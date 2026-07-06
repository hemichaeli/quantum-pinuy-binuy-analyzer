-- 037_complex_newbuild_columns.sql
-- 2026-07-06: newbuild valuation inputs for the future-uplift term A (phase 2).
--   newbuild_psm              = fair delivered price/sqm of a NEW unit in the complex
--   apartment_area_uplift_pct = expected floor-area gain on the replacement unit (%)
-- Populated pragmatically (v1) from complexes.city_avg_price_sqm * NEWBUILD_FACTOR
-- (env, default 1.35) in listingScoreService.populateNewbuildPsm().
-- TODO: replace newbuild_psm with a real new-build transaction comp when available.
-- Idempotent: safe to run on every boot.

ALTER TABLE complexes ADD COLUMN IF NOT EXISTS newbuild_psm NUMERIC;
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS apartment_area_uplift_pct NUMERIC DEFAULT 25;
