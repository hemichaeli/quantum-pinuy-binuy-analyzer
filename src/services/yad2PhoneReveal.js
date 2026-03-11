/**
 * yad2PhoneReveal.js
 * 
 * Uses Puppeteer to log into yad2.co.il and search for listings by address,
 * then reveals phone numbers by clicking the "גלה מספר" button.
 * 
 * Strategy:
 * 1. Login to yad2
 * 2. For each listing without a phone, search yad2 by address + city
 * 3. Find the matching listing on the search results page
 * 4. Click "גלה מספר" to reveal the phone
 * 5. Save the phone to the DB
 */
const puppeteer = require('puppeteer-core');
const pool = require('../db/pool');
const { logger } = require('./logger');

const YAD2_BASE = 'https://www.yad2.co.il';
const YAD2_LOGIN_URL = `${YAD2_BASE}/login`;
const YAD2_SEARCH_URL = `${YAD2_BASE}/realestate/forsale`;

const CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH 
  || process.env.CHROMIUM_PATH 
  || '/usr/bin/chromium'
  || '/usr/bin/chromium-browser';

let browser = null;
let page = null;
let isLoggedIn = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 12) return null;
  if (digits.startsWith('972')) return '0' + digits.slice(3);
  if (digits.startsWith('0')) return digits;
  return null;
}

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  
  logger.info('[yad2PhoneReveal] Launching browser...', { chromiumPath: CHROMIUM_PATH });
  browser = await puppeteer.launch({
    headless: 'new',
    executablePath: CHROMIUM_PATH,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--single-process',
      '--no-zygote',
      '--lang=he-IL'
    ],
    defaultViewport: { width: 1280, height: 900 }
  });
  
  page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'he-IL,he;q=0.9' });
  isLoggedIn = false;
  return browser;
}

async function login() {
  const email = process.env.YAD2_EMAIL;
  const password = process.env.YAD2_PASSWORD;
  
  if (!email || !password) {
    throw new Error('YAD2_EMAIL and YAD2_PASSWORD env vars required');
  }
  
  await getBrowser();
  logger.info('[yad2PhoneReveal] Logging in to yad2...');
  
  try {
    await page.goto(YAD2_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2000);
    
    // Try multiple login form selectors
    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[placeholder*="מייל"]',
      'input[placeholder*="email"]',
      '#email',
      'input[data-test="email"]'
    ];
    
    let emailInput = null;
    for (const sel of emailSelectors) {
      emailInput = await page.$(sel);
      if (emailInput) break;
    }
    
    if (!emailInput) {
      // Try clicking "login with email" button first
      const emailLoginBtn = await page.$('[data-test="email-login"]');
      if (emailLoginBtn) {
        await emailLoginBtn.click();
        await sleep(1500);
        for (const sel of emailSelectors) {
          emailInput = await page.$(sel);
          if (emailInput) break;
        }
      }
    }
    
    if (!emailInput) {
      throw new Error('Login form not found');
    }
    
    await emailInput.click({ clickCount: 3 });
    await emailInput.type(email, { delay: 50 });
    
    const passwordInput = await page.$('input[type="password"]') 
      || await page.$('input[name="password"]');
    
    if (passwordInput) {
      await passwordInput.click({ clickCount: 3 });
      await passwordInput.type(password, { delay: 50 });
    }
    
    const submitBtn = await page.$('button[type="submit"]') 
      || await page.$('[data-test="submit"]')
      || await page.$('[data-test="login-button"]');
    
    if (submitBtn) {
      await submitBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }
    
    await sleep(4000);
    
    const currentUrl = page.url();
    const isOnLogin = currentUrl.includes('/login');
    
    if (!isOnLogin) {
      isLoggedIn = true;
      logger.info('[yad2PhoneReveal] Login successful');
      return true;
    }
    
    isLoggedIn = true;
    logger.info('[yad2PhoneReveal] Login appears successful');
    return true;
    
  } catch (err) {
    logger.error('[yad2PhoneReveal] Login failed', { error: err.message });
    throw err;
  }
}

/**
 * Search yad2 for a listing by address and reveal its phone
 */
async function searchAndRevealPhone(listing) {
  try {
    if (!isLoggedIn) {
      await login();
    }
    
    const address = listing.address || '';
    const city = listing.city || '';
    const price = listing.asking_price;
    
    if (!address || !city) return null;
    
    // Build search URL - search by free text
    const searchQuery = encodeURIComponent(`${address} ${city}`);
    const searchUrl = `${YAD2_SEARCH_URL}?text=${searchQuery}`;
    
    logger.debug(`[yad2PhoneReveal] Searching for: ${address}, ${city}`);
    
    // Set up response interceptor to capture phone API calls
    let capturedPhone = null;
    
    const responseHandler = async (response) => {
      const url = response.url();
      if (url.includes('/phone') || url.includes('phone_number') || url.includes('contact')) {
        try {
          const data = await response.json();
          if (data?.data?.phone || data?.phone) {
            capturedPhone = cleanPhone(data?.data?.phone || data?.phone);
          }
        } catch (e) {}
      }
    };
    
    page.on('response', responseHandler);
    
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 25000 });
    await sleep(2000);
    
    // Look for listing cards that match our address
    const cards = await page.$$('[data-test="feed-item"], .feed-item, [class*="feedItem"], [class*="feed-item"]');
    logger.debug(`[yad2PhoneReveal] Found ${cards.length} listing cards`);
    
    let matchedCard = null;
    
    // Try to find matching card by address text
    for (const card of cards) {
      try {
        const cardText = await card.evaluate(el => el.innerText || el.textContent || '');
        const addressParts = address.split(' ').filter(p => p.length > 2);
        const matchCount = addressParts.filter(part => cardText.includes(part)).length;
        
        if (matchCount >= 2) {
          // Also check price if available
          if (price) {
            const priceStr = Math.round(price / 1000).toString();
            if (cardText.includes(priceStr) || cardText.includes(price.toString())) {
              matchedCard = card;
              break;
            }
          }
          if (!matchedCard) matchedCard = card;
        }
      } catch (e) {}
    }
    
    if (matchedCard) {
      // Try to click "גלה מספר" button within this card
      const revealBtn = await matchedCard.$('[data-test="phone-reveal"], [data-test="reveal-phone"], button[class*="phone"], [class*="phone-reveal"]');
      if (revealBtn) {
        await revealBtn.click();
        await sleep(2000);
      }
    } else {
      // Try clicking any phone reveal button on the page
      const revealBtns = await page.$$('[data-test="phone-reveal"], [data-test="reveal-phone"], button[class*="phone-reveal"]');
      if (revealBtns.length > 0) {
        await revealBtns[0].click();
        await sleep(2000);
      }
    }
    
    // Check if we captured a phone from API response
    if (capturedPhone) {
      page.off('response', responseHandler);
      return capturedPhone;
    }
    
    // Try to extract phone from page
    const phoneSelectors = [
      '[data-test="phone-number"]',
      '[data-test="phone"]',
      'a[href^="tel:"]',
      '[class*="phone-number"]',
      '[class*="phoneNumber"]',
      '[data-phone]'
    ];
    
    for (const sel of phoneSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          const text = await el.evaluate(node => {
            if (node.href && node.href.startsWith('tel:')) return node.href.replace('tel:', '');
            if (node.dataset?.phone) return node.dataset.phone;
            return node.textContent || '';
          });
          const phone = cleanPhone(text);
          if (phone) {
            page.off('response', responseHandler);
            return phone;
          }
        }
      } catch (e) {}
    }
    
    // Search page content for phone pattern
    const pageContent = await page.evaluate(() => document.body.innerText);
    const phoneRegex = /(?:0[2-9]\d{7,8}|05\d{8}|\+972[2-9]\d{7,8})/g;
    const matches = pageContent.match(phoneRegex);
    if (matches && matches.length > 0) {
      const phone = cleanPhone(matches[0]);
      if (phone) {
        page.off('response', responseHandler);
        return phone;
      }
    }
    
    page.off('response', responseHandler);
    return null;
    
  } catch (err) {
    logger.warn(`[yad2PhoneReveal] Error for listing ${listing.id}: ${err.message}`);
    try { await page.goto('about:blank'); } catch (e) {}
    return null;
  }
}

/**
 * Try to get phone via yad2 API using session cookies
 */
async function tryYad2ApiWithSession(itemId) {
  if (!itemId || itemId === 'NULL' || itemId.startsWith('yad2-')) return null;
  
  try {
    const cookies = await page.cookies('https://www.yad2.co.il');
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    
    const axios = require('axios');
    
    // Try phone reveal API
    const endpoints = [
      `https://gw.yad2.co.il/feed-search/item/${itemId}/phone`,
      `https://gw.yad2.co.il/feed-search-legacy/item/${itemId}/phone`,
      `https://gw.yad2.co.il/realestate/item/${itemId}/phone`
    ];
    
    for (const endpoint of endpoints) {
      try {
        const r = await axios.get(endpoint, {
          headers: {
            'Cookie': cookieStr,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.yad2.co.il/',
            'Origin': 'https://www.yad2.co.il',
            'Accept': 'application/json',
            'mobile_app': 'false'
          },
          timeout: 8000
        });
        
        if (r.data?.data) {
          const d = r.data.data;
          const phone = cleanPhone(d.phone || d.phone_number || d.contactPhone || d.contact_phone);
          if (phone) return phone;
        }
      } catch (e) {
        // Try next endpoint
      }
    }
  } catch (err) {
    logger.debug(`[yad2PhoneReveal] API method failed for ${itemId}: ${err.message}`);
  }
  return null;
}

/**
 * Batch reveal phones for all listings without phones
 * Works across all sources by visiting listing URLs
 */
async function revealPhonesForAllYad2(options = {}) {
  const { limit = 200, scanId = null } = options;
  
  logger.info(`[yad2PhoneReveal] Starting batch phone reveal for up to ${limit} listings`);
  
  // Get listings without phones - prioritize those with yad2 source or yad2 URLs
  const { rows: listings } = await pool.query(`
    SELECT id, source, source_listing_id, url, address, city, asking_price
    FROM listings
    WHERE (phone IS NULL OR phone = '')
      AND is_active = TRUE
      AND address IS NOT NULL
      AND address != ''
      AND city IS NOT NULL
      AND city != ''
    ORDER BY 
      CASE WHEN source = 'yad2' THEN 0
           WHEN source = 'yad1' THEN 1
           WHEN source = 'dira' THEN 2
           ELSE 3 END,
      created_at DESC
    LIMIT $1
  `, [limit]);
  
  logger.info(`[yad2PhoneReveal] Found ${listings.length} listings to process`);
  
  if (listings.length === 0) {
    return { enriched: 0, total: 0 };
  }
  
  let enriched = 0;
  let failed = 0;
  
  try {
    await login();
  } catch (loginErr) {
    logger.error('[yad2PhoneReveal] Cannot login, aborting batch', { error: loginErr.message });
    return { enriched: 0, total: listings.length, error: loginErr.message };
  }
  
  for (const listing of listings) {
    try {
      let phone = null;
      
      // Method 1: Try yad2 API with session cookies (for proper item IDs)
      if (listing.source_listing_id && 
          listing.source_listing_id !== 'NULL' && 
          !listing.source_listing_id.startsWith('yad2-') &&
          /^[a-zA-Z0-9]+$/.test(listing.source_listing_id)) {
        phone = await tryYad2ApiWithSession(listing.source_listing_id);
        if (phone) logger.info(`[yad2PhoneReveal] ✅ API method: ${listing.address} → ${phone}`);
      }
      
      // Method 2: Visit the listing URL directly
      if (!phone && listing.url && 
          listing.url !== 'NULL' && 
          listing.url.includes('yad2.co.il/item/')) {
        phone = await revealPhoneFromUrl(listing.url);
        if (phone) logger.info(`[yad2PhoneReveal] ✅ URL method: ${listing.address} → ${phone}`);
      }
      
      // Method 3: Search yad2 by address
      if (!phone && listing.source === 'yad2') {
        phone = await searchAndRevealPhone(listing);
        if (phone) logger.info(`[yad2PhoneReveal] ✅ Search method: ${listing.address} → ${phone}`);
      }
      
      if (phone) {
        await pool.query(
          `UPDATE listings SET phone = $1, updated_at = NOW() WHERE id = $2`,
          [phone, listing.id]
        );
        enriched++;
      }
      
      // Rate limiting
      await sleep(3000 + Math.random() * 2000);
      
    } catch (err) {
      failed++;
      logger.warn(`[yad2PhoneReveal] Failed for listing ${listing.id}: ${err.message}`);
      await sleep(2000);
    }
  }
  
  // Close browser
  try {
    if (browser) {
      await browser.close();
      browser = null;
      page = null;
      isLoggedIn = false;
    }
  } catch (e) {}
  
  logger.info(`[yad2PhoneReveal] Complete: ${enriched}/${listings.length} phones revealed`);
  return { enriched, failed, total: listings.length };
}

/**
 * Reveal phone from a specific yad2 item URL
 */
async function revealPhoneFromUrl(url) {
  try {
    if (!isLoggedIn) await login();
    
    logger.debug(`[yad2PhoneReveal] Visiting: ${url}`);
    
    let capturedPhone = null;
    const responseHandler = async (response) => {
      const rUrl = response.url();
      if (rUrl.includes('/phone') || rUrl.includes('phone_number')) {
        try {
          const data = await response.json();
          const phone = cleanPhone(data?.data?.phone || data?.phone || data?.data?.phone_number);
          if (phone) capturedPhone = phone;
        } catch (e) {}
      }
    };
    
    page.on('response', responseHandler);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
    await sleep(2000);
    
    // Click reveal button
    const revealSelectors = [
      '[data-test="phone-reveal"]',
      '[data-test="reveal-phone"]',
      'button[class*="phone-reveal"]',
      '[class*="reveal-phone"]',
      'button[aria-label*="טלפון"]'
    ];
    
    for (const sel of revealSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click();
          await sleep(2000);
          break;
        }
      } catch (e) {}
    }
    
    if (capturedPhone) {
      page.off('response', responseHandler);
      return capturedPhone;
    }
    
    // Extract from page
    const telLinks = await page.$$('a[href^="tel:"]');
    for (const link of telLinks) {
      const href = await link.evaluate(el => el.href);
      const phone = cleanPhone(href.replace('tel:', ''));
      if (phone) {
        page.off('response', responseHandler);
        return phone;
      }
    }
    
    page.off('response', responseHandler);
    return null;
    
  } catch (err) {
    logger.warn(`[yad2PhoneReveal] URL visit failed: ${err.message}`);
    return null;
  }
}

module.exports = {
  revealPhoneFromUrl,
  searchAndRevealPhone,
  revealPhonesForAllYad2,
  login
};
