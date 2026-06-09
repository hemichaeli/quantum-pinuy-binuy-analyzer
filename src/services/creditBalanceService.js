/**
 * creditBalanceService.js
 * Polls paid third-party API balances/spend for the daily morning report.
 *
 * Design notes:
 *  - Each provider check is independent, time-boxed (8-12s), and NEVER throws.
 *    A flaky/unreachable provider reports level:'unknown' so it can't break or
 *    delay the morning report.
 *  - Levels: 'ok' | 'warn' | 'empty' | 'unknown'
 *      empty  → balance at/near zero, or key rejected → rendered RED and surfaced
 *               in a banner at the TOP of the report (per ops requirement: a $0
 *               balance must be impossible to miss).
 *      warn   → balance low / approaching a cap.
 *      unknown→ provider check failed (network/parse) — not an alert.
 *
 * Provider coverage:
 *  - Apify:      reads month-to-date spend vs the budget brake (real API).
 *  - 2captcha:   reads prepaid balance (real API).
 *  - Perplexity: has NO balance endpoint, so we probe with a 1-token request and
 *                classify the auth/billing response (costs a fraction of a cent/day).
 */

const axios = require('axios');
const { logger } = require('./logger');

const APIFY_BASE = 'https://api.apify.com/v2';

// ── Apify: month-to-date spend vs budget brake ───────────────────────────────
async function checkApify() {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) return { name: 'Apify', level: 'unknown', detail: 'אין token', value: null };
  const brake = parseFloat(process.env.APIFY_BUDGET_BRAKE_USD || '70');
  try {
    const r = await axios.get(`${APIFY_BASE}/users/me/usage/monthly`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 8000,
      validateStatus: () => true,
    });
    const spend = r.data?.data?.totalUsageCreditsUsdAfterVolumeDiscount;
    if (typeof spend !== 'number') {
      return { name: 'Apify', level: 'unknown', detail: `HTTP ${r.status}`, value: null };
    }
    const remaining = brake - spend;
    let level = 'ok';
    if (spend >= brake) level = 'empty';            // brake engaged → Apify paused
    else if (remaining <= brake * 0.15) level = 'warn';
    const detail = level === 'empty'
      ? `הוצאת $${spend.toFixed(2)} / תקרת $${brake.toFixed(0)} — הבלם פעיל, Apify מושבת`
      : `הוצאת $${spend.toFixed(2)} / תקרת $${brake.toFixed(0)} (נותרו $${remaining.toFixed(2)})`;
    return { name: 'Apify', level, value: spend, detail };
  } catch (e) {
    return { name: 'Apify', level: 'unknown', detail: e.message, value: null };
  }
}

// ── 2captcha: prepaid balance ────────────────────────────────────────────────
async function check2captcha() {
  const key = process.env.TWOCAPTCHA_API_KEY;
  if (!key) return { name: '2captcha', level: 'unknown', detail: 'אין key', value: null };
  try {
    const r = await axios.get('https://2captcha.com/res.php', {
      params: { key, action: 'getbalance', json: 1 },
      timeout: 8000,
      validateStatus: () => true,
    });
    if (r.data?.status === 1) {
      const bal = parseFloat(r.data.request);
      let level = 'ok';
      if (!(bal > 0)) level = 'empty';
      else if (bal < 2) level = 'warn';
      return { name: '2captcha', level, value: bal, detail: `יתרה $${bal.toFixed(2)}` };
    }
    return { name: '2captcha', level: 'unknown', detail: String(r.data?.request || r.status), value: null };
  } catch (e) {
    return { name: '2captcha', level: 'unknown', detail: e.message, value: null };
  }
}

// ── Perplexity: no balance API → probe + classify the response ───────────────
async function checkPerplexity() {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) return { name: 'Perplexity', level: 'unknown', detail: 'אין key', value: null };
  try {
    const r = await axios.post('https://api.perplexity.ai/chat/completions', {
      model: process.env.PERPLEXITY_MODEL || 'sonar',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
    }, {
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      timeout: 12000,
      validateStatus: () => true,
    });
    if (r.status === 200) return { name: 'Perplexity', level: 'ok', detail: 'פעיל', value: null };
    if (r.status === 401) return { name: 'Perplexity', level: 'empty', detail: 'מפתח לא תקין / לא מורשה (401)', value: null };
    if (r.status === 402) return { name: 'Perplexity', level: 'empty', detail: 'אזל ה-credit (402)', value: null };
    if (r.status === 429) return { name: 'Perplexity', level: 'warn', detail: 'הוגבל קצב (429)', value: null };
    const msg = (r.data?.error?.message || r.data?.detail || '').toString().toLowerCase();
    if (msg.includes('credit') || msg.includes('balance') || msg.includes('payment') || msg.includes('insufficient')) {
      return { name: 'Perplexity', level: 'empty', detail: `אזל ה-credit (${r.status})`, value: null };
    }
    return { name: 'Perplexity', level: 'unknown', detail: `HTTP ${r.status}`, value: null };
  } catch (e) {
    return { name: 'Perplexity', level: 'unknown', detail: e.message, value: null };
  }
}

/**
 * Run all provider checks in parallel. Returns:
 *   { results: [{name, level, value, detail}], hasEmpty, hasWarn }
 */
async function getCreditBalances() {
  const results = await Promise.all([
    checkPerplexity().catch((e) => ({ name: 'Perplexity', level: 'unknown', detail: e.message, value: null })),
    checkApify().catch((e) => ({ name: 'Apify', level: 'unknown', detail: e.message, value: null })),
    check2captcha().catch((e) => ({ name: '2captcha', level: 'unknown', detail: e.message, value: null })),
  ]);
  const hasEmpty = results.some((r) => r.level === 'empty');
  const hasWarn = results.some((r) => r.level === 'warn');
  logger.info('[CreditBalance] ' + results.map((r) => `${r.name}=${r.level}`).join(' '));
  return { results, hasEmpty, hasWarn };
}

module.exports = { getCreditBalances, checkApify, check2captcha, checkPerplexity };
