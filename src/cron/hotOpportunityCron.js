/**
 * Hot Opportunity Cron - Day 7 (2026-04-28).
 *
 * Polls listings table every 30 minutes 09-21 IL. For each listing that:
 *   - was first_seen within the last 6 hours
 *   - belongs to a complex with iai_score >= 80 AND enhanced_ssi_score >= 60
 *   - is_active = TRUE
 *   - is NOT already in hot_opportunity_alerts
 * sends a Hebrew operator WhatsApp via inforuService.sendMessage and logs
 * the attempt to hot_opportunity_alerts (UNIQUE on listing_id ensures we
 * never send twice for the same listing).
 *
 * Env: OPERATOR_WHATSAPP_PHONE (required for actual send; otherwise log_only mode).
 * Tunables: HOT_OPP_MIN_IAI, HOT_OPP_MIN_SSI, HOT_OPP_LOOKBACK_HOURS.
 */

const pool = require('../db/pool');
const { logger } = require('../services/logger');

// Defaults; overridable via env.
const MIN_IAI       = parseInt(process.env.HOT_OPP_MIN_IAI || '80', 10);
const MIN_SSI       = parseInt(process.env.HOT_OPP_MIN_SSI || '60', 10);
const LOOKBACK_HRS  = parseInt(process.env.HOT_OPP_LOOKBACK_HOURS || '6', 10);
const MAX_PER_RUN   = parseInt(process.env.HOT_OPP_MAX_PER_RUN || '5', 10);

function fmtIls(n) {
  if (!n && n !== 0) return '-';
  return new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(n);
}

function buildMessage(row) {
  const lines = [
    '🔥 הזדמנות חמה QUANTUM',
    '',
    `${row.complex_name || row.complex_addresses || 'מתחם'} · ${row.city || '-'}`,
    `IAI ${row.iai_score ?? '-'} | SSI ${row.enhanced_ssi_score ?? '-'}`,
    `שלב: ${row.plan_stage || row.complex_status || '-'}${row.developer ? ' · יזם: ' + row.developer : ''}`,
    '',
    `${row.address || row.title || 'דירה'} · ${row.rooms || '?'} חד׳ · ${row.area_sqm || '?'} מ"ר`,
    `מחיר: ${fmtIls(row.asking_price)}${row.price_per_sqm ? ' · ' + fmtIls(row.price_per_sqm) + '/מ"ר' : ''}`,
    `מקור: ${row.source || '-'}${row.contact_name ? ' · ' + row.contact_name : ''}${row.phone ? ' · ' + row.phone : ''}`,
  ];
  if (row.url) lines.push('', row.url);
  return lines.join('\n');
}

async function findHotOpportunities() {
  const r = await pool.query(`
    SELECT l.id              AS listing_id,
           l.title, l.address, l.city, l.rooms, l.area_sqm,
           l.asking_price, l.price_per_sqm, l.source, l.url,
           l.phone, l.contact_name, l.first_seen,
           c.id              AS complex_id,
           c.name            AS complex_name,
           c.addresses       AS complex_addresses,
           c.iai_score, c.enhanced_ssi_score, c.plan_stage,
           c.status          AS complex_status, c.developer
    FROM listings l
    JOIN complexes c ON c.id = l.complex_id
    WHERE l.is_active = TRUE
      AND l.first_seen >= NOW() - INTERVAL '${LOOKBACK_HRS} hours'
      AND COALESCE(c.iai_score, 0)            >= $1
      AND COALESCE(c.enhanced_ssi_score, 0)   >= $2
      AND NOT EXISTS (
        SELECT 1 FROM hot_opportunity_alerts a WHERE a.listing_id = l.id
      )
    ORDER BY c.iai_score DESC, c.enhanced_ssi_score DESC, l.first_seen DESC
    LIMIT $3
  `, [MIN_IAI, MIN_SSI, MAX_PER_RUN]);
  return r.rows;
}

async function logAlert(row, channel, status, recipient, messagePreview, error) {
  try {
    await pool.query(`
      INSERT INTO hot_opportunity_alerts
        (listing_id, complex_id, iai_score, ssi_score, channel, status, recipient, message_preview, error)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (listing_id) DO NOTHING
    `, [
      row.listing_id, row.complex_id || null,
      row.iai_score ?? null, row.enhanced_ssi_score ?? null,
      channel, status, recipient || null,
      (messagePreview || '').substring(0, 500),
      error ? String(error).substring(0, 500) : null
    ]);
  } catch (e) {
    logger.warn('[hotOppCron] failed to log alert', { listing_id: row.listing_id, error: e.message });
  }
}

async function run() {
  let inforu;
  try { inforu = require('../services/inforuService'); }
  catch (e) {
    logger.warn('[hotOppCron] inforuService not available', { error: e.message });
  }

  const operatorPhone = process.env.OPERATOR_WHATSAPP_PHONE
    || process.env.OPERATOR_PHONE
    || null;

  let opportunities;
  try { opportunities = await findHotOpportunities(); }
  catch (e) {
    logger.warn('[hotOppCron] query failed', { error: e.message });
    return { scanned: 0, sent: 0, logged: 0, error: e.message };
  }

  if (opportunities.length === 0) {
    return { scanned: 0, sent: 0, logged: 0 };
  }

  let sent = 0;
  let logged = 0;
  for (const row of opportunities) {
    const message = buildMessage(row);

    if (!operatorPhone) {
      // No phone configured: log_only so we don't keep rediscovering the same listing.
      await logAlert(row, 'log_only', 'log_only', null, message, 'OPERATOR_WHATSAPP_PHONE not set');
      logged++;
      continue;
    }

    if (!inforu || typeof inforu.sendMessage !== 'function') {
      await logAlert(row, 'log_only', 'log_only', operatorPhone, message, 'inforuService unavailable');
      logged++;
      continue;
    }

    try {
      const result = await inforu.sendMessage(operatorPhone, message, {
        preferWhatsApp: true,
        customerParameter: 'QUANTUM_HOT_OPP'
      });
      const channel = result?.channel === 'whatsapp_chat' ? 'whatsapp' : (result?.channel || 'sms');
      const status = result?.success ? 'sent' : 'failed';
      await logAlert(row, channel, status, operatorPhone, message, result?.success ? null : result?.description);
      if (result?.success) sent++;
      logged++;
    } catch (e) {
      await logAlert(row, 'whatsapp', 'failed', operatorPhone, message, e.message);
      logged++;
      logger.warn('[hotOppCron] send error', { listing_id: row.listing_id, error: e.message });
    }
  }

  logger.info('[hotOppCron] run complete', {
    scanned: opportunities.length, sent, logged, operator_configured: !!operatorPhone
  });
  return { scanned: opportunities.length, sent, logged };
}

module.exports = { run, findHotOpportunities, buildMessage, MIN_IAI, MIN_SSI, LOOKBACK_HRS };
