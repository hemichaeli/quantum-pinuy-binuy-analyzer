/**
 * Daily Operations Digest (Day 8.5).
 *
 * Sends a single WhatsApp summary to OPERATOR_WHATSAPP_PHONE every morning
 * at 08:00 IL: leads/scrapes/messages/hot-opps/matches counts for the past
 * 24 hours, plus current bot configuration state.
 *
 * Why: previously a stalled cron (e.g. bulkOutreachCron disabled) could go
 * unnoticed for weeks. This is the canary.
 *
 * Schedule: 0 8 * * * (registered in src/index.js)
 */

const pool = require('../db/pool');
const { logger } = require('../services/logger');

let _running = false;

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

async function buildDigest() {
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

  const lines = [
    'דוח QUANTUM יומי - 24 שעות אחרונות',
    '',
    `לידים חדשים: ${leadsNew}`,
    `דירות חדשות שאותרו: ${listingsSeen}`,
    `הודעות יוצאות: ${messagesSent}`,
    `התראות hot-opportunity: ${hotOpps}`,
    `התאמות חדשות (lead_matches): ${matchesNew}`,
    `הסרות מרשימת תפוצה: ${optoutsNew}`,
    '',
    'מצב בוט מוכרים:',
    `  enabled=${bulkEnabled} template=${bulkTemplate || '-'} phone=${agentPhone || '-'}`,
  ];

  return lines.join('\n');
}

async function runDailyDigest() {
  if (_running) return { skipped: 'already_running' };
  _running = true;
  try {
    const operatorPhone = process.env.OPERATOR_WHATSAPP_PHONE
      || process.env.QUANTUM_OPERATOR_PHONE
      || '';
    const digest = await buildDigest();

    if (!operatorPhone) {
      logger.info('[DailyDigest] OPERATOR_WHATSAPP_PHONE not set; logging only');
      logger.info('[DailyDigest]\n' + digest);
      return { ok: true, mode: 'log_only', digest };
    }

    const inforu = require('../services/inforuService');
    const result = await inforu.sendMessage(operatorPhone, digest, {
      preferWhatsApp: true, customerParameter: 'QUANTUM_DAILY_DIGEST',
    });
    logger.info('[DailyDigest] Sent to operator', { phone: operatorPhone, status: result?.status });
    return { ok: true, mode: 'sent', digest };
  } catch (e) {
    logger.error('[DailyDigest] Failed:', e.message);
    return { ok: false, error: e.message };
  } finally {
    _running = false;
  }
}

module.exports = { runDailyDigest, buildDigest };
