# QUANTUM — Claude Project Instructions

> **This file is loaded automatically at the start of every Claude chat in this project.**
> Read it fully before doing anything else.

---

## 🗂️ Issues Tracker — Source of Truth

All tasks and their status live here:
**https://github.com/hemichaeli/claude-issues-tracker/tree/main/pinuy-binuy-analyzer/issues/**

Local path (already cloned): `/home/ubuntu/claude-issues-tracker/pinuy-binuy-analyzer/issues/`

### Rules — mandatory for every response:

**1. Start of every chat — pull tracker and read state:**
```bash
cd /home/ubuntu/claude-issues-tracker && git pull
cat pinuy-binuy-analyzer/HANDOFF.md 2>/dev/null | tail -5  # read last handoff if exists
ls pinuy-binuy-analyzer/issues/
```

**2. After completing any subtask — update tracker:**
```bash
echo "| $(date '+%Y-%m-%d %H:%M') | [what you did] |" >> /home/ubuntu/claude-issues-tracker/pinuy-binuy-analyzer/issues/[NUMBER].md
cd /home/ubuntu/claude-issues-tracker && git add -A && git commit -m "progress: #[NUMBER] [summary]" && git push
```

**3. When closing an issue:**
```bash
sed -i 's/\*\*Status:\*\* open/**Status:** ✅ closed/' /home/ubuntu/claude-issues-tracker/pinuy-binuy-analyzer/issues/[NUMBER].md
echo "| $(date '+%Y-%m-%d %H:%M') | ✅ CLOSED |" >> /home/ubuntu/claude-issues-tracker/pinuy-binuy-analyzer/issues/[NUMBER].md
cd /home/ubuntu/claude-issues-tracker && git add -A && git commit -m "closed: #[NUMBER]" && git push
gh issue close [NUMBER] -R hemichaeli/pinuy-binuy-analyzer
```

**4. Priority order:** Work issues from lowest number to highest, unless labeled `P0` (do first).

---

## 🔄 /handoff — Context Limit & Manual Handoff

Use `/handoff` when:
- The conversation is getting very long (approaching context limit)
- You want to start fresh while keeping all context
- The user types `/handoff`

**How to execute /handoff:**

```bash
# 1. Write handoff summary to tracker
cat >> /home/ubuntu/claude-issues-tracker/pinuy-binuy-analyzer/HANDOFF.md << 'EOF'
| $(date '+%Y-%m-%d %H:%M') | [SUMMARY: what was done, what's in progress, what's next] |
EOF
cd /home/ubuntu/claude-issues-tracker && git add -A && git commit -m "handoff: [summary]" && git push
```

Then say exactly:
```
HANDOFF_READY: [one-line summary of current state and next task]
```

The monitor will automatically start a new conversation with full tracker context.

**When starting after a handoff:**
1. Read `HANDOFF.md` for the last session summary
2. Read all open issue files to know current state
3. Continue from exactly where the last session left off

---

## 🏗️ Project Stack

| Component | Details |
|-----------|---------|
| **Runtime** | Node.js 18 |
| **Database** | PostgreSQL on Railway |
| **Deployment** | Railway (auto-deploy on push to `main`) |
| **Backend URL** | https://pinuy-binuy-analyzer-production.up.railway.app |
| **Dashboard** | https://quantum-dashboard-production.up.railway.app |
| **WhatsApp** | INFORU API (credentials in Railway env vars) |
| **Auto-dialer** | Vapi API (assistantId: `quantum_cold_prospecting`) |
| **Repo** | https://github.com/hemichaeli/pinuy-binuy-analyzer |

---

## 🔄 Git Workflow

After every completed feature:
```bash
git add -A && git commit -m "feat: [description]" && git push
```
Wait ~90s then verify: `curl -s https://pinuy-binuy-analyzer-production.up.railway.app/health`

---

## 📋 Scraper Template

Every new scraper must include:
- `src/scrapers/[name]Scraper.js` — scraper logic
- `src/routes/[name]Routes.js` — API routes
- DB migration in `migrations/` — table with: `id, url, title, price, rooms, city, phone, source, created_at, whatsapp_sent, called`
- Daily cron in `src/cron/[name]Cron.js`
- Auto-WhatsApp via INFORU after finding new listing with phone
- Auto-dialer: check `phone_calls` table → if not called → insert + call Vapi
- Dashboard tab in frontend

---

## 📞 Auto-Dialer Integration

```javascript
const existing = await db.query('SELECT id FROM phone_calls WHERE phone=$1 AND lead_source=$2', [phone, source]);
if (existing.rows.length === 0) {
  await db.query('INSERT INTO phone_calls (phone, lead_source, status) VALUES ($1, $2, $3)', [phone, source, 'pending']);
  await fetch('https://api.vapi.ai/call', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.VAPI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      assistantId: 'quantum_cold_prospecting',
      customer: { number: phone },
      metadata: { lead_source: source }
    })
  });
}
```
