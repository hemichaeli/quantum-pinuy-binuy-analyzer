/**
 * Tiny 4-page Path C run (credit-constrained: 40 credits → 4 calls).
 * Skips the modaaNum already used in the probe.
 *
 * Writes runs/path-c-mini-<iso>.json in the same shape as run-path-c.js.
 */
require('dotenv').config({ path: __dirname + '/secrets.poc', override: true });
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { extractSgai } = require('./lib/extract-sgai');

const URL_LIST = path.join(__dirname, '.cache', 'urls.json');
const OUT_DIR = path.join(__dirname, 'runs');
const PROBE_MODAA = '4616766';
const N = 4;

async function getCredits(key) {
  const r = await axios.get('https://api.scrapegraphai.com/v1/credits',
    { headers: { 'SGAI-APIKEY': key }, validateStatus: () => true });
  return r.data;
}

(async () => {
  const key = process.env.SGAI_API_KEY;
  if (!key) { console.error('SGAI_API_KEY missing'); process.exit(2); }

  const entries = JSON.parse(fs.readFileSync(URL_LIST, 'utf8'))
    .filter(e => e.modaaNum !== PROBE_MODAA)
    .slice(0, N);

  const startCredits = await getCredits(key);
  console.error('[path-c] starting credits:', JSON.stringify(startCredits));

  const rows = [];
  const latencies = [];
  for (let i = 0; i < entries.length; i++) {
    const { modaaNum, url } = entries[i];
    console.error(`[path-c] ${i+1}/${entries.length} — modaaNum=${modaaNum}`);
    const t0 = Date.now();
    const r = await extractSgai(null, modaaNum, { url });
    if (r.latency_ms) latencies.push(r.latency_ms);
    rows.push({ modaaNum, url, row: r.row, latency_ms: r.latency_ms, parse_error: r.parse_error, error: r.error, request_id: r.request_id });
    console.error(`  status=${r.error ? 'ERR ('+r.error+')' : 'ok'}  latency=${r.latency_ms}ms`);
    if (r.error) break; // surface error early; don't keep burning credits
  }

  const endCredits = await getCredits(key);
  const creditsUsed = (startCredits.remaining_credits || 0) - (endCredits.remaining_credits || 0);
  console.error('[path-c] ending credits:', JSON.stringify(endCredits), 'used=', creditsUsed);

  const med = arr => { if (!arr.length) return null; const s=[...arr].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; };
  const p95 = arr => { if (!arr.length) return null; const s=[...arr].sort((a,b)=>a-b); return s[Math.floor(s.length*0.95)] || s[s.length-1]; };

  const outPath = path.join(OUT_DIR, `path-c-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    path: 'C',
    method: 'ScrapeGraphAI v1 /smartscraper (live URL fetch)',
    note: 'SG re-fetches the URL server-side; not byte-identical input to A/B. n constrained by free-tier credits.',
    count: rows.filter(r => r.row).length,
    status: rows.some(r => r.error) ? 'partial' : 'ok',
    starting_credits: startCredits,
    ending_credits: endCredits,
    credits_used: creditsUsed,
    latency_median_ms: med(latencies),
    latency_p95_ms: p95(latencies),
    rows
  }, null, 2));
  console.error('[path-c] wrote', outPath);
})();
