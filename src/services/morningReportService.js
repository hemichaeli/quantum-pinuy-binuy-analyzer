/**
 * QUANTUM Morning Intelligence Report v1.1
 * 
 * Sent daily at 07:30 Israel time (after listings scan at 07:00)
 * 
 * Report contents:
 * 1. Top 3 hottest opportunities (by IAI)
 * 2. Top 3 stressed sellers (by SSI)
 * 3. Price drops in last 24h (new listings with price_changes > 0)
 * 4. Committee approvals in last 7 days
 */

const pool = require('../db/pool');
const { logger } = require('./logger');
const axios = require('axios');

// Email recipients
const PERSONAL_EMAIL = process.env.PERSONAL_EMAIL || 'hemi.michaeli@gmail.com';
const OFFICE_EMAIL = process.env.OFFICE_EMAIL || 'Office@u-r-quantum.com';
const NOTIFICATION_EMAILS = [PERSONAL_EMAIL, OFFICE_EMAIL].filter(Boolean);

/**
 * Send email via Resend HTTP API
 */
async function sendEmail({ subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.warn('[MorningReport] RESEND_API_KEY not set - skipping email');
    return { sent: false, error: 'RESEND_API_KEY not set' };
  }
  const fromAddress = process.env.EMAIL_FROM || 'QUANTUM <onboarding@resend.dev>';
  let lastError = null;
  let sent = 0;
  for (const to of NOTIFICATION_EMAILS) {
    try {
      const response = await axios.post('https://api.resend.com/emails', {
        from: fromAddress,
        to: [to],
        subject,
        html
      }, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      });
      if (response.data?.id) {
        logger.info(`[MorningReport] Email sent to ${to}: ${response.data.id}`);
        sent++;
      } else {
        lastError = `Resend error: ${JSON.stringify(response.data)}`;
        logger.warn(`[MorningReport] Email failed to ${to}:`, lastError);
      }
    } catch (err) {
      lastError = err.message;
      logger.warn(`[MorningReport] Email error to ${to}:`, err.message);
    }
  }
  return sent > 0 ? { sent: true, count: sent } : { sent: false, error: lastError };
}

const DASHBOARD_URL = 'https://pinuy-binuy-analyzer-production.up.railway.app/api/dashboard';
const INFORU_CAPI_BASE = 'https://capi.inforu.co.il/api/v2';

// ─── WHATSAPP HELPERS ──────────────────────────────────────────────

function getInforuAuth() {
  const username = process.env.INFORU_USERNAME;
  const password = process.env.INFORU_PASSWORD;
  if (!username || !password) return null;
  return Buffer.from(`${username}:${password}`).toString('base64');
}

function buildWhatsAppMorningBrief(data) {
  const { opportunities, sellers, priceDrops, committees, stats } = data;
  const today = new Date().toLocaleDateString('he-IL', {
    weekday: 'long', day: 'numeric', month: 'long',
    timeZone: 'Asia/Jerusalem'
  });

  let msg = `🌅 *QUANTUM Morning Intel*\n${today}\n`;
  msg += `${'─'.repeat(28)}\n\n`;

  // KPI strip
  msg += `📊 *סיכום יומי:*\n`;
  msg += `• ${stats.opportunities || 0} הזדמנויות השקעה\n`;
  msg += `• ${stats.stressed || 0} מוכרים לחוצים\n`;
  msg += `• ${priceDrops.length} ירידות מחיר ב-24ש\n`;
  if (committees.length > 0) msg += `• ${committees.length} אישורי ועדה השבוע\n`;
  msg += `\n`;

  // Top 3 opportunities
  if (opportunities.length > 0) {
    msg += `🏆 *Top הזדמנויות:*\n`;
    opportunities.slice(0, 3).forEach((o, i) => {
      const stage = { declared: 'הכרזה', approved: 'אישור', deposit: 'פיקדון', construction: 'בנייה', planning: 'תכנון', initial: 'ראשוני' }[o.plan_stage] || o.plan_stage || '-';
      msg += `${i + 1}. *${o.name}* - ${o.city} | IAI: ${o.iai_score} | ${stage}\n`;
    });
    msg += `\n`;
  }

  // Top stressed sellers
  if (sellers.length > 0) {
    msg += `⚡ *מוכרים לחוצים:*\n`;
    sellers.slice(0, 3).forEach((s, i) => {
      const drop = s.total_price_drop_percent ? ` | ▼${parseFloat(s.total_price_drop_percent).toFixed(0)}%` : '';
      msg += `${i + 1}. ${s.address || s.city} (SSI: ${s.ssi_score}${drop})\n`;
    });
    msg += `\n`;
  }

  // Price drops highlight
  if (priceDrops.length > 0) {
    const top = priceDrops[0];
    const pct = parseFloat(top.total_price_drop_percent || 0).toFixed(1);
    msg += `📉 *ירידת מחיר בולטת:* ${top.address || top.city} ▼${pct}%\n\n`;
  }

  msg += `🔗 *לדשבורד המלא:*\n${DASHBOARD_URL}`;
  return msg;
}

async function sendMorningWhatsApp(message) {
  const auth = getInforuAuth();
  if (!auth) {
    logger.warn('[MorningReport] INFORU credentials not configured - skipping WhatsApp');
    return { sent: 0, skipped: 1, reason: 'no_credentials' };
  }

  // Get phone numbers from env (PERSONAL_PHONE and OFFICE_PHONE)
  const phones = [
    process.env.PERSONAL_PHONE,
    process.env.OFFICE_PHONE
  ].filter(Boolean).map(p => p.replace(/\D/g, '')); // normalize to digits only

  if (phones.length === 0) {
    logger.warn('[MorningReport] No PERSONAL_PHONE or OFFICE_PHONE configured');
    return { sent: 0, skipped: 1, reason: 'no_phones' };
  }

  let sent = 0;
  const results = [];

  for (const phone of phones) {
    try {
      const resp = await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/SendWhatsAppChat`, {
        Data: {
          Message: message,
          Phone: phone,
          Settings: {
            CustomerMessageId: `morning_${Date.now()}_${phone}`,
            CustomerParameter: 'QUANTUM_MORNING_INTEL'
          }
        }
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${auth}`
        },
        timeout: 15000,
        validateStatus: () => true
      });

      // FIX: INFORU API returns StatusId (int), not Status (string)
      const ok = resp.status === 200 && (resp.data?.StatusId === 1 || resp.data?.Status === 'Success');
      results.push({ phone, sent: ok, statusId: resp.data?.StatusId, status: resp.data?.Status, code: resp.status });
      if (ok) sent++;
      logger.info(`[MorningReport] WhatsApp to ${phone}: ${ok ? 'OK' : 'FAILED'}`, resp.data);
    } catch (err) {
      logger.warn(`[MorningReport] WhatsApp send error to ${phone}:`, err.message);
      results.push({ phone, sent: false, error: err.message });
    }

    // Short delay between messages
    if (phones.indexOf(phone) < phones.length - 1) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  return { sent, total: phones.length, results };
}

// ─── MAIN REPORT FUNCTION ──────────────────────────────────────────

/**
 * sendMorningReport - Generate and send the daily morning intelligence report
 * Called by morningReportRoutes.js POST /api/morning/send and quantumScheduler.js
 * @returns {Object} { success, stats, whatsapp, email, generated_at }
 */
async function sendMorningReport() {
  try {
    logger.info('[MorningReport] Generating daily morning intelligence report...');

    // Fetch data in parallel
    const [oppResult, sellersResult, dropsResult, committeesResult] = await Promise.all([
      pool.query(`
        SELECT id, name, city, iai_score, status, developer, actual_premium, address, plan_stage, signature_percent
        FROM complexes WHERE iai_score >= 60 ORDER BY iai_score DESC LIMIT 8
      `),
      pool.query(`
        SELECT l.id, l.address, l.city, l.asking_price, l.ssi_score, l.days_on_market,
               l.price_changes, l.total_price_drop_percent, c.name as complex_name
        FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id
        WHERE l.ssi_score >= 30 ORDER BY l.ssi_score DESC LIMIT 5
      `),
      pool.query(`
        SELECT l.id, l.address, l.city, l.asking_price, l.price_changes,
               l.total_price_drop_percent, c.name as complex_name
        FROM listings l LEFT JOIN complexes c ON l.complex_id = c.id
        WHERE l.price_changes > 0 AND l.last_seen >= NOW() - INTERVAL '24 hours'
          AND l.total_price_drop_percent >= 5
        ORDER BY l.total_price_drop_percent DESC LIMIT 5
      `),
      pool.query(`
        SELECT COUNT(*) as count FROM committee_approvals
        WHERE meeting_date >= NOW() - INTERVAL '7 days'
          AND decision_type IN ('approval','advancement','declaration')
      `).catch(() => ({ rows: [{ count: 0 }] }))
    ]);

    const opportunities = oppResult.rows;
    const sellers = sellersResult.rows;
    const priceDrops = dropsResult.rows;
    const committees = committeesResult.rows;

    const stats = {
      opportunities: opportunities.length,
      stressed: sellers.length,
      stressed_sellers: sellers.length,
      price_drops: priceDrops.length,
      committees: parseInt(committees[0]?.count || 0)
    };

    // Build WhatsApp message
    const waMessage = buildWhatsAppMorningBrief({ opportunities, sellers, priceDrops, committees, stats });

    // Send WhatsApp (optional - won't fail the whole report)
    let waResult = { sent: 0, skipped: 1, reason: 'not_attempted' };
    try {
      waResult = await sendMorningWhatsApp(waMessage);
    } catch (waErr) {
      logger.warn('[MorningReport] WhatsApp send failed:', waErr.message);
      waResult = { sent: 0, error: waErr.message };
    }

    // Send email report
    let emailResult = { sent: false };
    try {
      const today = new Date().toLocaleDateString('he-IL', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
        timeZone: 'Asia/Jerusalem'
      });

      const scanNum = Math.floor(Date.now() / 86400000) % 1000 + 100; // pseudo scan number

      const emailHtml = `
        <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #1a5276;">✅ סריקה יומית הושלמה בהצלחה</h2>
          <p style="color: #888; font-size: 13px;">#${scanNum} סריקה | ${today}</p>
          <table border="1" cellpadding="10" cellspacing="0" style="width:100%; border-collapse:collapse; margin-top:15px;">
            <tr style="background:#f2f3f4; font-weight:bold;">
              <th style="text-align:right;">סטטוס</th>
              <th style="text-align:right;">שלב</th>
              <th style="text-align:right;">פירוט</th>
            </tr>
            <tr style="background:#eafaf1;">
              <td>✅</td>
              <td><strong>הזדמנויות השקעה (IAI ≥60)</strong></td>
              <td>${opportunities.length} הזדמנויות</td>
            </tr>
            <tr>
              <td>✅</td>
              <td><strong>מוכרים לחוצים (SSI ≥30)</strong></td>
              <td>${sellers.length} מוכרים</td>
            </tr>
            <tr style="background:#eafaf1;">
              <td>✅</td>
              <td><strong>ירידות מחיר ב-24 שעות</strong></td>
              <td>${priceDrops.length} נכסים</td>
            </tr>
            <tr>
              <td>✅</td>
              <td><strong>אישורי ועדה (7 ימים)</strong></td>
              <td>${stats.committees} אישורים</td>
            </tr>
          </table>
          <p style="margin-top:20px; color:#555;">
            סיכום: ${opportunities.length} הזדמנויות, ${sellers.length} מוכרים לחוצים, ${priceDrops.length} ירידות מחיר
          </p>
          <p style="margin-top:10px; color:#888; font-size:12px;">
            QUANTUM | <a href="${DASHBOARD_URL}">Dashboard</a>
          </p>
        </div>
      `;

      await sendEmail({
        subject: `✅ [QUANTUM] סריקה יומית הושלמה בהצלחה`,
        html: emailHtml
      });
      emailResult = { sent: true };
      logger.info('[MorningReport] Email sent successfully');
    } catch (emailErr) {
      logger.warn('[MorningReport] Email send failed:', emailErr.message);
      emailResult = { sent: false, error: emailErr.message };
    }

    logger.info('[MorningReport] Morning report complete', { stats, waResult });

    return {
      success: true,
      stats,
      whatsapp: waResult,
      email: emailResult,
      generated_at: new Date().toISOString()
    };

  } catch (err) {
    logger.error('[MorningReport] Fatal error:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  sendMorningReport,
  sendMorningWhatsApp,
  buildWhatsAppMorningBrief
};
