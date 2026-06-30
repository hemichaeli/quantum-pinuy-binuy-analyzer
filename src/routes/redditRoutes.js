/**
 * Reddit off-site mining — Apify Reddit Scraper integration (game-changer #4).
 * Surfaces diaspora pinui-binui / Israel real-estate questions to answer (off-site engine).
 * On-demand; self-seeding tables; existing APIFY_API_TOKEN.
 *   GET /api/reddit/run | /ingest | /results
 * NOTE: Reddit actors vary in input schema. Override actor via APIFY_REDDIT_ACTOR; this builds
 * Reddit search URLs (startUrls) which most actors accept.
 */
const express = require('express');
const axios = require('axios');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

const APIFY_BASE = 'https://api.apify.com/v2';
const REDDIT_ACTOR = process.env.APIFY_REDDIT_ACTOR || 'trudax~reddit-scraper-lite';
const TERMS = (process.env.REDDIT_TERMS || [
  'pinui binui', 'buy property in israel', 'israeli real estate', 'aliyah real estate', 'investment property israel'
].join('|')).split('|').map(s => s.trim()).filter(Boolean);
const MAX_ITEMS = Number(process.env.REDDIT_MAX || 50);

let _ready = null;
async function ensureTables() {
  if (_ready) return _ready;
  _ready = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reddit_threads (
        id SERIAL PRIMARY KEY, title TEXT, body TEXT, subreddit TEXT, url TEXT, author TEXT,
        score INT, num_comments INT, created TEXT, term TEXT, raw JSONB, run_id INT,
        created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS reddit_runs (
        id SERIAL PRIMARY KEY, apify_run_id TEXT, dataset_id TEXT, status TEXT DEFAULT 'running',
        started_at TIMESTAMPTZ DEFAULT NOW(), finished_at TIMESTAMPTZ, results_count INT DEFAULT 0);
    `);
    logger.info('[Reddit] tables ready');
  })().catch(e => { _ready = null; logger.error('[Reddit] ensureTables failed: ' + e.message); throw e; });
  return _ready;
}
ensureTables().catch(() => {});

async function startRun() {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new Error('APIFY_API_TOKEN not set');
  await ensureTables();
  // trudax/reddit-scraper-lite documented schema: searches[] + type + sort + time + maxItems.
  const input = { searches: TERMS, type: 'posts', sort: 'RELEVANCE', time: 'year', maxItems: MAX_ITEMS, skipComments: true };
  const r = await axios.post(`${APIFY_BASE}/acts/${REDDIT_ACTOR}/runs`, input, {
    headers: { Authorization: `Bearer ${token}` }, timeout: 30000, validateStatus: () => true });
  if (r.status < 200 || r.status >= 300 || !r.data?.data?.id) throw new Error(`actor start failed status=${r.status} (actor=${REDDIT_ACTOR}): ${JSON.stringify(r.data?.error || r.data).slice(0,200)}`);
  const run = r.data.data;
  const { rows } = await pool.query(`INSERT INTO reddit_runs (apify_run_id, dataset_id, status) VALUES ($1,$2,'running') RETURNING id`, [run.id, run.defaultDatasetId]);
  logger.info(`[Reddit] started run ${run.id} (actor ${REDDIT_ACTOR})`);
  return { runRowId: rows[0].id, apifyRunId: run.id, actor: REDDIT_ACTOR };
}

async function ingestFinished() {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) return { ingested: 0 };
  await ensureTables();
  const { rows: running } = await pool.query(`SELECT * FROM reddit_runs WHERE status='running' ORDER BY id DESC LIMIT 10`);
  let ingested = 0;
  for (const run of running) {
    try {
      const st = await axios.get(`${APIFY_BASE}/actor-runs/${run.apify_run_id}`, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000, validateStatus: () => true });
      const status = st.data?.data?.status;
      if (status === 'RUNNING' || status === 'READY') continue;
      if (status !== 'SUCCEEDED') { await pool.query(`UPDATE reddit_runs SET status=$1, finished_at=NOW() WHERE id=$2`, [String(status||'FAILED'), run.id]); continue; }
      const ds = await axios.get(`${APIFY_BASE}/datasets/${run.dataset_id}/items`, { headers: { Authorization: `Bearer ${token}` }, params: { clean: true, limit: 1000 }, timeout: 60000, validateStatus: () => true });
      const items = Array.isArray(ds.data) ? ds.data : [];
      for (const it of items) {
        if (it.dataType && it.dataType !== 'post') continue;
        await pool.query(`INSERT INTO reddit_threads (title, body, subreddit, url, author, score, num_comments, created, term, raw, run_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [it.title || null, (it.body || it.text || '').slice(0,2000) || null, it.parsedCommunityName || it.communityName || it.subreddit || null,
           it.url || it.link || null, it.username || it.author || null, it.upVotes ?? it.score ?? null,
           it.numberOfComments ?? it.numComments ?? null, it.createdAt || it.created || null, null, JSON.stringify(it).slice(0,4000), run.id]);
      }
      await pool.query(`UPDATE reddit_runs SET status='done', finished_at=NOW(), results_count=$1 WHERE id=$2`, [items.length, run.id]);
      ingested += items.length; logger.info(`[Reddit] ingested run ${run.id}: ${items.length}`);
    } catch (e) { logger.warn(`[Reddit] ingest error run ${run.id}: ${e.message}`); }
  }
  return { ingested };
}

router.get('/run', async (req, res) => { try { res.json({ ok: true, ...(await startRun()) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
router.get('/ingest', async (req, res) => { try { res.json({ ok: true, ...(await ingestFinished()) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
router.get('/results', async (req, res) => {
  try {
    await ensureTables();
    const total = await pool.query(`SELECT COUNT(*)::int n FROM reddit_threads`);
    const bySub = await pool.query(`SELECT subreddit, COUNT(*)::int n FROM reddit_threads GROUP BY subreddit ORDER BY n DESC LIMIT 15`);
    const sample = await pool.query(`SELECT title, subreddit, url, score, num_comments FROM reddit_threads ORDER BY id DESC LIMIT 40`);
    const lastRun = await pool.query(`SELECT id, status, results_count, started_at, finished_at FROM reddit_runs ORDER BY id DESC LIMIT 1`);
    res.json({ ok: true, total: total.rows[0].n, by_subreddit: bySub.rows, sample: sample.rows, last_run: lastRun.rows[0] || null });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
module.exports.startRun = startRun;
module.exports.ingestFinished = ingestFinished;
