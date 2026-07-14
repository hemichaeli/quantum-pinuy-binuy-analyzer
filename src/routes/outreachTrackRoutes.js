// Partner-outreach tracking: open pixel + sent/replied marking + stats.
// Pixel URL to embed per recipient (HTML email):
//   <img src="https://discovery.u-r-quantum.com/api/outreach/o/<key>.gif" width="1" height="1" alt="">
const express = require('express');
const path = require('path');
const router = express.Router();
const pool = require('../db/pool');

// QUANTUM logo for email signatures (stable hosted URL). JPEG = opaque white bg (no
// transparency checkerboard); png kept for back-compat.
router.get('/logo.jpg', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.type('image/jpeg').sendFile(path.join(__dirname, '..', 'assets', 'quantum-logo.jpg'));
});
router.get('/logo.png', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, '..', 'assets', 'quantum-logo.png'));
});

// Public price-check tool (consumer-facing Mispricing Index mockup).
router.get('/price-check.html', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.type('text/html').sendFile(path.join(__dirname, '..', 'assets', 'price-check.html'));
});

// Community-session registration / interest landing page.
router.get('/register.html', (req, res) => {
  res.set('Cache-Control', 'public, max-age=120');
  res.type('text/html').sendFile(path.join(__dirname, '..', 'assets', 'register.html'));
});

// Capture a registration/interest lead. Body: { name, email, org, role, interest, message, source_key }
router.post('/register-lead', async (req, res) => {
  const b = req.body || {};
  if (!b.email && !b.name) return res.status(400).json({ success: false, error: 'need name or email' });
  try {
    await pool.query(
      `INSERT INTO outreach_leads (name, email, org, role, interest, message, source_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [b.name || null, b.email || null, b.org || null, b.role || null, b.interest || null, b.message || null, b.source_key || null]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: 'could not save' }); }
});

// Simple registrations dashboard.
router.get('/leads', async (req, res) => {
  const rows = (await pool.query(
    `SELECT name, email, org, role, interest, message, source_key, created_at FROM outreach_leads ORDER BY created_at DESC`)).rows;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const fmt = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '');
  const tr = rows.map(r => `<tr><td>${fmt(r.created_at)}</td><td>${esc(r.name)}</td><td>${esc(r.email)}</td>
    <td>${esc(r.org)}</td><td>${esc(r.interest)}</td><td>${esc(r.source_key)}</td><td>${esc(r.message)}</td></tr>`).join('');
  res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QUANTUM registrations</title><style>body{font-family:Arial,sans-serif;margin:16px;color:#222}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#f4f4f4}</style><h1>QUANTUM registrations (${rows.length})</h1>
<table><thead><tr><th>When</th><th>Name</th><th>Email</th><th>Community/Org</th><th>Interest</th><th>Source</th><th>Message</th></tr></thead>
<tbody>${tr}</tbody></table>`);
});

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

// Click beacon + redirect. Wrap outbound links as /api/outreach/c/<key>?u=<encoded url>.
// High-signal (a real human clicked), unlike opens which mail proxies prefetch.
router.get('/c/:key', async (req, res) => {
  const key = req.params.key;
  const target = req.query.u || '';
  pool.query(
    `UPDATE outreach SET click_count = click_count + 1, first_click_at = COALESCE(first_click_at, NOW()) WHERE key = $1`,
    [key]).catch(() => {});
  // Only redirect to http/https to avoid open-redirect abuse.
  if (/^https?:\/\//i.test(target)) return res.redirect(302, target);
  res.status(204).end();
});

// Push-monitor feed: high-signal events (clicks + replies) not yet pushed to Claude mobile.
router.get('/events/new', async (req, res) => {
  const cur = (await pool.query(`SELECT last_pushed_at FROM outreach_push_cursor WHERE id = 1`)).rows[0];
  const since = cur ? cur.last_pushed_at : new Date(0).toISOString();
  const clicks = (await pool.query(
    `SELECT key, name, email, batch, category, first_click_at AS at, click_count FROM outreach
     WHERE first_click_at IS NOT NULL AND first_click_at > $1 ORDER BY first_click_at`, [since])).rows;
  const replies = (await pool.query(
    `SELECT key, name, email, batch, category, replied_at AS at FROM outreach
     WHERE replied_at IS NOT NULL AND replied_at > $1 ORDER BY replied_at`, [since])).rows;
  res.json({ since, clicks, replies, count: clicks.length + replies.length });
});

// Advance the cursor once events have been delivered. Body: { ts: ISO }
router.post('/events/ack', async (req, res) => {
  const ts = req.body?.ts;
  if (!ts) return res.status(400).json({ success: false, error: 'need ts' });
  await pool.query(`UPDATE outreach_push_cursor SET last_pushed_at = $1 WHERE id = 1`, [ts]);
  res.json({ success: true });
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

// Human-readable open/reply dashboard.
router.get('/dashboard', async (req, res) => {
  const agg = (await pool.query(
    `SELECT COUNT(*)::int total, COUNT(sent_at)::int sent, COUNT(first_open_at)::int opened, COUNT(replied_at)::int replied FROM outreach`)).rows[0];
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
  const rows = (await pool.query(
    `SELECT key, name, email, batch, category, sent_at, first_open_at, open_count, replied_at FROM outreach ORDER BY batch, key`)).rows;
  const fmt = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const tr = rows.map(r => `<tr>
    <td>${esc(r.name || r.key)}</td><td>${esc(r.email)}</td><td>${esc(r.category)}</td>
    <td>${r.sent_at ? 'yes' : ''}</td><td>${r.first_open_at ? 'yes' : ''}</td><td style="text-align:center">${r.open_count || 0}</td>
    <td>${r.replied_at ? 'yes' : ''}</td><td>${fmt(r.first_open_at)}</td></tr>`).join('');
  res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QUANTUM outreach</title><style>body{font-family:Arial,sans-serif;margin:16px;color:#222}
h1{font-size:18px}.k{display:inline-block;margin:6px 14px 6px 0}.k b{font-size:20px}
table{border-collapse:collapse;width:100%;font-size:13px;margin-top:12px}th,td{border:1px solid #ddd;padding:6px 8px;text-align:left}
th{background:#f4f4f4}</style></head><body>
<h1>QUANTUM partner outreach</h1>
<div class="k">Sent <b>${agg.sent}</b>/${agg.total}</div>
<div class="k">Opened <b>${agg.opened}</b> (${pct(agg.opened, agg.sent)}%)</div>
<div class="k">Replied <b>${agg.replied}</b> (${pct(agg.replied, agg.sent)}%)</div>
<table><thead><tr><th>Partner</th><th>Email</th><th>Segment</th><th>Sent</th><th>Opened</th><th>Opens</th><th>Replied</th><th>First open</th></tr></thead>
<tbody>${tr}</tbody></table>
<p style="color:#888;font-size:12px">Auto-refresh: reload the page. Open counts include email-client image prefetch, treat as directional.</p>
</body></html>`);
});

module.exports = router;
