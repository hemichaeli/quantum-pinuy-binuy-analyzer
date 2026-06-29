/**
 * Competitor ad intelligence — Apify Facebook Ad Library Scraper integration.
 *
 * GAME-CHANGER #2 for QUANTUM (MARKETING COUNCIL, 2026-06-29): see exactly what competing
 * pinui-binui / Israeli real-estate firms advertise to the diaspora, so QUANTUM's creative +
 * offer land right (and we don't repeat the Meta troll mistake). Uses an Apify FB Ad Library
 * actor + existing APIFY_API_TOKEN. On-demand; self-seeding tables.
 *
 *   GET /api/fbads/run      — start a run over competitor search terms
 *   GET /api/fbads/ingest   — pull finished runs into competitor_ads
 *   GET /api/fbads/results  — JSON summary
 *
 * NOTE: FB Ad Library actors vary in slug + input schema. Override the actor via
 * APIFY_FBADS_ACTOR and terms via FBADS_TERMS / country via FBADS_COUNTRY if the default fails.
 */
const express = require('express');
const axios = require('axios');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

const APIFY_BASE = 'https://api.apify.com/v2';
const FBADS_ACTOR = process.env.APIFY_FBADS_ACTOR || 'curious_coder~facebook-ads-library-scraper';
const TERMS = (process.env.FBADS_TERMS || [
  'pinui binui', 'פינוי בינוי', 'israel real estate investment', 'buy apartment israel', 'urban renewal israel'
].join('|')).split('|').map(s => s.trim()).filter(Boolean);
const COUNTRY = process.env.FBADS_COUNTRY || 'IL';
const MAX_ADS = Number(process.env.FBADS_MAX || 50);

let _ready = null;
async function ensureTables() {
  if (_ready) return _ready;
  _ready = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS competitor_ads (
        id SERIAL PRIMARY KEY, page_name TEXT, ad_text TEXT, term TEXT, cta TEXT,
        start_date TEXT, snapshot_url TEXT, raw JSONB, source TEXT DEFAULT 'fb_ad_library',
        created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS fbads_runs (
        id SERIAL PRIMARY KEY, apify_run_id TEXT, dataset_id TEXT, status TEXT DEFAULT 'running',
        terms_count INT, started_at TIMESTAMPTZ DEFAULT NOW(), finished_at TIMESTAMPTZ, results_count INT DEFAULT 0);
    `);
    logger.info('[FBAds] tables ready');
  })().catch(e => { _ready = null; logger.error('[FBAds] ensureTables failed: ' + e.message); throw e; });
  return _ready;
}
ensureTables().catch(() => {});

async function startRun() {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new Error('APIFY_API_TOKEN not set');
  await ensureTables();
  // This actor expects FB Ad Library search URLs. Build one per term.
  const urls = TERMS.map(t => ({
    url: `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=${encodeURIComponent(COUNTRY)}&q=${encodeURIComponent(t)}&search_type=keyword_unordered&media_type=all`
  }));
  const input = { urls, count: MAX_ADS, "scrapePageAds.activeStatus": "all", "scrapeAdDetails": true };
  const r = await axios.post(`${APIFY_BASE}/acts/${FBADS_ACTOR}/runs`, input, {
    headers: { Authorization: `Bearer ${token}` }, timeout: 30000, validateStatus: () => true
  });
  if (r.status < 200 || r.status >= 300 || !r.data?.data?.id) {
    throw new Error(`actor start failed status=${r.status} (actor=${FBADS_ACTOR}): ${JSON.stringify(r.data?.error || r.data).slice(0, 200)}`);
  }
  const run = r.data.data;
  const { rows } = await pool.query(
    `INSERT INTO fbads_runs (apify_run_id, dataset_id, status, terms_count) VALUES ($1,$2,'running',$3) RETURNING id`,
    [run.id, run.defaultDatasetId, TERMS.length]);
  logger.info(`[FBAds] started run ${run.id} (${TERMS.length} terms, actor ${FBADS_ACTOR})`);
  return { runRowId: rows[0].id, apifyRunId: run.id, actor: FBADS_ACTOR };
}

async function ingestFinished() {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) return { ingested: 0 };
  await ensureTables();
  const { rows: running } = await pool.query(`SELECT * FROM fbads_runs WHERE status='running' ORDER BY id DESC LIMIT 10`);
  let ingested = 0;
  for (const run of running) {
    try {
      const st = await axios.get(`${APIFY_BASE}/actor-runs/${run.apify_run_id}`, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000, validateStatus: () => true });
      const status = st.data?.data?.status;
      if (status === 'RUNNING' || status === 'READY') continue;
      if (status !== 'SUCCEEDED') {
        await pool.query(`UPDATE fbads_runs SET status=$1, finished_at=NOW() WHERE id=$2`, [String(status || 'FAILED'), run.id]);
        continue;
      }
      const ds = await axios.get(`${APIFY_BASE}/datasets/${run.dataset_id}/items`, { headers: { Authorization: `Bearer ${token}` }, params: { clean: true, limit: 1000 }, timeout: 60000, validateStatus: () => true });
      const items = Array.isArray(ds.data) ? ds.data : [];
      for (const it of items) {
        const pageName = it.pageName || it.page_name || it.advertiser || null;
        const adText = it.adText || it.ad_creative_body || it.body || it.text || (it.snapshot && it.snapshot.body) || null;
        const cta = it.ctaText || it.cta_type || (it.snapshot && it.snapshot.cta_text) || null;
        const startDate = it.startDate || it.ad_delivery_start_time || it.start_date || null;
        const snap = it.url || it.snapshotUrl || it.ad_snapshot_url || null;
        await pool.query(
          `INSERT INTO competitor_ads (page_name, ad_text, term, cta, start_date, snapshot_url, raw)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [pageName, adText, it.searchTerm || null, cta, startDate ? String(startDate) : null, snap, JSON.stringify(it).slice(0, 8000)]);
      }
      await pool.query(`UPDATE fbads_runs SET status='done', finished_at=NOW(), results_count=$1 WHERE id=$2`, [items.length, run.id]);
      ingested += items.length;
      logger.info(`[FBAds] ingested run ${run.id}: ${items.length} ads`);
    } catch (e) { logger.warn(`[FBAds] ingest error run ${run.id}: ${e.message}`); }
  }
  return { ingested };
}

router.get('/run', async (req, res) => { try { res.json({ ok: true, ...(await startRun()) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
router.get('/ingest', async (req, res) => { try { res.json({ ok: true, ...(await ingestFinished()) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
router.get('/results', async (req, res) => {
  try {
    await ensureTables();
    const total = await pool.query(`SELECT COUNT(*)::int n FROM competitor_ads`);
    const byPage = await pool.query(`SELECT page_name, COUNT(*)::int n FROM competitor_ads GROUP BY page_name ORDER BY n DESC LIMIT 30`);
    const sample = await pool.query(`SELECT page_name, ad_text, cta, start_date, snapshot_url FROM competitor_ads ORDER BY id DESC LIMIT 40`);
    const lastRun = await pool.query(`SELECT id, status, terms_count, results_count, started_at, finished_at FROM fbads_runs ORDER BY id DESC LIMIT 1`);
    res.json({ ok: true, total: total.rows[0].n, by_page: byPage.rows, sample: sample.rows, last_run: lastRun.rows[0] || null });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
module.exports.startRun = startRun;
module.exports.ingestFinished = ingestFinished;
