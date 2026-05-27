/**
 * Path B — Anthropic Haiku 4.5 raw-HTML → JSON.
 *
 * One request per page. Returns { row, usage } where usage carries
 * input_tokens/output_tokens for cost accounting in the runner.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { canonicalize, FIELDS } = require('./schema');

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_HTML_CHARS = 60000; // Haiku 4.5 200k ctx; keep cost predictable

const SYSTEM_PROMPT = `אתה מקבל HTML של עמוד מודעת דירה מאתר komo.co.il (עברית).
חלץ את הפרטים והחזר JSON תקני בלבד — בלי טקסט נוסף, בלי markdown, בלי backticks.

שדות (null אם אינו קיים):
- address: כתובת או שכונה+עיר, כפי שמופיע
- city: שם העיר בלבד (למשל "תל אביב")
- asking_price: מספר שלם בש"ח (ללא פסיקים, ללא סימן ₪)
- rooms: מספר חדרים (יכול להיות עשרוני, למשל 3.5)
- area_sqm: שטח במ"ר, מספר שלם
- floor: מספר קומה (קרקע = 0)
- phone: null (טלפון לא מופיע ב-HTML)
- contact_name: null
- title: תוכן תגית <title> או H1 ראשי
- description: תיאור הנכס, עד 500 תווים
- source_listing_id: מזהה המודעה (modaaNum)

ספק את המזהה כפי שמועבר אליך בשורת ה-"modaaNum" של ההודעה.`;

function buildUserPrompt(html, modaaNum) {
  const trimmed = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
  return `modaaNum: ${modaaNum}\n\nHTML:\n${trimmed}\n\nהחזר JSON בלבד.`;
}

function parseJsonStrict(text) {
  // Defensive: strip fences if model added them despite instructions
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(cleaned);
}

async function extractHaiku(html, modaaNum, opts = {}) {
  const client = new Anthropic({ apiKey: opts.apiKey || process.env.ANTHROPIC_API_KEY });
  const t0 = Date.now();
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(html, modaaNum) }]
  });
  const latency_ms = Date.now() - t0;

  const text = (resp.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();

  let raw = null;
  let parse_error = null;
  try { raw = parseJsonStrict(text); }
  catch (e) { parse_error = e.message; }

  // Ensure all schema keys are present even on parse failure
  const skeleton = Object.fromEntries(FIELDS.map(f => [f, null]));
  const merged = raw ? { ...skeleton, ...raw, source_listing_id: modaaNum } : skeleton;
  if (!raw) merged.source_listing_id = modaaNum;
  const row = canonicalize(merged);

  return {
    row,
    raw_text: text,
    parse_error,
    latency_ms,
    usage: {
      input_tokens: resp.usage?.input_tokens || 0,
      output_tokens: resp.usage?.output_tokens || 0
    },
    model: MODEL
  };
}

// Haiku 4.5 published rates: $1/MTok input, $5/MTok output
function estimateCostUSD(usage) {
  const inUsd = (usage.input_tokens / 1_000_000) * 1.0;
  const outUsd = (usage.output_tokens / 1_000_000) * 5.0;
  return inUsd + outUsd;
}

module.exports = { extractHaiku, estimateCostUSD, MODEL };
