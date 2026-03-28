/**
 * newsletterService.js — v2.0
 *
 * Multilingual newsletter service (he/en/fr/es/ru/de).
 * Subscriber language is stored in the `lang` column.
 */

const pool   = require('../db/pool');
const axios  = require('axios');
const crypto = require('crypto');
const { logger } = require('./logger');

const RESEND_URL = 'https://api.resend.com/emails';
const BASE_URL   = process.env.BASE_URL || 'https://pinuy-binuy-analyzer-production.up.railway.app';

// ── i18n strings ──────────────────────────────────────────────────────────────

const i18n = {
  he: {
    confirm_subject:   'אשר את הרשמתך ל-QUANTUM נדל״ן',
    confirm_heading:   'שלום {name}!',
    confirm_body:      'תודה שנרשמת לעדכוני נדל״ן מ-QUANTUM.<br>כדי להפעיל את ההתראות שלך, אנא אשר את כתובת האימייל שלך:',
    confirm_btn:       '✅ אישור הרשמה',
    confirm_expiry:    'הקישור תקף ל-48 שעות. אם לא נרשמת, ניתן להתעלם מהודעה זו.',
    alert_subject:     '🏠 נמצאו {n} עסקאות חדשות שמתאימות לחיפוש שלך',
    alert_subtitle:    'נמצאו {n} עסקאות חדשות שמתאימות לחיפוש שלך',
    view_listing:      'לצפייה במודעה',
    registered_note:   'קיבלת אימייל זה כי נרשמת לעדכוני נדל״ן מ-QUANTUM',
    unsubscribe:       'ביטול הרשמה',
    rooms:             'חד׳',
    floor_label:       'קומה',
    dir: 'rtl', lang: 'he',
  },
  en: {
    confirm_subject:   'Confirm your QUANTUM Real Estate subscription',
    confirm_heading:   'Hello {name}!',
    confirm_body:      'Thank you for subscribing to QUANTUM property alerts.<br>Please confirm your email address to activate your alerts:',
    confirm_btn:       '✅ Confirm Subscription',
    confirm_expiry:    'This link is valid for 48 hours. If you did not subscribe, please ignore this email.',
    alert_subject:     '🏠 {n} new properties matching your search',
    alert_subtitle:    '{n} new properties matching your search criteria',
    view_listing:      'View Listing',
    registered_note:   'You received this email because you subscribed to QUANTUM property alerts',
    unsubscribe:       'Unsubscribe',
    rooms:             'rooms',
    floor_label:       'Floor',
    dir: 'ltr', lang: 'en',
  },
  fr: {
    confirm_subject:   'Confirmez votre inscription QUANTUM Immobilier',
    confirm_heading:   'Bonjour {name} !',
    confirm_body:      'Merci de vous être inscrit aux alertes immobilières QUANTUM.<br>Veuillez confirmer votre adresse e-mail pour activer vos alertes :',
    confirm_btn:       '✅ Confirmer l\'inscription',
    confirm_expiry:    'Ce lien est valable 48 heures. Si vous ne vous êtes pas inscrit, ignorez cet e-mail.',
    alert_subject:     '🏠 {n} nouveaux biens correspondent à votre recherche',
    alert_subtitle:    '{n} nouveaux biens correspondant à vos critères',
    view_listing:      'Voir l\'annonce',
    registered_note:   'Vous avez reçu cet e-mail car vous êtes inscrit aux alertes QUANTUM',
    unsubscribe:       'Se désabonner',
    rooms:             'pièces',
    floor_label:       'Étage',
    dir: 'ltr', lang: 'fr',
  },
  es: {
    confirm_subject:   'Confirma tu suscripción a QUANTUM Inmobiliaria',
    confirm_heading:   '¡Hola {name}!',
    confirm_body:      'Gracias por suscribirte a las alertas inmobiliarias de QUANTUM.<br>Por favor confirma tu dirección de correo para activar tus alertas:',
    confirm_btn:       '✅ Confirmar suscripción',
    confirm_expiry:    'Este enlace es válido por 48 horas. Si no te suscribiste, ignora este correo.',
    alert_subject:     '🏠 {n} nuevas propiedades que coinciden con tu búsqueda',
    alert_subtitle:    '{n} nuevas propiedades que coinciden con tus criterios',
    view_listing:      'Ver anuncio',
    registered_note:   'Recibiste este correo porque te suscribiste a alertas QUANTUM',
    unsubscribe:       'Cancelar suscripción',
    rooms:             'hab.',
    floor_label:       'Piso',
    dir: 'ltr', lang: 'es',
  },
  ru: {
    confirm_subject:   'Подтвердите подписку на QUANTUM Недвижимость',
    confirm_heading:   'Здравствуйте, {name}!',
    confirm_body:      'Спасибо за подписку на оповещения QUANTUM о недвижимости.<br>Пожалуйста, подтвердите адрес электронной почты для активации оповещений:',
    confirm_btn:       '✅ Подтвердить подписку',
    confirm_expiry:    'Ссылка действительна 48 часов. Если вы не подписывались, просто проигнорируйте это письмо.',
    alert_subject:     '🏠 {n} новых объекта соответствуют вашему поиску',
    alert_subtitle:    '{n} новых объекта по вашим критериям',
    view_listing:      'Посмотреть объявление',
    registered_note:   'Вы получили это письмо, так как подписались на оповещения QUANTUM',
    unsubscribe:       'Отписаться',
    rooms:             'комн.',
    floor_label:       'Этаж',
    dir: 'ltr', lang: 'ru',
  },
  de: {
    confirm_subject:   'Bestätigen Sie Ihr QUANTUM Immobilien Abonnement',
    confirm_heading:   'Hallo {name}!',
    confirm_body:      'Vielen Dank für Ihre Anmeldung bei QUANTUM Immobilien-Alerts.<br>Bitte bestätigen Sie Ihre E-Mail-Adresse, um Ihre Alerts zu aktivieren:',
    confirm_btn:       '✅ Abonnement bestätigen',
    confirm_expiry:    'Dieser Link ist 48 Stunden gültig. Falls Sie sich nicht angemeldet haben, ignorieren Sie bitte diese E-Mail.',
    alert_subject:     '🏠 {n} neue Immobilien entsprechen Ihrer Suche',
    alert_subtitle:    '{n} neue Immobilien entsprechen Ihren Suchkriterien',
    view_listing:      'Inserat ansehen',
    registered_note:   'Sie erhalten diese E-Mail, weil Sie QUANTUM Immobilien-Alerts abonniert haben',
    unsubscribe:       'Abbestellen',
    rooms:             'Zi.',
    floor_label:       'Etage',
    dir: 'ltr', lang: 'de',
  },
};

function t(lang, key, vars = {}) {
  const strings = i18n[lang] || i18n.he;
  let s = strings[key] || i18n.he[key] || key;
  Object.entries(vars).forEach(([k, v]) => { s = s.replace(new RegExp(`{${k}}`, 'g'), v); });
  return s;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateToken() { return crypto.randomBytes(32).toString('hex'); }
function csvToArray(str) { if (!str) return []; return str.split(',').map(s => s.trim()).filter(Boolean); }

function listingMatchesSubscriber(listing, sub) {
  const cities = csvToArray(sub.cities);
  if (cities.length > 0 && !cities.some(c => c === (listing.city || '').trim())) return false;
  const price = Number(listing.asking_price) || 0;
  if (sub.price_min && price < sub.price_min) return false;
  if (sub.price_max && price > sub.price_max) return false;
  if (sub.min_discount_pct) {
    const disc = Number(listing.discount_pct) || Number(listing.iai_discount_pct) || 0;
    if (disc < sub.min_discount_pct) return false;
  }
  if (sub.min_discount_nis) {
    const discNis = Number(listing.discount_nis) || Number(listing.iai_discount_nis) || 0;
    if (discNis < sub.min_discount_nis) return false;
  }
  const types = csvToArray(sub.property_types);
  if (types.length > 0) {
    const lType = (listing.property_type || listing.asset_type || '').toLowerCase();
    if (!types.some(t2 => lType.includes(t2.toLowerCase()))) return false;
  }
  const rooms = Number(listing.rooms) || 0;
  if (sub.min_rooms && rooms < sub.min_rooms) return false;
  if (sub.max_rooms && rooms > sub.max_rooms) return false;
  const floor = Number(listing.floor) || 0;
  if (sub.min_floor && floor < sub.min_floor) return false;
  return true;
}

// ── Email templates ───────────────────────────────────────────────────────────

function baseLayout(lang, content, footerContent = '') {
  const dir = i18n[lang]?.dir || 'rtl';
  const langCode = i18n[lang]?.lang || lang;
  return `<!DOCTYPE html>
<html dir="${dir}" lang="${langCode}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;direction:${dir}">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:40px 20px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
        <tr><td style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);padding:40px;text-align:center">
          <h1 style="color:#e94560;margin:0;font-size:28px;letter-spacing:2px">QUANTUM</h1>
          <p style="color:#a0aec0;margin:8px 0 0;font-size:14px">נדל"ן | Real Estate | Immobilier</p>
        </td></tr>
        ${content}
        <tr><td style="background:#f7fafc;padding:20px;text-align:center;border-top:1px solid #e2e8f0">
          ${footerContent}
          <p style="color:#a0aec0;font-size:11px;margin:4px 0 0">QUANTUM Real Estate</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function buildConfirmationEmail(subscriber) {
  const lang = subscriber.lang || 'he';
  const name = subscriber.full_name || '';
  const link = `${BASE_URL}/api/newsletter/confirm/${subscriber.confirm_token}`;
  const content = `
    <tr><td style="padding:40px">
      <h2 style="color:#1a1a2e;margin:0 0 16px">${t(lang, 'confirm_heading', { name })}</h2>
      <p style="color:#4a5568;line-height:1.7;margin:0 0 24px">${t(lang, 'confirm_body')}</p>
      <div style="text-align:center;margin:32px 0">
        <a href="${link}" style="background:#e94560;color:#ffffff;text-decoration:none;padding:16px 40px;border-radius:8px;font-size:16px;font-weight:bold;display:inline-block">
          ${t(lang, 'confirm_btn')}
        </a>
      </div>
      <p style="color:#a0aec0;font-size:12px;margin:24px 0 0;text-align:center">${t(lang, 'confirm_expiry')}</p>
    </td></tr>`;
  return baseLayout(lang, content);
}

function buildAlertEmail(subscriber, listings) {
  const lang = subscriber.lang || 'he';
  const dir  = i18n[lang]?.dir || 'rtl';
  const unsubLink = `${BASE_URL}/api/newsletter/unsubscribe/${subscriber.unsubscribe_token}`;

  const listingsHtml = listings.map(l => {
    const price    = l.asking_price ? `₪${Number(l.asking_price).toLocaleString('he-IL')}` : '';
    const discount = l.discount_pct ? `<span style="color:#e94560;font-weight:bold">-${Number(l.discount_pct).toFixed(1)}%</span>` : '';
    const discNis  = l.discount_nis ? `<span style="color:#e94560"> (₪${Number(l.discount_nis).toLocaleString('he-IL')})</span>` : '';
    const rooms    = l.rooms ? `${l.rooms} ${t(lang, 'rooms')}` : '';
    const floor    = l.floor != null ? `${t(lang, 'floor_label')} ${l.floor}` : '';
    return `
    <tr><td style="padding:20px;border-bottom:1px solid #e2e8f0">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td>
            <p style="margin:0 0 4px;font-size:16px;font-weight:bold;color:#1a1a2e">${l.address || ''}, ${l.city || ''}</p>
            <p style="margin:0 0 8px;color:#718096;font-size:13px">${[rooms, floor, l.property_type || ''].filter(Boolean).join(' | ')}</p>
            <p style="margin:0;font-size:18px;font-weight:bold;color:#2d3748">${price} ${discount}${discNis}</p>
          </td>
          <td style="text-align:${dir === 'rtl' ? 'left' : 'right'};vertical-align:middle;padding-${dir === 'rtl' ? 'right' : 'left'}:16px">
            <a href="${l.url || '#'}" style="background:#e94560;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:13px;white-space:nowrap">
              ${t(lang, 'view_listing')}
            </a>
          </td>
        </tr>
      </table>
    </td></tr>`;
  }).join('');

  const content = `
    <tr><td style="padding:24px 0">
      <table width="100%" cellpadding="0" cellspacing="0">${listingsHtml}</table>
    </td></tr>`;

  const footer = `
    <p style="color:#718096;font-size:12px;margin:0 0 8px">${t(lang, 'registered_note')}</p>
    <a href="${unsubLink}" style="color:#a0aec0;font-size:11px">${t(lang, 'unsubscribe')}</a>`;

  return baseLayout(lang, content, footer);
}

// ── Core functions ────────────────────────────────────────────────────────────

async function createSubscriber(data) {
  const {
    email, full_name, phone, lang = 'he',
    cities, price_min, price_max,
    min_discount_pct, min_discount_nis,
    property_types, min_rooms, max_rooms,
    min_floor, frequency = 'immediate'
  } = data;

  if (!email) throw new Error('Email is required');

  const confirmToken     = generateToken();
  const unsubscribeToken = generateToken();

  const { rows } = await pool.query(`
    INSERT INTO newsletter_subscribers
      (email, full_name, phone, lang, cities, price_min, price_max,
       min_discount_pct, min_discount_nis, property_types,
       min_rooms, max_rooms, min_floor, frequency,
       confirm_token, unsubscribe_token)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    ON CONFLICT (email) DO UPDATE SET
      full_name = EXCLUDED.full_name,
      phone = EXCLUDED.phone,
      lang = EXCLUDED.lang,
      cities = EXCLUDED.cities,
      price_min = EXCLUDED.price_min,
      price_max = EXCLUDED.price_max,
      min_discount_pct = EXCLUDED.min_discount_pct,
      min_discount_nis = EXCLUDED.min_discount_nis,
      property_types = EXCLUDED.property_types,
      min_rooms = EXCLUDED.min_rooms,
      max_rooms = EXCLUDED.max_rooms,
      min_floor = EXCLUDED.min_floor,
      frequency = EXCLUDED.frequency,
      confirm_token = EXCLUDED.confirm_token,
      updated_at = NOW()
    RETURNING *
  `, [
    email.toLowerCase().trim(), full_name, phone,
    ['he','en','fr','es','ru','de'].includes(lang) ? lang : 'he',
    cities, price_min || null, price_max || null,
    min_discount_pct || null, min_discount_nis || null,
    property_types, min_rooms || null, max_rooms || null,
    min_floor || null, frequency,
    confirmToken, unsubscribeToken
  ]);

  const subscriber = rows[0];
  await sendEmail(
    subscriber.email,
    t(subscriber.lang || 'he', 'confirm_subject'),
    buildConfirmationEmail(subscriber)
  );

  logger.info(`[Newsletter] New subscriber: ${subscriber.email} (lang=${subscriber.lang})`);
  return subscriber;
}

async function confirmSubscriber(token) {
  const { rows } = await pool.query(`
    UPDATE newsletter_subscribers
    SET confirmed = TRUE, confirm_token = NULL, updated_at = NOW()
    WHERE confirm_token = $1
    RETURNING *
  `, [token]);
  if (rows.length === 0) throw new Error('Invalid or expired confirmation token');
  logger.info(`[Newsletter] Confirmed: ${rows[0].email}`);
  return rows[0];
}

async function unsubscribeByToken(token) {
  const { rows } = await pool.query(`
    UPDATE newsletter_subscribers
    SET is_active = FALSE, updated_at = NOW()
    WHERE unsubscribe_token = $1
    RETURNING email
  `, [token]);
  if (rows.length === 0) throw new Error('Invalid unsubscribe token');
  logger.info(`[Newsletter] Unsubscribed: ${rows[0].email}`);
  return rows[0];
}

async function sendEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { logger.warn('[Newsletter] RESEND_API_KEY not set'); return; }
  const from = `QUANTUM Real Estate <alerts@u-r-quantum.com>`;
  await axios.post(RESEND_URL, { from, to, subject, html }, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    timeout: 15000
  });
}

async function dispatchAlerts(newListingIds = []) {
  if (!newListingIds.length) return { dispatched: 0, emails_sent: 0 };

  const { rows: listings } = await pool.query(`
    SELECT l.id, l.address, l.city, l.asking_price, l.rooms, l.floor,
           l.property_type, l.url,
           c.iai_price,
           CASE WHEN c.iai_price > 0 AND l.asking_price > 0
                THEN ROUND(((c.iai_price - l.asking_price) / c.iai_price::numeric) * 100, 2)
                ELSE 0 END AS discount_pct,
           CASE WHEN c.iai_price > 0 AND l.asking_price > 0
                THEN (c.iai_price - l.asking_price) ELSE 0 END AS discount_nis
    FROM listings l
    LEFT JOIN complexes c ON l.complex_id = c.id
    WHERE l.id = ANY($1::int[]) AND l.is_active = TRUE
  `, [newListingIds]);

  if (!listings.length) return { dispatched: 0, emails_sent: 0 };

  const { rows: subscribers } = await pool.query(`
    SELECT * FROM newsletter_subscribers WHERE is_active = TRUE AND confirmed = TRUE
  `);

  let emailsSent = 0;
  for (const sub of subscribers) {
    const { rows: alreadySent } = await pool.query(`
      SELECT listing_id FROM newsletter_sent_listings
      WHERE subscriber_id = $1 AND listing_id = ANY($2::int[])
    `, [sub.id, newListingIds]);

    const sentIds = new Set(alreadySent.map(r => r.listing_id));
    const matched = listings.filter(l => !sentIds.has(l.id) && listingMatchesSubscriber(l, sub));
    if (!matched.length) continue;

    const lang = sub.lang || 'he';
    try {
      await sendEmail(
        sub.email,
        t(lang, 'alert_subject', { n: matched.length }),
        buildAlertEmail(sub, matched)
      );
      for (const l of matched) {
        await pool.query(`INSERT INTO newsletter_sent_listings (subscriber_id, listing_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [sub.id, l.id]);
      }
      await pool.query(`UPDATE newsletter_subscribers SET last_sent_at=NOW(), listings_sent=listings_sent+$1, updated_at=NOW() WHERE id=$2`, [matched.length, sub.id]);
      emailsSent++;
      logger.info(`[Newsletter] Sent ${matched.length} listings to ${sub.email} (${lang})`);
    } catch (err) {
      logger.warn(`[Newsletter] Failed to send to ${sub.email}: ${err.message}`);
    }
  }

  return { dispatched: listings.length, emails_sent: emailsSent };
}

async function getSubscribers({ page = 1, limit = 50 } = {}) {
  const offset = (page - 1) * limit;
  const { rows } = await pool.query(`
    SELECT id, email, full_name, phone, lang, cities, price_min, price_max,
           min_discount_pct, min_discount_nis, property_types,
           min_rooms, max_rooms, min_floor, frequency,
           is_active, confirmed, last_sent_at, listings_sent, created_at
    FROM newsletter_subscribers ORDER BY created_at DESC LIMIT $1 OFFSET $2
  `, [limit, offset]);
  const { rows: cr } = await pool.query(`SELECT COUNT(*) FROM newsletter_subscribers`);
  return { subscribers: rows, total: Number(cr[0].count), page, limit };
}

module.exports = {
  createSubscriber, confirmSubscriber, unsubscribeByToken,
  dispatchAlerts, getSubscribers, listingMatchesSubscriber
};
