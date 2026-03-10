/**
 * QUANTUM Professional Visits Routes v1.0
 *
 * POST /api/scheduling/pre-register
 *   Called by Zoho Workflow when WA is sent to a contact.
 *   Pre-populates bot_sessions with address + campaign info.
 *   No bot interaction needed at response time.
 *
 * POST /api/scheduling/visits
 *   Admin creates a professional visit (appraiser/surveyor).
 *   Auto-generates meeting_slots per professional.
 *
 * GET  /api/scheduling/visits?campaign_id=xxx
 *   List visits for a campaign.
 *
 * GET  /api/scheduling/visits/:id/report
 *   Export booked slots for a visit (for admin/field use).
 *
 * GET  /api/campaigns/:campaignId/buildings
 *   Returns buildings linked to a Zoho campaign (via relatedlist5).
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');
const axios = require('axios');

// ── Helpers ──────────────────────────────────────────────

/**
 * Parse property_addresses textarea into structured object.
 * Input:  "סמילצ'נסקי 3 דירה 9, ראשון לציון"
 * Output: { street: "סמילצ'נסקי", building: "3", apartment: "9",
 *            city: "ראשון לציון", normalized: "סמילצ'נסקי 3" }
 */
function parsePropertyAddress(raw) {
  if (!raw || !raw.trim()) return null;
  const line = raw.split('\n')[0].trim();

  // Extract apartment number: "דירה X" or "דירה X"
  const aptMatch = line.match(/דירה\s+(\d+)/i);
  const apartment = aptMatch ? aptMatch[1] : null;

  // Extract city after comma
  const commaIdx = line.indexOf(',');
  const city = commaIdx > -1 ? line.substring(commaIdx + 1).trim() : null;

  // Extract street + building from the start
  const beforeComma = commaIdx > -1 ? line.substring(0, commaIdx) : line;
  // Remove "דירה X" from the address part
  const stripped = beforeComma.replace(/דירה\s+\d+/i, '').trim();

  // Last token before cleanup is likely building number
  const tokens = stripped.split(/\s+/).filter(Boolean);
  let building = null;
  let streetTokens = tokens;
  if (tokens.length > 0 && /^\d+$/.test(tokens[tokens.length - 1])) {
    building = tokens[tokens.length - 1];
    streetTokens = tokens.slice(0, -1);
  }

  const street = streetTokens.join(' ');
  const normalized = building ? `${street} ${building}`.trim() : street;

  return { street, building, apartment, city, normalized };
}

/**
 * Normalize building address for matching:
 * removes extra spaces, lowercases for comparison.
 */
function normalizeBuildingForMatch(addr) {
  if (!addr) return '';
  return addr.trim().replace(/\s+/g, ' ');
}

// ── POST /pre-register ────────────────────────────────────

/**
 * Called by Zoho Workflow immediately when WA is dispatched.
 * Body:
 * {
 *   phone:             "0503016454",
 *   campaign_id:       "zoho_campaign_id",
 *   zoho_contact_id:   "zoho_id",
 *   contact_name:      "יצחק כגן",
 *   property_addresses:"סמילצ'נסקי 3 דירה 9, ראשון לציון",  // may be null
 *   campaign_buildings:["סמילצ'נסקי 3","סמילצ'נסקי 5"],     // all buildings in campaign
 *   campaign_end_date: "2026-06-30",                          // End_Date from Zoho
 *   campaign_status:   "Active",
 *   language:          "he"
 * }
 */
router.post('/pre-register', async (req, res) => {
  try {
    const {
      phone,
      campaign_id,
      zoho_contact_id,
      contact_name = '',
      property_addresses = null,
      campaign_buildings = [],
      campaign_end_date = null,
      campaign_status = 'Active',
      language = 'he'
    } = req.body;

    if (!phone || !campaign_id) {
      return res.status(400).json({ error: 'phone and campaign_id are required' });
    }

    // Parse address
    const parsed = parsePropertyAddress(property_addresses);
    const buildingAddress = parsed ? parsed.normalized : null;
    const apartmentNumber = parsed ? parsed.apartment : null;

    // Upsert bot_session — if already exists update, otherwise insert
    await pool.query(`
      INSERT INTO bot_sessions
        (phone, zoho_campaign_id, zoho_contact_id, language, state, context,
         building_address, apartment_number, campaign_buildings,
         campaign_end_date, campaign_status,
         contact_address, contact_street, contact_building_no)
      VALUES ($1,$2,$3,$4,'waiting',$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (phone, zoho_campaign_id)
      DO UPDATE SET
        zoho_contact_id   = EXCLUDED.zoho_contact_id,
        language          = EXCLUDED.language,
        building_address  = EXCLUDED.building_address,
        apartment_number  = EXCLUDED.apartment_number,
        campaign_buildings= EXCLUDED.campaign_buildings,
        campaign_end_date = EXCLUDED.campaign_end_date,
        campaign_status   = EXCLUDED.campaign_status,
        contact_address   = EXCLUDED.contact_address,
        contact_street    = EXCLUDED.contact_street,
        contact_building_no = EXCLUDED.contact_building_no,
        last_message_at   = NOW()
    `, [
      phone, campaign_id, zoho_contact_id, language,
      JSON.stringify({ contactName: contact_name }),
      buildingAddress, apartmentNumber,
      JSON.stringify(campaign_buildings),
      campaign_end_date, campaign_status,
      property_addresses,
      parsed?.street || null,
      parsed?.building || null
    ]);

    logger.info('[pre-register] session ready', {
      phone, campaign_id, buildingAddress, apartmentNumber,
      hasAddress: !!buildingAddress,
      buildingCount: campaign_buildings.length
    });

    res.json({
      success: true,
      building_address: buildingAddress,
      apartment_number: apartmentNumber,
      needs_building_selection: !buildingAddress && campaign_buildings.length > 0
    });

  } catch (err) {
    logger.error('[pre-register] error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /visits — Create professional visit ──────────────

/**
 * Body:
 * {
 *   campaign_id:           "zoho_campaign_id",
 *   project_id:            1,
 *   visit_type:            "appraiser",   // "appraiser" | "surveyor"
 *   building_address:      "סמילצ'נסקי 3",
 *   city:                  "ראשון לציון",
 *   visit_date:            "2026-04-01",
 *   start_time:            "09:00",
 *   end_time:              "17:00",
 *   slot_duration_minutes: 30,
 *   buffer_minutes:        5,
 *   professionals: [
 *     { name: "יוסי כהן", phone: "0501234567", zoho_calendar_id: null },
 *     { name: "דני לוי",  phone: "0507654321", zoho_calendar_id: null }
 *   ]
 * }
 */
router.post('/visits', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      campaign_id, project_id, visit_type,
      building_address, city,
      visit_date, start_time, end_time,
      slot_duration_minutes = 30,
      buffer_minutes = 5,
      professionals = []
    } = req.body;

    if (!campaign_id || !visit_type || !building_address || !visit_date || !start_time || !end_time) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!['appraiser', 'surveyor'].includes(visit_type)) {
      return res.status(400).json({ error: 'visit_type must be appraiser or surveyor' });
    }
    if (professionals.length === 0 || professionals.length > 3) {
      return res.status(400).json({ error: '1 to 3 professionals required' });
    }

    await client.query('BEGIN');

    // 1. Create visit record
    const visitRes = await client.query(`
      INSERT INTO professional_visits
        (campaign_id, project_id, visit_type, building_address, city,
         visit_date, start_time, end_time, slot_duration_minutes, buffer_minutes, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active')
      RETURNING id
    `, [campaign_id, project_id || null, visit_type, building_address, city,
        visit_date, start_time, end_time, slot_duration_minutes, buffer_minutes]);

    const visitId = visitRes.rows[0].id;

    // 2. Create professionals + generate slots per professional
    const stepMinutes = slot_duration_minutes + buffer_minutes;
    const slotsSummary = [];

    for (let i = 0; i < professionals.length; i++) {
      const prof = professionals[i];

      const profRes = await client.query(`
        INSERT INTO visit_professionals
          (visit_id, professional_name, professional_phone, zoho_calendar_id, display_order)
        VALUES ($1,$2,$3,$4,$5)
        RETURNING id
      `, [visitId, prof.name, prof.phone || null, prof.zoho_calendar_id || null, i]);

      const profId = profRes.rows[0].id;

      // Generate time slots for this professional
      const slots = generateTimeSlots(visit_date, start_time, end_time, stepMinutes, slot_duration_minutes);

      for (const slot of slots) {
        await client.query(`
          INSERT INTO meeting_slots
            (campaign_id, project_id, meeting_type, slot_datetime, duration_minutes,
             representative_name, status, visit_professional_id)
          VALUES ($1,$2,$3,$4,$5,$6,'open',$7)
        `, [campaign_id, project_id || null, visit_type,
            slot.datetime, slot_duration_minutes,
            prof.name, profId]);
      }

      slotsSummary.push({
        professional: prof.name,
        slots_created: slots.length,
        first_slot: slots[0]?.time,
        last_slot: slots[slots.length - 1]?.time
      });
    }

    await client.query('COMMIT');

    const totalSlots = slotsSummary.reduce((sum, p) => sum + p.slots_created, 0);

    logger.info('[visits] visit created', {
      visitId, campaign_id, building_address, visit_date,
      professionals: professionals.length, totalSlots
    });

    res.json({
      success: true,
      visit_id: visitId,
      building_address,
      visit_date,
      professionals: slotsSummary,
      total_slots: totalSlots
    });

  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('[visits] create error', { error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── GET /visits ───────────────────────────────────────────

router.get('/visits', async (req, res) => {
  try {
    const { campaign_id, project_id } = req.query;
    const conditions = [];
    const params = [];

    if (campaign_id) { conditions.push(`v.campaign_id = $${params.length + 1}`); params.push(campaign_id); }
    if (project_id)  { conditions.push(`v.project_id = $${params.length + 1}`); params.push(project_id); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const visits = await pool.query(`
      SELECT v.*,
        json_agg(json_build_object(
          'id', vp.id,
          'name', vp.professional_name,
          'phone', vp.professional_phone,
          'slots_open', (
            SELECT COUNT(*) FROM meeting_slots ms
            WHERE ms.visit_professional_id = vp.id AND ms.status = 'open'
          ),
          'slots_booked', (
            SELECT COUNT(*) FROM meeting_slots ms
            WHERE ms.visit_professional_id = vp.id AND ms.status = 'confirmed'
          )
        ) ORDER BY vp.display_order) AS professionals
      FROM professional_visits v
      LEFT JOIN visit_professionals vp ON vp.visit_id = v.id
      ${where}
      GROUP BY v.id
      ORDER BY v.visit_date DESC, v.created_at DESC
    `, params);

    res.json({ visits: visits.rows });
  } catch (err) {
    logger.error('[visits] list error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /visits/:id/report ────────────────────────────────

router.get('/visits/:id/report', async (req, res) => {
  try {
    const { id } = req.params;

    const visit = await pool.query(
      `SELECT * FROM professional_visits WHERE id = $1`, [id]
    );
    if (!visit.rows.length) return res.status(404).json({ error: 'Visit not found' });

    const slots = await pool.query(`
      SELECT
        ms.slot_datetime,
        TO_CHAR(ms.slot_datetime, 'HH24:MI') AS time_str,
        ms.status,
        ms.contact_name,
        ms.contact_phone,
        ms.apartment_number,
        ms.contact_address,
        vp.professional_name,
        ms.zoho_contact_id
      FROM meeting_slots ms
      JOIN visit_professionals vp ON ms.visit_professional_id = vp.id
      WHERE vp.visit_id = $1
      ORDER BY vp.display_order, ms.slot_datetime
    `, [id]);

    // Group by professional
    const grouped = {};
    for (const s of slots.rows) {
      const key = s.professional_name;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(s);
    }

    res.json({
      visit: visit.rows[0],
      report: grouped,
      summary: {
        total: slots.rows.length,
        booked: slots.rows.filter(s => s.status === 'confirmed').length,
        open: slots.rows.filter(s => s.status === 'open').length
      }
    });
  } catch (err) {
    logger.error('[visits] report error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /campaigns/:campaignId/buildings ─────────────────

/**
 * Fetches buildings linked to a Zoho campaign via relatedlist5.
 * Uses Zoho API with existing OAuth token from env.
 */
router.get('/campaigns/:campaignId/buildings', async (req, res) => {
  try {
    const { campaignId } = req.params;

    const zohoToken = await getZohoAccessToken();
    const response = await axios.get(
      `https://www.zohoapis.com/crm/v7/Campaigns/${campaignId}/relatedlist5`,
      {
        headers: { Authorization: `Zoho-oauthtoken ${zohoToken}` },
        timeout: 10000
      }
    );

    const buildings = (response.data?.data || []).map(b => ({
      id: b.id,
      name: b.Name || b.name || b.Building_Name || '',
      address: b.Building_Address || b.address || b.Name || ''
    }));

    res.json({ buildings });
  } catch (err) {
    logger.error('[campaigns/buildings] error', { error: err.message });
    res.status(500).json({ error: err.message, buildings: [] });
  }
});

// ── Helpers ───────────────────────────────────────────────

function generateTimeSlots(visitDate, startTime, endTime, stepMinutes, durationMinutes) {
  const slots = [];
  const [startH, startM] = startTime.split(':').map(Number);
  const [endH, endM] = endTime.split(':').map(Number);

  let current = startH * 60 + startM;
  const endTotal = endH * 60 + endM;

  while (current + durationMinutes <= endTotal) {
    const h = String(Math.floor(current / 60)).padStart(2, '0');
    const m = String(current % 60).padStart(2, '0');
    slots.push({
      time: `${h}:${m}`,
      datetime: `${visitDate}T${h}:${m}:00`
    });
    current += stepMinutes;
  }

  return slots;
}

async function getZohoAccessToken() {
  const response = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, {
    params: {
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id:     process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type:    'refresh_token'
    },
    timeout: 10000
  });
  if (!response.data?.access_token) throw new Error('Failed to get Zoho access token');
  return response.data.access_token;
}

module.exports = router;
