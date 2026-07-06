// nadlanApifyService.js
// Real nadlan.gov.il sold-transaction ingestion via the Apify actor swerve/nadlan-deals
// ("Israel Real Estate Sold Prices: Official Transactions").
//
// WHY: the old direct nadlan.gov.il REST API was retired when the site was rebuilt as a
// React SPA (the modern flow is GovMap geocode -> tikmeda GetProductList, behind a WAF that
// blocks server calls). The legacy src/services/nadlanScraper.js therefore fell back to
// Perplexity AI guesses, which is why only ~138 of 1606 eligible compounds have enough real
// comps to score. This service fetches REAL sold deals per city through Apify (managed
// anti-bot) and links each deal to a compound by street/house address, growing per-compound
// comp coverage for the listing-level scorer.
//
// Cost control: one actor run per CITY (not per compound). maxItems caps billed rows.
// FIRST RUN must be probeShape() to confirm the actor's output field names, since the actor
// has no public README and the normalizer maps a wide set of candidate keys defensively.

const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
const ACTOR = 'swerve~nadlan-deals';
const API = 'https://api.apify.com/v2';
const SOURCE = 'apify_nadlan';
const PSM_MIN = 3000, PSM_MAX = 250000;
// dealDateRange valid enum: 'all' | '3' | '6' | '12' | '60' (months). '60' covers the
// scorer's 24-month comp window (the scorer trims by date anyway).
const DEAL_RANGE_DEFAULT = '60';

// The actor's `cities` field is an enum of 81 supported cities (exact Hebrew spelling).
// For any other city, `customCities` accepts free-text Hebrew and geocodes it.
const CITY_ENUM = new Set(['ירושלים','תל אביב -יפו','חיפה','ראשון לציון','פתח תקווה','אשדוד','באר שבע','נתניה','חולון','בני ברק','רמת גן','בת ים','רחובות','אשקלון','בית שמש','כפר סבא','הרצלייה','מודיעין-מכבים-רעות','חדרה','נצרת','לוד','רעננה','רמלה','מודיעין עילית','רהט','גבעתיים','קריית אתא','נהרייה','הוד השרון','אום אל-פחם','קריית גת','אילת','עכו','ביתר עילית','נס ציונה','כרמיאל','רמת השרון','עפולה','אלעד','טבריה','ראש העין','נצרת עילית','טייבה','קריית מוצקין','שפרעם','קריית ים','קריית ביאליק','מעלה אדומים','יבנה','פרדס חנה-כרכור','קריית אונו','אור יהודה','דימונה','צפת','טמרה','נתיבות','יהוד-מונוסון',"סח'נין",'באקה אל-גרביה','גדרה','אופקים','מגדל העמק','מבשרת ציון','ערד','גבעת שמואל','טירה','ערערה','נשר','קריית שמונה','עראבה','שדרות','זכרון יעקב','קריית מלאכי','גן יבנה','מעלות-תרשיחא','מגאר','כפר קאסם','יקנעם עילית','קלנסווה','כפר יונה','כפר כנא']);
const CITY_ALIAS = { 'תל אביב': 'תל אביב -יפו', 'תל אביב יפו': 'תל אביב -יפו', 'תל אביב-יפו': 'תל אביב -יפו', 'הרצליה': 'הרצלייה', 'נהריה': 'נהרייה', 'יהוד': 'יהוד-מונוסון' };
function cityInput(city) {
  const c = String(city || '').trim();
  const mapped = CITY_ALIAS[c] || c;
  return CITY_ENUM.has(mapped) ? { cities: [mapped] } : { customCities: [c] };
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const pick = (o, keys) => {
  for (const k of keys) if (o[k] !== null && o[k] !== undefined && o[k] !== '') return o[k];
  return null;
};

// Normalize a raw actor item to our canonical transaction shape. Tolerant of field-name
// variants; probeShape() prints the real keys so this can be tightened after the first run.
function normalizeDeal(raw) {
  const price = num(pick(raw, ['price', 'dealAmount', 'DEALAMOUNT', 'amount', 'salePrice', 'priceNis', 'mchir']));
  const area = num(pick(raw, ['area', 'areaSqm', 'area_sqm', 'ASSETAREA', 'sqm', 'builtArea', 'shetach']));
  const rooms = num(pick(raw, ['rooms', 'roomsNum', 'ASSETROOMNUM', 'roomCount', 'chadarim']));
  const floor = num(pick(raw, ['floor', 'floorNo', 'FLOORNO', 'koma']));
  const date = pick(raw, ['dealDate', 'date', 'transactionDate', 'DEALDATETIME', 'DEALDATE', 'soldDate', 'taarich']);
  const street = pick(raw, ['street', 'streetName', 'ASSETADDRESS', 'rechov']);
  const house = pick(raw, ['houseNumber', 'house_number', 'ASSETHOUSENUMBER', 'buildingNumber', 'mispar']);
  const address = pick(raw, ['address', 'fullAddress', 'displayAddress', 'ktovet'])
    || [street, house].filter(Boolean).join(' ').trim() || null;
  const city = pick(raw, ['cityName', 'city', 'ASSETCITYNAME', 'settlement', 'yishuv']);
  const neighborhood = pick(raw, ['neighborhoodName', 'neighborhood', 'neighbourhood', 'quarter', 'shchuna']);
  const gush = pick(raw, ['gush', 'block']);
  const helka = pick(raw, ['helka', 'parcel']);
  const lat = num(pick(raw, ['lat', 'latitude']));
  const lng = num(pick(raw, ['lng', 'lon', 'longitude']));
  let ppsm = num(pick(raw, ['pricePerSqm', 'price_per_sqm', 'pricePerSquareMeter', 'mchirLemeter']));
  if (!ppsm && price && area > 0) ppsm = Math.round(price / area);
  const sid = pick(raw, ['assetId', 'id', 'dealId', 'objectId', 'KEYVALUE', 'OBJECTID'])
    || (date && price ? `${date}-${price}-${area || ''}` : null);
  // The actor's `address` is frequently null; fall back to the cadastral parcel so the row is identifiable.
  const addr = address || (gush && helka ? `gush ${gush} helka ${helka}` : null);
  return { transaction_date: date || null, price, area_sqm: area, rooms, floor, price_per_sqm: ppsm,
           address: addr, street: street || null, house: house || null, city: city || null,
           neighborhood: neighborhood || null, gush: gush || null, helka: helka || null, lat, lng, source_id: sid };
}

// ---------- Apify run (async start + poll, so big cities do not hit HTTP timeouts) ----------
async function runActor(input, { waitMs = 480000 } = {}) {
  if (!APIFY_TOKEN) throw new Error('APIFY_API_TOKEN not set');
  const start = await axios.post(`${API}/acts/${ACTOR}/runs?token=${APIFY_TOKEN}`, input,
    { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });
  const runId = start.data?.data?.id;
  const datasetId = start.data?.data?.defaultDatasetId;
  if (!runId) throw new Error('Apify run did not start');
  const t0 = Date.now();
  let status = start.data.data.status;
  while (['READY', 'RUNNING'].includes(status)) {
    if (Date.now() - t0 > waitMs) throw new Error(`Apify run ${runId} timed out after ${waitMs}ms`);
    await new Promise(r => setTimeout(r, 5000));
    const st = await axios.get(`${API}/actor-runs/${runId}?token=${APIFY_TOKEN}`, { timeout: 20000 });
    status = st.data?.data?.status;
  }
  if (status !== 'SUCCEEDED') throw new Error(`Apify run ${runId} ended ${status}`);
  const items = await axios.get(`${API}/datasets/${datasetId}/items?clean=true&format=json&token=${APIFY_TOKEN}`,
    { timeout: 60000 });
  return Array.isArray(items.data) ? items.data : [];
}

// First-run helper: fetch a handful and report the raw keys + a normalized sample.
async function probeShape(city, maxItems = 8) {
  const raw = await runActor({ ...cityInput(city), dealDateRange: '12', maxItems });
  const sample = raw[0] || null;
  return {
    fetched: raw.length,
    rawKeys: sample ? Object.keys(sample) : [],
    rawSample: sample,
    normalizedSample: sample ? normalizeDeal(sample) : null,
  };
}

// ---------- Address linking: deal -> compound in the same city ----------
const normStreet = (s) => (s || '')
  .replace(/^(רחוב|רח['׳]?|שדרות|שד['׳]?|שדרה)\s+/u, '')
  .replace(/["'׳״.,]/g, '')
  .replace(/\d+.*$/, '')      // drop house number and anything after
  .replace(/\s+/g, ' ')
  .trim();
const houseOf = (s) => { const m = String(s || '').match(/(\d+)/); return m ? m[1] : null; };

// Load an index of compounds for a city: street -> [{ id, houses:Set }]
async function loadCompoundIndex(city) {
  const { rows } = await pool.query(
    `SELECT id, addresses FROM complexes WHERE city = $1 AND addresses IS NOT NULL AND addresses <> ''`, [city]);
  const byStreet = new Map();
  for (const r of rows) {
    for (const part of String(r.addresses).split(/[,;]/)) {
      const st = normStreet(part);
      if (!st || st.length < 2) continue;
      const h = houseOf(part);
      if (!byStreet.has(st)) byStreet.set(st, new Map()); // street -> (complexId -> houses Set)
      const perComplex = byStreet.get(st);
      if (!perComplex.has(r.id)) perComplex.set(r.id, new Set());
      if (h) perComplex.get(r.id).add(h);
    }
  }
  return byStreet;
}

// Resolve a deal to a single complex_id, or null if none / ambiguous.
function linkDeal(deal, byStreet) {
  const st = normStreet(deal.street || deal.address);
  if (!st) return null;
  const perComplex = byStreet.get(st);
  if (!perComplex) return null;
  const ids = [...perComplex.keys()];
  if (ids.length === 1) return ids[0];                 // one compound on this street -> assign
  const h = houseOf(deal.house || deal.address);       // multiple compounds share the street
  if (h) { for (const id of ids) if (perComplex.get(id).has(h)) return id; }
  return null;                                         // ambiguous -> skip (do not pollute comps)
}

async function storeDeal(complexId, d) {
  if (!d.price || !d.transaction_date) return false;
  if (d.price_per_sqm && (d.price_per_sqm < PSM_MIN || d.price_per_sqm > PSM_MAX)) return false;
  if (d.source_id) {
    const ex = await pool.query('SELECT 1 FROM transactions WHERE complex_id=$1 AND source=$2 AND source_id=$3',
      [complexId, SOURCE, d.source_id]);
    if (ex.rows.length) return false;
  }
  const dup = await pool.query(
    'SELECT 1 FROM transactions WHERE complex_id=$1 AND transaction_date=$2 AND price=$3 AND COALESCE(address,\'\')=COALESCE($4,\'\')',
    [complexId, d.transaction_date, d.price, d.address]);
  if (dup.rows.length) return false;
  await pool.query(
    `INSERT INTO transactions (complex_id, transaction_date, price, area_sqm, rooms, floor, price_per_sqm, address, city, source, source_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [complexId, d.transaction_date, d.price, d.area_sqm, d.rooms, d.floor, d.price_per_sqm, d.address, d.city, SOURCE, d.source_id]);
  return true;
}

// Ingest all deals for a city: run actor -> normalize -> link -> store.
async function ingestCity(city, { dealDateRange = DEAL_RANGE_DEFAULT, maxItems = 800, rooms } = {}) {
  const input = { ...cityInput(city), dealDateRange, maxItems };
  if (rooms) input.rooms = rooms;
  const raw = await runActor(input);
  const byStreet = await loadCompoundIndex(city);
  let linked = 0, stored = 0, unlinked = 0;
  for (const r of raw) {
    const d = normalizeDeal(r);
    if (city && d.city && !String(d.city).includes(city) && !city.includes(d.city)) { /* keep, city filter is soft */ }
    const cid = linkDeal(d, byStreet);
    if (!cid) { unlinked++; continue; }
    linked++;
    if (await storeDeal(cid, d)) stored++;
  }
  logger.info(`[nadlanApify] ${city}: fetched=${raw.length} linked=${linked} stored=${stored} unlinked=${unlinked}`);
  return { city, fetched: raw.length, linked, stored, unlinked, compoundsInCity: byStreet.size };
}

async function ingestCities(cities, opts = {}) {
  const results = [];
  for (const c of cities) {
    try { results.push(await ingestCity(c, opts)); }
    catch (e) { logger.error(`[nadlanApify] ${c} failed: ${e.message}`); results.push({ city: c, error: e.message }); }
  }
  const totals = results.reduce((a, r) => ({
    fetched: a.fetched + (r.fetched || 0), linked: a.linked + (r.linked || 0), stored: a.stored + (r.stored || 0),
  }), { fetched: 0, linked: 0, stored: 0 });
  return { totals, results };
}

module.exports = { probeShape, ingestCity, ingestCities, normalizeDeal, linkDeal, loadCompoundIndex };
