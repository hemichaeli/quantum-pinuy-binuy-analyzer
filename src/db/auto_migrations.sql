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

-- Fix whatsapp_conversations
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
  phone VARCHAR(20),
  status VARCHAR(50) DEFAULT 'new',
  created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS phone VARCHAR(20);
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'new';

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

-- ===================================================
-- QUANTUM v4.62.0 - Search, CRM, Analytics, Users
-- ===================================================

-- Search history
CREATE TABLE IF NOT EXISTS search_history (
  id SERIAL PRIMARY KEY,
  query TEXT NOT NULL,
  filters JSONB DEFAULT '{}',
  result_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Saved searches
CREATE TABLE IF NOT EXISTS saved_searches (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  query TEXT NOT NULL,
  filters JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Call logs
CREATE TABLE IF NOT EXISTS call_logs (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  duration_seconds INTEGER DEFAULT 0,
  notes TEXT DEFAULT '',
  outcome VARCHAR(50) DEFAULT 'answered',
  called_by VARCHAR(100) DEFAULT 'agent',
  called_at TIMESTAMP DEFAULT NOW()
);

-- Reminders
CREATE TABLE IF NOT EXISTS reminders (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  notes TEXT DEFAULT '',
  due_at TIMESTAMP NOT NULL,
  reminder_type VARCHAR(50) DEFAULT 'follow_up',
  status VARCHAR(50) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Deals pipeline
CREATE TABLE IF NOT EXISTS deals (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  complex_id INTEGER REFERENCES complexes(id) ON DELETE SET NULL,
  title VARCHAR(255) NOT NULL,
  value DECIMAL(15,2) DEFAULT 0,
  stage VARCHAR(50) DEFAULT 'prospect',
  notes TEXT DEFAULT '',
  expected_close DATE,
  closed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  status VARCHAR(50) DEFAULT 'active'
);

-- Users
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) DEFAULT 'agent',
  is_active BOOLEAN DEFAULT true,
  last_login TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- User sessions
CREATE TABLE IF NOT EXISTS user_sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Activity log
CREATE TABLE IF NOT EXISTS activity_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50),
  entity_id INTEGER,
  details JSONB DEFAULT '{}',
  ip_address VARCHAR(45),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Leads columns (ensure exist)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_contact TIMESTAMP;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS budget DECIMAL(15,2);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS city VARCHAR(100);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

-- ===================================================
-- PERFORMANCE INDEXES
-- ===================================================

CREATE INDEX IF NOT EXISTS idx_complexes_city ON complexes(city);
CREATE INDEX IF NOT EXISTS idx_complexes_iai_score ON complexes(iai_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_complexes_ssi_score ON complexes(ssi_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_complexes_status ON complexes(status);
CREATE INDEX IF NOT EXISTS idx_complexes_enrichment ON complexes(enrichment_status);
CREATE INDEX IF NOT EXISTS idx_complexes_city_iai ON complexes(city, iai_score DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(source);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);

CREATE INDEX IF NOT EXISTS idx_whatsapp_phone ON whatsapp_messages(phone);
CREATE INDEX IF NOT EXISTS idx_whatsapp_created ON whatsapp_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_status ON whatsapp_messages(status);
CREATE INDEX IF NOT EXISTS idx_whatsapp_direction ON whatsapp_messages(direction);

CREATE INDEX IF NOT EXISTS idx_yad2_city ON yad2_listings(city);
CREATE INDEX IF NOT EXISTS idx_yad2_price ON yad2_listings(price);
CREATE INDEX IF NOT EXISTS idx_yad2_scraped ON yad2_listings(scraped_at DESC);

CREATE INDEX IF NOT EXISTS idx_call_logs_lead ON call_logs(lead_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_called ON call_logs(called_at DESC);
CREATE INDEX IF NOT EXISTS idx_reminders_lead ON reminders(lead_id);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_at);
CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status);
CREATE INDEX IF NOT EXISTS idx_deals_lead ON deals(lead_id);
CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage);
CREATE INDEX IF NOT EXISTS idx_deals_complex ON deals(complex_id);
CREATE INDEX IF NOT EXISTS idx_search_history_created ON search_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON user_sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON user_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log(user_id);
