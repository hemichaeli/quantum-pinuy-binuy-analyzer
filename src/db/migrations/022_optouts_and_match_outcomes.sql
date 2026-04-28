-- Migration 022: opt-out tracking + match outcome columns (Day 8.5)
--
-- Why:
--   * Meta Marketing templates require an opt-out path. We must record opt-outs
--     and skip those phones in bulkOutreachCron to stay compliant.
--   * Match Engine needs an outcome field per lead_match for future feedback.

CREATE TABLE IF NOT EXISTS wa_optouts (
  id            SERIAL PRIMARY KEY,
  phone         TEXT NOT NULL UNIQUE,
  opted_out_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source        TEXT NOT NULL,            -- 'reply_kw' | 'button' | 'manual' | 'api'
  reply_text    TEXT,
  listing_id    INT REFERENCES listings(id) ON DELETE SET NULL,
  notes         TEXT
);

CREATE INDEX IF NOT EXISTS idx_wa_optouts_opted_at
  ON wa_optouts (opted_out_at DESC);

ALTER TABLE lead_matches
  ADD COLUMN IF NOT EXISTS outcome       TEXT,
  ADD COLUMN IF NOT EXISTS outcome_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS outcome_notes TEXT;

CREATE INDEX IF NOT EXISTS idx_lead_matches_outcome
  ON lead_matches (outcome) WHERE outcome IS NOT NULL;
