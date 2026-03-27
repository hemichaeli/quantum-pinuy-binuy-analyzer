-- Migration 014: Add performance indexes for dashboard queries
-- QUANTUM System Audit - P0 query performance fix
-- Date: 2026-03-27

-- Enable trigram extension for fuzzy name search (safe to re-run)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Composite index for listing filters (city + status) - most common dashboard query
CREATE INDEX IF NOT EXISTS idx_listings_city_status ON listings(city, status);

-- Partial index for active listings (most queries filter on is_active = TRUE)
CREATE INDEX IF NOT EXISTS idx_listings_is_active ON listings(is_active) WHERE is_active = TRUE;

-- Index for phone lookups (WhatsApp/CRM matching)
CREATE INDEX IF NOT EXISTS idx_listings_phone ON listings(phone) WHERE phone IS NOT NULL;

-- Composite index for complexes dashboard (IAI score sorting + city filter)
CREATE INDEX IF NOT EXISTS idx_complexes_iai_city ON complexes(iai_score DESC NULLS LAST, city);

-- Index for complexes status filter
CREATE INDEX IF NOT EXISTS idx_complexes_status ON complexes(status);

-- Index for WhatsApp conversation phone lookups
CREATE INDEX IF NOT EXISTS idx_wa_conversations_phone ON whatsapp_conversations(phone);

-- Index for WhatsApp messages by conversation and timestamp
CREATE INDEX IF NOT EXISTS idx_wa_messages_conv_created ON whatsapp_messages(conversation_id, created_at);

-- Index for WhatsApp messages by phone (cross-query matching)
CREATE INDEX IF NOT EXISTS idx_wa_messages_phone ON whatsapp_messages(phone);

-- Index for listings updated_at (incremental scraping)
CREATE INDEX IF NOT EXISTS idx_listings_updated_at ON listings(updated_at DESC);

-- Trigram index for complex name fuzzy search
CREATE INDEX IF NOT EXISTS idx_complexes_name_trgm ON complexes USING gin(name gin_trgm_ops);

-- Analyze tables after index creation for query planner
ANALYZE listings;
ANALYZE complexes;
ANALYZE whatsapp_conversations;
ANALYZE whatsapp_messages;
