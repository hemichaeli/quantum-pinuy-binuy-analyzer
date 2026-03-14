/**
 * QUANTUM Campaign Flow Engine
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages the full lifecycle of campaign leads after Zoho sends the initial WA:
 *
 *  initial  ──(delay)──► reminder_1_sent ──(delay)──► reminder_2_sent
 *                                                           │
 *                                              (call_delay_after_wa_hours)
 *                                                           │
 *                                                    call_1_initiated
 *                                                           │
 *                                              ┌────────────┴────────────┐
 *                                         call_answered           call_1_no_answer
 *                                              │                        │
 *                                          converted           (call_retry_delay_hours)
 *                                                                       │
 *                                                              call_2_initiated
 *                                                                       │
 *                                                         ┌─────────────┴──────────────┐
 *                                                    call_answered             call_2_no_answer
 *                                                         │                            │
 *                                                     converted                    exhausted
 *
 * At any point: WA reply → 'replied' (flow paused, human takes over)
 *               Opt-out  → 'opted_out'
 *
 * All transitions are logged in campaign_flow_log.
 * Zoho status is updated at each stage.
 *
 * Runs every 5 minutes via cron in index.js.
 */

'use strict';

const pool   = require('../db/pool');
const axios  = require('axios');
const { logger } = require('../services/logger');

const INFORU_CAPI_BASE = 'https://capi.inforu.co.il/api/v2';
const VAPI_BASE        = 'https://api.vapi.ai';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getInforuAuth() {
  const u = process.env.INFORU_USERNAME;
  const p = process.env.INFORU_PASSWORD;
  if (!u || !p) throw new Error('INFORU credentials missing');
  return 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
}

function normalizePhone(phone) {
  const d = String(phone).replace(/\D/g, '');
  if (d.startsWith('972')) return '+' + d;
  if (d.startsWith('0'))   return '+972' + d.slice(1);
  return '+972' + d;
}

/**
 * Send a Meta-approved WA template by raw templateId (from Inforu).
 * params: array of string values for {{1}}, {{2}}, etc.
 */
async function sendWaTemplate(phone, templateId, params = [], leadId = null) {
  const auth = getInforuAuth();
  const templateParams = params.map((v, i) => ({
    Name: `[#${i + 1}#]`,
    Type: 'Text',
    Value: String(v)
  }));
  const payload = {
    Data: {
      TemplateId: String(templateId),
      Recipients: [{ Phone: phone }],
      ...(templateParams.length > 0 ? { TemplateParameters: templateParams } : {})
    }
  };
  const resp = await axios.post(
    `${INFORU_CAPI_BASE}/WhatsApp/SendWhatsApp`,
    payload,
    {
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      timeout: 15000,
      validateStatus: () => true
    }
  );
  const ok = resp.data?.StatusId === 1;
  logger.info(`[FlowEngine] WA template ${templateId} → ${phone}: ${ok ? 'OK' : 'FAIL'} (StatusId=${resp.data?.StatusId})`);
  return { ok, statusId: resp.data?.StatusId, description: resp.data?.StatusDescription };
}

/**
 * Place a Vapi call using campaign voice/script settings.
 */
async function placeVapiCall(phone, leadName, campaign) {
  const apiKey        = process.env.VAPI_API_KEY;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  const assistantId   = process.env.VAPI_ASSISTANT_COLD
                     || process.env.VAPI_ASSISTANT_SELLER
                     || process.env.VAPI_ASSISTANT_ID;
  if (!apiKey || !phoneNumberId || !assistantId) {
    throw new Error('Vapi credentials not configured');
  }
  const e164 = normalizePhone(phone);
  const overrides = {
    variableValues: {
      lead_name:     leadName || '',
      agent_name:    campaign.agent_name || 'רן',
      campaign_id:   String(campaign.id),
      campaign_name: campaign.name
    }
  };
  if (campaign.voice_name) {
    overrides.voice = {
      provider: campaign.voice_provider || 'vapi',
      voiceId:  campaign.voice_name
    };
  }
  if (campaign.call_script) {
    overrides.model = {
      messages: [{ role: 'system', content: campaign.call_script }]
    };
  }
  const resp = await axios.post(
    `${VAPI_BASE}/call/phone`,
    {
      phoneNumberId,
      assistantId,
      customer: { number: e164, name: leadName || 'לקוח' },
      assistantOverrides: overrides
    },
    {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 15000
    }
  );
  const callId = resp.data?.id;
  if (!callId) throw new Error('Vapi did not return call ID');
  logger.info(`[FlowEngine] Vapi call placed: ${callId} → ${e164}`);
  return callId;
}

/**
 * Update Zoho campaign contact status (fire-and-forget, non-blocking).
 */
async function syncZoho(zoho_campaign_id, zoho_contact_id, status, notes = '') {
  if (!zoho_campaign_id || !zoho_contact_id) return;
  try {
    const zoho = require('../services/zohoSchedulingService');
    await zoho.updateCampaignContactStatus(zoho_campaign_id, zoho_contact_id, status, notes);
    logger.info(`[FlowEngine] Zoho synced: campaign=${zoho_campaign_id} contact=${zoho_contact_id} status=${status}`);
  } catch (err) {
    logger.warn(`[FlowEngine] Zoho sync failed (non-critical): ${err.message}`);
  }
}

/**
 * Log a flow action to campaign_flow_log.
 */
async function logAction(campaignId, leadId, phone, action, stageBefore, stageAfter, success, details = null, errorMsg = null) {
  try {
    await pool.query(
      `INSERT INTO campaign_flow_log
         (campaign_id, lead_id, phone, action, stage_before, stage_after, success, details, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [campaignId, leadId, phone, action, stageBefore, stageAfter, success,
       details ? JSON.stringify(details) : null, errorMsg]
    );
  } catch (err) {
    logger.warn(`[FlowEngine] Failed to write flow log: ${err.message}`);
  }
}

/**
 * Update lead stage and timestamps.
 */
async function advanceLead(leadId, newStage, extraFields = {}) {
  const setClauses = ['flow_stage = $1', 'last_activity_at = NOW()', 'updated_at = NOW()'];
  const values     = [newStage];
  let   idx        = 2;
  for (const [col, val] of Object.entries(extraFields)) {
    setClauses.push(`${col} = $${idx++}`);
    values.push(val);
  }
  values.push(leadId);
  await pool.query(
    `UPDATE campaign_leads SET ${setClauses.join(', ')} WHERE id = $${idx}`,
    values
  );
}

// ─── Main Tick ───────────────────────────────────────────────────────────────

let _running = false;

async function runCampaignFlowEngine() {
  if (_running) {
    logger.info('[FlowEngine] Previous run still active, skipping');
    return;
  }
  _running = true;
  try {
    await stepReminder1();
    await stepReminder2();
    await stepCall1();
    await stepCall2();
  } catch (err) {
    logger.error('[FlowEngine] Unhandled error in flow engine tick:', err.message);
  } finally {
    _running = false;
  }
}

// ─── Step 1: Send Reminder 1 ─────────────────────────────────────────────────
// Leads in 'initial' stage, no WA reply, delay elapsed, campaign has reminder1_template_id

async function stepReminder1() {
  const { rows } = await pool.query(`
    SELECT cl.*, c.zoho_campaign_id, c.reminder1_template_id,
           c.wa_reminder_delay_hours, c.max_wa_reminders,
           c.agent_name, c.name AS campaign_name, c.id AS camp_id,
           c.voice_name, c.voice_provider, c.call_script
    FROM campaign_leads cl
    JOIN campaigns c ON c.id = cl.campaign_id
    WHERE cl.flow_stage = 'initial'
      AND c.status = 'active'
      AND c.flow_enabled = TRUE
      AND c.max_wa_reminders >= 1
      AND c.reminder1_template_id IS NOT NULL
      AND c.reminder1_template_id != ''
      AND cl.wa_replied_at IS NULL
      AND cl.wa_sent_at IS NOT NULL
      AND cl.wa_sent_at < NOW() - (c.wa_reminder_delay_hours || ' hours')::interval
    ORDER BY cl.wa_sent_at ASC
    LIMIT 20
  `);

  for (const lead of rows) {
    const stageBefore = 'initial';
    try {
      const result = await sendWaTemplate(
        lead.phone,
        lead.reminder1_template_id,
        [lead.name || ''],
        lead.id
      );
      await advanceLead(lead.id, 'reminder_1_sent', {
        reminder1_sent_at: 'NOW()',
        reminder_count: lead.reminder_count + 1
      });
      // Fix: use literal NOW() for timestamptz
      await pool.query(
        `UPDATE campaign_leads SET reminder1_sent_at = NOW(), reminder_count = reminder_count + 1 WHERE id = $1`,
        [lead.id]
      );
      await pool.query(
        `UPDATE campaign_leads SET flow_stage = 'reminder_1_sent', last_activity_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [lead.id]
      );
      await logAction(lead.camp_id, lead.id, lead.phone, 'wa_reminder_1',
        stageBefore, 'reminder_1_sent', result.ok,
        { templateId: lead.reminder1_template_id, statusId: result.statusId }
      );
      await syncZoho(lead.zoho_campaign_id, lead.zoho_contact_id,
        'no_answer_24h', 'תזכורת WA ראשונה נשלחה');
    } catch (err) {
      logger.error(`[FlowEngine] Reminder1 failed for lead #${lead.id}: ${err.message}`);
      await logAction(lead.camp_id, lead.id, lead.phone, 'wa_reminder_1',
        stageBefore, stageBefore, false, null, err.message);
    }
  }
}

// ─── Step 2: Send Reminder 2 ─────────────────────────────────────────────────
// Leads in 'reminder_1_sent', no reply, delay elapsed, campaign has reminder2_template_id

async function stepReminder2() {
  const { rows } = await pool.query(`
    SELECT cl.*, c.zoho_campaign_id, c.reminder2_template_id,
           c.wa_reminder_delay_hours, c.max_wa_reminders,
           c.agent_name, c.name AS campaign_name, c.id AS camp_id,
           c.voice_name, c.voice_provider, c.call_script
    FROM campaign_leads cl
    JOIN campaigns c ON c.id = cl.campaign_id
    WHERE cl.flow_stage = 'reminder_1_sent'
      AND c.status = 'active'
      AND c.flow_enabled = TRUE
      AND c.max_wa_reminders >= 2
      AND c.reminder2_template_id IS NOT NULL
      AND c.reminder2_template_id != ''
      AND cl.wa_replied_at IS NULL
      AND cl.reminder1_sent_at IS NOT NULL
      AND cl.reminder1_sent_at < NOW() - (c.wa_reminder_delay_hours || ' hours')::interval
    ORDER BY cl.reminder1_sent_at ASC
    LIMIT 20
  `);

  for (const lead of rows) {
    const stageBefore = 'reminder_1_sent';
    try {
      const result = await sendWaTemplate(
        lead.phone,
        lead.reminder2_template_id,
        [lead.name || ''],
        lead.id
      );
      await pool.query(
        `UPDATE campaign_leads
         SET flow_stage = 'reminder_2_sent', reminder2_sent_at = NOW(),
             reminder_count = reminder_count + 1, last_activity_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [lead.id]
      );
      await logAction(lead.camp_id, lead.id, lead.phone, 'wa_reminder_2',
        stageBefore, 'reminder_2_sent', result.ok,
        { templateId: lead.reminder2_template_id, statusId: result.statusId }
      );
      await syncZoho(lead.zoho_campaign_id, lead.zoho_contact_id,
        'no_answer_48h', 'תזכורת WA שנייה נשלחה');
    } catch (err) {
      logger.error(`[FlowEngine] Reminder2 failed for lead #${lead.id}: ${err.message}`);
      await logAction(lead.camp_id, lead.id, lead.phone, 'wa_reminder_2',
        stageBefore, stageBefore, false, null, err.message);
    }
  }
}

// ─── Step 3: Place Call 1 ────────────────────────────────────────────────────
// Leads in 'reminder_2_sent' (or 'initial'/'reminder_1_sent' if max_wa_reminders=0/1)
// No WA reply, call_delay_after_wa_hours elapsed since last reminder

async function stepCall1() {
  const { rows } = await pool.query(`
    SELECT cl.*, c.zoho_campaign_id, c.call_delay_after_wa_hours,
           c.max_call_attempts, c.agent_name, c.name AS campaign_name, c.id AS camp_id,
           c.voice_name, c.voice_provider, c.call_script, c.mode
    FROM campaign_leads cl
    JOIN campaigns c ON c.id = cl.campaign_id
    WHERE cl.flow_stage IN ('reminder_2_sent', 'reminder_1_sent', 'initial')
      AND c.status = 'active'
      AND c.flow_enabled = TRUE
      AND c.mode != 'wa_only'
      AND c.max_call_attempts >= 1
      AND cl.wa_replied_at IS NULL
      AND cl.call1_initiated_at IS NULL
      AND (
        -- After reminder 2
        (cl.flow_stage = 'reminder_2_sent'
         AND cl.reminder2_sent_at < NOW() - (c.call_delay_after_wa_hours || ' hours')::interval)
        OR
        -- After reminder 1 (if max_wa_reminders=1)
        (cl.flow_stage = 'reminder_1_sent'
         AND c.max_wa_reminders < 2
         AND cl.reminder1_sent_at < NOW() - (c.call_delay_after_wa_hours || ' hours')::interval)
        OR
        -- No reminders configured (direct to call)
        (cl.flow_stage = 'initial'
         AND c.max_wa_reminders = 0
         AND cl.wa_sent_at IS NOT NULL
         AND cl.wa_sent_at < NOW() - (c.call_delay_after_wa_hours || ' hours')::interval)
      )
    ORDER BY cl.updated_at ASC
    LIMIT 10
  `);

  for (const lead of rows) {
    const stageBefore = lead.flow_stage;
    try {
      const campaign = {
        id: lead.camp_id, name: lead.campaign_name,
        agent_name: lead.agent_name, voice_name: lead.voice_name,
        voice_provider: lead.voice_provider, call_script: lead.call_script
      };
      const vapiCallId = await placeVapiCall(lead.phone, lead.name, campaign);
      await pool.query(
        `UPDATE campaign_leads
         SET flow_stage = 'call_1_initiated', call1_initiated_at = NOW(),
             call1_vapi_id = $1, call_attempt_count = call_attempt_count + 1,
             last_activity_at = NOW(), updated_at = NOW()
         WHERE id = $2`,
        [vapiCallId, lead.id]
      );
      await logAction(lead.camp_id, lead.id, lead.phone, 'call_1',
        stageBefore, 'call_1_initiated', true, { vapiCallId });
      await syncZoho(lead.zoho_campaign_id, lead.zoho_contact_id,
        'no_answer_48h', 'שיחה ראשונה יוזמה');
    } catch (err) {
      logger.error(`[FlowEngine] Call1 failed for lead #${lead.id}: ${err.message}`);
      await logAction(lead.camp_id, lead.id, lead.phone, 'call_1',
        stageBefore, stageBefore, false, null, err.message);
    }
  }
}

// ─── Step 4: Place Call 2 ────────────────────────────────────────────────────
// Leads in 'call_1_no_answer', retry delay elapsed

async function stepCall2() {
  const { rows } = await pool.query(`
    SELECT cl.*, c.zoho_campaign_id, c.call_retry_delay_hours,
           c.max_call_attempts, c.agent_name, c.name AS campaign_name, c.id AS camp_id,
           c.voice_name, c.voice_provider, c.call_script
    FROM campaign_leads cl
    JOIN campaigns c ON c.id = cl.campaign_id
    WHERE cl.flow_stage = 'call_1_no_answer'
      AND c.status = 'active'
      AND c.flow_enabled = TRUE
      AND c.max_call_attempts >= 2
      AND cl.wa_replied_at IS NULL
      AND cl.call2_initiated_at IS NULL
      AND cl.call1_initiated_at IS NOT NULL
      AND cl.call1_initiated_at < NOW() - (c.call_retry_delay_hours || ' hours')::interval
    ORDER BY cl.call1_initiated_at ASC
    LIMIT 10
  `);

  for (const lead of rows) {
    const stageBefore = 'call_1_no_answer';
    try {
      const campaign = {
        id: lead.camp_id, name: lead.campaign_name,
        agent_name: lead.agent_name, voice_name: lead.voice_name,
        voice_provider: lead.voice_provider, call_script: lead.call_script
      };
      const vapiCallId = await placeVapiCall(lead.phone, lead.name, campaign);
      await pool.query(
        `UPDATE campaign_leads
         SET flow_stage = 'call_2_initiated', call2_initiated_at = NOW(),
             call2_vapi_id = $1, call_attempt_count = call_attempt_count + 1,
             last_activity_at = NOW(), updated_at = NOW()
         WHERE id = $2`,
        [vapiCallId, lead.id]
      );
      await logAction(lead.camp_id, lead.id, lead.phone, 'call_2',
        stageBefore, 'call_2_initiated', true, { vapiCallId });
      await syncZoho(lead.zoho_campaign_id, lead.zoho_contact_id,
        'no_answer_48h', 'שיחה שנייה יוזמה');
    } catch (err) {
      logger.error(`[FlowEngine] Call2 failed for lead #${lead.id}: ${err.message}`);
      await logAction(lead.camp_id, lead.id, lead.phone, 'call_2',
        stageBefore, stageBefore, false, null, err.message);
    }
  }
}

// ─── Webhook Handlers (called from campaignRoutes.js) ────────────────────────

/**
 * Mark a lead as having replied to WA — stops the flow.
 */
async function markWaReplied(phone) {
  try {
    const { rows } = await pool.query(
      `UPDATE campaign_leads
       SET flow_stage = 'replied', wa_replied_at = COALESCE(wa_replied_at, NOW()),
           last_activity_at = NOW(), updated_at = NOW()
       WHERE phone = $1
         AND flow_stage NOT IN ('replied', 'call_answered', 'converted', 'opted_out', 'exhausted')
         AND campaign_id IN (SELECT id FROM campaigns WHERE status = 'active')
       RETURNING id, campaign_id, flow_stage AS old_stage, zoho_contact_id,
                 (SELECT zoho_campaign_id FROM campaigns WHERE id = campaign_leads.campaign_id) AS zoho_cid`,
      [phone]
    );
    for (const lead of rows) {
      await logAction(lead.campaign_id, lead.id, phone, 'wa_replied',
        lead.old_stage, 'replied', true);
      await syncZoho(lead.zoho_cid, lead.zoho_contact_id, 'answered', 'ענה ל-WA');
    }
    if (rows.length > 0) logger.info(`[FlowEngine] WA reply marked for ${phone} (${rows.length} leads)`);
  } catch (err) {
    logger.error(`[FlowEngine] markWaReplied error for ${phone}: ${err.message}`);
  }
}

/**
 * Mark a call as no-answer (called from Vapi webhook or manual trigger).
 * callNumber: 1 or 2
 */
async function markCallNoAnswer(phone, callNumber = 1) {
  const newStage = callNumber === 1 ? 'call_1_no_answer' : 'call_2_no_answer';
  const fromStage = callNumber === 1 ? 'call_1_initiated' : 'call_2_initiated';
  try {
    const { rows } = await pool.query(
      `UPDATE campaign_leads
       SET flow_stage = $1, last_activity_at = NOW(), updated_at = NOW()
       WHERE phone = $2 AND flow_stage = $3
         AND campaign_id IN (SELECT id FROM campaigns WHERE status = 'active')
       RETURNING id, campaign_id, zoho_contact_id,
                 (SELECT zoho_campaign_id FROM campaigns WHERE id = campaign_leads.campaign_id) AS zoho_cid`,
      [newStage, phone, fromStage]
    );
    for (const lead of rows) {
      await logAction(lead.campaign_id, lead.id, phone, `call_${callNumber}_no_answer`,
        fromStage, newStage, true);
      // If call 2 no answer → mark exhausted
      if (callNumber === 2) {
        await pool.query(
          `UPDATE campaign_leads SET flow_stage = 'exhausted', updated_at = NOW() WHERE id = $1`,
          [lead.id]
        );
        await syncZoho(lead.zoho_cid, lead.zoho_contact_id,
          'no_answer_48h', 'כל ניסיונות הקשר מוצו');
      } else {
        await syncZoho(lead.zoho_cid, lead.zoho_contact_id,
          'no_answer_24h', `שיחה ${callNumber} ללא מענה`);
      }
    }
  } catch (err) {
    logger.error(`[FlowEngine] markCallNoAnswer error for ${phone}: ${err.message}`);
  }
}

/**
 * Mark a call as answered — stops the flow, syncs Zoho.
 */
async function markCallAnswered(phone) {
  try {
    const { rows } = await pool.query(
      `UPDATE campaign_leads
       SET flow_stage = 'call_answered', last_activity_at = NOW(), updated_at = NOW()
       WHERE phone = $1
         AND flow_stage IN ('call_1_initiated', 'call_2_initiated')
         AND campaign_id IN (SELECT id FROM campaigns WHERE status = 'active')
       RETURNING id, campaign_id, zoho_contact_id,
                 (SELECT zoho_campaign_id FROM campaigns WHERE id = campaign_leads.campaign_id) AS zoho_cid`,
      [phone]
    );
    for (const lead of rows) {
      await logAction(lead.campaign_id, lead.id, phone, 'call_answered',
        'call_initiated', 'call_answered', true);
      await syncZoho(lead.zoho_cid, lead.zoho_contact_id, 'answered', 'ענה לשיחה');
    }
  } catch (err) {
    logger.error(`[FlowEngine] markCallAnswered error for ${phone}: ${err.message}`);
  }
}

/**
 * Get funnel stats for a campaign (used by the dashboard UI).
 */
async function getCampaignFunnel(campaignId) {
  const { rows } = await pool.query(`
    SELECT
      flow_stage,
      COUNT(*) AS count
    FROM campaign_leads
    WHERE campaign_id = $1
    GROUP BY flow_stage
  `, [campaignId]);

  const map = {};
  for (const r of rows) map[r.flow_stage] = parseInt(r.count);

  return {
    initial:          map.initial          || 0,
    reminder_1_sent:  map.reminder_1_sent  || 0,
    reminder_2_sent:  map.reminder_2_sent  || 0,
    call_1_initiated: map.call_1_initiated || 0,
    call_1_no_answer: map.call_1_no_answer || 0,
    call_2_initiated: map.call_2_initiated || 0,
    call_2_no_answer: map.call_2_no_answer || 0,
    replied:          map.replied          || 0,
    call_answered:    map.call_answered    || 0,
    converted:        map.converted        || 0,
    opted_out:        map.opted_out        || 0,
    exhausted:        map.exhausted        || 0,
    failed:           map.failed           || 0,
    total: Object.values(map).reduce((a, b) => a + b, 0)
  };
}

/**
 * Get recent flow log entries for a campaign.
 */
async function getCampaignFlowLog(campaignId, limit = 50) {
  const { rows } = await pool.query(`
    SELECT fl.*, cl.name AS lead_name
    FROM campaign_flow_log fl
    LEFT JOIN campaign_leads cl ON cl.id = fl.lead_id
    WHERE fl.campaign_id = $1
    ORDER BY fl.created_at DESC
    LIMIT $2
  `, [campaignId, limit]);
  return rows;
}

module.exports = {
  runCampaignFlowEngine,
  markWaReplied,
  markCallNoAnswer,
  markCallAnswered,
  getCampaignFunnel,
  getCampaignFlowLog
};
