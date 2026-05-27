/**
 * Discover and cache 100 komo.co.il listing pages.
 *
 * Source preference:
 *   1. DATABASE_URL → query listings WHERE source='komo' ORDER BY first_seen DESC LIMIT 100
 *   2. Otherwise walk komo's public search pages and collect modaaNum IDs
 *      from the same target cities used in src/services/komoDirectScraper.js
 *
 * All HTML cached to .cache/html/<modaaNum>.html so reruns don't re-fetch.
 */

require('dotenv').config({ path: __dirname + '/.env.local' });
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CACHE_DIR = path.join(__dirname, '.cache', 'html');
const URL_LIST = path.join(__dirname, '.cache', 'urls.json');
const TARGET = parseInt(process.env.TARGET_URLS || '100', 10);
const DELAY_MS = 1500;
const BASE_URL = 'https://www.komo.co.il';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
  'Referer': 'https://www.komo.co.il'
};

const CITIES = [
  'תל אביב', 'ירושלים', 'חיפה', 'ראשון לציון', 'פתח תקווה',
  'נתניה', 'בת ים', 'חולון', 'רמת גן', 'בני ברק',
  'רחובות', 'אשדוד', 'הרצליה', 'כפר סבא', 'רעננה',
  'מודיעין', 'אשקלון', 'באר שבע', 'הוד השרון', 'גבעתיים'
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fromDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const { Client } = require('pg');
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    const r = await client.query(
      `SELECT url, source_listing_id FROM listings
       WHERE source='komo' AND complex_id IS NOT NULL AND url IS NOT NULL
       ORDER BY first_seen DESC LIMIT $1`,
      [TARGET]
    );
    await client.end();
    return r.rows.map(row => ({
      modaaNum: row.source_listing_id,
      url: row.url
    })).filter(r => r.modaaNum && r.url);
  } catch (e) {
    console.error(`[fetch-urls] DB query failed: ${e.message}`);
    try { await client.end(); } catch {}
    return null;
  }
}

async function fromLiveSearch() {
  console.error('[fetch-urls] DB unavailable — bootstrapping from komo.co.il search pages');
  const ids = new Set();
  for (const city of CITIES) {
    if (ids.size >= TARGET) break;
    for (let page = 1; page <= 3; page++) {
      if (ids.size >= TARGET) break;
      try {
        const r = await axios.get(`${BASE_URL}/code/nadlan/apartments-for-sale.asp`, {
          params: { city, page },
          headers: HEADERS,
          timeout: 20000
        });
        const matches = [...r.data.matchAll(/modaaNum=(\d+)/g)];
        const newIds = [...new Set(matches.map(m => m[1]))];
        for (const id of newIds) {
          ids.add(id);
          if (ids.size >= TARGET) break;
        }
        console.error(`[fetch-urls] ${city} p${page} → ${newIds.length} ids (total ${ids.size}/${TARGET})`);
        if (newIds.length < 15) break;
        await sleep(DELAY_MS);
      } catch (e) {
        console.error(`[fetch-urls] search ${city} p${page} failed: ${e.message}`);
      }
    }
  }
  return [...ids].map(modaaNum => ({
    modaaNum,
    url: `${BASE_URL}/code/nadlan/details/?modaaNum=${modaaNum}`
  }));
}

async function fetchAndCache(entries) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  let ok = 0, cached = 0, failed = 0;
  for (const { modaaNum, url } of entries) {
    const file = path.join(CACHE_DIR, `${modaaNum}.html`);
    if (fs.existsSync(file) && fs.statSync(file).size > 500) {
      cached++; continue;
    }
    try {
      const r = await axios.get(url, { headers: HEADERS, timeout: 20000, responseType: 'text' });
      // axios may decode badly for non-utf8; komo serves utf-8 charset header
      fs.writeFileSync(file, r.data, 'utf8');
      ok++;
      if ((ok + cached) % 10 === 0) {
        console.error(`[fetch-urls] cached=${cached} fetched=${ok} failed=${failed} / ${entries.length}`);
      }
      await sleep(DELAY_MS);
    } catch (e) {
      failed++;
      console.error(`[fetch-urls] fetch ${modaaNum} failed: ${e.message}`);
    }
  }
  console.error(`[fetch-urls] done: fetched=${ok} cached=${cached} failed=${failed}`);
  return { ok, cached, failed };
}

async function main() {
  let entries = await fromDatabase();
  if (!entries || entries.length === 0) {
    entries = await fromLiveSearch();
  }
  if (entries.length === 0) {
    console.error('[fetch-urls] no URLs discovered, aborting');
    process.exit(2);
  }
  entries = entries.slice(0, TARGET);
  fs.mkdirSync(path.dirname(URL_LIST), { recursive: true });
  fs.writeFileSync(URL_LIST, JSON.stringify(entries, null, 2));
  console.error(`[fetch-urls] wrote ${entries.length} entries to ${URL_LIST}`);
  await fetchAndCache(entries);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { main, fromDatabase, fromLiveSearch };
