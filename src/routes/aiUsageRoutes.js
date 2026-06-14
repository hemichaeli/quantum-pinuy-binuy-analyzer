// AI token-usage endpoints — see src/services/aiUsageLogger.js
//   GET /api/ai-usage           → today's per-provider totals (Claude + Perplexity)
//   GET /api/ai-usage/summary   → alias of the above; ?since=ISO for a custom window
//   GET /api/ai-usage/daily     → per-day breakdown by provider+model (?days=7)

const express = require('express');
const router = express.Router();
const { getUsageSummary, getDailyUsage } = require('../services/aiUsageLogger');

async function summaryHandler(req, res) {
  try {
    const since = req.query.since || null;
    const results = await getUsageSummary({ since });
    const had_usage = results.some((r) => Number(r.total_tokens) > 0 || Number(r.web_search_requests) > 0);
    res.json({ success: true, window: since ? `since ${since}` : 'today', had_usage, providers: results });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

router.get('/', summaryHandler);
router.get('/summary', summaryHandler);

router.get('/daily', async (req, res) => {
  try {
    const days = Math.max(1, Math.min(parseInt(req.query.days, 10) || 7, 90));
    res.json({ success: true, days, rows: await getDailyUsage({ days }) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
