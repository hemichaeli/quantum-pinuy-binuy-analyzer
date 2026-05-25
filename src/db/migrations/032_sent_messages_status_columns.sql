-- Migration 032: align sent_messages columns with inforuService.logMessage().
--
-- inforuService.logMessage() does CREATE TABLE IF NOT EXISTS sent_messages(...)
-- with columns: status_code, status_description, channel, template_id.
-- The table was created earlier without these columns; CREATE TABLE IF NOT
-- EXISTS does NOT add missing columns to an existing table, so every INSERT
-- since then has logged a warning "column status_code ... does not exist"
-- and silently failed (verified in Railway logs 2026-05-25).
-- Result: SMS/WA send still goes through, but no row lands in sent_messages,
-- so the DLR poller can't match delivery receipts to the original message.

ALTER TABLE sent_messages
  ADD COLUMN IF NOT EXISTS status_code        INTEGER,
  ADD COLUMN IF NOT EXISTS status_description TEXT,
  ADD COLUMN IF NOT EXISTS channel            VARCHAR(20) DEFAULT 'sms',
  ADD COLUMN IF NOT EXISTS template_id        VARCHAR(50);
