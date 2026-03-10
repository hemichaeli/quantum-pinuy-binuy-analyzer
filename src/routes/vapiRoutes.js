/**
 * QUANTUM Voice AI - Vapi Integration Routes
 * v1.8.0 - inforuService XML SMS, pre-fetched slots in prompt, native endCall
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');
const axios = require('axios');
const { JWT } = require('google-auth-library');

const VAPI_API_KEY = process.env.VAPI_API_KEY || '';

// ─── Google Service Account Auth ─────────────────────────────────────────────

let _googleAuthClient = null;

function getGoogleAuthClient() {
  if (_googleAuthClient) return _googleAuthClient;
  const email = process.env.GOOGLE_SA_EMAIL;
  const rawKey = process.env.GOOGLE_SA_PRIVATE_KEY;
  if (!email || !rawKey) { logger.warn('[VAPI] Google SA credentials not set'); return null; }
  const key = rawKey.replace(/\\n/g, '\n');
  _googleAuthClient = new JWT({ email, key, scopes: ['https://www.googleapis.com/auth/calendar'] });
  return _googleAuthClient;
}

async function getGoogleAccessToken() {
  const client = getGoogleAuthClient();
  if (!client) return null;
  try {
    const tokenResponse = await client.getAccessToken();
    return tokenResponse.token;
  } catch (err) {
    logger.error('[VAPI] Google access token error:', err.message);
    return null;
  }
}

const HEMI_CALENDAR_ID    = process.env.HEMI_CALENDAR_ID    || 'hemi.michaeli@gmail.com';
const QUANTUM_CALENDAR_ID = process.env.QUANTUM_CALENDAR_ID ||
  'cf4cd8ef53ef4cbdca7f172bdef3f6862509b4026a5e04b648ce09144ab5aa21@group.calendar.google.com';

// Hebrew spoken hour labels
const HOUR_LABELS = {
  9: 'תשע בבוקר', 10: 'עשר בבוקר', 11: 'אחת עשרה בבוקר',
  12: 'שתים עשרה', 13: 'אחת אחרי הצהריים', 14: 'שתיים אחרי הצהריים',
  15: 'שלוש אחרי הצהריים', 16: 'ארבע אחרי הצהריים', 17: 'חמש אחרי הצהריים',
};

function hebrewDayLabel(dateStr, todayStr) {
  const diff = Math.round((new Date(dateStr) - new Date(todayStr)) / 86400000);
  if (diff === 1) return 'מחר';
  if (diff === 2) return 'מחרתיים';
  const days = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  return 'ב' + days[new Date(dateStr).getDay()];
}

// ─── Pre-call free slot fetcher ───────────────────────────────────────────────

async function fetchFreeSlots() {
  const TZ = 'Asia/Jerusalem';
  const now = new Date();
  const todayStr = now.toLocaleDateString('sv-SE', { timeZone: TZ });

  // Build candidate slots for next 3 weekdays
  const candidates = [];
  let d = new Date(now);
  let daysAdded = 0;
  while (daysAdded < 3) {
    d = new Date(d.getTime() + 86400000);
    const dow = d.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' });
    if (dow === 'Fri' || dow === 'Sat') continue; // Israel weekend
    const dateStr = d.toLocaleDateString('sv-SE', { timeZone: TZ });
    for (const h of [9, 10, 11, 13, 14, 15, 16]) candidates.push({ dateStr, hour: h });
    daysAdded++;
  }

  const accessToken = await getGoogleAccessToken();
  if (!accessToken || !candidates.length) return getFallbackSlots(todayStr);

  const timeMin = new Date(`${candidates[0].dateStr}T09:00:00+03:00`).toISOString();
  const timeMax = new Date(`${candidates[candidates.length - 1].dateStr}T18:00:00+03:00`).toISOString();

  let busyIntervals = [];
  try {
    const fbRes = await axios.post(
      'https://www.googleapis.com/calendar/v3/freeBusy',
      { timeMin, timeMax, timeZone: TZ, items: [{ id: HEMI_CALENDAR_ID }, { id: QUANTUM_CALENDAR_ID }] },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    const cals = fbRes.data.calendars || {};
    for (const cal of Object.values(cals)) busyIntervals = busyIntervals.concat(cal?.busy || []);
  } catch (err) {
    logger.warn('[VAPI] freeBusy pre-fetch failed:', err.message);
    return getFallbackSlots(todayStr);
  }

  const free = [];
  for (const { dateStr, hour } of candidates) {
    if (free.length >= 4) break;
    const slotStart = new Date(`${dateStr}T${String(hour).padStart(2, '0')}:00:00+03:00`);
    const slotEnd = new Date(slotStart.getTime() + 3600000);
    const isBusy = busyIntervals.some(b => slotStart < new Date(b.end) && slotEnd > new Date(b.start));
    if (!isBusy) {
      free.push({
        iso: slotStart.toISOString(),
        label: `${hebrewDayLabel(dateStr, todayStr)} ב${HOUR_LABELS[hour]}`,
        date: dateStr,
        time: `${String(hour).padStart(2, '0')}:00`,
      });
    }
  }
  return free.length >= 2 ? free : getFallbackSlots(todayStr);
}

function getFallbackSlots(todayStr) {
  const slots = [];
  let d = new Date(todayStr + 'T12:00:00+03:00');
  let added = 0;
  while (added < 2) {
    d = new Date(d.getTime() + 86400000);
    const dow = d.toLocaleDateString('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short' });
    if (dow === 'Fri' || dow === 'Sat') continue;
    const dateStr = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Jerusalem' });
    const day = hebrewDayLabel(dateStr, todayStr);
    slots.push({ iso: new Date(`${dateStr}T10:00:00+03:00`).toISOString(), label: `${day} בעשר בבוקר`, date: dateStr, time: '10:00' });
    slots.push({ iso: new Date(`${dateStr}T14:00:00+03:00`).toISOString(), label: `${day} בשתיים אחרי הצהריים`, date: dateStr, time: '14:00' });
    added++;
  }
  return slots.slice(0, 4);
}

// ─── Vapi tool call parser ────────────────────────────────────────────────────
// Vapi sends: body.message.toolCallList  (NOT toolCalls)
// Response must be: { results: [{ toolCallId, result }] }

function parseVapiToolCall(body, toolName) {
  const list = body?.message?.toolCallList || body?.message?.toolCalls || [];
  const tc = list.find(t => t.function?.name === toolName);
  if (!tc) return { toolCallId: null, args: null };
  const args = typeof tc.function.arguments === 'string'
    ? JSON.parse(tc.function.arguments)
    : (tc.function.arguments || {});
  return { toolCallId: tc.id || tc.toolCallId || null, args };
}

function vapiToolResponse(res, toolCallId, resultText) {
  return res.json({ results: [{ toolCallId: toolCallId || 'unknown', result: resultText }] });
}

// ─── Calendar links ───────────────────────────────────────────────────────────

function generateCalendarLinks({ title, description, location, startISO, durationMinutes = 30 }) {
  const start = new Date(startISO);
  const end = new Date(start.getTime() + durationMinutes * 60000);
  const fmt = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const enc = encodeURIComponent;
  return {
    google: `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${enc(title)}&dates=${fmt(start)}/${fmt(end)}&details=${enc(description)}&location=${enc(location || '')}`,
    outlook: `https://outlook.live.com/calendar/0/deeplink/compose?subject=${enc(title)}&startdt=${start.toISOString()}&enddt=${end.toISOString()}&body=${enc(description)}&location=${enc(location || '')}&path=%2Fcalendar%2Faction%2Fcompose&rru=addevent`,
  };
}

// ─── Send meeting notification (SMS via inforuService XML, WA fallback) ───────

async function sendMeetingNotification({ phone, leadName, meetingDatetime, address }) {
  const inforuService = require('../services/inforuService');

  const start = new Date(meetingDatetime);
  const dateStr = start.toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'long', day: 'numeric', month: 'long' });
  const timeStr = start.toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });

  const links = generateCalendarLinks({
    title: 'פגישה עם קוונטום נדלן',
    description: `פגישת ייעוץ נדלן${address ? ' - ' + address : ''}`,
    location: address || '',
    startISO: meetingDatetime,
    durationMinutes: 30,
  });

  const msg = [
    `שלום${leadName ? ' ' + leadName : ''}!`,
    `פגישתך עם קוונטום נדלן אושרה:`,
    `${dateStr} בשעה ${timeStr}`,
    address ? `כתובת: ${address}` : null,
    '',
    'הוסף ליומן:',
    `Google: ${links.google}`,
    `Outlook: ${links.outlook}`,
    '',
    'קוונטום נדלן | 03-757-2229',
  ].filter(l => l !== null).join('\n');

  // SMS via XML endpoint (uses INFORU_PASSWORD / INFORU_USERNAME)
  try {
    const smsResult = await inforuService.sendSms(phone, msg);
    if (smsResult.success) {
      logger.info(`[VAPI] Meeting SMS sent to ${phone}`);
      return { success: true, channel: 'sms' };
    }
    logger.warn('[VAPI] SMS failed, trying WhatsApp chat:', smsResult.description);
  } catch (err) {
    logger.warn('[VAPI] SMS exception, trying WhatsApp chat:', err.message);
  }

  // WhatsApp fallback (chat - only works within 24h window)
  try {
    const waResult = await inforuService.sendWhatsAppChat(phone, msg);
    if (waResult.success) {
      logger.info(`[VAPI] Meeting WhatsApp sent to ${phone}`);
      return { success: true, channel: 'whatsapp' };
    }
    logger.warn('[VAPI] WhatsApp also failed:', waResult.description || JSON.stringify(waResult));
    return { success: false, error: waResult.description };
  } catch (err) {
    logger.error('[VAPI] Both SMS and WhatsApp failed:', err.message);
    return { success: false, error: err.message };
  }
}

// ─── Caller context ───────────────────────────────────────────────────────────

async function buildCallerContext(phone) {
  const normalized = phone.replace(/\D/g, '').replace(/^972/, '0').replace(/^00972/, '0');
  const variants = [normalized, `972${normalized.slice(1)}`, `+972${normalized.slice(1)}`, phone];
  let lead = null;
  try {
    const placeholders = variants.map((_, i) => `$${i + 1}`).join(', ');
    const result = await pool.query(
      `SELECT * FROM leads WHERE phone IN (${placeholders}) ORDER BY updated_at DESC LIMIT 1`, variants
    );
    if (result.rows.length > 0) lead = result.rows[0];
  } catch (err) { logger.warn('[VAPI] Lead lookup error:', err.message); }

  return {
    lead_name: lead?.name || 'אורח',
    lead_id: lead?.id || null,
    lead_context: lead ? `שם: ${lead.name}, סוג: ${lead.user_type}, סטטוס: ${lead.status}` : null,
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

router.get('/agents', (req, res) => {
  res.json({ success: true, agents: [{ id: 'cold_prospecting', name: 'Cold Prospecting', hasAssistantId: !!process.env.VAPI_ASSISTANT_COLD }] });
});

router.get('/google-auth-status', async (req, res) => {
  try {
    if (!process.env.GOOGLE_SA_EMAIL || !process.env.GOOGLE_SA_PRIVATE_KEY) return res.json({ success: false, configured: false });
    const token = await getGoogleAccessToken();
    res.json({ success: !!token, configured: true, serviceAccountEmail: process.env.GOOGLE_SA_EMAIL, tokenObtained: !!token });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Send Meeting SMS (called by Vapi tool) ───────────────────────────────────

router.post('/send-meeting-sms', async (req, res) => {
  try {
    const body = req.body;
    logger.info('[VAPI] send-meeting-sms body:', JSON.stringify(body).substring(0, 500));

    const { toolCallId, args } = parseVapiToolCall(body, 'sendMeetingSMS');

    const phone = args?.phone || body?.message?.call?.customer?.number || body.phone;
    const leadName        = args?.lead_name        || body.lead_name;
    const meetingDatetime = args?.meeting_datetime  || body.meeting_datetime;
    const address         = args?.address           || body.address;

    logger.info(`[VAPI] send-meeting-sms: phone=${phone} dt=${meetingDatetime} name=${leadName}`);

    if (!phone || !meetingDatetime) {
      return vapiToolResponse(res, toolCallId, 'CONFIRM:no_phone');
    }

    const result = await sendMeetingNotification({ phone, leadName, meetingDatetime, address });
    return vapiToolResponse(res, toolCallId, result.success ? 'SMS_SENT' : 'SMS_FAILED');

  } catch (err) {
    logger.error('[VAPI] send-meeting-sms error:', err.message);
    return vapiToolResponse(res, null, 'SMS_FAILED');
  }
});

// ─── Debug: test SMS ──────────────────────────────────────────────────────────

router.post('/test-sms', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const result = await sendMeetingNotification({
      phone,
      leadName: 'בדיקה',
      meetingDatetime: new Date(Date.now() + 86400000).toISOString(),
      address: 'רחוב הבדיקה 1, תל אביב',
    });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Outbound Call ────────────────────────────────────────────────────────────

const AGENTS_CONFIG = {
  cold_prospecting:    process.env.VAPI_ASSISTANT_COLD     || null,
  seller_followup:     process.env.VAPI_ASSISTANT_SELLER   || null,
  buyer_qualification: process.env.VAPI_ASSISTANT_BUYER    || null,
  meeting_reminder:    process.env.VAPI_ASSISTANT_REMINDER || null,
  inbound_handler:     process.env.VAPI_ASSISTANT_INBOUND  || null,
};

router.post('/outbound', async (req, res) => {
  try {
    const { phone, agent_type = 'cold_prospecting', lead_id, complex_id, metadata = {} } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'phone required' });
    const assistantId = AGENTS_CONFIG[agent_type];
    if (!assistantId) return res.status(503).json({ success: false, error: `No assistantId for ${agent_type}` });
    if (!VAPI_API_KEY) return res.status(503).json({ success: false, error: 'VAPI_API_KEY not configured' });

    const [context, slots] = await Promise.all([buildCallerContext(phone), fetchFreeSlots()]);

    const slotsText = slots.length >= 2
      ? slots.slice(0, 4).map(s => s.label).join(', ')
      : 'מחר בעשר בבוקר, מחרתיים בשתיים אחרי הצהריים';

    const slotsJson = JSON.stringify(slots.slice(0, 4));

    logger.info(`[VAPI] Outbound to ${phone} | slots: ${slotsText}`);

    const payload = {
      assistantId,
      customer: { number: phone, name: context.lead_name !== 'אורח' ? context.lead_name : undefined },
      assistantOverrides: {
        variableValues: {
          lead_name: context.lead_name,
          lead_context: context.lead_context || 'לקוח חדש',
          complex_city: metadata.city || '',
          available_slots: slotsText,
          slots_json: slotsJson,
        },
        metadata: { agent_type, lead_id: lead_id || context.lead_id, complex_id, ...metadata },
      },
    };
    if (process.env.VAPI_PHONE_NUMBER_ID) payload.phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;

    const vapiRes = await fetch('https://api.vapi.ai/call/phone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${VAPI_API_KEY}` },
      body: JSON.stringify(payload),
    });
    const vapiData = await vapiRes.json();
    if (!vapiRes.ok) return res.status(vapiRes.status).json({ success: false, error: vapiData.message || 'Vapi error' });

    try {
      await pool.query(
        `INSERT INTO vapi_calls (call_id, phone, agent_type, lead_id, complex_id, status, metadata, created_at)
         VALUES ($1,$2,$3,$4,$5,'initiated',$6,NOW()) ON CONFLICT (call_id) DO NOTHING`,
        [vapiData.id, phone, agent_type, lead_id || context.lead_id, complex_id, JSON.stringify({ ...metadata, available_slots: slotsText })]
      );
    } catch (dbErr) { logger.warn('[VAPI] DB log error:', dbErr.message); }

    res.json({ success: true, call_id: vapiData.id, phone, agent_type, available_slots: slotsText });
  } catch (err) {
    logger.error('[VAPI] outbound error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/outbound/batch', async (req, res) => {
  try {
    const { calls = [] } = req.body;
    if (!Array.isArray(calls) || !calls.length) return res.status(400).json({ success: false, error: 'calls array required' });
    if (calls.length > 50) return res.status(400).json({ success: false, error: 'Max 50 calls' });
    const slots = await fetchFreeSlots();
    const slotsText = slots.length >= 2 ? slots.slice(0, 4).map(s => s.label).join(', ') : 'מחר בעשר בבוקר, מחרתיים בשתיים אחרי הצהריים';
    const results = [];
    for (const call of calls) {
      const { phone, agent_type = 'cold_prospecting', lead_id, complex_id, metadata = {} } = call;
      const assistantId = AGENTS_CONFIG[agent_type];
      if (!phone || !assistantId || !VAPI_API_KEY) { results.push({ phone, success: false, error: 'missing config' }); continue; }
      try {
        const context = await buildCallerContext(phone);
        const payload = { assistantId, customer: { number: phone }, assistantOverrides: { variableValues: { lead_name: context.lead_name, complex_city: metadata.city || '', available_slots: slotsText }, metadata: { agent_type, lead_id: lead_id || context.lead_id } } };
        if (process.env.VAPI_PHONE_NUMBER_ID) payload.phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
        const r = await fetch('https://api.vapi.ai/call/phone', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${VAPI_API_KEY}` }, body: JSON.stringify(payload) });
        const d = await r.json();
        results.push(r.ok ? { phone, success: true, call_id: d.id } : { phone, success: false, error: d.message });
        await new Promise(r => setTimeout(r, 500));
      } catch (err) { results.push({ phone, success: false, error: err.message }); }
    }
    const succeeded = results.filter(r => r.success).length;
    res.json({ success: true, total: calls.length, succeeded, failed: calls.length - succeeded, results });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Webhook ──────────────────────────────────────────────────────────────────

router.post('/webhook', async (req, res) => {
  res.json({ received: true });
  const { type, call } = req.body;
  if (!call) return;
  try {
    if (type === 'call-ended') {
      const duration = call.endedAt && call.startedAt
        ? Math.round((new Date(call.endedAt) - new Date(call.startedAt)) / 1000) : null;
      await pool.query(
        `INSERT INTO vapi_calls (call_id, phone, agent_type, status, duration_seconds, summary, metadata, created_at, updated_at)
         VALUES ($1,$2,$3,'completed',$4,$5,$6,NOW(),NOW())
         ON CONFLICT (call_id) DO UPDATE SET status='completed',duration_seconds=$4,summary=$5,updated_at=NOW()`,
        [call.id, call.customer?.number || 'unknown', call.metadata?.agent_type || 'unknown', duration, call.summary || '', JSON.stringify({ endedReason: call.endedReason })]
      ).catch(() => {});
      logger.info(`[VAPI] call-ended: ${call.id} | ${duration}s | ${call.endedReason}`);
    }
  } catch (err) { logger.error('[VAPI] Webhook error:', err.message); }
});

router.get('/calls', async (req, res) => {
  try {
    const { agent_type, status, limit = 50, offset = 0 } = req.query;
    let where = [], params = [], p = 1;
    if (agent_type) { where.push(`agent_type = $${p++}`); params.push(agent_type); }
    if (status) { where.push(`status = $${p++}`); params.push(status); }
    const wc = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const result = await pool.query(`SELECT * FROM vapi_calls ${wc} ORDER BY created_at DESC LIMIT $${p++} OFFSET $${p++}`, [...params, parseInt(limit), parseInt(offset)]);
    const cnt = await pool.query(`SELECT COUNT(*) FROM vapi_calls ${wc}`, params);
    res.json({ success: true, total: parseInt(cnt.rows[0].count), calls: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/stats', async (req, res) => {
  try {
    const result = await pool.query(`SELECT agent_type, COUNT(*) as total, COUNT(*) FILTER (WHERE status='completed') as completed, ROUND(AVG(duration_seconds) FILTER (WHERE duration_seconds IS NOT NULL)) as avg_duration FROM vapi_calls WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY agent_type ORDER BY total DESC`);
    res.json({ success: true, stats: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
