/**
 * phoneRevealOrchestrator.js
 *
 * 5-Pass phone enrichment strategy for all platforms.
 * Runs passes in order of cost (cheapest first), stops when phone found.
 *
 * Pass 1: Regex extraction from description/title           → FREE, instant
 * Pass 2: Komo open phone API (showPhoneDetails)            → FREE, ~80% hit rate
 * Pass 3: yad2 direct phone API (/phone endpoint)           → FREE, opportunistic
 * Pass 4: Direct page scraping (dira, homeless, yad1, etc.) → FREE, bypasses simple sites
 * Pass 5: Apify Actor with residential proxies              → ~$0.005/listing, handles Cloudflare
 *
 * Exposed endpoints (added to scan.js):
 *   POST /api/scan/enrich-phones-v2   { limit, useApify, sources }
 *   GET  /api/scan/phone-coverage
 */

const pool   = require('../db/pool');
const axios  = require('axios');
const { logger } = require('./logger');

// ─────────────────────────────────────────────
// Pass 1: Regex from description / title
// ─────────────────────────────────────────────
const PHONE_REGEX = /(?:0(?:5[0-9]|[2-9]|7[2-9])[- ]?\d{3}[- ]?\d{4}|0[2-9][- ]?\d{7})/g;

function extractPhoneFromText(text) {
  if (!text) return null;
  const matches = text.match(PHONE_REGEX);
  if (!matches) return null;
  const cleaned = matches[0].replace(/[- ]/g, '');
  return cleaned.length >= 9 && cleaned.length <= 11 ? cleaned : null;
}

async function passRegex(listings) {
  let found = 0;
  for (const l of listings) {
    const phone = extractPhoneFromText(l.description) || extractPhoneFromText(l.title);
    if (phone) {
      await pool.query(`UPDATE listings SET phone = $1, updated_at = NOW() WHERE id = $2`, [phone, l.id]);
      l._resolved = true;
      found++;
    }
  }
  logger.info(`[PhoneV2] Pass 1 (Regex): ${found}/${listings.length} found`);
  return found;
}

// ─────────────────────────────────────────────
// Pass 2: Komo showPhoneDetails API
// ─────────────────────────────────────────────
async function passKomoApi(listings) {
  const komoListings = listings.filter(l => !l._resolved && l.source === 'komo' && l.external_id);
  let found = 0;

  for (const l of komoListings) {
    try {
      const res = await axios.get(
        `https://www.komo.co.il/api/ad/showPhoneDetails?adId=${l.external_id}`,
        { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.komo.co.il/' } }
      );
      const phone = res.data?.phone || res.data?.contactPhone || res.data?.sellerPhone;
      if (phone) {
        const cleaned = String(phone).replace(/[- ]/g, '');
        await pool.query(`UPDATE listings SET phone = $1, updated_at = NOW() WHERE id = $2`, [cleaned, l.id]);
        l._resolved = true;
        found++;
      }
    } catch (err) {
      // silently skip — Komo may rate-limit
    }
    await new Promise(r => setTimeout(r, 300));
  }

  logger.info(`[PhoneV2] Pass 2 (Komo API): ${found}/${komoListings.length} found`);
  return found;
}

// ─────────────────────────────────────────────
// Pass 3: yad2 direct phone API
// ─────────────────────────────────────────────
async function passYad2Api(listings) {
  const yad2Listings = listings.filter(l => !l._resolved && l.source === 'yad2' && l.external_id);
  let found = 0;

  for (const l of yad2Listings) {
    try {
      const res = await axios.get(
        `https://gw.yad2.co.il/feed-search-legacy/realestate/forsale/${l.external_id}/phone`,
        {
          timeout: 8000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json',
            'mobile-app': 'false'
          }
        }
      );
      const phone = res.data?.data?.phone || res.data?.phone;
      if (phone) {
        const cleaned = String(phone).replace(/[- ]/g, '');
        await pool.query(`UPDATE listings SET phone = $1, updated_at = NOW() WHERE id = $2`, [cleaned, l.id]);
        l._resolved = true;
        found++;
      }
    } catch (err) {
      // yad2 may block — skip
    }
    await new Promise(r => setTimeout(r, 500));
  }

  logger.info(`[PhoneV2] Pass 3 (yad2 API): ${found}/${yad2Listings.length} found`);
  return found;
}

// ─────────────────────────────────────────────
// Pass 4: Direct page scraping for simple sites
// ─────────────────────────────────────────────
async function passDirectScrape(listings) {
  const scrapable = listings.filter(l => !l._resolved && l.url &&
    ['dira', 'homeless', 'yad1', 'banknadlan', 'winwin'].includes(l.source));
  let found = 0;

  for (const l of scrapable) {
    try {
      const res = await axios.get(l.url, {
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      const phone = extractPhoneFromText(res.data);
      if (phone) {
        await pool.query(`UPDATE listings SET phone = $1, updated_at = NOW() WHERE id = $2`, [phone, l.id]);
        l._resolved = true;
        found++;
      }
    } catch (err) {
      // skip — site may block
    }
    await new Promise(r => setTimeout(r, 400));
  }

  logger.info(`[PhoneV2] Pass 4 (Direct Scrape): ${found}/${scrapable.length} found`);
  return found;
}

// ─────────────────────────────────────────────
// Pass 5: Apify Actor (residential proxies)
// ─────────────────────────────────────────────
async function passApify(listings) {
  const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
  if (!APIFY_TOKEN) {
    logger.warn('[PhoneV2] Pass 5 (Apify): APIFY_API_TOKEN not set — skipping');
    return 0;
  }

  const unresolved = listings.filter(l => !l._resolved && l.url);
  if (!unresolved.length) return 0;

  const ACTOR_ID = process.env.APIFY_PHONE_REVEAL_ACTOR || 'apify/web-scraper';

  try {
    // Start Apify run
    const runRes = await axios.post(
      `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
      {
        startUrls: unresolved.map(l => ({ url: l.url, metadata: { id: l.id, source: l.source } })),
        pageFunction: `async function pageFunction(context) {
          const { page, request } = context;
          const text = await page.content();
          const match = text.match(/0(?:5[0-9]|[2-9]|7[2-9])[- ]?\\d{3}[- ]?\\d{4}|0[2-9][- ]?\\d{7}/);
          return { id: request.userData.id, phone: match ? match[0].replace(/[- ]/g,'') : null };
        }`,
        proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }
      },
      { timeout: 15000 }
    );

    const runId = runRes.data?.data?.id;
    if (!runId) return 0;

    // Poll for completion (max 5 minutes)
    let status = 'RUNNING';
    let attempts = 0;
    while (status === 'RUNNING' && attempts < 30) {
      await new Promise(r => setTimeout(r, 10000));
      const statusRes = await axios.get(
        `https://api.apify.com/v2/acts/${ACTOR_ID}/runs/${runId}?token=${APIFY_TOKEN}`,
        { timeout: 10000 }
      );
      status = statusRes.data?.data?.status;
      attempts++;
    }

    if (status !== 'SUCCEEDED') {
      logger.warn(`[PhoneV2] Pass 5 (Apify): run ${runId} ended with status ${status}`);
      return 0;
    }

    // Fetch results
    const dataRes = await axios.get(
      `https://api.apify.com/v2/acts/${ACTOR_ID}/runs/${runId}/dataset/items?token=${APIFY_TOKEN}`,
      { timeout: 15000 }
    );

    let found = 0;
    for (const item of (dataRes.data || [])) {
      if (item.id && item.phone) {
        await pool.query(`UPDATE listings SET phone = $1, updated_at = NOW() WHERE id = $2`, [item.phone, item.id]);
        found++;
      }
    }

    logger.info(`[PhoneV2] Pass 5 (Apify): ${found}/${unresolved.length} found`);
    return found;

  } catch (err) {
    logger.warn(`[PhoneV2] Pass 5 (Apify) error: ${err.message}`);
    return 0;
  }
}

// ─────────────────────────────────────────────
// Main orchestrator
// ─────────────────────────────────────────────
async function enrichPhonesV2({ limit = 500, useApify = false, sources = null } = {}) {
  const startTime = Date.now();

  // Fetch listings without phone
  let query = `
    SELECT id, source, external_id, url, description, title
    FROM listings
    WHERE (phone IS NULL OR phone = '')
      AND is_active = TRUE
  `;
  const params = [];
  if (sources && sources.length) {
    params.push(sources);
    query += ` AND source = ANY($${params.length}::text[])`;
  }
  query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);

  const { rows: listings } = await pool.query(query, params);

  if (!listings.length) {
    return { total: 0, found: 0, passes: {}, duration_ms: 0 };
  }

  logger.info(`[PhoneV2] Starting 5-pass enrichment for ${listings.length} listings`);

  const passes = {};

  passes.regex    = await passRegex(listings);
  passes.komo_api = await passKomoApi(listings);
  passes.yad2_api = await passYad2Api(listings);
  passes.scrape   = await passDirectScrape(listings);

  if (useApify) {
    passes.apify = await passApify(listings);
  }

  const totalFound = Object.values(passes).reduce((a, b) => a + b, 0);
  const duration   = Date.now() - startTime;

  logger.info(`[PhoneV2] Complete: ${totalFound}/${listings.length} phones found in ${Math.round(duration/1000)}s`);

  return {
    total:       listings.length,
    found:       totalFound,
    coverage_pct: listings.length > 0 ? Math.round((totalFound / listings.length) * 100) : 0,
    passes,
    duration_ms: duration
  };
}

// ─────────────────────────────────────────────
// Phone coverage stats
// ─────────────────────────────────────────────
async function getPhoneCoverage() {
  const { rows } = await pool.query(`
    SELECT
      source,
      COUNT(*) AS total_listings,
      COUNT(phone) FILTER (WHERE phone IS NOT NULL AND phone != '') AS with_phone,
      COUNT(*) FILTER (WHERE phone IS NULL OR phone = '') AS without_phone,
      ROUND(
        COUNT(phone) FILTER (WHERE phone IS NOT NULL AND phone != '')::numeric
        / NULLIF(COUNT(*), 0) * 100, 1
      ) AS coverage_pct
    FROM listings
    WHERE is_active = TRUE
    GROUP BY source
    ORDER BY total_listings DESC
  `);

  const totals = rows.reduce((acc, r) => {
    acc.total_listings  += Number(r.total_listings);
    acc.with_phone      += Number(r.with_phone);
    acc.without_phone   += Number(r.without_phone);
    return acc;
  }, { total_listings: 0, with_phone: 0, without_phone: 0 });

  totals.coverage_pct = totals.total_listings > 0
    ? Math.round((totals.with_phone / totals.total_listings) * 100)
    : 0;

  return { by_source: rows, totals };
}

module.exports = { enrichPhonesV2, getPhoneCoverage };
