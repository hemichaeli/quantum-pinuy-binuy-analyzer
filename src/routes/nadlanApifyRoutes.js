// Routes for the Apify-based nadlan transaction ingestion (grows per-compound comp coverage).
// FIRST use POST /probe?city=<hebrew> to confirm the actor output field mapping, THEN
// POST /ingest to bulk-ingest. Requires APIFY_API_TOKEN and available Apify quota.
const express = require('express');
const router = express.Router();
const svc = require('../services/nadlanApifyService');

// Probe the actor output shape for one city (cheap: a few items).
router.post('/probe', async (req, res) => {
  const city = req.query.city || req.body?.city || 'רעננה';
  try { res.json({ success: true, city, ...(await svc.probeShape(city, Number(req.query.max) || 8)) }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Geocode compounds (with active listings, no lat/lng) for a city. Nominatim, ~1/sec.
router.post('/geocode', async (req, res) => {
  const city = req.query.city || req.body?.city;
  if (!city) return res.status(400).json({ success: false, error: 'provide ?city=' });
  try { res.json({ success: true, ...(await svc.geocodeCompounds(city, { limit: Number(req.query.limit) || 150 })) }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Ingest deals for one or more cities. Body: { cities:["תל אביב",...], dealDateRange:"60", maxItems:800 }
router.post('/ingest', async (req, res) => {
  const cities = req.body?.cities || (req.query.city ? [req.query.city] : null);
  if (!cities || !cities.length) return res.status(400).json({ success: false, error: 'provide cities[] or ?city=' });
  const opts = {
    dealDateRange: req.body?.dealDateRange || '2',
    maxItems: Number(req.body?.maxItems) || 800,
    rooms: req.body?.rooms,
  };
  try { res.json({ success: true, ...(await svc.ingestCities(cities, opts)) }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
