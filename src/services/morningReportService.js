/**
 * QUANTUM Morning Intelligence Report v2.2
 */

const pool = require('../db/pool');
const { logger } = require('./logger');
const axios = require('axios');
const { getCreditBalances } = require('./creditBalanceService');

const PERSONAL_EMAIL = process.env.PERSONAL_EMAIL || 'hemi.michaeli@gmail.com';
const OFFICE_EMAIL = process.env.OFFICE_EMAIL || 'Office@u-r-quantum.com';
const NOTIFICATION_EMAILS = [PERSONAL_EMAIL, OFFICE_EMAIL].filter(Boolean);
const DASHBOARD_BASE = process.env.DASHBOARD_URL ||
  'https://pinuy-binuy-analyzer-production.up.railway.app/dashboard';

function tabLink(tab, filter) {
  return `${DASHBOARD_BASE}#${tab}${filter ? '/' + filter : ''}`;
}

async function sendEmail({ subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, error: 'RESEND_API_KEY not set' };
  const fromAddress = process.env.EMAIL_FROM || 'QUANTUM Real Estate <alerts@u-r-quantum.com>';
  try {
    const response = await axios.post('https://api.resend.com/emails', {
      from: fromAddress, to: NOTIFICATION_EMAILS, subject, html
    }, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });
    if (response.data?.id) {
      logger.info(`[MorningReport] Email sent: ${response.data.id}`);
      return { sent: true, count: NOTIFICATION_EMAILS.length };
    }
    return { sent: false, error: JSON.stringify(response.data) };
  } catch (err) {
    logger.warn('[MorningReport] Email error:', err.message);
    return { sent: false, error: err.message };
  }
}

async function _digestSafeCount(sql) {
  try {
    const { rows } = await pool.query(sql);
    return parseInt(rows[0]?.c || 0, 10);
  } catch (e) { return -1; }
}

async function _digestGetSetting(key, defaultValue = '') {
  try {
    const { rows } = await pool.query('SELECT value FROM system_settings WHERE key = $1', [key]);
    return rows.length > 0 ? rows[0].value : defaultValue;
  } catch (e) { return defaultValue; }
}

async function buildSystemDigest() {
  // IMPORTANT (2026-05-13): listings table is general-purpose (Yad2, Facebook, Komo,
  // BankNadlan, Yad1, Winwin, Homeless, etc.) with a nullable complex_id. Only
  // listings matched into a known pinuy-binuy complex have complex_id populated.
  // We scope listings-derived counts to `complex_id IS NOT NULL` so this digest
  // reflects pinuy-binuy activity only — matching the original 08:00 scan intent
  // (which was missing the filter and over-counted everything).
  //
  // hot_opportunity_alerts and lead_matches are already pinuy-binuy-scoped at
  // ingest time (alerts JOIN complexes with iai/ssi thresholds; matches carry
  // complex_id from the matchEngine), so no extra WHERE clause needed there.
  const since = "NOW() - INTERVAL '24 hours'";
  const [leadsNew, listingsSeen, listingsDeactivated, messagesSent, hotOpps, matchesNew, optoutsNew] = await Promise.all([
    _digestSafeCount(`SELECT COUNT(*) AS c FROM website_leads WHERE created_at > ${since}`),
    _digestSafeCount(`SELECT COUNT(*) AS c FROM listings WHERE first_seen > ${since} AND complex_id IS NOT NULL`),
    // Listings deactivated in the last 24h (mirrors what the StalenessSweeper
    // does at 07:15 each morning — see src/services/stalenessSweeper.js).
    _digestSafeCount(`SELECT COUNT(*) AS c FROM listings WHERE is_active = FALSE AND complex_id IS NOT NULL AND updated_at > ${since}`),
    _digestSafeCount(`SELECT COUNT(*) AS c FROM listings WHERE last_message_sent_at > ${since} AND complex_id IS NOT NULL`),
    _digestSafeCount(`SELECT COUNT(*) AS c FROM hot_opportunity_alerts WHERE created_at > ${since}`),
    _digestSafeCount(`SELECT COUNT(*) AS c FROM lead_matches WHERE created_at > ${since}`),
    _digestSafeCount(`SELECT COUNT(*) AS c FROM wa_optouts WHERE opted_out_at > ${since}`),
  ]);
  const [bulkEnabled, bulkTemplate, agentPhone] = await Promise.all([
    _digestGetSetting('bulk_outreach_enabled', 'false'),
    _digestGetSetting('bulk_outreach_template_id', ''),
    _digestGetSetting('agent_phone', ''),
  ]);
  return { leadsNew, listingsSeen, listingsDeactivated, messagesSent, hotOpps, matchesNew, optoutsNew, bulkEnabled, bulkTemplate, agentPhone };
}

function buildDigestSectionHtml(d) {
  const linkStyle = 'color:#4ecdc4; text-decoration:none; font-weight:600;';
  const fmt = (v) => (v < 0 ? '⚠︎' : v);
  const valColor = (v) => (v < 0 ? '#f87171' : v > 0 ? '#4ecdc4' : '#9aa0b0');
  const row = (label, value, link) => `
    <tr style="border-bottom:1px solid rgba(255,255,255,0.06);">
      <td style="padding:10px 14px; color:#e8eaf0; font-size:13px;">${label}</td>
      <td style="padding:10px 14px; text-align:left; color:${valColor(value)}; font-weight:700; font-size:17px;">
        ${link ? `<a href="${link}" style="color:${valColor(value)}; text-decoration:none;">${fmt(value)}</a>` : fmt(value)}
      </td>
    </tr>`;
  const enabledColor = d.bulkEnabled === 'true' ? '#4ade80' : '#f87171';

  return `
  <div style="background:#2a2d35; border:1px solid rgba(255,255,255,0.08); border-radius:10px; margin-bottom:16px; overflow:hidden;">
    <div style="padding:16px 20px; border-bottom:1px solid rgba(255,255,255,0.08); display:flex; justify-content:space-between; align-items:center;">
      <span style="font-weight:700; font-size:15px;">📊 מערכת ובוט (24 שעות)</span>
      <a href="${DASHBOARD_BASE}" style="${linkStyle} font-size:12px;">פתח דשבורד &larr;</a>
    </div>
    <table style="width:100%; border-collapse:collapse;">
      ${row('לידים חדשים', d.leadsNew, tabLink('leads'))}
      ${row('דירות חדשות במתחמי פינוי-בינוי', d.listingsSeen, tabLink('ads'))}
      ${row('מודעות שירדו / הוסרו (24 שעות)', d.listingsDeactivated, tabLink('ads'))}
      ${row('הודעות יוצאות (פינוי-בינוי)', d.messagesSent, tabLink('messages'))}
      ${row('התראות hot-opportunity', d.hotOpps)}
      ${row('התאמות חדשות (Match Engine)', d.matchesNew)}
      ${row('הסרות מרשימת תפוצה', d.optoutsNew)}
    </table>
    <div style="padding:12px 20px; background:rgba(0,0,0,0.18); border-top:1px solid rgba(255,255,255,0.06);">
      <div style="color:#9aa0b0; font-size:11px; margin-bottom:4px; letter-spacing:1px; text-transform:uppercase;">מצב בוט מוכרים</div>
      <div style="font-size:13px; color:#e8eaf0;">
        enabled=<b style="color:${enabledColor};">${d.bulkEnabled}</b>
        &nbsp;|&nbsp; template=<b style="color:#4ecdc4;">${d.bulkTemplate || '-'}</b>
        &nbsp;|&nbsp; phone=<b style="color:#4ecdc4;">${d.agentPhone || '-'}</b>
      </div>
    </div>
  </div>`;
}

// ── Credit balances: prominent banner (only when something hit zero/blocked) ──
function buildCreditBannerHtml(credit) {
  if (!credit || !credit.hasEmpty) return '';
  const empties = credit.results.filter((r) => r.level === 'empty');
  const names = empties.map((r) => r.name).join(', ');
  const lines = empties.map((r) => `${r.name}: ${r.detail}`).join('<br>');
  return `
  <div style="background:#3a1f24; border:2px solid #f87171; border-radius:10px; padding:18px 22px; margin-bottom:20px;">
    <div style="font-size:18px; font-weight:800; color:#f87171; margin-bottom:8px;">🔴 התראת יתרה — ${names}</div>
    <div style="font-size:14px; color:#f3b6b6; line-height:1.7;">${lines}</div>
    <div style="font-size:12px; color:#d99b9b; margin-top:10px;">יש להטעין credit / לעדכן אמצעי תשלום כדי שההעשרה והסריקות ימשיכו לפעול.</div>
  </div>`;
}

// ── Credit balances: detailed per-service section (always shown) ──────────────
function buildCreditBalancesHtml(credit) {
  if (!credit || !Array.isArray(credit.results) || credit.results.length === 0) return '';
  const meta = {
    ok:      { color: '#4ade80', icon: '✅' },
    warn:    { color: '#e8b84b', icon: '⚠️' },
    empty:   { color: '#f87171', icon: '🔴' },
    unknown: { color: '#9aa0b0', icon: '❔' },
  };
  const rows = credit.results.map((r, i) => {
    const m = meta[r.level] || meta.unknown;
    return `
      <tr style="background:${i % 2 === 0 ? '#2a2d35' : '#32363f'}; border-bottom:1px solid #3a3f4a;">
        <td style="padding:10px 14px; font-weight:700; color:#e8eaf0; white-space:nowrap;">${m.icon} ${r.name}</td>
        <td style="padding:10px 14px; color:${m.color}; font-size:13px;">${r.detail || ''}</td>
      </tr>`;
  }).join('');
  return `
  <div style="background:#2a2d35; border:1px solid rgba(255,255,255,0.08); border-radius:10px; margin-bottom:16px; overflow:hidden;">
    <div style="padding:16px 20px; border-bottom:1px solid rgba(255,255,255,0.08); font-weight:700; font-size:15px;">💳 יתרות שירותים בתשלום</div>
    <table style="width:100%; border-collapse:collapse;"><tbody>${rows}</tbody></table>
  </div>`;
}

function buildEmailHtml({ opportunities, sellers, priceDrops, committees, stats, today, scanNum, digest, digestHtml, creditBanner, creditHtml }) {
  const linkStyle = 'color:#4ecdc4; text-decoration:none; font-weight:600;';
  const rowStyle = (bg) => `background:${bg}; border-bottom:1px solid #3a3f4a;`;

  const oppRows = opportunities.slice(0, 5).map((o, i) => {
    const stage = { declared: 'הכרזה', approved: 'אישור', deposit: 'פיקדון', construction: 'בנייה', planning: 'תכנון', initial: 'ראשוני' }[o.plan_stage] || o.plan_stage || '-';
    const iaiColor = o.iai_score >= 85 ? '#4ade80' : o.iai_score >= 70 ? '#e8b84b' : '#9aa0b0';
    return `
      <tr style="${rowStyle(i % 2 === 0 ? '#2a2d35' : '#32363f')}">
        <td style="padding:10px 14px; color:#e8eaf0;">
          <a href="${tabLink('complexes')}" style="${linkStyle}">${o.name || o.city}</a>
          <span style="color:#9aa0b0; font-size:12px; margin-right:6px;">${o.city || ''}</span>
        </td>
        <td style="padding:10px 14px; text-align:center;">
          <span style="background:rgba(78,205,196,0.15); color:${iaiColor}; padding:3px 10px; border-radius:6px; font-weight:700; font-size:13px;">${o.iai_score}</span>
        </td>
        <td style="padding:10px 14px; color:#9aa0b0; font-size:12px;">${stage}</td>
        <td style="padding:10px 14px; color:#9aa0b0; font-size:12px;">${o.developer || '-'}</td>
      </tr>`;
  }).join('');

  const sellerRows = sellers.slice(0, 5).map((s, i) => {
    const drop = s.total_price_drop_percent ? `▼${parseFloat(s.total_price_drop_percent).toFixed(0)}%` : '-';
    return `
      <tr style="${rowStyle(i % 2 === 0 ? '#2a2d35' : '#32363f')}">
        <td style="padding:10px 14px;">
          <a href="${tabLink('ads')}" style="${linkStyle}">${s.address || s.city || '-'}</a>
          <span style="color:#9aa0b0; font-size:12px; margin-right:6px;">${s.complex_name || ''}</span>
        </td>
        <td style="padding:10px 14px; text-align:center;">
          <span style="background:rgba(248,113,113,0.15); color:#f87171; padding:3px 10px; border-radius:6px; font-weight:700; font-size:13px;">${s.ssi_score}</span>
        </td>
        <td style="padding:10px 14px; color:#f87171; font-weight:600;">${drop}</td>
        <td style="padding:10px 14px; color:#9aa0b0; font-size:12px;">${s.days_on_market || 0} ימים</td>
      </tr>`;
  }).join('');

  const dropRows = priceDrops.slice(0, 5).map((p, i) => {
    const pct = parseFloat(p.total_price_drop_percent || 0).toFixed(1);
    const price = p.asking_price ? `₪${Number(p.asking_price).toLocaleString('he-IL')}` : '-';
    return `
      <tr style="${rowStyle(i % 2 === 0 ? '#2a2d35' : '#32363f')}">
        <td style="padding:10px 14px;">
          <a href="${tabLink('ads')}" style="${linkStyle}">${p.address || p.city || '-'}</a>
          <span style="color:#9aa0b0; font-size:12px; margin-right:6px;">${p.complex_name || ''}</span>
        </td>
        <td style="padding:10px 14px; color:#f87171; font-weight:700;">▼${pct}%</td>
        <td style="padding:10px 14px; color:#9aa0b0;">${price}</td>
        <td style="padding:10px 14px; color:#9aa0b0; font-size:12px;">${p.price_changes || 1} שינויים</td>
      </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>QUANTUM Morning Intel</title></head>
<body style="margin:0; padding:0; background:#1e2128; font-family:Arial,sans-serif; color:#e8eaf0;">
<div style="max-width:700px; margin:0 auto; padding:24px 16px;">

  ${creditBanner || ''}

  <div style="background:#2a2d35; border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:24px 28px; margin-bottom:20px; text-align:center;">
    <div style="font-size:11px; color:#4ecdc4; letter-spacing:3px; text-transform:uppercase; margin-bottom:8px;">QUANTUM ANALYZER</div>
    <div style="font-size:22px; font-weight:800; letter-spacing:2px; color:#e8eaf0;">דוח בוקר יומי</div>
    <div style="color:#9aa0b0; font-size:13px; margin-top:6px;">${today} | סריקה #${scanNum}</div>
  </div>

  <div style="display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:20px;">
    <a href="${tabLink('complexes')}" style="text-decoration:none; background:#2a2d35; border:1px solid rgba(78,205,196,0.3); border-radius:8px; padding:16px 12px; text-align:center; display:block;">
      <div style="font-size:28px; font-weight:800; color:#4ecdc4;">${stats.opportunities}</div>
      <div style="font-size:11px; color:#9aa0b0; margin-top:4px;">הזדמנויות</div>
    </a>
    <a href="${tabLink('ads')}" style="text-decoration:none; background:#2a2d35; border:1px solid rgba(248,113,113,0.3); border-radius:8px; padding:16px 12px; text-align:center; display:block;">
      <div style="font-size:28px; font-weight:800; color:#f87171;">${stats.stressed}</div>
      <div style="font-size:11px; color:#9aa0b0; margin-top:4px;">מוכרים לחוצים</div>
    </a>
    <a href="${tabLink('ads')}" style="text-decoration:none; background:#2a2d35; border:1px solid rgba(232,184,75,0.3); border-radius:8px; padding:16px 12px; text-align:center; display:block;">
      <div style="font-size:28px; font-weight:800; color:#e8b84b;">${stats.price_drops}</div>
      <div style="font-size:11px; color:#9aa0b0; margin-top:4px;">ירידות מחיר</div>
    </a>
    <a href="${tabLink('complexes')}" style="text-decoration:none; background:#2a2d35; border:1px solid rgba(139,92,246,0.3); border-radius:8px; padding:16px 12px; text-align:center; display:block;">
      <div style="font-size:28px; font-weight:800; color:#a78bfa;">${stats.committees}</div>
      <div style="font-size:11px; color:#9aa0b0; margin-top:4px;">אישורי ועדה</div>
    </a>
  </div>

  ${creditHtml || ''}

  ${opportunities.length > 0 ? `
  <div style="background:#2a2d35; border:1px solid rgba(255,255,255,0.08); border-radius:10px; margin-bottom:16px; overflow:hidden;">
    <div style="padding:16px 20px; border-bottom:1px solid rgba(255,255,255,0.08); display:flex; justify-content:space-between; align-items:center;">
      <span style="font-weight:700; font-size:15px;">🏆 הזדמנויות השקעה מובילות</span>
      <a href="${tabLink('complexes')}" style="${linkStyle} font-size:12px;">לכל המתחמים &larr;</a>
    </div>
    <table style="width:100%; border-collapse:collapse;">
      <thead>
        <tr style="background:#32363f;">
          <th style="padding:10px 14px; text-align:right; color:#9aa0b0; font-size:12px; font-weight:500;">מתחם</th>
          <th style="padding:10px 14px; text-align:center; color:#9aa0b0; font-size:12px; font-weight:500;">IAI</th>
          <th style="padding:10px 14px; text-align:right; color:#9aa0b0; font-size:12px; font-weight:500;">שלב</th>
          <th style="padding:10px 14px; text-align:right; color:#9aa0b0; font-size:12px; font-weight:500;">יזם</th>
        </tr>
      </thead>
      <tbody>${oppRows}</tbody>
    </table>
  </div>` : ''}

  ${sellers.length > 0 ? `
  <div style="background:#2a2d35; border:1px solid rgba(255,255,255,0.08); border-radius:10px; margin-bottom:16px; overflow:hidden;">
    <div style="padding:16px 20px; border-bottom:1px solid rgba(255,255,255,0.08); display:flex; justify-content:space-between; align-items:center;">
      <span style="font-weight:700; font-size:15px;">⚡ מוכרים לחוצים</span>
      <a href="${tabLink('ads')}" style="${linkStyle} font-size:12px;">לכל המודעות &larr;</a>
    </div>
    <table style="width:100%; border-collapse:collapse;">
      <thead>
        <tr style="background:#32363f;">
          <th style="padding:10px 14px; text-align:right; color:#9aa0b0; font-size:12px; font-weight:500;">כתובת</th>
          <th style="padding:10px 14px; text-align:center; color:#9aa0b0; font-size:12px; font-weight:500;">SSI</th>
          <th style="padding:10px 14px; text-align:right; color:#9aa0b0; font-size:12px; font-weight:500;">ירידת מחיר</th>
          <th style="padding:10px 14px; text-align:right; color:#9aa0b0; font-size:12px; font-weight:500;">ימים בשוק</th>
        </tr>
      </thead>
      <tbody>${sellerRows}</tbody>
    </table>
  </div>` : ''}

  ${priceDrops.length > 0 ? `
  <div style="background:#2a2d35; border:1px solid rgba(255,255,255,0.08); border-radius:10px; margin-bottom:16px; overflow:hidden;">
    <div style="padding:16px 20px; border-bottom:1px solid rgba(255,255,255,0.08); display:flex; justify-content:space-between; align-items:center;">
      <span style="font-weight:700; font-size:15px;">📉 ירידות מחיר ב-24 שעות</span>
      <a href="${tabLink('ads')}" style="${linkStyle} font-size:12px;">לכל המודעות &larr;</a>
    </div>
    <table style="width:100%; border-collapse:collapse;">
      <thead>
        <tr style="background:#32363f;">
          <th style="padding:10px 14px; text-align:right; color:#9aa0b0; font-size:12px; font-weight:500;">כתובת</th>
          <th style="padding:10px 14px; text-align:right; color:#9aa0b0; font-size:12px; font-weight:500;">ירידה</th>
          <th style="padding:10px 14px; text-align:right; color:#9aa0b0; font-size:12px; font-weight:500;">מחיר נוכחי</th>
          <th style="padding:10px 14px; text-align:right; color:#9aa0b0; font-size:12px; font-weight:500;">שינויים</th>
        </tr>
      </thead>
      <tbody>${dropRows}</tbody>
    </table>
  </div>` : ''}

  ${digestHtml || ''}

  <div style="text-align:center; padding:20px 0 10px;">
    <a href="${tabLink('dashboard')}" style="background:#4ecdc4; color:#1a1d24; padding:12px 32px; border-radius:8px; font-weight:700; font-size:14px; text-decoration:none; display:inline-block;">פתח דשבורד מלא &larr;</a>
    <div style="color:#6b7280; font-size:11px; margin-top:14px;">QUANTUM Analyzer | דוח אוטומטי יומי 07:30</div>
  </div>

</div>
</body>
</html>`;
}

async function sendMorningReport() {
  try {
    const { shouldSkipToday } = require('../config/israeliHolidays');
    const skipCheck = shouldSkipToday();
    if (skipCheck.shouldSkip) {
      logger.info(`[MorningReport] SKIPPED: ${skipCheck.reason}`);
      return { success: true, skipped: true, reason: skipCheck.reasonHe };
    }

    const todayIL = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS morning_report_log (id SERIAL PRIMARY KEY, sent_date DATE UNIQUE NOT NULL, sent_at TIMESTAMPTZ DEFAULT NOW())`);
      const { rows } = await pool.query(`SELECT id FROM morning_report_log WHERE sent_date = $1 LIMIT 1`, [todayIL]);
      if (rows.length > 0) {
        logger.info(`[MorningReport] Already sent today (${todayIL})`);
        return { success: true, skipped: true, reason: `כבר נשלח היום (${todayIL})` };
      }
      await pool.query(`INSERT INTO morning_report_log (sent_date, sent_at) VALUES ($1, NOW()) ON CONFLICT (sent_date) DO NOTHING`, [todayIL]);
    } catch (dbErr) {
      logger.warn('[MorningReport] Dedup check failed (continuing):', dbErr.message);
    }

    logger.info('[MorningReport] Generating...');

    // The display lists below (top-N leaderboards) are intentionally LIMIT-capped
    // — the email body only has room for a few rows. But the headline STATS at
    // the top of the email need to reflect actual 24h activity, not the LIMIT,
    // otherwise the report shows the same numbers every day (opportunities=8,
    // sellers=5, price_drops=5 forever, regardless of what changed).
    //
    // Display lists (top-N for the email body):
    //   oppResult     — top-8 complexes by IAI for the leaderboard
    //   sellersResult — top-5 stressed sellers for the leaderboard
    //   dropsResult   — top-5 price-drop listings for the leaderboard
    //
    // Activity counts (real 24h deltas, drive the headline numbers):
    //   oppActivityCount     — complexes (iai>=60) with a listing newly seen in 24h
    //   sellersActivityCount — listings (ssi>=30) newly first_seen in 24h
    //   dropsActivityCount   — listings with a >=5% price drop seen in 24h
    const [
      oppResult, sellersResult, dropsResult, committeesResult,
      oppActivityResult, sellersActivityResult, dropsActivityResult
    ] = await Promise.all([
      pool.query(`
        SELECT id, name, city, iai_score, status, developer, actual_premium,
               address, plan_stage, signature_percent
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
      `).catch(() => ({ rows: [{ count: 0 }] })),
      // Activity-count queries — these are what drive the headline stats.
      pool.query(`
        SELECT COUNT(DISTINCT c.id) AS cnt
        FROM complexes c
        WHERE c.iai_score >= 60
          AND EXISTS (
            SELECT 1 FROM listings l
            WHERE l.complex_id = c.id
              AND l.first_seen >= CURRENT_DATE - INTERVAL '1 day'
          )
      `),
      pool.query(`
        SELECT COUNT(*) AS cnt FROM listings
        WHERE ssi_score >= 30
          AND first_seen >= CURRENT_DATE - INTERVAL '1 day'
      `),
      pool.query(`
        SELECT COUNT(*) AS cnt FROM listings
        WHERE price_changes > 0
          AND last_seen >= NOW() - INTERVAL '24 hours'
          AND total_price_drop_percent >= 5
      `)
    ]);

    const opportunities = oppResult.rows;
    const sellers = sellersResult.rows;
    const priceDrops = dropsResult.rows;
    const committees = committeesResult.rows;

    const stats = {
      // Headline numbers: 24h activity counts, NOT the LIMIT of the display lists.
      // The display lists below still show top-N — these counts drive the cards.
      opportunities: parseInt(oppActivityResult.rows[0]?.cnt || 0),
      stressed: parseInt(sellersActivityResult.rows[0]?.cnt || 0),
      stressed_sellers: parseInt(sellersActivityResult.rows[0]?.cnt || 0),
      price_drops: parseInt(dropsActivityResult.rows[0]?.cnt || 0),
      committees: parseInt(committees[0]?.count || 0),
      // Totals available for future report iterations (count of all-time qualifying rows)
      _opportunities_total: opportunities.length,
      _sellers_total_shown: sellers.length,
      _drops_total_shown: priceDrops.length
    };

    const today = new Date().toLocaleDateString('he-IL', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      timeZone: 'Asia/Jerusalem'
    });
    const scanNum = Math.floor(Date.now() / 86400000) % 1000 + 100;

    // Merge 08:00 daily-digest data (bot ops canary) into the 07:30 report.
    // The standalone 08:00 cron in src/cron/dailyDigestCron.js is now disabled
    // in src/index.js — this is the single unified morning email.
    let digest = null;
    let digestHtml = '';
    try {
      digest = await buildSystemDigest();
      digestHtml = buildDigestSectionHtml(digest);
    } catch (digErr) {
      logger.warn('[MorningReport] Digest build failed (continuing without):', digErr.message);
    }

    // Credit balances (Perplexity / Apify / 2captcha). Never throws — a failed
    // provider check yields level:'unknown' and the report still goes out.
    let credit = { results: [], hasEmpty: false, hasWarn: false };
    try {
      credit = await getCreditBalances();
    } catch (creditErr) {
      logger.warn('[MorningReport] Credit balance check failed (continuing without):', creditErr.message);
    }
    const creditBanner = buildCreditBannerHtml(credit);
    const creditHtml = buildCreditBalancesHtml(credit);

    // Surface a $0/blocked balance in the subject line so it's visible without
    // even opening the email.
    const subject = credit.hasEmpty
      ? `🔴 [QUANTUM] התראת יתרה + דוח בוקר ${today}`
      : `🌅 [QUANTUM] דוח בוקר ${today}`;

    let emailResult = { sent: false };
    try {
      emailResult = await sendEmail({
        subject,
        html: buildEmailHtml({ opportunities, sellers, priceDrops, committees, stats, today, scanNum, digest, digestHtml, creditBanner, creditHtml })
      });
    } catch (emailErr) {
      logger.warn('[MorningReport] Email failed:', emailErr.message);
      emailResult = { sent: false, error: emailErr.message };
    }

    logger.info('[MorningReport] Complete', { stats, digest, credit: credit.results });
    return { success: true, stats, digest, credit, email: emailResult, generated_at: new Date().toISOString() };

  } catch (err) {
    logger.error('[MorningReport] Fatal:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { sendMorningReport, buildSystemDigest };
