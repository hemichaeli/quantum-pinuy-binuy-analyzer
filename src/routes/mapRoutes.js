/**
 * Map Routes - Day 6 (2026-04-28).
 *
 * GET /api/map/data    — complexes + active listings positioned at city centroids.
 * GET /api/map/cities  — city centroid table for zoom-to-city UI.
 *
 * Coordinates strategy: the analyzer DB does not yet have lat/lng columns
 * on complexes/listings. Day 6 uses a hardcoded city-centroid lookup so
 * the map renders something useful immediately. PostGIS migration is a
 * later task. Markers are jittered ±0.005 deg to avoid stacking.
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

// City centroids (lat, lng, WGS84). Coverage focused on cities that
// appear in the analyzer's complexes / listings data. Add more here
// as needed; missing cities are returned without coords.
const CITY_CENTROIDS = {
  'תל אביב':       { lat: 32.0853, lng: 34.7818 },
  'תל אביב-יפו':   { lat: 32.0853, lng: 34.7818 },
  'ירושלים':       { lat: 31.7683, lng: 35.2137 },
  'חיפה':          { lat: 32.7940, lng: 34.9896 },
  'ראשון לציון':   { lat: 31.9540, lng: 34.8044 },
  'פתח תקווה':     { lat: 32.0871, lng: 34.8870 },
  'אשדוד':         { lat: 31.8044, lng: 34.6553 },
  'נתניה':         { lat: 32.3286, lng: 34.8567 },
  'באר שבע':       { lat: 31.2518, lng: 34.7913 },
  'בני ברק':       { lat: 32.0840, lng: 34.8338 },
  'חולון':         { lat: 32.0167, lng: 34.7792 },
  'רמת גן':        { lat: 32.0689, lng: 34.8242 },
  'אשקלון':        { lat: 31.6688, lng: 34.5715 },
  'רחובות':        { lat: 31.8947, lng: 34.8086 },
  'בת ים':         { lat: 32.0167, lng: 34.7500 },
  'בית שמש':       { lat: 31.7456, lng: 34.9886 },
  'כפר סבא':       { lat: 32.1750, lng: 34.9069 },
  'הרצליה':        { lat: 32.1624, lng: 34.8447 },
  'חדרה':          { lat: 32.4344, lng: 34.9197 },
  'מודיעין':       { lat: 31.8928, lng: 35.0078 },
  'נצרת':          { lat: 32.6996, lng: 35.3035 },
  'רמלה':          { lat: 31.9293, lng: 34.8666 },
  'לוד':           { lat: 31.9522, lng: 34.8954 },
  'רעננה':         { lat: 32.1847, lng: 34.8708 },
  'גבעתיים':       { lat: 32.0719, lng: 34.8108 },
  'הוד השרון':     { lat: 32.1561, lng: 34.8881 },
  'קריית גת':      { lat: 31.6107, lng: 34.7642 },
  'אילת':          { lat: 29.5577, lng: 34.9519 },
  'נהריה':         { lat: 33.0034, lng: 35.0978 },
  'טבריה':         { lat: 32.7960, lng: 35.5305 },
  'צפת':           { lat: 32.9625, lng: 35.4969 },
  'עכו':           { lat: 32.9281, lng: 35.0770 },
  'דימונה':        { lat: 31.0700, lng: 35.0333 },
  'קריית ביאליק':   { lat: 32.8333, lng: 35.0833 },
  'קריית מוצקין':   { lat: 32.8392, lng: 35.0739 },
  'קריית ים':      { lat: 32.8442, lng: 35.0697 },
  'קריית אתא':     { lat: 32.8128, lng: 35.1056 },
  'קריית אונו':    { lat: 32.0651, lng: 34.8553 },
  'יבנה':          { lat: 31.8786, lng: 34.7406 },
  'נס ציונה':      { lat: 31.9293, lng: 34.7990 },
  'ראש העין':      { lat: 32.0844, lng: 34.9536 },
  'גבעת שמואל':    { lat: 32.0793, lng: 34.8480 },
  'יהוד':          { lat: 32.0333, lng: 34.8833 },
  'אור יהודה':     { lat: 32.0306, lng: 34.8506 },
  'רמת השרון':     { lat: 32.1466, lng: 34.8430 },
  'נשר':           { lat: 32.7702, lng: 35.0440 },
  'טירת כרמל':     { lat: 32.7610, lng: 34.9716 },
  'כרמיאל':        { lat: 32.9189, lng: 35.2920 },
  'קריית שמונה':   { lat: 33.2079, lng: 35.5697 },
  'מבשרת ציון':    { lat: 31.7986, lng: 35.1483 },
  'נתיבות':        { lat: 31.4221, lng: 34.5938 },
  'אופקים':        { lat: 31.3144, lng: 34.6175 },
};

function jitter(seed) {
  // Deterministic small offset based on numeric id so a row always renders
  // at the same spot. ±0.0035 deg ≈ ±390 m at Israel's latitude.
  const n = Number(seed) || 0;
  const a = ((n * 9301 + 49297) % 233280) / 233280;
  const b = ((n * 49297 + 9301) % 233280) / 233280;
  return { dlat: (a - 0.5) * 0.007, dlng: (b - 0.5) * 0.007 };
}

function attachCoords(row, idForJitter) {
  const c = CITY_CENTROIDS[row.city];
  if (!c) return null;
  const { dlat, dlng } = jitter(idForJitter);
  return { lat: c.lat + dlat, lng: c.lng + dlng };
}

/**
 * GET /api/map/data
 * Query params:
 *   minIAI: filter complexes with iai_score >= N (default 0)
 *   activeOnly: 'true' to filter listings to is_active = TRUE (default true)
 */
router.get('/data', async (req, res) => {
  const minIAI = parseFloat(req.query.minIAI) || 0;
  const activeOnly = req.query.activeOnly !== 'false';

  const safe = async (sql, params) => {
    try { const r = await pool.query(sql, params); return r.rows; }
    catch (e) { logger.warn('[mapRoutes] query failed', { error: e.message }); return []; }
  };

  const [complexRows, listingRows] = await Promise.all([
    safe(`
      SELECT id, name, city, neighborhood, addresses, iai_score,
             enhanced_ssi_score AS ssi_score, status, plan_stage, developer,
             existing_units AS units_count
      FROM complexes
      WHERE COALESCE(iai_score, 0) >= $1
      ORDER BY iai_score DESC NULLS LAST
      LIMIT 500
    `, [minIAI]),
    safe(`
      SELECT l.id, l.address, l.title, l.city, l.rooms, l.asking_price,
             l.area_sqm, l.price_per_sqm, l.source, l.url, l.thumbnail_url,
             l.ssi_score, l.first_seen, l.is_foreclosure, l.is_inheritance,
             c.id AS complex_id, c.name AS complex_name, c.iai_score
      FROM listings l
      LEFT JOIN complexes c ON c.id = l.complex_id
      WHERE ${activeOnly ? 'l.is_active = TRUE' : '1=1'}
      ORDER BY l.first_seen DESC NULLS LAST
      LIMIT 1000
    `, []),
  ]);

  const complexes = [];
  const complexesNoCoords = [];
  for (const r of complexRows) {
    const coords = attachCoords(r, r.id);
    if (coords) complexes.push({ ...r, ...coords });
    else complexesNoCoords.push({ id: r.id, name: r.name, city: r.city });
  }

  const listings = [];
  const listingsNoCoords = [];
  for (const r of listingRows) {
    const coords = attachCoords(r, r.id + 1000000);
    if (coords) listings.push({ ...r, ...coords });
    else listingsNoCoords.push({ id: r.id, city: r.city });
  }

  res.json({
    success: true,
    complexes,
    listings,
    summary: {
      complexes_total: complexRows.length,
      complexes_mapped: complexes.length,
      complexes_skipped_no_city: complexesNoCoords.length,
      listings_total: listingRows.length,
      listings_mapped: listings.length,
      listings_skipped_no_city: listingsNoCoords.length,
      cities_supported: Object.keys(CITY_CENTROIDS).length
    },
    skipped_cities_sample: [
      ...complexesNoCoords.slice(0, 5).map(c => `complex#${c.id} ${c.city || '(null)'}`),
      ...listingsNoCoords.slice(0, 5).map(l => `listing#${l.id} ${l.city || '(null)'}`)
    ]
  });
});

/**
 * GET /api/map/cities — exposed for the UI to populate a "zoom to city" dropdown.
 */
router.get('/cities', (req, res) => {
  res.json({
    success: true,
    cities: Object.entries(CITY_CENTROIDS).map(([name, { lat, lng }]) => ({ name, lat, lng })),
    total: Object.keys(CITY_CENTROIDS).length
  });
});

module.exports = router;
