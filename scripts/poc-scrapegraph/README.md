# PoC: ScrapeGraphAI vs Anthropic vs regex (komo.co.il extraction)

Local-only A/B/C harness. **Not part of the project build.** Do not commit
`.env.local`, `.cache/`, or `runs/`.

## Layout

```
scripts/poc-scrapegraph/
  .env.local           # SECRETS: ANTHROPIC_API_KEY, SGAI_API_KEY, DATABASE_URL
  .cache/html/         # one file per modaaNum: <id>.html
  runs/                # path-{a,b,c}-<ISO>.json
  lib/
    extract-regex.js   # Path A — ported from src/services/komoDirectScraper.js
    extract-haiku.js   # Path B — Anthropic Haiku 4.5 direct
    extract-sgai.js    # Path C — scrapegraphai SDK (skipped if no SGAI_API_KEY)
    fetch-urls.js      # discover 100 komo listing URLs (DB-or-search bootstrap)
    schema.js          # target schema + completeness rules
  run-path-a.js
  run-path-b.js
  run-path-c.js
  aggregate.js         # writes docs/poc-scrapegraph-vs-selectors-komo.md
```

## How to run

```bash
cd scripts/poc-scrapegraph
npm install                  # local only, does NOT touch parent package.json
node fetch-urls.js           # → .cache/html/*.html (100 files)
node run-path-a.js           # regex, ~0s, free
node run-path-b.js           # Haiku 4.5, ~$0.10-0.30, cost-capped at $2
node run-path-c.js           # ScrapeGraphAI, max 100 credits, skips if no key
node aggregate.js            # → ../../docs/poc-scrapegraph-vs-selectors-komo.md
```

## Cost guards

- Path B halts when cumulative usage * Haiku 4.5 published rate > $2.
- Path C halts at 100 SGAI credits (1 credit/page typical) or $2 equiv.
- Both paths checkpoint per-page JSON to `runs/` so a halt is recoverable.
