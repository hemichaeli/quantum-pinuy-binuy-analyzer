# yad2-proxy (Cloudflare Worker)

Tiny edge proxy that lets the Railway-hosted scraper reach yad2.co.il. yad2
blocks Railway egress IPs (ShieldSquare anti-bot) but trusts Cloudflare IPs.

## v2 (current) vs v1

| | v1 (2026-03) | v2 (2026-05) |
|---|---|---|
| Upstream | `gw.yad2.co.il/feed-search-legacy/realestate/forsale` | `www.yad2.co.il/realestate/forsale` |
| Upstream status | **404 dead** since ~2026-04 | 200, server-renders listings |
| Response shape | Yad2 legacy JSON | NEXT_DATA feed (private/agency/platinum/booster) |
| Default format | JSON | JSON (`?format=html` for raw passthrough) |

## Deploy

```bash
cd cloudflare-workers/yad2-proxy
npx wrangler login       # browser flow, one-time
npx wrangler deploy
```

Then in the Cloudflare dashboard:
- **Workers & Pages → yad2-proxy → Settings → Triggers**
- Enable the `workers.dev` preview URL. This produces a URL like
  `https://yad2-proxy.<account-subdomain>.workers.dev`.

Then in Railway → `pinuy-binuy-analyzer` service → Variables:
```
YAD2_PROXY_URL=https://yad2-proxy.<account-subdomain>.workers.dev
```

`yad2Scraper.js` (in `src/services/yad2Scraper.js`) reads `YAD2_PROXY_URL`
and routes its NEXT_DATA fetches through this Worker.

## Test

```bash
curl "https://yad2-proxy.<account-subdomain>.workers.dev/health"
# → { "status": "ok", "worker": "yad2-proxy", "version": "v2", ... }

curl "https://yad2-proxy.<account-subdomain>.workers.dev?city=5000&page=1&key=pinuy-binuy-2026" | jq '.counts'
# → { "private": 20, "agency": 20, "platinum": 3, "booster": 1 }
```

If `counts` reports >0 items, the proxy is healthy and the scraper will
pick up yad2 listings on the next cron run.

## Shared secret

The `key=` query param must equal `pinuy-binuy-2026` (set in `worker.js`).
This is light protection — anyone scanning workers.dev wouldn't burn your
Cloudflare quota. The shared secret value is identical to v1, so existing
clients still authenticate.
