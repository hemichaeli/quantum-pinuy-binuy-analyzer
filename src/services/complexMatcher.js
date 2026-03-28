/**
 * complexMatcher.js
 *
 * Matches listing addresses to pinuy-binuy complexes.
 *
 * Matching pipeline (in order):
 *  1. City filter  — normalised city comparison (handles hyphens: "רמת-גן" = "רמת גן")
 *  2. Street match — extracts street name from listing, handles REVERSED addresses
 *                   like "עיר, שכונה, רחוב מספר" (Dira / Komo format).
 *  3. Neighborhood fallback — when no street found, checks if listing address
 *                             contains the complex's neighborhood name.
 */

const pool = require('../db/pool');
const { logger } = require('./logger');

// In-memory cache of complexes with their addresses
let complexCache = null;
let cacheLoadedAt = null;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Load all complexes with their address data into memory cache
 */
async function loadComplexCache() {
  const now = Date.now();
  if (complexCache && cacheLoadedAt && (now - cacheLoadedAt) < CACHE_TTL_MS) {
    return complexCache;
  }

  try {
    const result = await pool.query(`
      SELECT id, name, city, addresses, address, neighborhood, neighborhood_streets
      FROM complexes
      WHERE addresses IS NOT NULL OR address IS NOT NULL OR name IS NOT NULL
      ORDER BY iai_score DESC NULLS LAST
    `);

    complexCache = result.rows.map(c => {
      // Collect all address strings for this complex
      const addressSources = [
        c.addresses || '',
        c.address || '',
        c.name || '',
        c.neighborhood || ''
      ];

      // Parse neighborhood_streets JSON array if present
      if (c.neighborhood_streets) {
        try {
          const streets = typeof c.neighborhood_streets === 'string'
            ? JSON.parse(c.neighborhood_streets)
            : c.neighborhood_streets;
          if (Array.isArray(streets)) {
            addressSources.push(...streets);
          }
        } catch (e) { /* ignore */ }
      }

      // Extract street names from all sources
      const streetNames = new Set();
      for (const src of addressSources) {
        if (!src) continue;
        // Split by common separators: semicolon, comma, newline
        const parts = String(src).split(/[;,\n]+/);
        for (const part of parts) {
          const street = extractStreetName(part.trim());
          if (street && street.length >= 2) {
            streetNames.add(street);
          }
        }
      }

      return {
        id:           c.id,
        name:         c.name,
        city:         c.city,
        neighborhood: c.neighborhood || null,  // kept raw for neighborhood fallback
        streetNames:  Array.from(streetNames)
      };
    });

    cacheLoadedAt = now;
    logger.info(`[ComplexMatcher] Loaded ${complexCache.length} complexes into cache`);
    return complexCache;
  } catch (err) {
    logger.error(`[ComplexMatcher] Failed to load cache: ${err.message}`);
    return [];
  }
}

/**
 * Extract the street name from an address string
 * e.g. "הרצל 15, תל אביב" -> "הרצל"
 * e.g. "רחוב הרצל 15" -> "הרצל"
 * e.g. "כלנית 1,3,5" -> "כלנית"
 */
function extractStreetName(address) {
  if (!address) return null;
  // Remove "רחוב", "שדרות", "דרך" prefixes
  let cleaned = address
    .replace(/^(רחוב|שדרות|דרך|סמטת|כיכר|גבעת|רח'|שד')\s+/i, '')
    .trim();
  // Take only the street name part (before numbers/comma)
  const match = cleaned.match(/^([^\d,;]+)/);
  if (match) {
    return match[1].trim().replace(/\s+/g, ' ');
  }
  return cleaned.split(/[\d,;]/)[0].trim();
}

/**
 * Normalize city name for comparison
 */
function normalizeCity(city) {
  if (!city) return '';
  return city
    .replace(/^עיריית\s+/, '')
    .replace(/^עיר\s+/, '')
    .replace(/[-–]/g, ' ')   // "רמת-גן" → "רמת גן"
    .trim()
    .toLowerCase();
}

/**
 * Extract street name with awareness of reversed-address format.
 * Dira / Komo often return "עיר, שכונה, רחוב מספר".
 * When the first part matches the city, the street is the LAST part.
 */
function extractStreetSmarter(address, listingCity) {
  if (!address) return null;
  const parts = address.split(/[,،،]/);
  if (parts.length >= 2 && listingCity) {
    const firstPart = parts[0].trim();
    if (citiesMatch(firstPart, listingCity)) {
      // Reversed format detected — street is the last segment
      return extractStreetName(parts[parts.length - 1].trim());
    }
  }
  return extractStreetName(address);
}

/**
 * Check if two city names match (exact or partial)
 */
function citiesMatch(city1, city2) {
  if (!city1 || !city2) return false;
  const c1 = normalizeCity(city1);
  const c2 = normalizeCity(city2);
  return c1 === c2 || c1.includes(c2) || c2.includes(c1);
}

/**
 * Find the best matching complex for a given listing address + city.
 * Returns { complexId, complexName, confidence } or null if no match found.
 * 
 * @param {string} listingAddress - e.g. "הרצל 15"
 * @param {string} listingCity - e.g. "תל אביב"
 * @returns {Object|null}
 */
async function findMatchingComplex(listingAddress, listingCity) {
  if (!listingAddress && !listingCity) return null;

  const complexes = await loadComplexCache();
  if (!complexes.length) return null;

  // Step 1 — city filter
  const cityMatches = complexes.filter(c => citiesMatch(c.city, listingCity));
  if (!cityMatches.length) return null;

  // Step 2 — street match (reversed-address aware)
  const listingStreet = extractStreetSmarter(listingAddress || '', listingCity);

  if (listingStreet && listingStreet.length >= 2) {
    for (const complex of cityMatches) {
      for (const street of complex.streetNames) {
        if (!street || street.length < 2) continue;
        const s1 = listingStreet.toLowerCase();
        const s2 = street.toLowerCase();
        if (s1 === s2 || s1.includes(s2) || s2.includes(s1)) {
          logger.debug(
            `[ComplexMatcher] Street match: "${listingAddress}" (${listingCity}) → ${complex.name} [${street}]`
          );
          return {
            complexId:     complex.id,
            complexName:   complex.name,
            matchedStreet: street,
            confidence:    s1 === s2 ? 'exact' : 'partial'
          };
        }
      }
    }
  }

  // Step 3 — neighborhood fallback (e.g. Homeless returns "רמת הנשיא" with no street)
  if (listingAddress) {
    const normAddr = listingAddress
      .replace(/[•\-–]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    for (const complex of cityMatches) {
      if (!complex.neighborhood) continue;
      const normNeighborhood = complex.neighborhood.trim().toLowerCase();
      if (normNeighborhood.length >= 3 && normAddr.includes(normNeighborhood)) {
        logger.debug(
          `[ComplexMatcher] Neighborhood match: "${listingAddress}" (${listingCity}) → ${complex.name} [${complex.neighborhood}]`
        );
        return {
          complexId:     complex.id,
          complexName:   complex.name,
          matchedStreet: complex.neighborhood,
          confidence:    'neighborhood'
        };
      }
    }
  }

  return null;
}

/**
 * Invalidate the cache (call after complexes are updated)
 */
function invalidateCache() {
  complexCache = null;
  cacheLoadedAt = null;
}

module.exports = {
  findMatchingComplex,
  loadComplexCache,
  invalidateCache,
  extractStreetName,
  extractStreetSmarter
};
