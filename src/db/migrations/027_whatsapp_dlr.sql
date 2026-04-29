-- Migration 027: WhatsApp delivery tracking columns (Day 10).
--
-- Lets the new whatsappDLRCron poll INFORU's DeliveryNotificationWhatsapp
-- pull endpoint and persist the per-message status: delivered / read /
-- failed, so the dashboard can show ✓ vs ✓✓ vs blue ✓✓.
--
-- INFORU echoes back our CustomerMessageId in each DLR row, so we save it
-- as the lookup key (external_id on sent_messages, also on unified_messages).

-- sent_messages: add external_id (customerMessageId) + delivery columns
ALTER TABLE sent_messages
  ADD COLUMN IF NOT EXISTS external_id    TEXT,
  ADD COLUMN IF NOT EXISTS delivered_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS read_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failed_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dlr_reason     TEXT;

CREATE INDEX IF NOT EXISTS idx_sent_messages_external_id
  ON sent_messages (external_id) WHERE external_id IS NOT NULL;

-- unified_messages: external_id + delivered_at already partially exist.
-- Make sure they're present (idempotent).
ALTER TABLE unified_messages
  ADD COLUMN IF NOT EXISTS delivered_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failed_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dlr_reason     TEXT;

CREATE INDEX IF NOT EXISTS idx_unified_messages_external_id
  ON unified_messages (external_id) WHERE external_id IS NOT NULL;
