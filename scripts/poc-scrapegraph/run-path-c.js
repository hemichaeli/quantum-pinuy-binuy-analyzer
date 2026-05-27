/**
 * Path C — scrapegraphai SDK end-to-end.
 *
 * Hard ceilings:
 *   - Credits: stops when cumulative credits_used > 100
 *   - Wall clock: stops after 25 minutes (combined with A+B should fit 45min)
 * Writes partial results to runs/path-c-*.json with status='budget_exceeded'
 * on breach.
 */

require('dotenv').config({ path: __dirname + '/.env.local' });
const fs = require('fs');
const path = require('path');
const { extractSgai } = require('./lib/extract-sgai');

const CACHE_DIR = path.join(__dirname, '.cache', 'html');
const URL_LIST = path.join(__dirname, '.cache', 'urls.json');
const OUT_DIR = path.join(__dirname, 'runs');
const CREDIT_CEILING = parseInt(process.env.PATH_C_CREDIT_CEILING || '100', 10);
const TIME_CEILING_MS = parseInt(process.env.PATH_C_TIME_CEILING_MS || `${25 * 60 * 1000}`, 10);
const CONCURRENCY = parseInt(process.env.PATH_C_CONCURRENCY || '2', 10);

function percentile(arr, p) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

async function main() {
  if (!process.env.SGAI_API_KEY) {
    console.error('[path-c] SGAI_API_KEY missing — skipping Path C');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'path-c-skipped.json'),
      JSON.stringify({ path: 'C', status: 'skipped_no_key' }, null, 2));
    return;
  }
  const entries = JSON.parse(fs.readFileSync(URL_LIST, 'utf8'));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tStart = Date.now();
  const rows = new Array(entries.length);
  const latencies = [];
  let totalCredits = 0;
  let halted = false;
  let haltReason = null;
  let next = 0;

  async function worker() {
    while (true) {
      if (halted) return;
      if (Date.now() - tStart > TIME_CEILING_MS) {
        haltReason = 'time_ceiling'; halted = true; return;
      }
      const i = next++;
      if (i >= entries.length) return;
      const { modaaNum, url } = entries[i];
      const file = path.join(CACHE_DIR, `${modaaNum}.html`);
      if (!fs.existsSync(file)) {
        rows[i] = { modaaNum, url, row: null, error: 'no_cache' };
        continue;
      }
      const html = fs.readFileSync(file, 'utf8');
      try {
        const r = await extractSgai(html, modaaNum);
        totalCredits += r.credits_used || 1;
        if (r.latency_ms) latencies.push(r.latency_ms);
        rows[i] = {
          modaaNum, url, row: r.row, latency_ms: r.latency_ms,
          credits_used: r.credits_used || 1, parse_error: r.parse_error,
          request_id: r.request_id || null
        };
        if (totalCredits >= CREDIT_CEILING) {
          console.error(`[path-c] CREDIT CEILING reached at ${totalCredits} after row ${i + 1}/${entries.length}, halting`);
          haltReason = 'credit_ceiling';
          halted = true;
          return;
        }
        if ((i + 1) % 5 === 0) {
          console.error(`[path-c] ${i + 1}/${entries.length}  credits=${totalCredits}  med=${percentile(latencies, 0.5)}ms`);
        }
      } catch (e) {
        rows[i] = { modaaNum, url, row: null, error: e.message };
        // hard SDK errors halt — likely auth/quota
        if (/401|403|quota|payment|insufficient/i.test(e.message)) {
          haltReason = 'sdk_error: ' + e.message;
          halted = true;
          return;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const outPath = path.join(OUT_DIR, `path-c-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    path: 'C',
    method: 'scrapegraphai SDK smartScraper (hosted)',
    count: rows.filter(Boolean).length,
    status: halted ? `halted: ${haltReason}` : 'ok',
    latency_median_ms: percentile(latencies, 0.5),
    latency_p95_ms: percentile(latencies, 0.95),
    credits_used: totalCredits,
    rows
  }, null, 2));
  console.error(`[path-c] wrote ${outPath} — credits=${totalCredits} status=${halted ? haltReason : 'ok'}`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
