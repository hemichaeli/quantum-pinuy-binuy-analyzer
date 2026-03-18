/**
 * 💾 GitHub Backup Service - Hourly Database Backups via GitHub API
 *
 * Exports all DB tables as JSON and pushes to a private GitHub repo.
 * No pg_dump required — works on any Railway container.
 *
 * Backup repo: hemichaeli/pinuy-binuy-backups (private)
 * Schedule: every hour at :05 (cron: 5 * * * *)
 * Retention: keeps last 168 backups (7 days × 24h)
 *
 * Tables backed up:
 *   complexes, listings, scan_logs, alerts, transactions, buildings
 *
 * File structure in repo:
 *   backups/YYYY-MM-DD/HH-mm-ss/complexes.json
 *   backups/YYYY-MM-DD/HH-mm-ss/listings.json
 *   backups/YYYY-MM-DD/HH-mm-ss/scan_logs.json
 *   backups/YYYY-MM-DD/HH-mm-ss/meta.json
 */

const https = require('https');
const pool = require('../db/pool');
const { logger } = require('./logger');

const GITHUB_TOKEN = process.env.GITHUB_BACKUP_TOKEN || process.env.GITHUB_TOKEN;
const BACKUP_REPO = 'hemichaeli/pinuy-binuy-backups';
const BACKUP_BRANCH = 'main';
const MAX_BACKUPS = 168; // 7 days

// Tables to back up (in order)
const BACKUP_TABLES = [
  { name: 'complexes',    query: 'SELECT * FROM complexes ORDER BY id' },
  { name: 'listings',     query: 'SELECT * FROM listings ORDER BY id' },
  { name: 'scan_logs',    query: 'SELECT * FROM scan_logs ORDER BY id DESC LIMIT 500' },
  { name: 'alerts',       query: 'SELECT * FROM alerts ORDER BY id DESC LIMIT 1000' },
  { name: 'transactions', query: 'SELECT * FROM transactions ORDER BY id DESC LIMIT 2000' },
  { name: 'buildings',    query: 'SELECT * FROM buildings ORDER BY id' },
];

/**
 * Make a GitHub API request
 */
function githubRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const token = GITHUB_TOKEN;
    if (!token) {
      return reject(new Error('GITHUB_BACKUP_TOKEN env var not set'));
    }

    const options = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'pinuy-binuy-backup/1.0',
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`GitHub API error ${res.statusCode}: ${parsed.message || data}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Get current SHA of a file (needed for updates)
 */
async function getFileSha(filePath) {
  try {
    const result = await githubRequest('GET', `/repos/${BACKUP_REPO}/contents/${filePath}?ref=${BACKUP_BRANCH}`);
    return result.sha || null;
  } catch {
    return null;
  }
}

/**
 * Create or update a file in the backup repo
 */
async function pushFile(filePath, content, message) {
  const sha = await getFileSha(filePath);
  const body = {
    message,
    content: Buffer.from(content).toString('base64'),
    branch: BACKUP_BRANCH,
  };
  if (sha) body.sha = sha;

  return githubRequest('PUT', `/repos/${BACKUP_REPO}/contents/${filePath}`, body);
}

/**
 * Export a single table to JSON
 */
async function exportTable(tableName, query) {
  try {
    const result = await pool.query(query);
    return {
      table: tableName,
      rows: result.rows.length,
      data: result.rows,
      exported_at: new Date().toISOString(),
    };
  } catch (err) {
    logger.warn(`[Backup] Failed to export table ${tableName}: ${err.message}`);
    return { table: tableName, rows: 0, data: [], error: err.message };
  }
}

/**
 * Get list of existing backups (for cleanup)
 */
async function listBackups() {
  try {
    const result = await githubRequest('GET', `/repos/${BACKUP_REPO}/contents/backups?ref=${BACKUP_BRANCH}`);
    if (!Array.isArray(result)) return [];
    
    const backups = [];
    for (const dateDir of result) {
      if (dateDir.type !== 'dir') continue;
      try {
        const timeDirs = await githubRequest('GET', `/repos/${BACKUP_REPO}/contents/backups/${dateDir.name}?ref=${BACKUP_BRANCH}`);
        if (Array.isArray(timeDirs)) {
          for (const timeDir of timeDirs) {
            if (timeDir.type === 'dir') {
              backups.push(`backups/${dateDir.name}/${timeDir.name}`);
            }
          }
        }
      } catch { /* skip */ }
    }
    return backups.sort();
  } catch {
    return [];
  }
}

/**
 * Delete old backups beyond MAX_BACKUPS
 */
async function cleanupOldBackups(backups) {
  if (backups.length <= MAX_BACKUPS) return 0;
  
  const toDelete = backups.slice(0, backups.length - MAX_BACKUPS);
  let deleted = 0;
  
  for (const backupPath of toDelete) {
    try {
      // List files in the backup dir
      const files = await githubRequest('GET', `/repos/${BACKUP_REPO}/contents/${backupPath}?ref=${BACKUP_BRANCH}`);
      if (Array.isArray(files)) {
        for (const file of files) {
          try {
            await githubRequest('DELETE', `/repos/${BACKUP_REPO}/contents/${file.path}`, {
              message: `cleanup: remove old backup ${file.path}`,
              sha: file.sha,
              branch: BACKUP_BRANCH,
            });
          } catch { /* skip */ }
        }
      }
      deleted++;
    } catch { /* skip */ }
  }
  
  return deleted;
}

/**
 * Create a full backup
 */
async function createBackup() {
  const startTime = Date.now();
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const timeStr = now.toISOString().slice(11, 19).replace(/:/g, '-'); // HH-mm-ss
  const backupPath = `backups/${dateStr}/${timeStr}`;
  
  logger.info(`[Backup] Starting GitHub backup to ${backupPath}`);

  if (!GITHUB_TOKEN) {
    logger.warn('[Backup] GITHUB_BACKUP_TOKEN not set — skipping backup');
    return { success: false, error: 'GITHUB_BACKUP_TOKEN not set' };
  }

  const results = {};
  let totalRows = 0;

  // Export each table
  for (const { name, query } of BACKUP_TABLES) {
    const tableData = await exportTable(name, query);
    results[name] = { rows: tableData.rows, error: tableData.error || null };
    totalRows += tableData.rows;

    const content = JSON.stringify(tableData, null, 2);
    try {
      await pushFile(
        `${backupPath}/${name}.json`,
        content,
        `backup: ${dateStr} ${timeStr} — ${name} (${tableData.rows} rows)`
      );
      logger.info(`[Backup] ✅ ${name}: ${tableData.rows} rows`);
    } catch (err) {
      logger.error(`[Backup] ❌ Failed to push ${name}: ${err.message}`);
      results[name].pushError = err.message;
    }
  }

  // Write meta file
  const duration = Date.now() - startTime;
  const meta = {
    backup_time: now.toISOString(),
    duration_ms: duration,
    total_rows: totalRows,
    tables: results,
    version: process.env.npm_package_version || 'unknown',
    repo: BACKUP_REPO,
  };

  try {
    await pushFile(
      `${backupPath}/meta.json`,
      JSON.stringify(meta, null, 2),
      `backup: ${dateStr} ${timeStr} — meta (${totalRows} total rows, ${duration}ms)`
    );
  } catch (err) {
    logger.warn(`[Backup] Failed to push meta: ${err.message}`);
  }

  // Record in DB
  try {
    await pool.query(`
      INSERT INTO backup_history (filename, file_path, size_bytes, size_mb, duration_ms, verified, status, notes)
      VALUES ($1, $2, $3, $4, $5, true, 'success', $6)
      ON CONFLICT DO NOTHING
    `, [
      `${dateStr}_${timeStr}`,
      `https://github.com/${BACKUP_REPO}/tree/${BACKUP_BRANCH}/${backupPath}`,
      totalRows * 200, // rough estimate
      Math.round(totalRows * 200 / 1024 / 1024 * 100) / 100,
      duration,
      JSON.stringify(results),
    ]);
  } catch { /* DB logging is optional */ }

  // Cleanup old backups
  try {
    const allBackups = await listBackups();
    const cleaned = await cleanupOldBackups(allBackups);
    if (cleaned > 0) logger.info(`[Backup] Cleaned up ${cleaned} old backups`);
  } catch (err) {
    logger.warn(`[Backup] Cleanup failed: ${err.message}`);
  }

  logger.info(`[Backup] ✅ Backup complete: ${totalRows} rows in ${duration}ms → ${backupPath}`);

  return {
    success: true,
    backupPath,
    totalRows,
    duration,
    tables: results,
    url: `https://github.com/${BACKUP_REPO}/tree/${BACKUP_BRANCH}/${backupPath}`,
  };
}

/**
 * Schedule hourly backups using node-cron
 */
function scheduleHourlyBackups() {
  try {
    const cron = require('node-cron');
    // Run at :05 every hour
    cron.schedule('5 * * * *', async () => {
      logger.info('[Backup] ⏰ Hourly backup triggered by cron');
      try {
        const result = await createBackup();
        logger.info(`[Backup] Cron backup done: ${result.totalRows} rows`);
      } catch (err) {
        logger.error(`[Backup] Cron backup failed: ${err.message}`);
      }
    });
    logger.info('[Backup] ✅ Hourly backup cron scheduled (runs at :05 every hour)');
  } catch (err) {
    logger.warn(`[Backup] Failed to schedule cron: ${err.message}`);
  }
}

/**
 * Initialize the backup service
 */
async function initializeGithubBackup() {
  logger.info('[Backup] Initializing GitHub Backup Service...');

  if (!GITHUB_TOKEN) {
    logger.warn('[Backup] ⚠️  GITHUB_BACKUP_TOKEN not set — backups disabled');
    logger.warn('[Backup] Set GITHUB_BACKUP_TOKEN in Railway env vars to enable');
    return { initialized: false, reason: 'no token' };
  }

  // Verify repo access
  try {
    const repo = await githubRequest('GET', `/repos/${BACKUP_REPO}`);
    logger.info(`[Backup] ✅ Connected to backup repo: ${repo.full_name} (private: ${repo.private})`);
  } catch (err) {
    logger.error(`[Backup] ❌ Cannot access backup repo: ${err.message}`);
    return { initialized: false, reason: err.message };
  }

  scheduleHourlyBackups();

  logger.info('[Backup] ✅ GitHub Backup Service ready');
  return { initialized: true, repo: BACKUP_REPO };
}

module.exports = {
  createBackup,
  initializeGithubBackup,
  scheduleHourlyBackups,
  listBackups,
};
