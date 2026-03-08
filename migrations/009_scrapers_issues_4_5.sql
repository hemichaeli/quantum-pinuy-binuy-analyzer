-- Migration 009: New Scrapers — Issues #4 and #5
-- Adds govmap_zone_id to complexes, and contact tracking columns to listings

-- ============================================
-- Govmap zone ID for complexes (Issue #4 P3)
-- ============================================
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS govmap_zone_id VARCHAR(100);
ALTER TABLE complexes ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_complexes_govmap_zone ON complexes(govmap_zone_id) WHERE govmap_zone_id IS NOT NULL;

-- ============================================
-- Contact tracking for listings table (Issues #4 scrapers)
-- ============================================
ALTER TABLE listings ADD COLUMN IF NOT EXISTS phone VARCHAR(30);
ALTER TABLE listings ADD COLUMN IF NOT EXISTS contact_name VARCHAR(200);
ALTER TABLE listings ADD COLUMN IF NOT EXISTS contact_status VARCHAR(30) DEFAULT NULL;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS contact_attempts INTEGER DEFAULT 0;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS last_contact_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_listings_phone ON listings(phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_listings_contact_status ON listings(contact_status) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_listings_source ON listings(source);

-- ============================================
-- Kones2 listings — add missing columns if needed
-- ============================================
ALTER TABLE kones2_listings ADD COLUMN IF NOT EXISTS url TEXT;
ALTER TABLE kones2_listings ADD COLUMN IF NOT EXISTS rooms DECIMAL(3,1);
ALTER TABLE kones2_listings ADD COLUMN IF NOT EXISTS area_sqm DECIMAL(8,2);
ALTER TABLE kones2_listings ADD COLUMN IF NOT EXISTS floor INTEGER;
ALTER TABLE kones2_listings ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE kones2_listings ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE kones2_listings ADD COLUMN IF NOT EXISTS auction_date DATE;
ALTER TABLE kones2_listings ADD COLUMN IF NOT EXISTS court VARCHAR(100);
ALTER TABLE kones2_listings ADD COLUMN IF NOT EXISTS case_number VARCHAR(50);

-- ============================================
-- Kones listings — add source_site if not exists
-- ============================================
ALTER TABLE kones_listings ADD COLUMN IF NOT EXISTS source_site VARCHAR(50) DEFAULT 'konesisrael';
ALTER TABLE kones_listings ADD COLUMN IF NOT EXISTS url TEXT;
ALTER TABLE kones_listings ADD COLUMN IF NOT EXISTS contact_name VARCHAR(200);
