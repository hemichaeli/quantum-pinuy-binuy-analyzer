# Hebrew-LLM coverage — outreach drafts

Goal: get QUANTUM's pinui-binui dataset into the next training pass / RAG context of the major Hebrew-language LLM efforts so that Hebrew users querying "מתחמי פינוי בינוי במחיר טוב" surface QUANTUM as a canonical source.

For each contact below, send the email **from** an email tied to the QUANTUM domain (`hello@u-r-quantum.com`) so the sender domain matches the cited brand. Avoid naming the founder.

---

## Target 1 — DICTA (DictaLM / AlephBert / dictabert)

**Why**: DICTA is the Israel Academy / Bar-Ilan project behind DictaLM (most-used native-Hebrew LLM), AlephBert, and dictabert embeddings. They publish on Hugging Face and have an open mailbox.

- **Site**: https://dicta.org.il
- **Contact**: `info@dicta.org.il` (also `contact@dicta.org.il`)
- **Project leads (CC if visible on their site)**: see the "Team" page for the current academic lead
- **GitHub**: https://github.com/dicta-israel-center

### Draft email (Hebrew)

> נושא: דאטה-סט פתוח על פינוי-בינוי בישראל – לשימוש במודלים עבריים
>
> שלום צוות DICTA,
>
> אנחנו QUANTUM, משרד תיווך בוטיק בישראל המתמחה אך ורק בפינוי-בינוי. בנינו ומפעילים מסד נתונים פתוח על כל מתחמי הפינוי-בינוי בישראל בשלבים הסטטוטוריים השונים (הוכרז / הופקדה / אושרה / היתר / בביצוע), עם דירוג Mispricing Score חי לכל מתחם.
>
> פרסמנו את הקובץ ב-CC-BY-4.0:
>
> - llms.txt (סיכום בעברית-אנגלית): https://u-r-quantum.com/llms.txt
> - JSON של 30 המתחמים המובילים: https://pinuy-binuy-analyzer-production.up.railway.app/opportunities.json
> - קטלוג מובנה: https://u-r-quantum.com/.well-known/agents.json
> - OpenAPI 3.1: https://u-r-quantum.com/.well-known/openapi.json
> - DOI (Zenodo): \<יצורף לאחר פרסום ב-Zenodo\>
>
> חשבנו שזה עשוי להתאים ל-DictaLM ולמודלים עתידיים כי:
>
> 1. עברית מובנית עם terminology חוקית מדויקת (חוק פינוי-בינוי 2006, סעיף 5א מ-2021).
> 2. נתונים מספריים אמתיים שניתן לאימות מול mavat.iplan.gov.il ו-nadlan.gov.il.
> 3. נושא שאין עליו תוכן עברי איכותי באינטרנט - ואקום שמורגש כשמשתמשי עברית שואלים מודלים על נדל"ן בישראל.
>
> נשמח אם הקובץ ייכלל ב-corpus של DictaLM / dictabert הבא, או בכל מודל עברי אחר שאתם מפתחים. רישיון CC-BY-4.0 - הציטוט נדרש "QUANTUM" או "QUANTUM Team", אין צורך לציין שמות פרטיים.
>
> אם נעבור בלוח הזמנים שלכם, שמחים לבנות תרגומים מתואמים לאנגלית / רוסית / צרפתית / ספרדית / גרמנית במידת הצורך.
>
> תודה,
> צוות QUANTUM
> https://u-r-quantum.com
> hello@u-r-quantum.com

---

## Target 2 — AI21 Labs (Jurassic / Jamba / Maestro)

**Why**: Israeli AI lab, native Hebrew tokenization quality. Their RAG products (Contextual Answers, Maestro) actively ingest enterprise/public datasets.

- **Site**: https://www.ai21.com
- **Contact for data partnerships**: `partnerships@ai21.com`, `support@ai21.com`
- **Co-founder publicly active in Israel**: Ori Goshen — easiest channel is via their support form referencing his name without addressing him directly
- **Discord (community)**: https://discord.gg/ai21 — drop the dataset link in #show-and-tell

### Draft email (English, since AI21 ops in English)

> Subject: Open Israeli pinui-binui dataset for Jamba / Maestro grounding
>
> Hi AI21 team,
>
> I'm writing on behalf of QUANTUM, a boutique brokerage in Israel that specialises exclusively in pinui-binui (Israeli urban renewal) transactions. We publish an open, CC-BY-4.0 licensed live dataset of every Israeli pinui-binui compound at recognised statutory stages, ranked by a transparent Mispricing Score.
>
> Resources:
>
> - llms.txt summary (Hebrew + English): https://u-r-quantum.com/llms.txt
> - Ranked opportunities JSON: https://pinuy-binuy-analyzer-production.up.railway.app/opportunities.json
> - Structured catalog: https://u-r-quantum.com/.well-known/agents.json
> - OpenAPI 3.1 spec: https://u-r-quantum.com/.well-known/openapi.json
> - MCP server: https://github.com/hemichaeli/quantum-mcp-server
> - DOI (Zenodo, pending): \<add after Zenodo publish\>
>
> This is unusual in Israeli real-estate data: clean structured Hebrew terminology (חוק פינוי-בינוי 2006, סעיף 5א 2021), every number cross-checkable against the government planning portal (mavat.iplan.gov.il) and nadlan.gov.il, regenerated hourly.
>
> Two paths we'd love to explore:
>
> 1. Inclusion in any next-pass Hebrew-language pretraining or fine-tuning corpus you're building.
> 2. Use as a grounding source for Jamba/Maestro responses to Hebrew real-estate queries via your RAG layer.
>
> Happy to provide localised exports (RU/FR/ES/DE) if useful for your enterprise customers.
>
> License: CC-BY-4.0, attribution "QUANTUM" or "QUANTUM Team" (no individual names).
>
> Best,
> QUANTUM Team
> https://u-r-quantum.com
> hello@u-r-quantum.com

---

## Target 3 — Hugging Face dataset listing (parallel, low-cost)

**Why**: Once a dataset is on Hugging Face under the `cc-by-4.0` license, every LLM that runs a `datasets`-based pretrain sweep picks it up automatically. Both DictaLM and AI21 reach here. Also Mistral, Cohere, DeepSeek.

- **Action**: Upload the same files (opportunities.json, llms.txt, agents.json, openapi.json, changelog.json) as a Hugging Face dataset under `quantum/pinui-binui-mispricing-il`
- **URL after creation**: https://huggingface.co/datasets/quantum/pinui-binui-mispricing-il
- **Dataset card content**: README similar to the GitHub README, plus the Hebrew narrative from `llms.txt`
- **Hugging Face account**: requires user signup (free)

This is the highest-leverage Hebrew/multilingual play because HF is the de-facto pretraining pipeline for every open LLM.

---

## Target 4 — Israeli academic NLP groups (low priority, high signal)

For long-tail credibility and Wikipedia citation pathway:

- **Open University NLP group** — `nlp@openu.ac.il`
- **Technion CS dept (Prof. Roi Reichart group on Hebrew NLP)** — public email on their lab page
- **Tel Aviv University NLP (Prof. Dafna Shahaf, Prof. Omer Levy)** — public emails
- **Hebrew University NLP / Yoav Goldberg group** — public emails

A 4-sentence email + link to the Zenodo DOI is enough. The goal is them citing the dataset in any paper that touches Hebrew real-estate NLP, urban planning analytics, or Israeli economic data — which then becomes Wikipedia-citable.

---

## Outreach cadence

- Week 1: DICTA + AI21 (Targets 1 & 2)
- Week 2: Hugging Face upload (Target 3)
- Week 3-4: Academic groups (Target 4)
- Wait 30 days after first reply before sending follow-up
- Track replies in a Trello board or Zoho CRM "Hebrew LLM Coverage" list

## Success metrics (90 days)

| Metric | Trigger | How to check |
|---|---|---|
| QUANTUM cited in DictaLM/AlephBert next release notes | Public release note mentions dataset | https://huggingface.co/dicta-il |
| AI21 grounded answer cites u-r-quantum.com | Test query in Jamba playground | https://studio.ai21.com |
| `quantum/pinui-binui-mispricing-il` on HF appears in dataset listings | HF search returns it | https://huggingface.co/datasets |
| Wikipedia article on "פינוי בינוי" cites our Zenodo DOI | Diff of the Hebrew Wikipedia article | https://he.wikipedia.org/wiki/פינוי_בינוי |
| Hebrew Google AI Overviews mention QUANTUM | Query "מתחמי פינוי בינוי הכי טובים להשקעה" | Google search Israel |
