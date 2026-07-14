-- Registrations / interest captured from the QUANTUM community-session landing page.
CREATE TABLE IF NOT EXISTS outreach_leads (
  id SERIAL PRIMARY KEY,
  name TEXT,
  email TEXT,
  org TEXT,
  role TEXT,
  interest TEXT,
  message TEXT,
  source_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
