-- Migration 010: Deduplicate listings and add UNIQUE index on (source, address, city)
-- This prevents the same property from being inserted multiple times from the same source

-- Step 1: Clean up existing duplicates by (source, source_listing_id)
-- Keep the row with the highest id (most recent) for each duplicate group
DELETE FROM listings
WHERE id NOT IN (
  SELECT MAX(id)
  FROM listings
  WHERE source_listing_id IS NOT NULL AND source_listing_id != ''
  GROUP BY source, source_listing_id
)
AND source_listing_id IS NOT NULL
AND source_listing_id != '';

-- Step 2: Clean up duplicates by (source, address, city) for listings without source_listing_id
-- or where source_listing_id differs but address+city+source is the same
-- Keep the row with the highest id (most recent)
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
-- This is a partial index — only applies when address and city are non-empty
CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_source_address_city
  ON listings (source, LOWER(TRIM(address)), LOWER(TRIM(city)))
  WHERE address IS NOT NULL AND address != '' AND city IS NOT NULL AND city != '';
