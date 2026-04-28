/**
 * Match Engine v1 - score listings against investor leads.
 * Created 2026-04-28 (Day 4-5 of dashboard fix plan).
 *
 * Input:  lead_id from website_leads (user_type='investor' expected).
 * Output: rows inserted into lead_matches with match_score and match_reasons.
 *
 * The lead's preferences live in form_data JSONB:
 *   - budget: '1-2m' | '2-5m' | '5m+'
 *   - areas:  ['center', 'sharon', 'north', 'south', 'jerusalem', 'haifa']
 *   - horizon: 'short' | 'long'
 *   - hasMultipleInvestments: bool
 *
 * Scoring (out of 100):
 *   base 50
 *   + iai_score * 0.30  (max +30)
 *   + enhanced_ssi_score * 0.15  (max +15)
 *   + entry_discount_pct * 1.5  (capped +30; only if positive)
 *   - 20 if construction stage (premium already captured)
 *   - 10 if has_negative_news
 *   clamp to [0, 100]
 */

const pool = require('../db/pool');
const { logger } = require('./logger');

// Map area code to a list of city names. Hebrew city strings as they appear
// in listings.city / complexes.city. Conservative coverage of the largest
// cities per area; lookup is `ILIKE ANY` so partial matches work too.
const AREA_TO_CITIES = {
  center:    ['תל אביב', 'תל אביב-יפו', 'רמת גן', 'גבעתיים', 'חולון', 'בת ים', 'ראשון לציון', 'פתח תקווה', 'ראש העין', 'גבעת שמואל', 'קריית אונו', 'יהוד', 'אור יהודה'],
  sharon:    ['הרצליה', 'רעננה', 'כפר סבא', 'הוד השרון', 'נתניה', 'רמת השרון'],
  north:     ['חיפה', 'קריית ביאליק', 'קריית מוצקין', 'קריית ים', 'קריית אתא', 'נהריה', 'כרמיאל', 'עכו', 'טבריה', 'צפת'],
  south:     ['באר שבע', 'אשדוד', 'אשקלון', 'דימונה', 'אילת', 'קריית גת', 'נתיבות', 'אופקים'],
  jerusalem: ['ירושלים', 'בית שמש', 'מבשרת ציון'],
  haifa:     ['חיפה', 'קריית ים', 'קריית מוצקין', 'קריית ביאליק', 'קריית אתא', 'נשר', 'טירת כרמל']
};

const BUDGET_RANGES = {
  '1-2m': { min: 1_000_000, max: 2_000_000 },
  '2-5m': { min: 2_000_000, max: 5_000_000 },
  '5m+':  { min: 5_000_000, max: 50_000_000 }
};

const CONSTRUCTION_STAGES = ['under_construction', 'ביצוע', 'בביצוע'];

const TOP_N_PER_LEAD = 20;
const MIN_SCORE_TO_PERSIST = 40;

function expandAreas(areas) {
  if (!Array.isArray(areas) || areas.length === 0) return null;
  const cities = new Set();
  areas.forEach(a => {
    const list = AREA_TO_CITIES[a];
    if (list) list.forEach(c => cities.add(c));
  });
  return cities.size ? Array.from(cities) : null;
}

function parseFormData(formData) {
  if (!formData) return {};
  if (typeof formData === 'string') {
    try { return JSON.parse(formData); } catch (e) { return {}; }
  }
  return formData;
}

function clamp(n, lo, hi) {
  if (Number.isNaN(n) || n === null || n === undefined) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function scoreCandidate(c, leadFormData) {
  let score = 50;
  const reasons = [];

  const iai = Number(c.iai_score) || 0;
  if (iai > 0) {
    const boost = Math.min(iai * 0.30, 30);
    score += boost;
    reasons.push(`IAI ${iai} (+${boost.toFixed(0)})`);
  }

  const ssi = Number(c.enhanced_ssi_score) || 0;
  if (ssi > 0) {
    const boost = Math.min(ssi * 0.15, 15);
    score += boost;
    reasons.push(`SSI ${ssi} (+${boost.toFixed(0)})`);
  }

  const entry = Number(c.entry_discount_pct) || 0;
  if (entry > 0) {
    const boost = Math.min(entry * 1.5, 30);
    score += boost;
    reasons.push(`Entry below market ${entry.toFixed(1)}% (+${boost.toFixed(0)})`);
  }

  if (CONSTRUCTION_STAGES.includes(c.plan_stage)) {
    score -= 20;
    reasons.push('Stage: under construction (-20)');
  }

  if (c.has_negative_news) {
    score -= 10;
    reasons.push('Negative news on developer (-10)');
  }

  // Long horizon bonus for early-stage projects.
  const horizon = leadFormData?.horizon;
  if (horizon === 'long' && ['planning', 'pre_deposit', 'declared'].includes(c.plan_stage)) {
    score += 5;
    reasons.push(`Long horizon plus early stage (+5)`);
  }

  return { score: clamp(Math.round(score * 100) / 100, 0, 100), reasons };
}

/**
 * Match a single lead against the listing inventory and persist results.
 * Returns { lead_id, candidates_scanned, matches_persisted, top_score } or
 * { skipped: true, reason: '...' } if the lead is not eligible.
 */
async function matchLead(leadId) {
  const leadRes = await pool.query(
    `SELECT id, name, user_type, form_data FROM website_leads WHERE id = $1`,
    [leadId]
  );
  const lead = leadRes.rows[0];
  if (!lead) return { skipped: true, reason: 'lead not found' };

  // Match Engine v1 only handles investor leads. Owner/contact leads are
  // sell-side or general inquiry and don't need listing matches.
  if (lead.user_type !== 'investor') {
    return { skipped: true, reason: `user_type ${lead.user_type} not matchable` };
  }

  const fd = parseFormData(lead.form_data);
  const cities = expandAreas(fd.areas);
  const budget = BUDGET_RANGES[fd.budget];

  if (!cities && !budget) {
    return { skipped: true, reason: 'no areas or budget in form_data' };
  }

  // Build listing query with available filters.
  const params = [];
  const conditions = ['l.is_active = TRUE'];

  if (cities) {
    params.push(cities);
    conditions.push(`(l.city = ANY($${params.length}) OR c.city = ANY($${params.length}))`);
  }
  if (budget) {
    params.push(budget.min);
    conditions.push(`l.asking_price >= $${params.length}`);
    params.push(budget.max);
    conditions.push(`l.asking_price <= $${params.length}`);
  }

  const sql = `
    SELECT
      l.id          AS listing_id,
      l.complex_id,
      l.address,
      l.city,
      l.rooms,
      l.asking_price,
      l.area_sqm,
      l.price_per_sqm,
      l.ssi_score   AS listing_ssi,
      c.name        AS complex_name,
      c.city        AS complex_city,
      c.iai_score,
      c.enhanced_ssi_score,
      c.plan_stage,
      c.has_negative_news,
      c.accurate_price_sqm,
      c.city_avg_price_sqm,
      CASE
        WHEN c.accurate_price_sqm > 0 AND c.city_avg_price_sqm > 0
        THEN ROUND(((c.city_avg_price_sqm - c.accurate_price_sqm)::numeric / c.city_avg_price_sqm) * 100, 1)
        ELSE NULL
      END AS entry_discount_pct
    FROM listings l
    LEFT JOIN complexes c ON c.id = l.complex_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY COALESCE(c.iai_score, 0) DESC NULLS LAST,
             COALESCE(c.enhanced_ssi_score, 0) DESC NULLS LAST
    LIMIT 200
  `;

  const candRes = await pool.query(sql, params);
  const candidates = candRes.rows;

  // Score, filter, sort.
  const scored = candidates
    .map(c => ({ c, ...scoreCandidate(c, fd) }))
    .filter(x => x.score >= MIN_SCORE_TO_PERSIST)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_N_PER_LEAD);

  // Upsert into lead_matches.
  let persisted = 0;
  for (const x of scored) {
    try {
      await pool.query(`
        INSERT INTO lead_matches (lead_id, listing_id, complex_id, match_score, match_reasons, operator_status, updated_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', NOW())
        ON CONFLICT (lead_id, listing_id) DO UPDATE SET
          match_score   = EXCLUDED.match_score,
          match_reasons = EXCLUDED.match_reasons,
          updated_at    = NOW()
      `, [leadId, x.c.listing_id, x.c.complex_id, x.score, JSON.stringify(x.reasons)]);
      persisted++;
    } catch (e) {
      logger.warn('[matchEngine] upsert failed', { lead_id: leadId, listing_id: x.c.listing_id, error: e.message });
    }
  }

  logger.info('[matchEngine] match complete', {
    lead_id: leadId,
    candidates_scanned: candidates.length,
    matches_persisted: persisted,
    top_score: scored[0]?.score ?? null
  });

  return {
    lead_id: leadId,
    user_type: lead.user_type,
    candidates_scanned: candidates.length,
    matches_persisted: persisted,
    top_score: scored[0]?.score ?? null,
    top_match_reasons: scored[0]?.reasons ?? []
  };
}

/**
 * Read top-N matches for a lead (for the operator's Match tab UI).
 */
async function getMatchesForLead(leadId, limit = 10) {
  const r = await pool.query(`
    SELECT
      lm.id, lm.match_score, lm.match_reasons, lm.operator_status,
      lm.created_at, lm.updated_at,
      l.id AS listing_id, l.title, l.address, l.city, l.rooms, l.asking_price,
      l.area_sqm, l.price_per_sqm, l.url, l.phone, l.contact_name,
      l.thumbnail_url, l.source, l.first_seen,
      c.id AS complex_id, c.name AS complex_name, c.iai_score,
      c.enhanced_ssi_score, c.plan_stage, c.developer
    FROM lead_matches lm
    LEFT JOIN listings  l ON l.id = lm.listing_id
    LEFT JOIN complexes c ON c.id = lm.complex_id
    WHERE lm.lead_id = $1
    ORDER BY lm.match_score DESC, lm.created_at DESC
    LIMIT $2
  `, [leadId, Math.min(parseInt(limit) || 10, 50)]);
  return r.rows;
}

/**
 * Update operator_status on a single match (pending/contacted/sent/dismissed/won/lost).
 */
async function updateMatchStatus(matchId, status, notes) {
  const valid = ['pending', 'contacted', 'sent', 'dismissed', 'won', 'lost'];
  if (!valid.includes(status)) {
    throw new Error(`invalid status; must be one of ${valid.join(', ')}`);
  }
  const r = await pool.query(`
    UPDATE lead_matches
    SET operator_status = $1, notes = COALESCE($2, notes), updated_at = NOW()
    WHERE id = $3
    RETURNING id, lead_id, listing_id, operator_status, notes, updated_at
  `, [status, notes ?? null, matchId]);
  return r.rows[0];
}

module.exports = {
  matchLead,
  getMatchesForLead,
  updateMatchStatus,
  AREA_TO_CITIES,
  BUDGET_RANGES
};
