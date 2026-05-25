-- AI bot fetch log: every time GPTBot, ClaudeBot, PerplexityBot, etc. hits
-- an AI-Discovery path on this server, we record one row. Lets us answer
-- "is the AI Discovery layer actually getting crawled" without leaving
-- Railway.
CREATE TABLE IF NOT EXISTS bot_fetches (
    id              BIGSERIAL PRIMARY KEY,
    bot_name        VARCHAR(50)  NOT NULL,
    user_agent      TEXT,
    path            VARCHAR(500),
    ip              INET,
    status_code     INT,
    response_bytes  INT,
    fetched_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bot_fetches_bot_time ON bot_fetches(bot_name, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_fetches_path     ON bot_fetches(path);
CREATE INDEX IF NOT EXISTS idx_bot_fetches_time     ON bot_fetches(fetched_at DESC);
