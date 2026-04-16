const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const axios = require('axios');

const DASHBOARD_URL = 'https://pinuy-binuy-analyzer-production.up.railway.app/api/dashboard';

// POST /api/morning/send - Manually trigger morning report email
// Pass force=true in body to bypass dedup guard
router.post('/send', async (req, res) => {
  try {
    const { sendMorningReport } = require('../services/morningReportService');

    // Force bypass dedup if requested
    if (req.body?.force) {
      try {
        const todayIL = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
        await pool.query('DELETE FROM morning_report_log WHERE sent_date = $1', [todayIL]);
      } catch (e) {}
    }

    const result = await sendMorningReport();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/morning/whatsapp - Send WhatsApp summary only (no email)
router.post('/whatsapp', async (req, res) => {
  try {
    const [opp, sellers, drops, committees] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM complexes WHERE iai_score >= 60'),
      pool.query('SELECT COUNT(*) as count FROM listings WHERE ssi_score >= 30 AND (deal_status IS NULL OR deal_status NOT IN ($1, $2))', ['סגור', 'אבוד']),
      pool.query("SELECT COUNT(*) as count FROM listings WHERE price_changes > 0 AND last_seen >= NOW() - INTERVAL '24 hours' AND total_price_drop_percent >= 5"),
      pool.query("SELECT COUNT(*) as count FROM committee_approvals WHERE meeting_date >= NOW() - INTERVAL '7 days' AND decision_type IN ('approval','advancement','declaration')").catch(() => ({ rows: [{ count: 0 }] }))
    ]);
    const stats = {
      opportunities: parseInt(opp.rows[0].count),
      stressed_sellers: parseInt(sellers.rows[0].count),
      price_drops: parseInt(drops.rows[0].count),
      committees: parseInt(committees.rows[0].count)
    };
    res.json({ success: true, stats, whatsapp: { skipped: true, reason: 'WhatsApp not configured' } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/morning/preview
router.get('/preview', async (req, res) => {
  try {
    const [opp, sellers, drops] = await Promise.all([
      pool.query('SELECT id, name, city, iai_score, status, developer, actual_premium, address, plan_stage, signature_percent FROM complexes WHERE iai_score >= 60 ORDER BY iai_score DESC LIMIT 8'),
      pool.query('SELECT l.id, l.address, l.city, l.asking_price, l.ssi_score, l.days_on_market, l.price_changes, l.total_price_drop_percent, c.name as complex_name FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id WHERE l.ssi_score >= 30 ORDER BY l.ssi_score DESC LIMIT 5'),
      pool.query("SELECT l.id, l.address, l.city, l.asking_price, l.price_changes, l.total_price_drop_percent, c.name as complex_name FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id WHERE l.price_changes > 0 AND l.last_seen >= NOW() - INTERVAL '24 hours' AND l.total_price_drop_percent >= 5 ORDER BY l.total_price_drop_percent DESC LIMIT 5")
    ]);
    res.json({
      opportunities: opp.rows,
      stressed_sellers: sellers.rows,
      price_drops_24h: drops.rows,
      generated_at: new Date().toISOString(),
      note: 'Preview only. POST /api/morning/send to trigger. Add {"force":true} to bypass dedup.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
