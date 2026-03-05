/**
 * QUANTUM Scheduling Routes
 * POST /api/scheduling/webhook          - Inforu WA webhook
 * GET  /api/scheduling/campaign/:id     - Get campaign config
 * PUT  /api/scheduling/campaign/:id     - Save campaign config
 * POST /api/scheduling/broadcast        - Send initial WA to campaign contacts
 * POST /api/scheduling/ceremony         - Create ceremony
 * GET  /api/scheduling/ceremony/:id/slots - Get ceremony slot grid
 * POST /api/scheduling/slots/generate   - Auto-generate slots for ceremony/meeting
 * GET  /api/scheduling/campaign/:id/stats - Booking stats
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

    // Find campaign from phone - look up active session
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
    if (!result.rows.length) {
      return res.json({ config: null, message: 'No config found' });
    }
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
      project_id,
      meeting_type,
      available_windows,
      slot_duration_minutes,
      buffer_minutes,
      reminder_delay_hours,
      bot_followup_delay_hours,
      pre_meeting_reminder_hours,
      morning_reminder_hours,
      wa_initial_template,
      wa_language
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

// ── BROADCAST - send initial WA ────────────────────────────────
router.post('/broadcast', async (req, res) => {
  try {
    const { campaignId, contacts } = req.body;
    // contacts: [{ phone, name, contactId, language }]

    const config = await pool.query(
      `SELECT * FROM campaign_schedule_config WHERE zoho_campaign_id = $1`,
      [campaignId]
    );
    if (!config.rows.length) {
      return res.status(400).json({ error: 'Campaign config not found' });
    }
    const cfg = config.rows[0];

    let sent = 0;
    let failed = 0;

    for (const contact of contacts) {
      try {
        const lang = contact.language || cfg.wa_language || 'he';
        const message = buildInitialMessage(contact, cfg, lang);
        await inforuService.sendWhatsApp(contact.phone, message);

        // Schedule follow-up sequence
        await botEngine.scheduleFollowupSequence(
          contact.phone, campaignId, contact.contactId, cfg
        );

        sent++;
        await new Promise(r => setTimeout(r, 300)); // rate limit
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
    return template
      .replace('{name}', contact.name)
      .replace('{campaign}', cfg.zoho_campaign_id);
  }

  const types = {
    he: { consultation:'פגישת ייעוץ', appraiser:'ביקור שמאי', signing_ceremony:'כנס חתימות', physical:'פגישה פיזית', surveyor:'ביקור מודד' },
    ru: { consultation:'консультация', appraiser:'визит оценщика', signing_ceremony:'церемония подписания', physical:'встреча в офисе', surveyor:'визит геодезиста' }
  };

  const typeLabel = (types[lang] || types.he)[cfg.meeting_type] || cfg.meeting_type;

  if (lang === 'ru') {
    return `Здравствуйте, ${contact.name} 👋\n\nQUANTUM на связи.\n\nМы готовы назначить *${typeLabel}* для вашей квартиры.\n\nНажмите *1* и мы запишем вас прямо сейчас.`;
  }
  return `שלום ${contact.name} 👋\n\nQUANTUM כאן.\n\nאנחנו מוכנים לתאם *${typeLabel}* עבור דירתך.\n\nענה/י *1* ונתאם עכשיו.`;
}

// ── CEREMONY ──────────────────────────────────────────────────
router.post('/ceremony', async (req, res) => {
  try {
    const {
      project_id, zoho_campaign_id, name,
      ceremony_date, start_time, end_time,
      slot_duration_minutes, break_duration_minutes, location,
      buildings
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
        `INSERT INTO ceremony_buildings (ceremony_id, building_address, building_label)
         VALUES ($1,$2,$3) RETURNING id`,
        [ceremonyId, bld.address, bld.label || bld.address]
      );
      const buildingId = bldRes.rows[0].id;

      for (let i = 0; i < (bld.stations || []).length; i++) {
        const st = bld.stations[i];
        const stRes = await pool.query(
          `INSERT INTO ceremony_stations (building_id, station_number, representative_name, representative_role)
           VALUES ($1,$2,$3,$4) RETURNING id`,
          [buildingId, i + 1, st.repName, st.repRole || 'עורך דין']
        );
        await generateCeremonySlots(
          ceremonyId, stRes.rows[0].id,
          ceremony_date, start_time, end_time,
          slot_duration_minutes || 15, break_duration_minutes || 0
        );
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
      `INSERT INTO ceremony_slots (station_id, ceremony_id, slot_time, slot_date, duration_minutes)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [stationId, ceremonyId, `${hh}:${mm}`, date, slotMin]
    );
  }
}

// ── CEREMONY SLOT GRID ────────────────────────────────────────
router.get('/ceremony/:id/slots', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         cb.building_address, cb.building_label,
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

// ── STATS ─────────────────────────────────────────────────────
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

module.exports = router;
