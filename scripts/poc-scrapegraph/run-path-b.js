/**
 * Path B — Anthropic Haiku 4.5 raw HTML → JSON.
 *
 * Hard cost ceiling: $2 cumulative. Halts immediately on breach and writes
 * partial results to runs/path-b-*.json with status='budget_exceeded'.
 */

// Secrets in secrets.poc (Claude Code permission policy blocks .env.local)
require('dotenv').config({ path: __dirname + '/secrets.poc' });
const fs = require('fs');
const path = require('path');
const { extractHaiku, estimateCostUSD } = require('./lib/extract-haiku');

const CACHE_DIR = path.join(__dirname, '.cache', 'html');
const URL_LIST = path.join(__dirname, '.cache', 'urls.json');
const OUT_DIR = path.join(__dirname, 'runs');
const COST_CEILING = parseFloat(process.env.PATH_B_BUDGET_USD || '2');
const CONCURRENCY = parseInt(process.env.PATH_B_CONCURRENCY || '4', 10);

function percentile(arr, p) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[path-b] ANTHROPIC_API_KEY missing — populate scripts/poc-scrapegraph/.env.local');
    process.exit(2);
  }
  const entries = JSON.parse(fs.readFileSync(URL_LIST, 'utf8'));
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const rows = new Array(entries.length);
  const latencies = [];
  let totalCost = 0;
  let totalUsage = { input_tokens: 0, output_tokens: 0 };
  let next = 0;
  let halted = false;

  async function worker() {
    while (true) {
      if (halted) return;
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
        const r = await extractHaiku(html, modaaNum);
        const c = estimateCostUSD(r.usage);
        totalCost += c;
        totalUsage.input_tokens += r.usage.input_tokens;
        totalUsage.output_tokens += r.usage.output_tokens;
        latencies.push(r.latency_ms);
        rows[i] = { modaaNum, url, row: r.row, latency_ms: r.latency_ms, usage: r.usage, cost_usd: c, parse_error: r.parse_error };
        if (totalCost > COST_CEILING) {
          console.error(`[path-b] BUDGET EXCEEDED at $${totalCost.toFixed(4)} after row ${i + 1}/${entries.length}, halting`);
          halted = true;
          return;
        }
        if ((i + 1) % 5 === 0) {
          console.error(`[path-b] ${i + 1}/${entries.length}  cost=$${totalCost.toFixed(4)}  med=${percentile(latencies, 0.5)}ms`);
        }
      } catch (e) {
        rows[i] = { modaaNum, url, row: null, error: e.message };
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const outPath = path.join(OUT_DIR, `path-b-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    path: 'B',
    method: 'Anthropic claude-haiku-4-5 raw HTML→JSON',
    count: rows.filter(Boolean).length,
    status: halted ? 'budget_exceeded' : 'ok',
    latency_median_ms: percentile(latencies, 0.5),
    latency_p95_ms: percentile(latencies, 0.95),
    cost_usd: totalCost,
    usage: totalUsage,
    rows
  }, null, 2));
  console.error(`[path-b] wrote ${outPath} — cost=$${totalCost.toFixed(4)} status=${halted ? 'budget_exceeded' : 'ok'}`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
