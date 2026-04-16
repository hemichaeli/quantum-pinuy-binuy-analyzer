/**
 * VAPI Call Routes v8
 *
 * Simplified flow:
 * 1. Ask if property is brokered
 * 2. YES → thank + hang up
 * 3. NO → scheduleCallback → email to hemi + add lead to DB + alert
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');
const axios = require('axios');

const HEMI_CALENDAR_ID = process.env.HEMI_CALENDAR_ID || 'primary';
const TZ = 'Asia/Jerusalem';
const HEMI_EMAIL = process.env.PERSONAL_EMAIL || 'hemi.michaeli@gmail.com';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'QUANTUM Real Estate <alerts@u-r-quantum.com>';

// ── Extract args from VAPI body (any format) ──────────────────────────────────
function extractArgs(body) {
  try {
    const toolCalls = body?.message?.toolCallList || body?.message?.toolCalls || [];
    if (toolCalls.length > 0) {
      const raw = toolCalls[0]?.function?.arguments;
      if (raw) return typeof raw === 'string' ? JSON.parse(raw) : raw;
    }
    const raw2 = body?.function?.arguments;
    if (raw2) return typeof raw2 === 'string' ? JSON.parse(raw2) : raw2;
  } catch (e) {}
  const { message, service, ...rest } = body || {};
  return Object.keys(rest).length ? rest : {};
}

function extractFunctionName(body) {
  try {
    const toolCalls = body?.message?.toolCallList || body?.message?.toolCalls || [];
    if (toolCalls.length > 0) return toolCalls[0]?.function?.name;
    if (body?.function?.name) return body.function.name;
  } catch (e) {}
  return null;
}

function extractCallPhone(body) {
  try {
    const num = body?.message?.call?.customer?.number || body?.call?.customer?.number;
    if (num) return num.replace(/^\+972/, '0').replace(/\D/g, '');
  } catch (e) {}
  return null;
}

// ── Send email via Resend ─────────────────────────────────────────────────────
async function sendEmail(subject, html) {
  if (!RESEND_API_KEY) return { sent: false, error: 'no key' };
  try {
    const res = await axios.post('https://api.resend.com/emails', {
      from: EMAIL_FROM,
      to: [HEMI_EMAIL],
      subject,
      html
    }, {
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 10000
    });
    return { sent: !!res.data?.id, id: res.data?.id };
  } catch (e) {
    logger.warn('[VapiCall] Email error:', e.message);
    return { sent: false, error: e.message };
  }
}

// ── Add lead to DB + send alert ───────────────────────────────────────────────
async function addLead(phone, source = 'vapi_hila_call') {
  try {
    await pool.query(`
      INSERT INTO listings (phone, source, source_listing_id, is_active, message_status, created_at, updated_at)
      VALUES ($1, $2, $3, true, 'new_lead', NOW(), NOW())
      ON CONFLICT DO NOTHING
    `, [phone, source, `${source}_${phone}_${Date.now()}`]);
    logger.info(`[VapiCall] Lead added: ${phone}`);
  } catch (e) {
    logger.warn('[VapiCall] addLead error:', e.message);
  }
}

// ── Handle scheduleCallback (now: non-brokered seller) ───────────────────────
async function handleScheduleCallback(args, callPhone) {
  const phone = args.phone || callPhone || '';
  const normalizedPhone = phone.replace(/^\+972/, '0').replace(/\D/g, '');
  const callbackDay = args.callback_day || args.callbackDay || 'בקרוב';
  const callbackTime = args.callback_time || args.callbackTime || '';
  const timeDesc = [callbackDay, callbackTime].filter(Boolean).join(' ');

  logger.info(`[VapiCall] Non-brokered lead: ${normalizedPhone} | callback: ${timeDesc}`);

  // 1. Add to DB as lead
  await addLead(normalizedPhone);

  // 2. Record in quantum_events
  try {
    await pool.query(
      `INSERT INTO quantum_events (title, event_type, event_date, notes, status, created_at)
       VALUES ($1, 'ליד_חדש', NOW(), $2, 'confirmed', NOW())`,
      [`ליד חדש — ${normalizedPhone}`, `מקור: שיחת הילה | לא מתווך | חזרה: ${timeDesc}`]
    );
  } catch (e) {}

  // 3. Send email alert to hemi
  const now = new Date().toLocaleString('he-IL', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const emailHtml = `
    <div dir="rtl" style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto; background:#1e2128; color:#e8eaf0; padding:24px; border-radius:10px;">
      <div style="font-size:11px; color:#4ecdc4; letter-spacing:3px; text-transform:uppercase; margin-bottom:8px;">QUANTUM ANALYZER</div>
      <h2 style="color:#4ecdc4; margin:0 0 16px;">🔔 ליד חדש — לא מתווך</h2>
      <table style="width:100%; border-collapse:collapse;">
        <tr><td style="padding:8px; color:#9aa0b0;">טלפון:</td><td style="padding:8px; color:#e8eaf0; font-weight:700;">${normalizedPhone}</td></tr>
        <tr><td style="padding:8px; color:#9aa0b0;">זמן השיחה:</td><td style="padding:8px; color:#e8eaf0;">${now}</td></tr>
        <tr><td style="padding:8px; color:#9aa0b0;">מקור:</td><td style="padding:8px; color:#e8eaf0;">שיחת הילה VAPI</td></tr>
        <tr><td style="padding:8px; color:#9aa0b0;">סטטוס:</td><td style="padding:8px; color:#4ade80; font-weight:700;">לא מתווך — מוכן לשיחה</td></tr>
      </table>
      <div style="margin-top:20px; padding:12px; background:#2a2d35; border-radius:8px; color:#9aa0b0; font-size:13px;">
        הלקוח ענה שהנכס אינו מטופל על ידי מתווך.<br>
        המנהל הובטח ליצור קשר בקרוב.
      </div>
    </div>
  `;
  const emailResult = await sendEmail(`🔔 [QUANTUM] ליד חדש — ${normalizedPhone}`, emailHtml);
  logger.info(`[VapiCall] Email sent: ${JSON.stringify(emailResult)}`);

  return {
    success: true,
    message: 'הליד נרשם. המנהל ייצור קשר בקרוב.'
  };
}

// ── Unified tool endpoint ─────────────────────────────────────────────────────
router.post('/tool', async (req, res) => {
  const body = req.body;
  const fnName = extractFunctionName(body);
  const args = extractArgs(body);
  const callPhone = extractCallPhone(body);

  logger.info(`[VapiCall] tool: ${fnName} | phone: ${callPhone} | args: ${JSON.stringify(args)}`);

  try {
    let result;
    if (fnName === 'scheduleCallback' || !fnName) {
      result = await handleScheduleCallback(args, callPhone);
    } else {
      result = { error: `Unknown: ${fnName}` };
    }
    res.json(result);
  } catch (err) {
    logger.error(`[VapiCall] tool error:`, err.message);
    res.json({ error: err.message });
  }
});

// ── Individual routes (kept for backwards compat) ─────────────────────────────
router.post('/schedule-callback', async (req, res) => {
  try { res.json(await handleScheduleCallback(req.body, null)); }
  catch (err) { res.json({ error: err.message }); }
});

router.post('/webhook', (req, res) => {
  res.json({ received: true });
  try { logger.info(`[VapiCall] Webhook: ${req.body?.message?.type}`); } catch (e) {}
});

// ── Keep slots/book for future use ────────────────────────────────────────────
router.get('/slots', (req, res) => res.json({ slots: [], message: 'Scheduling temporarily disabled' }));
router.post('/slots', (req, res) => res.json({ slots: [], message: 'Scheduling temporarily disabled' }));
router.post('/book', (req, res) => res.json({ success: false, message: 'Scheduling temporarily disabled' }));

module.exports = router;
