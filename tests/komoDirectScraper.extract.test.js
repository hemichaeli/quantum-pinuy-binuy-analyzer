/**
 * Smoke test for komoDirectScraper.extractFromHtml against the 25 cached
 * komo.co.il pages from scripts/poc-scrapegraph/.cache/html/.
 *
 * Bypasses Jest/Mocha so the project's "no test framework wired up" status
 * doesn't block this. Run directly: `node tests/komoDirectScraper.extract.test.js`.
 */

// Satisfy ../src/db/pool.js require-time DATABASE_URL check.
// We never make a DB call from extractFromHtml; the pool sits idle.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:5432/test';

const fs = require('fs');
const path = require('path');
const { extractFromHtml } = require('../src/services/komoDirectScraper');

// Stub logger so requiring the module doesn't blow up if logger has side effects
const CACHE = path.join(__dirname, '..', 'scripts', 'poc-scrapegraph', '.cache', 'html');

function main() {
  if (!fs.existsSync(CACHE)) {
    console.error(`SKIP: no cached PoC HTML at ${CACHE} — run scripts/poc-scrapegraph/fetch-urls.js first`);
    process.exit(0);
  }
  const files = fs.readdirSync(CACHE).filter(f => f.endsWith('.html'));
  if (files.length === 0) { console.error('SKIP: no cached files'); process.exit(0); }

  const REQUIRED = ['address', 'price', 'rooms', 'area_sqm'];
  const FIELDS = ['address', 'city', 'price', 'rooms', 'area_sqm', 'floor', 'description'];
  const perField = Object.fromEntries(FIELDS.map(f => [f, 0]));
  let complete = 0;
  const issues = [];

  for (const f of files) {
    const modaaNum = f.replace(/\.html$/, '');
    const html = fs.readFileSync(path.join(CACHE, f), 'utf8');
    const row = extractFromHtml(html, modaaNum);
    for (const k of FIELDS) {
      if (row[k] !== null && row[k] !== '' && row[k] !== undefined) perField[k]++;
    }
    if (REQUIRED.every(k => row[k] !== null && row[k] !== '' && row[k] !== undefined)) {
      complete++;
    } else {
      issues.push({ modaaNum, missing: REQUIRED.filter(k => row[k] === null || row[k] === '' || row[k] === undefined), row });
    }
  }

  console.log(`extractFromHtml smoke — n=${files.length}`);
  for (const k of FIELDS) {
    console.log(`  ${k.padEnd(14)} ${perField[k]}/${files.length} = ${(perField[k] / files.length * 100).toFixed(0)}%`);
  }
  console.log(`  complete-row    ${complete}/${files.length} = ${(complete / files.length * 100).toFixed(0)}%`);

  // ASSERT: the price ₪-direction bug is gone — at least 90% of pages must extract price.
  const priceRate = perField.price / files.length;
  if (priceRate < 0.9) {
    console.error(`\nFAIL: price extraction below 90% (${(priceRate * 100).toFixed(0)}%). Bug not fixed.`);
    process.exit(1);
  }
  // ASSERT: complete-row yield clears 70% (regex-only) — sensible bar for the no-LLM happy path.
  if (complete / files.length < 0.7) {
    console.error(`\nFAIL: complete-row yield below 70% (${(complete / files.length * 100).toFixed(0)}%).`);
    if (issues.length) console.error('First issue:', JSON.stringify(issues[0], null, 2));
    process.exit(1);
  }
  console.log('\nPASS');
}

main();
