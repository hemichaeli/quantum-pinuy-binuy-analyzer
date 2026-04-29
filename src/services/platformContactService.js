/**
 * Platform Contact Service (Day 10).
 *
 * Submits "contact form" / "leave details" requests to listings on platforms
 * that don't expose a public chat API: madlan, yad1, dira, homeless, winwin.
 *
 * Architecture:
 *   - Calls Apify Actor APIFY_PLATFORM_CONTACT_ACTOR (configurable env)
 *     which knows how to log into each platform, fill its specific contact
 *     form (Hebrew labels, anti-bot evasion via residential proxy + 2Captcha
 *     when required), and verify submission.
 *   - Synchronous: waits for the actor run to complete (typically 20-45s
 *     per submission). Caller is responsible for batching + rate limiting.
 *
 * Why an Apify Actor (not raw axios):
 *   - madlan is fronted by Cloudflare; raw HTTP is 403'd. Residential
 *     proxy + real browser bypasses.
 *   - yad1/dira/homeless require maintaining session cookies; Puppeteer
 *     handles that natively.
 *   - Captcha solving (2Captcha) requires real DOM access for the iframe.
 *
 * Cost: ~$0.0001 USD per submission (STARTER plan), plus $0.001 per
 * captcha (rare on most listings).
 *
 * Env required:
 *   APIFY_API_TOKEN              (already set on Railway)
 *   APIFY_PLATFORM_CONTACT_ACTOR (e.g. quiescent_sunset/quantum-platform-contact)
 *   MADLAN_EMAIL / MADLAN_PASSWORD (already set)
 *   YAD1_EMAIL / YAD1_PASSWORD     (TBD per platform)
 *   TWOCAPTCHA_API_KEY            (already set)
 */

const axios = require('axios');
const { logger } = require('./logger');

const APIFY_BASE = 'https://api.apify.com/v2';
const SUPPORTED_SOURCES = new Set([
  'madlan', 'web_madlan', 'yad1', 'dira', 'homeless', 'winwin',
]);

function isSupported(source) {
  return SUPPORTED_SOURCES.has((source || '').toLowerCase());
}

/**
 * Submit a contact form via the Apify Actor.
 *
 * @param {object} listing - { id, source, url, source_listing_id, address, city, ... }
 * @param {string} message - the message body to send
 * @param {object} [options]
 * @param {string} [options.contactName='חמי'] - name to put in the form
 * @param {string} [options.phone] - phone (defaults to OPERATOR_WHATSAPP_PHONE)
 * @param {string} [options.email='office@u-r-quantum.com']
 * @param {number} [options.timeoutSecs=120]
 * @returns {Promise<{success: boolean, channel: 'platform_chat', error?: string, screenshotUrl?: string, runId?: string}>}
 */
async function submitContactForm(listing, message, options = {}) {
  const source = (listing.source || '').toLowerCase();

  if (!isSupported(source)) {
    return { success: false, channel: 'platform_chat', error: `Unsupported source: ${source}` };
  }

  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    return { success: false, channel: 'platform_chat', error: 'APIFY_API_TOKEN not set' };
  }

  const actor = process.env.APIFY_PLATFORM_CONTACT_ACTOR
    || 'quiescent_sunset/quantum-platform-contact';
  const actorId = encodeURIComponent(actor);

  const input = {
    source,
    listingUrl: listing.url,
    listingId: listing.source_listing_id,
    address: listing.address,
    city: listing.city,
    contactName: options.contactName || 'חמי',
    phone: options.phone || process.env.OPERATOR_WHATSAPP_PHONE || '037572229',
    email: options.email || process.env.SMTP_FROM || 'office@u-r-quantum.com',
    message,
    credentials: {
      madlan:   { email: process.env.MADLAN_EMAIL,   password: process.env.MADLAN_PASSWORD },
      yad1:     { email: process.env.YAD1_EMAIL,     password: process.env.YAD1_PASSWORD },
      homeless: { email: process.env.HOMELESS_EMAIL, password: process.env.HOMELESS_PASSWORD },
    },
    twoCaptchaApiKey: process.env.TWOCAPTCHA_API_KEY,
  };

  const timeoutSecs = options.timeoutSecs || 120;

  try {
    // Synchronous run — blocks until the actor finishes (or timeoutSecs passes).
    const url = `${APIFY_BASE}/acts/${actorId}/run-sync-get-dataset-items?token=${token}&timeout=${timeoutSecs}`;
    const r = await axios.post(url, input, {
      timeout: (timeoutSecs + 10) * 1000,
      validateStatus: () => true,
    });

    if (r.status >= 400) {
      logger.warn('[PlatformContact] Apify run failed', { status: r.status, source, listingId: listing.id });
      return { success: false, channel: 'platform_chat', error: `Apify HTTP ${r.status}` };
    }

    const items = Array.isArray(r.data) ? r.data : [];
    const result = items[0] || {};

    if (result.success) {
      logger.info(`[PlatformContact] ${source} submitted for listing ${listing.id}`, { runId: result.runId });
      return {
        success: true,
        channel: 'platform_chat',
        runId: result.runId,
        screenshotUrl: result.screenshotUrl,
      };
    } else {
      return {
        success: false,
        channel: 'platform_chat',
        error: result.error || 'Unknown actor failure',
        runId: result.runId,
      };
    }
  } catch (err) {
    logger.warn('[PlatformContact] Exception calling Apify', { source, error: err.message });
    return { success: false, channel: 'platform_chat', error: err.message };
  }
}

module.exports = { submitContactForm, isSupported, SUPPORTED_SOURCES };
