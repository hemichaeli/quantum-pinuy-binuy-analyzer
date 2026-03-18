/**
 * BankNadlan (banknadlan.co.il) Scraper - Issue #4 P2
 * Scrapes bank receivership / foreclosure property listings
 * Stores in `listings` table (source='banknadlan', is_foreclosure=TRUE)
 * autoFirstContactService picks them up automatically for WhatsApp outreach
 */

const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

const DELAY_MS = 5000;
const { findMatchingComplex } = require('./complexMatcher');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/html',
  'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
  'Referer': 'https://www.banknadlan.co.il'
};

function cleanPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 12) return null;
  return digits.startsWith('972') ? '0' + digits.slice(3) : digits;
}

// Try BankNadlan direct API
async function queryBankNadlanDirect(city, limit = 50) {
  try {
    // BankNadlan known search endpoint
    const response = await axios.get('https://www.banknadlan.co.il/api/properties', {
      params: {
        city,
        type: 'sale',
        page: 1,
        limit
      },
      headers: HEADERS,
      timeout: 15000
    });
    if (response.data?.data?.length > 0) {
      return response.data.data.map(item => parseBankNadlanItem(item, city));
    }
    // Try alternate endpoint
    const r2 = await axios.get('https://www.banknadlan.co.il/search', {
      params: { city, deal: 'sale' },
      headers: { ...HEADERS, Accept: 'application/json' },
      timeout: 15000
    });
    if (r2.data?.results?.length > 0) {
      return r2.data.results.map(item => parseBankNadlanItem(item, city));
    }
    return null;
  } catch (err) {
    logger.debug(`[BankNadlan] Direct API failed for ${city}: ${err.message}`);
    return null;
  }
}

function parseBankNadlanItem(item, defaultCity) {
  const phone = item.phone || item.contactPhone || item.contact?.phone || item.agent_phone || null;
  const price = parseInt(String(item.price || item.askingPrice || item.auction_price || '').replace(/\D/g, '')) || null;
  return {
    source: 'banknadlan',
    listing_id: String(item.id || item.propertyId || ''),
    address: item.address || item.street || '',
    city: item.city || item.cityName || defaultCity || '',
    price,
    rooms: parseFloat(item.rooms || item.roomCount || 0) || null,
    area_sqm: parseFloat(item.size || item.squareMeters || item.area || 0) || null,
    floor: parseInt(item.floor || 0) || null,
    phone: cleanPhone(phone),
    contact_name: item.contactName || item.agentName || item.bank_name || null,
    url: item.url || (item.id ? `https://www.banknadlan.co.il/property/${item.id}` : null),
    description: (item.description || item.title || '').substring(0, 500),
    is_foreclosure: true
  };
}

// Perplexity fallback for BankNadlan
async function queryBankNadlanPerplexity(city) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return [];

  const prompt = `חפש נכסים למכירה בכינוס נכסים / הוצאה לפועל / בנק נדל"ן באתר banknadlan.co.il בעיר ${city}.
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
      source: 'banknadlan',
      listing_id: item.listing_id || String(Math.random()),
      address: item.address || '',
      city: item.city || city,
      price: parseInt(String(item.price || '').replace(/\D/g, '')) || null,
      rooms: parseFloat(item.rooms) || null,
      area_sqm: parseFloat(item.area_sqm) || null,
      floor: parseInt(item.floor) || null,
      phone: cleanPhone(item.phone),
      contact_name: item.contact_name || null,
      url: item.url || null,
      description: (item.description || '').substring(0, 500),
      is_foreclosure: true
    }));
  } catch (err) {
    logger.debug(`[BankNadlan] Perplexity failed for ${city}: ${err.message}`);
    return [];
  }
}

async function saveListing(listing) {
  try {
    // Only save listings that match a pinuy-binuy complex
    const match = await findMatchingComplex(listing.address, listing.city);
    if (!match) {
      logger.debug(`[BankNadlan] No complex match for: ${listing.address}, ${listing.city} — skipping`);
      return 'skipped';
    }
    const complexId = match.complexId;

    const sourceId = listing.listing_id || `${listing.address}-${listing.price}`;
    const existing = await pool.query(
      `SELECT id, asking_price FROM listings WHERE source = 'banknadlan' AND source_listing_id = $1`,
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
        rooms, area_sqm, floor, phone, contact_name, url, description_snippet,
        complex_id, is_active, is_foreclosure, first_seen, last_seen, created_at, updated_at)
       VALUES ('banknadlan', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
        $12, TRUE, TRUE, CURRENT_DATE, CURRENT_DATE, NOW(), NOW())
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
    logger.debug(`[BankNadlan] Saved listing for complex ${match.complexName}: ${listing.address}`);
    return 'inserted';
  } catch (err) {
    logger.warn(`[BankNadlan] Save error: ${err.message}`);
    return 'error';
  }
}

async function scanCity(city) {
  logger.info(`[BankNadlan] Scanning ${city}...`);
  let rawListings = await queryBankNadlanDirect(city);
  let source = 'banknadlan_api';
  if (!rawListings || rawListings.length === 0) {
    rawListings = await queryBankNadlanPerplexity(city);
    source = 'perplexity';
  }
  if (!rawListings || rawListings.length === 0) {
    logger.debug(`[BankNadlan] No listings found for ${city}`);
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
  logger.info(`[BankNadlan] ${city}: ${inserted} new, ${updated} updated (via ${source})`);
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
  logger.info(`[BankNadlan] Starting scan of ${citiesToScan.length} cities`);
  let totalInserted = 0, totalUpdated = 0;
  const results = [];
  for (let i = 0; i < citiesToScan.length; i++) {
    try {
      const result = await scanCity(citiesToScan[i]);
      totalInserted += result.inserted;
      totalUpdated += result.updated;
      results.push(result);
    } catch (err) {
      logger.error(`[BankNadlan] Error for ${citiesToScan[i]}: ${err.message}`);
      results.push({ city: citiesToScan[i], error: err.message });
    }
    if (i < citiesToScan.length - 1) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }
  logger.info('[BankNadlan] Scan complete:', { totalInserted, totalUpdated });
  return { total_cities: citiesToScan.length, total_inserted: totalInserted, total_updated: totalUpdated, results };
}

module.exports = { scanAll, scanCity };
