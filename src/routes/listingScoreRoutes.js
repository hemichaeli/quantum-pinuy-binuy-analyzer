// listingScoreRoutes.js
// Additive, listing-level opportunity feed. Does NOT touch the legacy
// compound-level opportunities.json / fetchTopMispriced / benchmarkService.
//
//   POST /api/listing-scores/run        -> rescore all eligible listings
//   POST /api/listing-scores/run/:id    -> rescore a single listing
//   GET  /api/listing-scores/top?limit=20 -> ranked scorable listings
//   GET  /api/listing-scores/coverage   -> data-coverage diagnostics

const express = require('express');
const router = express.Router();
const { logger } = require('../services/logger');
const {
  scoreAllListings,
  scoreListing,
  getTopListings,
  getCoverage,
} = require('../services/listingScoreService');

// Rescore every eligible listing.
router.post('/run', async (req, res) => {
  try {
    const result = await scoreAllListings();
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('[ListingScore] run failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Rescore a single listing by id.
router.post('/run/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, error: 'invalid id' });
    const row = await scoreListing(id);
    if (!row) return res.status(404).json({ success: false, error: 'listing not eligible or not found' });
    res.json({ success: true, listing: row });
  } catch (err) {
    logger.error('[ListingScore] run/:id failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Ranked feed of scorable listings.
router.get('/top', async (req, res) => {
  try {
    const limit = req.query.limit || 20;
    const listings = await getTopListings(limit);
    res.json({ success: true, count: listings.length, listings });
  } catch (err) {
    logger.error('[ListingScore] top failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Data-coverage diagnostics (how many listings are scorable vs lacking comps).
router.get('/coverage', async (req, res) => {
  try {
    const coverage = await getCoverage();
    res.json({ success: true, coverage });
  } catch (err) {
    logger.error('[ListingScore] coverage failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
