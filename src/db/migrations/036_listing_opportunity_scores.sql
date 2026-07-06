-- 036_listing_opportunity_scores.sql
-- 2026-07-06: LISTING-LEVEL opportunity scorer (phase 1).
-- Replaces the compound-level premium_gap feed with a grounded, per-listing metric.
-- phase 1 stores discount_pct (B) = (P_fair_psm - P_ask_psm) / P_ask_psm * 100
-- where P_fair_psm is the median price/sqm of comparable units in the SAME complex.
-- Idempotent: safe to run on every boot.

ALTER TABLE listings ADD COLUMN IF NOT EXISTS p_fair_psm NUMERIC;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS discount_pct NUMERIC;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS future_uplift_pct NUMERIC;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS opportunity_pct NUMERIC;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS opportunity_ils NUMERIC;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS confidence NUMERIC;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS comps_used INT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS scored_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_listings_opportunity ON listings(opportunity_pct DESC NULLS LAST);
