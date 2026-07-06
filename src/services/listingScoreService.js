// listingScoreService.js
// LISTING-LEVEL opportunity scorer (grounded, per-listing metric).
//
// For each active for-sale listing in a pre-evacuation pinui-binui complex:
//   P_ask_psm  = listing price per sqm (price_per_sqm, or asking_price / area_sqm)
//   P_fair_psm = median price/sqm of COMPARABLE units in the SAME complex
//                (other active listings + transactions from the last 24 months,
//                 matched on rooms +/-0.5 AND area_sqm +/-15%, excluding self)
//   B  discount_pct      = (P_fair_psm - P_ask_psm) / P_ask_psm * 100          [phase 1]
//   A  future_uplift_pct = (V_end - P_fair_total) / P_fair_total * 100, GROSS   [phase 2]
//   opportunity_pct = B (phase 1), then A + B (phase 2)
//   opportunity_ils = P_fair_total - asking_price (phase 1), then V_end - asking_price (phase 2)
//
// Eligibility: listing is_active AND complex status is a PRE-EVACUATION stage.
// Excludes 'construction' (residents evacuated, nothing to buy) and later/unknown stages.
// Requires >= 3 comps to be scorable; fewer => low confidence and excluded from the feed.

const pool = require('../db/pool');
const { logger } = require('./logger');

// Keep-list of pre-evacuation statuses. pre_deposit/planning are kept ONLY when they
// have comps, and are flagged low-confidence (see confidence formula below).
const ELIGIBLE_STATUSES = ['declared', 'deposited', 'approved', 'permit', 'pre_deposit', 'planning'];
const LOW_CONF_STATUSES = ['pre_deposit', 'planning'];

const MIN_COMPS = 4;
// Comp-outlier trim: within a compound, drop comps whose price/sqm is more than
// +/-35% from the compound's own median. Removes new-build/luxury/garbage comps that
// otherwise inflate P_fair and make ordinary old units look 60%+ "underpriced".
const COMP_TRIM = 0.35;
// Realistic Israeli apartment price/sqm band. Drops garbage rows (rent, per-meter,
// mis-scraped) on both ends. Genuine underpriced old units still sit well inside this.
const PSM_FLOOR = 7000;
const PSM_CEIL = 120000;
const ASK_FLOOR = 300000;    // a real apartment is not 3,900 or 12,700 shekels
const ASK_CEIL = 30000000;

// price/sqm expression for the listings table (unaliased, and l.-aliased variants)
const LISTING_PSM = `COALESCE(price_per_sqm, CASE WHEN area_sqm > 0 THEN asking_price / area_sqm END)`;
const LISTING_PSM_L = `COALESCE(l.price_per_sqm, CASE WHEN l.area_sqm > 0 THEN l.asking_price / l.area_sqm END)`;

// Shared CTEs: pool of comparable units (comps) + the target listings we score.
// {SINGLE} is replaced by an optional "AND l.id = $3" clause.
function buildCtes(single) {
  return `
    WITH comps AS (
      SELECT complex_id, rooms, area_sqm,
             ${LISTING_PSM} AS psm,
             id AS lid
      FROM listings
      WHERE is_active = TRUE AND complex_id IS NOT NULL
        AND rooms IS NOT NULL AND area_sqm > 0
        AND ${LISTING_PSM} BETWEEN ${PSM_FLOOR} AND ${PSM_CEIL}
      UNION ALL
      SELECT complex_id, rooms, area_sqm,
             price_per_sqm AS psm,
             NULL::int AS lid
      FROM transactions
      WHERE complex_id IS NOT NULL
        AND transaction_date >= NOW() - INTERVAL '24 months'
        AND rooms IS NOT NULL AND area_sqm > 0
        AND price_per_sqm BETWEEN ${PSM_FLOOR} AND ${PSM_CEIL}
    ),
    comp_center AS (
      SELECT complex_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY psm) AS med
      FROM comps GROUP BY complex_id
    ),
    targets AS (
      SELECT l.id, l.complex_id, l.rooms, l.area_sqm, l.asking_price,
             c.status, c.newbuild_psm, c.apartment_area_uplift_pct,
             ${LISTING_PSM_L} AS p_ask_psm
      FROM listings l
      JOIN complexes c ON c.id = l.complex_id
      WHERE l.is_active = TRUE
        AND c.status = ANY($1)
        AND l.rooms IS NOT NULL AND l.area_sqm > 0
        AND l.asking_price BETWEEN ${ASK_FLOOR} AND ${ASK_CEIL}
        AND ${LISTING_PSM_L} BETWEEN ${PSM_FLOOR} AND ${PSM_CEIL}
        ${single ? 'AND l.id = $3' : ''}
    ),
    scored AS (
      SELECT t.id, t.complex_id, t.rooms, t.area_sqm, t.asking_price, t.status, t.p_ask_psm,
             t.newbuild_psm, t.apartment_area_uplift_pct,
             COUNT(cp.psm) AS comps_used,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY cp.psm) AS p_fair_psm
      FROM targets t
      JOIN comp_center cc ON cc.complex_id = t.complex_id
      LEFT JOIN comps cp
        ON cp.complex_id = t.complex_id
       AND (cp.lid IS NULL OR cp.lid <> t.id)
       AND cp.rooms BETWEEN t.rooms - 0.5 AND t.rooms + 0.5
       AND cp.area_sqm BETWEEN t.area_sqm * 0.85 AND t.area_sqm * 1.15
       AND cp.psm BETWEEN cc.med * (1 - ${COMP_TRIM}) AND cc.med * (1 + ${COMP_TRIM})
      GROUP BY t.id, t.complex_id, t.rooms, t.area_sqm, t.asking_price, t.status, t.p_ask_psm,
               t.newbuild_psm, t.apartment_area_uplift_pct
    )`;
}

// Confidence 0..1: rises with comp count once past the MIN_COMPS threshold,
// discounted for the weaker pre_deposit/planning statuses. Below threshold stays low.
const CONFIDENCE_SQL = `
  CASE
    WHEN s.comps_used >= ${MIN_COMPS} THEN
      ROUND((LEAST(1.0, 0.5 + (s.comps_used - ${MIN_COMPS}) * 0.1)
             * (CASE WHEN s.status = ANY($2) THEN 0.6 ELSE 1.0 END))::numeric, 2)
    ELSE ROUND((s.comps_used / ${MIN_COMPS}.0 * 0.4)::numeric, 2)
  END`;

// Plausibility window: a genuine underpriced listing sits within a sane ratio of its
// same-compound comparable median. Outside this, it is a data error or a non-comparable
// unit (garbage price, parking/storage, old-vs-new mix), NOT a real deal. Tunable.
// LOW=0.6 caps the max believable discount at ~67%; HIGH=1.3 keeps small premiums.
const COMP_LOW = 0.74;
const COMP_HIGH = 1.2;

// Phase 2 (A, future uplift): rough v1 proxy for the delivered new-build price/sqm.
// newbuild_psm = city_avg_price_sqm * NEWBUILD_FACTOR. Tunable via env.
// TODO: replace with real new-build transaction comps per area (pipeline task).
const NEWBUILD_FACTOR = Number(process.env.NEWBUILD_FACTOR) || 1.35;
const DEFAULT_UPLIFT = 25; // % floor-area gain on the replacement unit, if not set per-complex

// Phase 2: opportunity = A + B. A (future_uplift, GROSS) from the newbuild valuation:
// V_end/area = newbuild_psm * (1 + uplift/100); A = (V_end - P_fair) / P_fair * 100.
// When newbuild_psm is missing, A is null and opportunity falls back to B alone.
function buildUpdateSql(single) {
  const discountExpr = `((s.p_fair_psm - s.p_ask_psm) / s.p_ask_psm * 100)::numeric`;
  const upl = `(1 + COALESCE(s.apartment_area_uplift_pct, ${DEFAULT_UPLIFT}) / 100.0)`;
  const upliftExpr = `((s.newbuild_psm * ${upl} - s.p_fair_psm) / s.p_fair_psm * 100)::numeric`;
  const vEndIls = `s.newbuild_psm * s.area_sqm * ${upl}`;
  const hasA = `s.newbuild_psm IS NOT NULL AND s.newbuild_psm > 0`;
  const scorable = `s.comps_used >= ${MIN_COMPS} AND s.p_fair_psm IS NOT NULL AND s.p_ask_psm > 0`
    + ` AND s.p_ask_psm >= ${COMP_LOW} * s.p_fair_psm AND s.p_ask_psm <= ${COMP_HIGH} * s.p_fair_psm`;
  return `
    ${buildCtes(single)}
    UPDATE listings l SET
      p_fair_psm        = ROUND(s.p_fair_psm::numeric),
      comps_used        = s.comps_used,
      discount_pct      = CASE WHEN ${scorable} THEN ROUND(${discountExpr}, 2) END,
      future_uplift_pct = CASE WHEN ${scorable} AND ${hasA} THEN ROUND(${upliftExpr}, 2) END,
      opportunity_pct   = CASE WHEN ${scorable}
                               THEN ROUND(${discountExpr} + CASE WHEN ${hasA} THEN ${upliftExpr} ELSE 0 END, 2) END,
      opportunity_ils   = CASE WHEN ${scorable}
                               THEN ROUND((CASE WHEN ${hasA} THEN ${vEndIls} ELSE s.p_fair_psm * s.area_sqm END - s.asking_price)::numeric) END,
      confidence        = ${CONFIDENCE_SQL},
      scored_at         = NOW()
    FROM scored s
    WHERE l.id = s.id
    RETURNING l.id`;
}

async function getCoverage() {
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM listings WHERE is_active) AS active_total,
      (SELECT COUNT(*) FROM listings l JOIN complexes c ON c.id = l.complex_id
         WHERE l.is_active AND c.status = ANY($1)) AS eligible_status_total,
      (SELECT COUNT(*) FROM listings l JOIN complexes c ON c.id = l.complex_id
         WHERE l.is_active AND c.status = 'construction') AS excluded_construction,
      (SELECT COUNT(*) FROM listings l JOIN complexes c ON c.id = l.complex_id
         WHERE l.is_active AND c.status = ANY($1)
           AND l.comps_used >= $2 AND l.opportunity_pct IS NOT NULL) AS scorable,
      (SELECT COUNT(*) FROM listings l JOIN complexes c ON c.id = l.complex_id
         WHERE l.is_active AND c.status = ANY($1)
           AND l.comps_used BETWEEN 1 AND $2 - 1) AS low_conf_few_comps,
      (SELECT COUNT(*) FROM listings l JOIN complexes c ON c.id = l.complex_id
         WHERE l.is_active AND c.status = ANY($1) AND l.comps_used = 0) AS no_comps,
      (SELECT COUNT(DISTINCT l.complex_id) FROM listings l JOIN complexes c ON c.id = l.complex_id
         WHERE l.is_active AND c.status = ANY($1)) AS eligible_complexes,
      (SELECT COUNT(DISTINCT l.complex_id) FROM listings l JOIN complexes c ON c.id = l.complex_id
         WHERE l.is_active AND c.status = ANY($1)
           AND l.comps_used >= $2 AND l.opportunity_pct IS NOT NULL) AS complexes_with_scorable
  `, [ELIGIBLE_STATUSES, MIN_COMPS]);
  const r = rows[0] || {};
  const out = {};
  for (const k of Object.keys(r)) out[k] = Number(r[k]);
  return out;
}

// Phase 2 input: fill complexes.newbuild_psm from the city average * NEWBUILD_FACTOR
// wherever it is missing. Rough v1 proxy for the delivered new-build price/sqm; a real
// new-build transaction comp replaces it later. Idempotent (only fills NULLs).
async function populateNewbuildPsm() {
  const res = await pool.query(`
    UPDATE complexes SET newbuild_psm = ROUND((city_avg_price_sqm * ${NEWBUILD_FACTOR})::numeric)
    WHERE newbuild_psm IS NULL AND city_avg_price_sqm IS NOT NULL AND city_avg_price_sqm > 0`);
  if (res.rowCount) logger.info(`[ListingScore] populated newbuild_psm for ${res.rowCount} complexes`);
  return res.rowCount;
}

// Rescore every eligible listing. Returns { updated, ms, coverage }.
async function scoreAllListings() {
  const t0 = Date.now();
  // Reset stale scores first, so rows that no longer qualify (garbage data filtered
  // out of the target set) do not keep a stale opportunity_pct in the feed.
  await pool.query(`
    UPDATE listings SET
      p_fair_psm = NULL, discount_pct = NULL, future_uplift_pct = NULL,
      opportunity_pct = NULL, opportunity_ils = NULL, confidence = NULL, comps_used = NULL
    WHERE opportunity_pct IS NOT NULL OR comps_used IS NOT NULL OR p_fair_psm IS NOT NULL`);
  await populateNewbuildPsm();
  const res = await pool.query(buildUpdateSql(false), [ELIGIBLE_STATUSES, LOW_CONF_STATUSES]);
  const coverage = await getCoverage();
  const ms = Date.now() - t0;
  logger.info(`[ListingScore] scored ${res.rowCount} listings in ${ms}ms (scorable=${coverage.scorable})`);
  return { updated: res.rowCount, ms, coverage };
}

// Rescore a single listing by id. Returns the updated row (or null if not eligible).
async function scoreListing(id) {
  const res = await pool.query(buildUpdateSql(true), [ELIGIBLE_STATUSES, LOW_CONF_STATUSES, id]);
  if (res.rowCount === 0) return null;
  const { rows } = await pool.query(
    `SELECT id, p_fair_psm, discount_pct, future_uplift_pct, opportunity_pct,
            opportunity_ils, confidence, comps_used, scored_at
       FROM listings WHERE id = $1`, [id]);
  return rows[0] || null;
}

// Ranked feed of scorable listings (>= MIN_COMPS comps), best opportunity first.
async function getTopListings(limit = 20) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);
  const { rows } = await pool.query(`
    SELECT l.id,
           l.city,
           c.name   AS compound_name,
           c.status,
           l.asking_price,
           l.area_sqm,
           l.rooms,
           l.p_fair_psm,
           l.discount_pct,
           l.future_uplift_pct,
           l.opportunity_pct,
           l.opportunity_ils,
           l.confidence,
           l.comps_used,
           l.url
    FROM listings l
    JOIN complexes c ON c.id = l.complex_id
    WHERE l.is_active = TRUE
      AND c.status = ANY($1)
      AND l.comps_used >= $2
      AND l.opportunity_pct IS NOT NULL
      AND l.confidence >= 0.5
    ORDER BY l.opportunity_pct DESC NULLS LAST, l.confidence DESC NULLS LAST
    LIMIT $3
  `, [ELIGIBLE_STATUSES, MIN_COMPS, lim]);
  return rows;
}

module.exports = {
  scoreAllListings,
  scoreListing,
  getTopListings,
  getCoverage,
  populateNewbuildPsm,
  ELIGIBLE_STATUSES,
  MIN_COMPS,
};
