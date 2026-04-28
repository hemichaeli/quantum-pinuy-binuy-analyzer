-- Migration 020: lead_matches table
-- Created 2026-04-28 for Match Engine v1.
-- Links investor leads (website_leads) to scored listings + complexes.
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS lead_matches (
  id              SERIAL PRIMARY KEY,
  lead_id         INT NOT NULL REFERENCES website_leads(id) ON DELETE CASCADE,
  listing_id      INT REFERENCES listings(id) ON DELETE CASCADE,
  complex_id      INT REFERENCES complexes(id) ON DELETE SET NULL,
  match_score     NUMERIC(5,2) NOT NULL,
  match_reasons   JSONB DEFAULT '[]'::jsonb,
  operator_status TEXT NOT NULL DEFAULT 'pending',
    -- operator_status values: pending | contacted | sent | dismissed | won | lost
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (lead_id, listing_id)
);

CREATE INDEX IF NOT EXISTS idx_lead_matches_lead_score
  ON lead_matches (lead_id, match_score DESC);

CREATE INDEX IF NOT EXISTS idx_lead_matches_operator_status
  ON lead_matches (operator_status)
  WHERE operator_status IN ('pending', 'contacted');

CREATE INDEX IF NOT EXISTS idx_lead_matches_complex
  ON lead_matches (complex_id);

CREATE INDEX IF NOT EXISTS idx_lead_matches_created
  ON lead_matches (created_at DESC);
