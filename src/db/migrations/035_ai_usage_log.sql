-- 2026-06-14: Cumulative AI token-usage log.
-- Every outbound call to Perplexity (api.perplexity.ai) and Anthropic/Claude
-- (api.anthropic.com) is recorded here by a global axios response interceptor
-- (src/services/aiUsageLogger.js), so we can answer "how many Claude / Perplexity
-- tokens did we burn today?" directly from the DB / dashboard instead of digging
-- through Railway logs or the provider billing consoles.

CREATE TABLE IF NOT EXISTS ai_usage_log (
  id                     BIGSERIAL PRIMARY KEY,
  provider               TEXT NOT NULL,            -- 'anthropic' | 'perplexity'
  model                  TEXT,                     -- 'claude-sonnet-4-6' | 'sonar' | ...
  endpoint               TEXT,                     -- request path (e.g. /v1/messages)
  input_tokens           INTEGER NOT NULL DEFAULT 0,
  output_tokens          INTEGER NOT NULL DEFAULT 0,
  total_tokens           INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens  INTEGER NOT NULL DEFAULT 0,
  web_search_requests    INTEGER NOT NULL DEFAULT 0,
  status_code            INTEGER,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_created          ON ai_usage_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_provider_created ON ai_usage_log (provider, created_at DESC);
