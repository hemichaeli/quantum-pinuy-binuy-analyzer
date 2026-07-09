-- 039_outreach_tracking.sql
-- 2026-07-09: partner-outreach tracking (delivery/open/reply). One row per recipient.
--   open is auto-logged by a 1x1 tracking pixel; sent/replied are marked via /mark.
-- Idempotent.
CREATE TABLE IF NOT EXISTS outreach (
  key TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  batch INT DEFAULT 1,
  category TEXT,
  sent_at TIMESTAMP,
  first_open_at TIMESTAMP,
  open_count INT DEFAULT 0,
  replied_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
