// Partner-outreach tracking: open pixel + sent/replied marking + stats.
// Pixel URL to embed per recipient (HTML email):
//   <img src="https://discovery.u-r-quantum.com/api/outreach/o/<key>.gif" width="1" height="1" alt="">
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// 1x1 transparent GIF
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// Open beacon. Best-effort; never blocks the image response.
router.get('/o/:key.gif', async (req, res) => {
  const key = req.params.key;
  pool.query(
    `UPDATE outreach SET open_count = open_count + 1, first_open_at = COALESCE(first_open_at, NOW()) WHERE key = $1`,
    [key]).catch(() => {});
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate, private', 'Pragma': 'no-cache', 'Expires': '0' });
  res.end(PIXEL);
});

// Seed / upsert recipients. Body: { partners: [{ key, name, email, batch, category }] }
router.post('/seed', async (req, res) => {
  const rows = req.body?.partners || [];
  let n = 0;
  for (const p of rows) {
    if (!p.key) continue;
    try {
      await pool.query(
        `INSERT INTO outreach (key, name, email, batch, category) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name, email=EXCLUDED.email, batch=EXCLUDED.batch, category=EXCLUDED.category`,
        [p.key, p.name || null, p.email || null, p.batch || 1, p.category || null]);
      n++;
    } catch (e) { /* skip bad row */ }
  }
  res.json({ success: true, seeded: n });
});

// Mark an event. Body: { key, event: 'sent' | 'replied' }
router.post('/mark', async (req, res) => {
  const { key, event } = req.body || {};
  if (!key || !['sent', 'replied'].includes(event)) return res.status(400).json({ success: false, error: 'need key + event (sent|replied)' });
  const col = event === 'sent' ? 'sent_at' : 'replied_at';
  await pool.query(`UPDATE outreach SET ${col} = COALESCE(${col}, NOW()) WHERE key = $1`, [key]);
  res.json({ success: true });
});

// Aggregate + per-recipient stats.
router.get('/stats', async (req, res) => {
  const agg = (await pool.query(
    `SELECT COUNT(*)::int total, COUNT(sent_at)::int sent, COUNT(first_open_at)::int opened, COUNT(replied_at)::int replied FROM outreach`)).rows[0];
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
  const rows = (await pool.query(
    `SELECT key, name, email, batch, category, sent_at, first_open_at, open_count, replied_at FROM outreach ORDER BY batch, key`)).rows;
  res.json({
    total: agg.total, sent: agg.sent, opened: agg.opened, replied: agg.replied,
    open_rate_pct: pct(agg.opened, agg.sent), reply_rate_pct: pct(agg.replied, agg.sent),
    recipients: rows,
  });
});

module.exports = router;
