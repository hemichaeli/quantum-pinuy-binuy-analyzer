// Drain v2 — match Swerve items against the authoritative complex addresses,
// not against our messy listings table.
//
// Why: many listings have junk source_listing_id (Perplexity-discovery search
// URLs) and matching Swerve→listings yielded only ~10%. complexes.addresses
// is the source of truth: a human-curated list of buildings inside each
// pinuy-binuy block. Matching against it tells us with confidence: "this
// phone belongs to a listing in pinuy-binuy complex X."
//
// addresses format (TEXT, free-form Hebrew):
//   'גבעתי 1-11; החי"ש 2-8; הריים 5-23; שלמה אלירז 3,5,7'
//   'רחוב ז'בוטינסקי, רחוב ולפסון, רחוב התומר'
//   'רוטנברג, שליט, אסא, נפתלי'
// Separators: '; ', ',' or ' - '. Each part is street + optional number/range.

const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');
const { isAddressMatch, normalizeAddress } = require('./swerveBacklogDrain');

const APIFY_BASE = 'https://api.apify.com/v2';
const SWERVE_ACTOR = 'swerve~yad2-scraper';
const PER_PHONE_USD = 0.005;

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

// ───── Parse complex addresses ─────

const SEPARATOR_RE = /\s*[;,]\s*|\s+-\s+/;

// Take one street-fragment like "גבעתי 1-11" or "שלמה אלירז 3,5,7" and
// return a list of {street, number} pairs. Empty list if no street word.
function parseAddressFragment(frag) {
  if (!frag) return [];
  let s = String(frag).trim();
  if (!s) return [];
  // House-number lists "3,5,7" inside one fragment expand to multiple entries.
  // Range "1-11" expands to all numbers from 1 to 11 inclusive.
  // Pull the street name (everything up to the first digit/comma run).
  const match = s.match(/^([^\d]+?)\s*([\d\s,\-–]+)$/);
  let street, numberPart;
  if (match) {
    street = match[1].trim();
    numberPart = match[2];
  } else {
    street = s.trim();
    numberPart = '';
  }
  // Normalize street: lowercase, strip common street-type prefixes, strip quotes.
  street = street.replace(/^(רחוב|רח'|שדרות|שד'|דרך|סמטת|כיכר|טיילת)\s+/, '');
  street = street.replace(/["'"׳״]/g, '').trim().toLowerCase();
  if (!street) return [];

  const numbers = [];
  if (numberPart) {
    // Split by comma first ("3,5,7"), then handle ranges in each part.
    for (const part of numberPart.split(',')) {
      const r = part.trim().match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (r) {
        const a = parseInt(r[1], 10), b = parseInt(r[2], 10);
        for (let n = Math.min(a, b); n <= Math.max(a, b); n++) numbers.push(n);
      } else {
        const n = parseInt(part.trim(), 10);
        if (!isNaN(n)) numbers.push(n);
      }
    }
  }

  if (numbers.length === 0) return [{ street, numbers: [] }];
  return [{ street, numbers }];
}

function parseAddressesField(raw) {
  if (!raw) return [];
  const out = [];
  for (const frag of String(raw).split(SEPARATOR_RE)) {
    for (const entry of parseAddressFragment(frag)) {
      out.push(entry);
    }
  }
  return out;
}

// ───── Match Swerve item against a complex's address list ─────

function itemMatchesComplex(itemAddress, complexAddrEntries) {
  if (!itemAddress || !Array.isArray(complexAddrEntries) || complexAddrEntries.length === 0) return false;
  // Reuse the city-listing fuzzy matcher: build a faux "ours" string per
  // complex entry and compare.
  for (const entry of complexAddrEntries) {
    if (entry.numbers.length === 0) {
      // Match by street name only.
      const fake = entry.street;
      if (isAddressMatch(fake, itemAddress)) return true;
    } else {
      for (const n of entry.numbers) {
        const fake = `${entry.street} ${n}`;
        if (isAddressMatch(fake, itemAddress)) return true;
      }
    }
  }
  return false;
}

// ───── Swerve call ─────

async function fetchSwerveCity(city, dealType, maxItems, neighbourhood = null) {
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
  if (resp.status >= 400) {
    return { items: [], error: resp.data };
  }
  return { items: Array.isArray(resp.data) ? resp.data : [], error: null };
}

// ───── Main runner ─────

const _runs = new Map();

async function runComplexAddressDrain({
  dryRun = false,
  maxGroups = 50,
  cityFilter = null,
  perGroupCap = 100,
  minHeatTier = 1,
  useNeighborhood = true,
} = {}) {
  const jobId = `cdrain_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const job = {
    status: 'running',
    startedAt: new Date().toISOString(),
    stats: {
      complexes_total: 0,
      groups_total: 0,
      groups_processed: 0,
      items_fetched: 0,
      items_matched: 0,
      items_no_phone: 0,
      listings_inserted: 0,
      listings_updated: 0,
      complexes_with_match: new Set(),
      estimated_cost_usd: 0,
      per_group: {},
    },
  };
  _runs.set(jobId, job);

  (async () => {
    try {
      const minTier = Math.max(1, parseInt(minHeatTier, 10) || 1);
      const { rows: complexes } = await pool.query(`
        SELECT
          c.id, c.city, c.neighborhood, c.name, c.addresses,
          ${HEAT_TIER_SQL}::int AS heat_tier
        FROM complexes c
        WHERE c.addresses IS NOT NULL AND length(c.addresses::text) > 0
          AND c.city IS NOT NULL AND c.city <> ''
          AND ${HEAT_TIER_SQL} >= ${minTier}
          ${cityFilter ? `AND c.city = '${String(cityFilter).replace(/'/g, "''")}'` : ''}
      `);
      job.stats.complexes_total = complexes.length;

      // Parse all addresses once.
      const parsedByComplex = new Map();
      for (const c of complexes) {
        parsedByComplex.set(c.id, parseAddressesField(c.addresses));
      }

      // Group complexes by (city, neighborhood-or-null).
      const byGroup = {};
      for (const c of complexes) {
        const nb = useNeighborhood && c.neighborhood ? c.neighborhood : null;
        const key = `${c.city}::${nb || '*'}`;
        if (!byGroup[key]) byGroup[key] = { city: c.city, neighborhood: nb, complexes: [], maxHeat: 0 };
        byGroup[key].complexes.push(c);
        if (c.heat_tier > byGroup[key].maxHeat) byGroup[key].maxHeat = c.heat_tier;
      }
      const groups = Object.entries(byGroup)
        .sort((a, b) => (b[1].maxHeat - a[1].maxHeat) || (b[1].complexes.length - a[1].complexes.length))
        .slice(0, maxGroups)
        .map(([k, v]) => ({ key: k, ...v }));
      job.stats.groups_total = groups.length;

      logger.info(`[ComplexDrain] Job ${jobId}: ${complexes.length} complexes across ${groups.length} (city,neighborhood) groups, minHeatTier=${minTier}`);

      for (const group of groups) {
        const { city, neighborhood } = group;
        const gStats = {
          city, neighborhood,
          heat_tier: group.maxHeat,
          complexes: group.complexes.length,
          items: 0,
          matched: 0,
          inserted: 0,
          updated: 0,
        };
        job.stats.per_group[group.key] = gStats;

        const { items, error } = await fetchSwerveCity(city, 'buy', perGroupCap, neighborhood);
        gStats.items = items.length;
        job.stats.items_fetched += items.length;
        job.stats.estimated_cost_usd += items.length * PER_PHONE_USD;

        if (error) {
          gStats.error = error?.error?.message || String(error).slice(0, 100);
          job.stats.groups_processed++;
          continue;
        }

        for (const item of items) {
          if (!item || !item.contactPhone) { job.stats.items_no_phone++; continue; }

          // Try to match against any complex in the group.
          let matchedComplex = null;
          for (const c of group.complexes) {
            const entries = parsedByComplex.get(c.id) || [];
            if (itemMatchesComplex(item.address, entries)) {
              matchedComplex = c;
              break;
            }
          }
          if (!matchedComplex) continue;

          gStats.matched++;
          job.stats.items_matched++;
          job.stats.complexes_with_match.add(matchedComplex.id);

          if (dryRun) continue;

          const tokenMatch = String(item.url || '').match(/\/item\/([A-Za-z0-9]+)/);
          const token = tokenMatch ? tokenMatch[1] : null;

          // Try to find an existing listing for this complex with the same phone
          // OR the same yad2 token. Prefer phone-dedup so the same advertiser
          // doesn't get multiple rows in our DB.
          const { rows: existing } = await pool.query(
            `SELECT id FROM listings
             WHERE complex_id = $1
               AND (phone = $2 OR (source_listing_id = $3 AND $3 IS NOT NULL))
             LIMIT 1`,
            [matchedComplex.id, item.contactPhone, token]
          );

          if (existing.length > 0) {
            await pool.query(
              `UPDATE listings
                 SET phone = $1,
                     contact_name = COALESCE($2, contact_name),
                     source_listing_id = COALESCE($3, source_listing_id),
                     url = COALESCE($4, url),
                     updated_at = NOW()
               WHERE id = $5`,
              [item.contactPhone, item.contactName || null, token, item.url || null, existing[0].id]
            );
            gStats.updated++;
            job.stats.listings_updated++;
          } else {
            await pool.query(
              `INSERT INTO listings
                 (complex_id, city, address, phone, contact_name,
                  source, source_listing_id, url, is_active, created_at, updated_at)
               VALUES
                 ($1, $2, $3, $4, $5, 'swerve', $6, $7, TRUE, NOW(), NOW())
               ON CONFLICT DO NOTHING`,
              [
                matchedComplex.id,
                matchedComplex.city,
                item.address || null,
                item.contactPhone,
                item.contactName || null,
                token,
                item.url || null,
              ]
            );
            gStats.inserted++;
            job.stats.listings_inserted++;
          }
        }

        job.stats.groups_processed++;
        logger.info(`[ComplexDrain] tier${group.maxHeat} ${city}/${neighborhood || '*'}: ${gStats.items} items, ${gStats.matched} matched, ${gStats.inserted}I+${gStats.updated}U`);
      }

      job.status = 'done';
      job.finishedAt = new Date().toISOString();
      // Replace the Set with its size before serializing.
      job.stats.complexes_with_match = job.stats.complexes_with_match.size;
      logger.info(`[ComplexDrain] Job ${jobId} complete: ${job.stats.items_matched} matched (${job.stats.listings_inserted} new + ${job.stats.listings_updated} updated), ${job.stats.complexes_with_match} complexes hit, ~$${job.stats.estimated_cost_usd.toFixed(2)}`);
    } catch (err) {
      job.status = 'error';
      job.error = err.message;
      job.finishedAt = new Date().toISOString();
      job.stats.complexes_with_match = job.stats.complexes_with_match.size || 0;
      logger.error(`[ComplexDrain] Job ${jobId} failed: ${err.message}`);
    }
  })();

  return { jobId };
}

function getDrainStatus(jobId) {
  const j = _runs.get(jobId);
  if (!j) return null;
  // Serialize the Set if still running.
  const out = JSON.parse(JSON.stringify(j, (k, v) => v instanceof Set ? v.size : v));
  return out;
}

function listDrainJobs() {
  return Array.from(_runs.entries()).map(([id, j]) => ({
    jobId: id,
    status: j.status,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    matched: j.stats.items_matched,
    inserted: j.stats.listings_inserted,
    updated: j.stats.listings_updated,
    groups: `${j.stats.groups_processed}/${j.stats.groups_total}`,
  }));
}

module.exports = {
  runComplexAddressDrain,
  getDrainStatus,
  listDrainJobs,
  parseAddressesField,
  itemMatchesComplex,
};
