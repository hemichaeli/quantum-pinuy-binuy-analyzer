-- ========================================================
-- QUANTUM v4.64+ - Visual Booking System
-- ========================================================

-- Add booking token to bot sessions (one-time link)
ALTER TABLE bot_sessions ADD COLUMN IF NOT EXISTS booking_token TEXT UNIQUE;
CREATE INDEX IF NOT EXISTS idx_bot_sessions_booking_token ON bot_sessions(booking_token);
ALTER TABLE bot_sessions ADD COLUMN IF NOT EXISTS booking_completed_at TIMESTAMPTZ;

-- Add show_rep_name toggle to campaign config
ALTER TABLE campaign_schedule_config ADD COLUMN IF NOT EXISTS show_rep_name BOOLEAN DEFAULT true;
ALTER TABLE campaign_schedule_config ADD COLUMN IF NOT EXISTS show_station_number BOOLEAN DEFAULT false;
ALTER TABLE campaign_schedule_config ADD COLUMN IF NOT EXISTS booking_link_expires_hours INTEGER DEFAULT 48;

-- Slot fill strategy: sequential (fill from start, no gaps) or free (any slot)
ALTER TABLE campaign_schedule_config ADD COLUMN IF NOT EXISTS slot_fill_strategy TEXT DEFAULT 'sequential';

-- Add contact_name to meeting_slots for display
ALTER TABLE meeting_slots ADD COLUMN IF NOT EXISTS contact_name TEXT;
