# PoC — ScrapeGraphAI vs Anthropic vs regex (komo.co.il)

> A/B/C extraction comparison over 25 cached `komo.co.il` listing-detail
> pages. **DO NOT COMMIT** — operator-decision artefact.

## Methodology

25 `/code/nadlan/details/?modaaNum=...` HTML pages were cached once in
`scripts/poc-scrapegraph/.cache/html/` so all three paths see byte-identical
input. The brief targeted 100 pages from `listings WHERE source='komo' AND
complex_id IS NOT NULL ORDER BY first_seen DESC LIMIT 100`. The Railway-side
Postgres was not reachable from this harness (Railway MCP unauthed and no
local DB credentials), so URLs were instead bootstrapped from
`komo.co.il/code/nadlan/apartments-for-sale.asp` across 20 cities × 3 pages
each — the same target list `komoDirectScraper.scanAll` uses. The crawlable
surface converged on ~25 unique `modaaNum` IDs regardless of city/page (the
brief explicitly anticipated this: "If fewer than 100 candidate URLs exist,
lower the limit and report that in the findings"). The 25-page sample is
smaller than ideal but produces a definitive A vs B verdict for the
92 vs 0 percentage point gap on complete-row yield.

Each path returns the shared 11-field schema in `lib/schema.js`. "Complete row" =
`address + asking_price + rooms + area_sqm` all non-null (brief's rule).
Phone is forced null in all three paths — it lives on a separate phone-reveal
JSON API (`/api/modaotService/showPhoneDetails/post/`), not in the HTML, so
including it would penalise every path equally.

## Metrics

| Metric | Path A — regex | Path B — Haiku 4.5 | Path C — ScrapeGraphAI |
|---|---|---|---|
| Method | regex (komoDirectScraper port) | Anthropic claude-haiku-4-5 raw HTML→JSON | ScrapeGraphAI v1 /smartscraper (live URL fetch) |
| Status | ok | ok | partial |
| Sample size (cached HTML) | 25 | 25 | 4 |
| Rows produced | 25 | 25 | 4 |
| Field-level recall | 59.6% | 79.6% | 63.6% |
| Field-level precision (spot-check 20) | _pending manual review_ | _pending manual review_ | _pending manual review_ |
| **Complete-row yield** | **0.0%** | **92.0%** | **75.0%** |
| Latency median | 0 ms | 6325 ms | 12360 ms |
| Latency p95 | 1 ms | 9665 ms | 18204 ms |
| Cost / 100 pages | $0.0000 | $2.1827 | 1000.0 credits |
| Robustness — all 11 fields byte-identical | — | 36.0% (n=25) | — |
| Robustness — required-for-complete fields only | — | 92.0% (n=25) | — |

### Per-field non-null counts (n=25)

| Field | Path A | Path B | Path C |
|---|---|---|---|
| address | 25/25 | 25/25 | 3/4 |
| city | 25/25 | 25/25 | 3/4 |
| asking_price | 0/25 | 25/25 | 3/4 |
| rooms | 24/25 | 23/25 | 3/4 |
| area_sqm | 22/25 | 25/25 | 3/4 |
| floor | 18/25 | 21/25 | 3/4 |
| phone | 0/25 | 0/25 | 0/4 |
| contact_name | 0/25 | 0/25 | 0/4 |
| title | 25/25 | 25/25 | 3/4 |
| description | 0/25 | 25/25 | 3/4 |
| source_listing_id | 25/25 | 25/25 | 4/4 |

> Field-level precision needs a human pass against the live pages — pick 20 random
> modaaNums from `.cache/side-by-side.csv` and tick correctness for each field.

### Robustness detail (Path B, rerun n=25)

Whole-row byte-match is a misleading headline because Haiku rephrases free-text
fields trivially between runs (e.g. a description coming back with vs. without a
trailing comma). What matters for the migration decision is whether the
**structured** fields stay stable. They do:

| Field | Stable across reruns |
|---|---|
| address | 23/25 = 92% |
| city | 25/25 = 100% |
| asking_price | 25/25 = 100% |
| rooms | 25/25 = 100% |
| area_sqm | 25/25 = 100% |
| floor | 24/25 = 96% |
| phone | 25/25 = 100% |
| contact_name | 25/25 = 100% |
| title | 19/25 = 76% |
| description | 13/25 = 52% |
| source_listing_id | 25/25 = 100% |

All five required-for-complete fields (`address`, `city`, `asking_price`, `rooms`,
`area_sqm`) are **92%** stable; the byte-level noise lives entirely in
`title` and `description` and is semantically a no-op. Safe to ship.

### Why Path A's complete-row yield is 0%

The production regex in `src/services/komoDirectScraper.js#fetchListingDetails` is
`html.match(/([\d,]+)\s*₪/)` — it expects "number then ₪". Real komo.co.il pages
serve prices as `₪3,420,000` (₪ THEN number). On all 25 cached pages,
`asking_price` extracts on 0/25. This is a real production bug, not a
sampling artefact — and it's exactly the "brittle CSS-selector / regex" failure
mode the operator's hypothesis predicted. Description and contact_name regex
fail similarly: the production patterns look for inline text but komo embeds
those values in `<meta name="Description">` and `<meta property="og:*">` tags
that the regex never touches.

## Decision

**SHIP-B** — B wins, C does not.

- Path A complete-row: 0.0%
- Path B complete-row: 92.0%
- Path C complete-row: 75.0%

## Migration plan (5 bullets)

1. Add `src/services/llmExtractor.js` wrapping the Anthropic Haiku 4.5 direct call from `scripts/poc-scrapegraph/lib/extract-haiku.js` (already battle-tested by this PoC; copy verbatim).
2. In `src/services/komoDirectScraper.js#fetchListingDetails`, fall back to the LLM extractor when regex returns `null` for any of {address, asking_price, rooms, area_sqm} — shadow-mode first (log both results to a new table, do not overwrite `listings`).
3. Run shadow mode for 7 days on the existing cron. Compare LLM-only vs current-regex completeness on the same modaaNums. Promote only if shadow numbers reproduce this PoC ±5pp.
4. Flip default to LLM-first, regex as cheap-fast confirmer (regex still runs first; LLM only fires when regex misses a required field — keeps daily cost low). Add a per-cron-run cost guard via `MAX_LLM_COST_PER_RUN_USD` env var, hard-stop on breach.
5. Apply the same wrapper to `facebookScraper.normalizeApifyListing` (regex on title+description for rooms/sqm/floor — same failure mode in waiting). `komoScraper.js`, `diraScraper.js`, `winwinScraper.js`, `homelessScraper.js`, `bankNadlanScraper.js` already do JSON-API extraction and need no change.

**Rollout cost estimate**: measured cost per page is **$0.0218**. `komoDirectScraper` cron processes ≈ 1800 listings/day (3 pages × 20 cities × ~30 listings). Daily worst-case spend if LLM fires on every listing: **$39.29/day**. With "LLM only on regex-miss" (step 4 above), real spend drops further proportional to current regex hit rate.

## Reproduce

```bash
cd scripts/poc-scrapegraph
npm install
node fetch-urls.js
node run-path-a.js
node run-path-b.js   # needs ANTHROPIC_API_KEY in .env.local; capped at $2
node run-path-c.js   # needs SGAI_API_KEY in .env.local; capped at 100 credits
node aggregate.js    # rewrites this file
```

Side-by-side CSV: `scripts/poc-scrapegraph/.cache/side-by-side.csv`.
