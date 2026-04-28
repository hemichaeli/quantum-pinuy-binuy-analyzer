/**
 * Lead Management Routes for QUANTUM
 * POST /submit - Receive lead from website
 * GET / - List leads (filters: type, status, urgent)
 * GET /stats - Lead statistics
 * GET /pipeline - Status-grouped pipeline view (added 2026-04-28)
 * PUT /:id/status - Update lead status
 * GET /trello/status - Trello integration status
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

let leadService;
let trelloService;

try {
  leadService = require('../services/leadService');
} catch (e) {
  logger.error('leadService not available:', e.message);
}

try {
  trelloService = require('../services/trelloService');
} catch (e) {
  logger.warn('trelloService not available:', e.message);
}

/**
 * POST /submit - Process new lead from website
 */
router.post('/submit', async (req, res) => {
  try {
    if (!leadService) {
      return res.status(503).json({ success: false, error: 'Lead service not available' });
    }

    const { name, email, phone, userType, user_type, phoneVerified, phone_verified,
            mailingListConsent, mailing_list_consent, formData, form_data, source,
            campaign_tag, utm_source, utm_campaign } = req.body;

    // Also check query params for UTM (for QR/link-based flows)
    const utmSourceFinal = utm_source || req.query.utm_source || req.query.src || null;
    const utmCampaignFinal = utm_campaign || req.query.utm_campaign || req.query.campaign || null;
    const campaignTagFinal = campaign_tag || req.query.campaign_tag || utmCampaignFinal || null;

    const leadData = {
      name: name || 'Unknown',
      email: email || '',
      phone: phone || '',
      phone_verified: phoneVerified || phone_verified || false,
      user_type: userType || user_type || 'investor',
      form_data: formData || form_data || {},
      mailing_list_consent: mailingListConsent || mailing_list_consent || false,
      source: utmSourceFinal === 'flyer' ? 'flyer' : (source || 'website'),
      campaign_tag: campaignTagFinal,
      utm_source: utmSourceFinal,
      utm_campaign: utmCampaignFinal
    };

    // Validate required fields
    if (!leadData.name || !leadData.phone) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: name, phone'
      });
    }

    logger.info(`New lead received: ${leadData.name} (${leadData.user_type})`);

    const result = await leadService.processNewLead(leadData);

    res.status(result.saved ? 201 : 207).json({
      success: true,
      leadId: result.leadId,
      notifications: {
        email: result.emailSent,
        trello: result.trelloCreated
      },
      errors: result.errors.length > 0 ? result.errors : undefined
    });

  } catch (error) {
    logger.error('Lead submit error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET / - List leads with optional filters
 */
router.get('/', async (req, res) => {
  try {
    if (!leadService) {
      return res.status(503).json({ error: 'Lead service not available' });
    }

    const { type, status, urgent, limit, offset } = req.query;
    const result = await leadService.getLeads({
      type,
      status,
      urgent: urgent !== undefined ? urgent === 'true' : undefined,
      limit: limit ? parseInt(limit) : 50,
      offset: offset ? parseInt(offset) : 0
    });

    res.json(result);
  } catch (error) {
    logger.error('Lead list error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /stats - Lead statistics
 */
router.get('/stats', async (req, res) => {
  try {
    if (!leadService) {
      return res.status(503).json({ error: 'Lead service not available' });
    }

    const stats = await leadService.getLeadStats();
    res.json(stats);
  } catch (error) {
    logger.error('Lead stats error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 2026-04-28: GET /pipeline
 * Status-grouped pipeline view for the dashboard Lead inbox.
 * Returns counts by status, counts by user_type, urgent count, 24h/7d/30d
 * cohorts, plus last 5 leads per status with trello_card_url + parsed
 * form_data preview.
 */
router.get('/pipeline', async (req, res) => {
  try {
    if (leadService && leadService.ensureLeadsTable) {
      try { await leadService.ensureLeadsTable(); } catch (e) { /* table may already exist */ }
    }

    const safe = async (sql, params = []) => {
      try { const r = await pool.query(sql, params); return r.rows; } catch (e) {
        logger.warn('[leads/pipeline] query failed', { error: e.message });
        return [];
      }
    };

    const STATUSES = ['new', 'contacted', 'qualified', 'negotiation', 'closed', 'lost'];

    const [byStatus, byType, cohorts, recentByStatus] = await Promise.all([
      safe(`
        SELECT status, COUNT(*)::int AS count
        FROM website_leads
        GROUP BY status
      `),
      safe(`
        SELECT user_type, COUNT(*)::int AS count
        FROM website_leads
        GROUP BY user_type
      `),
      safe(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE is_urgent = TRUE)::int AS urgent,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS last_24h,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS last_7d,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days')::int AS last_30d,
          COUNT(*) FILTER (WHERE trello_card_id IS NOT NULL)::int AS with_trello
        FROM website_leads
      `),
      safe(`
        SELECT id, name, phone, email, user_type, status, is_urgent,
               trello_card_url, form_data, created_at, updated_at,
               campaign_tag, utm_source
        FROM (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY status ORDER BY created_at DESC) AS rn
          FROM website_leads
        ) t
        WHERE t.rn <= 5
        ORDER BY status, created_at DESC
      `)
    ]);

    // Normalize: ensure every status appears even with 0 count.
    const statusMap = Object.fromEntries(STATUSES.map(s => [s, 0]));
    byStatus.forEach(r => { if (r.status) statusMap[r.status] = r.count; });

    // Group recent leads by status.
    const recentMap = Object.fromEntries(STATUSES.map(s => [s, []]));
    recentByStatus.forEach(l => {
      const s = l.status || 'new';
      if (!recentMap[s]) recentMap[s] = [];
      // Parse form_data if it came back as string.
      let fd = l.form_data;
      if (typeof fd === 'string') {
        try { fd = JSON.parse(fd); } catch (e) { fd = {}; }
      }
      recentMap[s].push({
        id: l.id, name: l.name, phone: l.phone, email: l.email,
        user_type: l.user_type, is_urgent: l.is_urgent,
        trello_card_url: l.trello_card_url,
        campaign_tag: l.campaign_tag, utm_source: l.utm_source,
        form_data_preview: fd,
        created_at: l.created_at, updated_at: l.updated_at
      });
    });

    // by_type as object {investor: N, owner: N, contact: N, ...}
    const typeMap = {};
    byType.forEach(r => { if (r.user_type) typeMap[r.user_type] = r.count; });

    res.json({
      success: true,
      cohorts: cohorts[0] || { total: 0, urgent: 0, last_24h: 0, last_7d: 0, last_30d: 0, with_trello: 0 },
      by_status: statusMap,
      by_type: typeMap,
      recent_by_status: recentMap,
      generated_at: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Lead pipeline error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /trello/status - Trello integration status
 */
router.get('/trello/status', async (req, res) => {
  try {
    if (!trelloService) {
      return res.json({ configured: false, error: 'Trello service not available' });
    }

    const status = await trelloService.getStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /:id/status - Update lead status
 */
router.put('/:id/status', async (req, res) => {
  try {
    if (!leadService) {
      return res.status(503).json({ error: 'Lead service not available' });
    }

    const { id } = req.params;
    const { status, notes } = req.body;

    const validStatuses = ['new', 'contacted', 'qualified', 'negotiation', 'closed', 'lost'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        error: `Invalid status. Valid: ${validStatuses.join(', ')}`
      });
    }

    const result = await leadService.updateLeadStatus(parseInt(id), status, notes);
    res.json(result);
  } catch (error) {
    logger.error('Lead status update error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
