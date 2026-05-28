// One-time backlog drain via swerve/yad2-scraper.
//
// Context (2026-05-28): we have 2,372 active listings with complex_id but
// without phone. Their stored source_listing_id is a search URL (from the
// Perplexity discovery bot), not a per-item yad2 token, so token-based
// matching against Swerve fails. This service does ADDRESS-based fuzzy
// matching instead: scrape each city once, then match Swerve items to our
// rows by normalized street name + house-number proximity. Successful
// matches get the phone + the recovered source_listing_id token written
// back, which lets future Swerve runs hit the cheap token path.

const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

const APIFY_BASE = 'https://api.apify.com/v2';
const SWERVE_ACTOR = 'swerve~yad2-scraper';
const PER_PHONE_USD = 0.005; // measured

// ───── Address normalization & fuzzy match ─────

// Common Hebrew street-type prefixes that we want to drop before comparing.
const STREET_PREFIX_RE = /^(רחוב|רח'|שדרות|שד'|דרך|סמטת|כיכר|טיילת)\s+/;

function normalizeAddress(addr) {
  if (!addr) return { street: '', numbers: [] };
  let s = String(addr).trim();
  // Drop neighborhood / city tail after comma, keep first segment.
  s = s.split(',')[0].trim();
  s = s.replace(STREET_PREFIX_RE, '');
  // Collect all numbers (e.g. "55-57" → [55, 56, 57]; "121" → [121]).
  const numbers = [];
  const numMatches = s.matchAll(/(\d+)(?:\s*-\s*(\d+))?/g);
  for (const m of numMatches) {
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    for (let n = Math.min(a, b); n <= Math.max(a, b); n++) numbers.push(n);
  }
  // Strip numbers + punctuation to get the street name.
  const street = s.replace(/\d+\s*-?\s*\d*/g, '').replace(/[",'"׳״]/g, '').trim();
  return { street: street.toLowerCase(), numbers };
}

// Quick Jaro-Winkler — good enough for Hebrew street comparisons.
function jaroWinkler(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const matchDist = Math.floor(Math.max(a.length, b.length) / 2) - 1;
  const aMatch = new Array(a.length).fill(false);
  const bMatch = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchDist);
    const end = Math.min(i + matchDist + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatch[j]) continue;
      if (a[i] !== b[j]) continue;
      aMatch[i] = true; bMatch[j] = true; matches++; break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0, k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;
  // Winkler boost for common prefix up to 4 chars.
  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++; else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

function isAddressMatch(ours, theirs) {
  const A = normalizeAddress(ours);
  const B = normalizeAddress(theirs);
  if (!A.street || !B.street) return false;
  // Street name similarity.
  const sim = jaroWinkler(A.street, B.street);
  if (sim < 0.85) return false;
  // House-number overlap (or skip if either side has no number).
  if (A.numbers.length === 0 || B.numbers.length === 0) return sim >= 0.95;
  const set = new Set(A.numbers);
  for (const n of B.numbers) {
    if (set.has(n) || set.has(n - 1) || set.has(n + 1)) return true;
  }
  return false;
}

// ───── Swerve API ─────

async function fetchSwerveCity(city, dealType, maxItems) {
  const t0 = Date.now();
  const resp = await axios.post(
    `${APIFY_BASE}/acts/${SWERVE_ACTOR}/run-sync-get-dataset-items`,
    { city, dealType, maxItems, enrichListings: true },
    {
      headers: { Authorization: `Bearer ${process.env.APIFY_API_TOKEN}` },
      timeout: 600000,
      params: { timeout: 580 },
      validateStatus: () => true,
    }
  );
  const elapsed = Date.now() - t0;
  if (resp.status >= 400) {
    logger.warn(`[SwerveDrain] ${city}/${dealType} HTTP ${resp.status}: ${JSON.stringify(resp.data).slice(0, 200)}`);
    return { items: [], elapsed, error: resp.data };
  }
  return { items: Array.isArray(resp.data) ? resp.data : [], elapsed, error: null };
}

// ───── Main drain ─────

const _runs = new Map(); // jobId → { status, stats, startedAt, finishedAt }

async function runSwerveDrain({ dryRun = false, maxCities = 50, cityFilter = null, perCityCap = 200 } = {}) {
  const jobId = `drain_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const job = {
    status: 'running',
    startedAt: new Date().toISOString(),
    stats: {
      backlog_total: 0,
      cities_processed: 0,
      cities_total: 0,
      items_fetched: 0,
      matched: 0,
      not_matched: 0,
      no_phone: 0,
      estimated_cost_usd: 0,
      per_city: {},
    },
  };
  _runs.set(jobId, job);

  (async () => {
    try {
      const { rows: backlog } = await pool.query(`
        SELECT id, city, address, complex_id, source_listing_id, url
        FROM listings
        WHERE is_active = TRUE
          AND complex_id IS NOT NULL
          AND (phone IS NULL OR phone = '' OR phone = 'NULL')
          AND city IS NOT NULL AND city <> ''
          AND address IS NOT NULL AND address <> ''
          ${cityFilter ? `AND city = '${String(cityFilter).replace(/'/g, "''")}'` : ''}
      `);
      job.stats.backlog_total = backlog.length;

      // Group by city, sorted desc by city backlog size.
      const byCity = {};
      for (const l of backlog) {
        if (!byCity[l.city]) byCity[l.city] = [];
        byCity[l.city].push(l);
      }
      const cities = Object.entries(byCity)
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, maxCities)
        .map(([c]) => c);
      job.stats.cities_total = cities.length;

      logger.info(`[SwerveDrain] Job ${jobId}: ${backlog.length} listings across ${cities.length} cities (dryRun=${dryRun})`);

      for (const city of cities) {
        const cityRows = byCity[city];
        const maxItems = Math.min(perCityCap, Math.max(50, cityRows.length * 3));
        const cityStats = { backlog: cityRows.length, items: 0, matched: 0 };
        job.stats.per_city[city] = cityStats;

        const { items, error } = await fetchSwerveCity(city, 'buy', maxItems);
        cityStats.items = items.length;
        job.stats.items_fetched += items.length;
        job.stats.estimated_cost_usd += items.length * PER_PHONE_USD;

        if (error) {
          cityStats.error = error?.error?.message || String(error).slice(0, 100);
          job.stats.cities_processed++;
          continue;
        }

        // Match each Swerve item against our city rows
        for (const item of items) {
          if (!item || !item.contactPhone) { job.stats.no_phone++; continue; }
          let matched = null;
          for (const ours of cityRows) {
            if (ours._matched) continue;
            if (isAddressMatch(ours.address, item.address)) { matched = ours; break; }
          }
          if (!matched) { job.stats.not_matched++; continue; }
          matched._matched = true;
          cityStats.matched++;
          job.stats.matched++;

          if (!dryRun) {
            // Extract token from Swerve URL so future runs use the cheap token path.
            const m = String(item.url || '').match(/\/item\/([A-Za-z0-9]+)/);
            const token = m ? m[1] : null;
            await pool.query(
              `UPDATE listings
                 SET phone = $1,
                     contact_name = COALESCE($2, contact_name),
                     source_listing_id = COALESCE($3, source_listing_id),
                     updated_at = NOW()
               WHERE id = $4`,
              [item.contactPhone, item.contactName || null, token, matched.id]
            );
          }
        }

        job.stats.cities_processed++;
        logger.info(`[SwerveDrain] ${city}: ${cityStats.items} items, ${cityStats.matched}/${cityStats.backlog} matched`);
      }

      job.status = 'done';
      job.finishedAt = new Date().toISOString();
      logger.info(`[SwerveDrain] Job ${jobId} complete: ${job.stats.matched}/${job.stats.backlog_total} matched, ~$${job.stats.estimated_cost_usd.toFixed(2)}`);
    } catch (err) {
      job.status = 'error';
      job.error = err.message;
      job.finishedAt = new Date().toISOString();
      logger.error(`[SwerveDrain] Job ${jobId} failed: ${err.message}`);
    }
  })();

  return { jobId };
}

function getDrainStatus(jobId) {
  return _runs.get(jobId) || null;
}

function listDrainJobs() {
  return Array.from(_runs.entries()).map(([id, job]) => ({
    jobId: id,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    matched: job.stats.matched,
    backlog_total: job.stats.backlog_total,
    cities_processed: `${job.stats.cities_processed}/${job.stats.cities_total}`,
  }));
}

module.exports = { runSwerveDrain, getDrainStatus, listDrainJobs, isAddressMatch, normalizeAddress };
