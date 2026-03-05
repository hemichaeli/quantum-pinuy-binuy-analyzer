/**
 * QUANTUM Dashboard - Bloomberg Terminal Dark Design
 * All tabs restored: Summary, Properties, Committees, Leads, Kones, WhatsApp, Morning
 * Fixed: Morning Intelligence, WhatsApp stats, clickable buttons
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

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

// API: WhatsApp subscription stats - FIXED (removed last_alert column)
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

// MAIN DASHBOARD
router.get('/', async (req, res) => {
  try {
    const [enrichR, statusR, listR] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total, SUM(CASE WHEN perplexity_summary IS NOT NULL THEN 1 ELSE 0 END) as perplexity, SUM(CASE WHEN iai_score IS NOT NULL AND iai_score > 0 THEN 1 ELSE 0 END) as iai FROM complexes`),
      pool.query(`SELECT SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) as approved, SUM(CASE WHEN status IN ('deposited','pre_deposit','planning','declared') THEN 1 ELSE 0 END) as inprocess, SUM(CASE WHEN status='construction' THEN 1 ELSE 0 END) as construction FROM complexes`),
      pool.query(`SELECT COUNT(*) as yad2 FROM listings WHERE source='yad2' AND is_active=true`)
    ]);
    const e = enrichR.rows[0]; const s = statusR.rows[0]; const l = listR.rows[0];
    const pct = Math.round((e.perplexity / Math.max(e.total, 1)) * 100);

    res.type('html').send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>QUANTUM Intelligence Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Assistant:wght@400;600;700;800&family=DM+Serif+Display&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Assistant',sans-serif;background:#080c14;color:#e2e8f0;direction:rtl}
.header{background:#0d1526;border-bottom:1px solid #1a2744;padding:12px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}
.logo{font-family:'DM Serif Display',serif;font-size:22px;color:#ffc233;letter-spacing:1px}
.logo-sub{font-size:10px;color:#4a5e80;letter-spacing:2px;text-transform:uppercase;margin-top:2px}
.header-right{display:flex;align-items:center;gap:12px}
.time{font-size:13px;color:#4a5e80;font-variant-numeric:tabular-nums}
.header-btns{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.btn{padding:6px 14px;background:transparent;border:1px solid #243352;border-radius:7px;color:#e2e8f0;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;text-decoration:none;white-space:nowrap;transition:all .15s}
.btn:hover{border-color:#ffc233;color:#ffc233}
.btn-chat{color:#9f7aea;font-weight:700;border-color:rgba(159,122,234,.3)}
.btn-chat:hover{border-color:#9f7aea;color:#9f7aea}
.btn-ssi{color:#06d6a0;font-weight:700;border-color:rgba(6,214,160,.3)}
.btn-ssi:hover{border-color:#06d6a0}
.nav{background:#0b1120;border-bottom:1px solid #1a2744;padding:0 24px;display:flex;gap:0;overflow-x:auto;scrollbar-width:none}
.nav::-webkit-scrollbar{display:none}
.nav-btn{padding:13px 18px;background:none;border:none;border-bottom:2px solid transparent;color:#4a5e80;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .15s;white-space:nowrap;text-transform:uppercase;letter-spacing:.5px}
.nav-btn:hover{color:#a0b4cc}
.nav-btn.active{border-bottom-color:#ffc233;color:#ffc233;font-weight:700}
.main{padding:20px 24px;max-width:1600px;margin:0 auto}
.stats-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:20px}
.stat{background:#0d1526;border:1px solid #1a2744;border-radius:10px;padding:14px 16px;cursor:pointer;transition:border-color .15s}
.stat:hover{border-color:#ffc23344}
.stat-label{font-size:10px;color:#4a5e80;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px}
.stat-val{font-size:28px;font-weight:800;line-height:1.1;font-family:'DM Serif Display',serif}
.stat-sub{font-size:10px;color:#4a5e80;margin-top:4px}
.panel{background:#0d1526;border:1px solid #1a2744;border-radius:12px;padding:20px;margin-bottom:16px}
.panel-gold{border-color:rgba(255,194,51,.2);background:linear-gradient(135deg,#0d1526,rgba(255,194,51,.02))}
.panel-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.panel-title{font-size:15px;font-weight:700;color:#e2e8f0;font-family:'DM Serif Display',serif}
.panel-sub{font-size:11px;color:#4a5e80}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:right;padding:8px 10px;color:#4a5e80;font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #1a2744}
td{padding:9px 10px;border-bottom:1px solid #0f1e35;vertical-align:middle}
tr:hover td{background:rgba(255,255,255,.02)}
tr:last-child td{border-bottom:none}
.fw{font-weight:600}
.nw{white-space:nowrap}
.dim{color:#6b7e99}
.xs{font-size:11px}
.c{text-align:center}
.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:700}
.badge-critical{background:rgba(239,68,68,.15);color:#ef4444;border:1px solid rgba(239,68,68,.3)}
.badge-high{background:rgba(245,158,11,.15);color:#f59e0b;border:1px solid rgba(245,158,11,.3)}
.badge-med{background:rgba(99,102,241,.15);color:#818cf8;border:1px solid rgba(99,102,241,.3)}
.badge-low{background:rgba(107,114,128,.12);color:#9ca3af;border:1px solid rgba(107,114,128,.2)}
.badge-status{display:inline-block;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:600}
.status-approved{background:rgba(16,185,129,.12);color:#10b981;border:1px solid rgba(16,185,129,.2)}
.status-construction{background:rgba(59,130,246,.12);color:#3b82f6;border:1px solid rgba(59,130,246,.2)}
.status-deposited,.status-pre_deposit{background:rgba(139,92,246,.12);color:#8b5cf6;border:1px solid rgba(139,92,246,.2)}
.status-planning,.status-declared{background:rgba(245,158,11,.12);color:#f59e0b;border:1px solid rgba(245,158,11,.2)}
.status-unknown{background:rgba(107,114,128,.1);color:#6b7280;border:1px solid rgba(107,114,128,.15)}
.badge-src{display:inline-block;padding:2px 7px;border-radius:10px;font-size:10px;font-weight:600}
.src-yad2{background:rgba(255,89,0,.12);color:#ff6b35;border:1px solid rgba(255,89,0,.2)}
.src-kones{background:rgba(239,68,68,.12);color:#ef4444;border:1px solid rgba(239,68,68,.2)}
.src-other{background:rgba(107,114,128,.1);color:#9ca3af;border:1px solid rgba(107,114,128,.15)}
.tab-content{display:none}
.tab-content.active{display:block;animation:fadeUp .2s ease}
@keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.filters{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;align-items:center}
.filter-select,.filter-input{background:#060d1a;border:1px solid #1a2744;color:#e2e8f0;border-radius:7px;padding:6px 10px;font-size:12px;font-family:inherit;cursor:pointer;transition:border-color .15s}
.filter-select:hover,.filter-input:hover{border-color:#243352}
.filter-select:focus,.filter-input:focus{border-color:#ffc233;outline:none}
.filter-input{min-width:200px}
.btn-link{padding:3px 10px;border-radius:5px;font-size:10px;font-weight:600;border:1px solid rgba(96,165,250,.25);background:rgba(96,165,250,.06);color:#60a5fa;text-decoration:none;white-space:nowrap;display:inline-flex;align-items:center;transition:all .15s}
.btn-link:hover{background:rgba(96,165,250,.15);border-color:rgba(96,165,250,.5)}
.empty-msg{color:#4a5e80;font-size:13px;padding:24px;text-align:center}
.morning-hero{background:linear-gradient(135deg,rgba(255,194,51,.06),rgba(6,214,160,.04));border:1px solid rgba(255,194,51,.15);border-radius:14px;padding:24px;margin-bottom:20px}
.morning-title{font-size:24px;font-weight:800;font-family:'DM Serif Display',serif;margin-bottom:4px;color:#ffc233}
.morning-sub{font-size:13px;color:#8899b4}
.morning-date{font-size:11px;color:#4a5e80;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px}
.morning-sections{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:900px){.morning-sections{grid-template-columns:1fr}}
.kv-row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #0f1e35;font-size:12px}
.kv-row:last-child{border-bottom:none}
.kv-key{color:#6b7e99}
.kv-val{font-weight:600}
.stat-card-mini{background:#060d1a;border:1px solid #1a2744;border-radius:8px;padding:12px 16px;text-align:center}
.mini-val{font-size:22px;font-weight:800;font-family:'DM Serif Display',serif;color:#ffc233}
.mini-label{font-size:10px;color:#4a5e80;margin-top:3px}
.ws-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
@media(max-width:700px){.ws-stats{grid-template-columns:repeat(2,1fr)}}
@media(max-width:768px){.header{padding:10px 14px}.nav{padding:0 14px}.main{padding:14px}.stats-row{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body>

<div class="header">
  <div>
    <div class="logo">QUANTUM</div>
    <div class="logo-sub">Urban Renewal Intelligence</div>
  </div>
  <div class="header-right">
    <div class="time" id="time-display"></div>
    <div class="header-btns">
      <a href="/api/chat" class="btn btn-chat">&#8984; &#1510;&#39;&#1488;&#1496;</a>
      <button onclick="reloadSSI()" class="btn btn-ssi" id="ssi-btn">&#8876; SSI</button>
    </div>
  </div>
</div>

<div class="nav">
  <button class="nav-btn active" data-tab="overview" onclick="navigate('overview')">&#9635; SUMMARY</button>
  <button class="nav-btn" data-tab="properties" onclick="navigate('properties')">&#9636; COMPLEXES</button>
  <button class="nav-btn" data-tab="committees" onclick="navigate('committees')">&#9678; &#1493;&#1506;&#1491;&#1493;&#1514;</button>
  <button class="nav-btn" data-tab="leads" onclick="navigate('leads')">&#9889; LEADS</button>
  <button class="nav-btn" data-tab="kones" onclick="navigate('kones')">&#9888; &#1499;&#1497;&#1504;&#1493;&#1505;&#1497;&#1501;</button>
  <button class="nav-btn" data-tab="whatsapp" onclick="navigate('whatsapp')">&#128242; WhatsApp</button>
  <button class="nav-btn" data-tab="morning" onclick="navigate('morning')">&#9728; MORNING</button>
</div>

<div class="main">

<div id="tab-overview" class="tab-content active">
<div class="stats-row">
  <div class="stat" onclick="navigate('properties')">
    <div class="stat-label">&#1502;&#1514;&#1495;&#1502;&#1497;&#1501;</div>
    <div class="stat-val" id="stat-complexes"><span style="font-size:18px;color:#4a5e80">...</span></div>
    <div class="stat-sub">PINUY-BINUY COMPLEXES</div>
  </div>
  <div class="stat" onclick="navigate('properties')">
    <div class="stat-label">&#1502;&#1488;&#1493;&#1513;&#1512;&#1497;&#1501;</div>
    <div class="stat-val" style="color:#06d6a0">${s.approved}</div>
    <div class="stat-sub">AUTHORIZED</div>
  </div>
  <div class="stat" onclick="navigate('properties')">
    <div class="stat-label">&#1489;&#1489;&#1504;&#1497;&#1497;&#1492;</div>
    <div class="stat-val" style="color:#3b82f6">${s.construction}</div>
    <div class="stat-sub">UNDER CONSTRUCTION</div>
  </div>
  <div class="stat" onclick="navigate('properties')">
    <div class="stat-label">&#1489;&#1514;&#1492;&#1500;&#1497;&#1498;</div>
    <div class="stat-val" style="color:#ffc233">${s.inprocess}</div>
    <div class="stat-sub">DEPOSITED / PLANNING</div>
  </div>
  <div class="stat" onclick="navigate('leads')">
    <div class="stat-label">&#1502;&#1493;&#1491;&#1506;&#1493;&#1514; &#1497;&#1491;2</div>
    <div class="stat-val">${l.yad2}</div>
    <div class="stat-sub">ACTIVE LISTINGS</div>
  </div>
  <div class="stat" onclick="navigate('morning')">
    <div class="stat-label">&#1492;&#1514;&#1512;&#1488;&#1493;&#1514;</div>
    <div class="stat-val" id="stat-alerts"><span style="font-size:18px;color:#4a5e80">...</span></div>
    <div class="stat-sub">UNREAD ALERTS</div>
  </div>
  <div class="stat">
    <div class="stat-label">Perplexity</div>
    <div class="stat-val" style="color:#06d6a0">${pct}%</div>
    <div class="stat-sub">${e.perplexity} / ${e.total} ENRICHED</div>
  </div>
  <div class="stat">
    <div class="stat-label">IAI Scored</div>
    <div class="stat-val">${e.iai}</div>
    <div class="stat-sub">COMPLEXES</div>
  </div>
  <div class="stat">
    <div class="stat-label">&#1505;&#1512;&#1497;&#1511;&#1493;&#1514;</div>
    <div class="stat-val" id="stat-scans" style="color:#8b5cf6"><span style="font-size:18px;color:#4a5e80">...</span></div>
    <div class="stat-sub" id="stat-scans-sub">LOADING...</div>
  </div>
</div>
<div class="panel panel-gold">
  <div class="panel-head">
    <div class="panel-title">&#9733; Top Opportunities</div>
    <span class="panel-sub">IAI Score &gt;= 60</span>
  </div>
  <div id="top-opps-list"><div class="empty-msg">Loading...</div></div>
</div>
</div>

<div id="tab-properties" class="tab-content">
<div class="panel">
  <div class="panel-head">
    <div class="panel-title">&#1502;&#1505;&#1491; &#1502;&#1514;&#1495;&#1502;&#1497;&#1501;</div>
    <span class="panel-sub" id="prop-count"></span>
  </div>
  <div class="filters">
    <input class="filter-input" id="prop-search" placeholder="&#1495;&#1508;&#1513; &#1513;&#1501; / &#1506;&#1497;&#1512;..." oninput="filterProps()">
    <select class="filter-select" id="prop-status" onchange="filterProps()">
      <option value="">&#1499;&#1500; &#1492;&#1505;&#1496;&#1496;&#1493;&#1505;&#1497;&#1501;</option>
      <option value="approved">&#1502;&#1488;&#1493;&#1513;&#1512;</option>
      <option value="construction">&#1489;&#1489;&#1504;&#1497;&#1497;&#1492;</option>
      <option value="deposited">&#1492;&#1493;&#1508;&#1511;&#1491;&#1492;</option>
      <option value="pre_deposit">&#1496;&#1512;&#1493;&#1501; &#1492;&#1508;&#1511;&#1491;&#1492;</option>
      <option value="planning">&#1489;&#1514;&#1499;&#1504;&#1493;&#1503;</option>
      <option value="declared">&#1492;&#1493;&#1499;&#1512;&#1494;</option>
    </select>
    <select class="filter-select" id="prop-sort" onchange="filterProps()">
      <option value="iai">&#1500;&#1508;&#1497; IAI</option>
      <option value="name">&#1500;&#1508;&#1497; &#1513;&#1501;</option>
      <option value="city">&#1500;&#1508;&#1497; &#1506;&#1497;&#1512;</option>
    </select>
  </div>
  <div id="props-table"><div class="empty-msg">Loading...</div></div>
</div>
</div>

<div id="tab-committees" class="tab-content">
<div class="panel">
  <div class="panel-head">
    <div class="panel-title">&#9678; &#1502;&#1506;&#1511;&#1489; &#1493;&#1506;&#1491;&#1493;&#1514;</div>
    <span class="panel-sub">&#1492;&#1495;&#1500;&#1496;&#1493;&#1514; &#1514;&#1499;&#1504;&#1493;&#1503; &#1493;&#1502;&#1505;&#1500;&#1493;&#1500;&#1497;&#1501;</span>
  </div>
  <div class="filters">
    <input class="filter-input" id="comm-search" placeholder="&#1495;&#1508;&#1513; &#1513;&#1501; / &#1506;&#1497;&#1512;..." oninput="filterComm()">
    <select class="filter-select" id="comm-status" onchange="filterComm()">
      <option value="">&#1499;&#1500; &#1492;&#1505;&#1496;&#1496;&#1493;&#1505;&#1497;&#1501;</option>
      <option value="approved">&#1502;&#1488;&#1493;&#1513;&#1512;</option>
      <option value="construction">&#1489;&#1489;&#1504;&#1497;&#1497;&#1492;</option>
      <option value="deposited">&#1492;&#1493;&#1508;&#1511;&#1491;&#1492;</option>
      <option value="pre_deposit">&#1496;&#1512;&#1493;&#1501; &#1492;&#1508;&#1511;&#1491;&#1492;</option>
      <option value="planning">&#1489;&#1514;&#1499;&#1504;&#1493;&#1503;</option>
      <option value="declared">&#1492;&#1493;&#1499;&#1512;&#1494;</option>
    </select>
  </div>
  <div id="comm-table"><div class="empty-msg">Loading...</div></div>
</div>
</div>

<div id="tab-leads" class="tab-content">
<div class="panel">
  <div class="panel-head">
    <div class="panel-title">&#9889; Lead Management</div>
    <span class="panel-sub">Yad2 + stress indicators</span>
  </div>
  <div class="filters">
    <select class="filter-select" id="leads-city" onchange="loadLeads()"><option value="">&#1499;&#1500; &#1492;&#1506;&#1512;&#1497;&#1501;</option></select>
    <select class="filter-select" id="leads-source" onchange="loadLeads()"><option value="">&#1499;&#1500; &#1492;&#1502;&#1511;&#1493;&#1512;&#1493;&#1514;</option></select>
    <select class="filter-select" id="leads-sort" onchange="loadLeads()">
      <option value="iai">&#1500;&#1508;&#1497; IAI</option>
      <option value="price">&#1500;&#1508;&#1497; &#1502;&#1495;&#1497;&#1512;</option>
      <option value="days">&#1500;&#1508;&#1497; &#1497;&#1502;&#1497;&#1501; &#1513;&#1493;&#1511;</option>
      <option value="ssi">&#1500;&#1508;&#1497; SSI</option>
    </select>
    <button class="btn" onclick="loadLeads()">&#1512;&#1506;&#1504;&#1503;</button>
  </div>
  <div id="leads-table"><div class="empty-msg">Loading...</div></div>
</div>
</div>

<div id="tab-kones" class="tab-content">
<div class="panel">
  <div class="panel-head">
    <div class="panel-title">&#9888; &#1499;&#1497;&#1504;&#1493;&#1505;&#1497; &#1504;&#1499;&#1505;&#1497;&#1501;</div>
    <span class="panel-sub">&#1504;&#1499;&#1505;&#1497;&#1501; &#1489;&#1499;&#1497;&#1504;&#1493;&#1505; - &#1492;&#1494;&#1491;&#1502;&#1504;&#1493;&#1497;&#1493;&#1514; &#1497;&#1497;&#1495;&#1493;&#1491;&#1493;&#1514;</span>
  </div>
  <div class="filters">
    <input class="filter-input" id="kones-search" placeholder="&#1495;&#1508;&#1513; &#1506;&#1497;&#1512; / &#1499;&#1514;&#1493;&#1489;&#1514;..." oninput="filterKones()">
    <button class="btn" onclick="loadKones()">&#1512;&#1506;&#1504;&#1503;</button>
  </div>
  <div id="kones-table"><div class="empty-msg">Loading...</div></div>
</div>
</div>

<div id="tab-whatsapp" class="tab-content">
<div class="ws-stats">
  <div class="stat-card-mini"><div class="mini-val" id="ws-total">-</div><div class="mini-label">&#1505;&#1492;"&#1499; &#1502;&#1504;&#1493;&#1497;&#1497;&#1501;</div></div>
  <div class="stat-card-mini"><div class="mini-val" id="ws-active" style="color:#06d6a0">-</div><div class="mini-label">&#1502;&#1504;&#1493;&#1497;&#1497;&#1501; &#1508;&#1506;&#1497;&#1500;&#1497;&#1501;</div></div>
  <div class="stat-card-mini"><div class="mini-val" id="ws-leads">-</div><div class="mini-label">&#1500;&#1497;&#1491;&#1497;&#1501; &#1497;&#1497;&#1495;&#1493;&#1491;&#1497;&#1497;&#1501;</div></div>
  <div class="stat-card-mini"><div class="mini-val" id="ws-alerts" style="color:#ffc233">-</div><div class="mini-label">&#1505;&#1492;"&#1499; &#1492;&#1514;&#1512;&#1488;&#1493;&#1514;</div></div>
</div>
<div class="panel">
  <div class="panel-head">
    <div class="panel-title">&#128242; &#1512;&#1513;&#1497;&#1502;&#1514; &#1502;&#1504;&#1493;&#1497;&#1497;&#1501;</div>
    <button class="btn" onclick="loadWS()">&#1512;&#1506;&#1504;&#1503;</button>
  </div>
  <div id="ws-table"><div class="empty-msg">Loading...</div></div>
</div>
</div>

<div id="tab-morning" class="tab-content">
<div class="morning-hero">
  <div class="morning-date" id="morning-date"></div>
  <div class="morning-title">&#9728; QUANTUM Morning Brief</div>
  <div class="morning-sub">&#1491;&#1493;&#1495; &#1502;&#1493;&#1491;&#1497;&#1506;&#1497;&#1503; &#1497;&#1493;&#1502;&#1497; - &#1492;&#1494;&#1491;&#1502;&#1504;&#1493;&#1497;&#1493;&#1514;, &#1500;&#1495;&#1509; &#1502;&#1493;&#1499;&#1512;&#1497;&#1501;, &#1497;&#1512;&#1497;&#1491;&#1493;&#1514; &#1502;&#1495;&#1497;&#1512;</div>
</div>
<div id="morning-content"><div class="empty-msg">Loading...</div></div>
</div>

</div>

<script>
let allProps=[],allComm=[],allKones=[];
function setTime(){const n=new Date();document.getElementById('time-display').textContent=n.toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'});}
setTime();setInterval(setTime,30000);
document.getElementById('morning-date').textContent=new Date().toLocaleDateString('he-IL',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
function navigate(tab){
  document.querySelectorAll('.nav-btn').forEach(function(b){b.classList.toggle('active',b.dataset.tab===tab);});
  document.querySelectorAll('.tab-content').forEach(function(t){t.classList.toggle('active',t.id==='tab-'+tab);});
  if(tab==='properties'&&!allProps.length)loadProps();
  if(tab==='committees'&&!allComm.length)loadComm();
  if(tab==='leads')loadLeads();
  if(tab==='kones'&&!allKones.length)loadKones();
  if(tab==='whatsapp')loadWS();
  if(tab==='morning')loadMorning();
}
async function reloadSSI(){
  const btn=document.getElementById('ssi-btn');btn.textContent='...';
  try{await fetch('/api/scan/ai/trigger',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'quick'})});btn.textContent='&#8876; OK!';}catch(e){btn.textContent='Error';}
  setTimeout(function(){btn.textContent='&#8876; SSI';},3000);
}
(async function(){
  try{
    const h=await fetch('/api/health').then(function(r){return r.json();});
    const al=await fetch('/api/alerts?limit=50').then(function(r){return r.json();});
    const sc=await fetch('/api/scan/ai/status').then(function(r){return r.json();});
    if(h.complexes)document.getElementById('stat-complexes').textContent=h.complexes.toLocaleString();
    document.getElementById('stat-alerts').textContent=(al.alerts||[]).filter(function(a){return !a.read;}).length;
    if(sc){const run=sc.running||0;document.getElementById('stat-scans').textContent=run>0?('&#9889;'+run):(sc.completed||0);document.getElementById('stat-scans-sub').textContent=run>0?'RUNNING':'COMPLETED';}
  }catch(e){}
  try{
    const data=await fetch('/api/opportunities').then(function(r){return r.json();});
    const opps=(data.opportunities||[]).slice(0,8);
    if(!opps.length){document.getElementById('top-opps-list').innerHTML='<div class="empty-msg">No data</div>';return;}
    let h='<table><thead><tr><th>&#1502;&#1514;&#1495;&#1501;</th><th>&#1506;&#1497;&#1512;</th><th>IAI</th><th>&#1497;&#1494;&#1501;</th><th>&#1505;&#1496;&#1496;&#1493;&#1505;</th><th class="c">&#1508;&#1512;&#1496;&#1497;&#1501;</th></tr></thead><tbody>';
    opps.forEach(function(o){const sc=parseFloat(o.iai_score)||0;const cl=sc>=80?'badge-critical':sc>=60?'badge-high':sc>=40?'badge-med':'badge-low';h+='<tr><td class="fw nw">'+(o.name||'')+'</td><td class="dim xs">'+(o.city||'')+'</td><td><span class="badge '+cl+'">'+sc.toFixed(1)+'</span></td><td class="dim xs">'+(o.developer||'-')+'</td><td class="xs dim">'+(o.status||'')+'</td><td class="c"><a href="/api/dashboard/complex/'+o.id+'" target="_blank" class="btn-link">&#1508;&#1512;&#1496;&#1497;&#1501;</a></td></tr>';});
    h+='</tbody></table>';document.getElementById('top-opps-list').innerHTML=h;
  }catch(e){document.getElementById('top-opps-list').innerHTML='<div class="empty-msg">Error</div>';}
})();
async function loadProps(){
  try{const data=await fetch('/api/dashboard/committees').then(function(r){return r.json();});allProps=data;filterProps();}
  catch(e){document.getElementById('props-table').innerHTML='<div class="empty-msg">Error</div>';}
}
function filterProps(){
  const search=(document.getElementById('prop-search').value||'').toLowerCase();
  const status=document.getElementById('prop-status').value;
  const sort=document.getElementById('prop-sort').value;
  let f=allProps.filter(function(p){return(!status||p.status===status)&&(!search||(p.complex_name||'').toLowerCase().includes(search)||(p.city||'').toLowerCase().includes(search));});
  if(sort==='iai')f.sort(function(a,b){return(b.iai_score||0)-(a.iai_score||0);});
  else if(sort==='name')f.sort(function(a,b){return(a.complex_name||'').localeCompare(b.complex_name||'');});
  else if(sort==='city')f.sort(function(a,b){return(a.city||'').localeCompare(b.city||'');});
  document.getElementById('prop-count').textContent=f.length+' &#1502;&#1514;&#1495;&#1502;&#1497;&#1501;';
  if(!f.length){document.getElementById('props-table').innerHTML='<div class="empty-msg">&#1500;&#1488; &#1504;&#1502;&#1510;&#1488;&#1493;</div>';return;}
  const stMap={approved:'&#1502;&#1488;&#1493;&#1513;&#1512;',deposited:'&#1492;&#1493;&#1508;&#1511;&#1491;&#1492;',pre_deposit:'&#1496;&#1512;&#1493;&#1501; &#1492;&#1508;&#1511;&#1491;&#1492;',planning:'&#1489;&#1514;&#1499;&#1504;&#1493;&#1503;',construction:'&#1489;&#1489;&#1504;&#1497;&#1497;&#1492;',declared:'&#1492;&#1493;&#1499;&#1512;&#1494;',unknown:'&#1500;&#1488; &#1497;&#1491;&#1493;&#1506;'};
  let h='<table><thead><tr><th>&#1502;&#1514;&#1495;&#1501;</th><th>&#1506;&#1497;&#1512;</th><th>&#1514;&#1488;&#1512;&#1497;&#1498;</th><th>&#1505;&#1496;&#1496;&#1493;&#1505;</th><th class="c">&#1508;&#1512;&#1496;&#1497;&#1501;</th></tr></thead><tbody>';
  f.forEach(function(p){h+='<tr><td class="fw">'+(p.complex_name||'')+'</td><td class="dim xs">'+(p.city||'')+'</td><td class="xs dim">'+(p.date?new Date(p.date).toLocaleDateString('he-IL'):'-')+'</td><td><span class="badge-status status-'+(p.status||'unknown')+'">'+(stMap[p.status]||p.status||'')+'</span></td><td class="c"><a href="/api/dashboard/complex/'+(p.id||'')+'" target="_blank" class="btn-link">&#1508;&#1512;&#1496;&#1497;&#1501;</a></td></tr>';});
  h+='</tbody></table>';document.getElementById('props-table').innerHTML=h;
}
async function loadComm(){
  try{const data=await fetch('/api/dashboard/committees').then(function(r){return r.json();});allComm=data;filterComm();}
  catch(e){document.getElementById('comm-table').innerHTML='<div class="empty-msg">Error</div>';}
}
function filterComm(){
  const search=(document.getElementById('comm-search').value||'').toLowerCase();
  const status=document.getElementById('comm-status').value;
  let f=allComm.filter(function(p){return(!status||p.status===status)&&(!search||(p.complex_name||'').toLowerCase().includes(search)||(p.city||'').toLowerCase().includes(search));});
  if(!f.length){document.getElementById('comm-table').innerHTML='<div class="empty-msg">&#1500;&#1488; &#1504;&#1502;&#1510;&#1488;&#1493;</div>';return;}
  const stMap={approved:'&#1502;&#1488;&#1493;&#1513;&#1512;',deposited:'&#1492;&#1493;&#1508;&#1511;&#1491;&#1492;',pre_deposit:'&#1496;&#1512;&#1493;&#1501; &#1492;&#1508;&#1511;&#1491;&#1492;',planning:'&#1489;&#1514;&#1499;&#1504;&#1493;&#1503;',construction:'&#1489;&#1489;&#1504;&#1497;&#1497;&#1492;',declared:'&#1492;&#1493;&#1499;&#1512;&#1494;',unknown:'&#1500;&#1488; &#1497;&#1491;&#1493;&#1506;'};
  let h='<table><thead><tr><th>&#1502;&#1514;&#1495;&#1501;</th><th>&#1506;&#1497;&#1512;</th><th>&#1514;&#1488;&#1512;&#1497;&#1498; &#1488;&#1497;&#1513;&#1493;&#1512;</th><th>&#1502;&#1505;&#39; &#1514;&#1493;&#1499;&#1504;&#1497;&#1514;</th><th>&#1505;&#1496;&#1496;&#1493;&#1505;</th></tr></thead><tbody>';
  f.forEach(function(p){h+='<tr><td class="fw">'+(p.complex_name||'')+'</td><td class="dim xs">'+(p.city||'')+'</td><td class="xs dim">'+(p.date?new Date(p.date).toLocaleDateString('he-IL'):'-')+'</td><td class="xs dim">'+(p.plan_number||'-')+'</td><td><span class="badge-status status-'+(p.status||'unknown')+'">'+(stMap[p.status]||p.status||'')+'</span></td></tr>';});
  h+='</tbody></table>';document.getElementById('comm-table').innerHTML=h;
}
async function loadLeads(){
  const city=document.getElementById('leads-city').value;
  const source=document.getElementById('leads-source').value;
  const sort=document.getElementById('leads-sort').value;
  document.getElementById('leads-table').innerHTML='<div class="empty-msg">Loading...</div>';
  try{
    const url='/api/dashboard/listings?sort='+sort+'&limit=100'+(city?'&city='+city:'')+(source?'&source='+source:'');
    const data=await fetch(url).then(function(r){return r.json();});
    const listings=data.listings||[];
    if(document.getElementById('leads-city').options.length===1&&data.cities)data.cities.forEach(function(c){document.getElementById('leads-city').add(new Option(c,c));});
    if(document.getElementById('leads-source').options.length===1&&data.sources)data.sources.forEach(function(s){document.getElementById('leads-source').add(new Option(s,s));});
    if(!listings.length){document.getElementById('leads-table').innerHTML='<div class="empty-msg">&#1500;&#1488; &#1504;&#1502;&#1510;&#1488;&#1493; &#1500;&#1497;&#1505;&#1496;&#1497;&#1504;&#1490;&#1497;&#1501;</div>';return;}
    let h='<table><thead><tr><th>&#1502;&#1514;&#1495;&#1501;</th><th>&#1506;&#1497;&#1512;</th><th>&#1502;&#1495;&#1497;&#1512;</th><th>&#1495;\'</th><th>&#1502;"&#1512;</th><th>&#1497;&#1502;&#1497;&#1501;</th><th>SSI</th><th>&#1502;&#1511;&#1493;&#1512;</th><th class="c">&#1511;&#1497;&#1513;&#1493;&#1512;</th></tr></thead><tbody>';
    listings.forEach(function(l){
      const dom=l.days_on_market||0;
      const dc=dom>60?' style="color:#ef4444"':dom>30?' style="color:#f59e0b"':'';
      const ssi=parseFloat(l.ssi_score)||0;
      const sc=ssi>=50?'badge-critical':ssi>=30?'badge-high':ssi>0?'badge-med':'';
      h+='<tr><td class="fw xs">'+(l.complex_name||'')+'</td><td class="dim xs">'+(l.city||'')+'</td><td class="nw fw">'+(l.asking_price?'&#8362;'+Math.round(l.asking_price/1000)+'K':'-')+'</td><td class="c">'+(l.rooms||'-')+'</td><td class="c">'+(l.area_sqm||'-')+'</td><td class="c"'+dc+'>'+(dom||'-')+'</td><td class="c">'+(ssi>0?'<span class="badge '+sc+'">'+ssi.toFixed(0)+'</span>':'-')+'</td><td><span class="badge-src src-'+(l.source||'other')+'">'+(l.source||'')+'</span></td><td class="c">'+(l.url?'<a href="'+l.url+'" target="_blank" class="btn-link">&#1511;&#1497;&#1513;&#1493;&#1512;</a>':'-')+'</td></tr>';
    });
    h+='</tbody></table>';document.getElementById('leads-table').innerHTML=h;
  }catch(e){document.getElementById('leads-table').innerHTML='<div class="empty-msg">Error</div>';}
}
async function loadKones(){
  document.getElementById('kones-table').innerHTML='<div class="empty-msg">Loading...</div>';
  try{
    const data=await fetch('/api/dashboard/kones/listings').then(function(r){return r.json();});
    allKones=Array.isArray(data)?data:(data.listings||[]);filterKones();
  }catch(e){document.getElementById('kones-table').innerHTML='<div class="empty-msg">Error</div>';}
}
function filterKones(){
  const search=(document.getElementById('kones-search').value||'').toLowerCase();
  const f=allKones.filter(function(k){return(!search||(k.complex_name||'').toLowerCase().includes(search)||(k.city||'').toLowerCase().includes(search)||(k.address||'').toLowerCase().includes(search));});
  if(!f.length){document.getElementById('kones-table').innerHTML='<div class="empty-msg">&#1488;&#1497;&#1503; &#1504;&#1499;&#1505;&#1497;&#1501; &#1489;&#1499;&#1497;&#1504;&#1493;&#1505; &#1499;&#1512;&#1490;&#1506;</div>';return;}
  let h='<table><thead><tr><th>&#1502;&#1514;&#1495;&#1501;</th><th>&#1506;&#1497;&#1512;</th><th>&#1499;&#1514;&#1493;&#1489;&#1514;</th><th>&#1502;&#1495;&#1497;&#1512;</th><th>&#1495;\'</th><th>&#1502;"&#1512;</th><th class="c">&#1511;&#1497;&#1513;&#1493;&#1512;</th></tr></thead><tbody>';
  f.forEach(function(k){h+='<tr><td class="fw xs">'+(k.complex_name||'')+'</td><td class="dim xs">'+(k.city||'')+'</td><td class="dim xs">'+(k.address||'-')+'</td><td class="nw">'+(k.asking_price?'&#8362;'+Math.round(k.asking_price/1000)+'K':'-')+'</td><td class="c">'+(k.rooms||'-')+'</td><td class="c">'+(k.area_sqm||'-')+'</td><td class="c">'+(k.url?'<a href="'+k.url+'" target="_blank" class="btn-link">&#1511;&#1497;&#1513;&#1493;&#1512;</a>':'-')+'</td></tr>';});
  h+='</tbody></table>';document.getElementById('kones-table').innerHTML=h;
}
async function loadWS(){
  try{
    const stats=await fetch('/api/dashboard/whatsapp/subscriptions/stats').then(function(r){return r.json();});
    document.getElementById('ws-total').textContent=stats.totalSubscriptions||0;
    document.getElementById('ws-active').textContent=stats.activeSubscriptions||0;
    document.getElementById('ws-leads').textContent=stats.uniqueLeads||0;
    document.getElementById('ws-alerts').textContent=stats.totalAlertsSent||0;
  }catch(e){}
  document.getElementById('ws-table').innerHTML='<div class="empty-msg">Loading...</div>';
  try{
    const data=await fetch('/api/dashboard/whatsapp/subscriptions/0').then(function(r){return r.json();});
    if(!Array.isArray(data)||!data.length){document.getElementById('ws-table').innerHTML='<div class="empty-msg">&#1488;&#1497;&#1503; &#1502;&#1504;&#1493;&#1497;&#1497;&#1501; &#1512;&#1513;&#1493;&#1502;&#1497;&#1501;</div>';return;}
    let h='<table><thead><tr><th>Lead ID</th><th>&#1508;&#1506;&#1497;&#1500;</th><th>&#1506;&#1512;&#1497;&#1501;</th><th>&#1495;&#1491;&#1512;&#1497;&#1501;</th><th>&#1502;&#1495;&#1497;&#1512;</th><th>&#1492;&#1514;&#1512;&#1488;&#1493;&#1514;</th></tr></thead><tbody>';
    data.forEach(function(s){
      const cr=s.criteria||{};const cities=(cr.cities||[]).join(', ')||'-';
      const rooms=cr.rooms_min||cr.rooms_max?(cr.rooms_min||'*')+'-'+(cr.rooms_max||'*'):'-';
      const price=cr.price_max?'&#1506;&#1491; &#8362;'+Math.round(cr.price_max/1000000)+'M':'-';
      h+='<tr><td class="fw xs">'+(s.lead_id||'')+'</td><td class="c">'+(s.active?'<span class="badge-status status-approved">&#1508;&#1506;&#1497;&#1500;</span>':'<span class="badge-status status-unknown">&#1499;&#1489;&#1493;&#1497;</span>')+'</td><td class="dim xs">'+cities+'</td><td class="c xs">'+rooms+'</td><td class="xs">'+price+'</td><td class="c">'+(s.alerts_sent||0)+'</td></tr>';
    });
    h+='</tbody></table>';document.getElementById('ws-table').innerHTML=h;
  }catch(e){document.getElementById('ws-table').innerHTML='<div class="empty-msg">&#1488;&#1497;&#1503; &#1502;&#1504;&#1493;&#1497;&#1497;&#1501;</div>';}
}
async function loadMorning(){
  document.getElementById('morning-content').innerHTML='<div class="empty-msg">Loading...</div>';
  try{
    const data=await fetch('/api/morning/preview').then(function(r){return r.json();});
    const opps=data.opportunities||[];const sellers=data.stressed_sellers||[];const drops=data.price_drops_24h||[];
    let h='<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">'+
      '<div style="grid-column:1/-1"><div class="panel panel-gold"><div class="panel-head"><div class="panel-title">&#9733; &#1492;&#1494;&#1491;&#1502;&#1504;&#1493;&#1497;&#1493;&#1514; &#1492;&#1513;&#1511;&#1506;&#1492;</div><span class="panel-sub">IAI &ge; 60 &bull; '+opps.length+' &#1502;&#1514;&#1495;&#1502;&#1497;&#1501;</span></div>';
    if(opps.length){
      h+='<table><thead><tr><th>&#1502;&#1514;&#1495;&#1501;</th><th>&#1506;&#1497;&#1512;</th><th>IAI</th><th>&#1497;&#1494;&#1501;</th><th>&#1505;&#1496;&#1496;&#1493;&#1505;</th></tr></thead><tbody>';
      opps.forEach(function(o){const sc=parseFloat(o.iai_score)||0;const cl=sc>=80?'badge-critical':sc>=60?'badge-high':'badge-med';h+='<tr><td class="fw xs">'+(o.name||'')+'</td><td class="dim xs">'+(o.city||'')+'</td><td><span class="badge '+cl+'">'+sc.toFixed(0)+'</span></td><td class="dim xs">'+(o.developer||'-')+'</td><td class="xs dim">'+(o.status||'')+'</td></tr>';});
      h+='</tbody></table>';
    }else{h+='<div class="empty-msg">&#1488;&#1497;&#1503; &#1504;&#1514;&#1493;&#1504;&#1497;&#1501;</div>';}
    h+='</div></div>';
    h+='<div class="panel"><div class="panel-head"><div class="panel-title">&#9888; &#1502;&#1493;&#1499;&#1512;&#1497;&#1501; &#1489;&#1500;&#1495;&#1509;</div><span class="panel-sub">SSI &ge; 30</span></div>';
    if(sellers.length){
      h+='<table><thead><tr><th>&#1499;&#1514;&#1493;&#1489;&#1514;</th><th>&#1506;&#1497;&#1512;</th><th>&#1502;&#1495;&#1497;&#1512;</th><th>SSI</th><th>&#1497;&#1502;&#1497;&#1501;</th></tr></thead><tbody>';
      sellers.forEach(function(s){const ssi=parseFloat(s.ssi_score)||0;const cl=ssi>=50?'badge-critical':'badge-high';h+='<tr><td class="fw xs">'+(s.address||s.complex_name||'')+'</td><td class="dim xs">'+(s.city||'')+'</td><td class="nw xs">'+(s.asking_price?'&#8362;'+Math.round(s.asking_price/1000)+'K':'-')+'</td><td><span class="badge '+cl+'">'+ssi.toFixed(0)+'</span></td><td class="c xs">'+(s.days_on_market||'-')+'</td></tr>';});
      h+='</tbody></table>';
    }else{h+='<div class="empty-msg">&#1488;&#1497;&#1503; &#1504;&#1514;&#1493;&#1504;&#1497;&#1501;</div>';}
    h+='</div>';
    h+='<div class="panel"><div class="panel-head"><div class="panel-title">&#8595; &#1497;&#1512;&#1497;&#1491;&#1493;&#1514; &#1502;&#1495;&#1497;&#1512; 24&#1513;</div><span class="panel-sub">&#1497;&#1512;&#1497;&#1491;&#1492; &ge; 5%</span></div>';
    if(drops.length){
      h+='<table><thead><tr><th>&#1499;&#1514;&#1493;&#1489;&#1514;</th><th>&#1506;&#1497;&#1512;</th><th>&#1502;&#1495;&#1497;&#1512;</th><th>&#1497;&#1512;&#1497;&#1491;&#1492;</th></tr></thead><tbody>';
      drops.forEach(function(d){const dp=parseFloat(d.total_price_drop_percent)||0;h+='<tr><td class="fw xs">'+(d.address||d.complex_name||'')+'</td><td class="dim xs">'+(d.city||'')+'</td><td class="nw xs">'+(d.asking_price?'&#8362;'+Math.round(d.asking_price/1000)+'K':'-')+'</td><td style="color:#ef4444;font-weight:700">-'+dp.toFixed(1)+'%</td></tr>';});
      h+='</tbody></table>';
    }else{h+='<div class="empty-msg">&#1488;&#1497;&#1503; &#1497;&#1512;&#1497;&#1491;&#1493;&#1514; &#1489;-24 &#1513;&#1506;&#1493;&#1514;</div>';}
    h+='</div></div>';
    document.getElementById('morning-content').innerHTML=h;
  }catch(e){document.getElementById('morning-content').innerHTML='<div class="panel"><div class="empty-msg">Error: '+e.message+'</div></div>';}
}
</script>
</body>
</html>`);
  } catch (err) {
    res.status(500).send('Dashboard error: ' + err.message);
  }
});

module.exports = router;
