/**
 * BidSpirit (bidspirit.com/houses) Scraper - Issue #5 P2
 * Scrapes real estate auction listings from bidspirit.com
 * Stores in `kones_listings` table (source_site='bidspirit') — reuses existing kones table
 * autoFirstContactService picks them up automatically for WhatsApp outreach
 */

const axios = require('axios');
const cheerio = require('cheerio');
const pool = require('../db/pool');
const { logger } = require('./logger');

const DELAY_MS = 5000;
const BASE_URL = 'https://www.bidspirit.com';
const HOUSES_URL = `${BASE_URL}/ui/houses`;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/json,*/*;q=0.8',
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

// Try BidSpirit API
async function queryBidspiritDirect(page = 1) {
  try {
    const response = await axios.get(`${BASE_URL}/api/lots`, {
      params: {
        category: 'real_estate',
        page,
        limit: 50,
        status: 'active'
      },
      headers: { ...HEADERS, Accept: 'application/json' },
      timeout: 15000
    });
    if (response.data?.lots?.length > 0) {
      return response.data.lots.map(parseBidspiritApiItem);
    }
    return null;
  } catch (err) {
    logger.debug(`[BidSpirit] Direct API failed: ${err.message}`);
    return null;
  }
}

function parseBidspiritApiItem(item) {
  return {
    listing_id: String(item.id || item.lotId || ''),
    title: item.title || item.name || '',
    address: item.address || item.location || '',
    city: item.city || extractCity(item.address || item.location || ''),
    price: parseInt(String(item.currentBid || item.startingBid || item.estimatedValue || '').replace(/\D/g, '')) || null,
    rooms: parseFloat(item.rooms || 0) || null,
    area_sqm: parseFloat(item.area || item.squareMeters || 0) || null,
    floor: parseInt(item.floor || 0) || null,
    phone: cleanPhone(item.phone || item.contactPhone),
    contact_name: item.contactName || item.auctioneer || null,
    url: item.url || (item.id ? `${BASE_URL}/lot/${item.id}` : null),
    description: (item.description || item.title || '').substring(0, 500),
    auction_date: item.endDate || item.auctionDate || null
  };
}

// HTML scraping fallback
async function scrapeBidspiritHtml(page = 1) {
  try {
    const response = await axios.get(HOUSES_URL, {
      params: { page },
      headers: HEADERS,
      timeout: 20000
    });
    const $ = cheerio.load(response.data);
    const listings = [];

    // BidSpirit uses React but may have server-side rendered content
    // Try to find lot cards
    $('[class*="lot"], [class*="item"], [class*="auction"], [class*="property"]').each((i, el) => {
      const $el = $(el);
      const title = $el.find('[class*="title"], h2, h3, h4').first().text().trim();
      const priceText = $el.find('[class*="price"], [class*="bid"]').first().text().trim();
      const locationText = $el.find('[class*="location"], [class*="address"]').first().text().trim();
      const link = $el.find('a').first().attr('href');
      const id = $el.attr('data-id') || $el.attr('data-lot-id') || '';

      if (!title && !priceText) return;

      listings.push({
        listing_id: id || `bidspirit-${i}-${Date.now()}`,
        title,
        address: locationText,
        city: extractCity(locationText),
        price: extractPrice(priceText),
        rooms: null,
        area_sqm: null,
        floor: null,
        phone: null,
        contact_name: null,
        url: link ? (link.startsWith('http') ? link : `${BASE_URL}${link}`) : null,
        description: title.substring(0, 500),
        auction_date: null
      });
    });

    // Also try to extract from JSON-LD or __NEXT_DATA__
    const nextDataMatch = response.data.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextDataMatch && listings.length === 0) {
      try {
        const nextData = JSON.parse(nextDataMatch[1]);
        const lots = nextData?.props?.pageProps?.lots || nextData?.props?.pageProps?.items || [];
        lots.forEach((item, i) => {
          listings.push({
            listing_id: String(item.id || `bidspirit-next-${i}`),
            title: item.title || item.name || '',
            address: item.address || item.location || '',
            city: extractCity(item.address || item.location || ''),
            price: extractPrice(String(item.currentBid || item.startingBid || '')),
            rooms: null,
            area_sqm: null,
            floor: null,
            phone: null,
            contact_name: null,
            url: item.url || (item.id ? `${BASE_URL}/lot/${item.id}` : null),
            description: (item.description || item.title || '').substring(0, 500),
            auction_date: item.endDate || null
          });
        });
      } catch (e) {
        logger.debug('[BidSpirit] NEXT_DATA parse failed:', e.message);
      }
    }

    return listings.length > 0 ? listings : null;
  } catch (err) {
    logger.debug(`[BidSpirit] HTML scrape failed page ${page}: ${err.message}`);
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
async function queryBidspiritPerplexity() {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return [];

  const prompt = `חפש נכסי נדל"ן למכירה פומבית באתר bidspirit.com בקטגוריית בתים ודירות.
החזר JSON בלבד:
{
  "listings": [
    {
      "title": "כותרת הנכס",
      "address": "כתובת מלאה",
      "city": "עיר",
      "price": מחיר_התחלתי_בשקלים,
      "rooms": מספר_חדרים,
      "area_sqm": שטח,
      "floor": קומה,
      "phone": "מספר_טלפון_או_null",
      "contact_name": "שם_איש_קשר_או_null",
      "url": "קישור_למכירה",
      "listing_id": "מזהה_מכירה",
      "auction_date": "תאריך_מכירה_פומבית_או_null"
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
      auction_date: item.auction_date || null
    }));
  } catch (err) {
    logger.debug(`[BidSpirit] Perplexity failed: ${err.message}`);
    return [];
  }
}

async function saveListing(listing) {
  try {
    const sourceId = `bidspirit-${listing.listing_id}`;
    const existing = await pool.query(
      `SELECT id FROM kones_listings WHERE external_id = $1`,
      [sourceId]
    );
    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE kones_listings SET price = COALESCE($1, price), updated_at = NOW()
         WHERE external_id = $2`,
        [listing.price, sourceId]
      );
      return 'updated';
    }
    await pool.query(
      `INSERT INTO kones_listings (external_id, address, city, price, phone,
        contact_name, source_site, is_active, contact_status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'bidspirit', TRUE, NULL, NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      [
        sourceId, listing.address || listing.title, listing.city, listing.price,
        listing.phone, listing.contact_name
      ]
    );
    return 'inserted';
  } catch (err) {
    logger.warn(`[BidSpirit] Save error: ${err.message}`);
    return 'error';
  }
}

async function scanAll(options = {}) {
  const { pages = 3 } = options;
  logger.info(`[BidSpirit] Starting scan (${pages} pages)`);
  let totalInserted = 0, totalUpdated = 0;
  const results = [];

  for (let page = 1; page <= pages; page++) {
    let rawListings = await queryBidspiritDirect(page);
    let source = 'bidspirit_api';
    if (!rawListings || rawListings.length === 0) {
      rawListings = await scrapeBidspiritHtml(page);
      source = 'html';
    }
    if (!rawListings || rawListings.length === 0) {
      if (page === 1) {
        rawListings = await queryBidspiritPerplexity();
        source = 'perplexity';
      } else {
        break;
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
    logger.info(`[BidSpirit] Page ${page}: ${inserted} new, ${updated} updated (via ${source})`);
    if (page < pages) await new Promise(r => setTimeout(r, DELAY_MS));
  }

  logger.info('[BidSpirit] Scan complete:', { totalInserted, totalUpdated });
  return { total_inserted: totalInserted, total_updated: totalUpdated, results };
}

module.exports = { scanAll };
