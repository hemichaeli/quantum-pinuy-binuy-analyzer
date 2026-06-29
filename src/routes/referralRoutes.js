/**
 * Referral-partner discovery — Apify Google Maps Scraper integration.
 *
 * GAME-CHANGER #1 for QUANTUM (MARKETING COUNCIL, 2026-06-29): the diaspora buyer trusts
 * their existing advisors. This finds those advisors at scale (cross-border tax accountants,
 * Israel real-estate lawyers, aliyah advisors) across diaspora cities, into a table you can
 * work in Zoho / 1:1 outreach. Uses the rented Apify Google Maps actor + existing APIFY_API_TOKEN.
 * Self-seeding tables; async run + ingest; JSON results.
 *
 *   GET /api/referrals/run       — start an async actor run over the role×city matrix
 *   GET /api/referrals/ingest    — pull finished runs' datasets into referral_partners
 *   GET /api/referrals/results   — JSON summary
 */
const express = require('express');
const axios = require('axios');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

const APIFY_BASE = 'https://api.apify.com/v2';
// compass/crawler-google-places = "Google Maps Scraper" (most-used). Override via env if needed.
const GMAPS_ACTOR = process.env.APIFY_GMAPS_ACTOR || 'compass~crawler-google-places';

// Diaspora referral-partner search matrix (role x city). Edit freely.
const ROLES = (process.env.REFERRAL_ROLES || [
  'cross-border tax accountant Israel',
  'Israel real estate lawyer',
  'aliyah financial advisor'
].join('|')).split('|').map(s => s.trim()).filter(Boolean);
const CITIES = (process.env.REFERRAL_CITIES || [
  'New York', 'Los Angeles', 'Miami', 'Toronto', 'London', 'Manchester', 'Sydney', 'Melbourne'
].join('|')).split('|').map(s => s.trim()).filter(Boolean);
const MAX_PER_SEARCH = Number(process.env.REFERRAL_MAX_PER_SEARCH || 15);

let _ready = null;
async function ensureTables() {
  if (_ready) return _ready;
  _ready = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS referral_partners (
        id SERIAL PRIMARY KEY, name TEXT, role TEXT, city TEXT, country TEXT,
        phone TEXT, email TEXT, website TEXT, address TEXT, maps_url TEXT,
        rating NUMERIC, reviews INT, outreach_status TEXT DEFAULT 'new',
        source TEXT DEFAULT 'gmaps', created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(name, city));
      CREATE TABLE IF NOT EXISTS referral_runs (
        id SERIAL PRIMARY KEY, apify_run_id TEXT, dataset_id TEXT,
        status TEXT DEFAULT 'running', searches_count INT,
        started_at TIMESTAMPTZ DEFAULT NOW(), finished_at TIMESTAMPTZ, results_count INT DEFAULT 0);
    `);
    logger.info('[Referrals] tables ready');
  })().catch(e => { _ready = null; logger.error('[Referrals] ensureTables failed: ' + e.message); throw e; });
  return _ready;
}
ensureTables().catch(() => {});

function buildSearches() {
  const out = [];
  for (const role of ROLES) for (const city of CITIES) out.push(`${role} ${city}`);
  return out;
}

async function startRun() {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new Error('APIFY_API_TOKEN not set');
  await ensureTables();
  const searches = buildSearches();
  const input = {
    searchStringsArray: searches,
    maxCrawledPlacesPerSearch: MAX_PER_SEARCH,
    language: 'en',
    skipClosedPlaces: true
  };
  const r = await axios.post(`${APIFY_BASE}/acts/${GMAPS_ACTOR}/runs`, input, {
    headers: { Authorization: `Bearer ${token}` }, timeout: 30000, validateStatus: () => true
  });
  if (r.status < 200 || r.status >= 300 || !r.data?.data?.id) {
    throw new Error(`actor start failed status=${r.status}: ${JSON.stringify(r.data?.error || r.data).slice(0, 200)}`);
  }
  const run = r.data.data;
  const { rows } = await pool.query(
    `INSERT INTO referral_runs (apify_run_id, dataset_id, status, searches_count) VALUES ($1,$2,'running',$3) RETURNING id`,
    [run.id, run.defaultDatasetId, searches.length]);
  logger.info(`[Referrals] started run ${run.id} (${searches.length} searches)`);
  return { runRowId: rows[0].id, apifyRunId: run.id, searches: searches.length };
}

function roleCityFor(item) {
  // best-effort: match the search term back from item.searchString if present
  const s = (item.searchString || '').toLowerCase();
  const role = ROLES.find(r => s.includes(r.toLowerCase())) || null;
  const city = CITIES.find(c => s.includes(c.toLowerCase())) || item.city || null;
  return { role, city };
}

async function ingestFinished() {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) return { ingested: 0 };
  await ensureTables();
  const { rows: running } = await pool.query(`SELECT * FROM referral_runs WHERE status='running' ORDER BY id DESC LIMIT 10`);
  let ingested = 0;
  for (const run of running) {
    try {
      const st = await axios.get(`${APIFY_BASE}/actor-runs/${run.apify_run_id}`, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000, validateStatus: () => true });
      const status = st.data?.data?.status;
      if (status === 'RUNNING' || status === 'READY') continue;
      if (status !== 'SUCCEEDED') {
        await pool.query(`UPDATE referral_runs SET status=$1, finished_at=NOW() WHERE id=$2`, [String(status || 'FAILED'), run.id]);
        continue;
      }
      const ds = await axios.get(`${APIFY_BASE}/datasets/${run.dataset_id}/items`, { headers: { Authorization: `Bearer ${token}` }, params: { clean: true, limit: 1000 }, timeout: 60000, validateStatus: () => true });
      const items = Array.isArray(ds.data) ? ds.data : [];
      let added = 0;
      for (const it of items) {
        const { role, city } = roleCityFor(it);
        const res = await pool.query(
          `INSERT INTO referral_partners (name, role, city, country, phone, email, website, address, maps_url, rating, reviews, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'gmaps') ON CONFLICT (name, city) DO NOTHING`,
          [it.title || null, role, city, it.countryCode || null, it.phone || it.phoneUnformatted || null,
           (Array.isArray(it.emails) ? it.emails[0] : it.email) || null, it.website || null,
           it.address || null, it.url || null, it.totalScore ?? null, it.reviewsCount ?? null]);
        added += res.rowCount || 0;
      }
      await pool.query(`UPDATE referral_runs SET status='done', finished_at=NOW(), results_count=$1 WHERE id=$2`, [items.length, run.id]);
      ingested += added;
      logger.info(`[Referrals] ingested run ${run.id}: ${items.length} items, ${added} new partners`);
    } catch (e) { logger.warn(`[Referrals] ingest error run ${run.id}: ${e.message}`); }
  }
  return { ingested };
}

router.get('/run', async (req, res) => { try { res.json({ ok: true, ...(await startRun()) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
router.get('/ingest', async (req, res) => { try { res.json({ ok: true, ...(await ingestFinished()) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
router.get('/results', async (req, res) => {
  try {
    await ensureTables();
    const total = await pool.query(`SELECT COUNT(*)::int n FROM referral_partners`);
    const byRole = await pool.query(`SELECT role, city, COUNT(*)::int n FROM referral_partners GROUP BY role, city ORDER BY n DESC`);
    const sample = await pool.query(`SELECT name, role, city, phone, email, website FROM referral_partners ORDER BY id DESC LIMIT 50`);
    const lastRun = await pool.query(`SELECT id, status, searches_count, results_count, started_at, finished_at FROM referral_runs ORDER BY id DESC LIMIT 1`);
    res.json({ ok: true, total: total.rows[0].n, by_role_city: byRole.rows, sample: sample.rows, last_run: lastRun.rows[0] || null });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/export', async (req, res) => {
  try {
    await ensureTables();
    const { rows } = await pool.query(`SELECT name, role, city, phone, email, website, address, maps_url, rating, reviews, outreach_status FROM referral_partners ORDER BY city, role, name`);
    const cols = ['name','role','city','phone','email','website','address','maps_url','rating','reviews','outreach_status'];
    const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const csv = [cols.join(',')].concat(rows.map(r => cols.map(c => esc(r[c])).join(','))).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="referral_partners.csv"');
    res.send(csv);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
module.exports.startRun = startRun;
module.exports.ingestFinished = ingestFinished;
