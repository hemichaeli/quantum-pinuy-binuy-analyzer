-- Migration 021: hot_opportunity_alerts table
-- Created 2026-04-28 (Day 7) for the hot-opportunity WhatsApp push cron.
-- One row per listing that fired an alert. UNIQUE(listing_id) prevents
-- duplicate alerts. Idempotent.

CREATE TABLE IF NOT EXISTS hot_opportunity_alerts (
  id              SERIAL PRIMARY KEY,
  listing_id      INT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  complex_id      INT REFERENCES complexes(id) ON DELETE SET NULL,
  iai_score       INT,
  ssi_score       INT,
  match_score     NUMERIC(5,2),
  channel         TEXT NOT NULL DEFAULT 'whatsapp',
    -- 'whatsapp' | 'sms' | 'log_only' (when no operator phone configured)
  status          TEXT NOT NULL DEFAULT 'sent',
    -- 'sent' | 'failed' | 'log_only'
  recipient       TEXT,
  message_preview TEXT,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (listing_id)
);

CREATE INDEX IF NOT EXISTS idx_hot_opp_alerts_created
  ON hot_opportunity_alerts (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_hot_opp_alerts_status
  ON hot_opportunity_alerts (status, created_at DESC);
