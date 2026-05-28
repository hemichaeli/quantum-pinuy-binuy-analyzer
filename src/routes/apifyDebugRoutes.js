// Diagnostic endpoint for the Apify phone-reveal 403 outage.
// Isolates whether the problem is:
//   (a) token invalid          → /users/me returns 401
//   (b) account out of credits → /users/me 200, "monthlyUsageUsd" near limit
//   (c) actor access revoked   → /users/me 200 but /acts/<id> returns 403/404
// Never echoes the token itself. Mounted at /api/debug.

const express = require('express');
const axios = require('axios');
const router = express.Router();
const { logger } = require('../services/logger');

const APIFY_BASE = 'https://api.apify.com/v2';

// Count of active listings without a phone, broken down by source. Used to
// size the pay-as-you-go cost of clearing the entire backlog in one go.
router.get('/phone-backlog', async (req, res) => {
  const pool = require('../db/pool');
  try {
    const { rows } = await pool.query(`
      SELECT source, COUNT(*)::int AS missing_phone
      FROM listings
      WHERE is_active = TRUE
        AND (phone IS NULL OR phone = '' OR phone = 'NULL')
      GROUP BY source
      ORDER BY missing_phone DESC
    `);
    const total = rows.reduce((sum, r) => sum + r.missing_phone, 0);
    const CENTS_PER_PHONE = 2.7; // measured 2026-05-23: $29.52 / 1,094
    return res.json({
      ok: true,
      total_missing_phone: total,
      by_source: rows,
      cost_estimate: {
        per_phone_usd: CENTS_PER_PHONE / 100,
        total_usd: +(total * CENTS_PER_PHONE / 100).toFixed(2),
        note: 'Based on 2026-05-23 burn: 1,094 phones / $29.52. Residential proxy dominates ($8/GB, ~3MB per phone). Actual could vary ±20%.'
      },
      daily_cap_runway_days: Math.ceil(total / parseInt(process.env.APIFY_DAILY_CAP || '50', 10))
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Today's Apify usage row — diagnostic for the daily cap.
router.get('/apify-today', async (req, res) => {
  const pool = require('../db/pool');
  try {
    const { rows } = await pool.query(
      `SELECT day, phones_attempted, phones_succeeded, updated_at
       FROM apify_daily_usage WHERE day = CURRENT_DATE`
    );
    return res.json({
      ok: true,
      today: rows[0] || { day: new Date().toISOString().slice(0, 10), phones_attempted: 0, phones_succeeded: 0 },
      daily_cap: parseInt(process.env.APIFY_DAILY_CAP || '50', 10),
      budget_brake_usd: parseFloat(process.env.APIFY_BUDGET_BRAKE_USD || '25')
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// When does the monthly budget reset?
// Apify exposes the current billing period via /v2/users/me/usage/monthly.
router.get('/apify-cycle', async (req, res) => {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) return res.status(500).json({ ok: false, error: 'APIFY_API_TOKEN not set' });

  try {
    const r = await axios.get(`${APIFY_BASE}/users/me/usage/monthly`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
      validateStatus: () => true
    });
    return res.json({
      ok: r.status === 200,
      status: r.status,
      data: r.data?.data || r.data,
      hint: 'periodEnd / billingCycleEnd is when the $29 hard cap resets'
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/apify-status', async (req, res) => {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    return res.status(500).json({ ok: false, error: 'APIFY_API_TOKEN not set' });
  }

  const actorId = (process.env.APIFY_PHONE_REVEAL_ACTOR || 'quantum-phone-reveal').replace('/', '~');
  const result = {
    ok: true,
    tokenLength: token.length,
    tokenPrefix: token.slice(0, 6) + '…',
    actorId,
    me: null,
    actor: null,
    runDryHead: null
  };

  // 1) /users/me — is the token still valid?
  try {
    const r = await axios.get(`${APIFY_BASE}/users/me`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
      validateStatus: () => true
    });
    result.me = {
      status: r.status,
      username: r.data?.data?.username || null,
      plan: r.data?.data?.plan || null,
      monthlyUsageUsd: r.data?.data?.usage?.monthlyUsageUsd ?? null,
      monthlyLimitUsd: r.data?.data?.limits?.maxMonthlyUsageUsd ?? null,
      body: r.status >= 400 ? r.data : undefined
    };
  } catch (err) {
    result.me = { status: 'network_error', error: err.message };
  }

  // 2) /acts/<actorId> — is the actor still accessible to this account?
  try {
    const r = await axios.get(`${APIFY_BASE}/acts/${actorId}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
      validateStatus: () => true
    });
    result.actor = {
      status: r.status,
      name: r.data?.data?.name || null,
      isPublic: r.data?.data?.isPublic ?? null,
      isDeprecated: r.data?.data?.isDeprecated ?? null,
      pricingInfo: r.data?.data?.pricingInfos?.[0] || null,
      body: r.status >= 400 ? r.data : undefined
    };
  } catch (err) {
    result.actor = { status: 'network_error', error: err.message };
  }

  // 3) HEAD on the run endpoint we actually call — same 403 surface as production
  try {
    const r = await axios.post(
      `${APIFY_BASE}/acts/${actorId}/runs`,
      { adUrls: [], waitForFinish: 0 },
      {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 10000,
        validateStatus: () => true
      }
    );
    result.runDryHead = {
      status: r.status,
      body: r.status >= 400 ? r.data : { id: r.data?.data?.id }
    };
    // If a run somehow got created, abort it immediately so we don't burn credits.
    if (r.data?.data?.id) {
      await axios.post(
        `${APIFY_BASE}/actor-runs/${r.data.data.id}/abort`,
        {},
        { headers: { Authorization: `Bearer ${token}` }, timeout: 5000, validateStatus: () => true }
      ).catch(() => null);
    }
  } catch (err) {
    result.runDryHead = { status: 'network_error', error: err.message };
  }

  logger.info('[apify-debug] status check', result);
  res.json(result);
});

// Breakdown of listings by source × complex-bound vs orphan, to size the
// pinuy-binuy-only cleanup. Counts only is_active=TRUE rows.
router.get('/listings-by-complex-bound', async (req, res) => {
  const pool = require('../db/pool');
  try {
    const { rows } = await pool.query(`
      SELECT
        source,
        COUNT(*) FILTER (WHERE complex_id IS NOT NULL)                                            AS bound,
        COUNT(*) FILTER (WHERE complex_id IS NULL)                                                AS orphan,
        COUNT(*) FILTER (WHERE complex_id IS NOT NULL AND (phone IS NULL OR phone='' OR phone='NULL')) AS bound_missing_phone,
        COUNT(*) FILTER (WHERE complex_id IS NULL     AND (phone IS NULL OR phone='' OR phone='NULL')) AS orphan_missing_phone,
        COUNT(*)::int AS total
      FROM listings
      WHERE is_active = TRUE
      GROUP BY source
      ORDER BY total DESC
    `);
    const summary = rows.reduce(
      (a, r) => ({
        bound: a.bound + Number(r.bound),
        orphan: a.orphan + Number(r.orphan),
        bound_missing_phone: a.bound_missing_phone + Number(r.bound_missing_phone),
        orphan_missing_phone: a.orphan_missing_phone + Number(r.orphan_missing_phone),
        total: a.total + Number(r.total),
      }),
      { bound: 0, orphan: 0, bound_missing_phone: 0, orphan_missing_phone: 0, total: 0 }
    );
    return res.json({
      ok: true,
      summary,
      by_source: rows,
      hint: 'orphan = no complex_id, candidates for archiving. bound_missing_phone is the real Apify enrichment target.'
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Token-format diagnostic. Compares our stored source_listing_id values for
// yad2 listings against the token Swerve returns inside /item/{token} URLs,
// so we can see why integration matched 0/12 today despite Swerve POC = 100%.
router.get('/yad2-token-sample', async (req, res) => {
  const pool = require('../db/pool');
  const token = process.env.APIFY_API_TOKEN;
  if (!token) return res.status(500).json({ ok: false, error: 'APIFY_API_TOKEN not set' });
  const city = req.query.city || 'Tel Aviv';

  try {
    // Our DB sample for the city
    const { rows: ours } = await pool.query(`
      SELECT id, source_listing_id, url, address
      FROM listings
      WHERE is_active = TRUE AND source = 'yad2' AND city ILIKE $1
        AND (phone IS NULL OR phone = '' OR phone = 'NULL')
      ORDER BY id DESC
      LIMIT 10
    `, [`%${city}%`]);

    // Swerve sample for the same city
    const r = await axios.post(
      'https://api.apify.com/v2/acts/swerve~yad2-scraper/run-sync-get-dataset-items',
      { city, dealType: 'buy', maxItems: 10, enrichListings: false },
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 120000,
        params: { timeout: 110 },
        validateStatus: () => true,
      }
    );
    const swerveItems = Array.isArray(r.data) ? r.data : [];
    const swerveSample = swerveItems.slice(0, 10).map(i => {
      const m = String(i?.url || '').match(/\/item\/([A-Za-z0-9]+)/);
      return { token: m ? m[1] : null, url: i?.url, id_field: i?.id || null };
    });

    return res.json({
      ok: true,
      city,
      our_listings: ours.map(o => ({
        id: o.id,
        source_listing_id: o.source_listing_id,
        url: o.url,
        url_token: (String(o.url || '').match(/\/item\/([A-Za-z0-9]+)/) || [])[1] || null,
        address: o.address
      })),
      swerve_sample: swerveSample,
      hint: 'Compare our source_listing_id and url_token to swerve_sample.token. The matcher in runApifyPhoneReveal uses source_listing_id lowercased.'
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POC for swerve/yad2-scraper as replacement actor.
// Costs ~$0.025 per call (5 listings × $5/1000). Returns phone-enriched samples
// so we can verify the new actor produces real phones before refactoring.
router.get('/swerve-poc', async (req, res) => {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) return res.status(500).json({ ok: false, error: 'APIFY_API_TOKEN not set' });
  const city = req.query.city || 'Tel Aviv';
  const maxItems = Math.min(parseInt(req.query.max || '5', 10), 10);
  const dealType = req.query.dealType || 'buy';

  const input = { city, dealType, maxItems, enrichListings: true };
  const t0 = Date.now();
  try {
    const r = await axios.post(
      'https://api.apify.com/v2/acts/swerve~yad2-scraper/run-sync-get-dataset-items',
      input,
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 120000,
        params: { timeout: 110 },
        validateStatus: () => true,
      }
    );
    const elapsedMs = Date.now() - t0;
    const items = Array.isArray(r.data) ? r.data : [];
    const withPhone = items.filter(i => i?.contactPhone || i?.phone).length;
    return res.json({
      ok: r.status >= 200 && r.status < 300,
      httpStatus: r.status,
      elapsedMs,
      input,
      items_count: items.length,
      items_with_phone: withPhone,
      success_rate: items.length ? `${Math.round(100 * withPhone / items.length)}%` : 'N/A',
      sample_items: items.slice(0, 5).map(i => ({
        source_listing_id: i?.id || i?.adNumber || i?.token || null,
        city: i?.city,
        address: i?.address || i?.street,
        price: i?.price,
        rooms: i?.rooms,
        contactPhone: i?.contactPhone || null,
        contactName: i?.contactName || null,
        url: i?.url
      })),
      estimated_cost_usd: +(items.length * 0.005).toFixed(3),
      error_body: r.status >= 400 ? r.data : null
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Complexes-table snapshot: how many complexes do we have, how many have
// usable addresses, what does the address field actually contain? Drives
// the "match against authoritative complex addresses" pivot.
router.get('/complexes-coverage', async (req, res) => {
  const pool = require('../db/pool');
  try {
    // addresses is TEXT not an array — could be JSON, comma-separated, or
    // single line. Inspect raw column type + raw samples first.
    const { rows: colInfo } = await pool.query(`
      SELECT column_name, data_type, udt_name
      FROM information_schema.columns
      WHERE table_name = 'complexes' AND column_name IN ('addresses', 'neighborhood', 'city', 'name')
    `);
    const { rows: summary } = await pool.query(`
      SELECT
        COUNT(*)::int                                                                      AS total,
        COUNT(*) FILTER (WHERE addresses IS NOT NULL AND length(addresses::text) > 0)::int AS with_addresses_raw,
        COUNT(*) FILTER (WHERE neighborhood IS NOT NULL AND neighborhood <> '')::int       AS with_neighborhood,
        COUNT(DISTINCT city)::int                                                          AS distinct_cities
      FROM complexes
    `);
    const { rows: byCity } = await pool.query(`
      SELECT city,
             COUNT(*)::int AS complexes,
             COUNT(*) FILTER (WHERE addresses IS NOT NULL AND length(addresses::text) > 0)::int AS with_addresses
      FROM complexes
      GROUP BY city
      ORDER BY complexes DESC
      LIMIT 25
    `);
    const { rows: samples } = await pool.query(`
      SELECT id, city, neighborhood, name, addresses
      FROM complexes
      ORDER BY id
      LIMIT 5
    `);
    res.json({ ok: true, column_info: colInfo, summary: summary[0], by_city: byCity, samples });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Heat-tier distribution across complexes. Drives Swerve scan prioritization
// so we spend the Apify budget on the deals closest to closing.
//
// Tier formula:
//   5  approval_date   IS NOT NULL OR signature_percent >= 85
//   4  deposit_date    IS NOT NULL OR signature_percent >= 65
//   3  submission_date IS NOT NULL OR signature_percent >= 45
//   2  declaration_date IS NOT NULL OR signature_percent >= 25
//   1  otherwise
// Bonus: multiplier >= 2.5 → +1 tier (capped at 5)
router.get('/complexes-heat', async (req, res) => {
  const pool = require('../db/pool');
  try {
    const heatSql = `
      LEAST(5,
        CASE
          WHEN approval_date    IS NOT NULL OR signature_percent >= 85 THEN 5
          WHEN deposit_date     IS NOT NULL OR signature_percent >= 65 THEN 4
          WHEN submission_date  IS NOT NULL OR signature_percent >= 45 THEN 3
          WHEN declaration_date IS NOT NULL OR signature_percent >= 25 THEN 2
          ELSE 1
        END
        + CASE WHEN multiplier >= 2.5 THEN 1 ELSE 0 END
      )
    `;
    const { rows: dist } = await pool.query(`
      SELECT ${heatSql} AS heat_tier, COUNT(*)::int AS complexes
      FROM complexes
      GROUP BY heat_tier
      ORDER BY heat_tier DESC
    `);
    const { rows: byCity } = await pool.query(`
      SELECT city,
             SUM(CASE WHEN ${heatSql} = 5 THEN 1 ELSE 0 END)::int AS tier5,
             SUM(CASE WHEN ${heatSql} = 4 THEN 1 ELSE 0 END)::int AS tier4,
             SUM(CASE WHEN ${heatSql} = 3 THEN 1 ELSE 0 END)::int AS tier3,
             SUM(CASE WHEN ${heatSql} = 2 THEN 1 ELSE 0 END)::int AS tier2,
             SUM(CASE WHEN ${heatSql} = 1 THEN 1 ELSE 0 END)::int AS tier1,
             COUNT(*)::int                                       AS total
      FROM complexes
      GROUP BY city
      ORDER BY tier5 DESC, tier4 DESC, total DESC
      LIMIT 30
    `);
    const { rows: hottest } = await pool.query(`
      SELECT id, name, city, neighborhood,
             ${heatSql}::int  AS heat_tier,
             multiplier, signature_percent,
             (approval_date IS NOT NULL)    AS has_approval,
             (deposit_date IS NOT NULL)     AS has_deposit,
             (submission_date IS NOT NULL)  AS has_submission,
             (declaration_date IS NOT NULL) AS has_declaration
      FROM complexes
      ORDER BY ${heatSql} DESC, multiplier DESC NULLS LAST, signature_percent DESC NULLS LAST
      LIMIT 15
    `);
    res.json({ ok: true, distribution: dist, by_city: byCity, top_15_hottest: hottest });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ───── Swerve backlog drain ─────
// One-time bulk operation that scrapes Swerve per city and fuzzy-matches
// results against our bound-missing-phone backlog. Returns a job id; poll
// /api/debug/swerve-drain/:jobId for status.
router.post('/swerve-drain', async (req, res) => {
  const drain = require('../services/swerveBacklogDrain');
  const {
    dryRun = false,
    maxGroups = 50,
    cityFilter = null,
    perGroupCap = 100,
    useNeighborhood = true,
  } = req.body || {};
  try {
    const { jobId } = await drain.runSwerveDrain({ dryRun, maxGroups, cityFilter, perGroupCap, useNeighborhood });
    res.json({ ok: true, jobId, dryRun, maxGroups, cityFilter, perGroupCap, useNeighborhood });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/swerve-drain/:jobId', (req, res) => {
  const drain = require('../services/swerveBacklogDrain');
  const job = drain.getDrainStatus(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: 'job not found' });
  res.json({ ok: true, job });
});

router.get('/swerve-drain-jobs', (req, res) => {
  const drain = require('../services/swerveBacklogDrain');
  res.json({ ok: true, jobs: drain.listDrainJobs() });
});

module.exports = router;
