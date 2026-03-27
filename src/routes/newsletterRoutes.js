/**
 * newsletterRoutes.js
 *
 * Public-facing newsletter subscription API.
 *
 * POST   /api/newsletter/subscribe       - Create / update subscription
 * GET    /api/newsletter/confirm/:token  - Confirm email
 * GET    /api/newsletter/unsubscribe/:token - Unsubscribe
 * GET    /api/newsletter/subscribers     - Admin: list all subscribers
 * POST   /api/newsletter/dispatch-test   - Admin: manually trigger dispatch
 */

const express = require('express');
const router  = express.Router();
const {
  createSubscriber,
  confirmSubscriber,
  unsubscribeByToken,
  dispatchAlerts,
  getSubscribers
} = require('../services/newsletterService');
const { logger } = require('../services/logger');

// ── POST /api/newsletter/subscribe ──────────────────────────────────────────
router.post('/subscribe', async (req, res) => {
  try {
    const {
      email, full_name, phone,
      cities, price_min, price_max,
      min_discount_pct, min_discount_nis,
      property_types, min_rooms, max_rooms,
      min_floor, frequency
    } = req.body;

    if (!email) return res.status(400).json({ error: 'Email is required' });

    const subscriber = await createSubscriber({
      email, full_name, phone,
      cities: Array.isArray(cities) ? cities.join(',') : cities,
      price_min, price_max,
      min_discount_pct, min_discount_nis,
      property_types: Array.isArray(property_types) ? property_types.join(',') : property_types,
      min_rooms, max_rooms, min_floor, frequency
    });

    res.json({
      success: true,
      message: 'נשלח אימייל אישור לכתובת שלך. אנא אשר את הרשמתך.',
      id: subscriber.id
    });
  } catch (err) {
    logger.error('[Newsletter] Subscribe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/newsletter/confirm/:token ──────────────────────────────────────
router.get('/confirm/:token', async (req, res) => {
  try {
    const subscriber = await confirmSubscriber(req.params.token);
    // Redirect to a thank-you page (or return HTML)
    const BASE_URL = process.env.DASHBOARD_URL || 'https://quantum-dashboard-production.up.railway.app';
    res.redirect(`${BASE_URL}/newsletter-confirmed.html?email=${encodeURIComponent(subscriber.email)}`);
  } catch (err) {
    logger.error('[Newsletter] Confirm error:', err.message);
    res.status(400).send(`
      <html dir="rtl"><body style="font-family:Arial;text-align:center;padding:60px">
        <h2>❌ הקישור אינו תקף</h2>
        <p>ייתכן שפג תוקפו. אנא נסה להירשם מחדש.</p>
      </body></html>
    `);
  }
});

// ── GET /api/newsletter/unsubscribe/:token ───────────────────────────────────
router.get('/unsubscribe/:token', async (req, res) => {
  try {
    await unsubscribeByToken(req.params.token);
    res.send(`
      <html dir="rtl"><body style="font-family:Arial;text-align:center;padding:60px;background:#f5f5f5">
        <div style="background:#fff;border-radius:12px;padding:40px;max-width:400px;margin:auto;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
          <h2 style="color:#1a1a2e">✅ בוצע ביטול הרשמה</h2>
          <p style="color:#718096">הוסרת בהצלחה מרשימת העדכונים של QUANTUM נדל"ן.</p>
        </div>
      </body></html>
    `);
  } catch (err) {
    res.status(400).send(`
      <html dir="rtl"><body style="font-family:Arial;text-align:center;padding:60px">
        <h2>שגיאה בביטול הרשמה</h2><p>${err.message}</p>
      </body></html>
    `);
  }
});

// ── GET /api/newsletter/subscribers (admin) ──────────────────────────────────
router.get('/subscribers', async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const result = await getSubscribers({ page: Number(page), limit: Number(limit) });
    res.json(result);
  } catch (err) {
    logger.error('[Newsletter] List error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/newsletter/dispatch-test (admin) ───────────────────────────────
router.post('/dispatch-test', async (req, res) => {
  try {
    const { listing_ids } = req.body;
    if (!listing_ids || !listing_ids.length) {
      return res.status(400).json({ error: 'listing_ids array required' });
    }
    const result = await dispatchAlerts(listing_ids);
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('[Newsletter] Dispatch test error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
