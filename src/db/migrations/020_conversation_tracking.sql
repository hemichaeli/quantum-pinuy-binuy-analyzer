-- Migration 020: Conversation tracking for unified inbox
-- Adds conversation_id grouping, read tracking, and reply detection

-- Add conversation tracking columns to unified_messages
ALTER TABLE unified_messages ADD COLUMN IF NOT EXISTS conversation_id VARCHAR(255);
ALTER TABLE unified_messages ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE;
ALTER TABLE unified_messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
ALTER TABLE unified_messages ADD COLUMN IF NOT EXISTS reply_to_id INTEGER REFERENCES unified_messages(id);
ALTER TABLE unified_messages ADD COLUMN IF NOT EXISTS external_thread_id VARCHAR(255);

-- Create index for conversation grouping
CREATE INDEX IF NOT EXISTS idx_unified_messages_conversation ON unified_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_unified_messages_listing_dir ON unified_messages(listing_id, direction, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_unified_messages_is_read ON unified_messages(is_read) WHERE is_read = FALSE;
CREATE INDEX IF NOT EXISTS idx_unified_messages_status ON unified_messages(status);

-- Generate conversation_id for existing messages (group by listing_id + channel)
UPDATE unified_messages
SET conversation_id = CONCAT('conv_', listing_id, '_', channel)
WHERE conversation_id IS NULL AND listing_id IS NOT NULL;

-- Create conversations summary view
CREATE OR REPLACE VIEW conversation_summary AS
SELECT
  conversation_id,
  MIN(um.listing_id) as listing_id,
  MIN(um.channel) as channel,
  MIN(um.platform) as platform,
  MIN(um.contact_phone) as contact_phone,
  MIN(um.contact_name) as contact_name,
  COUNT(*) as total_messages,
  COUNT(*) FILTER (WHERE um.direction = 'outgoing') as sent_count,
  COUNT(*) FILTER (WHERE um.direction = 'incoming') as received_count,
  COUNT(*) FILTER (WHERE um.is_read = FALSE AND um.direction = 'incoming') as unread_count,
  MAX(um.created_at) as last_message_at,
  MAX(um.created_at) FILTER (WHERE um.direction = 'outgoing') as last_sent_at,
  MAX(um.created_at) FILTER (WHERE um.direction = 'incoming') as last_received_at,
  -- Unanswered: last message is outgoing and sent > 5 hours ago
  CASE
    WHEN MAX(um.created_at) FILTER (WHERE um.direction = 'outgoing') >
         COALESCE(MAX(um.created_at) FILTER (WHERE um.direction = 'incoming'), '1970-01-01'::timestamptz)
         AND MAX(um.created_at) FILTER (WHERE um.direction = 'outgoing') < NOW() - INTERVAL '5 hours'
    THEN TRUE ELSE FALSE
  END as is_unanswered,
  -- Has unread incoming
  CASE WHEN COUNT(*) FILTER (WHERE um.is_read = FALSE AND um.direction = 'incoming') > 0
    THEN TRUE ELSE FALSE
  END as has_unread
FROM unified_messages um
WHERE um.conversation_id IS NOT NULL
GROUP BY um.conversation_id;

-- Add FB account pool status table (for tracking across restarts)
CREATE TABLE IF NOT EXISTS fb_account_status (
  id SERIAL PRIMARY KEY,
  account_label VARCHAR(100) NOT NULL UNIQUE,
  user_id VARCHAR(100),
  status VARCHAR(50) DEFAULT 'active',
  messages_sent_today INTEGER DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  cooldown_until TIMESTAMPTZ,
  consecutive_errors INTEGER DEFAULT 0,
  total_messages_sent INTEGER DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fb_account_status_label ON fb_account_status(account_label);
