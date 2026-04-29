/**
 * Daily Operations Digest (Day 8.5).
 *
 * Sends a single email summary every morning at 08:00 IL: counts of
 * leads/scrapes/messages/hot-opps/matches/optouts for the past 24 hours,
 * plus current bot configuration state.
 *
 * Why: previously a stalled cron (e.g. bulkOutreachCron disabled) could go
 * unnoticed for weeks. This is the canary.
 *
 * Why email (not WhatsApp): per operator preference (2026-04-29). Email is
 * also lower cost (no INFORU/Meta usage) and survives easier in inbox.
 *
 * Schedule: 0 8 * * * (registered in src/index.js)
 */

const pool = require('../db/pool');
const { logger } = require('../services/logger');
const axios = require('axios');

let _running = false;

const PERSONAL_EMAIL = process.env.PERSONAL_EMAIL || 'hemi.michaeli@gmail.com';
const OFFICE_EMAIL   = process.env.OFFICE_EMAIL   || 'office@u-r-quantum.com';
const RECIPIENTS     = [PERSONAL_EMAIL, OFFICE_EMAIL].filter(Boolean);
const FROM_ADDRESS   = process.env.EMAIL_FROM || 'QUANTUM Real Estate <alerts@u-r-quantum.com>';
const DASHBOARD_URL  = process.env.DASHBOARD_URL
  || 'https://pinuy-binuy-analyzer-production.up.railway.app/dashboard';

async function safeCount(sql, params = []) {
  try {
    const { rows } = await pool.query(sql, params);
    return parseInt(rows[0]?.c || 0, 10);
  } catch (e) {
    return -1; // sentinel = query failed (table missing etc.)
  }
}

async function getSetting(key, defaultValue = '') {
  try {
    const { rows } = await pool.query(
      'SELECT value FROM system_settings WHERE key = $1', [key]
    );
    return rows.length > 0 ? rows[0].value : defaultValue;
  } catch (e) { return defaultValue; }
}

async function buildDigestData() {
  const since = "NOW() - INTERVAL '24 hours'";
  const [
    leadsNew, listingsSeen, messagesSent, hotOpps,
    matchesNew, optoutsNew,
  ] = await Promise.all([
    safeCount(`SELECT COUNT(*) AS c FROM website_leads WHERE created_at > ${since}`),
    safeCount(`SELECT COUNT(*) AS c FROM listings WHERE first_seen > ${since}`),
    safeCount(`SELECT COUNT(*) AS c FROM listings WHERE last_message_sent_at > ${since}`),
    safeCount(`SELECT COUNT(*) AS c FROM hot_opportunity_alerts WHERE created_at > ${since}`),
    safeCount(`SELECT COUNT(*) AS c FROM lead_matches WHERE created_at > ${since}`),
    safeCount(`SELECT COUNT(*) AS c FROM wa_optouts WHERE opted_out_at > ${since}`),
  ]);

  const [bulkEnabled, bulkTemplate, agentPhone] = await Promise.all([
    getSetting('bulk_outreach_enabled', 'false'),
    getSetting('bulk_outreach_template_id', ''),
    getSetting('agent_phone', ''),
  ]);

  return {
    leadsNew, listingsSeen, messagesSent, hotOpps, matchesNew, optoutsNew,
    bulkEnabled, bulkTemplate, agentPhone,
  };
}

function buildEmailHtml(d) {
  const row = (label, value, link) => `
    <tr style="border-bottom:1px solid #3a3f4a;">
      <td style="padding:10px 14px; color:#e8eaf0;">${label}</td>
      <td style="padding:10px 14px; text-align:left; color:#4ecdc4; font-weight:700; font-size:18px;">
        ${link ? `<a href="${link}" style="color:#4ecdc4; text-decoration:none;">${value}</a>` : value}
      </td>
    </tr>`;

  const today = new Date().toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });

  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head><meta charset="utf-8"><title>QUANTUM Daily Digest</title></head>
<body style="margin:0; padding:24px; background:#1a1d23; font-family:Arial,sans-serif; color:#e8eaf0;">
  <div style="max-width:560px; margin:0 auto; background:#22252e; border-radius:8px; overflow:hidden;">
    <div style="padding:18px 22px; background:#2a2d35; border-bottom:1px solid #3a3f4a;">
      <h2 style="margin:0; color:#4ecdc4; font-size:18px;">QUANTUM | דוח יומי</h2>
      <div style="color:#9aa0b0; font-size:12px; margin-top:4px;">${today} - 24 שעות אחרונות</div>
    </div>
    <table style="width:100%; border-collapse:collapse;">
      ${row('לידים חדשים', d.leadsNew, `${DASHBOARD_URL}#leads`)}
      ${row('דירות חדשות שאותרו', d.listingsSeen, `${DASHBOARD_URL}#ads`)}
      ${row('הודעות יוצאות', d.messagesSent, `${DASHBOARD_URL}#messages`)}
      ${row('התראות hot-opportunity', d.hotOpps)}
      ${row('התאמות חדשות (Match Engine)', d.matchesNew)}
      ${row('הסרות מרשימת תפוצה', d.optoutsNew)}
    </table>
    <div style="padding:14px 22px; background:#2a2d35; border-top:1px solid #3a3f4a;">
      <div style="color:#9aa0b0; font-size:12px; margin-bottom:6px;">מצב בוט מוכרים:</div>
      <div style="font-size:13px; color:#e8eaf0;">
        enabled=<b style="color:${d.bulkEnabled === 'true' ? '#4ade80' : '#e57373'};">${d.bulkEnabled}</b>
        | template=<b>${d.bulkTemplate || '-'}</b>
        | phone=<b>${d.agentPhone || '-'}</b>
      </div>
    </div>
    <div style="padding:14px 22px; background:#1a1d23; text-align:center;">
      <a href="${DASHBOARD_URL}" style="color:#4ecdc4; text-decoration:none; font-weight:600;">פתח דשבורד &raquo;</a>
    </div>
  </div>
</body></html>`;
}

async function sendDigestEmail(html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, error: 'RESEND_API_KEY not set' };
  const today = new Date().toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });

  try {
    const response = await axios.post('https://api.resend.com/emails', {
      from: FROM_ADDRESS,
      to: RECIPIENTS,
      subject: `QUANTUM | דוח יומי - ${today}`,
      html,
    }, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    if (response.data?.id) {
      return { sent: true, id: response.data.id, count: RECIPIENTS.length };
    }
    return { sent: false, error: JSON.stringify(response.data) };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

async function runDailyDigest() {
  if (_running) return { skipped: 'already_running' };
  _running = true;
  try {
    const data = await buildDigestData();
    const html = buildEmailHtml(data);
    const result = await sendDigestEmail(html);

    if (result.sent) {
      logger.info('[DailyDigest] Email sent', { id: result.id, recipients: RECIPIENTS });
      return { ok: true, mode: 'email', id: result.id, data };
    } else {
      logger.warn('[DailyDigest] Email send failed; logging digest', { error: result.error });
      logger.info(`[DailyDigest] data=${JSON.stringify(data)}`);
      return { ok: false, error: result.error, data };
    }
  } catch (e) {
    logger.error('[DailyDigest] Failed:', e.message);
    return { ok: false, error: e.message };
  } finally {
    _running = false;
  }
}

module.exports = { runDailyDigest, buildDigestData };
