const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// ===================== CALLS =====================

// GET /api/crm/calls
router.get('/calls', async (req, res) => {
  try {
    const { lead_id, limit = 50, offset = 0 } = req.query;
    let q = `SELECT cl.*, l.name as lead_name, l.phone as lead_phone FROM call_logs cl LEFT JOIN leads l ON cl.lead_id = l.id WHERE 1=1`;
    const params = [];
    let pi = 1;
    if (lead_id) { q += ` AND cl.lead_id = $${pi}`; params.push(lead_id); pi++; }
    q += ` ORDER BY cl.called_at DESC LIMIT $${pi} OFFSET $${pi+1}`;
    params.push(parseInt(limit), parseInt(offset));
    const { rows } = await pool.query(q, params);
    const count = await pool.query(`SELECT COUNT(*) FROM call_logs${lead_id ? ' WHERE lead_id = $1' : ''}`, lead_id ? [lead_id] : []);
    res.json({ success: true, calls: rows, total: parseInt(count.rows[0].count) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/crm/calls
router.post('/calls', async (req, res) => {
  try {
    const { lead_id, duration_seconds, notes, outcome, called_by } = req.body;
    if (!lead_id) return res.status(400).json({ success: false, error: 'lead_id required' });
    const { rows } = await pool.query(
      `INSERT INTO call_logs (lead_id, duration_seconds, notes, outcome, called_by, called_at) VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING *`,
      [lead_id, duration_seconds || 0, notes || '', outcome || 'answered', called_by || 'agent']
    );
    await pool.query(`UPDATE leads SET last_contact = NOW(), updated_at = NOW() WHERE id = $1`, [lead_id]).catch(() => {});
    res.json({ success: true, call: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===================== REMINDERS =====================

// GET /api/crm/reminders
router.get('/reminders', async (req, res) => {
  try {
    const { status = 'pending', lead_id } = req.query;
    let q = `SELECT r.*, l.name as lead_name, l.phone as lead_phone FROM reminders r LEFT JOIN leads l ON r.lead_id = l.id WHERE 1=1`;
    const params = [];
    let pi = 1;
    if (status !== 'all') { q += ` AND r.status = $${pi}`; params.push(status); pi++; }
    if (lead_id) { q += ` AND r.lead_id = $${pi}`; params.push(lead_id); pi++; }
    q += ` ORDER BY r.due_at ASC`;
    const { rows } = await pool.query(q, params);
    res.json({ success: true, reminders: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/crm/reminders
router.post('/reminders', async (req, res) => {
  try {
    const { lead_id, title, notes, due_at, reminder_type } = req.body;
    if (!lead_id || !title || !due_at) return res.status(400).json({ success: false, error: 'lead_id, title, due_at required' });
    const { rows } = await pool.query(
      `INSERT INTO reminders (lead_id, title, notes, due_at, reminder_type, status, created_at) VALUES ($1,$2,$3,$4,$5,'pending',NOW()) RETURNING *`,
      [lead_id, title, notes || '', due_at, reminder_type || 'follow_up']
    );
    res.json({ success: true, reminder: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/crm/reminders/:id
router.put('/reminders/:id', async (req, res) => {
  try {
    const { status, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE reminders SET status = COALESCE($1, status), notes = COALESCE($2, notes), updated_at = NOW() WHERE id = $3 RETURNING *`,
      [status, notes, req.params.id]
    );
    res.json({ success: true, reminder: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===================== DEALS / PIPELINE =====================

// GET /api/crm/deals
router.get('/deals', async (req, res) => {
  try {
    const { stage, limit = 100 } = req.query;
    let q = `SELECT d.*, l.name as lead_name, l.phone as lead_phone, c.name as complex_name FROM deals d LEFT JOIN leads l ON d.lead_id = l.id LEFT JOIN complexes c ON d.complex_id = c.id WHERE 1=1`;
    const params = [];
    let pi = 1;
    if (stage) { q += ` AND d.stage = $${pi}`; params.push(stage); pi++; }
    q += ` ORDER BY d.updated_at DESC LIMIT $${pi}`; params.push(parseInt(limit));
    const { rows } = await pool.query(q, params);
    res.json({ success: true, deals: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/crm/deals
router.post('/deals', async (req, res) => {
  try {
    const { lead_id, complex_id, title, value, stage, notes, expected_close } = req.body;
    if (!lead_id || !title) return res.status(400).json({ success: false, error: 'lead_id, title required' });
    const { rows } = await pool.query(
      `INSERT INTO deals (lead_id, complex_id, title, value, stage, notes, expected_close, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW()) RETURNING *`,
      [lead_id, complex_id || null, title, value || 0, stage || 'prospect', notes || '', expected_close || null]
    );
    res.json({ success: true, deal: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/crm/deals/:id/stage
router.put('/deals/:id/stage', async (req, res) => {
  try {
    const { stage, notes } = req.body;
    const validStages = ['prospect', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];
    if (!validStages.includes(stage)) return res.status(400).json({ success: false, error: `Invalid stage. Valid: ${validStages.join(', ')}` });
    const closed = ['won', 'lost'].includes(stage) ? 'NOW()' : 'NULL';
    const { rows } = await pool.query(
      `UPDATE deals SET stage = $1, notes = COALESCE($2, notes), updated_at = NOW(), closed_at = ${closed} WHERE id = $3 RETURNING *`,
      [stage, notes, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, error: 'Deal not found' });
    res.json({ success: true, deal: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/crm/deals/:id
router.delete('/deals/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM deals WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/crm/pipeline
router.get('/pipeline', async (req, res) => {
  try {
    const stages = ['prospect', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];
    const pipeline = {};
    for (const stage of stages) {
      const { rows } = await pool.query(
        `SELECT d.*, l.name as lead_name, l.phone as lead_phone FROM deals d LEFT JOIN leads l ON d.lead_id = l.id WHERE d.stage = $1 ORDER BY d.updated_at DESC`,
        [stage]
      );
      const total_value = rows.reduce((sum, r) => sum + (parseFloat(r.value) || 0), 0);
      pipeline[stage] = { deals: rows, count: rows.length, total_value };
    }
    const summary = {
      total_deals: Object.values(pipeline).reduce((s, p) => s + p.count, 0),
      total_pipeline_value: Object.values(pipeline).reduce((s, p) => s + p.total_value, 0),
      won_value: pipeline.won?.total_value || 0,
      win_rate: pipeline.won?.count > 0
        ? Math.round((pipeline.won.count / (pipeline.won.count + (pipeline.lost?.count || 0))) * 100)
        : 0
    };
    res.json({ success: true, pipeline, summary });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/crm/stats
router.get('/stats', async (req, res) => {
  try {
    const [calls, reminders, deals, leads] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE called_at > NOW() - INTERVAL '7 days') as this_week FROM call_logs`).catch(() => ({ rows: [{ total: 0, this_week: 0 }] })),
      pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'pending' AND due_at <= NOW() + INTERVAL '24 hours') as due_soon FROM reminders`).catch(() => ({ rows: [{ total: 0, due_soon: 0 }] })),
      pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE stage = 'won') as won, COUNT(*) FILTER (WHERE stage = 'lost') as lost, COALESCE(SUM(value) FILTER (WHERE stage NOT IN ('won','lost')), 0) as pipeline_value FROM deals`).catch(() => ({ rows: [{ total: 0, won: 0, lost: 0, pipeline_value: 0 }] })),
      pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'qualified') as qualified FROM leads`).catch(() => ({ rows: [{ total: 0, qualified: 0 }] }))
    ]);
    res.json({
      success: true,
      stats: {
        calls: { total: parseInt(calls.rows[0].total), this_week: parseInt(calls.rows[0].this_week) },
        reminders: { total: parseInt(reminders.rows[0].total), due_soon: parseInt(reminders.rows[0].due_soon) },
        deals: { total: parseInt(deals.rows[0].total), won: parseInt(deals.rows[0].won), lost: parseInt(deals.rows[0].lost), pipeline_value: parseFloat(deals.rows[0].pipeline_value) },
        leads: { total: parseInt(leads.rows[0].total), qualified: parseInt(leads.rows[0].qualified) }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
