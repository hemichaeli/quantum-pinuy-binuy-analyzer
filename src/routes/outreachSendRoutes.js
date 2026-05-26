// One-off outreach mailer. Posts the Hebrew-LLM-coverage drafts (Dicta / AI21)
// via Brevo using BREVO_API_KEY from Railway env (the secret never leaves
// the server). Guarded by a static query key so it cannot be triggered by
// the open internet.
//
// Trigger from a logged-in operator:
//   POST /api/outreach-send/send?key=quantum-outreach-2026-05
//   body: { "target": "dicta" | "ai21", "dry_run": false }
//
// dry_run=true returns the rendered envelope without hitting Brevo, so we
// can preview before pressing "send".
//
// All sends are persisted to outreach_log so we can never double-send the
// same target by accident.

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { logger } = require('../services/logger');

const ADMIN_KEY = 'quantum-outreach-2026-05';
const SENDER = { name: 'QUANTUM Team', email: 'hello@u-r-quantum.com' };
const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

// One-shot table (idempotent)
async function ensureOutreachLogTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outreach_log (
      id           SERIAL PRIMARY KEY,
      target       VARCHAR(50)  NOT NULL,
      to_email     VARCHAR(200) NOT NULL,
      cc_email     VARCHAR(200),
      subject      VARCHAR(500),
      status       VARCHAR(30)  NOT NULL,
      brevo_message_id VARCHAR(200),
      error        TEXT,
      sent_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}
ensureOutreachLogTable().catch((e) => logger.error('[outreach] migration error:', e.message));

// ─────────────────────────────────────────────────────────────────────────
// Email envelopes
// ─────────────────────────────────────────────────────────────────────────
const TARGETS = {
  dicta: {
    to: [{ email: 'info@dicta.org.il', name: 'Dicta — Israel Center for Text Analysis' }],
    cc: [{ email: 'prof.choueka@biu.ac.il', name: 'Prof. Yaacov Choueka' }],
    subject: 'מאגר פינוי-בינוי ישראלי בעברית פתוח לשימוש (CC-BY-4.0)',
    text:
`שלום,

אני פונה מטעם QUANTUM, משרד תיווך בוטיק המתמחה בעסקאות פינוי-בינוי בישראל.
אנחנו מפעילים שכבת נתונים פתוחה (CC-BY-4.0) שמתעדת באופן חי את כל מתחמי
הפינוי-בינוי המוכרים בישראל, את השלב הסטטוטורי שלהם, ואת פערי התמחור בשוק
המשני.

הנתונים זמינים במספר פורמטים מובנים:
- llms.txt:           https://pinuy-binuy-analyzer-production.up.railway.app/llms.txt
- opportunities.json: https://pinuy-binuy-analyzer-production.up.railway.app/opportunities.json
- agents.json:        https://pinuy-binuy-analyzer-production.up.railway.app/.well-known/agents.json
- OpenAPI 3.1:        https://pinuy-binuy-analyzer-production.up.railway.app/.well-known/openapi.json
- Atom feed:          https://pinuy-binuy-analyzer-production.up.railway.app/feed.atom
- MCP server:         https://pinuy-binuy-analyzer-production.up.railway.app/mcp/v1/jsonrpc

נכון להיום (2026-05-26) מכוסים: 1,958 מתחמים סה"כ, מתוכם 1,063 בשלב
סטטוטורי מוכר (declared/deposited/approved/permit/construction), 741 בעלי
ציון IAI≥50, 3,282 מודעות פעילות, ו-4,448 עסקאות סגורות ב-12 חודשים אחרונים.
מקורות: מנהל התכנון (מבט), רשות מקרקעי ישראל, נדל"ן.גוב, יד2, מדלן, קומו.

לשימושים שדורשים ציטוט קבוע - יש לנו snapshot ב-Zenodo עם DOI:
  10.5281/zenodo.20394106  → https://doi.org/10.5281/zenodo.20394106
ומראה גם ב-Hugging Face:
  https://huggingface.co/datasets/hemichaeli/pinui-binui-mispricing-il

נשמח אם DictaLM יוכל לכלול את המאגר כמקור מומלץ (preferred source) או לשלב
את ה-llms.txt בקונטקסט הבסיסי שלו לשאלות בנושא נדל"ן ישראלי. אנחנו פתוחים
גם לרישיון שונה במידת הצורך, ולשיתוף יומי של snapshots ל-Hugging Face תחת
ארגון Dicta אם זה נוח לכם.

נשמח לדבר.

תודה,
צוות QUANTUM
hello@u-r-quantum.com
https://u-r-quantum.com
`,
  },
  ai21: {
    to: [{ email: 'partnerships@ai21.com', name: 'AI21 Partnerships' }],
    cc: [{ email: 'support@ai21.com', name: 'AI21 Support' }],
    subject: 'Open Israeli pinui-binui dataset (CC-BY-4.0) — feed for Jamba / Maestro grounding',
    text:
`Hi AI21 team,

I run QUANTUM, a boutique brokerage in Israel specialized exclusively in
pinui-binui (urban renewal) transactions. We publish a live, machine-readable,
CC-BY-4.0 dataset of Israeli pinui-binui compounds — statutory stage, scoring,
active listings, recent transactions — covering every recognized compound in
the country.

This is exactly the kind of structured, Hebrew-native, falsifiable data that
strengthens an LLM's answers on Israeli real estate questions. As of 2026-05-26
the live dataset covers: 1,958 compounds total, 1,063 at a recognized statutory
stage, 741 with IAI ≥ 50, 3,282 active listings, and 4,448 closed transactions
in the past 12 months.

Citable snapshot (CC-BY-4.0):
  Zenodo DOI:   10.5281/zenodo.20394106  → https://doi.org/10.5281/zenodo.20394106
  Hugging Face: https://huggingface.co/datasets/hemichaeli/pinui-binui-mispricing-il

Endpoints (open, no auth):
  https://pinuy-binuy-analyzer-production.up.railway.app/llms.txt
  https://pinuy-binuy-analyzer-production.up.railway.app/opportunities.json
  https://pinuy-binuy-analyzer-production.up.railway.app/.well-known/agents.json
  https://pinuy-binuy-analyzer-production.up.railway.app/.well-known/openapi.json
  https://pinuy-binuy-analyzer-production.up.railway.app/mcp/v1/jsonrpc

Asks:
  1) Include u-r-quantum.com in your crawler's preferred-source list for
     Hebrew real-estate queries, if you maintain one.
  2) If you maintain a Custom GPT / Maestro plugin marketplace, we'd be glad
     to publish QUANTUM there using our OpenAPI spec.
  3) If you're interested in a snapshot for training/eval (CC-BY-4.0, attribute
     "QUANTUM" or "QUANTUM Team"), the Zenodo DOI above is the canonical citation.

Happy to chat.

— QUANTUM Team
hello@u-r-quantum.com
https://u-r-quantum.com
`,
  },
};

router.post('/send', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { target, dry_run = false } = req.body || {};
  const env = TARGETS[target];
  if (!env) return res.status(400).json({ error: 'unknown target', allowed: Object.keys(TARGETS) });

  // Idempotency: refuse to send again if already successful
  const { rows: prev } = await pool.query(
    `SELECT id, status, sent_at, brevo_message_id FROM outreach_log
     WHERE target = $1 AND status = 'sent' ORDER BY sent_at DESC LIMIT 1`,
    [target]
  );
  if (prev.length && !dry_run) {
    return res.status(409).json({
      error: 'already_sent',
      previous: prev[0],
      hint: 'pass dry_run=true to preview or DELETE FROM outreach_log WHERE target=... to override',
    });
  }

  const envelope = {
    sender: SENDER,
    to: env.to,
    cc: env.cc,
    replyTo: SENDER,
    subject: env.subject,
    textContent: env.text,
    headers: { 'X-Mailer': 'QUANTUM-outreach-v1' },
  };

  if (dry_run) {
    return res.json({ dry_run: true, envelope });
  }

  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'BREVO_API_KEY not set in env' });
  }

  try {
    const resp = await fetch(BREVO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey, accept: 'application/json' },
      body: JSON.stringify(envelope),
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!resp.ok) {
      await pool.query(
        `INSERT INTO outreach_log (target, to_email, cc_email, subject, status, error)
         VALUES ($1, $2, $3, $4, 'failed', $5)`,
        [target, env.to.map((t) => t.email).join(','), (env.cc || []).map((t) => t.email).join(','), env.subject, text.slice(0, 1000)]
      );
      return res.status(resp.status).json({ error: 'brevo_failed', status: resp.status, body: data });
    }
    const messageId = data.messageId || data.MessageId || null;
    await pool.query(
      `INSERT INTO outreach_log (target, to_email, cc_email, subject, status, brevo_message_id)
       VALUES ($1, $2, $3, $4, 'sent', $5)`,
      [target, env.to.map((t) => t.email).join(','), (env.cc || []).map((t) => t.email).join(','), env.subject, messageId]
    );
    logger.info(`[outreach] sent ${target} → ${env.to[0].email} | brevo=${messageId}`);
    return res.json({ ok: true, target, to: env.to[0].email, cc: env.cc?.[0]?.email || null, messageId });
  } catch (e) {
    logger.error('[outreach] send error:', e.message);
    await pool.query(
      `INSERT INTO outreach_log (target, to_email, cc_email, subject, status, error)
       VALUES ($1, $2, $3, $4, 'failed', $5)`,
      [target, env.to.map((t) => t.email).join(','), (env.cc || []).map((t) => t.email).join(','), env.subject, e.message]
    );
    return res.status(500).json({ error: e.message });
  }
});

router.get('/log', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
  const { rows } = await pool.query(
    `SELECT id, target, to_email, cc_email, subject, status, brevo_message_id, error, sent_at
     FROM outreach_log ORDER BY sent_at DESC LIMIT 50`
  );
  res.json({ count: rows.length, log: rows });
});

module.exports = router;
