// aiUsageLogger.js
// Cumulative token-usage tracking for the paid LLM providers (Claude + Perplexity).
//
// Rather than instrument the ~15 scrapers + services that each call the providers
// directly via the shared `axios` default instance, we register ONE global axios
// response interceptor. It inspects every response, and when the request went to
// api.anthropic.com or api.perplexity.ai it extracts the `usage` block and records
// a row in `ai_usage_log`. The interceptor never throws and never alters the
// response — a logging failure must never break a provider call.
//
// Coverage note: this captures every call made through the default `axios` import
// (all current AI callers). The only `axios.create()` instance in the codebase is
// konesIsraelService, which is not an AI provider, so nothing is missed.

const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

let installed = false;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Pull provider + normalized usage out of an axios response. Returns null if this
// is not a provider response we track (or carries no usage we can read).
function extractUsage(response) {
  const url = (response?.config?.url || '').toLowerCase();
  const data = response?.data || {};

  let provider = null;
  if (url.includes('api.anthropic.com')) provider = 'anthropic';
  else if (url.includes('api.perplexity.ai')) provider = 'perplexity';
  if (!provider) return null;

  const usage = data.usage || {};

  // Anthropic: input_tokens / output_tokens (+ cache + server_tool_use.web_search_requests)
  // Perplexity (OpenAI-compatible): prompt_tokens / completion_tokens / total_tokens
  const inputTokens = num(usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = num(usage.output_tokens ?? usage.completion_tokens);
  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheCreation = num(usage.cache_creation_input_tokens);
  const totalTokens = num(usage.total_tokens) || (inputTokens + outputTokens);
  const webSearch = num(usage.server_tool_use?.web_search_requests);

  // If there's genuinely no usage signal, skip (e.g. error bodies, pings).
  if (!inputTokens && !outputTokens && !totalTokens && !webSearch) return null;

  // Path only (strip the host) so the column stays readable.
  let endpoint = null;
  try { endpoint = new URL(response.config.url).pathname; } catch { endpoint = response.config.url; }

  return {
    provider,
    model: data.model || response.config?.__aiModel || null,
    endpoint,
    inputTokens,
    outputTokens,
    totalTokens,
    cacheRead,
    cacheCreation,
    webSearch,
    statusCode: num(response.status) || null,
  };
}

// Fire-and-forget insert. Never throws.
function recordAiUsage(row) {
  pool.query(
    `INSERT INTO ai_usage_log
       (provider, model, endpoint, input_tokens, output_tokens, total_tokens,
        cache_read_tokens, cache_creation_tokens, web_search_requests, status_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [row.provider, row.model, row.endpoint, row.inputTokens, row.outputTokens,
     row.totalTokens, row.cacheRead, row.cacheCreation, row.webSearch, row.statusCode]
  ).catch((e) => { /* swallow — logging must never break a provider call */ void e; });
}

// ── Universal daily brake on paid Perplexity ─────────────────────────────────
// A REQUEST interceptor that blocks every outbound call to api.perplexity.ai once
// the day's count hits PPLX_DAILY_CAP. This is the single chokepoint that covers
// ALL ~24 direct callers (scanComplex, scrapers, enrichment, etc.). Seeds the
// day's count from ai_usage_log on rollover so it survives process restarts.
// PPLX_DAILY_CAP=0 disables Perplexity entirely (Gemini-only).
const _pplx = { day: null, count: 0, warned: false };
async function pplxRequestGate(config) {
  const url = (config?.url || '').toLowerCase();
  if (!url.includes('api.perplexity.ai')) return config;

  const cap = parseInt(process.env.PPLX_DAILY_CAP || '150', 10);
  const today = new Date().toISOString().slice(0, 10);
  if (_pplx.day !== today) {
    _pplx.day = today; _pplx.count = 0; _pplx.warned = false;
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int c FROM ai_usage_log WHERE provider='perplexity'
           AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Jerusalem') AT TIME ZONE 'Asia/Jerusalem'`);
      _pplx.count = rows[0]?.c || 0;
    } catch (e) { /* best-effort seed */ }
  }
  if (cap <= 0 || _pplx.count >= cap) {
    if (!_pplx.warned) {
      logger.warn(`[AIUsage] Perplexity daily cap reached (cap=${cap}, count=${_pplx.count}) — blocking further sonar calls today`);
      _pplx.warned = true;
    }
    const err = new Error(`Perplexity daily cap ${cap} reached — call blocked`);
    err.__pplxBlocked = true;
    throw err;
  }
  _pplx.count++;
  return config;
}

// Register the global interceptor once.
function installAiUsageInterceptor() {
  if (installed) return;
  installed = true;
  axios.interceptors.request.use(pplxRequestGate, (e) => Promise.reject(e));
  axios.interceptors.response.use(
    (response) => {
      try {
        const row = extractUsage(response);
        if (row) recordAiUsage(row);
      } catch (e) { /* never break the response path */ void e; }
      return response;
    },
    (error) => Promise.reject(error) // don't record failed calls (no usage to bill)
  );
  logger.info('[AIUsage] global axios usage interceptor installed');
}

// ── Pricing (USD per 1M tokens). Approximate — override via env. ──────────────
// Anthropic claude-sonnet-4-6: $3 in / $15 out. Web search: $10 per 1,000 requests.
// Perplexity sonar: ~$1 in / ~$1 out (Perplexity has no usage/billing API; treat as estimate).
const RATES = {
  anthropic: {
    input: parseFloat(process.env.AI_COST_ANTHROPIC_INPUT_PER_M || '3'),
    output: parseFloat(process.env.AI_COST_ANTHROPIC_OUTPUT_PER_M || '15'),
    webSearchPer1k: parseFloat(process.env.AI_COST_ANTHROPIC_WEBSEARCH_PER_1K || '10'),
  },
  perplexity: {
    input: parseFloat(process.env.AI_COST_PERPLEXITY_INPUT_PER_M || '1'),
    output: parseFloat(process.env.AI_COST_PERPLEXITY_OUTPUT_PER_M || '1'),
    webSearchPer1k: 0,
  },
};

function estimateCostUsd(provider, inputTokens, outputTokens, webSearchRequests) {
  const r = RATES[provider];
  if (!r) return null;
  const cost = (inputTokens / 1e6) * r.input
             + (outputTokens / 1e6) * r.output
             + (webSearchRequests / 1000) * (r.webSearchPer1k || 0);
  return Math.round(cost * 10000) / 10000; // 4 dp
}

// Per-provider totals for a window (default today, Asia/Jerusalem).
async function getUsageSummary({ since = null, tz = 'Asia/Jerusalem' } = {}) {
  // Default window = "today" in the given timezone.
  const whereSince = since
    ? `created_at >= $1`
    : `created_at >= date_trunc('day', NOW() AT TIME ZONE $1) AT TIME ZONE $1`;
  const params = since ? [since] : [tz];

  const { rows } = await pool.query(
    `SELECT provider,
            COUNT(*)::int                       AS calls,
            COALESCE(SUM(input_tokens),0)::bigint  AS input_tokens,
            COALESCE(SUM(output_tokens),0)::bigint AS output_tokens,
            COALESCE(SUM(total_tokens),0)::bigint  AS total_tokens,
            COALESCE(SUM(cache_read_tokens),0)::bigint     AS cache_read_tokens,
            COALESCE(SUM(cache_creation_tokens),0)::bigint AS cache_creation_tokens,
            COALESCE(SUM(web_search_requests),0)::int      AS web_search_requests
       FROM ai_usage_log
      WHERE ${whereSince}
      GROUP BY provider
      ORDER BY provider`,
    params
  );

  return rows.map((r) => ({
    ...r,
    estimated_cost_usd: estimateCostUsd(
      r.provider, Number(r.input_tokens), Number(r.output_tokens), Number(r.web_search_requests)
    ),
  }));
}

// Daily breakdown by provider+model for the last N days.
async function getDailyUsage({ days = 7, tz = 'Asia/Jerusalem' } = {}) {
  const { rows } = await pool.query(
    `SELECT (created_at AT TIME ZONE $1)::date AS day,
            provider,
            model,
            COUNT(*)::int                       AS calls,
            COALESCE(SUM(input_tokens),0)::bigint  AS input_tokens,
            COALESCE(SUM(output_tokens),0)::bigint AS output_tokens,
            COALESCE(SUM(total_tokens),0)::bigint  AS total_tokens,
            COALESCE(SUM(web_search_requests),0)::int AS web_search_requests
       FROM ai_usage_log
      WHERE created_at >= NOW() - ($2 || ' days')::interval
      GROUP BY day, provider, model
      ORDER BY day DESC, provider, model`,
    [tz, String(days)]
  );
  return rows.map((r) => ({
    ...r,
    estimated_cost_usd: estimateCostUsd(
      r.provider, Number(r.input_tokens), Number(r.output_tokens), Number(r.web_search_requests)
    ),
  }));
}

module.exports = {
  installAiUsageInterceptor,
  recordAiUsage,
  extractUsage,
  estimateCostUsd,
  getUsageSummary,
  getDailyUsage,
  RATES,
};
