-- Click tracking for partner outreach (high-signal event vs noisy opens).
ALTER TABLE outreach ADD COLUMN IF NOT EXISTS click_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outreach ADD COLUMN IF NOT EXISTS first_click_at TIMESTAMPTZ;
-- Cursor for the push monitor: last event timestamp already pushed to Claude mobile.
CREATE TABLE IF NOT EXISTS outreach_push_cursor (
  id INTEGER PRIMARY KEY DEFAULT 1,
  last_pushed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT single_row CHECK (id = 1)
);
INSERT INTO outreach_push_cursor (id, last_pushed_at) VALUES (1, NOW()) ON CONFLICT (id) DO NOTHING;
