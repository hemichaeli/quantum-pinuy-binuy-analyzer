/**
 * Positive-reply detection for QUANTUM cold outreach.
 *
 * Context: the seller_outreach_v1 WhatsApp template offers two quick-reply
 * buttons — "כן, אשמח לשמוע" and "אנא הסירו אותי". When the recipient taps
 * the positive button, InforU delivers the button label as a regular text
 * message ("כן, אשמח לשמוע"). Without intent recognition, this would fall
 * through to botEngine which currently logs "No campaign for phone X" and
 * does nothing — silent void for the interested lead.
 *
 * This service mirrors optoutService: a keyword matcher + a recorder. On
 * match, the listing's contact_status flips to 'replied_interested' so the
 * operator dashboard surfaces it, a one-line acknowledgement is queued back
 * to the recipient, and we drop the message before botEngine sees it.
 */
const pool = require('../db/pool');
const { logger } = require('./logger');

// Hebrew + English positive intent. Tight list; we deliberately don't match
// long free-form replies — those should go to a human, not be auto-classified.
const POSITIVE_KEYWORDS = [
  'כן, אשמח לשמוע',
  'כן אשמח לשמוע',
  'אשמח לשמוע',
  'אשמח',
  'כן',
  'מעוניין',
  'אני מעוניין',
  'אשמח לפרטים',
  'ספרו לי עוד',
  'אני מתעניין',
  'yes',
  'interested',
];

function matchPositiveKeyword(text) {
  if (!text) return null;
  const t = text.trim().toLowerCase();
  for (const kw of POSITIVE_KEYWORDS) {
    const k = kw.toLowerCase();
    // Exact single-word/short reply, or substring on short body.
    if (t === k) return kw;
    if (t.length <= 40 && t.includes(k)) return kw;
  }
  return null;
}

function normalizePhone(phone) {
  if (!phone) return null;
  let p = String(phone).replace(/\D/g, '');
  if (p.startsWith('972') && p.length === 12) return '0' + p.slice(3);
  return p || null;
}

/**
 * Flip the contact_status to 'replied_interested' on every active listing
 * for this phone, log the reply, and store the surface metadata so a future
 * dashboard / Cliq notifier can pick it up.
 */
async function recordPositiveReply({ phone, replyText, source = 'wa_button' }) {
  const p = normalizePhone(phone);
  if (!p) return { ok: false, error: 'invalid_phone' };
  try {
    const upd = await pool.query(
      `UPDATE listings
         SET contact_status = 'replied_interested',
             last_contact_at = NOW(),
             updated_at = NOW()
       WHERE phone = $1
         AND is_active = TRUE
         AND contact_status IN ('contacted', 'contacted_via_sibling')
       RETURNING id`,
      [p]
    );
    logger.info(`[PositiveReply] ${p}: marked ${upd.rowCount} listing(s) as replied_interested`);
    // Best-effort log into incoming feed for dashboard visibility.
    await pool.query(
      `INSERT INTO whatsapp_messages (phone, message, direction, message_type, created_at)
       VALUES ($1, $2, 'incoming', 'positive_reply', NOW())
       ON CONFLICT DO NOTHING`,
      [p, replyText || '(button reply)']
    ).catch(() => null);
    return { ok: true, listingsMarked: upd.rowCount };
  } catch (e) {
    logger.error('[PositiveReply] recordPositiveReply failed:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { matchPositiveKeyword, recordPositiveReply, POSITIVE_KEYWORDS };
