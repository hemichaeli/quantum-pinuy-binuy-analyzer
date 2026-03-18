/**
 * HomeLess (homeless.co.il) Scraper - Issue #4 P1
 * Scrapes property listings from homeless.co.il
 * Stores in `listings` table (source='homeless')
 * autoFirstContactService picks them up automatically for WhatsApp outreach
 */

const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

const DELAY_MS = 4000;
const PERPLEXITY_API = 'https://api.perplexity.ai/chat/completions';
const { findMatchingComplex } = require('./complexMatcher');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/html',
  'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
  'Referer': 'https://www.homeless.co.il'
};

// Try HomeLess direct API
async function queryHomelessDirect(city, limit = 50) {
  try {
    // HomeLess known API pattern
    const response = await axios.get('https://www.homeless.co.il/api/listings', {
      params: {
        city,
        deal_type: 'for_sale',
        property_type: 'apartment',
        page: 1,
        per_page: limit
      },
      headers: HEADERS,
      timeout: 15000
    });

    if (response.data?.listings?.length > 0) {
      return response.data.listings.map(item => parseHomelessItem(item, city));
    }

    // Try alternate endpoint pattern
    const r2 = await axios.get(`https://www.homeless.co.il/forsale/${encodeURIComponent(city)}`, {
      headers: { ...HEADERS, Accept: 'application/json' },
      timeout: 15000
    });

    if (r2.data?.results?.length > 0) {
      return r2.data.results.map(item => parseHomelessItem(item, city));
    }

    return null;
  } catch (err) {
    logger.debug(`[HomeLess] Direct API failed for ${city}: ${err.message}`);
    return null;
  }
}

function parseHomelessItem(item, defaultCity) {
  const phone = item.phone || item.seller_phone || item.contact?.phone || null;
  const price = parseInt(String(item.price || item.asking_price || '').replace(/\D/g, '')) || null;
  return {
    source: 'homeless',
    listing_id: String(item.id || item.listing_id || ''),
    address: item.address || item.street_name || '',
    city: item.city || item.city_name || defaultCity || '',
    price,
    rooms: parseFloat(item.rooms || item.room_count || 0) || null,
    area_sqm: parseFloat(item.size || item.area || 0) || null,
    floor: parseInt(item.floor || 0) || null,
    phone: cleanPhone(phone),
    contact_name: item.contact_name || item.seller_name || null,
    url: item.url || (item.id ? `https://www.homeless.co.il/property/${item.id}` : null),
    description: (item.description || item.title || '').substring(0, 500)
  };
}

// Perplexity fallback for HomeLess
async function queryHomelessPerplexity(city) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return [];

  const prompt = `חפש מודעות מכירת דירות פעילות באתר homeless.co.il בעיר ${city}.

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
}

רק דירות למכירה. מחירים בשקלים. החזר JSON בלבד.`;

  try {
    const res = await axios.post(PERPLEXITY_API, {
      model: 'sonar',
      messages: [
        { role: 'system', content: 'Return ONLY valid JSON. No markdown, no explanations.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 2000,
      temperature: 0.1
    }, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 30000
    });

    const content = res.data.choices?.[0]?.message?.content || '';
    return parseJsonListings(content);
  } catch (err) {
    logger.warn(`[HomeLess] Perplexity fallback failed for ${city}: ${err.message}`);
    return [];
  }
}

function parseJsonListings(content) {
  try {
    const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed.listings) ? parsed.listings : [];
  } catch {
    const match = content.match(/\{[\s\S]*"listings"[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]).listings || []; } catch { }
    }
    return [];
  }
}

function cleanPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 9) return null;
  return digits;
}

async function saveListing(listing) {
  try {
    // Only save listings that match a pinuy-binuy complex
    const match = await findMatchingComplex(listing.address, listing.city);
    if (!match) {
      logger.debug(`[HomeLess] No complex match for: ${listing.address}, ${listing.city} — skipping`);
      return 'skipped';
    }
    const complexId = match.complexId;

    const sourceId = listing.listing_id || `homeless-${listing.city}-${listing.address}-${listing.price}`;
    const existing = await pool.query(
      `SELECT id FROM listings WHERE source = 'homeless' AND source_listing_id = $1 LIMIT 1`,
      [sourceId]
    );

    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE listings SET asking_price = COALESCE($1, asking_price),
          last_seen = CURRENT_DATE, updated_at = NOW(), url = COALESCE($2, url),
          complex_id = COALESCE(complex_id, $3)
         WHERE id = $4`,
        [listing.price, listing.url, complexId, existing.rows[0].id]
      );
      return 'updated';
    }

    await pool.query(
      `INSERT INTO listings (source, source_listing_id, address, city, asking_price,
        rooms, area_sqm, floor, phone, contact_name, url, description_snippet,
        complex_id, is_active, first_seen, last_seen, created_at, updated_at)
       VALUES ('homeless', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
        $12, TRUE, CURRENT_DATE, CURRENT_DATE, NOW(), NOW())
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
        listing.url, listing.description, complexId
      ]
    );
    logger.debug(`[HomeLess] Saved listing for complex ${match.complexName}: ${listing.address}`);
    return 'inserted';
  } catch (err) {
    logger.warn(`[HomeLess] Save error: ${err.message}`);
    return 'error';
  }
}

async function scanCity(city) {
  logger.info(`[HomeLess] Scanning ${city}...`);

  let rawListings = await queryHomelessDirect(city);
  let source = 'homeless_api';

  if (!rawListings || rawListings.length === 0) {
    rawListings = await queryHomelessPerplexity(city);
    source = 'perplexity';
  }

  if (!rawListings || rawListings.length === 0) {
    logger.debug(`[HomeLess] No listings found for ${city}`);
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

  logger.info(`[HomeLess] ${city}: ${inserted} new, ${updated} updated (via ${source})`);
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

  logger.info(`[HomeLess] Starting scan of ${citiesToScan.length} cities`);

  let totalInserted = 0, totalUpdated = 0;
  const results = [];

  for (let i = 0; i < citiesToScan.length; i++) {
    try {
      const result = await scanCity(citiesToScan[i]);
      totalInserted += result.inserted;
      totalUpdated += result.updated;
      results.push(result);
    } catch (err) {
      logger.error(`[HomeLess] Error for ${citiesToScan[i]}: ${err.message}`);
      results.push({ city: citiesToScan[i], error: err.message });
    }

    if (i < citiesToScan.length - 1) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  const summary = {
    total_cities: citiesToScan.length,
    total_inserted: totalInserted,
    total_updated: totalUpdated,
    results
  };
  logger.info('[HomeLess] Scan complete:', { totalInserted, totalUpdated });
  return summary;
}

module.exports = { scanAll, scanCity };
