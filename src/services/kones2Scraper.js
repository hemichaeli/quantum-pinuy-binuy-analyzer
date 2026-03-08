/**
 * Kones2 (kones2.co.il) Scraper - Issue #5 P1
 * Scrapes receivership property listings from kones2.co.il
 * Stores in `kones2_listings` table
 * autoFirstContactService picks them up automatically for WhatsApp outreach
 */

const axios = require('axios');
const cheerio = require('cheerio');
const pool = require('../db/pool');
const { logger } = require('./logger');

const DELAY_MS = 5000;
const BASE_URL = 'https://www.kones2.co.il';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
  'Referer': BASE_URL
};

function cleanPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 12) return null;
  return digits.startsWith('972') ? '0' + digits.slice(3) : digits;
}

function extractPrice(text) {
  if (!text) return null;
  const match = String(text).replace(/,/g, '').match(/(\d{4,})/);
  return match ? parseInt(match[1]) : null;
}

// Try Kones2 API endpoint
async function queryKones2Direct(page = 1) {
  try {
    const response = await axios.get(`${BASE_URL}/api/properties`, {
      params: { page, limit: 50, type: 'sale' },
      headers: HEADERS,
      timeout: 15000
    });
    if (response.data?.items?.length > 0) {
      return response.data.items.map(parseKones2ApiItem);
    }
    return null;
  } catch (err) {
    logger.debug(`[Kones2] Direct API failed: ${err.message}`);
    return null;
  }
}

function parseKones2ApiItem(item) {
  return {
    listing_id: String(item.id || item.propertyId || ''),
    title: item.title || item.name || '',
    address: item.address || item.street || '',
    city: item.city || item.cityName || '',
    price: parseInt(String(item.price || '').replace(/\D/g, '')) || null,
    rooms: parseFloat(item.rooms || 0) || null,
    area_sqm: parseFloat(item.size || item.area || 0) || null,
    floor: parseInt(item.floor || 0) || null,
    phone: cleanPhone(item.phone || item.contactPhone),
    contact_name: item.contactName || item.agentName || null,
    url: item.url || (item.id ? `${BASE_URL}/property/${item.id}` : null),
    description: (item.description || '').substring(0, 500),
    auction_date: item.auctionDate || item.auction_date || null,
    court: item.court || item.courtName || null,
    case_number: item.caseNumber || item.case_number || null
  };
}

// HTML scraping fallback
async function scrapeKones2Html(page = 1) {
  try {
    const response = await axios.get(`${BASE_URL}/properties`, {
      params: { page },
      headers: HEADERS,
      timeout: 20000
    });
    const $ = cheerio.load(response.data);
    const listings = [];

    // Common patterns for kones2 property cards
    $('[class*="property"], [class*="listing"], [class*="item"], article').each((i, el) => {
      const $el = $(el);
      const title = $el.find('[class*="title"], h2, h3').first().text().trim();
      const priceText = $el.find('[class*="price"]').first().text().trim();
      const addressText = $el.find('[class*="address"], [class*="location"]').first().text().trim();
      const phoneText = $el.find('[class*="phone"], a[href^="tel:"]').first().text().trim() ||
                        $el.find('a[href^="tel:"]').attr('href')?.replace('tel:', '');
      const link = $el.find('a').first().attr('href');
      const id = $el.attr('data-id') || $el.attr('id') || '';

      if (!title && !priceText) return;

      listings.push({
        listing_id: id || `kones2-${i}-${Date.now()}`,
        title,
        address: addressText,
        city: extractCity(addressText),
        price: extractPrice(priceText),
        rooms: null,
        area_sqm: null,
        floor: null,
        phone: cleanPhone(phoneText),
        contact_name: null,
        url: link ? (link.startsWith('http') ? link : `${BASE_URL}${link}`) : null,
        description: title.substring(0, 500),
        auction_date: null,
        court: null,
        case_number: null
      });
    });

    return listings.length > 0 ? listings : null;
  } catch (err) {
    logger.debug(`[Kones2] HTML scrape failed page ${page}: ${err.message}`);
    return null;
  }
}

function extractCity(text) {
  if (!text) return '';
  const cities = ['תל אביב', 'ירושלים', 'חיפה', 'ראשון לציון', 'פתח תקווה', 'נתניה',
    'בת ים', 'חולון', 'רמת גן', 'בני ברק', 'רחובות', 'אשדוד', 'הרצליה', 'כפר סבא', 'רעננה',
    'אשקלון', 'באר שבע', 'רמת השרון', 'גבעתיים', 'קריית גת'];
  for (const city of cities) {
    if (text.includes(city)) return city;
  }
  return '';
}

// Perplexity fallback
async function queryKones2Perplexity() {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return [];

  const prompt = `חפש נכסים בכינוס נכסים / הוצאה לפועל באתר kones2.co.il.
החזר JSON בלבד:
{
  "listings": [
    {
      "title": "כותרת הנכס",
      "address": "כתובת מלאה",
      "city": "עיר",
      "price": מחיר_בשקלים,
      "rooms": מספר_חדרים,
      "area_sqm": שטח,
      "floor": קומה,
      "phone": "מספר_טלפון_או_null",
      "contact_name": "שם_איש_קשר_או_null",
      "url": "קישור_למודעה",
      "listing_id": "מזהה_מודעה",
      "auction_date": "תאריך_מכירה_פומבית_או_null",
      "court": "בית_משפט_או_null",
      "case_number": "מספר_תיק_או_null"
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
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );
    const text = response.data?.choices?.[0]?.message?.content || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]);
    return (parsed.listings || []).map(item => ({
      listing_id: item.listing_id || String(Math.random()),
      title: item.title || '',
      address: item.address || '',
      city: item.city || '',
      price: parseInt(String(item.price || '').replace(/\D/g, '')) || null,
      rooms: parseFloat(item.rooms) || null,
      area_sqm: parseFloat(item.area_sqm) || null,
      floor: parseInt(item.floor) || null,
      phone: cleanPhone(item.phone),
      contact_name: item.contact_name || null,
      url: item.url || null,
      description: (item.title || '').substring(0, 500),
      auction_date: item.auction_date || null,
      court: item.court || null,
      case_number: item.case_number || null
    }));
  } catch (err) {
    logger.debug(`[Kones2] Perplexity failed: ${err.message}`);
    return [];
  }
}

async function saveListing(listing) {
  try {
    const sourceId = listing.listing_id || `${listing.address}-${listing.price}`;
    const existing = await pool.query(
      `SELECT id FROM kones2_listings WHERE external_id = $1`,
      [sourceId]
    );
    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE kones2_listings SET price = COALESCE($1, price), updated_at = NOW()
         WHERE external_id = $2`,
        [listing.price, sourceId]
      );
      return 'updated';
    }
    await pool.query(
      `INSERT INTO kones2_listings (external_id, address, city, price, phone,
        contact_name, is_active, contact_status, raw_data, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, NULL, $7, NOW(), NOW())
       ON CONFLICT (external_id) DO NOTHING`,
      [
        sourceId, listing.address, listing.city, listing.price,
        listing.phone, listing.contact_name,
        JSON.stringify({ title: listing.title, url: listing.url, description: listing.description,
          rooms: listing.rooms, area_sqm: listing.area_sqm, floor: listing.floor,
          auction_date: listing.auction_date, court: listing.court, case_number: listing.case_number })
      ]
    );
    return 'inserted';
  } catch (err) {
    logger.warn(`[Kones2] Save error: ${err.message}`);
    return 'error';
  }
}

async function scanAll(options = {}) {
  const { pages = 3 } = options;
  logger.info(`[Kones2] Starting scan (${pages} pages)`);
  let totalInserted = 0, totalUpdated = 0;
  const results = [];

  for (let page = 1; page <= pages; page++) {
    let rawListings = await queryKones2Direct(page);
    let source = 'kones2_api';
    if (!rawListings || rawListings.length === 0) {
      rawListings = await scrapeKones2Html(page);
      source = 'html';
    }
    if (!rawListings || rawListings.length === 0) {
      if (page === 1) {
        rawListings = await queryKones2Perplexity();
        source = 'perplexity';
      } else {
        break; // No more pages
      }
    }
    let inserted = 0, updated = 0;
    for (const listing of rawListings) {
      const result = await saveListing(listing);
      if (result === 'inserted') inserted++;
      else if (result === 'updated') updated++;
    }
    totalInserted += inserted;
    totalUpdated += updated;
    results.push({ page, listings: rawListings.length, inserted, updated, source });
    logger.info(`[Kones2] Page ${page}: ${inserted} new, ${updated} updated (via ${source})`);
    if (page < pages) await new Promise(r => setTimeout(r, DELAY_MS));
  }

  logger.info('[Kones2] Scan complete:', { totalInserted, totalUpdated });
  return { total_inserted: totalInserted, total_updated: totalUpdated, results };
}

module.exports = { scanAll };
