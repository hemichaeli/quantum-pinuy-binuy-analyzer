const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const axios = require('axios');

const DASHBOARD_URL = 'https://pinuy-binuy-analyzer-production.up.railway.app/api/dashboard';

// Send WhatsApp morning summary via INFORU
async function sendWhatsAppMorningSummary(stats) {
  try {
    const phone = process.env.QUANTUM_REPORT_PHONE;
    const username = process.env.INFORU_USERNAME;
    const password = process.env.INFORU_PASSWORD;
    if (!phone || !username || !password) return { skipped: true, reason: 'QUANTUM_REPORT_PHONE or INFORU credentials not configured' };

    const auth = Buffer.from(`${username}:${password}`).toString('base64');
    const today = new Date().toLocaleDateString('he-IL', {
      weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Jerusalem'
    });

    const msg =
      `🌅 *QUANTUM Morning Intel* | ${today}\n\n` +
      `✅ ${stats.opportunities || 0} הזדמנויות מובילות (IAI ≥60)\n` +
      `🔴 ${stats.stressed_sellers || 0} מוכרים תחת לחץ (SSI ≥30)\n` +
      `📉 ${stats.price_drops || 0} ירידות מחיר ב-24 שעות\n` +
      `📋 ${stats.committees || 0} אישורי ועדה אחרונים\n\n` +
      `📊 דאשבורד: ${DASHBOARD_URL}`;

    const result = await axios.post('https://capi.inforu.co.il/api/v2/WhatsApp/SendWhatsAppChat', {
      Data: {
        Message: msg,
        Phone: phone,
        Settings: {
          CustomerMessageId: `morning_${Date.now()}`,
          CustomerParameter: 'QUANTUM_MORNING_REPORT'
        }
      }
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`
      },
      timeout: 15000,
      validateStatus: () => true
    });

    const success = result.data?.StatusId === 1 || result.status === 200;
    return { sent: success, phone, statusId: result.data?.StatusId, status: result.status };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

// POST /api/morning/send - Manually trigger morning report email + WhatsApp
router.post('/send', async (req, res) => {
  try {
    const { sendMorningReport } = require('../services/morningReportService');
    const result = await sendMorningReport();

    // Also send WhatsApp summary
    let waResult = { skipped: true };
    if (result.success && result.stats) {
      waResult = await sendWhatsAppMorningSummary(result.stats);
    }

    res.json({ ...result, whatsapp: waResult });
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
    const waResult = await sendWhatsAppMorningSummary(stats);
    res.json({ success: true, stats, whatsapp: waResult });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/morning/preview - Preview morning report data (no email sent)
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
      note: 'Preview only - no email sent. POST /api/morning/send to trigger. POST /api/morning/whatsapp for WhatsApp only.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
