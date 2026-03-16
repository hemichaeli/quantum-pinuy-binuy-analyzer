/**
 * complexMatcher.js
 * 
 * Matches listing addresses to pinuy-binuy complexes.
 * Used by city-based scrapers (homeless, dira, banknadlan, yad1, winwin)
 * to only save listings that belong to known pinuy-binuy complexes.
 * 
 * Matching logic:
 * 1. City must match (exact or partial)
 * 2. Street name from listing address must appear in complex addresses/name
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
        id: c.id,
        name: c.name,
        city: c.city,
        streetNames: Array.from(streetNames)
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
    .replace(/^עיר\s+/, '')
    .replace(/^עיריית\s+/, '')
    .trim()
    .toLowerCase();
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

  const listingStreet = extractStreetName(listingAddress || '');

  // Filter complexes by city first
  const cityMatches = complexes.filter(c => citiesMatch(c.city, listingCity));
  if (!cityMatches.length) return null;

  // If no street in listing, can't match further
  if (!listingStreet || listingStreet.length < 2) return null;

  // Find complexes where listing street matches one of the complex streets
  for (const complex of cityMatches) {
    for (const street of complex.streetNames) {
      if (!street || street.length < 2) continue;
      // Check if street names overlap (either contains the other)
      const s1 = listingStreet.toLowerCase();
      const s2 = street.toLowerCase();
      if (s1 === s2 || s1.includes(s2) || s2.includes(s1)) {
        logger.debug(`[ComplexMatcher] Matched: "${listingAddress}" (${listingCity}) -> ${complex.name} [street: ${street}]`);
        return {
          complexId: complex.id,
          complexName: complex.name,
          matchedStreet: street,
          confidence: s1 === s2 ? 'exact' : 'partial'
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
  extractStreetName
};
