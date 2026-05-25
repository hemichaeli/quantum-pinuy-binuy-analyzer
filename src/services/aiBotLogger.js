// AI bot fetch logger.
// Detects known AI crawler User-Agents on AI-Discovery paths and persists
// each fetch to the `bot_fetches` table so we can answer "is GPTBot reading
// us yet? when did Perplexity first crawl? what paths do they prefer?".
//
// Registered as Express middleware in src/index.js BEFORE loadAllRoutes().
// Only logs requests whose path matches DISCOVERY_PATHS (no risk of
// polluting the table with normal dashboard traffic).

const BOT_PATTERNS = [
  ['GPTBot',            /GPTBot/i],
  ['ChatGPT-User',      /ChatGPT-User/i],
  ['OAI-SearchBot',     /OAI-SearchBot/i],
  ['ClaudeBot',         /ClaudeBot/i],
  ['Claude-User',       /Claude-User/i],
  ['Claude-Web',        /Claude-Web/i],
  ['PerplexityBot',     /PerplexityBot/i],
  ['Perplexity-User',   /Perplexity-User/i],
  ['Google-Extended',   /Google-Extended/i],
  ['GoogleOther',       /GoogleOther/i],
  ['Googlebot',         /Googlebot(?!-)/i],
  ['Bingbot',           /bingbot/i],
  ['CCBot',             /CCBot/i],
  ['MistralAI-User',    /MistralAI/i],
  ['cohere-ai',         /cohere-ai/i],
  ['anthropic-ai',      /anthropic-ai/i],
  ['Bytespider',        /Bytespider/i],
  ['Amazonbot',         /Amazonbot/i],
  ['YouBot',            /YouBot/i],
  ['applebot-extended', /Applebot-Extended/i],
  ['Applebot',          /Applebot(?!-)/i],
  ['DuckAssistBot',     /DuckAssistBot/i],
  ['Diffbot',           /Diffbot/i],
  ['DataForSeoBot',     /DataForSeoBot/i],
];

const DISCOVERY_PATHS = /^(\/llms\.txt|\/opportunities\.json|\/changelog\.json|\/feed\.atom|\/\.well-known\/(agents|openapi)\.json|\/mcp\/v1\/|\/api\/discovery\/)/;

function detectBot(ua) {
  if (!ua) return null;
  for (const [name, pattern] of BOT_PATTERNS) {
    if (pattern.test(ua)) return name;
  }
  return null;
}

function aiBotLoggerMiddleware(pool) {
  return (req, res, next) => {
    if (!DISCOVERY_PATHS.test(req.path)) return next();
    const ua = req.headers['user-agent'] || '';
    const bot = detectBot(ua);
    if (!bot) return next();

    let responseBytes = 0;
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    res.write = function (chunk, ...args) {
      if (chunk) responseBytes += Buffer.byteLength(typeof chunk === 'string' ? chunk : chunk);
      return origWrite(chunk, ...args);
    };
    res.end = function (chunk, ...args) {
      if (chunk) responseBytes += Buffer.byteLength(typeof chunk === 'string' ? chunk : chunk);
      return origEnd(chunk, ...args);
    };

    res.on('finish', () => {
      const ip = (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '').toString().trim();
      pool.query(
        `INSERT INTO bot_fetches(bot_name, user_agent, path, ip, status_code, response_bytes)
         VALUES ($1, $2, $3, $4::inet, $5, $6)`,
        [bot, ua.slice(0, 500), req.path.slice(0, 500), ip || null, res.statusCode, responseBytes]
      ).catch(() => { /* swallow - logger must never break the request */ });
    });

    next();
  };
}

module.exports = { aiBotLoggerMiddleware, detectBot, BOT_PATTERNS, DISCOVERY_PATHS };
