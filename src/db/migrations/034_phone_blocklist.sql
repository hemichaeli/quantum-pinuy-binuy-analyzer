-- Migration 034: phone blocklist for QUANTUM outreach.
--
-- 2026-05-28 finding: 1,021 of 1,225 active listings-with-phone come from
-- just 6 mass-aggregator phones. They're competing real-estate brokerages,
-- not the actual property owners we want to engage. Sending the
-- seller_outreach_v1 WhatsApp template to them is off-message and would
-- waste InforU template volume on dead ends.
--
-- This table holds phones AutoFirstContact must skip. Reason codes:
--   mass_agent     — broker with 30+ listings across many complexes
--   internal_test  — our own numbers, used during smoke testing
--   opt_out        — recipient asked to be removed via the WA template button
--   abuse          — flagged for inappropriate replies (future)
--
-- Phones are stored in the same local-IL format as listings.phone so the
-- exclusion join is a direct equality.

CREATE TABLE IF NOT EXISTS phone_blocklist (
  phone         TEXT PRIMARY KEY,
  reason        TEXT        NOT NULL,
  blocked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  contact_name  TEXT,
  notes         TEXT
);

CREATE INDEX IF NOT EXISTS idx_phone_blocklist_reason
  ON phone_blocklist (reason);

-- Seed the 6 mass-aggregators identified 2026-05-28 via /api/debug/contacts.
-- Numbers documented in notes show the scope of their inventory at seed time.
INSERT INTO phone_blocklist (phone, reason, contact_name, notes) VALUES
  ('0508005958', 'mass_agent', 'נהוראי ביטון',     '421 listings, 239 complexes, 38 cities — mass aggregator'),
  ('0508005971', 'mass_agent', 'ירון בן בכור',     '418 listings, 237 complexes, 37 cities — mass aggregator'),
  ('033727764',  'mass_agent', 'בנק נדל"ן',         '67 listings, 34 complexes, 14 cities — landline aggregator'),
  ('0776704417', 'mass_agent', 'אייל הראלי',        '50 listings, 43 complexes, 20 cities — mass aggregator'),
  ('0508308534', 'mass_agent', 'אימפריית הנדל"ן',   '36 listings, 26 complexes, 16 cities — agency'),
  ('0508005962', 'mass_agent', 'מוטי-אל הנכס',      '29 listings, 22 complexes, 15 cities — agency')
ON CONFLICT (phone) DO NOTHING;
