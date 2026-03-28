'use strict';
/**
 * enrichMissingAddresses.js
 *
 * Fills in the `addresses` field for complexes that currently have none.
 * Without addresses, complexMatcher can never match listings to these complexes.
 *
 * Strategy:
 *   1. Query DB for complexes WHERE addresses IS NULL AND address IS NULL
 *   2. For each complex, ask Perplexity Sonar:
 *      "What are the street addresses of the pinuy-binuy complex [name] in [city]?"
 *   3. Parse the response and UPDATE complexes SET addresses = '...' WHERE id = ...
 *
 * Can be triggered via:
 *   - POST /api/scan/enrich-missing-addresses  (from scan.js route)
 *   - node src/services/enrichMissingAddresses.js  (standalone)
 *
 * Cost: ~1 Perplexity API call per complex. With 100 complexes ≈ $0.10-0.20.
 */

const axios = require('axios');
const pool  = require('../db/pool');
const { logger } = require('./logger');

const PERPLEXITY_API = 'https://api.perplexity.ai/chat/completions';
const DELAY_MS       = 1200;   // stay well under Perplexity rate limits
const BATCH_SIZE     = 5;

// ─── Perplexity query ────────────────────────────────────────────────────────

async function fetchAddressesFromPerplexity(complex) {
  const apiKey = process.env.SONAR_API_KEY || process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    logger.warn('[EnrichAddr] No Perplexity API key — skipping');
    return null;
  }

  const prompt = `מהן הכתובות המדויקות של מתחם פינוי-בינוי "${complex.name}" בעיר ${complex.city}, ישראל?
אני צריך רשימת רחובות ומספרים שנמצאים בתוך המתחם.
החזר JSON בלבד בפורמט:
{
  "addresses": ["רחוב א 1-5", "רחוב ב 10-20"],
  "neighborhood": "שם השכונה אם ידוע"
}
אם לא ידוע — החזר {"addresses": [], "neighborhood": null}`;

  try {
    const res = await axios.post(
      PERPLEXITY_API,
      {
        model: 'sonar',
        messages: [
          {
            role: 'system',
            content: 'Return ONLY valid JSON. No markdown, no explanations.'
          },
          { role: 'user', content: prompt }
        ],
        max_tokens: 500,
        temperature: 0.1
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 25000
      }
    );

    const text = res.data?.choices?.[0]?.message?.content || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    return parsed;
  } catch (err) {
    logger.warn(`[EnrichAddr] Perplexity failed for ${complex.name}: ${err.message}`);
    return null;
  }
}

// ─── DB update ───────────────────────────────────────────────────────────────

async function updateComplexAddresses(complexId, data) {
  if (!data) return false;

  const { addresses = [], neighborhood } = data;
  if (!addresses.length && !neighborhood) return false;

  const addressStr = addresses.join('; ') || null;

  const setClauses = [];
  const values     = [];
  let   idx        = 1;

  if (addressStr) {
    setClauses.push(`addresses = $${idx++}`);
    values.push(addressStr);
  }
  if (neighborhood) {
    // Only set neighborhood if it's currently empty
    setClauses.push(`neighborhood = COALESCE(neighborhood, $${idx++})`);
    values.push(neighborhood);
  }

  if (!setClauses.length) return false;

  values.push(complexId);
  await pool.query(
    `UPDATE complexes SET ${setClauses.join(', ')} WHERE id = $${idx}`,
    values
  );
  return true;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function enrichMissingAddresses(options = {}) {
  const { limit = 120, dryRun = false } = options;

  // Load complexes that have neither addresses nor address
  const { rows: complexes } = await pool.query(
    `SELECT id, name, city, neighborhood
     FROM complexes
     WHERE (addresses IS NULL OR TRIM(addresses) = '')
       AND (address   IS NULL OR TRIM(address)   = '')
     ORDER BY iai_score DESC NULLS LAST
     LIMIT $1`,
    [limit]
  );

  if (!complexes.length) {
    logger.info('[EnrichAddr] No complexes missing addresses — nothing to do');
    return { total: 0, enriched: 0, skipped: 0 };
  }

  logger.info(`[EnrichAddr] Found ${complexes.length} complexes missing addresses`);

  let enriched = 0;
  let skipped  = 0;

  // Process in small batches (sequential to avoid rate-limit)
  for (let i = 0; i < complexes.length; i++) {
    const complex = complexes[i];
    logger.debug(`[EnrichAddr] [${i + 1}/${complexes.length}] ${complex.name} (${complex.city})`);

    const data = await fetchAddressesFromPerplexity(complex);

    if (!data || (!data.addresses?.length && !data.neighborhood)) {
      logger.debug(`[EnrichAddr] No data returned for ${complex.name}`);
      skipped++;
    } else {
      if (!dryRun) {
        const updated = await updateComplexAddresses(complex.id, data);
        if (updated) {
          logger.info(
            `[EnrichAddr] ✅ ${complex.name} → ${data.addresses?.join('; ') || data.neighborhood}`
          );
          enriched++;
        } else {
          skipped++;
        }
      } else {
        logger.info(
          `[EnrichAddr] [DRY RUN] ${complex.name} → ${JSON.stringify(data)}`
        );
        enriched++;
      }
    }

    // Rate-limit delay (skip after last item)
    if (i < complexes.length - 1) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  logger.info(
    `[EnrichAddr] Done: ${enriched} enriched, ${skipped} skipped (of ${complexes.length})`
  );

  return { total: complexes.length, enriched, skipped };
}

module.exports = { enrichMissingAddresses };

// ─── Standalone execution ────────────────────────────────────────────────────
if (require.main === module) {
  enrichMissingAddresses({ limit: 120 })
    .then(r => { console.log('Result:', r); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
}
