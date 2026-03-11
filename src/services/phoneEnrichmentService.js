/**
 * phoneEnrichmentService.js
 * 
 * Enriches listings with phone numbers using:
 * 1. Gemini Flash - extract phone from description text
 * 2. Perplexity Sonar - search for listing phone on web
 * 3. yad2 API phone endpoint - for yad2 listings with item IDs
 * 4. Direct scraping of listing URL
 */
const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

const DELAY_MS = 1500;
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';
const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions';

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

// ============================================================
// METHOD 1: Extract phone from description using Gemini
// ============================================================
async function extractPhoneFromDescription(listing) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  
  const text = [
    listing.description_snippet || '',
    listing.title || '',
    listing.address || ''
  ].join(' ');
  
  if (!text.trim()) return null;
  
  // Quick regex check first - no need to call AI if phone is obvious
  const phoneRegex = /(?:0[2-9]\d{7,8}|05\d{8}|\+972[2-9]\d{7,8})/g;
  const matches = text.match(phoneRegex);
  if (matches && matches.length > 0) {
    const phone = cleanPhone(matches[0]);
    if (phone) {
      logger.debug(`[PhoneEnrich] Regex found phone for listing ${listing.id}: ${phone}`);
      return phone;
    }
  }
  
  // If text is short or no obvious phone, try Gemini
  if (text.length < 20) return null;
  
  try {
    const prompt = `מצא מספר טלפון בטקסט הבא. אם יש מספר טלפון, החזר אותו בלבד כמחרוזת. אם אין, החזר null.
טקסט: "${text.substring(0, 500)}"
החזר JSON בלבד: {"phone": "0501234567" או null}`;
    
    const response = await axios.post(
      `${GEMINI_API_URL}?key=${apiKey}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 100 }
      },
      { timeout: 10000 }
    );
    
    const raw = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return cleanPhone(parsed.phone);
    }
  } catch (err) {
    logger.debug(`[PhoneEnrich] Gemini extraction failed for listing ${listing.id}: ${err.message}`);
  }
  return null;
}

// ============================================================
// METHOD 2: yad2 phone API endpoint
// ============================================================
async function fetchYad2Phone(itemId) {
  if (!itemId || itemId.startsWith('ai-') || itemId.startsWith('yad2-')) return null;
  
  try {
    // Try the legacy phone endpoint
    const r = await axios.get(`https://gw.yad2.co.il/feed-search/item/${itemId}/phone`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.yad2.co.il/',
        'Origin': 'https://www.yad2.co.il'
      },
      timeout: 10000
    });
    
    if (r.data?.data) {
      const phone = r.data.data.phone || r.data.data.phone_number || r.data.data.contactPhone;
      return cleanPhone(phone);
    }
  } catch (err) {
    // Try alternate endpoint
    try {
      const r2 = await axios.get(`https://gw.yad2.co.il/feed-search-legacy/item/${itemId}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Referer': 'https://www.yad2.co.il/'
        },
        timeout: 10000
      });
      
      if (r2.data?.data) {
        const d = r2.data.data;
        const phone = d.phone || d.contactPhone || d.contact_phone || d.seller_phone;
        return cleanPhone(phone);
      }
    } catch (err2) {
      logger.debug(`[PhoneEnrich] yad2 API failed for item ${itemId}: ${err2.message}`);
    }
  }
  return null;
}

// ============================================================
// METHOD 3: Perplexity search for listing phone
// ============================================================
async function searchPhoneWithPerplexity(listing) {
  const apiKey = process.env.PERPLEXITY_API_KEY || process.env.SONAR_API_KEY;
  if (!apiKey) return null;
  
  const address = listing.address || '';
  const city = listing.city || '';
  const price = listing.asking_price ? `${Math.round(listing.asking_price/1000)}K` : '';
  
  if (!address || !city) return null;
  
  try {
    const prompt = `חפש מודעת מכירת דירה ב-yad2.co.il בכתובת "${address}", ${city}, מחיר ${price} ₪.
מצא את מספר הטלפון של המוכר/מתווך.
החזר JSON בלבד: {"phone": "מספר_טלפון" או null, "contact_name": "שם" או null}`;
    
    const response = await axios.post(
      PERPLEXITY_API_URL,
      {
        model: 'sonar',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200
      },
      {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 20000
      }
    );
    
    const raw = response.data?.choices?.[0]?.message?.content || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        phone: cleanPhone(parsed.phone),
        contact_name: parsed.contact_name || null
      };
    }
  } catch (err) {
    logger.debug(`[PhoneEnrich] Perplexity search failed for listing ${listing.id}: ${err.message}`);
  }
  return null;
}

// ============================================================
// MAIN: Enrich a single listing's phone
// ============================================================
async function enrichListingPhone(listing) {
  // Skip if already has phone
  if (listing.phone && listing.phone.trim()) return { success: false, reason: 'already_has_phone' };
  
  let phone = null;
  let contact_name = null;
  let method = null;
  
  // Method 1: Extract from description
  phone = await extractPhoneFromDescription(listing);
  if (phone) method = 'description_extraction';
  
  // Method 2: yad2 API (for yad2 listings)
  if (!phone && listing.source === 'yad2' && listing.source_listing_id) {
    await sleep(DELAY_MS);
    phone = await fetchYad2Phone(listing.source_listing_id);
    if (phone) method = 'yad2_api';
  }
  
  // Method 3: Perplexity (only for listings with good address data)
  if (!phone && listing.address && listing.city && listing.asking_price) {
    await sleep(DELAY_MS);
    const result = await searchPhoneWithPerplexity(listing);
    if (result?.phone) {
      phone = result.phone;
      contact_name = result.contact_name;
      method = 'perplexity_search';
    }
  }
  
  if (phone) {
    await pool.query(
      `UPDATE listings SET phone = $1, contact_name = COALESCE($2, contact_name), updated_at = NOW() WHERE id = $3`,
      [phone, contact_name, listing.id]
    );
    logger.info(`[PhoneEnrich] Found phone for listing ${listing.id} (${listing.address}): ${phone} via ${method}`);
    return { success: true, phone, method };
  }
  
  return { success: false, reason: 'no_phone_found' };
}

// ============================================================
// BATCH: Enrich all listings without phone
// ============================================================
async function enrichAllPhones(options = {}) {
  const { limit = 100, source = null, usePerplexity = false } = options;
  
  let query = `
    SELECT l.id, l.address, l.city, l.asking_price, l.source, l.source_listing_id,
           l.description_snippet, l.title, l.phone, l.url
    FROM listings l
    WHERE l.is_active = TRUE 
      AND (l.phone IS NULL OR l.phone = '')
      AND l.asking_price > 0
  `;
  const params = [];
  let paramIdx = 1;
  
  if (source) {
    query += ` AND l.source = $${paramIdx}`;
    params.push(source);
    paramIdx++;
  }
  
  query += ` ORDER BY l.created_at DESC LIMIT $${paramIdx}`;
  params.push(limit);
  
  const { rows: listings } = await pool.query(query, params);
  
  if (listings.length === 0) {
    logger.info('[PhoneEnrich] No listings need phone enrichment');
    return { enriched: 0, total: 0 };
  }
  
  logger.info(`[PhoneEnrich] Enriching phones for ${listings.length} listings...`);
  
  let enriched = 0;
  let failed = 0;
  const results = [];
  
  for (const listing of listings) {
    try {
      const result = await enrichListingPhone(listing);
      if (result.success) {
        enriched++;
        results.push({ id: listing.id, address: listing.address, phone: result.phone, method: result.method });
      }
    } catch (err) {
      failed++;
      logger.warn(`[PhoneEnrich] Failed for listing ${listing.id}: ${err.message}`);
    }
    await sleep(DELAY_MS);
  }
  
  logger.info(`[PhoneEnrich] Complete: ${enriched}/${listings.length} phones found`);
  return { enriched, failed, total: listings.length, results };
}

module.exports = {
  enrichListingPhone,
  enrichAllPhones,
  extractPhoneFromDescription,
  fetchYad2Phone,
  searchPhoneWithPerplexity
};
