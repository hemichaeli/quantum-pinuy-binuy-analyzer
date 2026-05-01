-- Migration 030: deactivate komo listings that aren't pinuy-binuy.
--
-- komoDirectScraper.js scrapes ALL apartment-for-sale listings from
-- komo.co.il for cities in TARGET_REGIONS, but unlike yad2/yad1/dira/
-- winwin/homeless/banknadlan it never filtered to pinuy-binuy complexes.
-- Result: the listings table is polluted with komo rows that have
-- complex_id = NULL — irrelevant to pinuy-binuy lead generation.
--
-- Going forward (this PR), saveListing() in komoDirectScraper calls
-- findMatchingComplex() and skips listings without a match, in parity
-- with the other scrapers.
--
-- This migration soft-deletes the existing polluting rows. Soft delete
-- (is_active=FALSE) so we can revive them if a future TARGET_REGIONS
-- expansion brings their complex into scope. Same pattern as 026.

UPDATE listings
SET is_active = FALSE,
    updated_at = NOW()
WHERE source = 'komo'
  AND is_active = TRUE
  AND complex_id IS NULL;
