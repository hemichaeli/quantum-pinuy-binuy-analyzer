-- Migration 024: clean up yad1 listings with non-yad1 URLs (Day 10).
--
-- yad1.co.il is currently returning 404 — the platform appears defunct.
-- The yad1Scraper falls back to Perplexity, which returns yad2.co.il
-- search-page URLs as best-effort guesses. These leaked into the listings
-- table as source='yad1' with url='https://www.yad2.co.il/...'.
--
-- Live count before this migration: ~101 of 108 yad1 listings have a
-- yad2.co.il URL instead of a yad1.co.il URL.
--
-- Action: NULL out the misleading URLs. Listings stay active so the
-- operator can still see them and contact via WhatsApp if a phone
-- exists; the modal's URL-host validation now correctly degrades
-- platform_chat for these cases.

UPDATE listings
SET url = NULL,
    updated_at = NOW()
WHERE source = 'yad1'
  AND url IS NOT NULL
  AND url NOT ILIKE 'https://%yad1.co.il/%'
  AND url NOT ILIKE 'http://%yad1.co.il/%';

-- Deactivate yad1 listings that now have no usable contact mechanism
-- (no phone AND no URL). They'd just clutter the dashboard with manual-only
-- fallback rows and the operator can't reach them anyway.
UPDATE listings
SET is_active = FALSE,
    updated_at = NOW()
WHERE source = 'yad1'
  AND is_active = TRUE
  AND (phone IS NULL OR phone = '')
  AND (url IS NULL OR url = '');
