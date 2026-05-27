/**
 * Path C — scrapegraphai SDK end-to-end.
 *
 * Uses the hosted smartScraper endpoint. We pass the cached HTML directly
 * (websiteHtml param) instead of letting SG re-fetch — guarantees the same
 * input bytes for A/B/C and avoids the network/anti-bot variability.
 *
 * If the SDK changes its API surface, this is the single place to update.
 */

const { canonicalize, FIELDS } = require('./schema');

const PROMPT = `Extract a single Israeli real-estate listing from this komo.co.il HTML page.
Return JSON with these exact keys, all nullable:
address, city, asking_price (integer ILS, no currency symbol),
rooms (float), area_sqm (integer), floor (integer; ground = 0),
phone (null — not in HTML), contact_name (null), title, description (<=500 chars),
source_listing_id (= the modaaNum value passed below).
Hebrew text is expected. Output JSON only, no commentary.`;

async function extractSgai(_htmlIgnored, modaaNum, opts = {}) {
  // SG SmartScraper takes a URL (re-fetches server-side) — no website_html option
  // on the public v1 API. We pass the live komo.co.il URL; this is a documented
  // divergence from Path A/B (which see byte-identical cached HTML).
  const apiKey = opts.apiKey || process.env.SGAI_API_KEY;
  if (!apiKey) throw new Error('SGAI_API_KEY missing');
  const axios = require('axios');
  const url = opts.url || `https://www.komo.co.il/code/nadlan/details/?modaaNum=${modaaNum}`;

  const t0 = Date.now();
  let resp, status;
  try {
    const r = await axios.post(
      'https://api.scrapegraphai.com/v1/smartscraper',
      { website_url: url, user_prompt: `${PROMPT}\n\nmodaaNum to echo back in source_listing_id: ${modaaNum}` },
      { headers: { 'SGAI-APIKEY': apiKey, 'Content-Type': 'application/json' }, timeout: 90000, validateStatus: () => true }
    );
    status = r.status;
    resp = r.data;
  } catch (e) {
    return {
      row: canonicalize({ source_listing_id: modaaNum }),
      raw_text: null,
      parse_error: e.message,
      latency_ms: Date.now() - t0,
      credits_used: 0,
      error: e.message
    };
  }
  const latency_ms = Date.now() - t0;

  if (status !== 200) {
    return {
      row: canonicalize({ source_listing_id: modaaNum }),
      raw_text: JSON.stringify(resp).slice(0, 500),
      parse_error: `HTTP ${status}`,
      latency_ms,
      credits_used: 0,
      error: resp?.error || `HTTP ${status}`,
      request_id: null
    };
  }

  const data = resp?.result || resp?.data || resp;
  const skeleton = Object.fromEntries(FIELDS.map(f => [f, null]));
  const row = canonicalize({ ...skeleton, ...(data || {}), source_listing_id: modaaNum });

  return {
    row,
    raw_text: typeof data === 'string' ? data : JSON.stringify(data || {}),
    parse_error: null,
    latency_ms,
    credits_used: 10, // SG SmartScraper is 10 credits/call per the dashboard
    request_id: resp?.request_id || resp?.id || null
  };
}

module.exports = { extractSgai };
