/**
 * QUANTUM Event Scheduler Routes — v1.2
 *
 * Admin routes (Basic Auth protected):
 *   GET  /events/                        — list events
 *   POST /events/                        — create event
 *   GET  /events/:id                     — event details + attendees per station
 *   POST /events/:id/stations            — add station (auto-imports Zoho residents)
 *   POST /events/:id/stations/:sid/slots — generate slots
 *   POST /events/:id/stations/:sid/assign — auto-assign attendees to slots
 *   GET  /events/:id/report              — full report JSON
 *   GET  /events/zoho/compounds          — list Zoho compounds
 *   GET  /events/zoho/buildings/:cid     — list buildings in compound
 *
 * Professional HTML (token-protected, no Basic Auth):
 *   GET  /events/pro/:token              — attendance page
 *   POST /events/pro/:token/attendee/:id — update status
 *   GET  /events/pro/:token/pdf          — printable list
 *
 * Attendee HTML (token-protected, no Basic Auth):
 *   GET  /events/attend/:token           — confirmation page
 *   POST /events/attend/:token/confirm   — confirm/cancel/reschedule
 */

const express  = require('express');
const router   = express.Router();
const pool     = require('../db/pool');
const { logger } = require('../services/logger');

let zohoSvc;
try { zohoSvc = require('../services/zohoResidentsService'); } catch (e) {}

const BASE_URL = 'https://pinuy-binuy-analyzer-production.up.railway.app';

// ── Basic Auth middleware (admin only) ────────────────────────────────────────

function adminAuth(req, res, next) {
  const expected = process.env.EVENT_BASIC_AUTH || 'Basic UVVBTlRVTTpkZDRhN2U5YS0xOWYyLTQzYjktOTM2Yy01YmQ0OTRlZWRjNWM=';
  const provided  = req.headers['authorization'] || '';

  if (provided === expected) return next();

  res.setHeader('WWW-Authenticate', 'Basic realm="QUANTUM Events"');
  return res.status(401).send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head><meta charset="UTF-8"><title>QUANTUM | כניסה נדרשת</title>
<style>body{font-family:'Segoe UI',sans-serif;background:#0a0a0f;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{text-align:center}.logo{color:#4fc3f7;font-size:24px;font-weight:700;margin-bottom:12px}.msg{color:#78909c;font-size:14px}</style>
</head>
<body><div class="box"><div class="logo">QUANTUM</div><div class="msg">נדרשת הרשאת כניסה</div></div></body></html>`);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function ok(res, data)    { res.json({ success: true, ...data }); }
function err(res, msg, status = 500) { res.status(status).json({ success: false, error: msg }); }

function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleString('he-IL', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Auto-import Zoho residents into a station (background, fire-and-forget) ──

async function autoImportResidents(stationId, zohoCompoundId, compoundName) {
  if (!zohoSvc || !zohoCompoundId) return;
  try {
    const residents = await zohoSvc.getResidentsForCompound(zohoCompoundId, compoundName || '');
    let inserted = 0;
    for (const r of residents) {
      const ex = await pool.query(
        'SELECT id FROM event_attendees WHERE station_id=$1 AND zoho_contact_id=$2',
        [stationId, r.zoho_contact_id]
      );
      if (ex.rows.length) continue;
      await pool.query(
        `INSERT INTO event_attendees
           (station_id, zoho_contact_id, zoho_asset_id, name, phone, unit_number, floor, building_name, compound_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [stationId, r.zoho_contact_id, r.zoho_asset_id, r.name, r.phone,
         r.unit_number, r.floor, r.building_name, r.compound_name]
      );
      inserted++;
    }
    logger.info(`[Events] Auto-imported ${inserted}/${residents.length} residents → station ${stationId}`);
  } catch (e) {
    logger.error(`[Events] Auto-import error (station ${stationId}):`, e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC TOKEN ROUTES — /pro/:token  and  /attend/:token
// These must be declared BEFORE adminAuth middleware
// ═══════════════════════════════════════════════════════════════════════════════

// ── Professional HTML page ────────────────────────────────────────────────────

router.get('/pro/:token', async (req, res) => {
  try {
    const { rows: st } = await pool.query(
      'SELECT s.*, e.title, e.event_date, e.location, e.compound_name FROM event_stations s JOIN quantum_events e ON e.id=s.event_id WHERE s.token=$1',
      [req.params.token]
    );
    if (!st.length) return res.status(404).send('<h2>קישור לא תקין</h2>');
    const station = st[0];

    const { rows: attendees } = await pool.query(`
      SELECT a.*, sl.start_time, sl.end_time
      FROM event_attendees a
      LEFT JOIN event_slots sl ON sl.id = a.slot_id
      WHERE a.station_id = $1
      ORDER BY sl.start_time NULLS LAST, a.building_name, a.unit_number
    `, [station.id]);

    const roleLabel = { lawyer:'עורך דין', surveyor:'מודד', appraiser:'שמאי', other:'מקצוען' }[station.pro_role] || station.pro_role;
    const stats = {
      total:     attendees.length,
      confirmed: attendees.filter(a => a.status === 'confirmed').length,
      cancelled: attendees.filter(a => a.status === 'cancelled').length,
      arrived:   attendees.filter(a => a.status === 'arrived').length,
      no_show:   attendees.filter(a => a.status === 'no_show').length,
    };

    const token = req.params.token;
    const tableRows = attendees.map(a => {
      const time = a.start_time ? fmtDate(a.start_time).split(' ')[1] : '-';
      const statusColors = { confirmed:'#1b5e20', cancelled:'#3c1414', arrived:'#0d47a1', no_show:'#4a1942', pending:'#1a3a5c', rescheduled:'#3e2723' };
      const statusLabels = { confirmed:'אישר', cancelled:'ביטל', arrived:'הגיע', no_show:'לא הגיע', pending:'ממתין', rescheduled:'תיאם מחדש' };
      return `<tr data-id="${a.id}">
        <td style="text-align:center;font-size:13px;color:#90a4ae">${time}</td>
        <td><strong>${esc(a.name)}</strong>${a.unit_number?`<br><span style="font-size:11px;color:#78909c">דירה ${esc(a.unit_number)}${a.floor?', קומה '+esc(a.floor):''}</span>`:''}</td>
        <td style="font-size:12px;color:#b0bec5">${esc(a.building_name||'-')}</td>
        <td style="direction:ltr;font-size:12px">${esc(a.phone||'-')}</td>
        <td><span class="badge" style="background:${statusColors[a.status]||'#263238'}">${statusLabels[a.status]||a.status}</span></td>
        <td>
          <div style="display:flex;gap:4px;flex-wrap:wrap">
            <button class="act-btn" style="background:#0d47a1" onclick="setStatus(${a.id},'arrived',this)">✅ הגיע</button>
            <button class="act-btn" style="background:#3c1414" onclick="setStatus(${a.id},'no_show',this)">❌ לא הגיע</button>
            <button class="act-btn" style="background:#263238" onclick="openNotes(${a.id},'${esc(a.name)}')">📝</button>
          </div>
        </td>
      </tr>`;
    }).join('');

    res.type('html').send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QUANTUM | ${esc(station.pro_name)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',sans-serif;background:#0a0a0f;color:#e0e0e0;direction:rtl}
.topbar{background:linear-gradient(135deg,#0d1117,#161b27);border-bottom:1px solid #1e3a5f;padding:14px 20px;display:flex;align-items:center;justify-content:space-between}
.logo{color:#4fc3f7;font-size:18px;font-weight:700}
.event-header{padding:16px 20px;background:#0d1a2a;border-bottom:1