-- Migration 025: retire all yad1 listings (Day 10).
--
-- yad1.co.il returns HTTP 404 — the platform is defunct. The yad1Scraper
-- was falling back to Perplexity, which generated fake listings with
-- yad2.co.il search-page URLs.
--
-- The scraper cron has been disabled in src/index.js (commented out).
-- This migration deactivates all existing yad1 listings so they stop
-- polluting the dashboard. Same listings (where real) are also being
-- scraped by the yad2 scraper, so coverage is unchanged.
--
-- Soft delete (is_active=FALSE) preserves history; if yad1 ever revives,
-- can be reactivated by setting is_active=TRUE.

UPDATE listings
SET is_active = FALSE,
    updated_at = NOW()
WHERE source = 'yad1'
  AND is_active = TRUE;
