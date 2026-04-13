/**
 * VAPI Call Routes
 *
 * Slot availability checks BOTH:
 *   1. Google Calendar (personal calendar via service account)
 *   2. QUANTUM DB — quantum_events + appointments tables
 *
 * VAPI tool servers always receive POST regardless of declared method.
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

const HEMI_CALENDAR_ID = process.env.HEMI_CALENDAR_ID || 'primary';
const TZ = 'Asia/Jerusalem';

// ── Helper: Google Calendar ───────────────────────────────────────────────────
function getCalendar() {
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SA_EMAIL,
      private_key: (process.env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  return google.calendar({ version: 'v3', auth });
}

// ── Helper: Hebrew date string ────────────────────────────────────────────────
function heDate(dt) {
  const d = new Date(dt);
  const days    = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
  const months  = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני',
                   'יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  const il = new Date(d.toLocaleString('en-US', { timeZone: TZ }));
  const hh = String(il.getHours()).padStart(2, '0');
  const mm = String(il.getMinutes()).padStart(2, '0');
  return `יום ${days[il.getDay()]}, ${il.getDate()} ב${months[il.getMonth()]}, בשעה ${hh}:${mm}`;
}

// ── Helper: today in Hebrew ───────────────────────────────────────────────────
function heToday() {
  const days   = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
  const months = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני',
                  'יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  const il = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
  return `יום ${days[il.getDay()]}, ${il.getDate()} ב${months[il.getMonth()]} ${il.getFullYear()}`;
}

// ── Get busy slots from QUANTUM DB ────────────────────────────────────────────
async function getQuantumBusy(fromDt, toDt) {
  const busy = [];
  try {
    // quantum_events
    const { rows: events } = await pool.query(`
      SELECT event_date as start,
             event_date + INTERVAL '30 minutes' as end
      FROM quantum_events
      WHERE event_date >= $1 AND event_date < $2
        AND status NOT IN ('cancelled','ביטול') AND status IS DISTINCT FROM 'cancelled'
    `, [fromDt.toISOString(), toDt.toISOString()]);
    busy.push(...events.map(r => ({ start: new Date(r.start), end: new Date(r.end) })));
  } catch (e) { logger.warn('[VapiCall] quantum_events query error:', e.message); }

  try {
    // appointments (via meeting_slots)
    const { rows: slots } = await pool.query(`
      SELECT ms.slot_datetime as start,
             ms.slot_datetime + (COALESCE(ms.duration_minutes, 30) * INTERVAL '1 minute') as end
      FROM meeting_slots ms
      WHERE ms.slot_datetime >= $1 AND ms.slot_datetime < $2
        AND ms.status IN ('confirmed','reserved')
    `, [fromDt.toISOString(), toDt.toISOString()]);
    busy.push(...slots.map(r => ({ start: new Date(r.start), end: new Date(r.end) })));
  } catch (e) { logger.warn('[VapiCall] meeting_slots query error:', e.message); }

  try {
    // vapi_booked appointments recorded by us
    const { rows: booked } = await pool.query(`
      SELECT call_scheduled_at as start,
             call_scheduled_at + INTERVAL '30 minutes' as end
      FROM listings
      WHERE call_scheduled_at >= $1 AND call_scheduled_at < $2
        AND call_scheduled_at IS NOT NULL
    `, [fromDt.toISOString(), toDt.toISOString()]);
    busy.push(...booked.map(r => ({ start: new Date(r.start), end: new Date(r.end) })));
  } catch (e) { /* column may not exist yet */ }

  return busy;
}

// ── Core: get available slots ─────────────────────────────────────────────────
async function getSlots() {
  const now = new Date();
  const end = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);

  // 1. Google Calendar busy
  let gcalBusy = [];
  try {
    const calendar = getCalendar();
    const busyRes = await calendar.freebusy.query({
      requestBody: {
        timeMin: now.toISOString(),
        timeMax: end.toISOString(),
        timeZone: TZ,
        items: [{ id: HEMI_CALENDAR_ID }]
      }
    });
    gcalBusy = (busyRes.data.calendars?.[HEMI_CALENDAR_ID]?.busy || [])
      .map(b => ({ start: new Date(b.start), end: new Date(b.end) }));
  } catch (e) {
    logger.warn('[VapiCall] Google Calendar error:', e.message);
  }

  // 2. QUANTUM DB busy
  const dbBusy = await getQuantumBusy(now, end);

  // Merge all busy periods
  const allBusy = [...gcalBusy, ...dbBusy];

  // 3. Generate candidate slots in Israel time (09:00–18:00, every 30 min)
  const slots = [];
  const cursor = new Date(now);
  const mins = cursor.getMinutes();
  if (mins < 30) { cursor.setMinutes(30, 0, 0); }
  else { cursor.setHours(cursor.getHours() + 1, 0, 0, 0); }

  while (slots.length < 6 && cursor < end) {
    const il = new Date(cursor.toLocaleString('en-US', { timeZone: TZ }));
    const hour = il.getHours();
    const day  = il.getDay();

    if (day !== 5 && day !== 6 && hour >= 9 && hour < 18) {
      const slotEnd = new Date(cursor.getTime() + 30 * 60 * 1000);
      const isBusy  = allBusy.some(b => cursor < b.end && slotEnd > b.start);
      if (!isBusy) {
        slots.push({
          start: cursor.toISOString(),
          end:   slotEnd.toISOString(),
          label: heDate(cursor)
        });
      }
    }
    cursor.setTime(cursor.getTime() + 30 * 60 * 1000);
  }

  return {
    today: heToday(),
    gcal_busy: gcalBusy.length,
    db_busy: dbBusy.length,
    slots
  };
}

// ── POST /api/vapi-call/slots  (VAPI tool) ────────────────────────────────────
router.post('/slots', async (req, res) => {
  try {
    const { slots, today } = await getSlots();
    const slotText = slots.slice(0, 4).map(s => s.label).join('\n');
    res.json({
      today,
      available_slots: slots.slice(0, 4).map(s => ({ label: s.label, start: s.start, end: s.end })),
      message: `היום ${today}.\nהמועדים הפנויים ביומן:\n${slotText}`
    });
  } catch (err) {
    logger.error('[VapiCall] Slots error:', err.message);
    res.json({ message: 'לא הצלחתי לבדוק את היומן. שאל את הלקוח מה נוח לו ואמור שנחזור לאשר.' });
  }
});

// ── GET /api/vapi-call/slots  (manual) ───────────────────────────────────────
router.get('/slots', async (req, res) => {
  try {
    const data = await getSlots();
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/vapi-call/book  (VAPI tool) ────────────────────────────────────
router.post('/book', async (req, res) => {
  const { start, end, phone, rooms, price } = req.body;
  try {
    const startDt = new Date(start);
    const endDt   = end ? new Date(end) : new Date(startDt.getTime() + 30 * 60 * 1000);
    const label   = heDate(startDt);

    // 1. Google Calendar
    try {
      const calendar = getCalendar();
      await calendar.events.insert({
        calendarId: HEMI_CALENDAR_ID,
        requestBody: {
          summary: `שיחת מנהל — ${phone || 'לא ידוע'}`,
          description: [
            'מקור: שיחת הילה VAPI',
            rooms ? `${rooms} חדרים` : '',
            price ? `מחיר: ₪${price}` : ''
          ].filter(Boolean).join('\n'),
          start: { dateTime: startDt.toISOString(), timeZone: TZ },
          end:   { dateTime: endDt.toISOString(),   timeZone: TZ }
        }
      });
    } catch (e) {
      logger.warn('[VapiCall] GCal insert error:', e.message);
    }

    // 2. Record in DB (quantum_events)
    try {
      await pool.query(`
        INSERT INTO quantum_events (title, event_type, event_date, notes, status, created_at)
        VALUES ($1, 'שיחת_מנהל', $2, $3, 'confirmed', NOW())
      `, [
        `שיחת מנהל — ${phone || 'לא ידוע'}`,
        startDt.toISOString(),
        [rooms ? `${rooms} חדרים` : '', price ? `₪${price}` : '', `מקור: VAPI הילה`].filter(Boolean).join(' | ')
      ]);
    } catch (e) { logger.warn('[VapiCall] DB event insert error:', e.message); }

    // 3. WhatsApp summary to customer
    if (phone) {
      try {
        const normalized = phone.replace(/^\+972/, '0').replace(/\D/g, '');
        const wa =
          `שלום רב,\n` +
          `בהמשך לשיחתנו קבענו שיחת מנהל ב${label}.\n\n` +
          `המשך יום נעים,\n` +
          `הילה | קוונטום נדל"ן`;
        const { sendWhatsAppChat } = require('../services/inforuService');
        await sendWhatsAppChat(normalized, wa, {
          customerMessageId: `vapi_book_${Date.now()}`,
          customerParameter: 'QUANTUM_PILOT'
        });
        logger.info(`[VapiCall] WA summary → ${normalized}`);
      } catch (e) { logger.warn('[VapiCall] WA send error:', e.message); }
    }

    logger.info(`[VapiCall] Booked: ${label} | phone: ${phone}`);
    res.json({
      success: true,
      label,
      message: `הפגישה נקבעה ל${label}. נשלחה הודעת אישור בוואטסאפ.`
    });
  } catch (err) {
    logger.error('[VapiCall] Book error:', err.message);
    res.json({ success: false, message: 'לא הצלחתי לקבוע. אמרי ללקוח שהמנהל יחזור אליו לאשר.' });
  }
});

// ── POST /api/vapi-call/webhook  (end-of-call) ───────────────────────────────
router.post('/webhook', async (req, res) => {
  res.json({ received: true });
  try {
    const type = req.body?.message?.type || req.body?.type;
    logger.info(`[VapiCall] Webhook: ${type}`);
  } catch (err) {
    logger.error('[VapiCall] Webhook error:', err.message);
  }
});

module.exports = router;
