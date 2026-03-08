/**
 * KonesIsrael Service - Receivership Property Data Integration
 * Sources:
 *   - konesisrael.co.il (blocked by SiteGround CAPTCHA - DB/manual import only)
 *   - konesonline.co.il (ACTIVE - live scraping works, no auth required)
 *
 * ARCHITECTURE: Database-first with live scraping from accessible sources
 * - Primary: Reads from kones_listings table in PostgreSQL
 * - konesonline.co.il: Scraped daily (07:15), ~24 active auction listings
 * - konesisrael.co.il: Manual import via /api/kones/import (CAPTCHA blocks Railway)
 */

const { logger } = require('./logger');

let _axios = null;

function getAxios() {
  if (!_axios) _axios = require('axios');
  return _axios;
}

// Property type -> English mapping
const PROP_TYPES = {
  'דירה': 'apartment', 'דירת גן': 'garden_apartment', 'פנטהאוז': 'penthouse',
  'דופלקס': 'duplex', 'בית פרטי': 'house', 'בית מגורים': 'house',
  'חד משפחתי': 'single_family', 'דו משפחתי': 'duplex_house',
  'מגרש': 'land', 'קרקע': 'land', 'חנות': 'store',
  'מבנה מסחרי': 'commercial', 'יחידה': 'unit', 'מחסן': 'storage'
};

// City -> region mapping (for Israeli cities)
const CITY_REGIONS = {
  'תל אביב': 'מרכז', 'רמת גן': 'מרכז', 'גבעתיים': 'מרכז', 'חולון': 'מרכז',
  'בת ים': 'מרכז', 'בני ברק': 'מרכז', 'פתח תקווה': 'מרכז', 'ראש העין': 'מרכז',
  'אור יהודה': 'מרכז', 'יהוד': 'מרכז', 'יבנה': 'מרכז', 'ראשון לציון': 'מרכז',
  'נס ציונה': 'מרכז', 'רחובות': 'מרכז', 'לוד': 'מרכז', 'רמלה': 'מרכז',
  'הוד השרון': 'שרון', 'כפר סבא': 'שרון', 'רעננה': 'שרון', 'הרצליה': 'שרון',
  'נתניה': 'שרון', 'חדרה': 'שרון',
  'ירושלים': 'ירושלים',
  'חיפה': 'צפון', 'קרית גת': 'דרום', 'אשדוד': 'דרום', 'אשקלון': 'דרום',
  'באר שבע': 'דרום', 'אילת': 'דרום', 'ערד': 'דרום',
  'מגדל העמק': 'צפון', 'נצרת עילית': 'צפון', 'עפולה': 'צפון',
  'שבי שומרון': 'יהודה ושומרון', 'עשרת': 'מרכז'
};

class KonesIsraelService {
  constructor() {
    this.baseUrl = 'https://konesisrael.co.il';
    this.realEstateUrl = `${this.baseUrl}/%D7%A0%D7%93%D7%9C%D7%9F-%D7%9E%D7%9B%D7%95%D7%A0%D7%A1-%D7%A0%D7%9B%D7%A1%D7%99%D7%9D/`;
    this.konesonlineUrl = 'https://www.konesonline.co.il/RealEstates';

    this.credentials = {
      email: process.env.KONES_EMAIL || '',
      password: process.env.KONES_PASSWORD || ''
    };

    this.listingsCache = { data: null, timestamp: null, ttl: 4 * 60 * 60 * 1000 };
    this.isLoggedIn = false;
    this._pool = null;
    this._tableReady = false;
  }

  _getPool() {
    if (!this._pool) this._pool = require('../db/pool');
    return this._pool;
  }

  isConfigured() {
    return !!(this.credentials.email && this.credentials.password);
  }

  async _ensureTable() {
    if (this._tableReady) return;
    const pool = this._getPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kones_listings (
        id SERIAL PRIMARY KEY,
        source VARCHAR(50) DEFAULT 'konesisrael',
        property_type VARCHAR(100),
        property_type_en VARCHAR(50),
        region VARCHAR(100),
        region_en VARCHAR(50),
        city VARCHAR(200),
        address TEXT,
        submission_deadline DATE,
        gush_helka VARCHAR(200),
        gush INTEGER,
        helka INTEGER,
        tat_helka INTEGER,
        contact_person VARCHAR(200),
        email VARCHAR(200),
        phone VARCHAR(50),
        contact_status VARCHAR(50) DEFAULT 'pending',
        contact_attempts INTEGER DEFAULT 0,
        last_contact_at TIMESTAMP,
        url TEXT,
        external_id VARCHAR(100),
        is_receivership BOOLEAN DEFAULT true,
        ssi_contribution INTEGER DEFAULT 30,
        raw_data JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        is_active BOOLEAN DEFAULT true
      )
    `);
    // Add columns if missing (migration-safe)
    try {
      await pool.query(`ALTER TABLE kones_listings ADD COLUMN IF NOT EXISTS contact_status VARCHAR(50) DEFAULT 'pending'`);
      await pool.query(`ALTER TABLE kones_listings ADD COLUMN IF NOT EXISTS contact_attempts INTEGER DEFAULT 0`);
      await pool.query(`ALTER TABLE kones_listings ADD COLUMN IF NOT EXISTS last_contact_at TIMESTAMP`);
      await pool.query(`ALTER TABLE kones_listings ADD COLUMN IF NOT EXISTS external_id VARCHAR(100)`);
    } catch (e) { /* columns already exist */ }
    this._tableReady = true;
  }

  // ─────────────────────────────────────────
  // KONESONLINE.CO.IL LIVE SCRAPER
  // ─────────────────────────────────────────

  /**
   * Scrape konesonline.co.il/RealEstates - returns parsed listings array
   * Format: "DD/MM/YYYY HH:MM [type] ב[city] רח' [street] [status_text]"
   */
  async scrapeKonesonline() {
    const axios = getAxios();
    const client = axios.create({
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache'
      },
      maxRedirects: 5
    });

    logger.info('[KonesonlineScraper] Fetching konesonline.co.il/RealEstates...');
    const response = await client.get(this.konesonlineUrl);
    const html = response.data;

    if (!html || html.length < 5000) {
      throw new Error(`konesonline returned short response (${html ? html.length : 0} bytes)`);
    }

    return this._parseKonesonlineHtml(html);
  }

  _parseKonesonlineHtml(html) {
    const listings = [];
    const propTypes = Object.keys(PROP_TYPES).join('|');

    // Extract listing blocks by splitting on RealEstatesProductDetails links
    const blockPattern = /RealEstatesProductDetails\/(\d+)[^>]*>([\s\S]*?)(?=RealEstatesProductDetails\/\d+|<\/body>|$)/g;
    let match;
    const seen = new Set();

    while ((match = blockPattern.exec(html)) !== null) {
      const externalId = match[1];
      if (seen.has(externalId)) continue;
      seen.add(externalId);

      // Strip HTML tags and decode entities
      let text = match[2]
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&#x27;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&#20;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      // Parse auction date: DD/MM/YYYY HH:MM
      const dateMatch = text.match(/(\d{2}\/\d{2}\/\d{4})/);
      const submissionDeadline = dateMatch ? this._parseDate(dateMatch[1]) : null;

      // Parse property type
      const propMatch = new RegExp(`(${propTypes})`).exec(text);
      const propertyType = propMatch ? propMatch[1] : null;

      // Parse city: after "ב" following property type
      // Pattern: "[type] ב[city] רח'|שד'"
      let city = null;
      let address = null;

      if (propertyType) {
        const afterType = text.slice(text.indexOf(propertyType) + propertyType.length).trim();
        // City: "ב[city]" before "רח'" or "שד'" or end
        const cityMatch = afterType.match(/^ב([\u05d0-\u05ea\s\-"']+?)(?:\s+(?:רח'|רחוב|שד'|דרך))/);
        if (cityMatch) {
          city = cityMatch[1].trim();
          // Street: after "רח'" / "שד'" etc., stop at status words
          const streetMatch = afterType.match(/(?:רח'|רחוב|שד'|דרך)\s+([\u05d0-\u05ea\s"'\-\d]+?)(?:\s+(?:המכרז|עוד|צפה|הסתיים|פעיל|היום|\d{2}\/)|$)/);
          if (streetMatch) {
            address = streetMatch[1].trim();
          }
        } else {
          // Fallback: extract city from title pattern "דירה- [city]- רח' [street]"
          const titleMatch = text.match(new RegExp(`${propertyType}[\\s\\-]+([\\u05d0-\\u05ea\\s]+?)[\\s\\-]+(?:רח'|רחוב|שד')\\s+([\\u05d0-\\u05ea\\s"'\\-\\d]+)`));
          if (titleMatch) {
            city = titleMatch[1].trim();
            address = titleMatch[2].trim().split(/\s+(?:עוד|המכרז|צפה)/)[0].trim();
          }
        }
      }

      // Clean up address - remove trailing status text
      if (address) {
        address = address
          .replace(/\s+(?:עוד \d+ ימים?|המכרז היום|עוד יום אחד).*$/, '')
          .trim();
      }

      if (!city && !address && !propertyType) continue;

      // Determine region from city
      const region = city ? (CITY_REGIONS[city] || null) : null;

      const listing = {
        source: 'konesonline',
        externalId,
        propertyType,
        propertyTypeEn: PROP_TYPES[propertyType] || 'other',
        city: city || null,
        address: address || null,
        region,
        regionEn: region === 'מרכז' ? 'center' : region === 'דרום' ? 'south' : region === 'צפון' ? 'north' : region === 'ירושלים' ? 'jerusalem' : null,
        submissionDeadline,
        phone: null, // konesonline requires subscription for contact details
        url: `https://www.konesonline.co.il/RealEstates/RealEstatesProductDetails/${externalId}`,
        isReceivership: true,
        ssiContribution: 30
      };

      if (listing.city || listing.address) {
        listings.push(listing);
      }
    }

    logger.info(`[KonesonlineScraper] Parsed ${listings.length} listings`);
    return listings;
  }

  /**
   * Run daily konesonline scrape + import new listings into DB
   */
  async runKonesonlineScrape() {
    try {
      const listings = await this.scrapeKonesonline();
      if (listings.length === 0) {
        return { success: false, error: 'No listings scraped', imported: 0, skipped: 0 };
      }

      const result = await this.importListings(listings);
      logger.info(`[KonesonlineScraper] Done: ${result.imported} imported, ${result.skipped} skipped`);
      return { success: true, ...result, source: 'konesonline' };
    } catch (err) {
      logger.error(`[KonesonlineScraper] Failed: ${err.message}`);
      return { success: false, error: err.message, imported: 0, skipped: 0 };
    }
  }

  // ─────────────────────────────────────────
  // DATABASE OPERATIONS
  // ─────────────────────────────────────────

  async fetchFromDatabase() {
    try {
      await this._ensureTable();
      const pool = this._getPool();
      const result = await pool.query(`
        SELECT * FROM kones_listings
        WHERE is_active = true
        ORDER BY created_at DESC
      `);
      return result.rows.map(row => ({
        id: `kones_db_${row.id}`,
        dbId: row.id,
        source: row.source || 'konesisrael',
        propertyType: row.property_type,
        propertyTypeEn: row.property_type_en || PROP_TYPES[row.property_type] || 'other',
        region: row.region,
        regionEn: row.region_en || null,
        city: row.city,
        address: row.address,
        submissionDeadline: row.submission_deadline ? row.submission_deadline.toISOString().split('T')[0] : null,
        gushHelka: row.gush_helka,
        gush: row.gush,
        helka: row.helka,
        tatHelka: row.tat_helka,
        contactPerson: row.contact_person,
        email: row.email,
        phone: row.phone,
        contactStatus: row.contact_status || 'pending',
        url: row.url,
        externalId: row.external_id,
        isReceivership: true,
        ssiContribution: row.ssi_contribution || 30,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));
    } catch (error) {
      logger.error(`KonesIsrael DB fetch error: ${error.message}`);
      return [];
    }
  }

  async importListings(listings) {
    await this._ensureTable();
    const pool = this._getPool();
    let imported = 0;
    let skipped = 0;

    for (const listing of listings) {
      try {
        // Deduplicate by external_id (konesonline) or city+address+type
        let existing;
        if (listing.externalId) {
          existing = await pool.query(
            `SELECT id FROM kones_listings WHERE external_id = $1 AND source = $2`,
            [listing.externalId, listing.source || 'konesisrael']
          );
        } else {
          existing = await pool.query(
            `SELECT id FROM kones_listings WHERE city = $1 AND address = $2 AND property_type = $3 AND is_active = true`,
            [listing.city || '', listing.address || '', listing.propertyType || listing.property_type || '']
          );
        }

        if (existing.rows.length > 0) {
          skipped++;
          continue;
        }

        const gushHelka = listing.gushHelka || listing.gush_helka || '';
        let gush = listing.gush || null;
        let helka = listing.helka || null;
        let tatHelka = listing.tatHelka || listing.tat_helka || null;

        if (gushHelka && !gush) {
          const parsed = this.parseGushHelka(gushHelka);
          gush = parsed.gush;
          helka = parsed.helka;
          tatHelka = parsed.tatHelka;
        }

        await pool.query(`
          INSERT INTO kones_listings
            (source, property_type, property_type_en, region, region_en,
             city, address, submission_deadline, gush_helka, gush, helka, tat_helka,
             contact_person, email, phone, url, external_id, ssi_contribution, raw_data)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        `, [
          listing.source || 'konesisrael',
          listing.propertyType || listing.property_type || null,
          listing.propertyTypeEn || listing.property_type_en || PROP_TYPES[listing.propertyType] || 'other',
          listing.region || null,
          listing.regionEn || listing.region_en || null,
          listing.city || null,
          listing.address || null,
          listing.submissionDeadline || listing.submission_deadline || null,
          gushHelka || null,
          gush, helka, tatHelka,
          listing.contactPerson || listing.contact_person || null,
          listing.email || null,
          listing.phone || null,
          listing.url || null,
          listing.externalId || listing.external_id || null,
          listing.ssiContribution || listing.ssi_contribution || 30,
          JSON.stringify(listing)
        ]);

        imported++;
      } catch (err) {
        logger.warn(`KonesIsrael import error for ${listing.city}/${listing.address}: ${err.message}`);
      }
    }

    this.listingsCache.data = null;
    this.listingsCache.timestamp = null;

    return { imported, skipped, total: listings.length };
  }

  // ─────────────────────────────────────────
  // MAIN FETCH (DB-FIRST)
  // ─────────────────────────────────────────

  async fetchListings(forceRefresh = false) {
    if (!forceRefresh && this.listingsCache.data &&
        Date.now() - this.listingsCache.timestamp < this.listingsCache.ttl) {
      return this.listingsCache.data;
    }

    const dbListings = await this.fetchFromDatabase();
    this.listingsCache.data = dbListings;
    this.listingsCache.timestamp = Date.now();

    if (dbListings.length > 0) {
      logger.info(`KonesIsrael: ${dbListings.length} listings from database`);
    }

    return dbListings;
  }

  async fetchWithLogin(forceRefresh = false) {
    return await this.fetchListings(forceRefresh);
  }

  // ─────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────

  _parseDate(dateStr) {
    if (!dateStr) return null;
    const match = dateStr.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
    if (match) {
      const day = match[1].padStart(2, '0');
      const month = match[2].padStart(2, '0');
      const year = match[3].length === 2 ? `20${match[3]}` : match[3];
      return `${year}-${month}-${day}`;
    }
    return null;
  }

  parseDate(dateStr) { return this._parseDate(dateStr); }

  extractEmail(html) {
    if (!html) return null;
    const match = html.match(/mailto:([^\s"'>]+)/);
    if (match) return match[1];
    const emailMatch = html.match(/[\w.-]+@[\w.-]+\.\w+/);
    return emailMatch ? emailMatch[0] : null;
  }

  extractPhone(html) {
    if (!html) return null;
    const match = html.match(/(?:tel:|href="tel:)?(\d{2,3}[-\s]?\d{3,4}[-\s]?\d{3,4})/);
    return match ? match[1].replace(/[\s-]/g, '') : null;
  }

  parseGushHelka(str) {
    const result = { gush: null, helka: null, tatHelka: null };
    if (!str) return result;
    const gushMatch = str.match(/גוש\s*(\d+)/);
    const helkaMatch = str.match(/חלקה\s*(\d+)/);
    const tatMatch = str.match(/תת\s*חלקה?\s*(\d+)/);
    if (gushMatch) result.gush = parseInt(gushMatch[1]);
    if (helkaMatch) result.helka = parseInt(helkaMatch[1]);
    if (tatMatch) result.tatHelka = parseInt(tatMatch[1]);
    return result;
  }

  // ─────────────────────────────────────────
  // SEARCH & MATCH
  // ─────────────────────────────────────────

  async searchByCity(city) {
    const listings = await this.fetchListings();
    return listings.filter(l => l.city && l.city.includes(city));
  }

  async searchByRegion(region) {
    const listings = await this.fetchListings();
    return listings.filter(l => l.region === region || l.regionEn === region);
  }

  async searchByGushHelka(gush, helka = null) {
    const listings = await this.fetchListings();
    return listings.filter(l => {
      if (l.gush !== gush) return false;
      if (helka && l.helka !== helka) return false;
      return true;
    });
  }

  async checkAddress(city, street) {
    const listings = await this.fetchListings();
    const normalizedStreet = street.toLowerCase().replace(/\s+/g, ' ');
    const normalizedCity = city.toLowerCase();
    return listings.filter(l => {
      const listingCity = (l.city || '').toLowerCase();
      const listingAddress = (l.address || '').toLowerCase().replace(/\s+/g, ' ');
      return listingCity.includes(normalizedCity) && listingAddress.includes(normalizedStreet);
    });
  }

  async matchWithComplexes(complexes) {
    const listings = await this.fetchListings();
    if (listings.length === 0) return [];
    const matches = [];

    for (const complex of complexes) {
      const city = complex.city;
      const address = complex.addresses || complex.address || complex.name || '';

      const matchingListings = listings.filter(l => {
        if (!l.city || !city) return false;
        const cityMatch = l.city.includes(city) || city.includes(l.city);
        if (!cityMatch) return false;
        if (address && l.address) {
          return l.address.includes(address) || address.includes(l.address);
        }
        return cityMatch;
      });

      if (matchingListings.length > 0) {
        matches.push({
          complexId: complex.id,
          complexName: complex.name || `${city} - ${address}`,
          matchedListings: matchingListings.length,
          listings: matchingListings,
          ssiBoost: 30
        });
      }
    }

    return matches;
  }

  async getStatistics() {
    const listings = await this.fetchListings();
    const stats = {
      total: listings.length,
      byPropertyType: {}, byRegion: {}, byCity: {},
      upcomingDeadlines: [], urgentDeadlines: []
    };

    const now = new Date();
    const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    for (const listing of listings) {
      stats.byPropertyType[listing.propertyType || 'אחר'] =
        (stats.byPropertyType[listing.propertyType || 'אחר'] || 0) + 1;
      stats.byRegion[listing.region || 'לא ידוע'] =
        (stats.byRegion[listing.region || 'לא ידוע'] || 0) + 1;
      stats.byCity[listing.city || 'לא ידוע'] =
        (stats.byCity[listing.city || 'לא ידוע'] || 0) + 1;

      if (listing.submissionDeadline) {
        const deadline = new Date(listing.submissionDeadline);
        if (deadline > now) {
          stats.upcomingDeadlines.push({
            ...listing,
            deadline: listing.submissionDeadline,
            daysLeft: Math.ceil((deadline - now) / (24 * 60 * 60 * 1000))
          });
          if (deadline <= sevenDaysFromNow) {
            stats.urgentDeadlines.push(listing);
          }
        }
      }
    }

    stats.upcomingDeadlines.sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
    stats.upcomingDeadlines = stats.upcomingDeadlines.slice(0, 20);

    return stats;
  }

  async getStatus() {
    let dbCount = 0;
    let bySource = {};
    try {
      await this._ensureTable();
      const pool = this._getPool();
      const result = await pool.query(`
        SELECT source, COUNT(*) as cnt FROM kones_listings
        WHERE is_active = true GROUP BY source
      `);
      result.rows.forEach(r => {
        bySource[r.source] = parseInt(r.cnt);
        dbCount += parseInt(r.cnt);
      });
    } catch (e) { /* table may not exist yet */ }

    return {
      status: 'ready',
      method: 'database_first_with_live_scraping',
      sources: {
        konesonline: { status: 'active', method: 'live_scraping', schedule: 'daily_07:15' },
        konesisrael: { status: 'manual_import', method: 'blocked_by_captcha', note: 'Use /api/kones/import' },
        bidspirit: { status: 'manual_import', method: 'api_pending' },
        rubin_law: { status: 'manual_import' }
      },
      dbListings: dbCount,
      bySource,
      cached: !!(this.listingsCache.data),
      cachedCount: this.listingsCache.data ? this.listingsCache.data.length : 0,
      cacheAge: this.listingsCache.timestamp
        ? Math.round((Date.now() - this.listingsCache.timestamp) / 60000) + ' minutes'
        : 'no cache'
    };
  }
}

const konesIsraelService = new KonesIsraelService();
module.exports = konesIsraelService;
