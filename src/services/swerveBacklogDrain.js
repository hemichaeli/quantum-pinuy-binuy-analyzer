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

// ───── Heat tier ─────
// Same formula as /api/debug/complexes-heat. Inline so callers in either
// service or route can use the same canonical scoring.
const HEAT_TIER_SQL = `
  LEAST(5,
    CASE
      WHEN c.approval_date    IS NOT NULL OR c.signature_percent >= 85 THEN 5
      WHEN c.deposit_date     IS NOT NULL OR c.signature_percent >= 65 THEN 4
      WHEN c.submission_date  IS NOT NULL OR c.signature_percent >= 45 THEN 3
      WHEN c.declaration_date IS NOT NULL OR c.signature_percent >= 25 THEN 2
      ELSE 1
    END
    + CASE WHEN c.multiplier >= 2.5 THEN 1 ELSE 0 END
  )
`;
const TIER_LABEL = { 5: '5', 4: '4', 3: '3', 2: '2', 1: '1' };

// ───── Swerve API ─────

async function fetchSwerveCity(city, dealType, maxItems, neighbourhood = null) {
  const t0 = Date.now();
  const input = { city, dealType, maxItems, enrichListings: true };
  if (neighbourhood) input.neighbourhood = neighbourhood;
  const resp = await axios.post(
    `${APIFY_BASE}/acts/${SWERVE_ACTOR}/run-sync-get-dataset-items`,
    input,
    {
      headers: { Authorization: `Bearer ${process.env.APIFY_API_TOKEN}` },
      timeout: 600000,
      params: { timeout: 580 },
      validateStatus: () => true,
    }
  );
  const elapsed = Date.now() - t0;
  if (resp.status >= 400) {
    logger.warn(`[SwerveDrain] ${city}/${neighbourhood || '*'}/${dealType} HTTP ${resp.status}: ${JSON.stringify(resp.data).slice(0, 200)}`);
    return { items: [], elapsed, error: resp.data };
  }
  return { items: Array.isArray(resp.data) ? resp.data : [], elapsed, error: null };
}

// ───── Main drain ─────

const _runs = new Map(); // jobId → { status, stats, startedAt, finishedAt }

async function runSwerveDrain({ dryRun = false, maxGroups = 50, cityFilter = null, perGroupCap = 100, useNeighborhood = true, minHeatTier = 1 } = {}) {
  const jobId = `drain_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const job = {
    status: 'running',
    startedAt: new Date().toISOString(),
    stats: {
      backlog_total: 0,
      groups_processed: 0,
      groups_total: 0,
      items_fetched: 0,
      matched: 0,
      not_matched: 0,
      no_phone: 0,
      estimated_cost_usd: 0,
      per_group: {},
    },
  };
  _runs.set(jobId, job);

  (async () => {
    try {
      // Join with complexes so we know each listing's neighborhood. This lets
      // us scope Swerve searches to exactly the pinuy-binuy block, not the
      // whole city. Big win for match rate.
      const { rows: backlog } = await pool.query(`
        SELECT
          l.id, l.city, l.address, l.complex_id, l.source_listing_id, l.url,
          c.neighborhood,
          ${HEAT_TIER_SQL}::int AS heat_tier
        FROM listings l
        JOIN complexes c ON c.id = l.complex_id
        WHERE l.is_active = TRUE
          AND l.complex_id IS NOT NULL
          AND (l.phone IS NULL OR l.phone = '' OR l.phone = 'NULL')
          AND l.city IS NOT NULL AND l.city <> ''
          AND l.address IS NOT NULL AND l.address <> ''
          AND ${HEAT_TIER_SQL} >= ${parseInt(minHeatTier, 10) || 1}
          ${cityFilter ? `AND l.city = '${String(cityFilter).replace(/'/g, "''")}'` : ''}
      `);
      job.stats.backlog_total = backlog.length;

      // Group key: city + (optional) neighborhood. Listings without a known
      // neighborhood fall back to a city-only group keyed `${city}::*`.
      // Track the max heat_tier per group so we can process burning blocks
      // first when budget is tight.
      const byGroup = {};
      for (const l of backlog) {
        const nb = useNeighborhood && l.neighborhood ? l.neighborhood : null;
        const key = `${l.city}::${nb || '*'}`;
        if (!byGroup[key]) byGroup[key] = { city: l.city, neighborhood: nb, listings: [], maxHeat: 0 };
        byGroup[key].listings.push(l);
        if (l.heat_tier > byGroup[key].maxHeat) byGroup[key].maxHeat = l.heat_tier;
      }
      // Sort groups: hottest first, then by backlog size (more = more value
      // per Swerve call). Tier 5🔥 → Tier 1🧊.
      const groups = Object.entries(byGroup)
        .sort((a, b) => (b[1].maxHeat - a[1].maxHeat) || (b[1].listings.length - a[1].listings.length))
        .slice(0, maxGroups)
        .map(([k, v]) => ({ key: k, ...v }));
      job.stats.groups_total = groups.length;

      logger.info(`[SwerveDrain] Job ${jobId}: ${backlog.length} listings across ${groups.length} (city,neighborhood) groups, minHeatTier=${minHeatTier}, sorted hot→cold (dryRun=${dryRun}, useNeighborhood=${useNeighborhood})`);

      for (const group of groups) {
        const { city, neighborhood, listings: groupRows, key } = group;
        const maxItems = Math.min(perGroupCap, Math.max(30, groupRows.length * 3));
        const gStats = { city, neighborhood, heat_tier: group.maxHeat, heat_label: TIER_LABEL[group.maxHeat] || String(group.maxHeat), backlog: groupRows.length, items: 0, matched: 0 };
        job.stats.per_group[key] = gStats;

        const { items, error } = await fetchSwerveCity(city, 'buy', maxItems, neighborhood);
        gStats.items = items.length;
        job.stats.items_fetched += items.length;
        job.stats.estimated_cost_usd += items.length * PER_PHONE_USD;

        if (error) {
          gStats.error = error?.error?.message || String(error).slice(0, 100);
          job.stats.groups_processed++;
          continue;
        }

        // Match each Swerve item against our group rows
        for (const item of items) {
          if (!item || !item.contactPhone) { job.stats.no_phone++; continue; }
          let matched = null;
          for (const ours of groupRows) {
            if (ours._matched) continue;
            if (isAddressMatch(ours.address, item.address)) { matched = ours; break; }
          }
          if (!matched) { job.stats.not_matched++; continue; }
          matched._matched = true;
          gStats.matched++;
          job.stats.matched++;

          if (!dryRun) {
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

        job.stats.groups_processed++;
        logger.info(`[SwerveDrain] ${TIER_LABEL[group.maxHeat]} ${city}/${neighborhood || '*'}: ${gStats.items} items, ${gStats.matched}/${gStats.backlog} matched`);
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
