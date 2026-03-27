/**
 * newsletterService.js
 *
 * Manages newsletter subscriptions and sends property alert emails
 * to public subscribers based on their saved preferences.
 *
 * Matching criteria:
 *  - cities (comma-separated, NULL = all)
 *  - price_min / price_max
 *  - min_discount_pct  (IAI discount %)
 *  - min_discount_nis  (IAI discount in NIS)
 *  - property_types    (comma-separated)
 *  - min_rooms / max_rooms
 *  - min_floor
 */

const pool   = require('../db/pool');
const axios  = require('axios');
const crypto = require('crypto');
const { logger } = require('./logger');

const RESEND_URL  = 'https://api.resend.com/emails';
const FROM_EMAIL  = process.env.EMAIL_FROM || 'QUANTUM נדל"ן <alerts@quantum-nadlan.co.il>';
const BASE_URL    = process.env.BASE_URL   || 'https://pinuy-binuy-analyzer-production.up.railway.app';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function csvToArray(str) {
  if (!str) return [];
  return str.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Does a listing match a subscriber's preferences?
 */
function listingMatchesSubscriber(listing, sub) {
  // City filter
  const cities = csvToArray(sub.cities);
  if (cities.length > 0) {
    const listingCity = (listing.city || '').trim();
    if (!cities.some(c => c === listingCity)) return false;
  }

  // Price range
  const price = Number(listing.asking_price) || 0;
  if (sub.price_min && price < sub.price_min) return false;
  if (sub.price_max && price > sub.price_max) return false;

  // Discount % (IAI)
  if (sub.min_discount_pct) {
    const disc = Number(listing.discount_pct) || Number(listing.iai_discount_pct) || 0;
    if (disc < sub.min_discount_pct) return false;
  }

  // Discount NIS
  if (sub.min_discount_nis) {
    const discNis = Number(listing.discount_nis) || Number(listing.iai_discount_nis) || 0;
    if (discNis < sub.min_discount_nis) return false;
  }

  // Property types
  const types = csvToArray(sub.property_types);
  if (types.length > 0) {
    const lType = (listing.property_type || listing.asset_type || '').toLowerCase();
    if (!types.some(t => lType.includes(t.toLowerCase()))) return false;
  }

  // Rooms
  const rooms = Number(listing.rooms) || 0;
  if (sub.min_rooms && rooms < sub.min_rooms) return false;
  if (sub.max_rooms && rooms > sub.max_rooms) return false;

  // Floor
  const floor = Number(listing.floor) || 0;
  if (sub.min_floor && floor < sub.min_floor) return false;

  return true;
}

// ─────────────────────────────────────────────
// Email templates
// ─────────────────────────────────────────────
function buildConfirmationEmail(subscriber) {
  const link = `${BASE_URL}/api/newsletter/confirm/${subscriber.confirm_token}`;
  return `
<!DOCTYPE html>
<html dir="rtl" lang="he">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;direction:rtl">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:40px 20px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
        <tr><td style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);padding:40px;text-align:center">
          <h1 style="color:#e94560;margin:0;font-size:28px;letter-spacing:2px">QUANTUM</h1>
          <p style="color:#a0aec0;margin:8px 0 0;font-size:14px">מערכת ניתוח נדל"ן</p>
        </td></tr>
        <tr><td style="padding:40px">
          <h2 style="color:#1a1a2e;margin:0 0 16px">שלום ${subscriber.full_name || ''}!</h2>
          <p style="color:#4a5568;line-height:1.7;margin:0 0 24px">
            תודה שנרשמת לעדכוני נדל"ן מ-QUANTUM.<br>
            כדי להפעיל את ההתראות שלך, אנא אשר את כתובת האימייל שלך:
          </p>
          <div style="text-align:center;margin:32px 0">
            <a href="${link}" style="background:#e94560;color:#ffffff;text-decoration:none;padding:16px 40px;border-radius:8px;font-size:16px;font-weight:bold;display:inline-block">
              ✅ אישור הרשמה
            </a>
          </div>
          <p style="color:#a0aec0;font-size:12px;margin:24px 0 0;text-align:center">
            הקישור תקף ל-48 שעות. אם לא נרשמת, ניתן להתעלם מהודעה זו.
          </p>
        </td></tr>
        <tr><td style="background:#f7fafc;padding:20px;text-align:center;border-top:1px solid #e2e8f0">
          <p style="color:#a0aec0;font-size:11px;margin:0">
            QUANTUM נדל"ן | מערכת ניתוח שוק מתקדמת
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildAlertEmail(subscriber, listings) {
  const unsubLink = `${BASE_URL}/api/newsletter/unsubscribe/${subscriber.unsubscribe_token}`;

  const listingsHtml = listings.map(l => {
    const price    = l.asking_price ? `₪${Number(l.asking_price).toLocaleString('he-IL')}` : 'לא צוין';
    const discount = l.discount_pct ? `<span style="color:#e94560;font-weight:bold">-${Number(l.discount_pct).toFixed(1)}%</span>` : '';
    const discNis  = l.discount_nis ? `<span style="color:#e94560"> (חיסכון ₪${Number(l.discount_nis).toLocaleString('he-IL')})</span>` : '';
    const rooms    = l.rooms ? `${l.rooms} חד'` : '';
    const floor    = l.floor != null ? `קומה ${l.floor}` : '';
    const url      = l.url || '#';

    return `
    <tr>
      <td style="padding:20px;border-bottom:1px solid #e2e8f0">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td>
              <p style="margin:0 0 4px;font-size:16px;font-weight:bold;color:#1a1a2e">
                ${l.address || ''}, ${l.city || ''}
              </p>
              <p style="margin:0 0 8px;color:#718096;font-size:13px">
                ${[rooms, floor, l.property_type || ''].filter(Boolean).join(' | ')}
              </p>
              <p style="margin:0;font-size:18px;font-weight:bold;color:#2d3748">
                ${price} ${discount}${discNis}
              </p>
            </td>
            <td style="text-align:left;vertical-align:middle;padding-right:16px">
              <a href="${url}" style="background:#e94560;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:13px;white-space:nowrap">
                לצפייה במודעה
              </a>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
  }).join('');

  return `
<!DOCTYPE html>
<html dir="rtl" lang="he">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;direction:rtl">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:40px 20px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
        <tr><td style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);padding:40px;text-align:center">
          <h1 style="color:#e94560;margin:0;font-size:28px;letter-spacing:2px">QUANTUM</h1>
          <p style="color:#a0aec0;margin:8px 0 0;font-size:14px">נמצאו ${listings.length} עסקאות חדשות שמתאימות לחיפוש שלך</p>
        </td></tr>
        <tr><td style="padding:24px 0">
          <table width="100%" cellpadding="0" cellspacing="0">
            ${listingsHtml}
          </table>
        </td></tr>
        <tr><td style="background:#f7fafc;padding:24px;text-align:center;border-top:1px solid #e2e8f0">
          <p style="color:#718096;font-size:12px;margin:0 0 8px">
            קיבלת אימייל זה כי נרשמת לעדכוני נדל"ן מ-QUANTUM
          </p>
          <a href="${unsubLink}" style="color:#a0aec0;font-size:11px">ביטול הרשמה</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─────────────────────────────────────────────
// Core functions
// ─────────────────────────────────────────────

/**
 * Create a new subscriber, send confirmation email.
 */
async function createSubscriber(data) {
  const {
    email, full_name, phone,
    cities, price_min, price_max,
    min_discount_pct, min_discount_nis,
    property_types, min_rooms, max_rooms,
    min_floor, frequency = 'immediate'
  } = data;

  if (!email) throw new Error('Email is required');

  const confirmToken     = generateToken();
  const unsubscribeToken = generateToken();

  const { rows } = await pool.query(`
    INSERT INTO newsletter_subscribers
      (email, full_name, phone, cities, price_min, price_max,
       min_discount_pct, min_discount_nis, property_types,
       min_rooms, max_rooms, min_floor, frequency,
       confirm_token, unsubscribe_token)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT (email) DO UPDATE SET
      full_name = EXCLUDED.full_name,
      phone = EXCLUDED.phone,
      cities = EXCLUDED.cities,
      price_min = EXCLUDED.price_min,
      price_max = EXCLUDED.price_max,
      min_discount_pct = EXCLUDED.min_discount_pct,
      min_discount_nis = EXCLUDED.min_discount_nis,
      property_types = EXCLUDED.property_types,
      min_rooms = EXCLUDED.min_rooms,
      max_rooms = EXCLUDED.max_rooms,
      min_floor = EXCLUDED.min_floor,
      frequency = EXCLUDED.frequency,
      confirm_token = EXCLUDED.confirm_token,
      updated_at = NOW()
    RETURNING *
  `, [
    email.toLowerCase().trim(), full_name, phone,
    cities, price_min || null, price_max || null,
    min_discount_pct || null, min_discount_nis || null,
    property_types, min_rooms || null, max_rooms || null,
    min_floor || null, frequency,
    confirmToken, unsubscribeToken
  ]);

  const subscriber = rows[0];

  // Send confirmation email
  await sendEmail(
    subscriber.email,
    'אשר את הרשמתך ל-QUANTUM נדל"ן',
    buildConfirmationEmail(subscriber)
  );

  logger.info(`[Newsletter] New subscriber: ${subscriber.email}`);
  return subscriber;
}

/**
 * Confirm subscription via token.
 */
async function confirmSubscriber(token) {
  const { rows } = await pool.query(`
    UPDATE newsletter_subscribers
    SET confirmed = TRUE, confirm_token = NULL, updated_at = NOW()
    WHERE confirm_token = $1
    RETURNING *
  `, [token]);

  if (rows.length === 0) throw new Error('Invalid or expired confirmation token');
  logger.info(`[Newsletter] Confirmed: ${rows[0].email}`);
  return rows[0];
}

/**
 * Unsubscribe via token.
 */
async function unsubscribeByToken(token) {
  const { rows } = await pool.query(`
    UPDATE newsletter_subscribers
    SET is_active = FALSE, updated_at = NOW()
    WHERE unsubscribe_token = $1
    RETURNING email
  `, [token]);

  if (rows.length === 0) throw new Error('Invalid unsubscribe token');
  logger.info(`[Newsletter] Unsubscribed: ${rows[0].email}`);
  return rows[0];
}

/**
 * Send email via Resend.
 */
async function sendEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.warn('[Newsletter] RESEND_API_KEY not set — skipping email');
    return;
  }
  await axios.post(RESEND_URL, { from: FROM_EMAIL, to, subject, html }, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    timeout: 15000
  });
}

/**
 * Match new listings against all active subscribers and send alerts.
 * Called after each scrape run.
 */
async function dispatchAlerts(newListingIds = []) {
  if (!newListingIds.length) return { dispatched: 0, emails_sent: 0 };

  // Fetch the new listings with all relevant fields
  const { rows: listings } = await pool.query(`
    SELECT l.id, l.address, l.city, l.asking_price, l.rooms, l.floor,
           l.property_type, l.url, l.source,
           c.iai_price,
           CASE WHEN c.iai_price > 0 AND l.asking_price > 0
                THEN ROUND(((c.iai_price - l.asking_price) / c.iai_price::numeric) * 100, 2)
                ELSE 0 END AS discount_pct,
           CASE WHEN c.iai_price > 0 AND l.asking_price > 0
                THEN (c.iai_price - l.asking_price)
                ELSE 0 END AS discount_nis
    FROM listings l
    LEFT JOIN complexes c ON l.complex_id = c.id
    WHERE l.id = ANY($1::int[]) AND l.is_active = TRUE
  `, [newListingIds]);

  if (!listings.length) return { dispatched: 0, emails_sent: 0 };

  // Fetch all active confirmed subscribers
  const { rows: subscribers } = await pool.query(`
    SELECT * FROM newsletter_subscribers
    WHERE is_active = TRUE AND confirmed = TRUE
  `);

  let emailsSent = 0;

  for (const sub of subscribers) {
    // Filter listings that match this subscriber AND haven't been sent before
    const { rows: alreadySent } = await pool.query(`
      SELECT listing_id FROM newsletter_sent_listings
      WHERE subscriber_id = $1 AND listing_id = ANY($2::int[])
    `, [sub.id, newListingIds]);

    const sentIds = new Set(alreadySent.map(r => r.listing_id));
    const matched = listings.filter(l => !sentIds.has(l.id) && listingMatchesSubscriber(l, sub));

    if (!matched.length) continue;

    try {
      await sendEmail(
        sub.email,
        `🏠 נמצאו ${matched.length} עסקאות חדשות שמתאימות לחיפוש שלך`,
        buildAlertEmail(sub, matched)
      );

      // Record sent listings
      for (const l of matched) {
        await pool.query(`
          INSERT INTO newsletter_sent_listings (subscriber_id, listing_id)
          VALUES ($1, $2) ON CONFLICT DO NOTHING
        `, [sub.id, l.id]);
      }

      // Update subscriber stats
      await pool.query(`
        UPDATE newsletter_subscribers
        SET last_sent_at = NOW(), listings_sent = listings_sent + $1, updated_at = NOW()
        WHERE id = $2
      `, [matched.length, sub.id]);

      emailsSent++;
      logger.info(`[Newsletter] Sent ${matched.length} listings to ${sub.email}`);
    } catch (err) {
      logger.warn(`[Newsletter] Failed to send to ${sub.email}: ${err.message}`);
    }
  }

  return { dispatched: listings.length, emails_sent: emailsSent };
}

/**
 * Get all subscribers (for dashboard admin view).
 */
async function getSubscribers({ page = 1, limit = 50 } = {}) {
  const offset = (page - 1) * limit;
  const { rows } = await pool.query(`
    SELECT id, email, full_name, phone, cities, price_min, price_max,
           min_discount_pct, min_discount_nis, property_types,
           min_rooms, max_rooms, min_floor, frequency,
           is_active, confirmed, last_sent_at, listings_sent, created_at
    FROM newsletter_subscribers
    ORDER BY created_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);

  const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM newsletter_subscribers`);
  return { subscribers: rows, total: Number(countRows[0].count), page, limit };
}

module.exports = {
  createSubscriber,
  confirmSubscriber,
  unsubscribeByToken,
  dispatchAlerts,
  getSubscribers,
  listingMatchesSubscriber
};
