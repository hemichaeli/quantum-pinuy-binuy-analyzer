/**
 * Yad1 (yad1.co.il) Scraper - Issue #4 P2
 * Scrapes property listings from yad1.co.il
 * Stores in `listings` table (source='yad1')
 * autoFirstContactService picks them up automatically for WhatsApp outreach
 */

const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

const DELAY_MS = 4000;
const { findMatchingComplex } = require('./complexMatcher');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/html',
  'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
  'Referer': 'https://www.yad1.co.il'
};

function cleanPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 12) return null;
  return digits.startsWith('972') ? '0' + digits.slice(3) : digits;
}

// Try Yad1 direct API
async function queryYad1Direct(city, limit = 50) {
  try {
    const response = await axios.get('https://www.yad1.co.il/api/realestate/forsale', {
      params: {
        city,
        page: 1,
        rows: limit
      },
      headers: HEADERS,
      timeout: 15000
    });
    if (response.data?.data?.length > 0) {
      return response.data.data.map(item => parseYad1Item(item, city));
    }
    // Try alternate endpoint
    const r2 = await axios.get('https://www.yad1.co.il/nadlan', {
      params: { city, deal_type: 'forsale', page: 1 },
      headers: { ...HEADERS, Accept: 'application/json' },
      timeout: 15000
    });
    if (r2.data?.items?.length > 0) {
      return r2.data.items.map(item => parseYad1Item(item, city));
    }
    return null;
  } catch (err) {
    logger.debug(`[Yad1] Direct API failed for ${city}: ${err.message}`);
    return null;
  }
}

// Day 10: yad1.co.il returns 404 — the platform appears defunct. Until that
// changes, validate any URL claiming to be yad1 actually points at yad1.co.il.
// Otherwise the listing isn't real and shouldn't be saved (or should be
// flagged so it doesn't leak into the operator's send queue).
function isValidYad1Url(u) {
  if (!u || typeof u !== 'string') return false;
  return /^https?:\/\/(www\.)?yad1\.co\.il\//i.test(u);
}

function parseYad1Item(item, defaultCity) {
  const phone = item.phone || item.contactPhone || item.contact?.phone || null;
  const price = parseInt(String(item.price || item.askingPrice || '').replace(/\D/g, '')) || null;
  const thumbnail = item.images?.[0]?.src || item.images?.[0]?.url ||
    item.thumbnail || item.cover_image || item.image || item.img_url || null;
  // Only keep URL if it's actually a yad1 URL; otherwise null so the modal
  // routes correctly (manual fallback rather than offering broken platform_chat).
  const rawUrl = item.url || (item.id ? `https://www.yad1.co.il/item/${item.id}` : null);
  const url = isValidYad1Url(rawUrl) ? rawUrl : null;
  return {
    source: 'yad1',
    listing_id: String(item.id || item.adId || ''),
    address: item.address || item.street || '',
    city: item.city || item.cityName || defaultCity || '',
    price,
    rooms: parseFloat(item.rooms || item.roomCount || 0) || null,
    area_sqm: parseFloat(item.size || item.squareMeters || 0) || null,
    floor: parseInt(item.floor || 0) || null,
    phone: cleanPhone(phone),
    contact_name: item.contactName || item.sellerName || null,
    url,
    description: (item.description || item.title || '').substring(0, 500),
    thumbnail_url: thumbnail
  };
}

// Perplexity fallback for Yad1
async function queryYad1Perplexity(city) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return [];

  const prompt = `חפש מודעות מכירת דירות פעילות באתר yad1.co.il בעיר ${city}.
החזר JSON בלבד:
{
  "listings": [
    {
      "address": "כתובת מלאה",
      "city": "${city}",
      "price": מחיר_בשקלים,
      "rooms": מספר_חדרים,
      "area_sqm": שטח,
      "floor": קומה,
      "phone": "מספר_טלפון_או_null",
      "contact_name": "שם_איש_קשר_או_null",
      "url": "קישור_למודעה",
      "listing_id": "מזהה_מודעה",
      "description": "תיאור קצר"
    }
  ]
}`;

  try {
    const response = await axios.post(
      'https://api.perplexity.ai/chat/completions',
      {
        model: 'sonar',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );
    const text = response.data?.choices?.[0]?.message?.content || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]);
    return (parsed.listings || []).map(item => ({
      source: 'yad1',
      listing_id: item.listing_id || String(Math.random()),
      address: item.address || '',
      city: item.city || city,
      price: parseInt(String(item.price || '').replace(/\D/g, '')) || null,
      rooms: parseFloat(item.rooms) || null,
      area_sqm: parseFloat(item.area_sqm) || null,
      floor: parseInt(item.floor) || null,
      phone: cleanPhone(item.phone),
      contact_name: item.contact_name || null,
      // Perplexity often returns yad2 search-page URLs when answering yad1
      // queries (yad1.co.il is 404). Drop non-yad1 URLs so the modal won't
      // offer a broken 'platform_chat' route.
      url: isValidYad1Url(item.url) ? item.url : null,
      description: (item.description || '').substring(0, 500)
    }));
  } catch (err) {
    logger.debug(`[Yad1] Perplexity failed for ${city}: ${err.message}`);
    return [];
  }
}

async function saveListing(listing) {
  try {
    // Only save listings that match a pinuy-binuy complex
    const match = await findMatchingComplex(listing.address, listing.city);
    if (!match) {
      logger.debug(`[Yad1] No complex match for: ${listing.address}, ${listing.city} — skipping`);
      return 'skipped';
    }
    const complexId = match.complexId;

    const sourceId = listing.listing_id || `${listing.address}-${listing.price}`;
    const existing = await pool.query(
      `SELECT id, asking_price FROM listings WHERE source = 'yad1' AND source_listing_id = $1`,
      [sourceId]
    );
    if (existing.rows.length > 0) {
      if (listing.price && listing.price !== existing.rows[0].asking_price) {
        await pool.query(
          `UPDATE listings SET asking_price = $1, url = COALESCE($2, url),
           last_seen = CURRENT_DATE, updated_at = NOW(),
           complex_id = COALESCE(complex_id, $3) WHERE id = $4`,
          [listing.price, listing.url, complexId, existing.rows[0].id]
        );
        return 'updated';
      }
      return 'skipped';
    }
    await pool.query(
      `INSERT INTO listings (source, source_listing_id, address, city, asking_price,
        rooms, area_sqm, floor, phone, contact_name, url, description_snippet, thumbnail_url,
        complex_id, is_active, first_seen, last_seen, created_at, updated_at)
       VALUES ('yad1', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
        $13, TRUE, CURRENT_DATE, CURRENT_DATE, NOW(), NOW())
       ON CONFLICT (source, LOWER(TRIM(address)), LOWER(TRIM(city)))
       DO UPDATE SET last_seen=CURRENT_DATE, asking_price=COALESCE(EXCLUDED.asking_price, listings.asking_price),
         phone=COALESCE(EXCLUDED.phone, listings.phone),
         url=COALESCE(EXCLUDED.url, listings.url),
         complex_id=COALESCE(EXCLUDED.complex_id, listings.complex_id),
         updated_at=NOW()`,
      [
        sourceId, listing.address, listing.city, listing.price,
        listing.rooms, listing.area_sqm, listing.floor,
        listing.phone, listing.contact_name,
        listing.url, listing.description, listing.thumbnail_url || null, complexId
      ]
    );
    logger.debug(`[Yad1] Saved listing for complex ${match.complexName}: ${listing.address}`);
    return 'inserted';
  } catch (err) {
    logger.warn(`[Yad1] Save error: ${err.message}`);
    return 'error';
  }
}

async function scanCity(city) {
  logger.info(`[Yad1] Scanning ${city}...`);
  let rawListings = await queryYad1Direct(city);
  let source = 'yad1_api';
  if (!rawListings || rawListings.length === 0) {
    rawListings = await queryYad1Perplexity(city);
    source = 'perplexity';
  }
  if (!rawListings || rawListings.length === 0) {
    logger.debug(`[Yad1] No listings found for ${city}`);
    return { city, listings: 0, inserted: 0, updated: 0, source };
  }
  let inserted = 0, updated = 0;
  for (const listing of rawListings) {
    if (!listing.address && !listing.price) continue;
    if (!listing.city) listing.city = city;
    const result = await saveListing(listing);
    if (result === 'inserted') inserted++;
    else if (result === 'updated') updated++;
  }
  logger.info(`[Yad1] ${city}: ${inserted} new, ${updated} updated (via ${source})`);
  return { city, listings: rawListings.length, inserted, updated, source };
}

const TARGET_CITIES = [
  'תל אביב', 'ירושלים', 'חיפה', 'ראשון לציון', 'פתח תקווה',
  'נתניה', 'בת ים', 'חולון', 'רמת גן', 'בני ברק',
  'רחובות', 'אשדוד', 'הרצליה', 'כפר סבא', 'רעננה'
];

async function scanAll(options = {}) {
  const { cities = TARGET_CITIES, limit = 15 } = options;
  const citiesToScan = cities.slice(0, limit);
  logger.info(`[Yad1] Starting scan of ${citiesToScan.length} cities`);
  let totalInserted = 0, totalUpdated = 0;
  const results = [];
  for (let i = 0; i < citiesToScan.length; i++) {
    try {
      const result = await scanCity(citiesToScan[i]);
      totalInserted += result.inserted;
      totalUpdated += result.updated;
      results.push(result);
    } catch (err) {
      logger.error(`[Yad1] Error for ${citiesToScan[i]}: ${err.message}`);
      results.push({ city: citiesToScan[i], error: err.message });
    }
    if (i < citiesToScan.length - 1) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }
  logger.info('[Yad1] Scan complete:', { totalInserted, totalUpdated });
  return { total_cities: citiesToScan.length, total_inserted: totalInserted, total_updated: totalUpdated, results };
}

module.exports = { scanAll, scanCity };
