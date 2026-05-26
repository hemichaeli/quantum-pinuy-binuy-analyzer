-- Migration 033: Apify daily-cap counter table.
--
-- The orchestrator burned $29.52 in a single day (2026-05-23) when 1,094 cold
-- listings hit the residential-proxy pass after the slash→tilde fix. To
-- prevent a repeat, every Apify batch increments a per-day counter; the
-- orchestrator skips Apify once the counter reaches APIFY_DAILY_CAP.
--
-- Schema: one row per UTC day, single counter column. Cheap to UPSERT.

CREATE TABLE IF NOT EXISTS apify_daily_usage (
  day               DATE PRIMARY KEY,
  phones_attempted  INTEGER NOT NULL DEFAULT 0,
  phones_succeeded  INTEGER NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
