/**
 * QUANTUM Outreach Escalation Cron
 *
 * Checks every 30 minutes for listings where:
 * - A message was sent (WhatsApp/yad2_chat/leave_details)
 * - More than 5 hours (configurable) have passed since sending
 * - No response has been received
 * - No VAPI call has been made yet
 *
 * For those listings, triggers a VAPI call using vapiCampaignService.
 *
 * Schedule: */30 * * * * (set in src/index.js)
 */

const pool = require('../db/pool');
const { placeVapiCall } = require('../services/vapiCampaignService');
const { logger } = require('../services/logger');

let _running = false;

// ─── Config ──────────────────────────────────────────────────────────────────

async function isEnabled() {
  try {
    const { rows } = await pool.query(
      "SELECT value FROM system_settings WHERE key = 'outreach_escalation_enabled'"
    );
    return rows.length > 0 && rows[0].value === 'true';
  } catch (e) { return false; }
}

async function getEscalationMinutes() {
  try {
    const { rows } = await pool.query(
      "SELECT value FROM system_settings WHERE key = 'wa_bot_escalation_minutes'"
    );
    if (rows.length) {
      const val = parseInt(rows[0].value, 10);
      return isNaN(val) ? 300 : val;
    }
  } catch (e) {}
  return 300; // default 5 hours = 300 minutes
}

// ─── Main Tick ───────────────────────────────────────────────────────────────

async function runOutreachEscalation() {
  if (_running) {
    logger.info('[OutreachEscalation] Previous run still active, skipping');
    return { skipped: true };
  }
  _running = true;

  try {
    // Check if enabled
    const enabled = await isEnabled();
    if (!enabled) {
      return { disabled: true };
    }

    // Check VAPI config
    const apiKey = process.env.VAPI_API_KEY;
    const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
    if (!apiKey || !phoneNumberId) {
      logger.warn('[OutreachEscalation] VAPI not configured, skipping');
      return { skipped: true, reason: 'VAPI not configured' };
    }

    const waitMinutes = await getEscalationMinutes();
    if (waitMinutes === 0) return { disabled: true };

    // Find listings where:
    // 1. An outgoing message was sent (via unified_messages)
    // 2. More than waitMinutes ago
    // 3. No incoming reply exists
    // 4. No VAPI call has been placed
    const { rows: overdueListings } = await pool.query(`
      WITH sent_messages AS (
        SELECT DISTINCT ON (listing_id)
          listing_id,
          contact_phone,
          channel,
          created_at AS sent_at
        FROM unified_messages
        WHERE direction = 'outgoing'
          AND channel IN ('whatsapp', 'yad2_chat', 'leave_details', 'sms', 'komo_chat')
          AND created_at < NOW() - ($1::int * INTERVAL '1 minute')
          AND created_at > NOW() - INTERVAL '7 days'
        ORDER BY listing_id, created_at DESC
      ),
      has_reply AS (
        SELECT DISTINCT listing_id
        FROM unified_messages
        WHERE direction = 'incoming'
          AND created_at > NOW() - INTERVAL '7 days'
      ),
      has_call AS (
        SELECT DISTINCT listing_id
        FROM unified_messages
        WHERE channel = 'vapi_call'
          AND created_at > NOW() - INTERVAL '7 days'
      )
      SELECT sm.listing_id, sm.contact_phone, sm.channel, sm.sent_at,
             l.address, l.city, l.contact_name, l.phone
      FROM sent_messages sm
      JOIN listings l ON l.id = sm.listing_id
      LEFT JOIN has_reply hr ON hr.listing_id = sm.listing_id
      LEFT JOIN has_call hc ON hc.listing_id = sm.listing_id
      WHERE hr.listing_id IS NULL
        AND hc.listing_id IS NULL
        AND l.is_active = TRUE
        AND (l.deal_status IS NULL OR l.deal_status NOT IN ('סגור', 'לא רלוונטי', 'closed'))
      ORDER BY sm.sent_at ASC
      LIMIT 10
    `, [waitMinutes]);

    if (!overdueListings.length) {
      return { processed: 0 };
    }

    logger.info(`[OutreachEscalation] Found ${overdueListings.length} listings needing call escalation`);

    let called = 0, errors = 0;

    for (const listing of overdueListings) {
      try {
        const phone = listing.contact_phone || listing.phone;
        if (!phone) {
          logger.warn(`[OutreachEscalation] No phone for listing #${listing.listing_id}, skipping`);
          continue;
        }

        const { callId, status } = await placeVapiCall({
          phone,
          leadName: listing.contact_name || '',
          leadCity: listing.city || '',
          scriptType: 'seller',
          campaignLeadId: null,
          campaignId: null
        });

        // Log escalation to unified_messages
        try {
          await pool.query(`
            INSERT INTO unified_messages (
              listing_id, complex_id, contact_phone, direction, channel, platform,
              message_text, status, metadata
            ) VALUES (
              $1, NULL, $2, 'outgoing', 'vapi_call', 'vapi',
              $3, 'sent',
              $4::jsonb
            )
          `, [
            listing.listing_id,
            phone,
            `שיחת VAPI אוטומטית — הסלמה אחרי ${waitMinutes} דקות ללא מענה`,
            JSON.stringify({ call_id: callId, call_status: status, original_channel: listing.channel, sent_at: listing.sent_at, escalation_source: 'outreach_escalation' })
          ]);
        } catch (logErr) {
          logger.warn(`[OutreachEscalation] Failed to log to unified_messages: ${logErr.message}`);
        }

        // Update listing
        try {
          await pool.query(`
            UPDATE listings SET call_scheduled_at = NOW(), updated_at = NOW() WHERE id = $1
          `, [listing.listing_id]);
        } catch (e) {}

        logger.info(`[OutreachEscalation] VAPI call placed for listing #${listing.listing_id} (${phone}), callId=${callId}`);
        called++;

        // Rate limit: wait 1 second between calls
        await new Promise(r => setTimeout(r, 1000));

      } catch (err) {
        logger.error(`[OutreachEscalation] Failed for listing #${listing.listing_id}: ${err.message}`);
        errors++;
      }
    }

    const result = { processed: overdueListings.length, called, errors };
    logger.info(`[OutreachEscalation] Done: ${JSON.stringify(result)}`);
    return result;

  } catch (err) {
    logger.error('[OutreachEscalation] Cron error:', err.message);
    return { error: err.message };
  } finally {
    _running = false;
  }
}

module.exports = { runOutreachEscalation };
