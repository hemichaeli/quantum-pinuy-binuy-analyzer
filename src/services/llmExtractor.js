/**
 * Tier-2 LLM extractor — fallback for regex-based scrapers when required
 * fields come back null.
 *
 * Gated by env vars (ALL must be set for the LLM call to fire):
 *   ANTHROPIC_API_KEY              — credentials
 *   KOMO_LLM_FALLBACK_ENABLED=true — feature flag, default OFF
 *   MAX_LLM_COST_PER_RUN_USD       — optional cron-level kill-switch (process-wide cumulative)
 *
 * Model: claude-haiku-4-5 (validated by docs/poc-scrapegraph-vs-selectors-komo.md
 * at $0.0218/page, 92% complete-row yield on a 25-page sample).
 */

const axios = require('axios');
const { logger } = require('./logger');

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_HTML_CHARS = 60000; // 200k ctx; keep cost predictable
const RATE_INPUT_USD_PER_MTOK = 1.0;
const RATE_OUTPUT_USD_PER_MTOK = 5.0;

// Process-wide cumulative spend across all LLM calls in this Node process.
// Reset when the process restarts (Railway redeploy / cron re-entry).
let cumulativeCostUsd = 0;

const SYSTEM_PROMPT = `אתה מקבל HTML של עמוד מודעת דירה מאתר komo.co.il (עברית).
חלץ את הפרטים והחזר JSON תקני בלבד — בלי טקסט נוסף, בלי markdown, בלי backticks.

שדות (null אם אינו קיים):
- address: כתובת או שכונה+עיר, כפי שמופיע
- city: שם העיר בלבד (למשל "תל אביב")
- price: מספר שלם בש"ח (ללא פסיקים, ללא סימן ₪)
- rooms: מספר חדרים (יכול להיות עשרוני, למשל 3.5)
- area_sqm: שטח במ"ר, מספר שלם
- floor: מספר קומה (קרקע = 0)
- neighborhood: שכונה אם מופיע, אחרת null
- description: תיאור הנכס, עד 500 תווים

החזר JSON בלבד.`;

function estimateCostUSD(usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0) / 1_000_000 * RATE_INPUT_USD_PER_MTOK
       + (usage.output_tokens || 0) / 1_000_000 * RATE_OUTPUT_USD_PER_MTOK;
}

function parseJsonStrict(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(cleaned);
}

/**
 * Extract komo listing fields from raw HTML.
 *
 * @param {string} html - raw page HTML
 * @param {string} modaaNum - listing id (echoed back in result)
 * @param {object} [opts]
 * @param {string[]} [opts.onlyFields] - if provided, narrow the prompt to these field names
 * @returns {Promise<object|null>}
 */
async function extractKomoListing(html, modaaNum, opts = {}) {
  if (process.env.KOMO_LLM_FALLBACK_ENABLED !== 'true') {
    return null;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    logger.warn('[llmExtractor] KOMO_LLM_FALLBACK_ENABLED=true but ANTHROPIC_API_KEY missing');
    return null;
  }
  const maxCost = parseFloat(process.env.MAX_LLM_COST_PER_RUN_USD || 'NaN');
  if (Number.isFinite(maxCost) && cumulativeCostUsd >= maxCost) {
    logger.warn(`[llmExtractor] MAX_LLM_COST_PER_RUN_USD ($${maxCost}) hit; skipping (cumulative=$${cumulativeCostUsd.toFixed(4)})`);
    return null;
  }

  const trimmed = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
  const fieldList = opts.onlyFields && opts.onlyFields.length
    ? `\nשים לב: רק השדות הבאים נדרשים הפעם: ${opts.onlyFields.join(', ')}. שדות אחרים יכולים להיות null.`
    : '';

  try {
    const apiResp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT + fieldList,
        messages: [{ role: 'user', content: `modaaNum: ${modaaNum}\n\nHTML:\n${trimmed}\n\nהחזר JSON בלבד.` }]
      },
      {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        timeout: parseInt(process.env.LLM_TIMEOUT_MS || '30000', 10)
      }
    );
    const resp = apiResp.data;
    const cost = estimateCostUSD(resp.usage);
    cumulativeCostUsd += cost;

    const text = (resp.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    let parsed;
    try { parsed = parseJsonStrict(text); }
    catch (e) {
      logger.warn(`[llmExtractor] parse error for ${modaaNum}: ${e.message}; raw: ${text.slice(0, 200)}`);
      return null;
    }

    return {
      address: parsed.address ?? null,
      city: parsed.city ?? null,
      neighborhood: parsed.neighborhood ?? null,
      price: parsed.price != null ? parseInt(String(parsed.price).replace(/[^\d-]/g, ''), 10) || null : null,
      rooms: parsed.rooms != null ? parseFloat(String(parsed.rooms)) || null : null,
      area_sqm: parsed.area_sqm != null ? parseInt(String(parsed.area_sqm).replace(/[^\d-]/g, ''), 10) || null : null,
      floor: parsed.floor != null ? parseInt(String(parsed.floor).replace(/[^\d-]/g, ''), 10) : null,
      description: parsed.description != null ? String(parsed.description).slice(0, 500) : null,
      _llm: { cost_usd: cost, cumulative_usd: cumulativeCostUsd, input_tokens: resp.usage?.input_tokens, output_tokens: resp.usage?.output_tokens }
    };
  } catch (e) {
    logger.warn(`[llmExtractor] API call failed for ${modaaNum}: ${e.message}`);
    return null;
  }
}

function getCumulativeCostUSD() { return cumulativeCostUsd; }
function resetCumulativeCost() { cumulativeCostUsd = 0; }

module.exports = { extractKomoListing, getCumulativeCostUSD, resetCumulativeCost, MODEL };
