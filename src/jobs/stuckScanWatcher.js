const cron = require('node-cron');
const pool = require('../db/pool');
const { logger } = require('../services/logger');
const notificationService = require('../services/notificationService');

// Check every 30 minutes for stuck scans
const WATCHER_CRON = '*/30 * * * *';

let watcherTask = null;
let lastAlertSent = null;

/**
 * Send alert about stuck scans
 */
async function sendStuckScanAlert(stuckScans) {
  if (!notificationService.isConfigured()) {
    logger.info('Stuck scan alert not sent - no email provider configured');
    return;
  }

  // Don't spam - only send if last alert was >2 hours ago
  if (lastAlertSent && (Date.now() - lastAlertSent) < 2 * 60 * 60 * 1000) {
    logger.info('Stuck scan detected but alert throttled (< 2 hours since last alert)');
    return;
  }

  const now = new Date();
  const israelTime = now.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  
  const subject = `⚠️ [QUANTUM] סריקות תקועות זוהו`;
  
  const scansTable = stuckScans.map((scan, i) => {
    const duration = Math.round((Date.now() - new Date(scan.started_at).getTime()) / (1000 * 60));
    return `
      <tr style="background: ${i % 2 === 0 ? '#fef2f2' : '#ffffff'};">
        <td style="padding: 8px 12px; border: 1px solid #e5e7eb;">#${scan.id}</td>
        <td style="padding: 8px 12px; border: 1px solid #e5e7eb;">${scan.scan_type}</td>
        <td style="padding: 8px 12px; border: 1px solid #e5e7eb;">${duration} דקות</td>
        <td style="padding: 8px 12px; border: 1px solid #e5e7eb;">${scan.complexes_scanned || 0}</td>
      </tr>
    `;
  }).join('');

  const html = `
    <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #dc2626;">⚠️ סריקות תקועות זוהו</h2>
      
      <div style="background: #fef2f2; border: 1px solid #fca5a5; border-radius: 8px; padding: 16px; margin: 16px 0;">
        <p style="margin: 0 0 8px; font-size: 16px;">
          <strong>${stuckScans.length} סריקות</strong> רצות יותר מ-2 שעות ללא התקדמות.
        </p>
        <p style="margin: 0; color: #92400e; font-size: 14px;">
          זמן: ${israelTime}
        </p>
      </div>
      
      <h3 style="color: #374151;">סריקות תקועות:</h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead>
          <tr style="background: #f3f4f6;">
            <th style="padding: 8px 12px; text-align: right; border: 1px solid #e5e7eb;">ID</th>
            <th style="padding: 8px 12px; text-align: right; border: 1px solid #e5e7eb;">סוג</th>
            <th style="padding: 8px 12px; text-align: right; border: 1px solid #e5e7eb;">משך</th>
            <th style="padding: 8px 12px; text-align: right; border: 1px solid #e5e7eb;">מתחמים</th>
          </tr>
        </thead>
        <tbody>
          ${scansTable}
        </tbody>
      </table>
      
      <div style="background: #fffbeb; border: 1px solid #fcd34d; border-radius: 8px; padding: 12px; margin: 16px 0;">
        <strong>פעולות מומלצות:</strong>
        <ol style="margin: 8px 0 0; padding-right: 20px;">
          <li>בדוק את לוגי Railway לשגיאות</li>
          <li>סגור סריקות תקועות: <code>POST /api/scan/fix-stuck</code></li>
          <li>הרץ סריקה חדשה אם נדרש</li>
        </ol>
      </div>
      
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 16px 0;">
      <p style="font-size: 11px; color: #9ca3af; text-align: center;">
        QUANTUM v4.8.3 - Stuck Scan Watcher<br>
        בדיקה כל 30 דקות | התראות מוגבלות ל-1 פעם ב-2 שעות
      </p>
    </div>
  `;

  try {
    for (const email of notificationService.NOTIFICATION_EMAILS) {
      await notificationService.sendEmail(email, subject, html);
    }
    lastAlertSent = Date.now();
    logger.info(`Stuck scan alert sent: ${stuckScans.length} stuck scans`);
  } catch (err) {
    logger.warn('Failed to send stuck scan alert', { error: err.message });
  }
}

/**
 * Check for stuck scans and alert if found
 */
async function checkStuckScans() {
  try {
    const stuckScans = await pool.query(`
      SELECT id, scan_type, started_at, complexes_scanned 
      FROM scan_logs 
      WHERE status = 'running' 
        AND started_at < NOW() - INTERVAL '2 hours'
      ORDER BY started_at ASC
    `);

    if (stuckScans.rows.length > 0) {
      logger.warn(`⚠️ Found ${stuckScans.rows.length} stuck scans`, { 
        scans: stuckScans.rows.map(s => ({ id: s.id, type: s.scan_type })) 
      });
      
      await sendStuckScanAlert(stuckScans.rows);
      
      // Auto-fix stuck scans older than 2 hours
      await pool.query(`
        UPDATE scan_logs 
        SET status = 'failed', 
            completed_at = NOW(),
            errors = 'Auto-failed - scan stuck > 2 hours (by watcher)'
        WHERE status = 'running' 
          AND started_at < NOW() - INTERVAL '2 hours'
      `);
      
      logger.info(`Auto-fixed ${stuckScans.rows.length} stuck scans`);
    } else {
      logger.debug('✅ No stuck scans found');
    }
  } catch (err) {
    logger.error('Stuck scan check failed', { error: err.message });
  }
}

/**
 * Start the stuck scan watcher
 */
function startWatcher() {
  if (watcherTask) {
    logger.warn('Stuck scan watcher already running');
    return;
  }

  if (!cron.validate(WATCHER_CRON)) {
    logger.error(`Invalid watcher cron: ${WATCHER_CRON}`);
    return;
  }

  watcherTask = cron.schedule(WATCHER_CRON, async () => {
    logger.debug('Running stuck scan check...');
    await checkStuckScans();
  }, { timezone: 'Asia/Jerusalem' });

  logger.info(`Stuck scan watcher started: ${WATCHER_CRON} (every 30 min, Israel time)`);
}

/**
 * Stop the watcher
 */
function stopWatcher() {
  if (watcherTask) {
    watcherTask.stop();
    watcherTask = null;
    logger.info('Stuck scan watcher stopped');
  }
}

/**
 * Get watcher status
 */
function getWatcherStatus() {
  return {
    enabled: !!watcherTask,
    cron: WATCHER_CRON,
    schedule: 'Every 30 minutes',
    timezone: 'Asia/Jerusalem',
    lastAlertSent: lastAlertSent ? new Date(lastAlertSent).toISOString() : null,
    alertThrottle: '2 hours'
  };
}

module.exports = {
  startWatcher,
  stopWatcher,
  getWatcherStatus,
  checkStuckScans
};
