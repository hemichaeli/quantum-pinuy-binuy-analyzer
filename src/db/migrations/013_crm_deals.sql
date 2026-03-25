-- Migration 013: CRM Deals table
-- Creates the deals table for CRM pipeline management

CREATE TABLE IF NOT EXISTS deals (
  id              SERIAL PRIMARY KEY,
  lead_id         INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  complex_id      INTEGER REFERENCES complexes(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  value           NUMERIC(12,2) DEFAULT 0,
  stage           TEXT NOT NULL DEFAULT 'prospect'
                    CHECK (stage IN ('prospect','qualified','proposal','negotiation','won','lost')),
  notes           TEXT DEFAULT '',
  expected_close  DATE,
  closed_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deals_lead_id    ON deals(lead_id);
CREATE INDEX IF NOT EXISTS idx_deals_complex_id ON deals(complex_id);
CREATE INDEX IF NOT EXISTS idx_deals_stage      ON deals(stage);
CREATE INDEX IF NOT EXISTS idx_deals_updated_at ON deals(updated_at DESC);

-- Seed a few demo deals so the pipeline page isn't empty
INSERT INTO deals (lead_id, title, value, stage, notes)
SELECT id, 'עסקת מכירה — ' || name, 1500000, 'prospect', 'ליד ממערכת QUANTUM'
FROM leads
WHERE id IN (SELECT id FROM leads ORDER BY id LIMIT 3)
ON CONFLICT DO NOTHING;
