-- 038_geo_linking_columns.sql
-- 2026-07-07: geo keys so real nadlan deals (which carry gush/helka + lat/lng but NO
-- street address) can be attached to a specific compound as comps.
--   complexes.lat/lng    = geocoded centroid of the compound's first address (Nominatim)
--   complexes.gush       = cadastral block adopted from the nearest deal (optional)
--   transactions.gush/helka/lat/lng/neighborhood = carried from the Apify actor output
-- Idempotent: safe to run on every boot.

ALTER TABLE complexes ADD COLUMN IF NOT EXISTS lat NUMERIC;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS lng NUMERIC;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS gush VARCHAR(20);
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS geocoded_at TIMESTAMP;

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS gush VARCHAR(20);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS helka VARCHAR(20);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS lat NUMERIC;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS lng NUMERIC;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS neighborhood VARCHAR(100);
