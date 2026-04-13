/**
 * VAPI Call Routes
 * - GET  /api/vapi-call/slots        — returns next available calendar slots
 * - POST /api/vapi-call/book         — books a slot and returns confirmation
 * - POST /api/vapi-call/webhook      — called by VAPI on call end → sends WA summary
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

const HEMI_CALENDAR_ID = process.env.HEMI_CALENDAR_ID || 'primary';

// ── Helper: get Google Calendar service ──────────────────────────────────────
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

// ── GET /api/vapi-call/slots ──────────────────────────────────────────────────
// Returns next 6 available 30-min slots (working hours, next 2 days)
router.get('/slots', async (req, res) => {
  try {
    const calendar = getCalendar();
    const now = new Date();
    const end = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000); // +2 days

    const busyRes = await calendar.freebusy.query({
      requestBody: {
        timeMin: now.toISOString(),
        timeMax: end.toISOString(),
        timeZone: 'Asia/Jerusalem',
        items: [{ id: HEMI_CALENDAR_ID }]
      }
    });

    const busy = (busyRes.data.calendars?.[HEMI_CALENDAR_ID]?.busy || []).map(b => ({
      start: new Date(b.start),
      end: new Date(b.end)
    }));

    // Generate candidate slots: 09:00-18:00, every 30 min
    const slots = [];
    const cursor = new Date(now);
    cursor.setMinutes(cursor.getMinutes() < 30 ? 30 : 0, 0, 0);
    if (cursor.getMinutes() === 0) cursor.setHours(cursor.getHours() + 1);

    while (slots.length < 6 && cursor < end) {
      const hour = cursor.getHours();
      const day = cursor.getDay();
      // Skip weekends (5=Fri, 6=Sat) and outside 9-18
      if (day !== 5 && day !== 6 && hour >= 9 && hour < 18) {
        const slotEnd = new Date(cursor.getTime() + 30 * 60 * 1000);
        const isBusy = busy.some(b => cursor < b.end && slotEnd > b.start);
        if (!isBusy) {
          slots.push({
            start: cursor.toISOString(),
            end: slotEnd.toISOString(),
            label: cursor.toLocaleString('he-IL', {
              timeZone: 'Asia/Jerusalem',
              weekday: 'long', day: 'numeric', month: 'long',
              hour: '2-digit', minute: '2-digit'
            })
          });
        }
      }
      cursor.setMinutes(cursor.getMinutes() + 30);
    }

    res.json({ success: true, slots });
  } catch (err) {
    logger.error('[VapiCall] Slots error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/vapi-call/book ──────────────────────────────────────────────────
// body: { start, end, phone, complexName, city, rooms, price }
router.post('/book', async (req, res) => {
  const { start, end, phone, complexName, city, rooms, price } = req.body;
  try {
    const calendar = getCalendar();
    const startDt = new Date(start);
    const label = startDt.toLocaleString('he-IL', {
      timeZone: 'Asia/Jerusalem',
      weekday: 'long', day: 'numeric', month: 'long',
      hour: '2-digit', minute: '2-digit'
    });

    await calendar.events.insert({
      calendarId: HEMI_CALENDAR_ID,
      requestBody: {
        summary: `שיחת מנהל — ${phone}`,
        description: `פינוי-בינוי | ${complexName || ''} ${city || ''}\n${rooms ? rooms + ' חדרים' : ''} ${price ? '| ₪' + Number(price).toLocaleString('he-IL') : ''}\nמקור: שיחת הילה VAPI`,
        start: { dateTime: start, timeZone: 'Asia/Jerusalem' },
        end: { dateTime: end || new Date(startDt.getTime() + 30 * 60 * 1000).toISOString(), timeZone: 'Asia/Jerusalem' }
      }
    });

    // Save to DB
    try {
      await pool.query(
        `INSERT INTO listings (phone, source, source_listing_id, description_snippet, is_active, created_at, updated_at)
         VALUES ($1, 'vapi_booked', $2, $3, true, NOW(), NOW())
         ON CONFLICT DO NOTHING`,
        [phone, `vapi_${phone}_${Date.now()}`, `שיחת מנהל קבועה ל-${label}`]
      );
    } catch (e) { /* non-critical */ }

    res.json({ success: true, label, start, end });
  } catch (err) {
    logger.error('[VapiCall] Book error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/vapi-call/webhook ───────────────────────────────────────────────
// VAPI calls this when call ends. Sends WA summary if appointment was booked.
router.post('/webhook', async (req, res) => {
  res.json({ received: true }); // respond immediately

  try {
    const { message } = req.body;
    if (!message || message.type !== 'end-of-call-report') return;

    const call = message.call || {};
    const vars = call.assistantOverrides?.variableValues || {};
    const phone = call.customer?.number?.replace(/^\+972/, '0') || vars.lead_phone;
    const appointmentLabel = vars.appointment_label;
    const appointmentDay = vars.appointment_day;
    const appointmentTime = vars.appointment_time;

    if (!phone || (!appointmentLabel && !appointmentDay)) return;

    const timeStr = appointmentLabel || `${appointmentDay}, בשעה ${appointmentTime}`;

    const waMessage =
      `שלום רב,\n` +
      `בהמשך לשיחתנו קבענו שיחת מנהל ב${timeStr}.\n\n` +
      `המשך יום נעים,\n` +
      `הילה | קוונטום נדל"ן`;

    const { sendWhatsAppChat } = require('../services/inforuService');
    await sendWhatsAppChat(phone, waMessage, {
      customerMessageId: `vapi_summary_${Date.now()}`,
      customerParameter: 'QUANTUM_PILOT'
    });

    logger.info(`[VapiCall] WA summary sent to ${phone}: ${timeStr}`);
  } catch (err) {
    logger.error('[VapiCall] Webhook error:', err.message);
  }
});

module.exports = router;
