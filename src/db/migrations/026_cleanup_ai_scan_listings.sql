-- Migration 026: deactivate existing ai_scan listings without contact info (Day 10).
--
-- claudeOrchestrator.js was creating listings with source='ai_scan' but the
-- AI prompt didn't ask for phone or URL, and the INSERT didn't save them
-- either. Result: ~13 ai_scan listings in production with no phone AND
-- no URL — uncontactable.
--
-- Going forward (this PR), the prompt asks for phone+url and the INSERT
-- saves them; processListingFromAI also skips listings missing both.
--
-- This migration deactivates the existing uncontactable rows. Soft delete
-- so they're easy to reactivate if AI scan re-finds them with better data.

UPDATE listings
SET is_active = FALSE,
    updated_at = NOW()
WHERE source = 'ai_scan'
  AND is_active = TRUE
  AND (phone IS NULL OR phone = '')
  AND (url IS NULL OR url = '');
