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
