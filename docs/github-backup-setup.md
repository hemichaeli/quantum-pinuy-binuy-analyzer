# GitHub Backup Token — Renewal

The `[Backup] ❌ Cannot access backup repo: GitHub API error 401: Bad credentials`
log line means `GITHUB_BACKUP_TOKEN` in Railway is rejected by GitHub. The token
either expired or was revoked. Generate a new one and update Railway env.

## 1. Generate a new fine-grained PAT

1. Open https://github.com/settings/tokens?type=beta
2. **Generate new token**
3. **Token name:** `quantum-backup-railway` (anything works)
4. **Expiration:** 1 year (or "No expiration" if you don't want to rotate)
5. **Repository access:** Only select repositories → `hemichaeli/pinuy-binuy-backups`
6. **Permissions:**
   - Repository → **Contents**: **Read and write**
   - Repository → **Metadata**: **Read** (auto-selected)
7. **Generate token** — copy the `github_pat_...` value (shown once).

## 2. Update Railway env var

Either via the dashboard:
- https://railway.com/project/145d8345-978c-4abb-a792-a46ece2f1b9f
- Service `pinuy-binuy-analyzer` → Variables → `GITHUB_BACKUP_TOKEN` → paste new value → Save

Or via CLI / MCP (replace `<NEW_TOKEN>`):
```
mcp__railway__set_variable
  projectId: 145d8345-978c-4abb-a792-a46ece2f1b9f
  environmentId: ac35918c-66aa-405e-871e-fce81f8f81b9
  serviceId: e827f187-00fa-498e-9fc0-26d85beabf5e
  name: GITHUB_BACKUP_TOKEN
  value: <NEW_TOKEN>
```

## 3. Verify

After Railway redeploys (~60s):

```bash
curl -X POST "https://pinuy-binuy-analyzer-production.up.railway.app/api/backup/github/create"
```

Expected: `{"success":true,...}` plus a new commit on `hemichaeli/pinuy-binuy-backups`
under `backups/YYYY-MM-DD/HH-mm-ss/`. The hourly cron at `5 * * * *` will then
take over automatically.
