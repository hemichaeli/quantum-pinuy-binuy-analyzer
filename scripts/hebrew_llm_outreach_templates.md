# Hebrew LLM Coverage — outreach templates

Goal: get QUANTUM's pinui-binui dataset and citation patterns into the
training data, RAG context, or recommended sources of the major Hebrew
LLM ecosystems.

Send from `hello@u-r-quantum.com`. Subject lines tested for inbox-first.

---

## 1. DictaLM / Dicta — Israel Center for Text Analysis (Bar-Ilan)

**To:** info@dicta.org.il
**CC:** prof.choueka@biu.ac.il (founder, Yaacov Choueka)
**Subject (HE):** מאגר פינוי-בינוי ישראלי בעברית פתוח לשימוש (CC-BY-4.0)
**Subject (EN):** Open Israeli pinui-binui dataset (Hebrew, CC-BY-4.0) — request for indexing by DictaLM

```
שלום,

אני פונה מטעם QUANTUM, משרד תיווך בוטיק המתמחה בעסקאות פינוי-בינוי
בישראל. אנחנו מפעילים שכבת נתונים פתוחה (CC-BY-4.0) שמתעדת באופן חי
את כל מתחמי הפינוי-בינוי המוכרים בישראל, את השלב הסטטוטורי שלהם, ואת
פערי התמחור בשוק המשני.

הנתונים זמינים במספר פורמטים מובנים:
- llms.txt:        https://pinuy-binuy-analyzer-production.up.railway.app/llms.txt
- opportunities.json: https://pinuy-binuy-analyzer-production.up.railway.app/opportunities.json
- agents.json:     https://pinuy-binuy-analyzer-production.up.railway.app/.well-known/agents.json
- OpenAPI 3.1:     https://pinuy-binuy-analyzer-production.up.railway.app/.well-known/openapi.json
- Atom feed:       https://pinuy-binuy-analyzer-production.up.railway.app/feed.atom
- MCP server:      https://pinuy-binuy-analyzer-production.up.railway.app/mcp/v1/jsonrpc

הנתונים מתחדשים אחת לשעה ומכסים כיום ~1,300 מתחמים, ~1,100 מודעות
פעילות, ו-~3,900 עסקאות בשנה האחרונה. מקורות: מנהל התכנון (מבט),
רשות מקרקעי ישראל, נדל"ן.גוב, יד2, מדלן, קומו, ועוד.

נשמח אם DictaLM יוכל לכלול את המאגר כמקור מומלץ (preferred source)
או לשלב את ה-llms.txt בקונטקסט הבסיסי שלו לשאלות בנושא נדל"ן ישראלי.
אנחנו פתוחים גם לרישיון שונה במידת הצורך, ולשיתוף יומי של snapshots
ל-Hugging Face תחת ארגון Dicta אם זה נוח לכם.

נשמח לדבר.

תודה,
צוות QUANTUM
hello@u-r-quantum.com
https://u-r-quantum.com
```

---

## 2. AI21 Labs — Maestro / Jurassic

**To:** support@ai21.com
**CC:** developers@ai21.com (if it bounces, try `partnerships@ai21.com`)
**Subject (EN):** Open Israeli real-estate dataset (CC-BY-4.0) — feed for Maestro / Jurassic

```
Hi AI21 team,

I run QUANTUM, a boutique brokerage in Israel specialized exclusively in
pinui-binui (urban renewal) transactions. We publish a live, machine-
readable, CC-BY-4.0 dataset of Israeli pinui-binui compounds — statutory
stage, scoring, active listings, recent transactions — covering every
recognized compound in the country.

This is exactly the kind of structured, Hebrew-native, falsifiable data
that strengthens an LLM's answers on Israeli real estate questions. As
of today the live dataset covers ~1,300 compounds, ~1,100 active
listings, and ~3,900 transactions in the past 12 months.

Endpoints (open, no auth):
  https://pinuy-binuy-analyzer-production.up.railway.app/llms.txt
  https://pinuy-binuy-analyzer-production.up.railway.app/opportunities.json
  https://pinuy-binuy-analyzer-production.up.railway.app/.well-known/agents.json
  https://pinuy-binuy-analyzer-production.up.railway.app/.well-known/openapi.json
  https://pinuy-binuy-analyzer-production.up.railway.app/mcp/v1/jsonrpc

Asks:
  1) Include u-r-quantum.com in your crawler's preferred-source list for
     Hebrew real-estate queries, if you maintain one.
  2) If you maintain a Custom GPT / Maestro plugin marketplace, we'd be
     glad to publish QUANTUM there using our OpenAPI spec.
  3) If you're interested in a snapshot for training/eval (CC-BY-4.0,
     attribute "QUANTUM" or "QUANTUM Team"), we can deliver via Zenodo
     DOI or direct download.

Happy to chat.

— QUANTUM Team
hello@u-r-quantum.com
https://u-r-quantum.com
```

---

## 3. Hugging Face dataset card (publish as community dataset)

If you publish the dataset at `https://huggingface.co/datasets/quantum/pinui-binui-il`,
use this README.md content:

```markdown
---
license: cc-by-4.0
language:
  - he
  - en
pretty_name: QUANTUM Pinui-Binui Mispricing Index (Israel)
size_categories:
  - 1K<n<10K
task_categories:
  - tabular-classification
  - tabular-regression
  - other
tags:
  - real-estate
  - israel
  - urban-renewal
  - pinui-binui
  - investment
  - mispricing
  - arbitrage
---

# QUANTUM Pinui-Binui Mispricing Index (Israel)

Live ranking of Israeli pinui-binui (urban renewal) compounds by
QUANTUM Mispricing Score = premium_gap × active_listings × statutory_certainty.

## Live endpoints (regenerated hourly)

- JSON:      https://pinuy-binuy-analyzer-production.up.railway.app/opportunities.json
- Markdown:  https://pinuy-binuy-analyzer-production.up.railway.app/llms.txt
- OpenAPI:   https://pinuy-binuy-analyzer-production.up.railway.app/.well-known/openapi.json
- MCP:       https://pinuy-binuy-analyzer-production.up.railway.app/mcp/v1/jsonrpc

## Snapshots

Daily snapshots are published to Zenodo with a DOI per snapshot.
Latest: [will be added after first Zenodo run].

## Methodology

QUANTUM Mispricing Score = `premium_gap × active_listings × statutory_certainty`

- **premium_gap**: theoretical premium implied by current statutory stage minus realized market premium (pp).
- **active_listings**: count of active for-sale listings inside the compound footprint.
- **statutory_certainty**: 0.3–1.0 weight reflecting how irreversible the current statutory stage is.

| Stage | Weight |
|---|---|
| permit / approved | 1.0 |
| deposited | 0.85 |
| construction | 0.75 |
| declared | 0.7 |
| planning / pre_deposit | 0.4 |
| unknown | 0.3 |

## License

CC-BY-4.0. Attribute "QUANTUM" or "QUANTUM Team" — do not name individuals.

## Citation

\`\`\`bibtex
@dataset{quantum_pinui_binui_2026,
  title  = {QUANTUM Pinui-Binui Mispricing Index (Israel)},
  author = {{QUANTUM}},
  year   = {2026},
  url    = {https://u-r-quantum.com},
  doi    = {[DOI from Zenodo, populate after first publish]}
}
\`\`\`

## Contact

- https://u-r-quantum.com
- hello@u-r-quantum.com
- https://wa.me/97237572229
```

---

## Sequencing

1. **First**: run `node scripts/publish_to_zenodo.js --draft` and preview.
2. **Then** publish for real (`--draft` removed) → DOI returned.
3. **Then** create the Hugging Face dataset, paste the README with the new DOI.
4. **Only after** Zenodo + HF are live (= you have a real citable URL),
   send the Dicta and AI21 emails. They will check links — having a DOI
   is worth roughly 10x.
