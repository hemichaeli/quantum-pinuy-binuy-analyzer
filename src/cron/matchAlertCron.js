/**
 * Match Alert Cron (Day 8.5).
 *
 * Sends an operator WhatsApp alert when a high-score lead_match is created.
 * Threshold defaults to 80 (configurable via MATCH_ALERT_MIN_SCORE).
 *
 * De-duplication: sends only for matches that don't yet have outcome_notes
 * marked 'alerted' (we co-opt outcome_notes column to track).
 *
 * Schedule: registered in src/index.js, every 10 minutes.
 */
const pool = require('../db/pool');
const { logger } = require('../services/logger');

const MIN_SCORE = parseFloat(process.env.MATCH_ALERT_MIN_SCORE || '80');
const MAX_PER_RUN = parseInt(process.env.MATCH_ALERT_MAX_PER_RUN || '5', 10);

let _running = false;

function fmtIls(n) {
  if (n == null) return '-';
  return new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(n);
}

async function runMatchAlerts() {
  if (_running) return { skipped: 'already_running' };
  _running = true;

  try {
    const { rows: matches } = await pool.query(`
      SELECT
        m.id, m.lead_id, m.listing_id, m.score, m.created_at,
        wl.name AS lead_name, wl.email AS lead_email, wl.phone AS lead_phone,
        l.address, l.city, l.asking_price, l.url AS listing_url,
        c.name AS complex_name, c.iai_score, c.enhanced_ssi_score
      FROM lead_matches m
      LEFT JOIN website_leads wl ON wl.id = m.lead_id
      LEFT JOIN listings l ON l.id = m.listing_id
      LEFT JOIN complexes c ON c.id = l.complex_id
      WHERE m.score >= $1
        AND m.created_at > NOW() - INTERVAL '24 hours'
        AND (m.outcome_notes IS NULL OR m.outcome_notes NOT LIKE '%alerted=1%')
      ORDER BY m.score DESC
      LIMIT $2
    `, [MIN_SCORE, MAX_PER_RUN]);

    if (matches.length === 0) {
      return { ok: true, sent: 0, reason: 'no_pending' };
    }

    const operatorPhone = process.env.OPERATOR_WHATSAPP_PHONE
      || process.env.QUANTUM_OPERATOR_PHONE
      || '';

    if (!operatorPhone) {
      logger.info(`[MatchAlert] Found ${matches.length} matches but no OPERATOR_WHATSAPP_PHONE; marking alerted in log_only mode`);
      for (const m of matches) {
        await pool.query(
          `UPDATE lead_matches SET outcome_notes = COALESCE(outcome_notes,'') || ' alerted=1(log_only) ' WHERE id = $1`,
          [m.id]
        );
      }
      return { ok: true, mode: 'log_only', count: matches.length };
    }

    const inforu = require('../services/inforuService');
    let sent = 0;

    for (const m of matches) {
      const msg = [
        `התאמה חמה (${Math.round(parseFloat(m.score))})`,
        '',
        `ליד: ${m.lead_name || '-'} | ${m.lead_phone || m.lead_email || '-'}`,
        `דירה: ${m.address || '-'}, ${m.city || '-'} | ${fmtIls(m.asking_price)}`,
        `מתחם: ${m.complex_name || '-'} (IAI ${m.iai_score || '-'} / SSI ${m.enhanced_ssi_score || '-'})`,
        m.listing_url ? m.listing_url : '',
      ].filter(Boolean).join('\n');

      try {
        await inforu.sendMessage(operatorPhone, msg, {
          preferWhatsApp: true, customerParameter: 'QUANTUM_MATCH_ALERT',
        });
        await pool.query(
          `UPDATE lead_matches SET outcome_notes = COALESCE(outcome_notes,'') || ' alerted=1 ' WHERE id = $1`,
          [m.id]
        );
        sent++;
      } catch (e) {
        logger.warn('[MatchAlert] Send failed for match', { id: m.id, error: e.message });
      }
    }

    return { ok: true, mode: 'sent', count: matches.length, sent };
  } catch (e) {
    logger.error('[MatchAlert] Run failed:', e.message);
    return { ok: false, error: e.message };
  } finally {
    _running = false;
  }
}

module.exports = { runMatchAlerts };
