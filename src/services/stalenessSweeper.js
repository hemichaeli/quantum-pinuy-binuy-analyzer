/**
 * Staleness Sweeper — 2026-05-13.
 *
 * Daily sweep that marks listings as inactive when their source has stopped
 * advertising them (i.e., they were taken down at the source). Runs at 07:15
 * IL — just after the daily scraper run and just before the 07:30 morning
 * report — so the operator's morning brief reflects the most current state.
 *
 * Why a centralized sweeper (vs. relying on each scraper's per-complex stale
 * logic): the per-scraper logic only marks listings inactive when that
 * complex was successfully scanned this run, and the windows (14d/21d) were
 * inconsistent across sources. This sweeper applies a unified, aggressive
 * window so the DB reflects "what's currently for sale," not "what was for
 * sale within the last 3 weeks."
 *
 * Scope: pinuy-binuy listings only (complex_id IS NOT NULL). Listings
 * outside known pinuy-binuy complexes shouldn't be in the active set at all;
 * migration 031 cleans those up historically.
 *
 * Sources with their own per-scrape stale logic (yad2 21d, facebook 14d) are
 * NOT skipped — this sweeper runs in addition, with a tighter window so the
 * morning report is accurate. The per-scrape logic stays as a belt-and-
 * suspenders fallback.
 */

const pool = require('../db/pool');
const { logger } = require('./logger');

// Stale window per source. Tighter than the per-scraper defaults because
// scrapers run daily and a 3-day gap is enough margin for one transient
// failure. FB listings linger longer (people forget to delete posts), so
// allow 5 days there. yad1 is retired (migration 025) so any active yad1
// row is stale by definition. konesIsrael/komo-residents aren't for-sale
// listings, so they're excluded from the sweep entirely.
const STALE_WINDOWS = {
  yad2:        '3 days',
  facebook:    '5 days',
  komo:        '3 days',
  dira:        '3 days',
  winwin:      '3 days',
  homeless:    '3 days',
  banknadlan:  '3 days',
  kones2:      '5 days',
  yad1:        '0 days', // retired source — anything still active is stale
};

async function sweepSource(source, window) {
  try {
    const result = await pool.query(`
      UPDATE listings
         SET is_active = FALSE,
             updated_at = NOW()
       WHERE source = $1
         AND is_active = TRUE
         AND complex_id IS NOT NULL
         AND last_seen < NOW() - INTERVAL '${window}'
       RETURNING id
    `, [source]);
    return result.rowCount || 0;
  } catch (e) {
    logger.warn(`[StalenessSweeper] ${source} sweep failed:`, e.message);
    return -1;
  }
}

async function runSweep() {
  const startedAt = Date.now();
  const perSource = {};
  let total = 0;

  for (const [source, window] of Object.entries(STALE_WINDOWS)) {
    const removed = await sweepSource(source, window);
    perSource[source] = removed;
    if (removed > 0) total += removed;
  }

  // Catch-all for any source we don't have in STALE_WINDOWS (e.g., a new
  // scraper added without updating this map). 7-day window as a safe default.
  try {
    const known = Object.keys(STALE_WINDOWS);
    const placeholders = known.map((_, i) => `$${i + 1}`).join(',');
    const result = await pool.query(`
      UPDATE listings
         SET is_active = FALSE,
             updated_at = NOW()
       WHERE is_active = TRUE
         AND complex_id IS NOT NULL
         AND source NOT IN (${placeholders})
         AND last_seen < NOW() - INTERVAL '7 days'
       RETURNING id, source
    `, known);
    if (result.rowCount > 0) {
      perSource._unknown_sources = result.rowCount;
      total += result.rowCount;
      logger.warn(`[StalenessSweeper] swept ${result.rowCount} rows from unknown sources`,
        { sources: [...new Set(result.rows.map(r => r.source))] });
    }
  } catch (e) {
    logger.warn('[StalenessSweeper] unknown-source sweep failed:', e.message);
  }

  const elapsed = Date.now() - startedAt;
  logger.info('[StalenessSweeper] Complete', { totalDeactivated: total, perSource, elapsedMs: elapsed });
  return { total, perSource, elapsedMs: elapsed, ranAt: new Date().toISOString() };
}

/**
 * Read-only count of how many listings WOULD be deactivated. Used by the
 * morning report to show "deactivated yesterday" without re-running the sweep.
 * Reads from the listings table; counts rows soft-deleted in the last 24h.
 */
async function recentlyDeactivatedCount() {
  try {
    const { rows } = await pool.query(`
      SELECT COUNT(*) AS c
        FROM listings
       WHERE is_active = FALSE
         AND complex_id IS NOT NULL
         AND updated_at > NOW() - INTERVAL '24 hours'
    `);
    return parseInt(rows[0]?.c || 0, 10);
  } catch (e) {
    return -1;
  }
}

module.exports = { runSweep, recentlyDeactivatedCount, STALE_WINDOWS };
