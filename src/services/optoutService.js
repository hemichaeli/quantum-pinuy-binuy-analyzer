/**
 * Opt-out Service (Day 8.5).
 *
 * Records phones that asked to stop receiving QUANTUM WhatsApp outreach,
 * and provides a fast check for the bulk-outreach cron + incoming-WA cron.
 *
 * Compliance: Meta Marketing templates require honoring opt-out requests.
 */
const pool = require('../db/pool');
const { logger } = require('./logger');

// Hebrew + English keywords. We match on the trimmed body (case-insensitive).
const OPTOUT_KEYWORDS = [
  'הסר', 'הסירו', 'תפסיקו', 'תפסיק', 'תורידו', 'אנא הסירו אותי',
  'stop', 'unsubscribe', 'remove me', 'no thanks',
];

function matchOptoutKeyword(text) {
  if (!text) return null;
  const t = text.trim().toLowerCase();
  for (const kw of OPTOUT_KEYWORDS) {
    const k = kw.toLowerCase();
    // Exact match (single-word reply) or substring with word boundary.
    if (t === k) return kw;
    if (t.length <= 30 && t.includes(k)) return kw;
  }
  return null;
}

function normalizePhone(phone) {
  if (!phone) return null;
  let p = String(phone).replace(/\D/g, '');
  if (p.startsWith('972') && p.length === 12) return '0' + p.slice(3);
  return p || null;
}

async function isOptedOut(phone) {
  const p = normalizePhone(phone);
  if (!p) return false;
  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM wa_optouts WHERE phone = $1 LIMIT 1', [p]
    );
    return rows.length > 0;
  } catch (e) {
    logger.warn('[Optout] isOptedOut check failed:', e.message);
    return false;
  }
}

async function recordOptout({ phone, source, replyText = null, listingId = null, notes = null }) {
  const p = normalizePhone(phone);
  if (!p) return { ok: false, error: 'invalid_phone' };
  try {
    await pool.query(
      `INSERT INTO wa_optouts (phone, source, reply_text, listing_id, notes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (phone) DO UPDATE SET
         opted_out_at = NOW(),
         source       = EXCLUDED.source,
         reply_text   = EXCLUDED.reply_text,
         notes        = EXCLUDED.notes`,
      [p, source, replyText, listingId, notes]
    );
    logger.info(`[Optout] Recorded ${p} via ${source}`);
    return { ok: true };
  } catch (e) {
    logger.error('[Optout] Insert failed:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { matchOptoutKeyword, isOptedOut, recordOptout, OPTOUT_KEYWORDS };
