/**
 * yad2-proxy v2 — Cloudflare Worker
 *
 * Proxies requests to yad2's PUBLIC search page so the Railway-side scraper
 * can extract listings from the server-rendered __NEXT_DATA__ JSON.
 *
 * v1 (2026-03) proxied gw.yad2.co.il/feed-search-legacy/realestate/forsale.
 * That endpoint started returning 404 with ShieldSquare anti-bot ~2026-04
 * and is dead. v2 talks to the public realestate/forsale page instead.
 *
 * Two response modes:
 *   ?format=html   → raw HTML passthrough (caller parses NEXT_DATA itself)
 *   ?format=feed   → DEFAULT: extract __NEXT_DATA__ and return only the feed
 *                    buckets ({ feed_items: [...] }) in a shape close to the
 *                    legacy gw.yad2 API. Lets us keep the Worker's response
 *                    payload tiny (a few KB instead of 1.3 MB HTML).
 *
 * Auth: same shared secret as v1 (?key=… or X-Secret-Key header).
 *
 * Deploy:
 *   cd cloudflare-workers/yad2-proxy
 *   wrangler deploy   # or paste this file in dashboard → Workers → yad2-proxy
 *
 * Make sure workers.dev subdomain is enabled on the Worker (Settings → Triggers →
 * "Custom Domains" + "workers.dev"). The Railway scraper reads YAD2_PROXY_URL.
 */

const YAD2_PUBLIC = 'https://www.yad2.co.il/realestate/forsale';
const SECRET_KEY = 'pinuy-binuy-2026';
const SGAI_API = 'https://api.scrapegraphai.com/v1/smartscraper';

// Browser User-Agents to rotate per request. ShieldSquare keys on UA+IP+rate;
// CF egress IPs are not yet flagged, so rotation is mostly precautionary.
const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
];

addEventListener('fetch', event => event.respondWith(handleRequest(event.request)));

function jsonResp(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'X-Proxied-By': 'yad2-proxy-worker-v2'
    }
  });
}

function isShieldSquare(html) {
  return typeof html === 'string' && (
    html.includes('ShieldSquare') ||
    html.includes('__uzdbm_') ||
    html.includes('SSJSConnectorObj') ||
    html.includes('Bot Manager')
  );
}

function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function pickFeedBuckets(nextData) {
  const feed = nextData?.props?.pageProps?.feed || {};
  return {
    private: feed.private || [],
    agency: feed.agency || [],
    platinum: feed.platinum || [],
    booster: feed.booster || [],
    yad1: feed.yad1 || null,
  };
}

async function handleRequest(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Secret-Key',
      },
    });
  }
  if (request.method !== 'GET') {
    return jsonResp(405, { error: 'Method not allowed' });
  }

  const url = new URL(request.url);

  if (url.pathname === '/health') {
    return jsonResp(200, { status: 'ok', worker: 'yad2-proxy', version: 'v2', timestamp: new Date().toISOString() });
  }

  const secretKey = request.headers.get('X-Secret-Key') || url.searchParams.get('key');
  if (secretKey !== SECRET_KEY) return jsonResp(401, { error: 'Unauthorized' });

  // Forward all params except 'key' and 'format' to yad2 public page
  const fmt = url.searchParams.get('format') || 'feed';
  const params = new URLSearchParams();
  for (const [k, v] of url.searchParams.entries()) {
    if (k === 'key' || k === 'format') continue;
    // Drop legacy params that the public page doesn't understand
    if (k === 'propertyGroup' || k === 'dealType' || k === 'limit') continue;
    params.set(k, v);
  }
  const targetUrl = YAD2_PUBLIC + (params.toString() ? '?' + params.toString() : '');

  const ua = UAS[Math.floor(Math.random() * UAS.length)];
  try {
    const yad2Resp = await fetch(targetUrl, {
      headers: {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
      redirect: 'follow',
    });

    const status = yad2Resp.status;
    const html = await yad2Resp.text();

    if (isShieldSquare(html)) {
      // Direct CF egress IPs are blocked by yad2's ShieldSquare. Fall back to
      // ScrapeGraphAI stealth (residential proxies) if SGAI_API_KEY is set as
      // a Worker secret. Costs ~14 credits/call ($0.03ish at SG starter rates).
      // Verified 2026-05-17: SG stealth successfully extracts listings from
      // the same URL that gets bot_challenge for both CF and Railway IPs.
      const sgaiKey = (typeof SGAI_API_KEY !== 'undefined') ? SGAI_API_KEY : null;
      if (sgaiKey && url.searchParams.get('no_fallback') !== '1') {
        try {
          // Safety brake: refuse SG fallback when remaining credits drop below
          // SGAI_FLOOR_CREDITS. Prevents runaway cron loops from draining a
          // paid SG plan in minutes — which is exactly what happened the first
          // time this Worker went live (300 calls × 14 credits = 4200 credits
          // in ~25 minutes). Default floor = 500 credits ≈ $1 cushion.
          const floorRaw = (typeof SGAI_FLOOR_CREDITS !== 'undefined') ? SGAI_FLOOR_CREDITS : '500';
          const floor = parseInt(floorRaw, 10) || 500;
          try {
            const cResp = await fetch('https://api.scrapegraphai.com/v1/credits', {
              headers: { 'SGAI-APIKEY': sgaiKey }
            });
            const cBody = await cResp.json();
            if (typeof cBody?.remaining_credits === 'number' && cBody.remaining_credits < floor) {
              return jsonResp(503, {
                error: 'sgai_floor_hit',
                message: `SG credits at ${cBody.remaining_credits} (floor=${floor}). Refusing SG fallback to preserve runway.`,
                remaining_credits: cBody.remaining_credits,
                floor
              });
            }
          } catch (e) {
            // If credits-check fails (network), proceed with the call — better
            // a couple of unguarded calls than blocking the proxy entirely.
          }
          const sgResp = await fetch(SGAI_API, {
            method: 'POST',
            headers: { 'SGAI-APIKEY': sgaiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              website_url: targetUrl,
              user_prompt: 'Extract all real-estate listings on this page. For each listing return: token (id from URL), price (integer ILS, no currency), rooms (number), area_sqm (integer), floor (integer, ground=0), address (object with street, house_number, neighborhood, city). Return JSON {"listings": [...]}.',
              stealth: true,
              mode: 'js'
            })
          });
          const sgData = await sgResp.json();
          if (sgData?.status === 'completed' && sgData?.result?.listings) {
            const listings = sgData.result.listings;
            // Shape-convert SG output to look like yad2 NEXT_DATA buckets so the
            // Railway scraper's existing parser keeps working unchanged.
            const buckets = { private: [], agency: [], platinum: [], booster: [] };
            // SG returns address as either an object OR a string like
            // "מוסינזון 17, תל אביב יפו". Normalise both to the structured
            // shape that yad2Scraper.parseYad2NextItem expects.
            const parseAddrString = (s) => {
              if (!s || typeof s !== 'string') return { street: '', house: null, city: '' };
              const parts = s.split(',').map(p => p.trim()).filter(Boolean);
              if (parts.length === 1) return { street: '', house: null, city: parts[0] };
              // Last segment is city. Earlier segments are street/neighborhood.
              const city = parts[parts.length - 1];
              const streetPart = parts.slice(0, -1).join(' ').trim();
              // Try to peel off a trailing house number from streetPart
              const m = streetPart.match(/^(.*?)\s+(\d+[א-ת]?)\s*$/);
              if (m) return { street: m[1].trim(), house: m[2], city };
              return { street: streetPart, house: null, city };
            };
            for (const l of listings) {
              let street = '', house = null, neighborhood = '', city = '';
              if (typeof l.address === 'object' && l.address !== null) {
                const a = l.address;
                if (a.street && typeof a.street === 'object') street = a.street.text || '';
                else if (typeof a.street === 'string') street = a.street;
                if (a.house && typeof a.house === 'object') house = a.house.number;
                else if (a.house_number) house = a.house_number;
                if (a.city && typeof a.city === 'object') city = a.city.text || '';
                else if (typeof a.city === 'string') city = a.city;
                if (a.neighborhood && typeof a.neighborhood === 'object') neighborhood = a.neighborhood.text || '';
                else if (typeof a.neighborhood === 'string') neighborhood = a.neighborhood;
              } else {
                const parsed = parseAddrString(l.address || '');
                street = parsed.street; house = parsed.house; city = parsed.city;
              }
              buckets.private.push({
                token: l.token || null,
                price: l.price || null,
                additionalDetails: { roomsCount: l.rooms || null, squareMeter: l.area_sqm || null, property: null, propertyCondition: null },
                address: {
                  region: {},
                  city: { text: city },
                  area: {},
                  neighborhood: { text: neighborhood },
                  street: { text: street },
                  house: { number: house, floor: l.floor != null ? l.floor : null }
                },
                metaData: {},
                tags: ['sgai_stealth']
              });
            }
            return jsonResp(200, {
              ok: true,
              source: 'sgai_stealth_fallback',
              target_url: targetUrl,
              counts: { private: buckets.private.length, agency: 0, platinum: 0, booster: 0 },
              feed: buckets,
              sgai_request_id: sgData.request_id || null,
            });
          }
          // SG didn't return listings — fall through to the bot_challenge response below
        } catch (e) {
          // SG itself errored; report both
          return jsonResp(503, { error: 'bot_challenge_and_sg_failed', message: 'yad2 ShieldSquare + SG fallback errored: ' + e.message });
        }
      }
      return jsonResp(503, { error: 'bot_challenge', message: 'yad2 returned ShieldSquare', upstream_status: status, sgai_configured: !!sgaiKey });
    }
    if (status !== 200) {
      return jsonResp(502, { error: 'upstream_error', upstream_status: status, body_preview: html.slice(0, 300) });
    }

    if (fmt === 'html') {
      return new Response(html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'X-Proxied-By': 'yad2-proxy-worker-v2',
        }
      });
    }

    // Default: extract NEXT_DATA, return feed only
    const data = extractNextData(html);
    if (!data) {
      return jsonResp(502, { error: 'no_next_data', message: 'NEXT_DATA script tag not found' });
    }
    const buckets = pickFeedBuckets(data);
    return jsonResp(200, {
      ok: true,
      source: 'yad2_next_data',
      target_url: targetUrl,
      counts: {
        private: buckets.private.length,
        agency: buckets.agency.length,
        platinum: buckets.platinum.length,
        booster: buckets.booster.length,
      },
      feed: buckets,
    });
  } catch (err) {
    return jsonResp(500, { error: 'fetch_failed', message: err.message });
  }
}
