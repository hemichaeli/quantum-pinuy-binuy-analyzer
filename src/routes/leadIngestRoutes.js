/**
 * Lead Ingest + Match Engine Routes (Day 4-5, 2026-04-28)
 *
 * Mounted at /api so paths are:
 *   POST /api/leads-ingest         -- Supabase webhook entry (shared-secret auth)
 *   POST /api/leads/:id/match      -- operator-triggered re-match
 *   GET  /api/leads/:id/matches    -- read top-N matches for a lead
 *   PATCH /api/lead-matches/:id    -- update match operator_status
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');
const matchEngine = require('../services/matchEngine');

/**
 * Verify webhook secret. Fail closed: if SUPABASE_WEBHOOK_SECRET is unset
 * the endpoint refuses all requests.
 */
function verifyWebhookSecret(req, res) {
  const expected = process.env.SUPABASE_WEBHOOK_SECRET;
  if (!expected) {
    res.status(503).json({ error: 'webhook secret not configured on server' });
    return false;
  }
  const provided = req.headers['x-webhook-secret'];
  if (!provided || provided !== expected) {
    res.status(401).json({ error: 'invalid or missing X-Webhook-Secret header' });
    return false;
  }
  return true;
}

/**
 * POST /api/leads-ingest
 * Body shape (from u-r-quantum.com Supabase Edge Function):
 *   {
 *     external_id: 'supabase-row-uuid',  // optional; used for idempotency
 *     name, email, phone,
 *     user_type: 'investor' | 'owner' | 'contact',
 *     form_data: { budget, areas, horizon, ... } | { addresses, ... },
 *     source, campaign_tag, utm_source, utm_campaign
 *   }
 */
router.post('/leads-ingest', async (req, res) => {
  if (!verifyWebhookSecret(req, res)) return;

  const b = req.body || {};
  if (!b.name || !b.phone) {
    return res.status(400).json({ error: 'name and phone required' });
  }

  try {
    // Insert into website_leads. Idempotency via (email, phone) match.
    let leadId;
    if (b.email && b.phone) {
      const existing = await pool.query(
        `SELECT id FROM website_leads WHERE email = $1 AND phone = $2 ORDER BY id DESC LIMIT 1`,
        [b.email, b.phone]
      );
      if (existing.rows[0]) {
        leadId = existing.rows[0].id;
        // Refresh form_data on re-submission so newer answers win.
        await pool.query(
          `UPDATE website_leads
              SET form_data = $1::jsonb,
                  updated_at = NOW(),
                  campaign_tag = COALESCE($2, campaign_tag),
                  utm_source = COALESCE($3, utm_source),
                  utm_campaign = COALESCE($4, utm_campaign)
            WHERE id = $5`,
          [JSON.stringify(b.form_data || {}), b.campaign_tag || null, b.utm_source || null, b.utm_campaign || null, leadId]
        );
      }
    }

    if (!leadId) {
      const ins = await pool.query(`
        INSERT INTO website_leads
          (name, email, phone, phone_verified, user_type, form_data, mailing_list_consent, is_urgent, source, campaign_tag, utm_source, utm_campaign)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12)
        RETURNING id
      `, [
        b.name, b.email || '', b.phone, !!b.phone_verified,
        b.user_type || 'investor', JSON.stringify(b.form_data || {}),
        !!b.mailing_list_consent, false,
        b.source || 'u-r-quantum',
        b.campaign_tag || null, b.utm_source || null, b.utm_campaign || null
      ]);
      leadId = ins.rows[0].id;
      logger.info('[leadsIngest] new lead', { lead_id: leadId, user_type: b.user_type, source: b.source });
    } else {
      logger.info('[leadsIngest] lead refreshed', { lead_id: leadId });
    }

    // Respond fast; run match in background.
    res.status(202).json({ ok: true, lead_id: leadId, matching: 'in_background' });

    setImmediate(async () => {
      try {
        const result = await matchEngine.matchLead(leadId);
        logger.info('[leadsIngest] match result', result);
      } catch (e) {
        logger.error('[leadsIngest] match failed', { lead_id: leadId, error: e.message });
      }
    });
  } catch (err) {
    logger.error('[leadsIngest] insert failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/leads/:id/match
 * Operator-triggered re-match (e.g., after fixing form_data or after the
 * inventory got new listings). Synchronous so the operator sees the outcome.
 */
router.post('/leads/:id/match', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'invalid lead id' });
  }
  try {
    const result = await matchEngine.matchLead(id);
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error('[leads/match] failed', { lead_id: id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/leads/:id/matches
 * Read top-N scored matches for a lead (default 10, max 50).
 */
router.get('/leads/:id/matches', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'invalid lead id' });
  }
  try {
    const rows = await matchEngine.getMatchesForLead(id, parseInt(req.query.limit) || 10);
    res.json({ lead_id: id, matches: rows, total: rows.length });
  } catch (err) {
    logger.error('[leads/matches] failed', { lead_id: id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/lead-matches/:id
 * Body: { status: 'contacted' | 'sent' | 'dismissed' | 'won' | 'lost' | 'pending', notes?: string }
 * Operator updates a match's operator_status.
 */
router.patch('/lead-matches/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'invalid match id' });
  }
  try {
    const updated = await matchEngine.updateMatchStatus(id, req.body?.status, req.body?.notes);
    if (!updated) return res.status(404).json({ error: 'match not found' });
    res.json({ ok: true, match: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
