-- Migration 028: lead archive support (Day 10).
--
-- Adds soft-delete (is_archived + archived_at) on website_leads so the
-- operator can hide test/dead leads from the main view without losing
-- history. Hard delete still possible via dedicated bulk-delete endpoint.

ALTER TABLE website_leads
  ADD COLUMN IF NOT EXISTS is_archived  BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS archived_at  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_website_leads_archived
  ON website_leads (is_archived, created_at DESC);
