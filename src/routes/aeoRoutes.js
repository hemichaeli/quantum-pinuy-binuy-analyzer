/**
 * AEO / Competitor Intelligence — answer-engine visibility tracking.
 *
 * Uses the rented Apify actor `inovaflow/ai-brand-monitoring` (verified accessible)
 * to capture how QUANTUM (and competitors) show up in Google AI Overview answers
 * for a curated diaspora-investor prompt list. Self-contained: creates + seeds its
 * own tables on boot; async run + ingest; JSON + a standalone dashboard tab.
 *
 *   GET /api/aeo/run        — start an async actor run over active prompts
 *   GET /api/aeo/ingest     — pull finished runs' datasets into ai_visibility_results
 *   GET /api/aeo/results    — JSON summary for the dashboard
 *   GET /api/aeo/dashboard  — standalone HTML tab
 */
const express = require('express');
const axios = require('axios');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

const AEO_ACTOR = 'inovaflow~ai-brand-monitoring';
const APIFY_BASE = 'https://api.apify.com/v2';
const BRAND = { brand: 'U-R-Quantum', brandAliases: ['QUANTUM', 'U-R Quantum', 'ur-quantum', 'יו אר קוונטום'], brandDomains: ['u-r-quantum.com'] };
const COUNTRIES = (process.env.AEO_COUNTRIES || 'us').split(',').map(s => s.trim()).filter(Boolean);

// ── Council-built prompt list (diaspora-investor AEO) ────────────────────────
const SEED_PROMPTS = [
  ['What is pinui-binui in Israeli real estate?', 'concept', 'TOFU', 'yes'],
  ['Is buying Israeli real estate a good investment for foreigners?', 'thesis', 'TOFU', 'maybe'],
  ['What is urban renewal property investment in Israel?', 'concept', 'TOFU', 'yes'],
  ['How does Tama 38 differ from pinui-binui?', 'concept', 'TOFU', 'yes'],
  ['Can a foreign Jew buy an apartment in Israel?', 'eligibility', 'TOFU', 'yes'],
  ['How can I invest in Israeli real estate from abroad?', 'process', 'MOFU', 'yes'],
  ['What taxes do foreigners pay buying property in Israel?', 'tax', 'MOFU', 'maybe'],
  ['Can foreigners get a mortgage to buy property in Israel?', 'financing', 'MOFU', 'maybe'],
  ['What are the risks of buying urban-renewal apartments in Israel?', 'risk', 'MOFU', 'yes'],
  ['Best cities in Israel for real estate investment 2026', 'geo', 'MOFU', 'no'],
  ['Is pinui-binui a safe investment for overseas buyers?', 'risk', 'MOFU', 'yes'],
  ['How do diaspora Jews buy property in Israel remotely?', 'process', 'MOFU', 'yes'],
  ['What is an off-market apartment deal in Israel?', 'concept', 'MOFU', 'yes'],
  ['Step-by-step guide to buying an Israeli apartment as a non-resident', 'process', 'MOFU', 'yes'],
  ['Best companies to buy off-market Israeli urban-renewal apartments', 'vendor', 'BOFU', 'yes'],
  ['Who helps foreign Jews invest in Israeli real estate?', 'vendor', 'BOFU', 'yes'],
  ['Best Israeli real estate broker for diaspora investors', 'vendor', 'BOFU', 'yes'],
  ['Trusted pinui-binui investment firms in Israel for foreign buyers', 'vendor', 'BOFU', 'yes'],
  ['How to find a buyers agent for Israeli urban renewal property', 'vendor', 'BOFU', 'yes'],
  ['מה זה פינוי בינוי ולמה זו השקעה טובה?', 'concept', 'HE', 'maybe'],
  ['איך יהודי תושב חוץ קונה דירה בפינוי בינוי בישראל?', 'process', 'HE', 'yes'],
  ['חברות שמלוות משקיעים מחו"ל בנדל"ן פינוי בינוי', 'vendor', 'HE', 'yes']
];

// dominant pinui-binui agents found in our scraped data (research 2026-06-22)
const SEED_COMPETITORS = [
  ['נהוראי ביטון', 'both', 421, 255, 'listings'],
  ['ירון בן בכור', 'both', 420, 245, 'listings'],
  ['אימפריית הנדל"ן', 'competitor', 37, 27, 'listings'],
  ['מוטי-אל הנכס', 'competitor', 29, 22, 'listings'],
  ['זמיר נדל"ן', 'competitor', 17, 5, 'listings'],
  ['צוות רוזנברגר', 'competitor', 12, 8, 'listings']
];

let _ready = null;
async function ensureTables() {
  if (_ready) return _ready;
  _ready = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_visibility_prompts (
        id SERIAL PRIMARY KEY, prompt TEXT UNIQUE NOT NULL,
        tag TEXT, stage TEXT, could_cite TEXT, active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS ai_visibility_runs (
        id SERIAL PRIMARY KEY, apify_run_id TEXT, dataset_id TEXT,
        status TEXT DEFAULT 'running', prompts_count INT,
        started_at TIMESTAMPTZ DEFAULT NOW(), finished_at TIMESTAMPTZ, results_count INT DEFAULT 0);
      CREATE TABLE IF NOT EXISTS ai_visibility_results (
        id SERIAL PRIMARY KEY, run_id INT, prompt TEXT, country TEXT, surface TEXT,
        present BOOLEAN, answer_text TEXT, citation_count INT,
        brand_mentions JSONB, competitor_mentions JSONB, brand_in_citations JSONB,
        scraped_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE INDEX IF NOT EXISTS idx_aeo_results_run ON ai_visibility_results(run_id);
      CREATE TABLE IF NOT EXISTS competitor_watch (
        id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, relationship TEXT DEFAULT 'competitor',
        listings INT, complexes INT, source TEXT, notes TEXT, active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW());
    `);
    for (const [prompt, tag, stage, cc] of SEED_PROMPTS) {
      await pool.query(
        `INSERT INTO ai_visibility_prompts (prompt, tag, stage, could_cite) VALUES ($1,$2,$3,$4)
         ON CONFLICT (prompt) DO NOTHING`, [prompt, tag, stage, cc]);
    }
    for (const [name, rel, listings, complexes, src] of SEED_COMPETITORS) {
      await pool.query(
        `INSERT INTO competitor_watch (name, relationship, listings, complexes, source) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (name) DO UPDATE SET relationship=EXCLUDED.relationship, listings=EXCLUDED.listings, complexes=EXCLUDED.complexes`,
        [name, rel, listings, complexes, src]);
    }
    logger.info('[AEO] tables ready + seeded');
  })().catch(e => { _ready = null; logger.error('[AEO] ensureTables failed: ' + e.message); throw e; });
  return _ready;
}
ensureTables().catch(() => {});

// ── Start an async actor run over active prompts ─────────────────────────────
async function startRun() {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new Error('APIFY_API_TOKEN not set');
  await ensureTables();
  const { rows: prompts } = await pool.query(`SELECT prompt FROM ai_visibility_prompts WHERE active = TRUE ORDER BY id`);
  const { rows: comps } = await pool.query(`SELECT name FROM competitor_watch WHERE active = TRUE`);
  if (!prompts.length) throw new Error('no active prompts');
  const input = {
    prompts: prompts.map(p => p.prompt),
    ...BRAND,
    competitors: comps.map(c => c.name),
    watchCompetitors: true,
    country: COUNTRIES
  };
  const r = await axios.post(`${APIFY_BASE}/acts/${AEO_ACTOR}/runs`, input, {
    headers: { Authorization: `Bearer ${token}` }, timeout: 30000, validateStatus: () => true
  });
  if (r.status < 200 || r.status >= 300 || !r.data?.data?.id) {
    throw new Error(`actor start failed status=${r.status}: ${JSON.stringify(r.data?.error || r.data).slice(0, 200)}`);
  }
  const run = r.data.data;
  const { rows } = await pool.query(
    `INSERT INTO ai_visibility_runs (apify_run_id, dataset_id, status, prompts_count) VALUES ($1,$2,'running',$3) RETURNING id`,
    [run.id, run.defaultDatasetId, prompts.length]);
  logger.info(`[AEO] started run ${run.id} (${prompts.length} prompts × ${COUNTRIES.length} countries)`);
  return { runRowId: rows[0].id, apifyRunId: run.id };
}

// ── Ingest finished runs ─────────────────────────────────────────────────────
async function ingestFinished() {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) return { ingested: 0 };
  await ensureTables();
  const { rows: running } = await pool.query(`SELECT * FROM ai_visibility_runs WHERE status = 'running' ORDER BY id DESC LIMIT 10`);
  let ingested = 0;
  for (const run of running) {
    try {
      const st = await axios.get(`${APIFY_BASE}/actor-runs/${run.apify_run_id}`, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000, validateStatus: () => true });
      const status = st.data?.data?.status;
      if (status === 'RUNNING' || status === 'READY') continue;
      if (status !== 'SUCCEEDED') {
        await pool.query(`UPDATE ai_visibility_runs SET status=$1, finished_at=NOW() WHERE id=$2`, [String(status || 'FAILED'), run.id]);
        continue;
      }
      const ds = await axios.get(`${APIFY_BASE}/datasets/${run.dataset_id}/items`, { headers: { Authorization: `Bearer ${token}` }, params: { clean: true, limit: 1000 }, timeout: 60000, validateStatus: () => true });
      const items = Array.isArray(ds.data) ? ds.data : [];
      for (const it of items) {
        await pool.query(
          `INSERT INTO ai_visibility_results (run_id, prompt, country, surface, present, answer_text, citation_count, brand_mentions, competitor_mentions, brand_in_citations, scraped_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [run.id, it.query || null, it.country || null, it.surface || null, it.present ?? null,
           it.answer_text || null, it.citation_count ?? null,
           JSON.stringify(it.brand_mentions || []), JSON.stringify(it.competitor_mentions || []), JSON.stringify(it.brand_in_citations || []),
           it.scraped_at || null]);
      }
      await pool.query(`UPDATE ai_visibility_runs SET status='done', finished_at=NOW(), results_count=$1 WHERE id=$2`, [items.length, run.id]);
      ingested += items.length;
      logger.info(`[AEO] ingested run ${run.id}: ${items.length} rows`);
    } catch (e) { logger.warn(`[AEO] ingest error run ${run.id}: ${e.message}`); }
  }
  return { ingested };
}

router.get('/run', async (req, res) => { try { res.json({ ok: true, ...(await startRun()) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
router.get('/ingest', async (req, res) => { try { res.json({ ok: true, ...(await ingestFinished()) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });

router.get('/results', async (req, res) => {
  try {
    await ensureTables();
    const latest = await pool.query(`SELECT id, started_at, finished_at, status, results_count FROM ai_visibility_runs WHERE status='done' ORDER BY id DESC LIMIT 1`);
    const runId = latest.rows[0]?.id;
    const results = runId ? (await pool.query(
      `SELECT r.prompt, r.country, r.surface, r.present, r.citation_count,
              jsonb_array_length(COALESCE(r.brand_mentions,'[]'))   AS brand_n,
              jsonb_array_length(COALESCE(r.competitor_mentions,'[]')) AS comp_n,
              jsonb_array_length(COALESCE(r.brand_in_citations,'[]')) AS brand_cited_n,
              p.stage, p.could_cite
       FROM ai_visibility_results r LEFT JOIN ai_visibility_prompts p ON p.prompt = r.prompt
       WHERE r.run_id = $1 ORDER BY p.stage NULLS LAST, r.prompt`, [runId])).rows : [];
    const present = results.filter(r => r.present).length;
    const branded = results.filter(r => r.brand_n > 0).length;
    const comps = await pool.query(`SELECT name, relationship, listings, complexes FROM competitor_watch WHERE active=TRUE ORDER BY listings DESC NULLS LAST`);
    res.json({ ok: true, run: latest.rows[0] || null, totals: { rows: results.length, aio_present: present, brand_mentioned: branded }, results, competitors: comps.rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/dashboard', async (req, res) => {
  res.type('html').send(`<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QUANTUM · AEO / מתחרים</title><style>
body{font-family:system-ui,Arial;background:#0b1220;color:#e6edf7;margin:0;padding:20px}h1{font-size:20px}h2{font-size:15px;color:#9fb3d1;margin-top:26px}
table{border-collapse:collapse;width:100%;font-size:13px;margin-top:8px}th,td{border:1px solid #1e2b44;padding:6px 8px;text-align:right}th{background:#13203a}
.pill{padding:1px 7px;border-radius:9px;font-size:11px}.y{background:#10391f;color:#7ee2a8}.n{background:#3a1414;color:#f0a0a0}.m{background:#3a2f10;color:#e7cd7a}
.kpi{display:inline-block;background:#13203a;border:1px solid #1e2b44;border-radius:10px;padding:10px 16px;margin:6px}.kpi b{font-size:22px;display:block}
.bofu{color:#7ee2a8}.muted{color:#6b7c99}</style></head><body>
<h1>QUANTUM — נראות במנועי-תשובה (AEO) + מתחרים</h1>
<div id="kpis"></div>
<h2>תוצאות הריצה האחרונה</h2><div id="res">טוען…</div>
<h2>מעקב מתחרים / שותפי-מקור (מהדאטה שלנו)</h2><div id="comp"></div>
<p class="muted" style="margin-top:20px">הרצה ידנית: <code>/api/aeo/run</code> · קליטה: <code>/api/aeo/ingest</code></p>
<script>
const ccCls={yes:'y',maybe:'m',no:'n'};
fetch('/api/aeo/results').then(r=>r.json()).then(d=>{
 if(!d.ok){document.getElementById('res').textContent='שגיאה: '+d.error;return;}
 const t=d.totals||{};
 document.getElementById('kpis').innerHTML=
  '<div class="kpi"><b>'+(t.rows||0)+'</b>שורות</div>'+
  '<div class="kpi"><b>'+(t.aio_present||0)+'</b>AI-Overview הופיע</div>'+
  '<div class="kpi"><b>'+(t.brand_mentioned||0)+'</b>QUANTUM אוזכר</div>'+
  '<div class="kpi muted"><b>'+(d.run?new Date(d.run.finished_at).toLocaleString('he-IL'):'—')+'</b>ריצה אחרונה</div>';
 const rows=(d.results||[]).map(r=>'<tr><td>'+(r.prompt||'')+'</td><td>'+(r.stage||'')+'</td>'+
  '<td><span class="pill '+(ccCls[r.could_cite]||'')+'">'+(r.could_cite||'')+'</span></td>'+
  '<td>'+(r.present?'✓':'—')+'</td><td>'+(r.citation_count||0)+'</td>'+
  '<td>'+(r.brand_n>0?'<span class="pill y">'+r.brand_n+'</span>':'—')+'</td>'+
  '<td>'+(r.comp_n||0)+'</td></tr>').join('');
 document.getElementById('res').innerHTML='<table><tr><th>Prompt</th><th>שלב</th><th>פוטנציאל-ציטוט</th><th>AIO</th><th>ציטוטים</th><th>QUANTUM</th><th>מתחרים</th></tr>'+rows+'</table>'
   +(d.results&&d.results.length?'':'<p class="muted">אין עדיין תוצאות — הרץ /api/aeo/run ואז /api/aeo/ingest</p>');
 document.getElementById('comp').innerHTML='<table><tr><th>שם</th><th>יחס</th><th>מודעות</th><th>מתחמים</th></tr>'+
  (d.competitors||[]).map(c=>'<tr><td>'+c.name+'</td><td>'+(c.relationship==='both'?'מתחרה+שותף':c.relationship)+'</td><td>'+(c.listings||'')+'</td><td>'+(c.complexes||'')+'</td></tr>').join('')+'</table>';
}).catch(e=>{document.getElementById('res').textContent='שגיאה: '+e.message;});
</script></body></html>`);
});

module.exports = router;
module.exports.startRun = startRun;
module.exports.ingestFinished = ingestFinished;
