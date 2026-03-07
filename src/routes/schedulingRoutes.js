/**
 * QUANTUM Scheduling Routes v2
 * POST /api/scheduling/webhook              - Inforu WA webhook
 * GET  /api/scheduling/campaign/:id         - Get campaign config
 * PUT  /api/scheduling/campaign/:id         - Save campaign config
 * POST /api/scheduling/broadcast            - Send initial WA to campaign contacts
 * POST /api/scheduling/ceremony             - Create ceremony
 * GET  /api/scheduling/ceremony/:id/slots   - Get ceremony slot grid
 * GET  /api/scheduling/campaign/:id/stats   - Basic booking stats
 * GET  /api/scheduling/campaign/:id/report  - Full campaign report (HTML+JSON)
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const botEngine = require('../services/botEngine');
const inforuService = require('../services/inforuService');

// ── WEBHOOK - incoming WA messages ────────────────────────────
router.post('/webhook', async (req, res) => {
  try {
    const { From, Body, CampaignId } = req.body;
    if (!From || !Body) return res.sendStatus(200);

    let campaignId = CampaignId;
    if (!campaignId) {
      const sess = await pool.query(
        `SELECT zoho_campaign_id FROM bot_sessions WHERE phone=$1 ORDER BY last_message_at DESC LIMIT 1`,
        [From]
      );
      campaignId = sess.rows[0]?.zoho_campaign_id;
    }

    if (!campaignId) {
      console.warn(`[Webhook] No campaign found for phone ${From}`);
      return res.sendStatus(200);
    }

    const reply = await botEngine.handleIncoming(From, Body, campaignId);
    if (reply) {
      await inforuService.sendWhatsApp(From, reply);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('[Webhook] Error:', err);
    res.sendStatus(500);
  }
});

// ── CAMPAIGN CONFIG ────────────────────────────────────────────
router.get('/campaign/:campaignId', async (req, res) => {
  try {
    const { campaignId } = req.params;
    const result = await pool.query(
      `SELECT csc.*, p.name AS project_name, p.google_calendar_id, p.zoho_calendar_id
       FROM campaign_schedule_config csc
       LEFT JOIN projects p ON csc.project_id = p.id
       WHERE csc.zoho_campaign_id = $1`,
      [campaignId]
    );
    if (!result.rows.length) return res.json({ config: null, message: 'No config found' });
    res.json({ config: result.rows[0] });
  } catch (err) {
    console.error('[Config GET] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/campaign/:campaignId', async (req, res) => {
  try {
    const { campaignId } = req.params;
    const {
      project_id, meeting_type, available_windows, slot_duration_minutes,
      buffer_minutes, reminder_delay_hours, bot_followup_delay_hours,
      pre_meeting_reminder_hours, morning_reminder_hours, wa_initial_template, wa_language
    } = req.body;

    await pool.query(
      `INSERT INTO campaign_schedule_config
         (zoho_campaign_id, project_id, meeting_type, available_windows,
          slot_duration_minutes, buffer_minutes,
          reminder_delay_hours, bot_followup_delay_hours,
          pre_meeting_reminder_hours, morning_reminder_hours,
          wa_initial_template, wa_language, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
       ON CONFLICT (zoho_campaign_id) DO UPDATE SET
         project_id = EXCLUDED.project_id,
         meeting_type = EXCLUDED.meeting_type,
         available_windows = EXCLUDED.available_windows,
         slot_duration_minutes = EXCLUDED.slot_duration_minutes,
         buffer_minutes = EXCLUDED.buffer_minutes,
         reminder_delay_hours = EXCLUDED.reminder_delay_hours,
         bot_followup_delay_hours = EXCLUDED.bot_followup_delay_hours,
         pre_meeting_reminder_hours = EXCLUDED.pre_meeting_reminder_hours,
         morning_reminder_hours = EXCLUDED.morning_reminder_hours,
         wa_initial_template = EXCLUDED.wa_initial_template,
         wa_language = EXCLUDED.wa_language,
         updated_at = NOW()`,
      [
        campaignId, project_id, meeting_type,
        JSON.stringify(available_windows || []),
        slot_duration_minutes || 45,
        buffer_minutes || 15,
        reminder_delay_hours || 24,
        bot_followup_delay_hours || 48,
        pre_meeting_reminder_hours || 24,
        morning_reminder_hours || 2,
        wa_initial_template || '',
        wa_language || 'he'
      ]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[Config PUT] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── BROADCAST ─────────────────────────────────────────────────
router.post('/broadcast', async (req, res) => {
  try {
    const { campaignId, contacts } = req.body;
    const config = await pool.query(
      `SELECT * FROM campaign_schedule_config WHERE zoho_campaign_id = $1`,
      [campaignId]
    );
    if (!config.rows.length) return res.status(400).json({ error: 'Campaign config not found' });
    const cfg = config.rows[0];

    let sent = 0, failed = 0;
    for (const contact of contacts) {
      try {
        const lang = contact.language || cfg.wa_language || 'he';
        const message = buildInitialMessage(contact, cfg, lang);
        await inforuService.sendWhatsApp(contact.phone, message);
        await botEngine.scheduleFollowupSequence(contact.phone, campaignId, contact.contactId, cfg);
        sent++;
        await new Promise(r => setTimeout(r, 300));
      } catch (e) {
        console.error(`[Broadcast] Failed for ${contact.phone}:`, e.message);
        failed++;
      }
    }

    res.json({ sent, failed, total: contacts.length });
  } catch (err) {
    console.error('[Broadcast] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

function buildInitialMessage(contact, cfg, lang) {
  const template = cfg.wa_initial_template;
  if (template) {
    return template.replace('{name}', contact.name).replace('{campaign}', cfg.zoho_campaign_id);
  }
  const types = {
    he: { consultation:'פגישת ייעוץ', appraiser:'ביקור שמאי', signing_ceremony:'כנס חתימות', physical:'פגישה פיזית', surveyor:'ביקור מודד' },
    ru: { consultation:'консультация', appraiser:'визит оценщика', signing_ceremony:'церемония подписания', physical:'встреча в офисе', surveyor:'визит геодезиста' }
  };
  const typeLabel = (types[lang] || types.he)[cfg.meeting_type] || cfg.meeting_type;
  if (lang === 'ru') {
    return `Здравствуйте, ${contact.name} 👋\n\nQUANTUM на связи.\n\nГотовы назначить *${typeLabel}* для вашей квартиры.\n\nНажмите *1* и мы запишем вас прямо сейчас.`;
  }
  return `שלום ${contact.name} 👋\n\nQUANTUM כאן.\n\nאנחנו מוכנים לתאם *${typeLabel}* עבור דירתך.\n\nענה/י *1* ונתאם עכשיו.`;
}

// ── CEREMONY ──────────────────────────────────────────────────
router.post('/ceremony', async (req, res) => {
  try {
    const {
      project_id, zoho_campaign_id, name,
      ceremony_date, start_time, end_time,
      slot_duration_minutes, break_duration_minutes, location, buildings
    } = req.body;

    const cermRes = await pool.query(
      `INSERT INTO signing_ceremonies
         (project_id, zoho_campaign_id, name, ceremony_date, start_time, end_time,
          slot_duration_minutes, break_duration_minutes, location)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [project_id, zoho_campaign_id, name, ceremony_date, start_time, end_time,
       slot_duration_minutes || 15, break_duration_minutes || 0, location]
    );
    const ceremonyId = cermRes.rows[0].id;

    for (const bld of (buildings || [])) {
      const bldRes = await pool.query(
        `INSERT INTO ceremony_buildings (ceremony_id, building_address, building_label) VALUES ($1,$2,$3) RETURNING id`,
        [ceremonyId, bld.address, bld.label || bld.address]
      );
      const buildingId = bldRes.rows[0].id;
      for (let i = 0; i < (bld.stations || []).length; i++) {
        const st = bld.stations[i];
        const stRes = await pool.query(
          `INSERT INTO ceremony_stations (building_id, station_number, representative_name, representative_role) VALUES ($1,$2,$3,$4) RETURNING id`,
          [buildingId, i + 1, st.repName, st.repRole || 'עורך דין']
        );
        await generateCeremonySlots(ceremonyId, stRes.rows[0].id, ceremony_date, start_time, end_time, slot_duration_minutes || 15, break_duration_minutes || 0);
      }
    }

    res.json({ success: true, ceremonyId });
  } catch (err) {
    console.error('[Ceremony POST] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

async function generateCeremonySlots(ceremonyId, stationId, date, startTime, endTime, slotMin, breakMin) {
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  const startMins = sh * 60 + sm;
  const endMins = eh * 60 + em;
  const step = slotMin + breakMin;
  for (let m = startMins; m + slotMin <= endMins; m += step) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    await pool.query(
      `INSERT INTO ceremony_slots (station_id, ceremony_id, slot_time, slot_date, duration_minutes) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [stationId, ceremonyId, `${hh}:${mm}`, date, slotMin]
    );
  }
}

// ── CEREMONY SLOT GRID ────────────────────────────────────────
router.get('/ceremony/:id/slots', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT cb.building_address, cb.building_label,
              cst.station_number, cst.representative_name,
              cs.id AS slot_id, cs.slot_time, cs.slot_date, cs.status,
              cs.contact_name, cs.contact_phone
       FROM ceremony_slots cs
       JOIN ceremony_stations cst ON cs.station_id = cst.id
       JOIN ceremony_buildings cb ON cst.building_id = cb.id
       WHERE cs.ceremony_id = $1
       ORDER BY cb.display_order, cst.station_number, cs.slot_time`,
      [req.params.id]
    );
    res.json({ slots: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── BASIC STATS ───────────────────────────────────────────────
router.get('/campaign/:campaignId/stats', async (req, res) => {
  try {
    const { campaignId } = req.params;
    const [botStats, reminderStats, slotStats] = await Promise.all([
      pool.query(`SELECT state, COUNT(*) FROM bot_sessions WHERE zoho_campaign_id=$1 GROUP BY state`, [campaignId]),
      pool.query(`SELECT reminder_type, status, COUNT(*) FROM reminder_queue WHERE zoho_campaign_id=$1 GROUP BY reminder_type, status`, [campaignId]),
      pool.query(`SELECT status, COUNT(*) FROM meeting_slots WHERE campaign_id=$1 GROUP BY status`, [campaignId])
    ]);
    res.json({ botSessions: botStats.rows, reminders: reminderStats.rows, meetingSlots: slotStats.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── FULL CAMPAIGN REPORT ──────────────────────────────────────
// GET /api/scheduling/campaign/:campaignId/report?format=json|html
router.get('/campaign/:campaignId/report', async (req, res) => {
  try {
    const { campaignId } = req.params;
    const format = req.query.format || 'html';

    // 1. Config & project info
    const configRes = await pool.query(
      `SELECT csc.*, p.name AS project_name
       FROM campaign_schedule_config csc
       LEFT JOIN projects p ON csc.project_id = p.id
       WHERE csc.zoho_campaign_id = $1`,
      [campaignId]
    );
    const config = configRes.rows[0] || {};

    // 2. Session funnel
    const sessionsRes = await pool.query(
      `SELECT state,
              COUNT(*) AS total,
              COUNT(CASE WHEN language='ru' THEN 1 END) AS russian,
              COUNT(CASE WHEN language='he' THEN 1 END) AS hebrew
       FROM bot_sessions
       WHERE zoho_campaign_id=$1
       GROUP BY state
       ORDER BY total DESC`,
      [campaignId]
    );

    // 3. Confirmed meetings with times
    const confirmedRes = await pool.query(
      `SELECT bs.phone, bs.language,
              bs.context->>'contactName' AS name,
              ms.slot_datetime,
              TO_CHAR(ms.slot_datetime AT TIME ZONE 'Asia/Jerusalem','DD/MM/YYYY') AS date_str,
              TO_CHAR(ms.slot_datetime AT TIME ZONE 'Asia/Jerusalem','HH24:MI') AS time_str,
              ms.representative_name AS rep
       FROM bot_sessions bs
       JOIN meeting_slots ms ON ms.contact_phone = bs.phone AND ms.campaign_id = bs.zoho_campaign_id
       WHERE bs.zoho_campaign_id=$1 AND bs.state='confirmed'
       ORDER BY ms.slot_datetime`,
      [campaignId]
    );

    // 4. Slot utilization
    const slotsRes = await pool.query(
      `SELECT
         COUNT(*) AS total_slots,
         COUNT(CASE WHEN status='confirmed' THEN 1 END) AS confirmed,
         COUNT(CASE WHEN status='open' THEN 1 END) AS open,
         COUNT(CASE WHEN status='cancelled' THEN 1 END) AS cancelled
       FROM meeting_slots WHERE campaign_id=$1`,
      [campaignId]
    );

    // 5. Timeline - confirmations per day
    const timelineRes = await pool.query(
      `SELECT DATE(slot_datetime AT TIME ZONE 'Asia/Jerusalem') AS day,
              TO_CHAR(DATE(slot_datetime AT TIME ZONE 'Asia/Jerusalem'),'DD/MM') AS label,
              COUNT(CASE WHEN status='confirmed' THEN 1 END) AS confirmed
       FROM meeting_slots
       WHERE campaign_id=$1
       GROUP BY day, label
       ORDER BY day`,
      [campaignId]
    );

    // 6. Rep distribution
    const repsRes = await pool.query(
      `SELECT representative_name AS rep,
              COUNT(*) AS total,
              COUNT(CASE WHEN status='confirmed' THEN 1 END) AS confirmed
       FROM meeting_slots WHERE campaign_id=$1
       GROUP BY representative_name
       ORDER BY confirmed DESC`,
      [campaignId]
    );

    const sessions = sessionsRes.rows;
    const totalSent = sessions.reduce((a, b) => a + parseInt(b.total), 0);
    const totalAnswered = sessions.filter(s => s.state !== 'confirm_identity').reduce((a, b) => a + parseInt(b.total), 0);
    const totalConfirmed = sessions.find(s => s.state === 'confirmed')?.total || 0;
    const totalDeclined = sessions.find(s => s.state === 'closed' || s.state === 'ceremony_declined')?.total || 0;

    const slots = slotsRes.rows[0] || {};
    const slotUtil = slots.total_slots > 0 ? Math.round((slots.confirmed / slots.total_slots) * 100) : 0;
    const responseRate = totalSent > 0 ? Math.round((totalAnswered / totalSent) * 100) : 0;
    const conversionRate = totalAnswered > 0 ? Math.round((totalConfirmed / totalAnswered) * 100) : 0;

    const data = {
      campaignId,
      projectName: config.project_name || campaignId,
      meetingType: config.meeting_type || 'meeting',
      generatedAt: new Date().toISOString(),
      summary: {
        totalSent, totalAnswered, totalConfirmed: parseInt(totalConfirmed),
        totalDeclined: parseInt(totalDeclined),
        responseRate, conversionRate, slotUtil,
        totalSlots: parseInt(slots.total_slots || 0),
        openSlots: parseInt(slots.open || 0)
      },
      funnel: sessions,
      confirmedMeetings: confirmedRes.rows,
      timeline: timelineRes.rows,
      reps: repsRes.rows
    };

    if (format === 'json') return res.json(data);

    // ── HTML REPORT ───────────────────────────────────────────
    const confirmedRows = confirmedRes.rows.map(m =>
      `<tr><td>${m.name || m.phone}</td><td>${m.phone}</td><td>${m.date_str}</td><td>${m.time_str}</td><td>${m.rep || '-'}</td><td>${m.language === 'ru' ? '🇷🇺 רוסית' : '🇮🇱 עברית'}</td></tr>`
    ).join('');

    const timelineBars = timelineRes.rows.map(t => {
      const pct = Math.min(100, Math.round((t.confirmed / Math.max(1, totalConfirmed)) * 100));
      return `<div style="margin:4px 0;display:flex;align-items:center;gap:8px">
        <span style="width:40px;font-size:12px;color:#666">${t.label}</span>
        <div style="background:#d1fae5;width:${pct}%;max-width:200px;height:18px;border-radius:3px;display:flex;align-items:center;padding:0 6px;font-size:11px">${t.confirmed}</div>
      </div>`;
    }).join('');

    const repRows = repsRes.rows.map(r =>
      `<tr><td>${r.rep}</td><td>${r.total}</td><td>${r.confirmed}</td><td>${r.total > 0 ? Math.round(r.confirmed/r.total*100) : 0}%</td></tr>`
    ).join('');

    res.type('text/html').send(`<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>דוח קמפיין QUANTUM - ${data.projectName}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; background: #0a0a0f; color: #e2e8f0; direction: rtl; }
  .header { background: linear-gradient(135deg, #1e3a5f 0%, #0d1b2e 100%); padding: 32px 24px; border-bottom: 1px solid #1e40af44; }
  .logo { font-size: 13px; letter-spacing: 4px; color: #60a5fa; text-transform: uppercase; margin-bottom: 8px; }
  h1 { font-size: 22px; color: #f1f5f9; font-weight: 700; }
  .meta { font-size: 12px; color: #94a3b8; margin-top: 6px; }
  .container { max-width: 960px; margin: 0 auto; padding: 24px 16px; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin: 20px 0; }
  .kpi { background: #111827; border: 1px solid #1e293b; border-radius: 12px; padding: 16px; text-align: center; }
  .kpi-val { font-size: 28px; font-weight: 800; }
  .kpi-val.green { color: #34d399; }
  .kpi-val.blue { color: #60a5fa; }
  .kpi-val.yellow { color: #fbbf24; }
  .kpi-val.red { color: #f87171; }
  .kpi-label { font-size: 11px; color: #64748b; margin-top: 4px; }
  .section { background: #111827; border: 1px solid #1e293b; border-radius: 12px; padding: 20px; margin: 16px 0; }
  .section h2 { font-size: 14px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 16px; border-bottom: 1px solid #1e293b; padding-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: right; padding: 8px 10px; color: #64748b; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; background: #0f172a; }
  td { padding: 9px 10px; border-bottom: 1px solid #1e293b; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #1e293b44; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .badge-green { background: #064e3b; color: #34d399; }
  .badge-blue { background: #1e3a5f; color: #60a5fa; }
  .export-btn { float: left; background: #1e40af; color: white; border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 12px; text-decoration: none; }
  .export-btn:hover { background: #2563eb; }
</style>
</head>
<body>
<div class="header">
  <div class="logo">⚡ QUANTUM Intelligence</div>
  <h1>דוח קמפיין: ${data.projectName}</h1>
  <div class="meta">סוג פגישה: ${data.meetingType} &nbsp;|&nbsp; נוצר: ${new Date(data.generatedAt).toLocaleString('he-IL')} &nbsp;|&nbsp; <a href="?format=json" style="color:#60a5fa">JSON API</a></div>
</div>

<div class="container">

<!-- KPIs -->
<div class="kpis">
  <div class="kpi">
    <div class="kpi-val blue">${data.summary.totalSent}</div>
    <div class="kpi-label">נשלחו הודעות</div>
  </div>
  <div class="kpi">
    <div class="kpi-val yellow">${data.summary.totalAnswered}</div>
    <div class="kpi-label">ענו</div>
  </div>
  <div class="kpi">
    <div class="kpi-val green">${data.summary.totalConfirmed}</div>
    <div class="kpi-label">נקבעו פגישות</div>
  </div>
  <div class="kpi">
    <div class="kpi-val red">${data.summary.totalDeclined}</div>
    <div class="kpi-label">סירבו</div>
  </div>
  <div class="kpi">
    <div class="kpi-val ${data.summary.responseRate >= 60 ? 'green' : 'yellow'}">${data.summary.responseRate}%</div>
    <div class="kpi-label">שיעור מענה</div>
  </div>
  <div class="kpi">
    <div class="kpi-val ${data.summary.conversionRate >= 50 ? 'green' : 'yellow'}">${data.summary.conversionRate}%</div>
    <div class="kpi-label">המרה לפגישה</div>
  </div>
  <div class="kpi">
    <div class="kpi-val blue">${data.summary.openSlots}</div>
    <div class="kpi-label">חלונות פנויים</div>
  </div>
  <div class="kpi">
    <div class="kpi-val ${data.summary.slotUtil >= 70 ? 'green' : 'yellow'}">${data.summary.slotUtil}%</div>
    <div class="kpi-label">תפיסת סלוטים</div>
  </div>
</div>

<!-- Timeline -->
${timelineRes.rows.length ? `
<div class="section">
  <h2>📈 פגישות לפי יום</h2>
  ${timelineBars || '<div style="color:#64748b;font-size:13px">אין נתונים</div>'}
</div>` : ''}

<!-- Confirmed Meetings -->
<div class="section">
  <h2>✅ פגישות שנקבעו (${data.summary.totalConfirmed})</h2>
  ${confirmedRows ? `
  <table>
    <thead><tr><th>שם</th><th>טלפון</th><th>תאריך</th><th>שעה</th><th>נציג</th><th>שפה</th></tr></thead>
    <tbody>${confirmedRows}</tbody>
  </table>` : '<div style="color:#64748b;font-size:13px;padding:8px 0">אין פגישות מאושרות עדיין</div>'}
</div>

<!-- Reps -->
${repsRes.rows.length ? `
<div class="section">
  <h2>👤 עומס לפי נציג</h2>
  <table>
    <thead><tr><th>נציג</th><th>סה"כ חלונות</th><th>נקבעו</th><th>תפיסה</th></tr></thead>
    <tbody>${repRows}</tbody>
  </table>
</div>` : ''}

<!-- Funnel -->
<div class="section">
  <h2>🔄 משפך שיחות</h2>
  <table>
    <thead><tr><th>שלב</th><th>סה"כ</th><th>עברית</th><th>רוסית</th></tr></thead>
    <tbody>
      ${sessionsRes.rows.map(s => `<tr>
        <td><span class="badge ${s.state === 'confirmed' ? 'badge-green' : 'badge-blue'}">${s.state}</span></td>
        <td>${s.total}</td><td>${s.hebrew || 0}</td><td>${s.russian || 0}</td>
      </tr>`).join('')}
    </tbody>
  </table>
</div>

</div>
</body>
</html>`);
  } catch (err) {
    console.error('[Report] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
