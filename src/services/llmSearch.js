/**
 * Shared web-search LLM call for the listing scrapers.
 * Gemini-primary (grounded, cheaper) with Perplexity `sonar` fallback.
 * Returns the model's text content (string) or null. Fail-open: if Gemini
 * errors/empty it falls back to Perplexity, so no scraper breaks.
 * Toggle with SCRAPER_LLM=perplexity to force the old behaviour.
 */
const axios = require('axios');
const { logger } = require('./logger');

const PERPLEXITY_API = 'https://api.perplexity.ai/chat/completions';

// Hard daily brake on the paid Perplexity fallback. When Gemini fails, every
// enrichment call spills here; without a cap that is a runaway credit burn
// (1,100+ sonar calls/day observed 2026-07). In-process counter, resets daily.
// Override with PPLX_DAILY_CAP (0 = disable Perplexity entirely).
let _pplxDay = null, _pplxCount = 0, _pplxWarned = false;
function pplxAllowed() {
  const today = new Date().toISOString().slice(0, 10);
  if (_pplxDay !== today) { _pplxDay = today; _pplxCount = 0; _pplxWarned = false; }
  const cap = parseInt(process.env.PPLX_DAILY_CAP || '300', 10);
  if (_pplxCount >= cap) {
    if (!_pplxWarned) { logger.warn(`[llmSearch] Perplexity daily cap ${cap} reached; suppressing further sonar calls today`); _pplxWarned = true; }
    return false;
  }
  _pplxCount++;
  return true;
}

async function searchLLM(systemPrompt, userPrompt, opts = {}) {
  const maxTokens = opts.maxTokens || 3000;
  const provider = process.env.SCRAPER_LLM || 'gemini';

  if (provider === 'gemini') {
    try {
      const { queryGemini } = require('./geminiEnrichmentService');
      const text = await queryGemini(userPrompt, systemPrompt, true);
      if (text && text.trim()) return text;
    } catch (e) {
      logger.warn(`[llmSearch] Gemini failed, falling back to Perplexity: ${e.message}`);
    }
  }

  const apiKey = process.env.PERPLEXITY_API_KEY || process.env.SONAR_API_KEY;
  if (!apiKey) return null;
  if (!pplxAllowed()) return null;
  try {
    const res = await axios.post(PERPLEXITY_API, {
      model: 'sonar',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: maxTokens,
      temperature: 0.1
    }, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 30000 });
    return res.data?.choices?.[0]?.message?.content || null;
  } catch (e) {
    logger.warn(`[llmSearch] Perplexity fallback failed: ${e.message}`);
    return null;
  }
}

module.exports = { searchLLM };
