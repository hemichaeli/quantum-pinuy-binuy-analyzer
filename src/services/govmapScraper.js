/**
 * Govmap (govmap.gov.il) Scraper - Issue #4 P3
 * Fetches pinuy-binuy (urban renewal) zones and planning data from govmap.gov.il
 * Stores zone data in `complexes` table with govmap_zone_id
 * Uses the official Govmap REST API (no auth required for public layers)
 */

const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

const DELAY_MS = 2000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
  'Referer': 'https://www.govmap.gov.il'
};

// Govmap API base URL
const GOVMAP_API = 'https://www.govmap.gov.il/govmap/api';

// Pinuy-Binuy layer ID on Govmap (urban renewal zones)
// Layer 1: תוכניות פינוי-בינוי מאושרות
// Layer 2: תוכניות פינוי-בינוי בהכנה
const PINUY_BINUY_LAYERS = [
  { id: 'PINUY_BINUY', name: 'פינוי-בינוי מאושר', status: 'approved' },
  { id: 'PINUY_BINUY_PREP', name: 'פינוי-בינוי בהכנה', status: 'in_preparation' }
];

// Major Israeli cities with their approximate bounding boxes
const CITY_BBOXES = [
  { city: 'תל אביב', minX: 34.75, minY: 32.02, maxX: 34.84, maxY: 32.12 },
  { city: 'ירושלים', minX: 35.17, minY: 31.73, maxX: 35.27, maxY: 31.83 },
  { city: 'חיפה', minX: 34.95, minY: 32.77, maxX: 35.05, maxY: 32.87 },
  { city: 'ראשון לציון', minX: 34.77, minY: 31.97, maxX: 34.84, maxY: 32.04 },
  { city: 'פתח תקווה', minX: 34.86, minY: 32.07, maxX: 34.93, maxY: 32.12 },
  { city: 'נתניה', minX: 34.83, minY: 32.29, maxX: 34.90, maxY: 32.34 },
  { city: 'בת ים', minX: 34.74, minY: 32.00, maxX: 34.78, maxY: 32.04 },
  { city: 'חולון', minX: 34.76, minY: 32.00, maxX: 34.81, maxY: 32.05 },
  { city: 'רמת גן', minX: 34.81, minY: 32.07, maxX: 34.85, maxY: 32.10 },
  { city: 'בני ברק', minX: 34.82, minY: 32.07, maxX: 34.86, maxY: 32.10 }
];

// Query Govmap API for pinuy-binuy zones in a bounding box
async function queryGovmapLayer(layerId, bbox) {
  try {
    const response = await axios.get(`${GOVMAP_API}/features`, {
      params: {
        layerName: layerId,
        bbox: `${bbox.minX},${bbox.minY},${bbox.maxX},${bbox.maxY}`,
        srsName: 'EPSG:4326',
        outputFormat: 'application/json',
        maxFeatures: 100
      },
      headers: HEADERS,
      timeout: 20000
    });
    if (response.data?.features?.length > 0) {
      return response.data.features;
    }
    // Try alternate WFS endpoint
    const r2 = await axios.get(`${GOVMAP_API}/wfs`, {
      params: {
        SERVICE: 'WFS',
        VERSION: '2.0.0',
        REQUEST: 'GetFeature',
        TYPENAMES: layerId,
        BBOX: `${bbox.minY},${bbox.minX},${bbox.maxY},${bbox.maxX}`,
        SRSNAME: 'EPSG:4326',
        OUTPUTFORMAT: 'application/json',
        COUNT: 100
      },
      headers: HEADERS,
      timeout: 20000
    });
    return r2.data?.features || [];
  } catch (err) {
    logger.debug(`[Govmap] Layer ${layerId} query failed: ${err.message}`);
    return [];
  }
}

// Parse a Govmap feature into a complex record
function parseGovmapFeature(feature, cityName, layerStatus) {
  const props = feature.properties || {};
  return {
    govmap_zone_id: props.OBJECTID || props.id || String(Math.random()),
    name: props.PLAN_NAME || props.name || props.SCHEME_NAME || `אזור פינוי-בינוי - ${cityName}`,
    city: props.CITY_NAME || props.city || cityName,
    address: props.ADDRESS || props.address || props.STREET || '',
    status: layerStatus,
    plan_number: props.PLAN_NUM || props.plan_number || null,
    total_units: parseInt(props.TOTAL_UNITS || props.units || 0) || null,
    geometry: feature.geometry ? JSON.stringify(feature.geometry) : null,
    source: 'govmap'
  };
}

// Save or update a complex from Govmap data
async function saveComplex(zone) {
  try {
    // Check if complex with this govmap zone ID already exists
    const existing = await pool.query(
      `SELECT id FROM complexes WHERE govmap_zone_id = $1`,
      [zone.govmap_zone_id]
    );
    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE complexes SET name = COALESCE($1, name), city = COALESCE($2, city),
         address = COALESCE($3, address), updated_at = NOW()
         WHERE govmap_zone_id = $4`,
        [zone.name, zone.city, zone.address, zone.govmap_zone_id]
      );
      return 'updated';
    }
    // Insert new complex
    await pool.query(
      `INSERT INTO complexes (name, city, address, status, govmap_zone_id,
         source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'govmap', NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      [zone.name, zone.city, zone.address, zone.status, zone.govmap_zone_id]
    );
    return 'inserted';
  } catch (err) {
    logger.warn(`[Govmap] Save complex error: ${err.message}`);
    return 'error';
  }
}

async function scanCity(cityConfig) {
  const { city, minX, minY, maxX, maxY } = cityConfig;
  logger.info(`[Govmap] Scanning ${city}...`);
  let totalInserted = 0, totalUpdated = 0;

  for (const layer of PINUY_BINUY_LAYERS) {
    try {
      const features = await queryGovmapLayer(layer.id, { minX, minY, maxX, maxY });
      for (const feature of features) {
        const zone = parseGovmapFeature(feature, city, layer.status);
        const result = await saveComplex(zone);
        if (result === 'inserted') totalInserted++;
        else if (result === 'updated') totalUpdated++;
      }
      logger.debug(`[Govmap] ${city} - ${layer.name}: ${features.length} zones found`);
      await new Promise(r => setTimeout(r, DELAY_MS));
    } catch (err) {
      logger.warn(`[Govmap] Error scanning ${city} layer ${layer.id}: ${err.message}`);
    }
  }

  logger.info(`[Govmap] ${city}: ${totalInserted} new, ${totalUpdated} updated`);
  return { city, inserted: totalInserted, updated: totalUpdated };
}

async function scanAll(options = {}) {
  const { cities = CITY_BBOXES } = options;
  logger.info(`[Govmap] Starting scan of ${cities.length} cities`);
  let totalInserted = 0, totalUpdated = 0;
  const results = [];

  for (const cityConfig of cities) {
    try {
      const result = await scanCity(cityConfig);
      totalInserted += result.inserted;
      totalUpdated += result.updated;
      results.push(result);
    } catch (err) {
      logger.error(`[Govmap] Error for ${cityConfig.city}: ${err.message}`);
      results.push({ city: cityConfig.city, error: err.message });
    }
    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  logger.info('[Govmap] Scan complete:', { totalInserted, totalUpdated });
  return { total_cities: cities.length, total_inserted: totalInserted, total_updated: totalUpdated, results };
}

module.exports = { scanAll, scanCity };
