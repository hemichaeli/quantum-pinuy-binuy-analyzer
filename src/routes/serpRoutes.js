/**
 * SERP / AEO rank tracking — Apify Google Search Scraper integration (game-changer #3).
 * Tracks where QUANTUM (and competitors) rank for diaspora pinui-binui queries on Google.
 * On-demand; self-seeding tables; existing APIFY_API_TOKEN.
 *   GET /api/serp/run | /ingest | /results
 */
const express = require('express');
const axios = require('axios');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

const APIFY_BASE = 'https://api.apify.com/v2';
const SERP_ACTOR = process.env.APIFY_SERP_ACTOR || 'apify~google-search-scraper';
const QUERIES = (process.env.SERP_QUERIES || [
  'buy property in israel from abroad', 'invest in israeli real estate', 'pinui binui investment',
  'israeli real estate for foreigners', 'buy apartment in israel remotely', 'buy israeli property from usa',
  'is pinui binui a good investment', 'pinui binui explained'
].join('\n'));
const COUNTRY = process.env.SERP_COUNTRY || 'us';

let _ready = null;
async function ensureTables() {
  if (_ready) return _ready;
  _ready = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS serp_results (
        id SERIAL PRIMARY KEY, query TEXT, position INT, title TEXT, url TEXT, domain TEXT,
        is_quantum BOOLEAN DEFAULT FALSE, run_id INT, created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS serp_runs (
        id SERIAL PRIMARY KEY, apify_run_id TEXT, dataset_id TEXT, status TEXT DEFAULT 'running',
        started_at TIMESTAMPTZ DEFAULT NOW(), finished_at TIMESTAMPTZ, results_count INT DEFAULT 0);
    `);
    logger.info('[SERP] tables ready');
  })().catch(e => { _ready = null; logger.error('[SERP] ensureTables failed: ' + e.message); throw e; });
  return _ready;
}
ensureTables().catch(() => {});

async function startRun() {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new Error('APIFY_API_TOKEN not set');
  await ensureTables();
  const input = { queries: QUERIES, resultsPerPage: 10, maxPagesPerQuery: 1, countryCode: COUNTRY, languageCode: 'en' };
  const r = await axios.post(`${APIFY_BASE}/acts/${SERP_ACTOR}/runs`, input, {
    headers: { Authorization: `Bearer ${token}` }, timeout: 30000, validateStatus: () => true });
  if (r.status < 200 || r.status >= 300 || !r.data?.data?.id) throw new Error(`actor start failed status=${r.status}: ${JSON.stringify(r.data?.error || r.data).slice(0,200)}`);
  const run = r.data.data;
  const { rows } = await pool.query(`INSERT INTO serp_runs (apify_run_id, dataset_id, status) VALUES ($1,$2,'running') RETURNING id`, [run.id, run.defaultDatasetId]);
  logger.info(`[SERP] started run ${run.id}`);
  return { runRowId: rows[0].id, apifyRunId: run.id };
}

async function ingestFinished() {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) return { ingested: 0 };
  await ensureTables();
  const { rows: running } = await pool.query(`SELECT * FROM serp_runs WHERE status='running' ORDER BY id DESC LIMIT 10`);
  let ingested = 0;
  for (const run of running) {
    try {
      const st = await axios.get(`${APIFY_BASE}/actor-runs/${run.apify_run_id}`, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000, validateStatus: () => true });
      const status = st.data?.data?.status;
      if (status === 'RUNNING' || status === 'READY') continue;
      if (status !== 'SUCCEEDED') { await pool.query(`UPDATE serp_runs SET status=$1, finished_at=NOW() WHERE id=$2`, [String(status||'FAILED'), run.id]); continue; }
      const ds = await axios.get(`${APIFY_BASE}/datasets/${run.dataset_id}/items`, { headers: { Authorization: `Bearer ${token}` }, params: { clean: true, limit: 1000 }, timeout: 60000, validateStatus: () => true });
      const items = Array.isArray(ds.data) ? ds.data : [];
      let n = 0;
      for (const it of items) {
        const q = it.searchQuery?.term || it.searchQuery || null;
        for (const o of (it.organicResults || [])) {
          const url = o.url || '';
          let domain = ''; try { domain = new URL(url).hostname.replace(/^www\./,''); } catch {}
          await pool.query(`INSERT INTO serp_results (query, position, title, url, domain, is_quantum, run_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [q, o.position ?? null, o.title || null, url || null, domain, /u-r-quantum\.com/i.test(url), run.id]);
          n++;
        }
      }
      await pool.query(`UPDATE serp_runs SET status='done', finished_at=NOW(), results_count=$1 WHERE id=$2`, [n, run.id]);
      ingested += n; logger.info(`[SERP] ingested run ${run.id}: ${n} rows`);
    } catch (e) { logger.warn(`[SERP] ingest error run ${run.id}: ${e.message}`); }
  }
  return { ingested };
}

router.get('/run', async (req, res) => { try { res.json({ ok: true, ...(await startRun()) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
router.get('/ingest', async (req, res) => { try { res.json({ ok: true, ...(await ingestFinished()) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
router.get('/results', async (req, res) => {
  try {
    await ensureTables();
    const quantum = await pool.query(`SELECT query, MIN(position) pos FROM serp_results WHERE is_quantum AND run_id=(SELECT MAX(run_id) FROM serp_results) GROUP BY query ORDER BY pos`);
    const topDomains = await pool.query(`SELECT domain, COUNT(*)::int n FROM serp_results WHERE run_id=(SELECT MAX(run_id) FROM serp_results) GROUP BY domain ORDER BY n DESC LIMIT 20`);
    const lastRun = await pool.query(`SELECT id, status, results_count, started_at, finished_at FROM serp_runs ORDER BY id DESC LIMIT 1`);
    res.json({ ok: true, quantum_rankings: quantum.rows, top_domains: topDomains.rows, last_run: lastRun.rows[0] || null });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
module.exports.startRun = startRun;
module.exports.ingestFinished = ingestFinished;
