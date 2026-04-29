/**
 * QUANTUM Platform Contact Actor (Day 10).
 *
 * Submits contact-form requests to real-estate listings on Israeli platforms
 * that don't expose a public chat API. Reverse-engineered selectors per
 * platform; runs Puppeteer with residential proxy + 2Captcha when needed.
 *
 * Inputs (see INPUT_SCHEMA.json):
 *   source       — 'madlan' | 'web_madlan' | 'yad1' | 'dira' | 'homeless' | 'winwin'
 *   listingUrl   — the listing's URL on the platform
 *   listingId    — source-specific listing ID
 *   contactName  — name to put in form (e.g. 'חמי')
 *   phone        — phone for the form
 *   email        — email for the form
 *   message      — Hebrew message body
 *   credentials  — { madlan: {...}, yad1: {...}, ... }
 *   twoCaptchaApiKey — optional, used by handlers that hit captchas
 *
 * Output (single dataset item):
 *   { success: bool, error?, screenshotUrl?, runId?, source, listingId }
 */

const { Actor } = require('apify');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const handlers = {
  madlan:   require('./handlers/madlan'),
  web_madlan: require('./handlers/madlan'),
  yad1:     require('./handlers/yad1'),
  dira:     require('./handlers/dira'),
  homeless: require('./handlers/homeless'),
  winwin:   require('./handlers/winwin'),
};

Actor.main(async () => {
  const input = await Actor.getInput();
  const { source } = input;

  const handler = handlers[source];
  if (!handler) {
    await Actor.pushData({
      success: false,
      error: `No handler for source: ${source}`,
      source,
      listingId: input.listingId,
    });
    return;
  }

  // Residential proxy (uses Apify's pool — no IP-ban risk on first pass)
  const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],
    countryCode: 'IL',
  });
  const proxyUrl = await proxyConfiguration.newUrl();

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      `--proxy-server=${proxyUrl}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--lang=he-IL',
    ],
  });

  let result;
  let screenshotKey;
  try {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'he-IL,he;q=0.9,en;q=0.5' });
    await page.setViewport({ width: 1366, height: 900 });

    result = await handler(page, input);

    // Always capture screenshot for audit trail
    const buf = await page.screenshot({ fullPage: false, type: 'png' });
    screenshotKey = `screenshot-${Date.now()}.png`;
    await Actor.setValue(screenshotKey, buf, { contentType: 'image/png' });
  } catch (err) {
    result = { success: false, error: err.message };
  } finally {
    await browser.close().catch(() => {});
  }

  const runId = process.env.APIFY_ACTOR_RUN_ID;
  await Actor.pushData({
    success: !!result?.success,
    error: result?.error || null,
    detail: result?.detail || null,
    source,
    listingId: input.listingId,
    runId,
    screenshotUrl: screenshotKey
      ? `https://api.apify.com/v2/key-value-stores/${process.env.APIFY_DEFAULT_KEY_VALUE_STORE_ID}/records/${screenshotKey}`
      : null,
  });
});
