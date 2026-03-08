/**
 * QUANTUM Optimization Test Route
 * POST /api/test/optimization/setup   - seed test data (Zoho + DB)
 * POST /api/test/optimization/reset   - clean up test data
 * GET  /api/test/optimization/state   - show current test state
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const axios = require('axios');
const { logger } = require('../services/logger');

const CAMPAIGN_ID = 'HEMI-TEST-001';
const TEST_PHONE  = '972525959103'; // Hemi's number - update if different

// ── Zoho OAuth helper ──────────────────────────────────────────
async function getZohoToken() {
  const res = await axios.post('https://accounts.zoho.com/oauth/v2/token', null, {
    params: {
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id:     process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type:    'refresh_token'
    }
  });
  return res.data.access_token;
}

// ── Search Zoho Contacts for "חמי מיכאלי" ─────────────────────
async function findHemiInZoho(token) {
  const res = await axios.get('https://www.zohoapis.com/crm/v3/Contacts/search', {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params: { criteria: '(Last_Name:equals:מיכאלי)', fields: 'id,First_Name,Last_Name,Phone,Mobile,Mailing_Street,Mailing_City' }
  });
  return res.data?.data?.[0] || null;
}

// ── Update Zoho Contact address if missing ────────────────────
async function ensureZohoAddress(token, contactId, currentStreet) {
  if (currentStreet) return { updated: false, street: currentStreet };
  await axios.put(`https://www.zohoapis.com/crm/v3/Contacts/${contactId}`, {
    data: [{ Mailing_Street: 'הרצל 20', Mailing_City: 'תל אביב' }]
  }, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  return { updated: true, street: 'הרצל 20' };
}

// ── Create Zoho Campaign with Hemi only ───────────────────────
async function ensureZohoCampaign(token, contactId) {
  // Search existing
  const search = await axios.get('https://www.zohoapis.com/crm/v3/Campaigns/search', {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params: { criteria: `(Campaign_Name:equals:${CAMPAIGN_ID})`, fields: 'id,Campaign_Name' }
  }).catch(() => ({ data: {} }));

  let campaignZohoId = search.data?.data?.[0]?.id;

  if (!campaignZohoId) {
    const create = await axios.post('https://www.zohoapis.com/crm/v3/Campaigns', {
      data: [{
        Campaign_Name: CAMPAIGN_ID,
        Status: 'Active',
        Start_Date: new Date().toISOString().split('T')[0],
        Type: 'Email'
      }]
    }, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    campaignZohoId = create.data?.data?.[0]?.details?.id;
  }

  // Add contact to campaign
  if (campaignZohoId && contactId) {
    await axios.post(`https://www.zohoapis.com/crm/v3/Campaigns/${campaignZohoId}/Contacts`, {
      data: [{ id: contactId }]
    }, { headers: { Authorization: `Zoho-oauthtoken ${token}` } }).catch(() => {});
  }

  return campaignZohoId;
}

// ── Seed meeting_slots for tomorrow ───────────────────────────
// Creates an ISOLATED slot for Hemi + two clustered slots for "others"
// So the optimization engine has a real candidate to work with
async function seedTestSlots(phone, street) {
  // Campaign config
  await pool.query(
    `INSERT INTO campaign_schedule_config
       (zoho_campaign_id, project_id, meeting_type, slot_duration_minutes, buffer_minutes, wa_language, updated_at)
     VALUES ($1, 1, 'appraiser', 45, 15, 'he', NOW())
     ON CONFLICT (zoho_campaign_id) DO UPDATE
     SET meeting_type='appraiser', updated_at=NOW()`,
    [CAMPAIGN_ID]
  );

  // Tomorrow date
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tDate = tomorrow.toISOString().split('T')[0];

  // Helper to build ISO datetime for a time on tomorrow (Israel time = UTC+2/3)
  const dt = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    const d = new Date(tDate);
    d.setUTCHours(h - 2, m, 0, 0); // convert Israel time to UTC
    return d.toISOString();
  };

  // Clean previous test slots
  await pool.query(`DELETE FROM meeting_slots WHERE campaign_id=$1`, [CAMPAIGN_ID]);

  // ── Slot 1: 09:00 — "אחר 1" (clustered together at morning)
  await pool.query(
    `INSERT INTO meeting_slots
       (campaign_id, slot_datetime, duration_minutes, status, contact_phone, contact_name, contact_street)
     VALUES ($1,$2,45,'confirmed','972501111111','ישראל ישראלי','הרצל')`,
    [CAMPAIGN_ID, dt('09:00')]
  );

  // ── Slot 2: 09:45 — "אחר 2" (clustered with slot 1)
  await pool.query(
    `INSERT INTO meeting_slots
       (campaign_id, slot_datetime, duration_minutes, status, contact_phone, contact_name, contact_street)
     VALUES ($1,$2,45,'confirmed','972502222222','שרה כהן','הרצל')`,
    [CAMPAIGN_ID, dt('09:45')]
  );

  // ── Slot 3: 13:30 — HEMI (ISOLATED — gap >2.5h from slot 2 and slot 4)
  const hemiSlotRes = await pool.query(
    `INSERT INTO meeting_slots
       (campaign_id, slot_datetime, duration_minutes, status, contact_phone, contact_name, contact_street, contact_address)
     VALUES ($1,$2,45,'confirmed',$3,'חמי מיכאלי',$4,$5)
     RETURNING id`,
    [CAMPAIGN_ID, dt('13:30'), phone, street, `${street}, תל אביב`]
  );

  // ── Slot 4: 16:00 — "אחר 3" (clustered at afternoon)
  await pool.query(
    `INSERT INTO meeting_slots
       (campaign_id, slot_datetime, duration_minutes, status, contact_phone, contact_name, contact_street)
     VALUES ($1,$2,45,'confirmed','972503333333','דוד לוי','הרצל')`,
    [CAMPAIGN_ID, dt('16:00')]
  );

  // ── Slot 5: 16:45 — "אחר 4" (clustered with slot 4)
  await pool.query(
    `INSERT INTO meeting_slots
       (campaign_id, slot_datetime, duration_minutes, status, contact_phone, contact_name, contact_street)
     VALUES ($1,$2,45,'confirmed','972504444444','רחל מזרחי','הרצל')`,
    [CAMPAIGN_ID, dt('16:45')]
  );

  // ── OPEN Slot at 09:30 — best proposal for Hemi (between slot 1 and slot 2)
  // This is where the optimizer should suggest moving Hemi to
  const proposedSlotRes = await pool.query(
    `INSERT INTO meeting_slots
       (campaign_id, slot_datetime, duration_minutes, status)
     VALUES ($1,$2,45,'open')
     RETURNING id`,
    [CAMPAIGN_ID, dt('10:30')]
  );

  // Bot session for Hemi
  await pool.query(
    `INSERT INTO bot_sessions (phone, zoho_campaign_id, state, language, contact_address, contact_street, context)
     VALUES ($1,$2,'confirmed','he',$3,$4,$5)
     ON CONFLICT (phone, zoho_campaign_id) DO UPDATE
     SET state='confirmed', contact_address=EXCLUDED.contact_address,
         contact_street=EXCLUDED.contact_street, context=EXCLUDED.context`,
    [
      phone, CAMPAIGN_ID,
      `${street}, תל אביב`,
      street,
      JSON.stringify({ contactName: 'חמי מיכאלי', confirmedSlot: { dateStr: tDate, timeStr: '13:30' } })
    ]
  );

  return {
    hemi_slot_id: hemiSlotRes.rows[0].id,
    proposed_slot_id: proposedSlotRes.rows[0].id,
    tomorrow: tDate,
    slots_created: 6
  };
}

// ══════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════

/**
 * POST /api/test/optimization/setup
 * 1. Find Hemi in Zoho
 * 2. Ensure he has an address (add one if missing)
 * 3. Create/verify Zoho campaign
 * 4. Seed DB slots for tomorrow
 */
router.post('/setup', async (req, res) => {
  const log = [];
  const step = (msg, data) => { log.push({ msg, data }); logger.info(`[TestSetup] ${msg}`); };

  try {
    // ── Step 1: Zoho contact ──────────────────────────────────
    step('Fetching Zoho token...');
    let zohoContactId = null;
    let hemiPhone = TEST_PHONE;
    let hemiStreet = 'הרצל 20';
    let zohoOk = false;

    try {
      const token = await getZohoToken();
      step('Zoho token OK');

      const contact = await findHemiInZoho(token);
      if (contact) {
        zohoContactId = contact.id;
        hemiPhone = (contact.Mobile || contact.Phone || TEST_PHONE).replace(/\D/g, '');
        if (!hemiPhone.startsWith('972')) hemiPhone = '972' + hemiPhone.replace(/^0/, '');
        step(`Found Hemi in Zoho: ${contact.First_Name} ${contact.Last_Name}`, { id: zohoContactId, phone: hemiPhone, street: contact.Mailing_Street });

        // Ensure address
        const addrResult = await ensureZohoAddress(token, zohoContactId, contact.Mailing_Street);
        hemiStreet = addrResult.street?.replace(/^(רחוב|שד'|דרך)\s+/i, '').replace(/\s+\d+$/, '').trim() || 'הרצל';
        step(addrResult.updated ? `Address added: ${addrResult.street}` : `Address exists: ${addrResult.street}`);
      } else {
        step('Hemi not found in Zoho — using test defaults', { phone: hemiPhone });
      }

      // Create/verify Zoho campaign
      const zohoId = await ensureZohoCampaign(token, zohoContactId);
      step(`Zoho campaign: ${CAMPAIGN_ID}`, { zoho_id: zohoId });
      zohoOk = true;
    } catch (zohoErr) {
      step(`Zoho error (continuing with DB-only): ${zohoErr.message}`);
    }

    // ── Step 2: Seed DB slots ─────────────────────────────────
    step('Seeding test slots in DB...');
    const seedResult = await seedTestSlots(hemiPhone, hemiStreet);
    step('Slots seeded', seedResult);

    // ── Step 3: Run optimization ──────────────────────────────
    step('Running optimization engine...');
    const optimizationService = require('../services/optimizationService');
    const optResult = await optimizationService.sendRescheduleOffers(CAMPAIGN_ID);
    step('Optimization run complete', optResult);

    // ── Step 4: Fetch current state ───────────────────────────
    const slotRows = await pool.query(
      `SELECT id, TO_CHAR(slot_datetime AT TIME ZONE 'Asia/Jerusalem','HH24:MI') AS time,
              status, contact_name, contact_phone
       FROM meeting_slots WHERE campaign_id=$1 ORDER BY slot_datetime`,
      [CAMPAIGN_ID]
    );
    const reqRows = await pool.query(
      `SELECT * FROM reschedule_requests WHERE campaign_id=$1 ORDER BY created_at DESC LIMIT 5`,
      [CAMPAIGN_ID]
    );

    res.json({
      success: true,
      campaign_id: CAMPAIGN_ID,
      hemi_phone: hemiPhone,
      hemi_street: hemiStreet,
      zoho_ok: zohoOk,
      zoho_contact_id: zohoContactId,
      seed: seedResult,
      optimization: optResult,
      slots: slotRows.rows,
      reschedule_requests: reqRows.rows,
      log
    });

  } catch (err) {
    logger.error('[TestSetup] Fatal:', err.message);
    res.status(500).json({ success: false, error: err.message, log });
  }
});

/**
 * GET /api/test/optimization/state
 * Show current slots + reschedule_requests for HEMI-TEST-001
 */
router.get('/state', async (req, res) => {
  try {
    const slots = await pool.query(
      `SELECT id,
              TO_CHAR(slot_datetime AT TIME ZONE 'Asia/Jerusalem','HH24:MI') AS time,
              status, contact_name, contact_phone, contact_street
       FROM meeting_slots WHERE campaign_id=$1 ORDER BY slot_datetime`,
      [CAMPAIGN_ID]
    );
    const requests = await pool.query(
      `SELECT rr.*, 
              TO_CHAR(rr.original_datetime AT TIME ZONE 'Asia/Jerusalem','HH24:MI') AS orig_time,
              TO_CHAR(rr.proposed_datetime AT TIME ZONE 'Asia/Jerusalem','HH24:MI') AS prop_time
       FROM reschedule_requests rr WHERE rr.campaign_id=$1 ORDER BY rr.created_at DESC`,
      [CAMPAIGN_ID]
    );
    const session = await pool.query(
      `SELECT phone, state, language, contact_street, context FROM bot_sessions WHERE zoho_campaign_id=$1`,
      [CAMPAIGN_ID]
    );
    res.json({ campaign_id: CAMPAIGN_ID, slots: slots.rows, requests: requests.rows, sessions: session.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/test/optimization/reset
 * Clean up all test data
 */
router.post('/reset', async (req, res) => {
  try {
    await pool.query(`DELETE FROM reschedule_requests WHERE campaign_id=$1`, [CAMPAIGN_ID]);
    await pool.query(`DELETE FROM meeting_slots WHERE campaign_id=$1`, [CAMPAIGN_ID]);
    await pool.query(`DELETE FROM bot_sessions WHERE zoho_campaign_id=$1`, [CAMPAIGN_ID]);
    await pool.query(`DELETE FROM campaign_schedule_config WHERE zoho_campaign_id=$1`, [CAMPAIGN_ID]);
    res.json({ success: true, message: 'Test data cleared' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
