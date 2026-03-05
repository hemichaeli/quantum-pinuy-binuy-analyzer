-- ============================================================
-- QUANTUM Scheduling System - Full Schema
-- Run once: added to start.js auto-migration
-- ============================================================

CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  zoho_campaign_id VARCHAR(100) UNIQUE,
  google_calendar_id VARCHAR(255),
  zoho_calendar_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS campaign_schedule_config (
  id SERIAL PRIMARY KEY,
  zoho_campaign_id VARCHAR(100) UNIQUE NOT NULL,
  project_id INTEGER REFERENCES projects(id),
  meeting_type VARCHAR(50) NOT NULL DEFAULT 'consultation',
  available_windows JSONB DEFAULT '[]',
  slot_duration_minutes INTEGER DEFAULT 45,
  buffer_minutes INTEGER DEFAULT 15,
  reminder_delay_hours INTEGER DEFAULT 24,
  bot_followup_delay_hours INTEGER DEFAULT 48,
  pre_meeting_reminder_hours INTEGER DEFAULT 24,
  morning_reminder_hours INTEGER DEFAULT 2,
  wa_initial_template TEXT,
  wa_language VARCHAR(10) DEFAULT 'he',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS signing_ceremonies (
  id SERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id),
  zoho_campaign_id VARCHAR(100),
  name VARCHAR(255) NOT NULL,
  ceremony_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  slot_duration_minutes INTEGER NOT NULL DEFAULT 15,
  break_duration_minutes INTEGER NOT NULL DEFAULT 0,
  location TEXT,
  status VARCHAR(50) DEFAULT 'scheduled',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ceremony_buildings (
  id SERIAL PRIMARY KEY,
  ceremony_id INTEGER REFERENCES signing_ceremonies(id) ON DELETE CASCADE,
  building_address TEXT NOT NULL,
  building_label VARCHAR(100),
  display_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ceremony_stations (
  id SERIAL PRIMARY KEY,
  building_id INTEGER REFERENCES ceremony_buildings(id) ON DELETE CASCADE,
  station_number INTEGER NOT NULL,
  representative_name VARCHAR(255),
  representative_role VARCHAR(100) DEFAULT 'עורך דין',
  google_calendar_id VARCHAR(255),
  zoho_calendar_id VARCHAR(255),
  is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS ceremony_slots (
  id SERIAL PRIMARY KEY,
  station_id INTEGER REFERENCES ceremony_stations(id) ON DELETE CASCADE,
  ceremony_id INTEGER REFERENCES signing_ceremonies(id),
  slot_time TIME NOT NULL,
  slot_date DATE NOT NULL,
  duration_minutes INTEGER NOT NULL,
  status VARCHAR(50) DEFAULT 'open',
  reserved_at TIMESTAMP,
  confirmed_at TIMESTAMP,
  contact_phone VARCHAR(50),
  contact_name VARCHAR(255),
  zoho_contact_id VARCHAR(100),
  google_event_id VARCHAR(255),
  zoho_event_id VARCHAR(255),
  UNIQUE(station_id, slot_date, slot_time)
);

CREATE TABLE IF NOT EXISTS meeting_slots (
  id SERIAL PRIMARY KEY,
  campaign_id VARCHAR(100) NOT NULL,
  project_id INTEGER REFERENCES projects(id),
  meeting_type VARCHAR(50) NOT NULL,
  slot_datetime TIMESTAMP NOT NULL,
  duration_minutes INTEGER NOT NULL,
  representative_id VARCHAR(100),
  representative_name VARCHAR(255),
  status VARCHAR(50) DEFAULT 'open',
  contact_phone VARCHAR(50),
  contact_name VARCHAR(255),
  zoho_contact_id VARCHAR(100),
  google_event_id VARCHAR(255),
  zoho_event_id VARCHAR(255),
  reserved_at TIMESTAMP,
  confirmed_at TIMESTAMP,
  UNIQUE(campaign_id, representative_id, slot_datetime)
);

CREATE TABLE IF NOT EXISTS bot_sessions (
  id SERIAL PRIMARY KEY,
  phone VARCHAR(50) NOT NULL,
  zoho_contact_id VARCHAR(100),
  zoho_campaign_id VARCHAR(100),
  language VARCHAR(5) DEFAULT 'he',
  state VARCHAR(100) DEFAULT 'confirm_identity',
  context JSONB DEFAULT '{}',
  last_message_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(phone, zoho_campaign_id)
);

CREATE TABLE IF NOT EXISTS reminder_queue (
  id SERIAL PRIMARY KEY,
  phone VARCHAR(50) NOT NULL,
  zoho_contact_id VARCHAR(100),
  zoho_campaign_id VARCHAR(100),
  reminder_type VARCHAR(50) NOT NULL,
  scheduled_at TIMESTAMP NOT NULL,
  sent_at TIMESTAMP,
  status VARCHAR(50) DEFAULT 'pending',
  payload JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bot_sessions_phone ON bot_sessions(phone);
CREATE INDEX IF NOT EXISTS idx_reminder_queue_scheduled ON reminder_queue(scheduled_at, status);
CREATE INDEX IF NOT EXISTS idx_ceremony_slots_status ON ceremony_slots(ceremony_id, status);
CREATE INDEX IF NOT EXISTS idx_meeting_slots_campaign ON meeting_slots(campaign_id, status);
