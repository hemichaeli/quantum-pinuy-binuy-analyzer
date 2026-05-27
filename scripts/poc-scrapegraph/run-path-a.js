/**
 * Path A — regex extraction over .cache/html/*.html
 * No API calls, no cost, no LLM. Pure CPU.
 */

require('dotenv').config({ path: __dirname + '/.env.local' });
const fs = require('fs');
const path = require('path');
const { extractRegex } = require('./lib/extract-regex');

const CACHE_DIR = path.join(__dirname, '.cache', 'html');
const URL_LIST = path.join(__dirname, '.cache', 'urls.json');
const OUT_DIR = path.join(__dirname, 'runs');

function percentile(arr, p) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function main() {
  const entries = JSON.parse(fs.readFileSync(URL_LIST, 'utf8'));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rows = [];
  const latencies = [];
  for (const { modaaNum, url } of entries) {
    const file = path.join(CACHE_DIR, `${modaaNum}.html`);
    if (!fs.existsSync(file)) {
      rows.push({ modaaNum, url, row: null, error: 'no_cache' });
      continue;
    }
    const html = fs.readFileSync(file, 'utf8');
    const t0 = Date.now();
    const row = extractRegex(html, modaaNum);
    const dt = Date.now() - t0;
    latencies.push(dt);
    rows.push({ modaaNum, url, row, latency_ms: dt });
  }
  const outPath = path.join(OUT_DIR, `path-a-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    path: 'A',
    method: 'regex (komoDirectScraper port)',
    count: rows.length,
    latency_median_ms: percentile(latencies, 0.5),
    latency_p95_ms: percentile(latencies, 0.95),
    cost_usd: 0,
    rows
  }, null, 2));
  console.error(`[path-a] wrote ${outPath}`);
}

if (require.main === module) main();
