-- QUANTUM Auto Migrations
-- Runs on every startup via runAutoMigrations()

-- vapi_calls table for QUANTUM Voice AI
CREATE TABLE IF NOT EXISTS vapi_calls (
  id              SERIAL PRIMARY KEY,
  call_id         TEXT UNIQUE NOT NULL,
  phone           TEXT NOT NULL,
  agent_type      TEXT NOT NULL DEFAULT 'unknown',
  lead_id         INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  complex_id      INTEGER REFERENCES complexes(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'initiated',
  duration_seconds INTEGER,
  summary         TEXT,
  intent          TEXT,
  transcript      JSONB,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vapi_calls_phone     ON vapi_calls(phone);
CREATE INDEX IF NOT EXISTS idx_vapi_calls_lead_id   ON vapi_calls(lead_id);
CREATE INDEX IF NOT EXISTS idx_vapi_calls_agent     ON vapi_calls(agent_type);
CREATE INDEX IF NOT EXISTS idx_vapi_calls_intent    ON vapi_calls(intent);
CREATE INDEX IF NOT EXISTS idx_vapi_calls_created   ON vapi_calls(created_at DESC);

-- Fix whatsapp_conversations: add phone column if missing (table may exist without it)
CREATE TABLE IF NOT EXISTS whatsapp_conversations (
  id SERIAL PRIMARY KEY,
  phone VARCHAR(20) NOT NULL,
  status VARCHAR(50) DEFAULT 'active',
  last_message_category VARCHAR(50),
  agent_transferred BOOLEAN DEFAULT FALSE,
  unsubscribed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS phone VARCHAR(20);
ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active';
ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS last_message_category VARCHAR(50);
ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS agent_transferred BOOLEAN DEFAULT FALSE;
ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS unsubscribed_at TIMESTAMP;
ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES whatsapp_conversations(id),
  direction VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  external_id VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_notifications (
  id SERIAL PRIMARY KEY,
  phone VARCHAR(20),
  conversation_id INTEGER REFERENCES whatsapp_conversations(id),
  priority VARCHAR(20) DEFAULT 'normal',
  type VARCHAR(50),
  message TEXT,
  handled BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_phone ON whatsapp_conversations(phone);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_conversation ON whatsapp_messages(conversation_id);
