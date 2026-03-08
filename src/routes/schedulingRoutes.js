/**
 * QUANTUM Scheduling Routes v3
 *
 * POST /api/scheduling/webhook                        - Inforu WA webhook
 * GET  /api/scheduling/campaign/:id                  - Get campaign config
 * PUT  /api/scheduling/campaign/:id                  - Save campaign config
 * POST /api/scheduling/broadcast                     - Send initial WA to campaign contacts
 * POST /api/scheduling/ceremony                      - Create ceremony (buildings with station_count)
 * POST /api/scheduling/ceremony/:id/assign           - Assign contacts to buildings
 * GET  /api/scheduling/ceremony/:id/buildings        - List buildings + station counts
 * GET  /api/scheduling/ceremony/:id/slots            - Get ceremony slot grid (admin view)
 * GET  /api/scheduling/campaign/:id/stats            - Basic booking stats
 * GET  /api/scheduling/campaign/:id/report           - Full campaign report (HTML+JSON)
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const pool = require('../db/pool');
const botEngine = require('../services/botEngine');
const inforuService = require('../services/inforuService');
let zohoSchedulingService;
try { zohoSchedulingService = require('../services/zohoSchedulingService'); } catch (e) { /* optional */ }

// ── ZOHO CRM WIDGET ────────────────────────────────────────────
router.get('/widget', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/zoho-scheduling-widget.html'));
});

// ── CAMPAIGN CONTACTS (from Zoho CRM) ──────────────────────────
/**
 * GET /api/scheduling/campaign/:id/contacts
 * Fetch all contacts for a Zoho Campaign.
 * Falls back to bot_sessions in DB if Zoho CRM is not configured.
 */
router.get('/campaign/:id/contacts', async (req, res) => {
  const campaignId = req.params.id;
  try {
    // Try Zoho CRM first
    if (zohoSchedulingService?.getCampaignContacts) {
      try {
        const contacts = await zohoSchedulingService.getCampaignContacts(campaignId);
        if (contacts.length > 0) {
          return res.json({ success: true, source: 'zoho', contacts });
        }
      } catch (zohoErr) {
        // Fall through to DB fallback
      }
    }
    // DB fallback: return bot_sessions for this campaign
    const { rows } = await pool.query(
      `SELECT
         bs.phone,
         bs.context->>'contactName' AS name,
         bs.context->>'contactId' AS id,
         bs.language,
         bs.state AS status,
         bs.last_message_at
       FROM bot_sessions bs
       WHERE bs.zoho_campaign_id = $1
       ORDER BY bs.last_message_at DESC`,
      [campaignId]
    );
    res.json({ success: true, source: 'db', contacts: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── WEBHOOK ────────────────────────────────────────────
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
    if (reply) await inforuService.sendWhatsApp(From, reply);
    res.sendStatus(200);
  } catch (err) {
    console.error('[Webhook] Error:', err);
    res.sendStatus(500);
  }
});

// ── CAMPAIGN CONFIG ────────────────────────────────────────────
router.get('/campaign/:campaignId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT csc.*, p.name AS project_name, p.google_calendar_id, p.zoho_calendar_id
       FROM campaign_schedule_config csc
       LEFT JOIN projects p ON csc.project_id = p.id
       WHERE csc.zoho_campaign_id = $1`,
      [req.params.campaignId]
    );
    if (!result.rows.length) return res.json({ config: null, message: 'No config found' });
    res.json({ config: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/campaign/:campaignId', async (req, res) => {
  try {
    const { campaignId } = req.params;
    const {
      project_id, meeting_type, available_windows, slot_duration_minutes,
      buffer_minutes, reminder_delay_hours, bot_followup_delay_hours,
      pre_meeting_reminder_hours, morning_reminder_hours, wa_initial_template, wa_language,
      show_rep_name, booking_link_expires_hours
    } = req.body;

    await pool.query(
      `INSERT INTO campaign_schedule_config
         (zoho_campaign_id, project_id, meeting_type, available_windows,
          slot_duration_minutes, buffer_minutes,
          reminder_delay_hours, bot_followup_delay_hours,
          pre_meeting_reminder_hours, morning_reminder_hours,
          wa_initial_template, wa_language,
          show_rep_name, booking_link_expires_hours, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
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
         show_rep_name = EXCLUDED.show_rep_name,
         booking_link_expires_hours = EXCLUDED.booking_link_expires_hours,
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
        wa_language || 'he',
        show_rep_name !== false,
        booking_link_expires_hours || 48
      ]
    );
    res.json({ success: true });
  } catch (err) {
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
        sent++;
        await new Promise(r => setTimeout(r, 300));
      } catch (e) {
        console.error(`[Broadcast] Failed for ${contact.phone}:`, e.message);
        failed++;
      }
    }
    res.json({ sent, failed, total: contacts.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function buildInitialMessage(contact, cfg, lang) {
  const template = cfg.wa_initial_template;
  if (template) return template.replace('{name}', contact.name).replace('{campaign}', cfg.zoho_campaign_id);
  const types = {
    he: { consultation:'פגישת ייעוץ', appraiser:'ביקור שמאי', signing_ceremony:'כנס חתימות', physical:'פגישה פיזית', surveyor:'ביקור מודד' },
    ru: { consultation:'консультация', appraiser:'визит оценщика', signing_ceremony:'церемония подписания', physical:'встреча в офисе', surveyor:'визит геодезиста' }
  };
  const typeLabel = (types[lang] || types.he)[cfg.meeting_type] || cfg.meeting_type;
  if (lang === 'ru') return `Здравствуйте, ${contact.name} 👋\n\nQUANTUM на связи.\n\nГотовы назначить *${typeLabel}* для вашей квартиры.\n\nНажмите *1* и мы запишем вас прямо сейчас.`;
  return `שלום ${contact.name} 👋\n\nQUANTUM כאן.\n\nאנחנו מוכנים לתאם *${typeLabel}* עבור דירתך.\n\nענה/י *1* ונתאם עכשיו.`;
}

// ══════════════════════════════════════════════════════════════
// CEREMONY MANAGEMENT
// ══════════════════════════════════════════════════════════════

/**
 * POST /api/scheduling/ceremony
 *
 * Create a ceremony with buildings and stations.
 * Each building specifies station_count (integer) instead of individual station objects.
 * Slots are auto-generated for all stations.
 *
 * Body:
 * {
 *   project_id, zoho_campaign_id, name,
 *   ceremony_date,          // "YYYY-MM-DD"
 *   start_time,             // "09:00"
 *   end_time,               // "17:00"
 *   slot_duration_minutes,  // 15
 *   break_duration_minutes, // 0
 *   location,
 *   buildings: [
 *     {
 *       address: "רחוב הרצל 1",
 *       label: "בניין א",     // optional
 *       station_count: 3,     // NUMBER OF PARALLEL STATIONS (e.g. 3 lawyers)
 *       display_order: 0      // optional
 *     }
 *   ]
 * }
 */
router.post('/ceremony', async (req, res) => {
  try {
    const {
      project_id, zoho_campaign_id, name,
      ceremony_date, start_time, end_time,
      slot_duration_minutes, break_duration_minutes,
      location, buildings
    } = req.body;

    // Create ceremony
    const cermRes = await pool.query(
      `INSERT INTO signing_ceremonies
         (project_id, zoho_campaign_id, name, ceremony_date, start_time, end_time,
          slot_duration_minutes, break_duration_minutes, location)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [project_id, zoho_campaign_id, name, ceremony_date, start_time, end_time,
       slot_duration_minutes || 15, break_duration_minutes || 0, location]
    );
    const ceremonyId = cermRes.rows[0].id;

    const buildingResults = [];
    for (const [idx, bld] of (buildings || []).entries()) {
      // Each building gets N stations where N = station_count
      const stationCount = parseInt(bld.station_count) || 1;

      const bldRes = await pool.query(
        `INSERT INTO ceremony_buildings
           (ceremony_id, building_address, building_label, display_order)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [ceremonyId, bld.address, bld.label || bld.address, bld.display_order ?? idx]
      );
      const buildingId = bldRes.rows[0].id;

      // Create N stations (auto-numbered 1..N, no rep name required)
      let slotsCreated = 0;
      for (let n = 1; n <= stationCount; n++) {
        const stRes = await pool.query(
          `INSERT INTO ceremony_stations
             (building_id, station_number, representative_name, representative_role, is_active)
           VALUES ($1,$2,$3,'עורך דין',true) RETURNING id`,
          [buildingId, n, `עמדה ${n}`]
        );
        const stationSlots = await generateCeremonySlots(
          ceremonyId, stRes.rows[0].id,
          ceremony_date, start_time, end_time,
          slot_duration_minutes || 15,
          break_duration_minutes || 0
        );
        slotsCreated += stationSlots;
      }

      buildingResults.push({
        buildingId,
        address: bld.address,
        label: bld.label || bld.address,
        station_count: stationCount,
        slots_created: slotsCreated
      });
    }

    res.json({ success: true, ceremonyId, buildings: buildingResults });
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
  let count = 0;
  for (let m = startMins; m + slotMin <= endMins; m += step) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    await pool.query(
      `INSERT INTO ceremony_slots (station_id, ceremony_id, slot_time, slot_date, duration_minutes)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [stationId, ceremonyId, `${hh}:${mm}`, date, slotMin]
    );
    count++;
  }
  return count;
}

/**
 * POST /api/scheduling/ceremony/:id/assign
 *
 * Assign contacts to buildings for this ceremony.
 * Must be done BEFORE broadcasting so the bot knows which building's slots to show.
 *
 * Body:
 * {
 *   assignments: [
 *     { phone: "972501234567", building_id: 12 },
 *     { phone: "972509876543", building_id: 13 },
 *     ...
 *   ]
 * }
 *
 * Or by building address:
 * {
 *   zoho_campaign_id: "...",
 *   assignments: [
 *     { phone: "972501234567", building_address: "רחוב הרצל 1" },
 *   ]
 * }
 */
router.post('/ceremony/:id/assign', async (req, res) => {
  try {
    const ceremonyId = parseInt(req.params.id);
    const { assignments, zoho_campaign_id } = req.body;

    if (!assignments?.length) return res.status(400).json({ error: 'assignments[] required' });

    // Build address→id map if needed
    let addressToId = {};
    const needsLookup = assignments.some(a => !a.building_id && a.building_address);
    if (needsLookup) {
      const bldRes = await pool.query(
        `SELECT id, building_address FROM ceremony_buildings WHERE ceremony_id=$1`,
        [ceremonyId]
      );
      for (const row of bldRes.rows) addressToId[row.building_address] = row.id;
    }

    let assigned = 0, skipped = 0;
    for (const a of assignments) {
      const buildingId = a.building_id || addressToId[a.building_address];
      if (!buildingId) { skipped++; continue; }

      // Update existing session OR create/mark the assignment in the DB
      // The session will be created by the bot when the contact first replies.
      // We store the building assignment in bot_sessions (upsert on phone+campaign).
      const campaignId = zoho_campaign_id || a.zoho_campaign_id;
      if (!campaignId) { skipped++; continue; }

      await pool.query(
        `INSERT INTO bot_sessions (phone, zoho_campaign_id, ceremony_building_id, state, context)
         VALUES ($1, $2, $3, 'confirm_identity', '{}')
         ON CONFLICT (phone, zoho_campaign_id) DO UPDATE
         SET ceremony_building_id = EXCLUDED.ceremony_building_id`,
        [a.phone, campaignId, buildingId]
      );
      assigned++;
    }

    res.json({ success: true, assigned, skipped, total: assignments.length });
  } catch (err) {
    console.error('[Assign] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/scheduling/ceremony/:id/buildings
 * Returns buildings with their station count and slot stats.
 */
router.get('/ceremony/:id/buildings', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         cb.id, cb.building_address, cb.building_label, cb.display_order,
         COUNT(DISTINCT cst.id) AS station_count,
         COUNT(cs.id) AS total_slots,
         COUNT(cs.id) FILTER (WHERE cs.status='open') AS open_slots,
         COUNT(cs.id) FILTER (WHERE cs.status='confirmed') AS confirmed_slots
       FROM ceremony_buildings cb
       LEFT JOIN ceremony_stations cst ON cst.building_id = cb.id AND cst.is_active=true
       LEFT JOIN ceremony_slots cs ON cs.station_id = cst.id
       WHERE cb.ceremony_id = $1
       GROUP BY cb.id, cb.building_address, cb.building_label, cb.display_order
       ORDER BY cb.display_order, cb.id`,
      [req.params.id]
    );
    res.json({ buildings: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/scheduling/ceremony/:id/buildings/:buildingId
 * Update station_count for a building (adds or removes stations + slots).
 */
router.patch('/ceremony/:id/buildings/:buildingId', async (req, res) => {
  try {
    const ceremonyId = parseInt(req.params.id);
    const buildingId = parseInt(req.params.buildingId);
    const { station_count } = req.body;

    if (!station_count || station_count < 1) return res.status(400).json({ error: 'station_count must be >= 1' });

    // Get ceremony time config
    const cermRes = await pool.query(
      `SELECT ceremony_date, start_time, end_time, slot_duration_minutes, break_duration_minutes
       FROM signing_ceremonies WHERE id=$1`,
      [ceremonyId]
    );
    if (!cermRes.rows.length) return res.status(404).json({ error: 'Ceremony not found' });
    const { ceremony_date, start_time, end_time, slot_duration_minutes, break_duration_minutes } = cermRes.rows[0];

    // Current stations
    const currentRes = await pool.query(
      `SELECT id, station_number FROM ceremony_stations WHERE building_id=$1 AND is_active=true ORDER BY station_number`,
      [buildingId]
    );
    const currentCount = currentRes.rows.length;

    if (station_count > currentCount) {
      // Add stations
      for (let n = currentCount + 1; n <= station_count; n++) {
        const stRes = await pool.query(
          `INSERT INTO ceremony_stations (building_id, station_number, representative_name, representative_role, is_active)
           VALUES ($1,$2,$3,'עורך דין',true) RETURNING id`,
          [buildingId, n, `עמדה ${n}`]
        );
        await generateCeremonySlots(
          ceremonyId, stRes.rows[0].id,
          ceremony_date, start_time.substring(0,5), end_time.substring(0,5),
          slot_duration_minutes, break_duration_minutes
        );
      }
    } else if (station_count < currentCount) {
      // Deactivate excess stations (only if no confirmed slots)
      const toDeactivate = currentRes.rows.slice(station_count);
      for (const st of toDeactivate) {
        const hasConfirmed = await pool.query(
          `SELECT 1 FROM ceremony_slots WHERE station_id=$1 AND status='confirmed' LIMIT 1`,
          [st.id]
        );
        if (!hasConfirmed.rows.length) {
          await pool.query(`UPDATE ceremony_stations SET is_active=false WHERE id=$1`, [st.id]);
        }
      }
    }

    res.json({ success: true, station_count, previous: currentCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CEREMONY SLOT GRID (admin) ────────────────────────────────
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

// ── STATS ──────────────────────────────────────────────────────
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
router.get('/campaign/:campaignId/report', async (req, res) => {
  try {
    const { campaignId } = req.params;
    const format = req.query.format || 'html';

    const configRes = await pool.query(
      `SELECT csc.*, p.name AS project_name FROM campaign_schedule_config csc
       LEFT JOIN projects p ON csc.project_id = p.id WHERE csc.zoho_campaign_id = $1`,
      [campaignId]
    );
    const config = configRes.rows[0] || {};

    const sessionsRes = await pool.query(
      `SELECT state, COUNT(*) AS total,
              COUNT(CASE WHEN language='ru' THEN 1 END) AS russian,
              COUNT(CASE WHEN language='he' THEN 1 END) AS hebrew
       FROM bot_sessions WHERE zoho_campaign_id=$1
       GROUP BY state ORDER BY total DESC`,
      [campaignId]
    );

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

    const slotsRes = await pool.query(
      `SELECT COUNT(*) AS total_slots,
              COUNT(CASE WHEN status='confirmed' THEN 1 END) AS confirmed,
              COUNT(CASE WHEN status='open' THEN 1 END) AS open,
              COUNT(CASE WHEN status='cancelled' THEN 1 END) AS cancelled
       FROM meeting_slots WHERE campaign_id=$1`,
      [campaignId]
    );

    const timelineRes = await pool.query(
      `SELECT DATE(slot_datetime AT TIME ZONE 'Asia/Jerusalem') AS day,
              TO_CHAR(DATE(slot_datetime AT TIME ZONE 'Asia/Jerusalem'),'DD/MM') AS label,
              COUNT(CASE WHEN status='confirmed' THEN 1 END) AS confirmed
       FROM meeting_slots WHERE campaign_id=$1
       GROUP BY day, label ORDER BY day`,
      [campaignId]
    );

    const repsRes = await pool.query(
      `SELECT representative_name AS rep, COUNT(*) AS total,
              COUNT(CASE WHEN status='confirmed' THEN 1 END) AS confirmed
       FROM meeting_slots WHERE campaign_id=$1
       GROUP BY representative_name ORDER BY confirmed DESC`,
      [campaignId]
    );

    const sessions = sessionsRes.rows;
    const totalSent = sessions.reduce((a, b) => a + parseInt(b.total), 0);
    const totalAnswered = sessions.filter(s => s.state !== 'confirm_identity').reduce((a, b) => a + parseInt(b.total), 0);
    const totalConfirmed = parseInt(sessions.find(s => s.state === 'confirmed')?.total || 0);
    const totalDeclined = parseInt(sessions.find(s => s.state === 'closed' || s.state === 'ceremony_declined')?.total || 0);
    const slots = slotsRes.rows[0] || {};
    const slotUtil = slots.total_slots > 0 ? Math.round((slots.confirmed / slots.total_slots) * 100) : 0;
    const responseRate = totalSent > 0 ? Math.round((totalAnswered / totalSent) * 100) : 0;
    const conversionRate = totalAnswered > 0 ? Math.round((totalConfirmed / totalAnswered) * 100) : 0;

    const data = {
      campaignId, projectName: config.project_name || campaignId,
      meetingType: config.meeting_type || 'meeting',
      generatedAt: new Date().toISOString(),
      summary: {
        totalSent, totalAnswered, totalConfirmed, totalDeclined,
        responseRate, conversionRate, slotUtil,
        totalSlots: parseInt(slots.total_slots || 0),
        openSlots: parseInt(slots.open || 0)
      },
      funnel: sessions, confirmedMeetings: confirmedRes.rows,
      timeline: timelineRes.rows, reps: repsRes.rows
    };

    if (format === 'json') return res.json(data);

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
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>דוח קמפיין QUANTUM - ${data.projectName}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',Arial,sans-serif;background:#0a0a0f;color:#e2e8f0;direction:rtl}
.header{background:linear-gradient(135deg,#1e3a5f,#0d1b2e);padding:32px 24px;border-bottom:1px solid #1e40af44}
.logo{font-size:13px;letter-spacing:4px;color:#60a5fa;text-transform:uppercase;margin-bottom:8px}
h1{font-size:22px;color:#f1f5f9;font-weight:700}
.meta{font-size:12px;color:#94a3b8;margin-top:6px}
.container{max-width:960px;margin:0 auto;padding:24px 16px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:20px 0}
.kpi{background:#111827;border:1px solid #1e293b;border-radius:12px;padding:16px;text-align:center}
.kpi-val{font-size:28px;font-weight:800}
.kpi-val.green{color:#34d399}.kpi-val.blue{color:#60a5fa}.kpi-val.yellow{color:#fbbf24}.kpi-val.red{color:#f87171}
.kpi-label{font-size:11px;color:#64748b;margin-top:4px}
.section{background:#111827;border:1px solid #1e293b;border-radius:12px;padding:20px;margin:16px 0}
.section h2{font-size:14px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:2px;margin-bottom:16px;border-bottom:1px solid #1e293b;padding-bottom:10px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:right;padding:8px 10px;color:#64748b;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:1px;background:#0f172a}
td{padding:9px 10px;border-bottom:1px solid #1e293b}
tr:last-child td{border-bottom:none}
tr:hover td{background:#1e293b44}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}
.badge-green{background:#064e3b;color:#34d399}.badge-blue{background:#1e3a5f;color:#60a5fa}
</style>
</head>
<body>
<div class="header">
  <div class="logo">⚡ QUANTUM Intelligence</div>
  <h1>דוח קמפיין: ${data.projectName}</h1>
  <div class="meta">סוג: ${data.meetingType} | נוצר: ${new Date(data.generatedAt).toLocaleString('he-IL')} | <a href="?format=json" style="color:#60a5fa">JSON</a></div>
</div>
<div class="container">
<div class="kpis">
  <div class="kpi"><div class="kpi-val blue">${data.summary.totalSent}</div><div class="kpi-label">נשלחו</div></div>
  <div class="kpi"><div class="kpi-val yellow">${data.summary.totalAnswered}</div><div class="kpi-label">ענו</div></div>
  <div class="kpi"><div class="kpi-val green">${data.summary.totalConfirmed}</div><div class="kpi-label">נקבעו</div></div>
  <div class="kpi"><div class="kpi-val red">${data.summary.totalDeclined}</div><div class="kpi-label">סירבו</div></div>
  <div class="kpi"><div class="kpi-val ${data.summary.responseRate >= 60 ? 'green' : 'yellow'}">${data.summary.responseRate}%</div><div class="kpi-label">מענה</div></div>
  <div class="kpi"><div class="kpi-val ${data.summary.conversionRate >= 50 ? 'green' : 'yellow'}">${data.summary.conversionRate}%</div><div class="kpi-label">המרה</div></div>
  <div class="kpi"><div class="kpi-val blue">${data.summary.openSlots}</div><div class="kpi-label">פנויים</div></div>
  <div class="kpi"><div class="kpi-val ${data.summary.slotUtil >= 70 ? 'green' : 'yellow'}">${data.summary.slotUtil}%</div><div class="kpi-label">תפיסה</div></div>
</div>
${timelineRes.rows.length ? `<div class="section"><h2>📈 פגישות לפי יום</h2>${timelineBars}</div>` : ''}
<div class="section">
  <h2>✅ פגישות שנקבעו (${data.summary.totalConfirmed})</h2>
  ${confirmedRows ? `<table><thead><tr><th>שם</th><th>טלפון</th><th>תאריך</th><th>שעה</th><th>נציג</th><th>שפה</th></tr></thead><tbody>${confirmedRows}</tbody></table>` : '<div style="color:#64748b;font-size:13px;padding:8px 0">אין פגישות</div>'}
</div>
${repsRes.rows.length ? `<div class="section"><h2>👤 עומס לפי נציג</h2><table><thead><tr><th>נציג</th><th>סה"כ</th><th>נקבעו</th><th>תפיסה</th></tr></thead><tbody>${repRows}</tbody></table></div>` : ''}
<div class="section">
  <h2>🔄 משפך</h2>
  <table><thead><tr><th>שלב</th><th>סה"כ</th><th>עברית</th><th>רוסית</th></tr></thead>
  <tbody>${sessionsRes.rows.map(s => `<tr><td><span class="badge ${s.state === 'confirmed' ? 'badge-green' : 'badge-blue'}">${s.state}</span></td><td>${s.total}</td><td>${s.hebrew||0}</td><td>${s.russian||0}</td></tr>`).join('')}</tbody></table>
</div>
</div></body></html>`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
