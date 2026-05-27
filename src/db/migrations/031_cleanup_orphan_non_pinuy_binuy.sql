-- Migration 031: deactivate ALL active listings that aren't in pinuy-binuy
-- complexes, regardless of source.
--
-- Why: every current scraper (yad2, yad1, dira, winwin, homeless, banknadlan,
-- komo) now calls findMatchingComplex() and skips listings that don't match a
-- pinuy-binuy complex (see service files; komo was the last to be retrofitted
-- in migration 030). But historical rows from before those filters were added
-- still pollute the active set with complex_id = NULL — irrelevant for
-- pinuy-binuy lead generation, distorting morning-report counts, and wasting
-- enrichment / outreach budget if they slip through downstream jobs.
--
-- This sweeps the whole listings table in one shot. Soft-delete only
-- (is_active=FALSE) so we can revive rows if a future TARGET_REGIONS
-- expansion brings their complex into scope, or if a complex-matching bug
-- caused a false negative. Same pattern as migrations 026 / 030.
--
-- Idempotent: re-running this changes nothing because rows already flipped
-- to is_active=FALSE are excluded by the WHERE clause.

UPDATE listings
   SET is_active = FALSE,
       updated_at = NOW()
 WHERE is_active = TRUE
   AND complex_id IS NULL;
