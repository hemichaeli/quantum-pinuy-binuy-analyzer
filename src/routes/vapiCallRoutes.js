/**
 * VAPI Call Routes
 *
 * Slot availability checks BOTH:
 *   1. Google Calendar (personal calendar via service account)
 *   2. QUANTUM DB — quantum_events + meeting_slots tables
 *
 * VAPI tool servers always receive POST regardless of declared method.
 * Phone is passed automatically as lead_phone variable — never asked from user.
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

const HEMI_CALENDAR_ID = process.env.HEMI_CALENDAR_ID || 'primary';
const TZ = 'Asia/Jerusalem';

const DAYS   = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
const MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני',
                'יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

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

// ── Helper: convert UTC Date → Israel local Date object ───────────────────────
function toIsrael(dt) {
  const d = new Date(dt);
  // Use the en-US locale parts to extract Israel time components
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(d);
  const get = (type) => parts.find(p => p.type === type)?.value || '0';
  return new Date(
    parseInt(get('year')), parseInt(get('month')) - 1, parseInt(get('day')),
    parseInt(get('hour')), parseInt(get('minute')), parseInt(get('second'))
  );
}

// ── Helper: Hebrew date+time label (all Hebrew, no English) ──────────────────
function heDate(dt) {
  const il = toIsrael(dt);
  const hh = String(il.getHours()).padStart(2, '0');
  const mm = String(il.getMinutes()).padStart(2, '0');
  return `יום ${DAYS[il.getDay()]}, ${il.getDate()} ב${MONTHS[il.getMonth()]}, בשעה ${hh}:${mm}`;
}

// ── Helper: today in Hebrew ───────────────────────────────────────────────────
function heToday() {
  const il = toIsrael(new Date());
  return `יום ${DAYS[il.getDay()]}, ${il.getDate()} ב${MONTHS[il.getMonth()]} ${il.getFullYear()}`;
}

// ── Helper: QUANTUM DB busy periods ──────────────────────────────────────────
async function getQuantumBusy(fromDt, toDt) {
  const busy = [];
  try {
    const { rows } = await pool.query(`
      SELECT event_date as start, event_date + INTERVAL '30 minutes' as end
      FROM quantum_events
      WHERE event_date >= $1 AND event_date < $2
        AND (status IS NULL OR status NOT IN ('cancelled','ביטול'))
    `, [fromDt.toISOString(), toDt.toISOString()]);
    busy.push(...rows.map(r => ({ start: new Date(r.start), end: new Date(r.end) })));
  } catch (e) { logger.warn('[VapiCall] quantum_events:', e.message); }

  try {
    const { rows } = await pool.query(`
      SELECT slot_datetime as start,
             slot_datetime + (COALESCE(duration_minutes,30) * INTERVAL '1 minute') as end
      FROM meeting_slots
      WHERE slot_datetime >= $1 AND slot_datetime < $2
        AND status IN ('confirmed','reserved')
    `, [fromDt.toISOString(), toDt.toISOString()]);
    busy.push(...rows.map(r => ({ start: new Date(r.start), end: new Date(r.end) })));
  } catch (e) { logger.warn('[VapiCall] meeting_slots:', e.message); }

  return busy;
}

// ── Core: compute available slots ────────────────────────────────────────────
async function computeSlots() {
  const now = new Date();
  const end = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);

  // Google Calendar busy
  let gcalBusy = [];
  try {
    const calendar = getCalendar();
    const res = await calendar.freebusy.query({
      requestBody: {
        timeMin: now.toISOString(), timeMax: end.toISOString(),
        timeZone: TZ, items: [{ id: HEMI_CALENDAR_ID }]
      }
    });
    gcalBusy = (res.data.calendars?.[HEMI_CALENDAR_ID]?.busy || [])
      .map(b => ({ start: new Date(b.start), end: new Date(b.end) }));
  } catch (e) { logger.warn('[VapiCall] GCal freebusy:', e.message); }

  const dbBusy = await getQuantumBusy(now, end);
  const allBusy = [...gcalBusy, ...dbBusy];

  // Generate slots (working hours 09:00–18:00, skip Fri/Sat)
  const slots = [];
  const cursor = new Date(now);
  const mins = cursor.getMinutes();
  if (mins < 30) { cursor.setMinutes(30, 0, 0); }
  else { cursor.setHours(cursor.getHours() + 1, 0, 0, 0); }

  while (slots.length < 6 && cursor < end) {
    const il = toIsrael(cursor);
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

  return { today: heToday(), slots, gcal_busy: gcalBusy.length, db_busy: dbBusy.length };
}

// ── POST /api/vapi-call/slots  (VAPI tool) ────────────────────────────────────
router.post('/slots', async (req, res) => {
  try {
    const { slots, today } = await computeSlots();
    const top4 = slots.slice(0, 4);
    const slotText = top4.map(s => s.label).join('\n');
    res.json({
      today,
      available_slots: top4.map(s => ({ label: s.label, start: s.start, end: s.end })),
      message: `היום ${today}.\nמועדים פנויים ביומן:\n${slotText}`
    });
  } catch (err) {
    logger.error('[VapiCall] Slots error:', err.message);
    res.json({ message: 'לא הצלחתי לבדוק את היומן. שאל מתי נוח לו ואמור שנחזור לאשר.' });
  }
});

// ── GET /api/vapi-call/slots  (manual test) ───────────────────────────────────
router.get('/slots', async (req, res) => {
  try { res.json({ success: true, ...(await computeSlots()) }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── POST /api/vapi-call/book  (VAPI tool) ─────────────────────────────────────
router.post('/book', async (req, res) => {
  // phone comes from lead_phone variable — never from user input during call
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
          description: ['מקור: שיחת הילה VAPI', rooms ? `${rooms} חדרים` : '', price ? `₪${price}` : ''].filter(Boolean).join('\n'),
          start: { dateTime: startDt.toISOString(), timeZone: TZ },
          end:   { dateTime: endDt.toISOString(),   timeZone: TZ }
        }
      });
    } catch (e) { logger.warn('[VapiCall] GCal insert:', e.message); }

    // 2. QUANTUM DB
    try {
      await pool.query(`
        INSERT INTO quantum_events (title, event_type, event_date, notes, status, created_at)
        VALUES ($1, 'שיחת_מנהל', $2, $3, 'confirmed', NOW())
      `, [
        `שיחת מנהל — ${phone || 'לא ידוע'}`,
        startDt.toISOString(),
        [rooms ? `${rooms} חדרים` : '', price ? `₪${price}` : '', 'מקור: VAPI הילה'].filter(Boolean).join(' | ')
      ]);
    } catch (e) { logger.warn('[VapiCall] DB insert:', e.message); }

    // 3. WhatsApp summary — phone is already the customer's number
    if (phone) {
      try {
        const normalized = phone.replace(/^\+972/, '0').replace(/\D/g, '');
        const wa = `שלום רב,\nבהמשך לשיחתנו קבענו שיחת מנהל ב${label}.\n\nהמשך יום נעים,\nהילה | קוונטום נדל"ן`;
        const { sendWhatsAppChat } = require('../services/inforuService');
        await sendWhatsAppChat(normalized, wa, {
          customerMessageId: `vapi_book_${Date.now()}`,
          customerParameter: 'QUANTUM_PILOT'
        });
        logger.info(`[VapiCall] WA → ${normalized}: ${label}`);
      } catch (e) { logger.warn('[VapiCall] WA send:', e.message); }
    }

    logger.info(`[VapiCall] Booked: ${label} | ${phone}`);
    res.json({ success: true, label, message: `הפגישה נקבעה ל${label}. נשלחה הודעת אישור בוואטסאפ.` });
  } catch (err) {
    logger.error('[VapiCall] Book error:', err.message);
    res.json({ success: false, message: 'לא הצלחתי לקבוע. המנהל יחזור לאשר.' });
  }
});

// ── POST /api/vapi-call/webhook ───────────────────────────────────────────────
router.post('/webhook', async (req, res) => {
  res.json({ received: true });
  try { logger.info(`[VapiCall] Webhook: ${req.body?.message?.type || req.body?.type}`); }
  catch (e) {}
});

module.exports = router;
