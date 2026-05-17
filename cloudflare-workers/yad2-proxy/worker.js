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
      return jsonResp(503, { error: 'bot_challenge', message: 'yad2 returned ShieldSquare', upstream_status: status });
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
