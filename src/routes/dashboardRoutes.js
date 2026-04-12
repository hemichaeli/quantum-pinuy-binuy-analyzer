/**
 * QUANTUM Dashboard API Routes v2.3
 *
 * v2.3: Investor-grade ranking
 *   - Complexes: ranked by TRUE investor premium (entry discount × theoretical premium)
 *   - Listings: ranked by SSI + investor context, known agents flagged
 *   - Construction-stage complexes deprioritized for investors
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { enrichNewListings } = require('../services/adEnrichmentService');

// Known recurring agent phones — flag but don't exclude
const KNOWN_AGENT_PHONES = ['0508005958', '0508005971', '0508005995'];

// Plan stages that indicate active construction — premium already captured
const CONSTRUCTION_STAGES = ['under_construction', 'ביצוע', 'בביצוע'];

router.get('/', (req, res) => { res.redirect('/dashboard'); });

// ============================================================
// API: All Ads — with true investor premium per listing
// ============================================================
router.get('/ads/all', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        l.*,
        c.name                    AS complex_name,
        c.city                    AS complex_city,
        c.iai_score,
        c.accurate_price_sqm,
        c.city_avg_price_sqm,
        c.theoretical_premium_min,
        c.theoretical_premium_max,
        c.plan_stage,
        c.developer_strength,
        c.certainty_factor,
        c.has_negative_news,
        l.asking_price            AS price,

        -- Entry discount: how far below market is this listing today?
        CASE
          WHEN l.price_per_sqm > 0 AND c.city_avg_price_sqm > 0
          THEN ROUND(((c.city_avg_price_sqm - l.price_per_sqm)::numeric / c.city_avg_price_sqm) * 100, 1)
          WHEN c.accurate_price_sqm > 0 AND c.city_avg_price_sqm > 0
          THEN ROUND(((c.city_avg_price_sqm - c.accurate_price_sqm)::numeric / c.city_avg_price_sqm) * 100, 1)
          ELSE NULL
        END                       AS entry_discount_pct,

        -- Total investor premium from entry price to post-realisation value
        CASE
          WHEN c.accurate_price_sqm > 0 AND c.city_avg_price_sqm > 0 AND c.theoretical_premium_min IS NOT NULL
          THEN ROUND(
            ((c.city_avg_price_sqm * (1 + c.theoretical_premium_min::numeric/100) - c.accurate_price_sqm)::numeric
              / c.accurate_price_sqm) * 100, 1)
          ELSE NULL
        END                       AS total_investor_premium_min,

        -- Is this an active-construction project? (premium mostly captured)
        CASE WHEN c.plan_stage = ANY($1) THEN true ELSE false END AS is_construction,

        -- Is this a known recurring agent?
        CASE WHEN l.phone = ANY($2) THEN true ELSE false END AS is_known_agent

      FROM listings l
      LEFT JOIN complexes c ON l.complex_id = c.id
      WHERE l.is_active = true
      ORDER BY l.created_at DESC
      LIMIT 1000
    `, [CONSTRUCTION_STAGES, KNOWN_AGENT_PHONES]);

    res.json({ ads: rows.map(row => ({
      ...row,
      premium_amount: row.total_investor_premium_min
        ? Math.round((row.total_investor_premium_min / 100) * (row.price || 0))
        : null
    })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// API: Ads Statistics
// ============================================================
router.get('/ads/stats', async (req, res) => {
  try {
    const [t, n, a, p, h] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM listings WHERE is_active = true'),
      pool.query(`SELECT COUNT(*) as count FROM listings WHERE is_active = true AND created_at >= NOW() - INTERVAL '24 hours'`),
      pool.query('SELECT AVG(asking_price) as avg FROM listings WHERE is_active = true AND asking_price > 0'),
      pool.query('SELECT COUNT(*) as count FROM listings WHERE is_active = true AND phone IS NOT NULL'),
      pool.query(`SELECT COUNT(*) as count FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id WHERE l.is_active = true AND c.iai_score > 80`)
    ]);
    res.json({ active: t.rows[0]?.count||0, new_leads: n.rows[0]?.count||0, avg_price: Math.round(a.rows[0]?.avg||0), with_phone: p.rows[0]?.count||0, hot_opportunities: h.rows[0]?.count||0, today_calls: 8, monthly_deals: 5 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/messages/all', (req, res) => res.json({ messages: [] }));
router.get('/messages/stats', (req, res) => res.json({ new: 15, whatsapp: 40, email: 10, response_rate: 70 }));

// ============================================================
// API: All Complexes — with investor score
// ============================================================
router.get('/complexes/all', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        id, name, city, existing_units, planned_units,
        iai_score, status, updated_at, address, developer,
        approval_date, signature_percent,
        accurate_price_sqm, city_avg_price_sqm,
        theoretical_premium_min, theoretical_premium_max,
        plan_stage, developer_strength, developer_risk_level,
        certainty_factor, has_negative_news,

        -- Entry discount: how much below market today
        CASE
          WHEN accurate_price_sqm > 0 AND city_avg_price_sqm > 0
          THEN ROUND(((city_avg_price_sqm - accurate_price_sqm)::numeric / city_avg_price_sqm) * 100, 1)
          ELSE NULL
        END AS entry_discount_pct,

        -- True total investor premium (from entry price to post-realisation)
        CASE
          WHEN accurate_price_sqm > 0 AND city_avg_price_sqm > 0 AND theoretical_premium_min IS NOT NULL
          THEN ROUND(
            ((city_avg_price_sqm * (1 + theoretical_premium_min::numeric/100) - accurate_price_sqm)::numeric
              / accurate_price_sqm) * 100, 1)
          ELSE NULL
        END AS total_investor_premium_min,

        CASE
          WHEN accurate_price_sqm > 0 AND city_avg_price_sqm > 0 AND theoretical_premium_max IS NOT NULL
          THEN ROUND(
            ((city_avg_price_sqm * (1 + theoretical_premium_max::numeric/100) - accurate_price_sqm)::numeric
              / accurate_price_sqm) * 100, 1)
          ELSE NULL
        END AS total_investor_premium_max,

        -- Is entry below market? (key investor criterion)
        CASE
          WHEN accurate_price_sqm > 0 AND city_avg_price_sqm > 0
            AND accurate_price_sqm < city_avg_price_sqm
          THEN true ELSE false
        END AS entry_below_market,

        -- Construction stage flag (premium mostly captured, skip for investors)
        CASE WHEN plan_stage = ANY($1) THEN true ELSE false END AS is_construction,

        -- Composite investor score:
        --   50% total_investor_premium + 30% certainty + 20% iai
        --   Penalise: construction (-30), negative news (-20), weak developer (-10)
        CASE
          WHEN accurate_price_sqm > 0 AND city_avg_price_sqm > 0 AND theoretical_premium_min IS NOT NULL
          THEN ROUND(
            (
              -- Premium component (0-100 mapped from 0-200% premium)
              LEAST(50, ((city_avg_price_sqm * (1 + theoretical_premium_min::numeric/100) - accurate_price_sqm)::numeric
                / accurate_price_sqm) * 25)
              -- Certainty component
              + COALESCE(certainty_factor::numeric, 0.5) * 30
              -- IAI component
              + COALESCE(iai_score, 50)::numeric * 0.2
              -- Penalties
              - CASE WHEN plan_stage = ANY($1) THEN 30 ELSE 0 END
              - CASE WHEN has_negative_news THEN 20 ELSE 0 END
              - CASE WHEN developer_strength = 'weak' THEN 10
                     WHEN developer_strength = 'unknown' THEN 5
                     ELSE 0 END
            ), 1)
          ELSE iai_score::numeric * 0.7
        END AS investor_score

      FROM complexes
      ORDER BY investor_score DESC NULLS LAST
      LIMIT 1000
    `, [CONSTRUCTION_STAGES]);

    res.json({ complexes: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/buyers/all', (req, res) => res.json({ buyers: [] }));
router.get('/news', (req, res) => res.json({ news: [] }));
router.get('/calls/stats', (req, res) => res.json({ today: { total: 0 }, week: { total: 0 }, month: { total: 0 } }));
router.get('/leads/stats', (req, res) => res.json({ total: 0, new_this_month: 0, converted: 0, active: 0, conversion_rate: 0 }));

// API: Get single complex
router.get('/complex/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM complexes WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// API: Listings — investor-aware ranking
// Sort options: iai | ssi | price | days | new | investor
// investor = composite: SSI × 0.4 + IAI × 0.3 + entry_discount × 0.3
// ============================================================
router.get('/listings', async (req, res) => {
  try {
    const {
      city, complex_slug, source, sort = 'investor', limit = 200,
      is_active, min_rooms, max_rooms, min_price, max_price,
      min_ssi, min_iai, message_status,
      exclude_construction, exclude_agents
    } = req.query;

    const params = [];
    const conditions = [is_active === 'false' ? 'l.is_active = false' : 'l.is_active = true'];

    if (city)         { params.push(`%${city}%`);           conditions.push(`l.city ILIKE $${params.length}`); }
    if (complex_slug) { params.push(complex_slug);          conditions.push(`c.slug = $${params.length}`); }
    if (source)       { params.push(source);                conditions.push(`l.source = $${params.length}`); }
    if (min_rooms)    { params.push(parseFloat(min_rooms)); conditions.push(`l.rooms >= $${params.length}`); }
    if (max_rooms)    { params.push(parseFloat(max_rooms)); conditions.push(`l.rooms <= $${params.length}`); }
    if (min_price)    { params.push(parseFloat(min_price)); conditions.push(`l.asking_price >= $${params.length}`); }
    if (max_price)    { params.push(parseFloat(max_price)); conditions.push(`l.asking_price <= $${params.length}`); }
    if (min_ssi)      { params.push(parseFloat(min_ssi));   conditions.push(`l.ssi_score >= $${params.length}`); }
    if (min_iai)      { params.push(parseFloat(min_iai));   conditions.push(`c.iai_score >= $${params.length}`); }

    if (exclude_construction === 'true') {
      params.push(CONSTRUCTION_STAGES);
      conditions.push(`(c.plan_stage IS NULL OR NOT c.plan_stage = ANY($${params.length}))`);
    }
    if (exclude_agents === 'true') {
      params.push(KNOWN_AGENT_PHONES);
      conditions.push(`(l.phone IS NULL OR NOT l.phone = ANY($${params.length}))`);
    }

    if (message_status) {
      if (message_status === 'none')     conditions.push(`(l.message_status IS NULL OR l.message_status IN ('לא נשלחה','none','not_sent',''))`);
      else if (message_status === 'sent')     conditions.push(`l.message_status IN ('sent','נשלחה')`);
      else if (message_status === 'replied')  conditions.push(`l.message_status IN ('replied','ענה')`);
      else if (message_status === 'no_reply') conditions.push(`l.message_status IN ('no_reply','ללא מענה')`);
      else { params.push(message_status); conditions.push(`l.message_status = $${params.length}`); }
    }

    const sortMap = {
      iai:      'c.iai_score DESC NULLS LAST',
      price:    'l.asking_price ASC NULLS LAST',
      days:     'l.days_on_market DESC NULLS LAST',
      ssi:      'l.ssi_score DESC NULLS LAST',
      new:      'l.created_at DESC',
      investor: `
        (
          COALESCE(l.ssi_score, 0) * 0.4
          + COALESCE(c.iai_score, 0)::numeric * 0.3
          + CASE
              WHEN c.accurate_price_sqm > 0 AND c.city_avg_price_sqm > 0
                AND c.accurate_price_sqm < c.city_avg_price_sqm
              THEN ((c.city_avg_price_sqm - c.accurate_price_sqm)::numeric / c.city_avg_price_sqm) * 30
              ELSE 0
            END
          - CASE WHEN c.plan_stage = ANY(ARRAY['under_construction','ביצוע','בביצוע']) THEN 20 ELSE 0 END
          - CASE WHEN c.has_negative_news THEN 10 ELSE 0 END
          - CASE WHEN l.phone = ANY(ARRAY['0508005958','0508005971','0508005995']) THEN 5 ELSE 0 END
        ) DESC NULLS LAST
      `
    };

    const lim = Math.min(parseInt(limit) || 200, 500);

    const { rows } = await pool.query(`
      SELECT
        l.id, l.address, l.title, l.city, l.rooms, l.asking_price, l.area_sqm,
        l.price_per_sqm, l.ssi_score, l.message_status, l.contact_attempts,
        l.last_message_sent_at, l.last_reply_at, l.deal_status, l.source,
        l.phone, l.contact_name, l.thumbnail_url, l.created_at,
        l.days_on_market, l.total_price_drop_percent,
        l.has_urgent_keywords, l.urgent_keywords_found,
        l.is_foreclosure, l.is_inheritance,
        c.name          AS complex_name,
        c.city          AS complex_city,
        c.slug          AS complex_slug,
        c.id            AS cid,
        c.iai_score,
        c.status        AS complex_status,
        c.developer,
        c.developer_strength,
        c.plan_stage,
        c.accurate_price_sqm,
        c.city_avg_price_sqm,
        c.theoretical_premium_min,
        c.certainty_factor,
        c.has_negative_news,

        -- Entry discount
        CASE
          WHEN c.accurate_price_sqm > 0 AND c.city_avg_price_sqm > 0
          THEN ROUND(((c.city_avg_price_sqm - c.accurate_price_sqm)::numeric / c.city_avg_price_sqm) * 100, 1)
          ELSE NULL
        END AS entry_discount_pct,

        -- True total investor premium
        CASE
          WHEN c.accurate_price_sqm > 0 AND c.city_avg_price_sqm > 0 AND c.theoretical_premium_min IS NOT NULL
          THEN ROUND(
            ((c.city_avg_price_sqm * (1 + c.theoretical_premium_min::numeric/100) - c.accurate_price_sqm)::numeric
              / c.accurate_price_sqm) * 100, 1)
          ELSE NULL
        END AS total_investor_premium_min,

        -- Flags
        CASE WHEN c.plan_stage = ANY(ARRAY['under_construction','ביצוע','בביצוע']) THEN true ELSE false END AS is_construction,
        CASE WHEN l.phone = ANY(ARRAY['0508005958','0508005971','0508005995']) THEN true ELSE false END AS is_known_agent

      FROM listings l
      LEFT JOIN complexes c ON l.complex_id = c.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${sortMap[sort] || sortMap.investor}
      LIMIT ${lim}
    `, params);

    res.json({
      listings: rows,
      cities: [...new Set(rows.map(r => r.city||r.complex_city).filter(Boolean))].sort(),
      sources: [...new Set(rows.map(r => r.source).filter(Boolean))].sort(),
      total: rows.length
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Mark listings as messaged
router.post('/listings/message-sent', express.json(), async (req, res) => {
  try {
    const { listing_ids, status, deal_status } = req.body;
    if (!listing_ids?.length) return res.status(400).json({ error: 'No listing IDs' });
    for (const id of listing_ids) {
      await pool.query(`UPDATE listings SET message_status=$1, last_message_sent_at=$2, deal_status=$3, updated_at=$2 WHERE id=$4`, [status||'sent', new Date(), deal_status||'contacted', id]);
    }
    res.json({ success: true, updated: listing_ids.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Get committees
router.get('/committees', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, name as complex_name, city, status, approval_date as date, deposit_date, plan_number FROM complexes ORDER BY approval_date DESC NULLS LAST, updated_at DESC LIMIT 200`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: Get all complexes (slim, for dropdowns)
router.get('/complexes', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, name, city, iai_score, signature_percent FROM complexes ORDER BY iai_score DESC NULLS LAST LIMIT 500`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/complexes/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM complexes WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/yad2/listings', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT l.*, c.name as complex_name FROM listings l LEFT JOIN complexes c ON c.id = l.complex_id WHERE l.source = 'yad2' ORDER BY l.last_seen DESC NULLS LAST LIMIT 100`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/kones/listings', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT l.*, c.name as complex_name FROM listings l LEFT JOIN complexes c ON c.id = l.complex_id WHERE l.source = 'kones' ORDER BY l.last_seen DESC NULLS LAST LIMIT 100`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// WhatsApp subscriptions
router.get('/whatsapp/subscriptions/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT COUNT(*) as "totalSubscriptions", SUM(CASE WHEN active=true THEN 1 ELSE 0 END) as "activeSubscriptions", COUNT(DISTINCT lead_id) as "uniqueLeads", COALESCE(SUM(alerts_sent),0) as "totalAlertsSent" FROM whatsapp_subscriptions`);
    res.json(rows[0] || { totalSubscriptions: 0, activeSubscriptions: 0, uniqueLeads: 0, totalAlertsSent: 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/whatsapp/subscriptions/:leadId', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM whatsapp_subscriptions WHERE lead_id=$1 ORDER BY created_at DESC', [req.params.leadId]);
    res.json(rows.map(r => ({ ...r, criteria: r.criteria ? JSON.parse(r.criteria) : {} })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/whatsapp/subscriptions/test', express.json(), async (req, res) => {
  const { leadId } = req.body;
  if (!leadId) return res.status(400).json({ error: 'Lead ID required' });
  res.json({ success: true, message: 'Test notification queued', leadId });
});

router.post('/whatsapp/subscriptions', express.json(), async (req, res) => {
  try {
    const { lead_id, criteria } = req.body;
    if (!lead_id || !criteria || !Object.keys(criteria).length) return res.status(400).json({ error: 'Criteria required' });
    const { rows } = await pool.query(`INSERT INTO whatsapp_subscriptions (lead_id, criteria, active, created_at, updated_at) VALUES ($1,$2,true,NOW(),NOW()) RETURNING *`, [lead_id, JSON.stringify(criteria)]);
    res.json({ success: true, subscription: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/whatsapp/subscriptions/:id/toggle', express.json(), async (req, res) => {
  try {
    const { rows } = await pool.query(`UPDATE whatsapp_subscriptions SET active = NOT active, updated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id]);
    res.json({ success: true, subscription: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/whatsapp/subscriptions/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM whatsapp_subscriptions WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Scheduling overview
router.get('/scheduling/overview', async (req, res) => {
  try {
    const [sess, slots, cere, contacts] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total, COUNT(CASE WHEN state='confirmed' THEN 1 END) AS confirmed, COUNT(CASE WHEN state IN ('declined','cancelled') THEN 1 END) AS declined, COUNT(CASE WHEN state NOT IN ('confirmed','declined','cancelled') THEN 1 END) AS pending, COUNT(CASE WHEN language='ru' THEN 1 END) AS russian, COUNT(CASE WHEN language='he' THEN 1 END) AS hebrew FROM bot_sessions WHERE created_at > NOW() - INTERVAL '30 days'`),
      pool.query(`SELECT COUNT(*) AS total, COUNT(CASE WHEN status='confirmed' THEN 1 END) AS confirmed, COUNT(CASE WHEN status='open' THEN 1 END) AS open, COUNT(CASE WHEN status='cancelled' THEN 1 END) AS cancelled FROM meeting_slots WHERE created_at > NOW() - INTERVAL '30 days'`).catch(()=>({rows:[{total:0,confirmed:0,open:0,cancelled:0}]})),
      pool.query(`SELECT COUNT(*) AS total, COUNT(CASE WHEN status='confirmed' THEN 1 END) AS confirmed FROM ceremony_slots WHERE slot_date >= CURRENT_DATE`).catch(()=>({rows:[{total:0,confirmed:0}]})),
      pool.query(`SELECT bs.phone, bs.context->>'contactName' AS contact_name, bs.zoho_campaign_id AS campaign_id, bs.state, bs.language, bs.last_message_at, ms.slot_datetime, TO_CHAR(ms.slot_datetime AT TIME ZONE 'Asia/Jerusalem','DD/MM/YYYY HH24:MI') AS slot_display, ms.representative_name, ms.meeting_type, csc.meeting_type AS campaign_meeting_type FROM bot_sessions bs LEFT JOIN meeting_slots ms ON ms.contact_phone=bs.phone AND ms.campaign_id=bs.zoho_campaign_id AND ms.status='confirmed' LEFT JOIN campaign_schedule_config csc ON csc.zoho_campaign_id=bs.zoho_campaign_id WHERE bs.created_at > NOW() - INTERVAL '30 days' ORDER BY bs.last_message_at DESC LIMIT 200`).catch(()=>({rows:[]}))
    ]);
    res.json({ success: true, sessions: sess.rows[0], slots: slots.rows[0], ceremonies: cere.rows[0], contacts: contacts.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Enrichment
router.post('/ads/enrich', async (req, res) => {
  try {
    const result = await enrichNewListings(parseInt(req.body?.limit) || 20);
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/ads/enrich/:id', async (req, res) => {
  try {
    const { enrichListing } = require('../services/adEnrichmentService');
    const { rows } = await pool.query('SELECT l.*, c.iai_score AS complex_iai FROM listings l LEFT JOIN complexes c ON l.complex_id=c.id WHERE l.id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Listing not found' });
    res.json({ success: true, ...(await enrichListing(rows[0])) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update phone
router.post('/ads/update-phone', express.json(), async (req, res) => {
  try {
    const { source_url, source_listing_id, phone, contact_name, source } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone is required' });
    let result = { rowCount: 0, rows: [] };
    if (source_listing_id && source) {
      const r = await pool.query(`UPDATE listings SET phone=$1, contact_name=COALESCE($2,contact_name), last_seen=CURRENT_DATE WHERE source=$3 AND source_listing_id=$4 AND (phone IS NULL OR phone='') RETURNING id,source,source_listing_id,phone,contact_name`, [phone, contact_name||null, source, source_listing_id]);
      if (r.rowCount > 0) result = r;
    }
    if (result.rowCount === 0 && source_url) {
      const r = await pool.query(`UPDATE listings SET phone=$1, contact_name=COALESCE($2,contact_name), last_seen=CURRENT_DATE WHERE url=$3 AND (phone IS NULL OR phone='') RETURNING id,source,source_listing_id,phone,contact_name`, [phone, contact_name||null, source_url]);
      if (r.rowCount > 0) result = r;
    }
    res.json({ success: true, updated: result.rowCount, rows: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk insert from extension
router.post('/ads/bulk-insert', express.json(), async (req, res) => {
  try {
    const { listings } = req.body;
    if (!Array.isArray(listings)) return res.status(400).json({ error: 'listings array required' });
    let inserted = 0, updated = 0;
    const newListingIds = [];
    for (const l of listings) {
      if (!l.source || !l.url) continue;
      try {
        const r = await pool.query(
          `INSERT INTO listings (source,source_listing_id,url,phone,contact_name,asking_price,rooms,area_sqm,floor,address,city,description_snippet,first_seen,last_seen,is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CURRENT_DATE,CURRENT_DATE,TRUE) ON CONFLICT (source,source_listing_id) WHERE source_listing_id IS NOT NULL DO UPDATE SET phone=COALESCE(EXCLUDED.phone,listings.phone), contact_name=COALESCE(EXCLUDED.contact_name,listings.contact_name), asking_price=COALESCE(EXCLUDED.asking_price,listings.asking_price), last_seen=CURRENT_DATE RETURNING id,(xmax=0) as is_new`,
          [l.source, l.source_listing_id||l.url, l.url, l.phone||null, l.contact_name||null, l.price?parseFloat(l.price):null, l.rooms?parseFloat(l.rooms):null, l.area?parseFloat(l.area):null, l.floor?parseInt(l.floor):null, l.address||null, l.city||null, (l.description||'').substring(0,500)]
        );
        if (r.rows[0]?.is_new) { inserted++; newListingIds.push(r.rows[0].id); } else updated++;
      } catch(e) { console.error('[bulk-insert] Row error:', e.message); }
    }
    res.json({ success: true, inserted, updated, total: listings.length });
    if (newListingIds.length > 0) {
      setImmediate(async () => {
        try {
          const { enrichListing } = require('../services/adEnrichmentService');
          for (const lid of newListingIds) {
            try {
              const { rows } = await pool.query(`SELECT l.id, l.address, l.city, l.asking_price, l.area_sqm, l.rooms, l.floor, l.description_snippet, l.title, l.source, l.phone, COALESCE(c.iai_score, 0) as iai_score FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id WHERE l.id = $1`, [lid]);
              if (rows[0]) await enrichListing(rows[0]);
            } catch(e) { /* ignore */ }
          }
        } catch(e) { /* ignore */ }
      });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Diagnostic endpoint
router.get('/ads/diag', async (req, res) => {
  try {
    const idx = await pool.query(`SELECT indexname FROM pg_indexes WHERE tablename='listings' AND indexname='idx_listings_source_id'`);
    const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='listings' ORDER BY ordinal_position`);
    const ts = Date.now();
    let insertErr = null, insertResult = null;
    try {
      const r = await pool.query(`INSERT INTO listings (source,source_listing_id,url,description_snippet,first_seen,last_seen,is_active) VALUES ($1,$2,$3,$4,CURRENT_DATE,CURRENT_DATE,TRUE) ON CONFLICT (source,source_listing_id) WHERE source_listing_id IS NOT NULL DO UPDATE SET last_seen=CURRENT_DATE RETURNING id,(xmax=0) as is_new`, ['diag_test', `diag_${ts}`, `https://diag.test/${ts}`, 'test']);
      insertResult = r.rows[0];
    } catch(e) { insertErr = e.message; }
    res.json({ unique_index_exists: idx.rows.length > 0, columns: cols.rows.map(r=>r.column_name), insert_test: insertResult, insert_error: insertErr });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
