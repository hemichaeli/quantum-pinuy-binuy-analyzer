-- Migration 015: Newsletter Subscribers
-- Public-facing newsletter with property preference filters

CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id                  SERIAL PRIMARY KEY,
  email               VARCHAR(255) NOT NULL UNIQUE,
  full_name           VARCHAR(255),
  phone               VARCHAR(30),
  -- Geographic preferences (comma-separated city names, NULL = all cities)
  cities              TEXT,
  -- Price range (NIS)
  price_min           INTEGER,
  price_max           INTEGER,
  -- Premium filter: minimum discount vs. committee price (%)
  min_discount_pct    NUMERIC(5,2),
  -- Premium filter: minimum discount in absolute NIS
  min_discount_nis    INTEGER,
  -- Property type filter (comma-separated: apartment,penthouse,garden,duplex)
  property_types      TEXT,
  -- Minimum rooms
  min_rooms           NUMERIC(3,1),
  -- Maximum rooms
  max_rooms           NUMERIC(3,1),
  -- Minimum floor
  min_floor           INTEGER,
  -- Frequency: 'immediate' | 'daily' | 'weekly'
  frequency           VARCHAR(20) NOT NULL DEFAULT 'immediate',
  -- Status
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  confirmed           BOOLEAN NOT NULL DEFAULT FALSE,
  confirm_token       VARCHAR(64),
  unsubscribe_token   VARCHAR(64),
  -- Tracking
  last_sent_at        TIMESTAMP WITH TIME ZONE,
  listings_sent       INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_newsletter_active ON newsletter_subscribers(is_active, confirmed);
CREATE INDEX IF NOT EXISTS idx_newsletter_email ON newsletter_subscribers(email);
CREATE INDEX IF NOT EXISTS idx_newsletter_confirm_token ON newsletter_subscribers(confirm_token);
CREATE INDEX IF NOT EXISTS idx_newsletter_unsubscribe_token ON newsletter_subscribers(unsubscribe_token);

-- Track which listings were already sent to which subscriber (avoid duplicates)
CREATE TABLE IF NOT EXISTS newsletter_sent_listings (
  id              SERIAL PRIMARY KEY,
  subscriber_id   INTEGER NOT NULL REFERENCES newsletter_subscribers(id) ON DELETE CASCADE,
  listing_id      INTEGER NOT NULL,
  sent_at         TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletter_sent_unique ON newsletter_sent_listings(subscriber_id, listing_id);
CREATE INDEX IF NOT EXISTS idx_newsletter_sent_subscriber ON newsletter_sent_listings(subscriber_id);
