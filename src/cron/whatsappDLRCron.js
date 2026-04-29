/**
 * WhatsApp Delivery Receipt (DLR) Cron — Day 10.
 *
 * Polls INFORU's DeliveryNotificationWhatsapp pull endpoint every 60s and
 * updates per-message status: sent → delivered → read (or failed).
 *
 * INFORU echoes back our CustomerMessageId for each delivery report, so we
 * match each DLR to the row in sent_messages and unified_messages by
 * external_id.
 *
 * Status mapping (defensive against INFORU's mixed casing/naming):
 *   delivered / Delivered / 2     → status='delivered', delivered_at=now
 *   read      / Read       / 3    → status='read',      read_at=now
 *   sent      / Sent       / 1    → no-op (already 'sent')
 *   failed / undelivered / 4 / 5  → status='failed',    failed_at=now
 *   anything else                 → logged at debug, ignored
 */
const inforu = require('../services/inforuService');
const pool = require('../db/pool');
const { logger } = require('../services/logger');

let _running = false;

function classify(rawStatus) {
  if (!rawStatus && rawStatus !== 0) return null;
  const s = String(rawStatus).toLowerCase();
  if (s === 'delivered' || s === '2') return 'delivered';
  if (s === 'read'      || s === '3') return 'read';
  if (s === 'sent'      || s === '1') return 'sent';
  if (s === 'failed' || s === 'undelivered' || s === 'rejected' || s === '4' || s === '5' || s === '6') return 'failed';
  return null;
}

async function applyDlr(externalId, classified, reason) {
  if (!externalId || !classified) return { matched: 0 };

  const tsField = classified === 'delivered' ? 'delivered_at'
    : classified === 'read' ? 'read_at'
    : classified === 'failed' ? 'failed_at'
    : null;

  // sent_messages
  let r1 = { rowCount: 0 };
  try {
    r1 = await pool.query(
      tsField
        ? `UPDATE sent_messages SET status = $1, ${tsField} = NOW(), dlr_reason = COALESCE($3, dlr_reason) WHERE external_id = $2 RETURNING id`
        : `UPDATE sent_messages SET status = $1, dlr_reason = COALESCE($3, dlr_reason) WHERE external_id = $2 RETURNING id`,
      [classified, externalId, reason || null]
    );
  } catch (e) { logger.debug('[DLRCron] sent_messages update failed', { error: e.message }); }

  // unified_messages (kept in sync; some sends only touch this table)
  let r2 = { rowCount: 0 };
  try {
    r2 = await pool.query(
      tsField
        ? `UPDATE unified_messages SET status = $1, ${tsField} = NOW(), dlr_reason = COALESCE($3, dlr_reason), updated_at = NOW() WHERE external_id = $2 RETURNING id`
        : `UPDATE unified_messages SET status = $1, dlr_reason = COALESCE($3, dlr_reason), updated_at = NOW() WHERE external_id = $2 RETURNING id`,
      [classified, externalId, reason || null]
    );
  } catch (e) { logger.debug('[DLRCron] unified_messages update failed', { error: e.message }); }

  return { matched: (r1.rowCount || 0) + (r2.rowCount || 0) };
}

function pickField(obj, ...names) {
  for (const n of names) {
    if (obj[n] !== undefined && obj[n] !== null) return obj[n];
  }
  return null;
}

async function pollDlr() {
  if (_running) return { skipped: 'already_running' };
  _running = true;

  try {
    const resp = await inforu.pullWhatsAppDLR(100);
    if (!resp || resp.StatusId !== 1) return { ok: true, fetched: 0 };

    // INFORU response shape isn't fully documented; try common keys.
    const items = resp.Data?.Notifications
      || resp.Data?.Messages
      || resp.Data?.List
      || resp.Data
      || [];

    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) return { ok: true, fetched: 0 };

    let updated = 0, skipped = 0;
    for (const dlr of list) {
      const externalId = pickField(dlr,
        'CustomerMessageId', 'customerMessageId', 'customer_message_id',
        'MessageId', 'messageId'
      );
      const rawStatus = pickField(dlr,
        'Status', 'status', 'DeliveryStatus', 'deliveryStatus', 'StatusId'
      );
      const reason = pickField(dlr,
        'StatusDescription', 'statusDescription', 'Reason', 'reason'
      );

      const classified = classify(rawStatus);
      if (!externalId || !classified) {
        skipped++;
        continue;
      }

      const r = await applyDlr(externalId, classified, reason);
      if (r.matched > 0) updated++;
      else skipped++;
    }

    if (updated > 0 || skipped > 0) {
      logger.info('[DLRCron] poll complete', { fetched: list.length, updated, skipped });
    }
    return { ok: true, fetched: list.length, updated, skipped };
  } catch (err) {
    logger.warn('[DLRCron] poll failed', { error: err.message });
    return { ok: false, error: err.message };
  } finally {
    _running = false;
  }
}

module.exports = { pollDlr, classify };
