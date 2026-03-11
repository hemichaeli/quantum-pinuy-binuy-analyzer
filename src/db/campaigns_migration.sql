-- QUANTUM Campaign Manager — DB Schema
-- Supports: WA only, Call only, WA→Call fallback

CREATE TABLE IF NOT EXISTS campaigns (
  id               SERIAL PRIMARY KEY,
  name             VARCHAR(200) NOT NULL,
  mode             VARCHAR(30)  NOT NULL DEFAULT 'wa_then_call',
  -- 'wa_then_call' | 'call_only' | 'wa_only'
  wa_wait_minutes  INTEGER      NOT NULL DEFAULT 30,
  -- minutes to wait for WA reply before calling
  agent_name       VARCHAR(100) NOT NULL DEFAULT 'רן',
  script_type      VARCHAR(50)  NOT NULL DEFAULT 'general',
  -- 'general' | 'seller' | 'buyer' | 'pinuy_binuy'
  status           VARCHAR(20)  NOT NULL DEFAULT 'active',
  -- 'active' | 'paused' | 'archived'
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS campaign_leads (
  id               SERIAL PRIMARY KEY,
  campaign_id      INTEGER      NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  phone            VARCHAR(30)  NOT NULL,
  name             VARCHAR(200),
  lead_type        VARCHAR(20),
  -- 'seller' | 'buyer' | 'unknown'
  city             VARCHAR(100),
  property_type    VARCHAR(100),
  notes            TEXT,
  -- WA tracking
  wa_sent_at       TIMESTAMPTZ,
  wa_replied_at    TIMESTAMPTZ,
  wa_message_count INTEGER      NOT NULL DEFAULT 0,
  -- Call tracking
  call_triggered_at TIMESTAMPTZ,
  call_id          VARCHAR(200),
  call_status      VARCHAR(50),
  -- 'pending' | 'wa_sent' | 'wa_replied' | 'call_queued' | 'call_placed' | 'call_completed' | 'converted' | 'dead'
  flow_status      VARCHAR(50)  NOT NULL DEFAULT 'pending',
  converted        BOOLEAN      NOT NULL DEFAULT FALSE,
  handoff_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_leads_campaign_id   ON campaign_leads(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_phone         ON campaign_leads(phone);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_flow_status   ON campaign_leads(flow_status);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_wa_sent       ON campaign_leads(wa_sent_at) WHERE wa_sent_at IS NOT NULL;
