-- Migration 023: unique expression index for listings ON CONFLICT (Day 8.5).
--
-- Why:
--   yad2Scraper.js uses
--     INSERT INTO listings ... ON CONFLICT (source, LOWER(TRIM(address)), LOWER(TRIM(city)))
--   which requires a UNIQUE INDEX on those exact expressions. Without it
--   PostgreSQL raises 'no unique or exclusion constraint matching the
--   ON CONFLICT specification' and the listing is silently dropped.
--
-- Idempotency:
--   - CREATE UNIQUE INDEX IF NOT EXISTS guards re-runs.
--   - Pre-dedupe step removes existing duplicates that would otherwise
--     prevent the unique-index creation.

-- Pre-dedupe: keep the lowest id for each (source, LOWER(TRIM(address)), LOWER(TRIM(city))).
-- We deactivate (not delete) the duplicates to preserve referential integrity.
WITH dups AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY source, LOWER(TRIM(address)), LOWER(TRIM(city))
      ORDER BY id
    ) AS rn
  FROM listings
  WHERE address IS NOT NULL AND city IS NOT NULL AND source IS NOT NULL
)
UPDATE listings
SET is_active = FALSE,
    updated_at = NOW()
WHERE id IN (SELECT id FROM dups WHERE rn > 1)
  AND is_active = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_listings_source_address_city
  ON listings (source, LOWER(TRIM(address)), LOWER(TRIM(city)))
  WHERE address IS NOT NULL AND city IS NOT NULL AND source IS NOT NULL;
