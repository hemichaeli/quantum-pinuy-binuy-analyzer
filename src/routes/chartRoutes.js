/**
 * Chart Routes - Time-series and breakdowns for the dashboard.
 * Created 2026-04-28 to close 4 dashboard 404s on /api/chart/*.
 *
 * All endpoints return { success, data } where data is an array (or object
 * for the funnel) suitable for direct rendering. Each query is wrapped in
 * safeQuery so a missing table yields an empty result instead of a 500.
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

async function safeQuery(sql, params = []) {
  try {
    const r = await pool.query(sql, params);
    return r.rows;
  } catch (err) {
    logger.warn('[chartRoutes] query failed', { error: err.message, sql: sql.slice(0, 80) });
    return [];
  }
}

/**
 * GET /api/chart/listings-monthly
 * New listings per month for the last 12 months.
 * Response: { success, data: [{ month: 'YYYY-MM', new_listings: N }, ...] }
 */
router.get('/listings-monthly', async (req, res) => {
  const rows = await safeQuery(`
    SELECT
      TO_CHAR(date_trunc('month', first_seen), 'YYYY-MM') AS month,
      COUNT(*)::int AS new_listings
    FROM listings
    WHERE first_seen >= NOW() - INTERVAL '12 months'
    GROUP BY date_trunc('month', first_seen)
    ORDER BY date_trunc('month', first_seen)
  `);
  res.json({ success: true, data: rows });
});

/**
 * GET /api/chart/leads-by-source
 * Distribution of leads by utm_source (falls back to source, then 'direct').
 * Response: { success, data: [{ source: 'meta-ads', count: N }, ...] }
 */
router.get('/leads-by-source', async (req, res) => {
  const rows = await safeQuery(`
    SELECT
      COALESCE(NULLIF(utm_source, ''), NULLIF(source, ''), 'direct') AS source,
      COUNT(*)::int AS count
    FROM leads
    GROUP BY 1
    ORDER BY count DESC
    LIMIT 20
  `);
  res.json({ success: true, data: rows });
});

/**
 * GET /api/chart/listings-by-source
 * Active listings broken down by scraper source (yad2, facebook, dira, etc.).
 * Response: { success, data: [{ source: 'yad2', count: N }, ...] }
 */
router.get('/listings-by-source', async (req, res) => {
  const rows = await safeQuery(`
    SELECT
      COALESCE(NULLIF(source, ''), 'unknown') AS source,
      COUNT(*)::int AS count
    FROM listings
    WHERE is_active = TRUE
    GROUP BY 1
    ORDER BY count DESC
    LIMIT 20
  `);
  res.json({ success: true, data: rows });
});

/**
 * GET /api/chart/conversion-rate
 * Lead funnel summary: total -> engaged -> qualified -> converted.
 * 'engaged' = status in (contacted, qualified, negotiation, closed)
 * 'qualified' = status in (qualified, negotiation, closed)
 * 'converted' = status = closed
 * Response: { success, data: { total_leads, engaged, qualified, converted, conversion_rate_percent } }
 */
router.get('/conversion-rate', async (req, res) => {
  const rows = await safeQuery(`
    SELECT
      COUNT(*)::int AS total_leads,
      COUNT(*) FILTER (WHERE status IN ('contacted','qualified','negotiation','closed'))::int AS engaged,
      COUNT(*) FILTER (WHERE status IN ('qualified','negotiation','closed'))::int AS qualified,
      COUNT(*) FILTER (WHERE status = 'closed')::int AS converted,
      COALESCE(ROUND(
        COUNT(*) FILTER (WHERE status = 'closed')::numeric * 100.0 /
        NULLIF(COUNT(*), 0)
      , 2), 0)::float AS conversion_rate_percent
    FROM leads
  `);
  const summary = rows[0] || {
    total_leads: 0, engaged: 0, qualified: 0, converted: 0, conversion_rate_percent: 0
  };
  res.json({ success: true, data: summary });
});

module.exports = router;
