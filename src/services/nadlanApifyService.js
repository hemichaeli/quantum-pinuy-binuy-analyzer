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
const { queryGemini } = require('./geminiEnrichmentService');

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
  // First-hand = new-build first sale (the replacement units). Not a comp for old-stock
  // fair value; exclude so it does not inflate P_fair.
  const firstHand = raw.isFirstHand === true || raw.isFirstHand === 'true' || raw.isFirstHand === 1;
  let ppsm = num(pick(raw, ['pricePerSqm', 'price_per_sqm', 'pricePerSquareMeter', 'mchirLemeter']));
  if (!ppsm && price && area > 0) ppsm = Math.round(price / area);
  const sid = pick(raw, ['assetId', 'id', 'dealId', 'objectId', 'KEYVALUE', 'OBJECTID'])
    || (date && price ? `${date}-${price}-${area || ''}` : null);
  // The actor's `address` is frequently null; fall back to the cadastral parcel so the row is identifiable.
  const addr = address || (gush && helka ? `gush ${gush} helka ${helka}` : null);
  return { transaction_date: date || null, price, area_sqm: area, rooms, floor, price_per_sqm: ppsm,
           address: addr, street: street || null, house: house || null, city: city || null,
           neighborhood: neighborhood || null, gush: gush || null, helka: helka || null, lat, lng,
           is_first_hand: firstHand, source_id: sid };
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

// ---------- Geocoding + coordinate-proximity linking ----------
// The actor's deals carry lat/lng + gush/helka but no street address, and compounds carry
// only street addresses. So we geocode each compound's address to a point (once), then
// attach a deal to the nearest compound within a tight radius.
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const GOOGLE_GEOCODE = 'https://maps.googleapis.com/maps/api/geocode/json';
// Google Maps Geocoding is accurate for Israeli addresses (Nominatim is not). Uses a
// dedicated Maps key, falling back to the shared Google key. Requires the Geocoding API
// enabled on the GCP project. Nominatim is the last-resort fallback.
const GEO_KEY = process.env.GOOGLE_MAPS_API_KEY || process.env.GEMINI_API_KEY || '';
const usingGoogle = () => Boolean(GEO_KEY);

function haversineM(aLat, aLng, bLat, bLng) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function geocodeAddress(q) {
  if (GEO_KEY) {
    try {
      const { data } = await axios.get(GOOGLE_GEOCODE,
        { params: { address: q, region: 'il', language: 'he', key: GEO_KEY }, timeout: 15000 });
      if (data.status === 'OK' && data.results?.[0]) {
        const lt = data.results[0].geometry.location_type; // ROOFTOP > RANGE_INTERPOLATED > GEOMETRIC_CENTER > APPROXIMATE
        if (lt !== 'APPROXIMATE') {
          const loc = data.results[0].geometry.location;
          return { lat: loc.lat, lng: loc.lng, precise: lt === 'ROOFTOP' || lt === 'RANGE_INTERPOLATED' };
        }
        return null; // city-level result is useless for proximity
      }
      if (data.status === 'REQUEST_DENIED') logger.warn(`[nadlanApify] Google Geocoding denied: ${data.error_message}`);
      else if (data.status !== 'ZERO_RESULTS') logger.warn(`[nadlanApify] Google Geocoding ${data.status}`);
    } catch (e) { logger.warn(`[nadlanApify] Google geocode error: ${e.message}`); }
  }
  try {
    const res = await axios.get(NOMINATIM, {
      params: { format: 'json', q, countrycodes: 'il', limit: 1 },
      headers: { 'User-Agent': 'QUANTUM-pinuy-binuy-analyzer/1.0 (hemi@u-r-quantum.com)' }, timeout: 15000,
    });
    const hit = Array.isArray(res.data) ? res.data[0] : null;
    if (!hit) return null;
    const lat = Number(hit.lat), lng = Number(hit.lon);
    return (Number.isFinite(lat) && Number.isFinite(lng)) ? { lat, lng, precise: false } : null;
  } catch { return null; }
}

// Geocode compounds in a city that have active listings but no lat/lng yet.
// Nominatim policy: max 1 req/sec, valid User-Agent. Bounded by `limit`.
async function geocodeCompounds(city, { limit = 150 } = {}) {
  const { rows } = await pool.query(
    `SELECT DISTINCT c.id, c.addresses, c.city FROM complexes c
       JOIN listings l ON l.complex_id = c.id AND l.is_active = TRUE
      WHERE c.city = $1 AND c.lat IS NULL AND c.addresses IS NOT NULL AND c.addresses <> ''
      LIMIT $2`, [city, limit]);
  let done = 0, failed = 0;
  for (const r of rows) {
    const firstAddr = String(r.addresses).split(/[,;]/)[0].trim();
    if (!firstAddr) { failed++; continue; }
    try {
      const pt = await geocodeAddress(`${firstAddr}, ${r.city}, ישראל`);
      if (pt) { await pool.query('UPDATE complexes SET lat=$1, lng=$2, geocoded_at=NOW() WHERE id=$3', [pt.lat, pt.lng, r.id]); done++; }
      else failed++;
    } catch (e) { failed++; }
    await new Promise(res => setTimeout(res, usingGoogle() ? 120 : 1100)); // Google 50 QPS vs Nominatim 1/sec
  }
  if (rows.length) logger.info(`[nadlanApify] geocoded ${done}/${rows.length} compounds in ${city} (failed ${failed})`);
  return { city, attempted: rows.length, geocoded: done, failed };
}

async function loadCompoundGeoIndex(city) {
  const { rows } = await pool.query(
    `SELECT id, lat, lng FROM complexes WHERE city = $1 AND lat IS NOT NULL AND lng IS NOT NULL`, [city]);
  return rows.map(r => ({ id: r.id, lat: Number(r.lat), lng: Number(r.lng) }));
}

// Nearest compound within maxMeters, skipped if a second compound is almost as close
// (ambiguous) unless we are very close (< 90m) to the winner.
function linkByProximity(deal, geoIndex, maxMeters = 200) {
  if (!Number.isFinite(deal.lat) || !Number.isFinite(deal.lng) || !geoIndex.length) return null;
  let best = null, bestD = Infinity, second = Infinity;
  for (const c of geoIndex) {
    const d = haversineM(deal.lat, deal.lng, c.lat, c.lng);
    if (d < bestD) { second = bestD; bestD = d; best = c; }
    else if (d < second) { second = d; }
  }
  if (!best || bestD > maxMeters) return null;
  if (bestD > 90 && second < bestD * 1.35) return null;
  return best.id;
}

async function storeDeal(complexId, d) {
  if (!d.price || !d.transaction_date) return false;
  if (d.price_per_sqm && (d.price_per_sqm < PSM_MIN || d.price_per_sqm > PSM_MAX)) return false;
  if (d.source_id) {
    const ex = await pool.query('SELECT 1 FROM transactions WHERE complex_id=$1 AND source=$2 AND source_id=$3',
      [complexId, SOURCE, d.source_id]);
    if (ex.rows.length) return false;
  }
  await pool.query(
    `INSERT INTO transactions (complex_id, transaction_date, price, area_sqm, rooms, floor, price_per_sqm,
                               address, city, neighborhood, gush, helka, lat, lng, source, source_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [complexId, d.transaction_date, d.price, d.area_sqm, d.rooms, d.floor, d.price_per_sqm,
     d.address, d.city, d.neighborhood, d.gush, d.helka, d.lat, d.lng, SOURCE, d.source_id]);
  return true;
}

// Ingest all deals for a city: geocode compounds -> run actor -> proximity-link -> store.
async function ingestCity(city, { dealDateRange = DEAL_RANGE_DEFAULT, maxItems = 800, rooms, geocodeLimit = 150 } = {}) {
  const geo = await geocodeCompounds(city, { limit: geocodeLimit });
  const geoIndex = await loadCompoundGeoIndex(city);
  const input = { ...cityInput(city), dealDateRange, maxItems };
  if (rooms) input.rooms = rooms;
  const raw = await runActor(input);
  let linked = 0, stored = 0, unlinked = 0, nogeo = 0, firsthand = 0;
  const gushVotes = new Map(); // complexId -> Map(gush -> count)
  for (const r of raw) {
    const d = normalizeDeal(r);
    if (d.is_first_hand) { firsthand++; continue; }               // new-build, not a resale comp
    if (!Number.isFinite(d.lat) || !Number.isFinite(d.lng)) { nogeo++; continue; }
    const cid = linkByProximity(d, geoIndex);
    if (!cid) { unlinked++; continue; }
    linked++;
    if (d.gush) { if (!gushVotes.has(cid)) gushVotes.set(cid, new Map()); const m = gushVotes.get(cid); m.set(d.gush, (m.get(d.gush) || 0) + 1); }
    if (await storeDeal(cid, d)) stored++;
  }
  // Adopt each compound's modal gush from its linked deals -> the key the Mavat cross-check validates.
  let gushAdopted = 0;
  for (const [cid, m] of gushVotes) {
    let bestG = null, bestC = 0;
    for (const [g, c] of m) if (c > bestC) { bestC = c; bestG = g; }
    if (bestG) { const u = await pool.query('UPDATE complexes SET gush=$1 WHERE id=$2 AND gush IS NULL', [bestG, cid]); gushAdopted += u.rowCount; }
  }
  logger.info(`[nadlanApify] ${city}: fetched=${raw.length} geoCompounds=${geoIndex.length} linked=${linked} stored=${stored} unlinked=${unlinked} nogeo=${nogeo} firsthand=${firsthand} gushAdopted=${gushAdopted}`);
  return { city, fetched: raw.length, geocodedNow: geo.geocoded, geoCompounds: geoIndex.length, linked, stored, unlinked, nogeo, firsthand, gushAdopted };
}

// Mavat cross-check: for compounds whose gush was adopted from linked deals, ask Gemini
// (Google Search grounded on mavat.iplan.gov.il + the government nadlan site) for the
// official cadastral gush and compare. Agreement confirms the geocode->deal linkage is
// on the right parcel; a mismatch flags a compound whose deals may be mis-attributed.
async function crossCheckMavat(city, { limit = 20 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, name, city, addresses, plan_number, gush FROM complexes
      WHERE city = $1 AND gush IS NOT NULL ORDER BY id LIMIT $2`, [city, limit]);
  const results = [];
  for (const c of rows) {
    const addr = String(c.addresses || '').split(/[,;]/)[0].trim();
    const prompt = `מהו מספר הגוש (block) של מתחם ההתחדשות העירונית "${c.name}" בכתובת ${addr}, ${c.city}`
      + `${c.plan_number ? `, תכנית ${c.plan_number}` : ''}? חפש ב-mavat.iplan.gov.il ובאתר נדלן הממשלתי. `
      + `החזר JSON בלבד: {"gush":"<number or null>"}`;
    let mavatGush = null;
    try {
      const txt = await queryGemini(prompt, 'You return only strict JSON with a numeric gush or null.', true);
      const m = String(txt).match(/"?gush"?\s*:\s*"?(\d{3,6})"?/);
      if (m) mavatGush = m[1];
    } catch (e) { /* soft: leave null */ }
    const agree = mavatGush != null && String(mavatGush) === String(c.gush);
    if (mavatGush != null) {
      await pool.query('UPDATE complexes SET gush_verified = $1 WHERE id = $2', [agree, c.id]).catch(() => {});
    }
    results.push({ id: c.id, name: c.name, adopted_gush: c.gush, mavat_gush: mavatGush, agree });
  }
  const agreed = results.filter(r => r.agree).length;
  logger.info(`[nadlanApify] Mavat cross-check ${city}: ${agreed}/${results.length} gush agree`);
  return { city, checked: results.length, agreed, results };
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

module.exports = { probeShape, ingestCity, ingestCities, geocodeCompounds, crossCheckMavat, normalizeDeal, linkByProximity };
