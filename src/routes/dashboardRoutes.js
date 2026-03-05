/**
 * QUANTUM Dashboard API Routes
 * HTML is served from /dashboard (dashboardRoute.js -> src/views/dashboard.html)
 * This file provides all the DATA API endpoints used by the dashboard.
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// Redirect root to the new dashboard
router.get('/', (req, res) => {
  res.redirect('/dashboard');
});

// API: Get single complex
router.get('/complex/:id', async (req, res) => {
  try {
    const complex = await pool.query('SELECT * FROM complexes WHERE id = $1', [req.params.id]);
    if (!complex.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(complex.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Get listings with filters
router.get('/listings', async (req, res) => {
  try {
    const { city, source, sort = 'iai', limit = 100 } = req.query;
    let query = `SELECT l.*, c.name as complex_name, c.city as complex_city, c.status as complex_status, c.iai_score, c.developer, c.slug as complex_slug, c.id as cid FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id WHERE l.is_active = true`;
    const params = [];
    if (city) { params.push(city); query += ` AND l.city = $${params.length}`; }
    if (source) { params.push(source); query += ` AND l.source = $${params.length}`; }
    const sortMap = { iai: 'c.iai_score DESC NULLS LAST', price: 'l.asking_price ASC NULLS LAST', days: 'l.days_on_market DESC NULLS LAST', ssi: 'l.ssi_score DESC NULLS LAST' };
    query += ` ORDER BY ${sortMap[sort] || sortMap.iai} LIMIT $${params.length + 1}`;
    params.push(parseInt(limit) || 100);
    const { rows } = await pool.query(query, params);
    const cities = [...new Set(rows.map(r => r.city || r.complex_city).filter(Boolean))].sort();
    const sources = [...new Set(rows.map(r => r.source).filter(Boolean))].sort();
    res.json({ listings: rows, cities, sources });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Mark listings as messaged
router.post('/listings/message-sent', express.json(), async (req, res) => {
  try {
    const { listing_ids, status, deal_status } = req.body;
    if (!listing_ids || !listing_ids.length) return res.status(400).json({ error: 'No listing IDs' });
    for (const id of listing_ids) {
      await pool.query(`UPDATE listings SET message_status = $1, last_message_sent_at = $2, deal_status = $3, updated_at = $2 WHERE id = $4`, [status || 'sent', new Date(), deal_status || 'contacted', id]);
    }
    res.json({ success: true, updated: listing_ids.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Get committees (complexes ordered by date)
router.get('/committees', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, name as complex_name, city, status, approval_date as date, deposit_date, plan_number FROM complexes ORDER BY approval_date DESC NULLS LAST, updated_at DESC LIMIT 200`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Get all complexes
router.get('/complexes', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, name, city, iai_score, signature_percent FROM complexes ORDER BY iai_score DESC NULLS LAST LIMIT 500`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Get single complex details
router.get('/complexes/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM complexes WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Yad2 listings
router.get('/yad2/listings', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT l.*, c.name as complex_name FROM listings l LEFT JOIN complexes c ON c.id = l.complex_id WHERE l.source = 'yad2' ORDER BY l.last_seen DESC NULLS LAST LIMIT 100`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Kones listings
router.get('/kones/listings', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT l.*, c.name as complex_name FROM listings l LEFT JOIN complexes c ON c.id = l.complex_id WHERE l.source = 'kones' ORDER BY l.last_seen DESC NULLS LAST LIMIT 100`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: WhatsApp subscription stats
router.get('/whatsapp/subscriptions/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT COUNT(*) as "totalSubscriptions", SUM(CASE WHEN active = true THEN 1 ELSE 0 END) as "activeSubscriptions", COUNT(DISTINCT lead_id) as "uniqueLeads", COALESCE(SUM(alerts_sent), 0) as "totalAlertsSent" FROM whatsapp_subscriptions`);
    res.json(rows[0] || { totalSubscriptions: 0, activeSubscriptions: 0, uniqueLeads: 0, totalAlertsSent: 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Get subscriptions by lead
router.get('/whatsapp/subscriptions/:leadId', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM whatsapp_subscriptions WHERE lead_id = $1 ORDER BY created_at DESC', [req.params.leadId]);
    res.json(rows.map(row => ({ ...row, criteria: row.criteria ? JSON.parse(row.criteria) : {} })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Test WhatsApp subscription
router.post('/whatsapp/subscriptions/test', express.json(), async (req, res) => {
  try {
    const { leadId } = req.body;
    if (!leadId) return res.status(400).json({ error: 'Lead ID required' });
    res.json({ success: true, message: 'Test notification queued', leadId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Create subscription
router.post('/whatsapp/subscriptions', express.json(), async (req, res) => {
  try {
    const { lead_id, criteria } = req.body;
    if (!lead_id || !criteria || !Object.keys(criteria).length) return res.status(400).json({ error: 'Criteria required' });
    const { rows } = await pool.query(
      `INSERT INTO whatsapp_subscriptions (lead_id, criteria, active, created_at, updated_at) VALUES ($1, $2, true, NOW(), NOW()) RETURNING *`,
      [lead_id, JSON.stringify(criteria)]
    );
    res.json({ success: true, subscription: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Toggle subscription
router.patch('/whatsapp/subscriptions/:id/toggle', express.json(), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE whatsapp_subscriptions SET active = NOT active, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    res.json({ success: true, subscription: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Delete subscription
router.delete('/whatsapp/subscriptions/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM whatsapp_subscriptions WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
