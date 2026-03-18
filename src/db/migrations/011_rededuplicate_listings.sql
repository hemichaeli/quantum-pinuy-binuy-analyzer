-- Migration 011: Re-run deduplication with correct logic
-- Migration 010 ran but only cleaned source_listing_id duplicates.
-- This migration cleans address+city duplicates and creates the UNIQUE index.

-- Step 1: Drop the old UNIQUE index if it exists (so we can recreate it cleanly)
DROP INDEX IF EXISTS idx_listings_source_address_city;

-- Step 2: Clean up duplicates by (source, LOWER(address), LOWER(city))
-- Keep the row with the highest id (most recent) for each duplicate group
DELETE FROM listings
WHERE id NOT IN (
  SELECT MAX(id)
  FROM listings
  WHERE address IS NOT NULL AND address != ''
    AND city IS NOT NULL AND city != ''
  GROUP BY source, LOWER(TRIM(address)), LOWER(TRIM(city))
)
AND address IS NOT NULL AND address != ''
AND city IS NOT NULL AND city != '';

-- Step 3: Add UNIQUE index on (source, LOWER(address), LOWER(city)) to prevent future duplicates
CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_source_address_city
  ON listings (source, LOWER(TRIM(address)), LOWER(TRIM(city)))
  WHERE address IS NOT NULL AND address != '' AND city IS NOT NULL AND city != '';
