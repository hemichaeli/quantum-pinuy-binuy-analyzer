const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// GET /api/analytics/overview
router.get('/overview', async (req, res) => {
  try {
    const { period = '30d' } = req.query;
    const days = period === '7d' ? 7 : period === '90d' ? 90 : period === '1y' ? 365 : 30;

    const [complexes, leads, messages, deals, calls] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total, ROUND(AVG(iai_score)::numeric, 1) as avg_iai FROM complexes`).catch(() => ({ rows: [{}] })),
      pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '${days} days') as new_period, COUNT(*) FILTER (WHERE status = 'qualified') as qualified, COUNT(*) FILTER (WHERE status = 'converted') as converted FROM leads`).catch(() => ({ rows: [{}] })),
      pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '${days} days') as new_period FROM whatsapp_messages`).catch(() => ({ rows: [{}] })),
      pool.query(`SELECT COUNT(*) as total, COALESCE(SUM(value) FILTER (WHERE stage = 'won'), 0) as won_value FROM deals`).catch(() => ({ rows: [{}] })),
      pool.query(`SELECT COUNT(*) as total FROM call_logs WHERE called_at > NOW() - INTERVAL '${days} days'`).catch(() => ({ rows: [{}] }))
    ]);

    res.json({
      success: true,
      period,
      overview: {
        complexes: {
          total: parseInt(complexes.rows[0]?.total) || 698,
          avg_iai: parseFloat(complexes.rows[0]?.avg_iai) || 0
        },
        leads: {
          total: parseInt(leads.rows[0]?.total) || 0,
          new_this_period: parseInt(leads.rows[0]?.new_period) || 0,
          qualified: parseInt(leads.rows[0]?.qualified) || 0,
          converted: parseInt(leads.rows[0]?.converted) || 0,
          conversion_rate: leads.rows[0]?.total > 0
            ? Math.round((parseInt(leads.rows[0]?.converted || 0) / parseInt(leads.rows[0]?.total)) * 100)
            : 0
        },
        messages: {
          total: parseInt(messages.rows[0]?.total) || 0,
          new_this_period: parseInt(messages.rows[0]?.new_period) || 0
        },
        deals: {
          total: parseInt(deals.rows[0]?.total) || 0,
          won_value: parseFloat(deals.rows[0]?.won_value) || 0
        },
        activity: {
          calls_this_period: parseInt(calls.rows[0]?.total) || 0
        }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/analytics/leads
router.get('/leads', async (req, res) => {
  try {
    const [bySource, byStatus, byCity, trend] = await Promise.all([
      pool.query(`SELECT source, COUNT(*) as count FROM leads GROUP BY source ORDER BY count DESC`).catch(() => ({ rows: [] })),
      pool.query(`SELECT status, COUNT(*) as count FROM leads GROUP BY status ORDER BY count DESC`).catch(() => ({ rows: [] })),
      pool.query(`SELECT city, COUNT(*) as count FROM leads WHERE city IS NOT NULL GROUP BY city ORDER BY count DESC LIMIT 10`).catch(() => ({ rows: [] })),
      pool.query(`SELECT DATE_TRUNC('day', created_at) as day, COUNT(*) as count FROM leads WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY day ORDER BY day`).catch(() => ({ rows: [] }))
    ]);

    res.json({
      success: true,
      leads: {
        by_source: bySource.rows,
        by_status: byStatus.rows,
        by_city: byCity.rows,
        daily_trend: trend.rows
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/analytics/market
router.get('/market', async (req, res) => {
  try {
    const [byCity, topIAI, statusDist, signatureDist] = await Promise.all([
      pool.query(`SELECT city, COUNT(*) as complexes, ROUND(AVG(iai_score)::numeric,1) as avg_iai, ROUND(AVG(avg_ssi)::numeric,1) as avg_ssi FROM complexes WHERE city IS NOT NULL GROUP BY city ORDER BY avg_iai DESC NULLS LAST LIMIT 15`).catch(() => ({ rows: [] })),
      pool.query(`SELECT id, name, city, iai_score, avg_ssi, planned_units, existing_units, developer FROM complexes WHERE iai_score IS NOT NULL ORDER BY iai_score DESC LIMIT 10`).catch(() => ({ rows: [] })),
      pool.query(`SELECT status, COUNT(*) as count FROM complexes WHERE status IS NOT NULL GROUP BY status ORDER BY count DESC`).catch(() => ({ rows: [] })),
      pool.query(`SELECT CASE WHEN signature_percent >= 80 THEN 'חתימות גבוהות (80%+)' WHEN signature_percent >= 50 THEN 'חתימות בינוניות (50-80%)' WHEN signature_percent >= 25 THEN 'חתימות נמוכות (25-50%)' ELSE 'מתחת ל-25%' END as range, COUNT(*) as count FROM complexes WHERE signature_percent IS NOT NULL GROUP BY range ORDER BY count DESC`).catch(() => ({ rows: [] }))
    ]);

    res.json({
      success: true,
      market: {
        by_city: byCity.rows,
        top_iai_complexes: topIAI.rows,
        status_distribution: statusDist.rows,
        signature_distribution: signatureDist.rows
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/analytics/performance
router.get('/performance', async (req, res) => {
  try {
    const [iai_dist, developer_risk, whatsapp, enrichment] = await Promise.all([
      pool.query(`SELECT CASE WHEN iai_score >= 80 THEN 'גבוה (80+)' WHEN iai_score >= 60 THEN 'בינוני (60-80)' WHEN iai_score >= 40 THEN 'נמוך (40-60)' ELSE 'מתחת ל-40' END as range, COUNT(*) as count FROM complexes WHERE iai_score IS NOT NULL GROUP BY range ORDER BY count DESC`).catch(() => ({ rows: [] })),
      pool.query(`SELECT developer_risk_level, COUNT(*) as count FROM complexes WHERE developer_risk_level IS NOT NULL GROUP BY developer_risk_level ORDER BY count DESC`).catch(() => ({ rows: [] })),
      pool.query(`SELECT direction, COUNT(*) as count FROM whatsapp_messages WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY direction`).catch(() => ({ rows: [] })),
      pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE enrichment_score > 0) as enriched FROM complexes`).catch(() => ({ rows: [{ total: 698, enriched: 0 }] }))
    ]);

    const total = parseInt(enrichment.rows[0]?.total) || 698;
    const enriched = parseInt(enrichment.rows[0]?.enriched) || 0;

    res.json({
      success: true,
      performance: {
        iai_distribution: iai_dist.rows,
        developer_risk: developer_risk.rows,
        enrichment: {
          total,
          enriched,
          rate: total > 0 ? Math.round((enriched / total) * 100) : 0
        },
        whatsapp_activity: whatsapp.rows
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/analytics/revenue
router.get('/revenue', async (req, res) => {
  try {
    const [monthly, byStage, topDeals] = await Promise.all([
      pool.query(`SELECT DATE_TRUNC('month', closed_at) as month, SUM(value) as revenue, COUNT(*) as deals FROM deals WHERE stage = 'won' AND closed_at IS NOT NULL GROUP BY month ORDER BY month DESC LIMIT 12`).catch(() => ({ rows: [] })),
      pool.query(`SELECT stage, COUNT(*) as count, COALESCE(SUM(value), 0) as total_value FROM deals GROUP BY stage ORDER BY total_value DESC`).catch(() => ({ rows: [] })),
      pool.query(`SELECT d.id, d.title, d.value, d.stage, l.name as lead_name FROM deals d LEFT JOIN leads l ON d.lead_id = l.id ORDER BY d.value DESC LIMIT 10`).catch(() => ({ rows: [] }))
    ]);

    res.json({
      success: true,
      revenue: {
        monthly_trend: monthly.rows,
        by_stage: byStage.rows,
        top_deals: topDeals.rows
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
