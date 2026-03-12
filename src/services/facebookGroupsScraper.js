/**
 * Facebook Groups Scraper — Perplexity Sonar
 *
 * Searches for pinuy-binuy property listings inside known Facebook groups
 * by querying Perplexity Sonar (which indexes public Facebook content).
 *
 * Strategy:
 *   1. Iterate over a curated list of known pinuy-binuy FB groups
 *   2. For each group → query Perplexity: "find recent listings in [group]"
 *   3. Parse JSON response → save to listings table (source='facebook_group')
 *   4. Auto-enrich new listings via adEnrichmentService
 *   5. Attempt to match each listing to a complex by address
 *
 * Why Perplexity instead of direct scraping:
 *   - No login required (public groups are indexed by Perplexity)
 *   - No rate-limit bans / CAPTCHA
 *   - Cost: ~$0.005 per group query (vs $0.50+ for Apify)
 */

const axios = require('axios');
const pool = require('../db/pool');
const { logger } = require('./logger');

const PERPLEXITY_API = 'https://api.perplexity.ai/chat/completions';
const BATCH_SIZE = 3;       // parallel group queries (keep low to avoid rate limits)
const DELAY_MS = 1500;      // delay between batches
const ENRICH_DELAY_MS = 500; // delay between enrichments

// ============================================================
// KNOWN PINUY-BINUY FACEBOOK GROUPS
// ============================================================
const FB_GROUPS = [
  // --- Dedicated pinuy-binuy / urban renewal groups ---
  {
    id: '374280285021074',
    name: 'פינוי בינוי | התחדשות עירונית',
    url: 'https://www.facebook.com/groups/374280285021074',
    cities: null // all cities
  },
  {
    id: '1920472201728581',
    name: 'עסקאות מכר נדל"ן - פינוי בינוי חתום 100%',
    url: 'https://www.facebook.com/groups/1920472201728581',
    cities: null
  },
  {
    id: '1281594211934148',
    name: 'יזמות תמ"א 38 פינוי בינוי / פרויקטים למכירה וקנייה',
    url: 'https://www.facebook.com/groups/1281594211934148',
    cities: null
  },
  {
    id: '715476131887115',
    name: 'כרישי נדל"ן - פינוי-בינוי | פריסייל | ערך',
    url: 'https://www.facebook.com/groups/715476131887115',
    cities: null
  },
  {
    id: '1778188822296883',
    name: 'פריסייל ישראל | דירות חדשות מקבלן | התחדשות עירונית',
    url: 'https://www.facebook.com/groups/1778188822296883',
    cities: null
  },
  {
    id: '1833093740933553',
    name: 'דירות למכירה / פינוי בינוי / מציאות נדל"ן',
    url: 'https://www.facebook.com/groups/1833093740933553',
    cities: null
  },
  // --- City-specific groups with pinuy-binuy listings ---
  {
    id: '1061700308964053',
    name: 'דירות למכירה פינוי בינוי בחולון',
    url: 'https://www.facebook.com/groups/1061700308964053',
    cities: ['חולון']
  },
  {
    id: '1374467126144215',
    name: 'דירות למכירה בתל אביב',
    url: 'https://www.facebook.com/groups/1374467126144215',
    cities: ['תל אביב', 'תל אביב יפו']
  },
  {
    id: '570765253256345',
    name: 'דירות למכירה בתל אביב (2)',
    url: 'https://www.facebook.com/groups/570765253256345',
    cities: ['תל אביב', 'תל אביב יפו']
  },
  {
    id: '525610664799369',
    name: 'הקבוצה של רמת גן גבעתיים',
    url: 'https://www.facebook.com/groups/525610664799369',
    cities: ['רמת גן', 'גבעתיים']
  },
  {
    id: '446273700552631',
    name: 'דירות למכירה בתל אביב - שפירא',
    url: 'https://www.facebook.com/groups/446273700552631',
    cities: ['תל אביב', 'תל אביב יפו']
  },
  // --- General real estate groups (filter by pinuy-binuy keywords) ---
  {
    id: '3303947573209051',
    name: 'פורום נפגעי התמ"א ופינוי בינוי',
    url: 'https://www.facebook.com/groups/3303947573209051',
    cities: null
  }
];

// ============================================================
// PHONE CLEANUP
// ============================================================
function cleanPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 12) return null;
  if (digits.startsWith('972')) return '0' + digits.slice(3);
  return digits.startsWith('0') ? digits : '0' + digits;
}

// ============================================================
// PERPLEXITY SEARCH: Find listings in a specific FB group
// ============================================================
async function searchGroup(group) {
  const apiKey = process.env.SONAR_API_KEY || process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    logger.warn('[FBGroups] No Perplexity API key found');
    return [];
  }

  const cityFilter = group.cities
    ? `בערים: ${group.cities.join(', ')}`
    : 'בכל הארץ';

  const prompt = `חפש מודעות נדל"ן למכירה בקבוצת הפייסבוק: "${group.name}" (${group.url})
אני מחפש דירות למכירה במתחמי פינוי-בינוי ${cityFilter}.

החזר JSON בלבד בפורמט הזה:
{
  "listings": [
    {
      "group_id": "${group.id}",
      "post_id": "מזהה הפוסט אם זמין",
      "url": "https://www.facebook.com/groups/${group.id}/posts/...",
      "address": "כתובת מדויקת כולל רחוב ומספר",
      "city": "שם העיר",
      "price": 1500000,
      "rooms": 3,
      "area_sqm": 75,
      "floor": 2,
      "phone": "0501234567",
      "contact_name": "שם המוכר",
      "description": "תיאור קצר של המודעה",
      "is_pinuy_binuy": true,
      "posted_date": "תאריך הפוסט אם זמין"
    }
  ]
}

חשוב:
- רק מודעות שמציינות במפורש "פינוי בינוי", "בניין חתום", "מתחם פינוי בינוי" או "התחדשות עירונית"
- לא לכלול מודעות שכירות, רק מכירה
- מחירים בשקלים
- אם אין מודעות רלוונטיות, החזר {"listings": []}`;

  try {
    const res = await axios.post(PERPLEXITY_API, {
      model: 'sonar',
      messages: [
        {
          role: 'system',
          content: 'Return ONLY valid JSON. No markdown, no explanations. Search the web for real estate listings in Facebook groups.'
        },
        { role: 'user', content: prompt }
      ],
      max_tokens: 3000,
      temperature: 0.1
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 25000
    });

    const content = res.data.choices?.[0]?.message?.content || '';
    return parseGroupListings(content, group);
  } catch (err) {
    logger.warn(`[FBGroups] Perplexity failed for group "${group.name}": ${err.message}`);
    return [];
  }
}

// ============================================================
// PARSE JSON RESPONSE
// ============================================================
function parseGroupListings(content, group) {
  try {
    const cleaned = content
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .trim();

    // Extract JSON object
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return [];

    const parsed = JSON.parse(match[0]);
    const listings = parsed.listings || [];

    if (!Array.isArray(listings)) return [];

    return listings
      .filter(l => l && l.is_pinuy_binuy !== false)
      .map(l => ({
        source: 'facebook_group',
        listing_id: l.post_id || l.url || `fb_${group.id}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
        url: l.url || group.url,
        address: l.address || null,
        city: l.city || (group.cities ? group.cities[0] : null),
        price: l.price ? parseFloat(l.price) : null,
        rooms: l.rooms ? parseFloat(l.rooms) : null,
        area_sqm: l.area_sqm ? parseFloat(l.area_sqm) : null,
        floor: l.floor ? parseInt(l.floor) : null,
        phone: cleanPhone(l.phone),
        contact_name: l.contact_name || null,
        description: (l.description || '').substring(0, 500),
        group_id: group.id,
        group_name: group.name
      }));
  } catch (err) {
    logger.warn(`[FBGroups] JSON parse error for group "${group.name}": ${err.message}`);
    return [];
  }
}

// ============================================================
// MATCH LISTING TO COMPLEX
// ============================================================
async function matchToComplex(listing) {
  if (!listing.address || !listing.city) return null;
  try {
    const { rows } = await pool.query(
      `SELECT id FROM complexes
       WHERE city ILIKE $1
         AND (
           addresses ILIKE $2
           OR name ILIKE $2
           OR neighborhood ILIKE $2
         )
       ORDER BY iai_score DESC NULLS LAST
       LIMIT 1`,
      [
        `%${listing.city}%`,
        `%${listing.address.split(' ').slice(0, 3).join('%')}%`
      ]
    );
    return rows[0]?.id || null;
  } catch (e) {
    return null;
  }
}

// ============================================================
// SAVE LISTING TO DB
// ============================================================
async function saveListing(listing) {
  try {
    const sourceId = listing.listing_id;
    if (!sourceId) return { status: 'skip' };

    const complexId = await matchToComplex(listing);

    const r = await pool.query(
      `INSERT INTO listings (
        source, source_listing_id, url, phone, contact_name,
        asking_price, rooms, area_sqm, floor,
        address, city, description_snippet,
        complex_id,
        first_seen, last_seen, is_active,
        created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
        CURRENT_DATE, CURRENT_DATE, TRUE, NOW(), NOW())
      ON CONFLICT (source, source_listing_id)
      WHERE source_listing_id IS NOT NULL
      DO UPDATE SET
        phone = COALESCE(EXCLUDED.phone, listings.phone),
        contact_name = COALESCE(EXCLUDED.contact_name, listings.contact_name),
        asking_price = COALESCE(EXCLUDED.asking_price, listings.asking_price),
        complex_id = COALESCE(listings.complex_id, EXCLUDED.complex_id),
        last_seen = CURRENT_DATE,
        updated_at = NOW()
      RETURNING id, (xmax = 0) as is_new`,
      [
        listing.source,
        sourceId,
        listing.url || null,
        listing.phone || null,
        listing.contact_name || null,
        listing.price || null,
        listing.rooms || null,
        listing.area_sqm || null,
        listing.floor || null,
        listing.address || null,
        listing.city || null,
        listing.description || '',
        complexId
      ]
    );

    if (r.rows[0]?.is_new) return { status: 'inserted', id: r.rows[0].id };
    return { status: 'updated', id: r.rows[0]?.id };
  } catch (err) {
    logger.warn(`[FBGroups] Save error for ${listing.listing_id}: ${err.message}`);
    return { status: 'error' };
  }
}

// ============================================================
// ENRICH NEW LISTINGS
// ============================================================
async function enrichNewListingIds(listingIds) {
  if (!listingIds || listingIds.length === 0) return;
  try {
    const { enrichListing } = require('./adEnrichmentService');
    logger.info(`[FBGroups] Enriching ${listingIds.length} new listings...`);
    for (const lid of listingIds) {
      try {
        const { rows } = await pool.query(
          `SELECT l.id, l.address, l.city, l.asking_price, l.area_sqm, l.rooms, l.floor,
                  l.description_snippet, l.source, l.phone,
                  COALESCE(c.iai_score, 0) as iai_score
           FROM listings l
           LEFT JOIN complexes c ON l.complex_id = c.id
           WHERE l.id = $1`, [lid]
        );
        if (rows[0]) {
          await enrichListing(rows[0]);
          await new Promise(r => setTimeout(r, ENRICH_DELAY_MS));
        }
      } catch (e) {
        logger.warn(`[FBGroups] Enrich error for listing ${lid}: ${e.message}`);
      }
    }
    logger.info(`[FBGroups] Enrichment complete for ${listingIds.length} listings`);
  } catch (e) {
    logger.warn(`[FBGroups] Enrichment batch error: ${e.message}`);
  }
}

// ============================================================
// SCAN SINGLE GROUP
// ============================================================
async function scanGroup(group) {
  logger.info(`[FBGroups] Scanning group: "${group.name}"`);
  const rawListings = await searchGroup(group);

  if (!rawListings || rawListings.length === 0) {
    logger.info(`[FBGroups] No listings found in "${group.name}"`);
    return { group_id: group.id, name: group.name, found: 0, inserted: 0, updated: 0, new_ids: [] };
  }

  logger.info(`[FBGroups] Found ${rawListings.length} listings in "${group.name}"`);

  let inserted = 0, updated = 0;
  const newIds = [];

  for (const listing of rawListings) {
    const result = await saveListing(listing);
    if (result.status === 'inserted') {
      inserted++;
      if (result.id) newIds.push(result.id);
    } else if (result.status === 'updated') {
      updated++;
    }
  }

  logger.info(`[FBGroups] "${group.name}": ${inserted} new, ${updated} updated`);

  // Trigger enrichment for new listings (async, non-blocking)
  if (newIds.length > 0) {
    setImmediate(() => enrichNewListingIds(newIds));
  }

  return {
    group_id: group.id,
    name: group.name,
    found: rawListings.length,
    inserted,
    updated,
    new_ids: newIds
  };
}

// ============================================================
// SCAN ALL GROUPS (main entry point)
// ============================================================
async function scanAll(options = {}) {
  const {
    groupIds = null,    // specific group IDs to scan (null = all)
    scanId = null       // scan_logs ID for progress updates
  } = options;

  const groups = groupIds
    ? FB_GROUPS.filter(g => groupIds.includes(g.id))
    : FB_GROUPS;

  if (groups.length === 0) {
    logger.info('[FBGroups] No groups to scan');
    return { total_groups: 0, total_inserted: 0, total_updated: 0, results: [] };
  }

  logger.info(`[FBGroups] Starting scan of ${groups.length} groups in batches of ${BATCH_SIZE}`);

  let totalInserted = 0, totalUpdated = 0;
  const results = [];

  for (let i = 0; i < groups.length; i += BATCH_SIZE) {
    const batch = groups.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(groups.length / BATCH_SIZE);

    logger.info(`[FBGroups] Batch ${batchNum}/${totalBatches} (groups ${i + 1}-${Math.min(i + BATCH_SIZE, groups.length)})`);

    const batchResults = await Promise.allSettled(
      batch.map(group => scanGroup(group))
    );

    for (const br of batchResults) {
      if (br.status === 'fulfilled') {
        totalInserted += br.value.inserted || 0;
        totalUpdated += br.value.updated || 0;
        results.push(br.value);
      } else {
        logger.error(`[FBGroups] Batch error: ${br.reason?.message}`);
        results.push({ error: br.reason?.message });
      }
    }

    // Update scan progress
    if (scanId) {
      try {
        await pool.query(
          `UPDATE scan_logs SET complexes_scanned = $1, new_listings = $2, summary = $3 WHERE id = $4`,
          [
            Math.min(i + BATCH_SIZE, groups.length),
            totalInserted,
            `FB Groups: batch ${batchNum}/${totalBatches}, ${totalInserted} new, ${totalUpdated} updated`,
            scanId
          ]
        );
      } catch (e) { /* ignore */ }
    }

    if (i + BATCH_SIZE < groups.length) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  const summary = {
    total_groups: groups.length,
    total_inserted: totalInserted,
    total_updated: totalUpdated,
    results
  };

  logger.info(`[FBGroups] Scan complete: ${totalInserted} inserted, ${totalUpdated} updated across ${groups.length} groups`);
  return summary;
}

module.exports = { scanAll, scanGroup, FB_GROUPS };
