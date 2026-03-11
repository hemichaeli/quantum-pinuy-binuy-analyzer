/**
 * yad2PhoneReveal.js
 * 
 * Uses Puppeteer to log into yad2.co.il and reveal phone numbers
 * for listings by clicking the "גלה מספר" button.
 * 
 * This is the ONLY reliable way to get phone numbers from yad2
 * since they are hidden behind authentication + reveal button.
 */
const puppeteer = require('puppeteer-core');
const pool = require('../db/pool');
const { logger } = require('./logger');

const YAD2_BASE = 'https://www.yad2.co.il';
const YAD2_LOGIN_URL = `${YAD2_BASE}/login`;

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
  logger.info('[yad2PhoneReveal] Logging in...');
  
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
      const emailLoginBtn = await page.$('button[data-test="email-login"]') 
        || await page.$('[data-test="email-login"]')
        || await page.$('button:contains("כניסה עם אימייל")');
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
      || await page.$('button[data-test="login-button"]');
    
    if (submitBtn) {
      await submitBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }
    
    await sleep(3000);
    
    // Check if logged in by looking for user menu or profile
    const currentUrl = page.url();
    const isOnLogin = currentUrl.includes('/login');
    
    if (!isOnLogin) {
      isLoggedIn = true;
      logger.info('[yad2PhoneReveal] Login successful');
      return true;
    }
    
    // Check for error message
    const errorEl = await page.$('.error-message, [data-test="error"]');
    if (errorEl) {
      const errorText = await errorEl.evaluate(el => el.textContent);
      throw new Error(`Login failed: ${errorText}`);
    }
    
    // Sometimes yad2 redirects to home after login
    isLoggedIn = true;
    logger.info('[yad2PhoneReveal] Login appears successful (no error found)');
    return true;
    
  } catch (err) {
    logger.error('[yad2PhoneReveal] Login failed', { error: err.message });
    throw err;
  }
}

/**
 * Reveal phone number for a single yad2 listing
 * @param {string} itemId - yad2 item ID
 * @param {string} url - full URL to the listing
 */
async function revealPhoneForListing(itemId, url) {
  try {
    if (!isLoggedIn) {
      await login();
    }
    
    const listingUrl = url || `${YAD2_BASE}/item/${itemId}`;
    logger.debug(`[yad2PhoneReveal] Visiting: ${listingUrl}`);
    
    await page.goto(listingUrl, { waitUntil: 'networkidle2', timeout: 25000 });
    await sleep(2000);
    
    // Method 1: Click "גלה מספר" / "הצג מספר" button
    const revealSelectors = [
      '[data-test="phone-reveal"]',
      '[data-test="reveal-phone"]',
      'button[data-test*="phone"]',
      '.phone-reveal-button',
      '.reveal-phone',
      'button:has-text("גלה מספר")',
      'button:has-text("הצג מספר")',
      '[class*="phone-reveal"]',
      '[class*="reveal-phone"]',
      'button[aria-label*="טלפון"]',
      '.contact-button',
      '[data-test="contact-phone"]'
    ];
    
    let phoneRevealed = false;
    for (const sel of revealSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click();
          await sleep(1500);
          phoneRevealed = true;
          break;
        }
      } catch (e) {
        // Continue trying other selectors
      }
    }
    
    // Method 2: Try intercepting the phone API call
    // Set up response interceptor before navigating
    let interceptedPhone = null;
    
    // Method 3: Extract phone from page after reveal
    const phoneSelectors = [
      '[data-test="phone-number"]',
      '[data-test="phone"]',
      '.phone-number',
      '[class*="phone-number"]',
      '[class*="phoneNumber"]',
      'a[href^="tel:"]',
      '[data-phone]',
      '.contact-phone'
    ];
    
    for (const sel of phoneSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          const text = await el.evaluate(node => {
            // Try href first (tel: links)
            if (node.href && node.href.startsWith('tel:')) {
              return node.href.replace('tel:', '');
            }
            // Try data-phone attribute
            if (node.dataset && node.dataset.phone) {
              return node.dataset.phone;
            }
            return node.textContent || node.innerText || '';
          });
          const phone = cleanPhone(text);
          if (phone) {
            logger.info(`[yad2PhoneReveal] Found phone for ${itemId}: ${phone} (selector: ${sel})`);
            return phone;
          }
        }
      } catch (e) {
        // Continue
      }
    }
    
    // Method 4: Search page content for phone pattern
    const pageContent = await page.evaluate(() => document.body.innerText);
    const phoneRegex = /(?:0[2-9]\d{7,8}|05\d{8}|\+972[2-9]\d{7,8})/g;
    const matches = pageContent.match(phoneRegex);
    if (matches && matches.length > 0) {
      const phone = cleanPhone(matches[0]);
      if (phone) {
        logger.info(`[yad2PhoneReveal] Found phone via regex for ${itemId}: ${phone}`);
        return phone;
      }
    }
    
    // Method 5: Try the yad2 API directly with session cookies
    const cookies = await page.cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    
    try {
      const axios = require('axios');
      const apiRes = await axios.get(
        `https://gw.yad2.co.il/feed-search/item/${itemId}/phone`,
        {
          headers: {
            'Cookie': cookieStr,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': listingUrl,
            'Origin': 'https://www.yad2.co.il',
            'Accept': 'application/json'
          },
          timeout: 10000
        }
      );
      
      if (apiRes.data?.data) {
        const d = apiRes.data.data;
        const phone = cleanPhone(d.phone || d.phone_number || d.contactPhone);
        if (phone) {
          logger.info(`[yad2PhoneReveal] Found phone via API for ${itemId}: ${phone}`);
          return phone;
        }
      }
    } catch (apiErr) {
      logger.debug(`[yad2PhoneReveal] API method failed for ${itemId}: ${apiErr.message}`);
    }
    
    logger.debug(`[yad2PhoneReveal] No phone found for ${itemId}`);
    return null;
    
  } catch (err) {
    logger.warn(`[yad2PhoneReveal] Error for ${itemId}: ${err.message}`);
    
    // Reset browser on error
    if (err.message.includes('navigation') || err.message.includes('timeout')) {
      try {
        await page.goto('about:blank');
      } catch (e) {}
    }
    
    return null;
  }
}

/**
 * Batch reveal phones for all yad2 listings without phones
 */
async function revealPhonesForAllYad2(options = {}) {
  const { limit = 200, scanId = null } = options;
  
  logger.info(`[yad2PhoneReveal] Starting batch phone reveal for up to ${limit} yad2 listings`);
  
  // Get yad2 listings without phones
  const { rows: listings } = await pool.query(`
    SELECT id, source_listing_id, url, address, city, asking_price
    FROM listings
    WHERE source = 'yad2'
      AND (phone IS NULL OR phone = '')
      AND is_active = TRUE
      AND source_listing_id IS NOT NULL
      AND source_listing_id NOT LIKE 'ai-%'
      AND source_listing_id NOT LIKE 'yad2-%'
      AND source_listing_id ~ '^[a-zA-Z0-9]+$'
    ORDER BY created_at DESC
    LIMIT $1
  `, [limit]);
  
  logger.info(`[yad2PhoneReveal] Found ${listings.length} yad2 listings to process`);
  
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
      const phone = await revealPhoneForListing(
        listing.source_listing_id,
        listing.url
      );
      
      if (phone) {
        await pool.query(
          `UPDATE listings SET phone = $1, updated_at = NOW() WHERE id = $2`,
          [phone, listing.id]
        );
        enriched++;
        logger.info(`[yad2PhoneReveal] ✅ ${listing.address}: ${phone}`);
      }
      
      // Rate limiting - be respectful
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

module.exports = {
  revealPhoneForListing,
  revealPhonesForAllYad2,
  login
};
