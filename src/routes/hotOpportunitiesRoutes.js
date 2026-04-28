/**
 * Hot Opportunities read endpoint (Day 8 — surfaces what hotOpportunityCron writes).
 *
 * Mounted at /api so paths are:
 *   GET /api/hot-opportunities              -- last N alerts with listing+complex context
 *   GET /api/hot-opportunities?status=sent  -- filter by status
 *   GET /api/hot-opportunities?limit=20     -- override default (50, max 200)
 */
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

router.get('/hot-opportunities', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const status = req.query.status;
    const params = [];
    let where = '';
    if (status) {
      where = 'WHERE a.status = $1';
      params.push(status);
    }
    params.push(limit);
    const { rows } = await pool.query(`
      SELECT
        a.id, a.listing_id, a.complex_id, a.iai_score, a.ssi_score,
        a.match_score, a.channel, a.status, a.recipient,
        a.message_preview, a.error, a.created_at,
        l.address, l.city, l.asking_price, l.url AS listing_url, l.source,
        c.name AS complex_name
      FROM hot_opportunity_alerts a
      LEFT JOIN listings  l ON l.id = a.listing_id
      LEFT JOIN complexes c ON c.id = a.complex_id
      ${where}
      ORDER BY a.created_at DESC
      LIMIT $${params.length}
    `, params);
    res.json({ success: true, count: rows.length, alerts: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Day 8.5 — opt-outs read endpoint
router.get('/wa-optouts', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const { rows } = await pool.query(`
      SELECT id, phone, opted_out_at, source, reply_text, listing_id, notes
      FROM wa_optouts
      ORDER BY opted_out_at DESC
      LIMIT $1
    `, [limit]);
    res.json({ success: true, count: rows.length, optouts: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Day 8.5 — recent matches across all leads (operator-wide view)
router.get('/lead-matches', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const minScore = parseFloat(req.query.min_score) || 0;
    const { rows } = await pool.query(`
      SELECT
        m.id, m.lead_id, m.listing_id, m.score, m.created_at,
        m.outcome, m.outcome_at, m.outcome_notes,
        wl.name AS lead_name, wl.email AS lead_email, wl.phone AS lead_phone,
        l.address, l.city, l.asking_price, l.url AS listing_url,
        c.name AS complex_name, c.iai_score, c.enhanced_ssi_score
      FROM lead_matches m
      LEFT JOIN website_leads wl ON wl.id = m.lead_id
      LEFT JOIN listings l ON l.id = m.listing_id
      LEFT JOIN complexes c ON c.id = l.complex_id
      WHERE m.score >= $2
      ORDER BY m.created_at DESC
      LIMIT $1
    `, [limit, minScore]);
    res.json({ success: true, count: rows.length, matches: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
