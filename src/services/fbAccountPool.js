/**
 * Facebook Account Pool - Multi-account rotation with anti-block protection
 *
 * Manages multiple FB accounts for Marketplace messaging with:
 * - Round-robin account rotation
 * - Per-account daily message limits
 * - Cooldown on errors/blocks
 * - Random delays between messages
 * - fb_dtsg token extraction
 */

const axios = require('axios');
const { logger } = require('./logger');

const MAX_MESSAGES_PER_DAY = 20;
const COOLDOWN_RATE_LIMIT = 60 * 60 * 1000;       // 1 hour
const COOLDOWN_BLOCK = 24 * 60 * 60 * 1000;        // 24 hours
const MIN_DELAY_MS = 15000;                          // 15 seconds minimum between messages
const MAX_DELAY_MS = 90000;                          // 90 seconds max
const DTSG_CACHE_TTL = 30 * 60 * 1000;              // 30 minutes

const BROWSER_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Upgrade-Insecure-Requests': '1'
};

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15'
];

// In-memory account pool
let accounts = [];
let lastPoolLoad = 0;
let globalLastSendTime = 0;

/**
 * Load all FB accounts from environment variables
 * Supports: FB_COOKIES_BASE64 (single), FB_COOKIES_BASE64_1..N (multiple)
 */
function loadAccounts() {
  if (accounts.length > 0 && Date.now() - lastPoolLoad < 5 * 60 * 1000) {
    return accounts;
  }

  accounts = [];

  // Load primary account
  const primary = process.env.FB_COOKIES_BASE64;
  if (primary) {
    const acct = parseAccount(primary, 'primary');
    if (acct) accounts.push(acct);
  }

  // Load numbered accounts (FB_COOKIES_BASE64_1, _2, _3, etc.)
  for (let i = 1; i <= 10; i++) {
    const env = process.env[`FB_COOKIES_BASE64_${i}`];
    if (env) {
      const acct = parseAccount(env, `account_${i}`);
      if (acct) accounts.push(acct);
    }
  }

  // Load from pooled env (JSON array of base64 cookies)
  const poolEnv = process.env.FB_ACCOUNT_POOL;
  if (poolEnv) {
    try {
      const poolArr = JSON.parse(poolEnv);
      poolArr.forEach((b64, idx) => {
        const acct = parseAccount(b64, `pool_${idx}`);
        if (acct) accounts.push(acct);
      });
    } catch (e) {
      logger.warn(`[FBPool] Failed to parse FB_ACCOUNT_POOL: ${e.message}`);
    }
  }

  lastPoolLoad = Date.now();
  logger.info(`[FBPool] Loaded ${accounts.length} accounts`);
  return accounts;
}

/**
 * Parse a base64-encoded cookie string into an account object
 */
function parseAccount(b64, label) {
  try {
    const json = Buffer.from(b64, 'base64').toString('utf-8');
    const cookies = JSON.parse(json);
    if (!Array.isArray(cookies) || cookies.length === 0) return null;

    const cUser = cookies.find(c => c.name === 'c_user');
    if (!cUser) return null;

    return {
      id: label,
      userId: cUser.value,
      cookies,
      cookieStr: cookies.map(c => `${c.name}=${c.value}`).join('; '),
      status: 'active',           // active, cooldown, expired, blocked
      lastUsed: 0,
      messagesSentToday: 0,
      messageSentDates: [],       // timestamps of sent messages today
      cooldownUntil: 0,
      consecutiveErrors: 0,
      dtsg: null,
      dtsgExpiry: 0,
      userAgent: USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
    };
  } catch (err) {
    logger.warn(`[FBPool] Failed to parse account ${label}: ${err.message}`);
    return null;
  }
}

/**
 * Get the next available account (round-robin, skipping unavailable)
 */
function getNextAccount() {
  const pool = loadAccounts();
  if (pool.length === 0) return null;

  const now = Date.now();
  const today = new Date().toDateString();

  // Reset daily counters if new day
  for (const acct of pool) {
    const lastDate = acct.lastUsed ? new Date(acct.lastUsed).toDateString() : '';
    if (lastDate !== today) {
      acct.messagesSentToday = 0;
      acct.messageSentDates = [];
    }
  }

  // Filter to available accounts
  const available = pool.filter(a => {
    if (a.status === 'expired' || a.status === 'blocked') return false;
    if (a.status === 'cooldown' && a.cooldownUntil > now) return false;
    if (a.status === 'cooldown' && a.cooldownUntil <= now) a.status = 'active';
    if (a.messagesSentToday >= MAX_MESSAGES_PER_DAY) return false;
    return true;
  });

  if (available.length === 0) {
    logger.warn(`[FBPool] No available accounts. Total: ${pool.length}, all in cooldown/expired/at limit`);
    return null;
  }

  // Pick least recently used
  available.sort((a, b) => a.lastUsed - b.lastUsed);
  return available[0];
}

/**
 * Mark an account as used after successful send
 */
function markAccountUsed(accountId) {
  const acct = accounts.find(a => a.id === accountId);
  if (!acct) return;
  acct.lastUsed = Date.now();
  acct.messagesSentToday++;
  acct.messageSentDates.push(Date.now());
  acct.consecutiveErrors = 0;
  globalLastSendTime = Date.now();
}

/**
 * Mark an account with an error
 */
function markAccountError(accountId, errorType) {
  const acct = accounts.find(a => a.id === accountId);
  if (!acct) return;
  acct.consecutiveErrors++;

  switch (errorType) {
    case 'rate_limit':
      acct.status = 'cooldown';
      acct.cooldownUntil = Date.now() + COOLDOWN_RATE_LIMIT;
      logger.warn(`[FBPool] Account ${accountId} rate limited, cooldown 1h`);
      break;
    case 'blocked':
      acct.status = 'cooldown';
      acct.cooldownUntil = Date.now() + COOLDOWN_BLOCK;
      logger.warn(`[FBPool] Account ${accountId} blocked, cooldown 24h`);
      break;
    case 'expired':
      acct.status = 'expired';
      logger.warn(`[FBPool] Account ${accountId} cookies expired`);
      break;
    default:
      if (acct.consecutiveErrors >= 3) {
        acct.status = 'cooldown';
        acct.cooldownUntil = Date.now() + COOLDOWN_RATE_LIMIT;
        logger.warn(`[FBPool] Account ${accountId} 3 consecutive errors, cooldown 1h`);
      }
  }
}

/**
 * Get fb_dtsg token for an account (required for GraphQL mutations)
 */
async function getDtsg(account) {
  if (account.dtsg && account.dtsgExpiry > Date.now()) {
    return account.dtsg;
  }

  try {
    const resp = await axios.get('https://www.facebook.com/marketplace/', {
      headers: { ...BROWSER_HEADERS, 'User-Agent': account.userAgent, Cookie: account.cookieStr },
      timeout: 20000,
      maxRedirects: 5
    });

    const html = resp.data;
    const patterns = [
      /"DTSGInitialData".*?"token":"([^"]+)"/,
      /name="fb_dtsg" value="([^"]+)"/,
      /"dtsg":\{"token":"([^"]+)"/,
      /\["DTSGInitData",\[\],\{"token":"([^"]+)"/
    ];

    for (const p of patterns) {
      const m = html.match(p);
      if (m) {
        account.dtsg = m[1];
        account.dtsgExpiry = Date.now() + DTSG_CACHE_TTL;
        logger.info(`[FBPool] Got fb_dtsg for ${account.id}`);
        return account.dtsg;
      }
    }

    logger.warn(`[FBPool] Could not extract fb_dtsg for ${account.id}`);
    return null;
  } catch (err) {
    logger.warn(`[FBPool] Failed to get fb_dtsg for ${account.id}: ${err.message}`);
    return null;
  }
}

/**
 * Calculate delay before next message (random human-like timing)
 */
function getNextDelay() {
  const timeSinceLastSend = Date.now() - globalLastSendTime;
  const baseDelay = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
  const remaining = Math.max(0, baseDelay - timeSinceLastSend);
  return Math.round(remaining);
}

/**
 * Wait for the calculated delay
 */
async function waitForDelay() {
  const delay = getNextDelay();
  if (delay > 0) {
    logger.debug(`[FBPool] Waiting ${Math.round(delay / 1000)}s before next message`);
    await new Promise(r => setTimeout(r, delay));
  }
}

/**
 * Get pool status for monitoring
 */
function getPoolStatus() {
  const pool = loadAccounts();
  return {
    totalAccounts: pool.length,
    active: pool.filter(a => a.status === 'active').length,
    cooldown: pool.filter(a => a.status === 'cooldown').length,
    expired: pool.filter(a => a.status === 'expired').length,
    blocked: pool.filter(a => a.status === 'blocked').length,
    accounts: pool.map(a => ({
      id: a.id,
      userId: a.userId,
      status: a.status,
      messagesSentToday: a.messagesSentToday,
      cooldownUntil: a.cooldownUntil > Date.now() ? new Date(a.cooldownUntil).toISOString() : null,
      consecutiveErrors: a.consecutiveErrors,
      hasDtsg: !!a.dtsg
    }))
  };
}

/**
 * Get proxy configuration from env (optional)
 */
function getProxyConfig() {
  const proxyUrl = process.env.FB_PROXY_URL;
  if (!proxyUrl) return undefined;

  try {
    const url = new URL(proxyUrl);
    return {
      host: url.hostname,
      port: parseInt(url.port),
      auth: url.username ? { username: url.username, password: url.password } : undefined,
      protocol: url.protocol.replace(':', '')
    };
  } catch (e) {
    return undefined;
  }
}

module.exports = {
  loadAccounts,
  getNextAccount,
  markAccountUsed,
  markAccountError,
  getDtsg,
  getNextDelay,
  waitForDelay,
  getPoolStatus,
  getProxyConfig,
  USER_AGENTS,
  BROWSER_HEADERS
};
