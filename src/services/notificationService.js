/**
 * Notification Service v4 - Dashboard-Centric Alerts (No Email)
 * 
 * ⚠️ EMAIL NOTIFICATIONS DISABLED per user request (March 6, 2026)
 * 
 * All notifications now appear exclusively in QUANTUM Dashboard V3:
 * - Critical alerts visible in dashboard alerts feed
 * - Weekly digests available via NEWS tab
 * - Real-time updates through dashboard auto-refresh
 * 
 * Email functionality preserved but disabled for future reactivation if needed.
 * To re-enable: set ENABLE_EMAIL_NOTIFICATIONS=true in Railway environment.
 */

const pool = require('../db/pool');
const { logger } = require('./logger');

// 🚫 EMAIL NOTIFICATIONS DISABLED - All alerts now dashboard-only
const EMAIL_DISABLED = process.env.ENABLE_EMAIL_NOTIFICATIONS !== 'true';

// Previous email targets (now disabled)
const PERSONAL_EMAIL = process.env.PERSONAL_EMAIL || 'hemi.michaeli@gmail.com';
const OFFICE_EMAIL = process.env.OFFICE_EMAIL || 'Office@u-r-quantum.com';
const TRELLO_EMAIL = process.env.TRELLO_BOARD_EMAIL || 'uth_limited+c9otswetpgdfphdpoehc@boards.trello.com';

// All notification targets (empty when disabled)
const NOTIFICATION_EMAILS = EMAIL_DISABLED ? [] : [PERSONAL_EMAIL, OFFICE_EMAIL].filter(Boolean);

// Severity -> emoji mapping for dashboard alerts
const SEVERITY_EMOJI = {
  critical: '🚨',
  high: '🔴', 
  medium: '🟡',
  info: 'ℹ️'
};

const ALERT_TYPE_LABEL = {
  status_change: 'שינוי סטטוס',
  committee_approval: 'אישור ועדה',
  opportunity: 'הזדמנות השקעה',
  stressed_seller: 'מוכר לחוץ',
  price_drop: 'ירידת מחיר',
  new_complex: 'מתחם חדש'
};

/**
 * Send email via Resend HTTP API (DISABLED)
 */
async function sendViaResend(to, subject, htmlBody, textBody) {
  if (EMAIL_DISABLED) {
    logger.info(`📧 Email to ${to} blocked (notifications disabled) - storing in dashboard instead`);
    return { sent: false, error: 'Email notifications disabled per user request', provider: 'disabled' };
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, error: 'RESEND_API_KEY not set', provider: 'resend' };

  const fromAddress = process.env.EMAIL_FROM || 'QUANTUM <onboarding@resend.dev>';

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromAddress,
        to: [to],
        subject: subject,
        html: htmlBody,
        text: textBody || htmlBody.replace(/<[^>]*>/g, '')
      })
    });

    const data = await response.json();

    if (response.ok) {
      logger.info(`✉️ Resend: sent to ${to}`, { id: data.id });
      return { sent: true, messageId: data.id, provider: 'resend' };
    } else {
      logger.warn(`Resend failed for ${to}: ${data.message || response.status}`, { status: response.status });
      return { sent: false, error: data.message || `HTTP ${response.status}`, statusCode: response.status, provider: 'resend' };
    }
  } catch (err) {
    logger.error(`Resend error for ${to}`, { error: err.message });
    return { sent: false, error: err.message, provider: 'resend' };
  }
}

/**
 * Send email via SMTP (DISABLED)
 */
async function sendViaSMTP(to, subject, htmlBody, textBody) {
  if (EMAIL_DISABLED) {
    logger.info(`📧 SMTP email to ${to} blocked (notifications disabled)`);
    return { sent: false, error: 'Email notifications disabled per user request', provider: 'disabled' };
  }

  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (!smtpHost || !smtpUser || !smtpPass) {
    return { sent: false, error: 'SMTP not configured', provider: 'smtp' };
  }

  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransporter({
      host: smtpHost,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: smtpUser, pass: smtpPass },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000
    });

    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || smtpUser,
      to,
      subject,
      html: htmlBody,
      text: textBody || htmlBody.replace(/<[^>]*>/g, '')
    });

    logger.info(`✉️ SMTP: sent to ${to}`, { messageId: info.messageId });
    return { sent: true, messageId: info.messageId, provider: 'smtp' };
  } catch (err) {
    logger.error(`SMTP failed for ${to}`, { error: err.message, code: err.code });
    return { sent: false, error: err.message, code: err.code, provider: 'smtp' };
  }
}

/**
 * Send a single email - DISABLED, logs instead
 */
async function sendEmail(to, subject, htmlBody, textBody) {
  if (EMAIL_DISABLED) {
    logger.info(`📧 Email blocked: to=${to}, subject="${subject}" (notifications disabled)`);
    return { sent: false, error: 'Email notifications disabled per user request', provider: 'disabled' };
  }

  if (process.env.RESEND_API_KEY) {
    const resendResult = await sendViaResend(to, subject, htmlBody, textBody);
    if (resendResult.sent) return resendResult;
    logger.info(`Resend failed for ${to}, trying SMTP fallback...`);
  }
  
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    return sendViaSMTP(to, subject, htmlBody, textBody);
  }
  
  return { sent: false, error: 'No email provider available', provider: 'none' };
}

/**
 * Store alert in dashboard instead of sending email
 */
async function storeAlertInDashboard(alert, subject, body) {
  try {
    await pool.query(`
      INSERT INTO dashboard_notifications (alert_id, subject, body, created_at, severity, type)
      VALUES ($1, $2, $3, NOW(), $4, 'alert')
      ON CONFLICT (alert_id) DO UPDATE SET
        subject = EXCLUDED.subject,
        body = EXCLUDED.body,
        updated_at = NOW()
    `, [alert.id, subject, body, alert.severity]);
    
    logger.info(`📱 Alert stored in dashboard: ${alert.title}`);
    return true;
  } catch (err) {
    logger.warn('Failed to store alert in dashboard', { error: err.message });
    return false;
  }
}

/**
 * Format alert for dashboard display
 */
function formatAlertForDashboard(alert) {
  const emoji = SEVERITY_EMOJI[alert.severity] || '';
  const typeLabel = ALERT_TYPE_LABEL[alert.alert_type] || alert.alert_type;
  
  const subject = `${emoji} ${typeLabel}: ${alert.title}`;
  
  let body = `${alert.message}\n\n`;
  body += `סוג: ${typeLabel}\n`;
  body += `חומרה: ${alert.severity}\n`;
  body += `תאריך: ${new Date(alert.created_at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}\n`;

  if (alert.data) {
    const data = typeof alert.data === 'string' ? JSON.parse(alert.data) : alert.data;
    if (data.old_status && data.new_status) {
      body += `סטטוס ישן: ${data.old_status} -> חדש: ${data.new_status}\n`;
    }
    if (data.committee) {
      body += `ועדה: ${data.committee === 'local' ? 'מקומית' : 'מחוזית'}\n`;
    }
    if (data.old_iai !== undefined) {
      body += `IAI: ${data.old_iai} -> ${data.new_iai}\n`;
    }
    if (data.ssi_score) {
      body += `SSI: ${data.ssi_score}\n`;
    }
    if (data.drop_percent) {
      body += `ירידה: ${data.drop_percent}%\n`;
    }
  }

  return { subject, body };
}

/**
 * Send dashboard notification instead of email for alerts
 */
async function sendAlertNotification(alert) {
  if (!alert || !['critical', 'high'].includes(alert.severity)) return 0;

  // Store in dashboard instead of sending email
  const dashboardFormat = formatAlertForDashboard(alert);
  const stored = await storeAlertInDashboard(alert, dashboardFormat.subject, dashboardFormat.body);

  if (stored) {
    try {
      await pool.query('UPDATE alerts SET sent_at = NOW(), notification_method = $1 WHERE id = $2', 
        ['dashboard', alert.id]);
    } catch (err) {
      logger.warn('Failed to mark alert as dashboard-sent', { alertId: alert.id, error: err.message });
    }
    
    logger.info(`📱 Alert stored in dashboard instead of email: ${alert.title}`);
    return 1; // Count as "sent" to dashboard
  }

  return 0;
}

/**
 * Process all unsent high-severity alerts for dashboard
 */
async function sendPendingAlerts() {
  try {
    const result = await pool.query(`
      SELECT a.*, c.name as complex_name, c.city
      FROM alerts a
      LEFT JOIN complexes c ON a.complex_id = c.id
      WHERE a.sent_at IS NULL AND a.severity IN ('critical', 'high')
      ORDER BY a.created_at ASC
      LIMIT 20
    `);

    if (result.rows.length === 0) {
      logger.info('No pending alerts to process');
      return { totalAlerts: 0, sent: 0 };
    }

    let sent = 0;
    for (const alert of result.rows) {
      const count = await sendAlertNotification(alert);
      if (count > 0) sent++;
      await new Promise(r => setTimeout(r, 100)); // Small delay
    }

    logger.info(`Stored ${sent}/${result.rows.length} alerts in dashboard`);
    return { totalAlerts: result.rows.length, sent };
  } catch (err) {
    logger.error('Failed to process pending alerts', { error: err.message });
    return { error: err.message };
  }
}

/**
 * Alias for compatibility
 */
async function sendPendingNotifications() {
  return sendPendingAlerts();
}

/**
 * Store weekly digest in dashboard instead of email
 */
async function sendWeeklyDigest(scanResult) {
  if (!scanResult) return { sent: 0, method: 'dashboard' };

  const subject = `📊 QUANTUM - סיכום שבועי`;

  const alertsResult = await pool.query(`
    SELECT a.*, c.name as complex_name, c.city
    FROM alerts a
    LEFT JOIN complexes c ON a.complex_id = c.id
    WHERE a.created_at > NOW() - INTERVAL '7 days'
    ORDER BY 
      CASE a.severity 
        WHEN 'critical' THEN 1 WHEN 'high' THEN 2 
        WHEN 'medium' THEN 3 ELSE 4 
      END,
      a.created_at DESC
    LIMIT 30
  `);

  const topOpps = await pool.query(`
    SELECT name, city, status, iai_score, actual_premium
    FROM complexes WHERE iai_score >= 50
    ORDER BY iai_score DESC LIMIT 10
  `);

  let body = `סיכום שבועי QUANTUM\n\n`;
  
  body += `תוצאות סריקה:\n`;
  if (scanResult.nadlan) body += `nadlan.gov.il: ${scanResult.nadlan.newTransactions || scanResult.nadlan.newTx || 0} עסקאות חדשות\n`;
  if (scanResult.yad2) body += `yad2: ${scanResult.yad2.new || scanResult.yad2.newListings || 0} מודעות חדשות, ${scanResult.yad2.priceChanges || 0} שינויי מחיר\n`;
  if (scanResult.mavat) body += `mavat: ${scanResult.mavat.statusChanges || 0} שינויי סטטוס, ${scanResult.mavat.committeeUpdates || 0} אישורי ועדה\n`;
  if (scanResult.benchmarks) body += `Benchmarks: ${scanResult.benchmarks.calculated || 0} חושבו\n`;
  body += `משך: ${scanResult.duration || 'N/A'} | ${scanResult.alertsGenerated || 0} התראות\n\n`;

  if (alertsResult.rows.length > 0) {
    body += `התראות השבוע (${alertsResult.rows.length}):\n`;
    for (const alert of alertsResult.rows.slice(0, 10)) {
      body += `- ${SEVERITY_EMOJI[alert.severity]} ${alert.title}: ${alert.message}\n`;
    }
    body += `\n`;
  }

  if (topOpps.rows.length > 0) {
    body += `Top 10 הזדמנויות:\n`;
    for (const opp of topOpps.rows) {
      body += `- ${opp.name} (${opp.city}) IAI=${opp.iai_score}\n`;
    }
  }

  // Store in dashboard notifications
  try {
    await pool.query(`
      INSERT INTO dashboard_notifications (subject, body, created_at, severity, type)
      VALUES ($1, $2, NOW(), 'info', 'digest')
    `, [subject, body]);
    
    logger.info('📱 Weekly digest stored in dashboard instead of email');
    return { sent: 1, method: 'dashboard' };
  } catch (err) {
    logger.error('Failed to store weekly digest in dashboard', { error: err.message });
    return { sent: 0, method: 'dashboard', error: err.message };
  }
}

/**
 * Check if notifications are configured (now always dashboard)
 */
function isConfigured() {
  return true; // Dashboard is always available
}

/**
 * Get active provider info
 */
function getProvider() {
  if (EMAIL_DISABLED) return 'dashboard-only';
  
  const providers = [];
  if (process.env.RESEND_API_KEY) providers.push('resend');
  if (process.env.SMTP_HOST) providers.push('smtp');
  return providers.length ? providers.join('+dashboard') : 'dashboard-only';
}

/**
 * Emergency re-enable function (for critical system issues only)
 */
async function emergencyEnableEmail(reason) {
  logger.warn(`🚨 Emergency email re-enabled: ${reason}`);
  process.env.ENABLE_EMAIL_NOTIFICATIONS = 'true';
  EMAIL_DISABLED = false;
  
  // Send notification about re-enablement
  const subject = `🚨 [QUANTUM] Email notifications re-enabled - ${reason}`;
  const body = `Email notifications have been temporarily re-enabled due to: ${reason}\n\nTime: ${new Date().toISOString()}`;
  
  return await sendEmail(PERSONAL_EMAIL, subject, body);
}

module.exports = {
  sendAlertNotification,
  sendPendingAlerts,
  sendPendingNotifications,
  sendWeeklyDigest,
  sendEmail,
  isConfigured,
  getProvider,
  storeAlertInDashboard,
  emergencyEnableEmail,
  NOTIFICATION_EMAILS,
  PERSONAL_EMAIL,
  OFFICE_EMAIL,
  TRELLO_EMAIL,
  EMAIL_DISABLED
};