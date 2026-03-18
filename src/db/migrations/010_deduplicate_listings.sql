-- Migration 010: Deduplicate listings and add UNIQUE index on (source, address, city)
-- This prevents the same property from being inserted multiple times from the same source

-- Step 1: Clean up existing duplicates by (source, source_listing_id)
-- Keep the row with the highest id (most recent) for each duplicate group
DO $$
BEGIN
  DELETE FROM listings
  WHERE id NOT IN (
    SELECT MAX(id)
    FROM listings
    WHERE source_listing_id IS NOT NULL AND source_listing_id != ''
    GROUP BY source, source_listing_id
  )
  AND source_listing_id IS NOT NULL
  AND source_listing_id != '';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Step 1 dedup by source_listing_id failed: %', SQLERRM;
END $$;

-- Step 2: Clean up duplicates by (source, LOWER(address), LOWER(city))
-- Keep the row with the highest id (most recent) for each duplicate group
DO $$
BEGIN
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
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Step 2 dedup by address+city failed: %', SQLERRM;
END $$;

-- Step 3: Add UNIQUE index on (source, LOWER(address), LOWER(city)) to prevent future duplicates
-- This is a partial index — only applies when address and city are non-empty
DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_source_address_city
    ON listings (source, LOWER(TRIM(address)), LOWER(TRIM(city)))
    WHERE address IS NOT NULL AND address != '' AND city IS NOT NULL AND city != '';
  RAISE NOTICE 'UNIQUE index idx_listings_source_address_city created successfully';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'UNIQUE index creation failed (may already exist or duplicates remain): %', SQLERRM;
END $$;
