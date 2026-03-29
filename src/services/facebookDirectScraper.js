/**
 * Facebook Marketplace Direct Scraper (No Apify dependency)
 *
 * Scrapes Facebook Marketplace using direct HTTP requests with cookies.
 * Uses Facebook's internal GraphQL API (same approach FB's frontend uses).
 * Falls back to HTML parsing if GraphQL fails.
 */

const axios = require('axios');
const { logger } = require('./logger');

// Lazy-load cheerio to avoid startup issues
let cheerio;
function getCheerio() {
  if (!cheerio) cheerio = require('cheerio');
  return cheerio;
}

const FB_BASE = 'https://www.facebook.com';
const FB_GRAPHQL = 'https://www.facebook.com/api/graphql/';
const REQUEST_DELAY = 2000; // 2s between requests to avoid rate limiting
const MAX_RETRIES = 2;

// Common headers to mimic real browser
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1'
};

/**
 * Load FB cookies from env and format as cookie header string
 */
function getCookieString() {
  const b64 = process.env.FB_COOKIES_BASE64;
  if (!b64) return null;
  try {
    const json = Buffer.from(b64, 'base64').toString('utf-8');
    const cookies = JSON.parse(json);
    if (Array.isArray(cookies) && cookies.length > 0) {
      return cookies.map(c => `${c.name}=${c.value}`).join('; ');
    }
  } catch (err) {
    logger.warn(`Failed to parse FB_COOKIES_BASE64: ${err.message}`);
  }
  return null;
}

/**
 * Get fb_dtsg token from a Facebook page (needed for GraphQL calls)
 */
async function getFbDtsg(cookieStr) {
  try {
    const resp = await axios.get(`${FB_BASE}/marketplace/`, {
      headers: { ...BROWSER_HEADERS, Cookie: cookieStr },
      timeout: 30000,
      maxRedirects: 5
    });
    const html = resp.data;

    // Extract fb_dtsg from page source
    const dtsgMatch = html.match(/"DTSGInitialData".*?"token":"([^"]+)"/);
    if (dtsgMatch) return dtsgMatch[1];

    // Alternative patterns
    const dtsgMatch2 = html.match(/name="fb_dtsg" value="([^"]+)"/);
    if (dtsgMatch2) return dtsgMatch2[1];

    const dtsgMatch3 = html.match(/"dtsg":\{"token":"([^"]+)"/);
    if (dtsgMatch3) return dtsgMatch3[1];

    const dtsgMatch4 = html.match(/\["DTSGInitData",\[\],\{"token":"([^"]+)"/);
    if (dtsgMatch4) return dtsgMatch4[1];

    logger.warn('Could not extract fb_dtsg from page');
    return null;
  } catch (err) {
    logger.warn(`Failed to get fb_dtsg: ${err.message}`);
    return null;
  }
}

/**
 * Extract user ID from cookies
 */
function getUserId(cookieStr) {
  const match = cookieStr.match(/c_user=(\d+)/);
  return match ? match[1] : null;
}

/**
 * Scrape Marketplace listings via HTML parsing (fallback method)
 * Facebook embeds listing data in script tags as JSON
 */
async function scrapeViaHtml(marketplaceUrl, cookieStr) {
  try {
    logger.info(`[FB-Direct] HTML scrape: ${marketplaceUrl}`);
    const resp = await axios.get(marketplaceUrl, {
      headers: { ...BROWSER_HEADERS, Cookie: cookieStr },
      timeout: 30000,
      maxRedirects: 5
    });

    const html = resp.data;

    // Check if redirected to login
    if (html.includes('/login/') && !html.includes('marketplace_listing_title')) {
      logger.warn('[FB-Direct] Redirected to login - cookies may be expired');
      return [];
    }

    const listings = [];
    const seenIds = new Set();

    // Strategy: FB embeds listing data in script tags as JSON relay data.
    // Each listing has: marketplace_listing_title, formatted_amount, and an ID nearby.
    // We extract title+price pairs, then correlate with nearby IDs.

    // Step 1: Find all title occurrences with their positions
    const titlePattern = /"marketplace_listing_title":"([^"]+)"/g;
    const titlePositions = [];
    let tm;
    while ((tm = titlePattern.exec(html)) !== null) {
      titlePositions.push({ title: tm[1], pos: tm.index });
    }

    // Step 2: For each title, search nearby for price and ID
    for (const tp of titlePositions) {
      // Look in a window around the title (5000 chars before and after)
      const start = Math.max(0, tp.pos - 5000);
      const end = Math.min(html.length, tp.pos + 5000);
      const window = html.substring(start, end);

      // Find price
      const priceMatch = window.match(/"formatted_amount":"([^"]+)"/);
      const price = priceMatch ? priceMatch[1] : null;

      // Find ID (long numeric string)
      const idMatch = window.match(/"id":"(\d{10,20})"/);
      const id = idMatch ? idMatch[1] : null;

      // Find location
      const cityMatch = window.match(/"reverse_geocode":\{[^}]*?"city":"([^"]+)"/);
      const city = cityMatch ? cityMatch[1] : null;

      const locMatch = window.match(/"location_text":\{[^}]*?"text":"([^"]+)"/);
      const location = locMatch ? locMatch[1] : null;

      // Find creation time
      const timeMatch = window.match(/"creation_time":(\d+)/);
      const createdAt = timeMatch ? new Date(parseInt(timeMatch[1]) * 1000).toISOString() : null;

      // Find image
      const imgMatch = window.match(/"image":\{"uri":"([^"]+)"/);
      const image = imgMatch ? imgMatch[1].replace(/\\\//g, '/') : null;

      // Decode unicode escapes in title
      let title = tp.title;
      try {
        title = JSON.parse(`"${tp.title}"`);
      } catch (e) { /* keep as-is */ }

      let decodedPrice = price;
      if (price) {
        try { decodedPrice = JSON.parse(`"${price}"`); } catch (e) { /* keep as-is */ }
      }

      if (id && !seenIds.has(id)) {
        seenIds.add(id);
        listings.push({
          id,
          title,
          price: decodedPrice,
          city,
          location,
          createdAt,
          image,
          url: `${FB_BASE}/marketplace/item/${id}/`,
          source: 'html_window'
        });
      }
    }

    if (listings.length > 0) {
      logger.info(`[FB-Direct] Found ${listings.length} listings via window matching (${titlePositions.length} titles found)`);
      return listings;
    }

    // Fallback: just get IDs from the page
    const altIds = [];
    const altPattern = /"id":"(\d{12,20})"/g;
    let am;
    while ((am = altPattern.exec(html)) !== null) {
      const aid = am[1];
      if (!seenIds.has(aid)) {
        seenIds.add(aid);
        altIds.push(aid);
      }
      if (altIds.length > 50) break;
    }

    if (altIds.length > 0) {
      logger.info(`[FB-Direct] Found ${altIds.length} potential listing IDs (no title match)`);
      return altIds.map(id => ({
        id,
        url: `${FB_BASE}/marketplace/item/${id}/`,
        source: 'html_id_only'
      }));
    }

    logger.info(`[FB-Direct] 0 listings found. htmlLen=${html.length}, titles=${titlePositions.length}`);
    return [];
  } catch (err) {
    logger.warn(`[FB-Direct] HTML scrape failed: ${err.message}`);
    return [];
  }
}

/**
 * Scrape a single listing's details page
 */
async function scrapeListingDetails(listingId, cookieStr) {
  try {
    const url = `${FB_BASE}/marketplace/item/${listingId}/`;
    const resp = await axios.get(url, {
      headers: { ...BROWSER_HEADERS, Cookie: cookieStr },
      timeout: 20000,
      maxRedirects: 5
    });

    const html = resp.data;
    const details = { id: listingId, url };

    // Extract title
    const titleMatch = html.match(/"marketplace_listing_title":"([^"]+)"/);
    if (titleMatch) details.title = titleMatch[1];

    // Extract price
    const priceMatch = html.match(/"formatted_amount":"([^"]+)"/);
    if (priceMatch) details.price = priceMatch[1];

    // Extract description
    const descMatch = html.match(/"redacted_description":\{"text":"([^"]+)"/);
    if (descMatch) details.description = descMatch[1];

    // Alt description
    if (!details.description) {
      const descMatch2 = html.match(/"marketplace_listing_description":"([^"]+)"/);
      if (descMatch2) details.description = descMatch2[1];
    }

    // Extract location
    const locMatch = html.match(/"location_text":\{"text":"([^"]+)"/);
    if (locMatch) details.location = locMatch[1];

    const cityMatch = html.match(/"reverse_geocode":\{[^}]*"city":"([^"]+)"/);
    if (cityMatch) details.city = cityMatch[1];

    // Extract seller
    const sellerMatch = html.match(/"marketplace_listing_seller":\{[^}]*"name":"([^"]+)"/);
    if (sellerMatch) details.sellerName = sellerMatch[1];

    // Extract images
    const imgMatch = html.match(/"image":\{"uri":"([^"]+)"/);
    if (imgMatch) details.image = imgMatch[1].replace(/\\\//g, '/');

    // Extract listing date
    const dateMatch = html.match(/"creation_time":(\d+)/);
    if (dateMatch) details.createdAt = new Date(parseInt(dateMatch[1]) * 1000).toISOString();

    return details;
  } catch (err) {
    logger.debug(`[FB-Direct] Failed to get listing ${listingId} details: ${err.message}`);
    return { id: listingId, url: `${FB_BASE}/marketplace/item/${listingId}/` };
  }
}

/**
 * Main scraping function — tries GraphQL first, falls back to HTML
 */
async function scrapeMarketplace(marketplaceUrl, options = {}) {
  const { maxItems = 50, getDetails = false } = options;
  const cookieStr = getCookieString();

  if (!cookieStr) {
    logger.warn('[FB-Direct] No FB cookies configured. Set FB_COOKIES_BASE64');
    return { listings: [], source: 'no_cookies' };
  }

  const userId = getUserId(cookieStr);
  logger.info(`[FB-Direct] Starting scrape: ${marketplaceUrl} (userId=${userId})`);

  // Try HTML scraping (most reliable with cookies)
  let listings = await scrapeViaHtml(marketplaceUrl, cookieStr);

  // Deduplicate by ID
  const seen = new Set();
  listings = listings.filter(l => {
    if (!l.id) return true;
    if (seen.has(l.id)) return false;
    seen.add(l.id);
    return true;
  });

  // Limit results
  if (listings.length > maxItems) {
    listings = listings.slice(0, maxItems);
  }

  // Optionally get details for each listing
  if (getDetails && listings.length > 0) {
    const listingsWithIds = listings.filter(l => l.id);
    logger.info(`[FB-Direct] Fetching details for ${listingsWithIds.length} listings`);

    for (let i = 0; i < listingsWithIds.length; i++) {
      const listing = listingsWithIds[i];
      const details = await scrapeListingDetails(listing.id, cookieStr);
      Object.assign(listing, details);

      // Rate limiting
      if (i < listingsWithIds.length - 1) {
        await new Promise(r => setTimeout(r, REQUEST_DELAY));
      }
    }
  }

  logger.info(`[FB-Direct] Scraped ${listings.length} listings from ${marketplaceUrl}`);
  return { listings, source: 'direct', rawCount: listings.length };
}

/**
 * Convert direct scraper listing to internal format (same as normalizeApifyListing)
 */
function normalizeDirectListing(item, city) {
  try {
    let price = null;
    const priceRaw = item.price || '';
    const priceStr = String(priceRaw).replace(/[₪,\s]/g, '').replace(/[^\d.]/g, '');
    if (priceStr) {
      price = parseFloat(priceStr);
      if (price < 10000 || price > 50000000) price = null;
    }

    const title = item.title || '';
    const location = item.location || item.city || '';
    const description = item.description || '';

    const addressText = location || title;
    const streetMatch = addressText.match(/(רח(?:וב)?\.?\s*[^\d,]+?)[\s,]*(\d+)?/);
    const street = streetMatch ? streetMatch[1].replace(/^רח(?:וב)?\.?\s*/, '').trim() : '';
    const houseNumber = streetMatch ? (streetMatch[2] || '') : '';

    let rooms = null;
    const roomsMatch = (title + ' ' + description).match(/(\d+(?:\.\d)?)\s*(?:חד|חדר|rooms)/i);
    if (roomsMatch) rooms = parseFloat(roomsMatch[1]);

    let areaSqm = null;
    const areaMatch = (title + ' ' + description).match(/(\d+)\s*(?:מ"ר|מטר|sqm|m²)/i);
    if (areaMatch) areaSqm = parseFloat(areaMatch[1]);

    let floor = null;
    const floorMatch = (title + ' ' + description).match(/קומה\s*(\d+)/i);
    if (floorMatch) floor = parseInt(floorMatch[1]);

    const fullText = `${title} ${description} ${location}`.toLowerCase();
    const isUrgent = /דחוף|הזדמנות|חייב למכור|מתחת לשוק|הורדת מחיר|urgent/.test(fullText);
    const isForeclosure = /כינוס|כונס|receivership/.test(fullText);
    const isInheritance = /ירושה|עיזבון|inheritance/.test(fullText);
    const isAgent = /מתווך|תיווך|סוכן|agent|broker/.test(fullText);

    let daysOnMarket = 0;
    if (item.createdAt) {
      const posted = new Date(item.createdAt);
      if (!isNaN(posted.getTime())) {
        daysOnMarket = Math.floor((Date.now() - posted.getTime()) / (1000 * 60 * 60 * 24));
      }
    }

    const sellerName = item.sellerName || '';

    return {
      address: location || `${street} ${houseNumber}`.trim() || title.substring(0, 100),
      street, house_number: houseNumber,
      asking_price: price, rooms, area_sqm: areaSqm, floor,
      description: `${title}${description ? ' | ' + description.substring(0, 300) : ''}`,
      url: item.url || null,
      listing_id: item.id || item.url || null,
      seller_name: sellerName, days_on_market: daysOnMarket,
      is_urgent: isUrgent, is_foreclosure: isForeclosure,
      is_inheritance: isInheritance, is_agent: isAgent,
      phone: '', image: item.image || null
    };
  } catch (err) {
    logger.debug(`[FB-Direct] Failed to normalize listing: ${err.message}`);
    return null;
  }
}

/**
 * Check if cookies are valid by loading Facebook
 */
async function checkCookies() {
  const cookieStr = getCookieString();
  if (!cookieStr) return { valid: false, reason: 'No cookies configured' };

  try {
    const resp = await axios.get(`${FB_BASE}/marketplace/`, {
      headers: { ...BROWSER_HEADERS, Cookie: cookieStr },
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: () => true
    });

    const html = resp.data;
    const isLoggedIn = html.includes('c_user') || html.includes('marketplace_listing') ||
                       html.includes('MarketplaceFeed') || !html.includes('/login/');
    const userId = getUserId(cookieStr);

    return {
      valid: isLoggedIn,
      userId,
      statusCode: resp.status,
      hasMarketplace: html.includes('marketplace'),
      htmlLength: html.length
    };
  } catch (err) {
    return { valid: false, reason: err.message };
  }
}

/**
 * Debug: fetch raw HTML and return analysis of what patterns exist
 */
async function debugHtml(marketplaceUrl) {
  const cookieStr = getCookieString();
  if (!cookieStr) return { error: 'No cookies' };

  try {
    const resp = await axios.get(marketplaceUrl || `${FB_BASE}/marketplace/tel-aviv/propertyforsale`, {
      headers: { ...BROWSER_HEADERS, Cookie: cookieStr },
      timeout: 30000,
      maxRedirects: 5
    });

    const html = resp.data;
    const patterns = {
      htmlLength: html.length,
      hasMarketplaceListing: html.includes('marketplace_listing'),
      hasMarketplaceListingTitle: html.includes('marketplace_listing_title'),
      hasFormattedAmount: html.includes('formatted_amount'),
      hasListingPrice: html.includes('listing_price'),
      hasListingId: html.includes('listing_id'),
      hasMarketplaceFeed: html.includes('MarketplaceFeed'),
      hasMarketplaceSearch: html.includes('MarketplaceSearch'),
      hasPropertyForSale: html.includes('propertyforsale'),
      hasLogin: html.includes('/login/'),
      hasRedact: html.includes('redacted_description'),
      hasReverseGeocode: html.includes('reverse_geocode'),
      hasCreationTime: html.includes('creation_time'),
      hasMarketplaceListingType: html.includes('MarketplaceListing'),
      hasNodeType: html.includes('"__typename":"MarketplaceListing"'),
    };

    // Find all unique keys that contain "marketplace" or "listing"
    const marketplaceKeys = [];
    const mkMatch = html.matchAll(/"(marketplace[^"]{0,50})"/gi);
    const seen = new Set();
    for (const m of mkMatch) {
      const k = m[1].substring(0, 60);
      if (!seen.has(k)) { seen.add(k); marketplaceKeys.push(k); }
      if (seen.size > 30) break;
    }

    // Try to find listing IDs
    const idMatches = html.matchAll(/"listing_id":"(\d+)"/g);
    const ids = [];
    for (const m of idMatches) { ids.push(m[1]); if (ids.length > 10) break; }

    // Alt: find any long numeric IDs near marketplace context
    const altIds = [];
    const altMatch = html.matchAll(/"id":"(\d{12,20})"/g);
    for (const m of altMatch) { altIds.push(m[1]); if (altIds.length > 10) break; }

    // Find price patterns
    const prices = [];
    const priceMatch = html.matchAll(/"formatted_amount":"([^"]+)"/g);
    for (const m of priceMatch) { prices.push(m[1]); if (prices.length > 10) break; }

    // Find title patterns
    const titles = [];
    const titleMatch = html.matchAll(/"marketplace_listing_title":"([^"]{0,100})"/g);
    for (const m of titleMatch) { titles.push(m[1]); if (titles.length > 10) break; }

    // Snippet around first "marketplace_listing" occurrence
    let snippet = '';
    const idx = html.indexOf('marketplace_listing');
    if (idx > -1) {
      snippet = html.substring(Math.max(0, idx - 50), idx + 200);
    }

    return {
      patterns,
      marketplaceKeys: marketplaceKeys.slice(0, 20),
      listingIds: ids,
      altIds: altIds.slice(0, 10),
      prices: prices.slice(0, 10),
      titles: titles.slice(0, 10),
      snippet: snippet.substring(0, 300)
    };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = {
  scrapeMarketplace,
  scrapeListingDetails,
  normalizeDirectListing,
  checkCookies,
  getCookieString,
  debugHtml
};
