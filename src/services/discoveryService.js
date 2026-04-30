/**
 * Discovery Service - Find NEW Pinuy-Binuy complexes
 * 
 * Searches for urban renewal projects that match our criteria:
 * - Minimum 24 housing units (per Pinuy-Binuy law)
 * - Specific regions (Gush Dan, Sharon, Center, Jerusalem, Haifa)
 * - Any planning status
 * 
 * Runs DAILY as part of the morning scan
 */

const pool = require('../db/pool');
const { logger } = require('./logger');

// Lazy-load onboarding pipeline to avoid circular deps
function getOnboardingPipeline() {
  try { return require('./onboardingPipeline'); }
  catch (e) { logger.warn('[Discovery] onboardingPipeline not available'); return null; }
}

// Target cities by region
const TARGET_REGIONS = {
  'גוש דן': ['תל אביב', 'רמת גן', 'גבעתיים', 'בני ברק', 'חולון', 'בת ים', 'אור יהודה', 'קריית אונו', 'יהוד'],
  'שרון': ['רעננה', 'כפר סבא', 'הוד השרון', 'הרצליה', 'נתניה', 'רמת השרון', 'כוכב יאיר'],
  'מרכז': ['פתח תקווה', 'ראשון לציון', 'רחובות', 'נס ציונה', 'לוד', 'רמלה', 'מודיעין'],
  'ירושלים': ['ירושלים', 'בית שמש', 'מבשרת ציון', 'מעלה אדומים'],
  'חיפה והקריות': ['חיפה', 'קריית ביאליק', 'קריית מוצקין', 'קריית ים', 'קריית אתא', 'נשר', 'טירת כרמל'],
  'דרום': ['אשקלון', 'אשדוד', 'באר שבע', 'יבנה', 'באר יעקב']
};

// All target cities flat list
const ALL_TARGET_CITIES = Object.values(TARGET_REGIONS).flat();

// City name normalization map - common abbreviations/variants to canonical name
const CITY_NORMALIZATION = {
  'ראשלצ': 'ראשון לציון',
  'ת"א': 'תל אביב',
  'תל-אביב': 'תל אביב',
  'תל אביב יפו': 'תל אביב',
  'תל אביב-יפו': 'תל אביב',
  'פ"ת': 'פתח תקווה',
  'פת': 'פתח תקווה',
  'פתח-תקווה': 'פתח תקווה',
  'ר"ג': 'רמת גן',
  'רמת-גן': 'רמת גן',
  'ב"ב': 'בני ברק',
  'בני-ברק': 'בני ברק',
  'ב"ש': 'בית שמש',
  'בית-שמש': 'בית שמש',
  'כ"ס': 'כפר סבא',
  'כפר-סבא': 'כפר סבא',
  'הוד-השרון': 'הוד השרון',
  'רמת-השרון': 'רמת השרון',
  'נס-ציונה': 'נס ציונה',
  'קרית ביאליק': 'קריית ביאליק',
  'קרית מוצקין': 'קריית מוצקין',
  'קרית ים': 'קריית ים',
  'קרית אתא': 'קריית אתא',
  'קרית אונו': 'קריית אונו',
  'טירת-כרמל': 'טירת כרמל',
  'מעלה-אדומים': 'מעלה אדומים',
  'מבשרת-ציון': 'מבשרת ציון',
  'אור-יהודה': 'אור יהודה',
  'כוכב-יאיר': 'כוכב יאיר',
  'מודיעין מכבים רעות': 'מודיעין',
  'מודיעין-מכבים-רעות': 'מודיעין'
};

/**
 * Normalize city name to canonical form
 */
function normalizeCity(city) {
  if (!city) return city;
  const trimmed = city.trim();
  return CITY_NORMALIZATION[trimmed] || trimmed;
}

// Minimum housing units per Pinuy-Binuy law
const MIN_HOUSING_UNITS = 24;

function getTodaysCities() {
  // 2026-05-01: removed rotation — daily discovery now scans ALL TARGET_REGIONS cities
  // every morning. Rotation (4→12 cities/day) meant new declarations took 3-9 days to
  // surface; with full coverage they surface within 24h. Cost: ~38 Perplexity sonar
  // calls/day ≈ $0.20/day (~$6/month). Duration: ~2.5 min extra at 4s delay/city.
  return [...ALL_TARGET_CITIES];
}

function buildDiscoveryPrompt(city, existingNames = []) {
  const excludeSection = existingNames.length > 0
    ? `\n\nחשוב מאוד: המתחמים הבאים כבר קיימים במערכת שלי עבור ${city}. אל תחזיר אותם שוב, גם לא בשמות דומים או וריאציות:\n${existingNames.map(n => '- ' + n).join('\n')}\n\nהחזר רק מתחמים שלא מופיעים ברשימה הזו.`
    : '';
  return `חפש מתחמי פינוי בינוי והתחדשות עירונית חדשים ב${city}.${excludeSection}

אני מחפש מתחמים שעונים לקריטריונים:
- מינימום ${MIN_HOUSING_UNITS} יחידות דיור קיימות (לפי חוק פינוי בינוי)
- לפחות 70 יחידות דיור מתוכננות
- בכל שלב תכנוני (הוכרז, בתכנון, הופקד, אושר, בביצוע)
- פרויקטים שהוכרזו או קודמו ב-2023-2025

החזר JSON בלבד (ללא טקסט נוסף) בפורמט:

{
  "city": "${city}",
  "discovered_complexes": [
    {
      "name": "שם המתחם/שכונה",
      "addresses": "כתובות או גבולות המתחם",
      "existing_units": 0,
      "planned_units": 0,
      "developer": "שם היזם או null",
      "status": "הוכרז/בתכנון/הופקד/אושר/בביצוע",
      "plan_number": "מספר תוכנית אם ידוע",
      "source": "מקור המידע",
      "last_update": "YYYY-MM-DD או null",
      "notes": "הערות נוספות"
    }
  ],
  "search_date": "${new Date().toISOString().split('T')[0]}",
  "confidence": "high/medium/low"
}

חפש במקורות:
- mavat.iplan.gov.il (מנהל התכנון)
- הרשות להתחדשות עירונית
- אתרי חדשות נדל"ן (גלובס, כלכליסט, דה-מרקר)
- אתרי הרשויות המקומיות

החזר JSON בלבד.`;
}

const DISCOVERY_SYSTEM_PROMPT = `You are an Israeli real estate research assistant specializing in finding Pinuy-Binuy (urban renewal) projects.
Return ONLY valid JSON. No explanations, no markdown, no text before or after.
Search for projects that are publicly announced or in planning stages.
Be thorough - find projects from official planning sources and news.
All text should be in Hebrew.
If you can't find any new complexes, return an empty array for discovered_complexes.
Remember: Pinuy-Binuy requires minimum 24 existing units and 70+ planned units.`;

async function discoverInCity(city) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error('PERPLEXITY_API_KEY not set');

  const axios = require('axios');
  
  // Get existing complex names for this city to avoid rediscovery
  const normalizedCity = normalizeCity(city);
  let existingNames = [];
  try {
    const existing = await pool.query(
      'SELECT name FROM complexes WHERE LOWER(TRIM(city)) = LOWER(TRIM($1)) ORDER BY name',
      [normalizedCity]
    );
    existingNames = existing.rows.map(r => r.name);
    logger.debug(`${city}: ${existingNames.length} existing complexes to exclude`);
  } catch (e) {
    logger.warn(`Failed to get existing names for ${city}: ${e.message}`);
  }
  
  const prompt = buildDiscoveryPrompt(city, existingNames);

  try {
    const response = await axios.post('https://api.perplexity.ai/chat/completions', {
      model: 'sonar',
      messages: [
        { role: 'system', content: DISCOVERY_SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 4000
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 60000
    });

    const content = response.data.choices[0].message.content;
    return parseDiscoveryResponse(content);
  } catch (err) {
    logger.error(`Discovery failed for ${city}`, { error: err.message });
    return null;
  }
}

function parseDiscoveryResponse(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[1].trim()); } catch (e2) {}
    }
    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try { return JSON.parse(objectMatch[0]); } catch (e3) {}
    }
    return null;
  }
}

// Strip common Hebrew prefixes to get core name for fuzzy matching
function stripPrefixes(name) {
  const prefixes = ['מתחם', 'פינוי בינוי', 'שכונת', 'שכונה', 'רחוב', 'שדרות', 'דרך', 'מיזם', 'מותג עירוני', 'מתחמי'];
  let stripped = name.trim();
  for (const p of prefixes) {
    if (stripped.startsWith(p + ' ')) {
      stripped = stripped.slice(p.length).trim();
    }
  }
  // Also strip trailing parenthetical info like "(10 מתחמים)"
  stripped = stripped.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return stripped;
}

async function complexExists(name, city) {
  city = normalizeCity(city);
  const coreName = stripPrefixes(name);
  
  // Get all complexes in this city for comparison
  const result = await pool.query(
    `SELECT id, name FROM complexes 
     WHERE LOWER(TRIM(city)) = LOWER(TRIM($1))`,
    [city]
  );
  
  const lowerName = name.toLowerCase().trim();
  const lowerCore = coreName.toLowerCase().trim();
  
  for (const row of result.rows) {
    const existingName = row.name.toLowerCase().trim();
    const existingCore = stripPrefixes(row.name).toLowerCase().trim();
    
    // Exact match
    if (existingName === lowerName) return true;
    
    // Core name match (ignoring prefixes like מתחם, פינוי בינוי, etc.)
    if (existingCore === lowerCore && lowerCore.length >= 3) return true;
    
    // Bidirectional substring: new contains old OR old contains new
    if (lowerCore.length >= 3 && existingCore.length >= 3) {
      if (existingCore.includes(lowerCore) || lowerCore.includes(existingCore)) return true;
    }
    
    // Full name substring check (at least 4 chars to avoid false positives)
    if (lowerName.length >= 4 && existingName.length >= 4) {
      if (existingName.includes(lowerName) || lowerName.includes(existingName)) return true;
    }
  }
  
  return false;
}

async function addNewComplex(complex, city, source = 'discovery') {
  city = normalizeCity(city);
  
  const statusMap = {
    'הוכרז': 'declared',
    'בתכנון': 'planning',
    'להפקדה': 'pre_deposit',
    'הופקד': 'deposited',
    'הופקדה': 'deposited',
    'אושר': 'approved',
    'אושרה': 'approved',
    'בביצוע': 'construction',
    'היתר': 'permit'
  };

  const status = statusMap[complex.status] || 'declared';

  try {
    const result = await pool.query(
      `INSERT INTO complexes 
       (name, city, addresses, existing_units, planned_units, developer, 
        status, plan_number, discovery_source, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (name, city) DO NOTHING
       RETURNING id`,
      [
        complex.name, city,
        complex.addresses || null,
        complex.existing_units || null,
        complex.planned_units || null,
        complex.developer || null,
        status,
        complex.plan_number || null,
        source
      ]
    );

    if (result.rows.length === 0) {
      logger.debug(`Complex already exists (ON CONFLICT): ${complex.name} in ${city}`);
      return null;
    }
    return result.rows[0].id;
  } catch (err) {
    if (err.code === '23505') {
      logger.debug(`Complex already exists: ${complex.name} in ${city}`);
      return null;
    }
    throw err;
  }
}

async function createDiscoveryAlert(complexId, complex, city) {
  try {
    await pool.query(
      `INSERT INTO alerts 
       (complex_id, alert_type, severity, title, message, data)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        complexId, 'new_complex', 'high',
        `🆕 מתחם חדש התגלה: ${complex.name} (${city})`,
        `נמצא מתחם חדש: ${complex.existing_units || '?'} יח"ד קיימות, ` +
        `${complex.planned_units || '?'} יח"ד מתוכננות. ` +
        `סטטוס: ${complex.status}. יזם: ${complex.developer || 'לא ידוע'}.`,
        JSON.stringify({
          addresses: complex.addresses,
          source: complex.source,
          plan_number: complex.plan_number
        })
      ]
    );
  } catch (err) {
    logger.warn('Failed to create discovery alert', { error: err.message });
  }
}

async function discoverDaily() {
  const cities = getTodaysCities();
  logger.info(`Daily discovery: scanning ${cities.length} cities today: ${cities.join(', ')}`);

  const results = {
    cities_scanned: 0, total_discovered: 0,
    new_added: 0, already_existed: 0,
    cities: cities, details: []
  };

  for (let i = 0; i < cities.length; i++) {
    const city = cities[i];
    logger.info(`[${i + 1}/${cities.length}] Discovering in ${city}...`);

    try {
      const discovered = await discoverInCity(city);
      results.cities_scanned++;

      if (!discovered || !discovered.discovered_complexes) {
        results.details.push({ city, found: 0, added: 0, error: null });
        continue;
      }

      const complexes = discovered.discovered_complexes;
      let added = 0, existed = 0;

      for (const complex of complexes) {
        if (complex.existing_units && complex.existing_units < MIN_HOUSING_UNITS) continue;
        
        // Fuzzy duplicate check before insertion
        const alreadyExists = await complexExists(complex.name, city);
        if (alreadyExists) {
          existed++;
          continue;
        }
        
        const newId = await addNewComplex(complex, city, 'discovery-daily');
        if (newId) {
          added++; results.total_discovered++; results.new_added++;
          await createDiscoveryAlert(newId, complex, city);
          logger.info(`✨ NEW: ${complex.name} (${city}) - ${complex.existing_units || '?'} units`);
          // Trigger full onboarding pipeline asynchronously
          const pipeline = getOnboardingPipeline();
          if (pipeline) {
            setImmediate(() => {
              pipeline.runOnboarding(newId).catch(err =>
                logger.error(`[Discovery] Onboarding failed for ${complex.name}: ${err.message}`)
              );
            });
          }
        } else { existed++; }
      }

      results.already_existed += existed;
      results.details.push({ city, found: complexes.length, added, existed, error: null });
    } catch (err) {
      logger.error(`Discovery error for ${city}`, { error: err.message });
      results.details.push({ city, found: 0, added: 0, error: err.message });
    }

    if (i < cities.length - 1) await new Promise(r => setTimeout(r, 4000));
  }

  logger.info('Daily discovery completed', { cities: results.cities_scanned, discovered: results.total_discovered, new: results.new_added });
  return results;
}

async function discoverAll(options = {}) {
  const { region = null, limit = null } = options;
  let cities = ALL_TARGET_CITIES;
  if (region && TARGET_REGIONS[region]) cities = TARGET_REGIONS[region];
  if (limit) cities = cities.slice(0, limit);

  logger.info(`Starting full discovery scan for ${cities.length} cities`);

  const results = {
    cities_scanned: 0, total_discovered: 0,
    new_added: 0, already_existed: 0, details: []
  };

  for (let i = 0; i < cities.length; i++) {
    const city = cities[i];
    logger.info(`[${i + 1}/${cities.length}] Discovering in ${city}...`);

    try {
      const discovered = await discoverInCity(city);
      results.cities_scanned++;

      if (!discovered || !discovered.discovered_complexes) {
        results.details.push({ city, found: 0, added: 0, error: null });
        continue;
      }

      const complexes = discovered.discovered_complexes;
      let added = 0, existed = 0;

      for (const complex of complexes) {
        if (complex.existing_units && complex.existing_units < MIN_HOUSING_UNITS) continue;
        
        // Fuzzy duplicate check before insertion
        const alreadyExists = await complexExists(complex.name, city);
        if (alreadyExists) {
          existed++;
          continue;
        }
        
        const newId = await addNewComplex(complex, city, 'discovery-full');
        if (newId) {
          added++; results.total_discovered++; results.new_added++;
          await createDiscoveryAlert(newId, complex, city);
          logger.info(`✨ NEW: ${complex.name} (${city}) - ${complex.existing_units || '?'} units`);
          // Trigger full onboarding pipeline asynchronously
          const pipeline = getOnboardingPipeline();
          if (pipeline) {
            setImmediate(() => {
              pipeline.runOnboarding(newId).catch(err =>
                logger.error(`[Discovery] Onboarding failed for ${complex.name}: ${err.message}`)
              );
            });
          }
        } else { existed++; }
      }

      results.already_existed += existed;
      results.details.push({ city, found: complexes.length, added, existed, error: null });
    } catch (err) {
      logger.error(`Discovery error for ${city}`, { error: err.message });
      results.details.push({ city, found: 0, added: 0, error: err.message });
    }

    if (i < cities.length - 1) await new Promise(r => setTimeout(r, 4000));
  }

  logger.info('Full discovery scan completed', { cities: results.cities_scanned, discovered: results.total_discovered, new: results.new_added });
  return results;
}

async function discoverRegion(regionName) {
  if (!TARGET_REGIONS[regionName]) {
    throw new Error(`Unknown region: ${regionName}. Available: ${Object.keys(TARGET_REGIONS).join(', ')}`);
  }
  return discoverAll({ region: regionName });
}

module.exports = {
  discoverAll,
  discoverDaily,
  discoverInCity,
  discoverRegion,
  addNewComplex,
  complexExists,
  stripPrefixes,
  normalizeCity,
  getTodaysCities,
  TARGET_REGIONS,
  ALL_TARGET_CITIES,
  CITY_NORMALIZATION,
  MIN_HOUSING_UNITS
};
