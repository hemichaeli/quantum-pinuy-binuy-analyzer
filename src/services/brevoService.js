/**
 * Brevo (Sendinblue) transactional email service for QUANTUM
 * Sends welcome sequence email immediately on lead submission
 * Requires: BREVO_API_KEY env var
 */
const { logger } = require('./logger');

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const SENDER = { name: 'QUANTUM', email: 'hello@u-r-quantum.com' };
const GUIDE_URL = 'https://u-r-quantum.com/blog/what-is-pinui-binui';

const WELCOME_EMAIL = {
  he: {
    subject: (firstName) => `קיבלנו את הפנייה שלך, ${firstName}`,
    html: (firstName) => `
<div dir="rtl" style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;line-height:1.7">
  <div style="background:#0A1628;padding:24px 32px;border-radius:8px 8px 0 0">
    <span style="color:#fff;font-size:22px;font-weight:700;letter-spacing:2px">QUANTUM</span>
  </div>
  <div style="padding:32px;background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
    <p>שלום ${firstName},</p>
    <p>תודה שפנית אלינו. קיבלנו את הפרטים שלך ואנחנו כבר מתחילים להתעמק.</p>
    <p>אחד מאנשי הצוות שלנו ייצור איתך קשר תוך 24 שעות כדי להבין בדיוק מה אתה מחפש ואיך אנחנו יכולים לעזור.</p>
    <p>בינתיים, הכנו עבורך מדריך קצר שמסביר את מה שחשוב לדעת לפני שנכנסים לעולם פינוי-בינוי:</p>
    <p style="margin:24px 0"><a href="${GUIDE_URL}" style="background:#0A1628;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">קרא את המדריך המלא</a></p>
    <p>אנחנו לא עובדים עם מאות לקוחות. אנחנו עובדים עם מעטים, לעומק. כי ככה עסקאות נסגרות נכון.</p>
    <p>נדבר בקרוב,</p>
    <p><strong>צוות QUANTUM</strong><br>כל לקוח מקבל את כולנו<br><a href="https://u-r-quantum.com" style="color:#0A1628">u-r-quantum.com</a></p>
  </div>
</div>`,
  },
  en: {
    subject: (firstName) => `We received your inquiry, ${firstName}`,
    html: (firstName) => `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;line-height:1.7">
  <div style="background:#0A1628;padding:24px 32px;border-radius:8px 8px 0 0">
    <span style="color:#fff;font-size:22px;font-weight:700;letter-spacing:2px">QUANTUM</span>
  </div>
  <div style="padding:32px;background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
    <p>Hi ${firstName},</p>
    <p>Thank you for reaching out. We have your details and we are already looking into things.</p>
    <p>One of our team members will contact you within 24 hours to understand exactly what you are looking for and how we can help.</p>
    <p>In the meantime, we put together a short guide covering what matters most before entering the Pinui-Binui market:</p>
    <p style="margin:24px 0"><a href="${GUIDE_URL}" style="background:#0A1628;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">Read the full guide</a></p>
    <p>We do not work with hundreds of clients. We work with a few, deeply. That is how deals get done right.</p>
    <p>Talk soon,</p>
    <p><strong>The QUANTUM Team</strong><br>Every client gets all of us<br><a href="https://u-r-quantum.com" style="color:#0A1628">u-r-quantum.com</a></p>
  </div>
</div>`,
  },
  fr: {
    subject: (firstName) => `Nous avons bien recu votre demande, ${firstName}`,
    html: (firstName) => `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;line-height:1.7">
  <div style="background:#0A1628;padding:24px 32px;border-radius:8px 8px 0 0">
    <span style="color:#fff;font-size:22px;font-weight:700;letter-spacing:2px">QUANTUM</span>
  </div>
  <div style="padding:32px;background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
    <p>Bonjour ${firstName},</p>
    <p>Merci de nous avoir contactes. Nous avons bien recu vos coordonnees et nous nous y penchons deja.</p>
    <p>Un membre de notre equipe prendra contact avec vous dans les 24 heures pour comprendre precisement ce que vous recherchez et comment nous pouvons vous accompagner.</p>
    <p>En attendant, nous avons prepare un guide qui couvre les points essentiels avant de se lancer dans le Pinui-Binui:</p>
    <p style="margin:24px 0"><a href="${GUIDE_URL}" style="background:#0A1628;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">Lire le guide complet</a></p>
    <p>Nous ne travaillons pas avec des centaines de clients. Nous en accompagnons quelques-uns, en profondeur. C'est comme cela que les transactions se concluent correctement.</p>
    <p>A tres bientot,</p>
    <p><strong>L'equipe QUANTUM</strong><br>Chaque client recoit toute notre attention<br><a href="https://u-r-quantum.com" style="color:#0A1628">u-r-quantum.com</a></p>
  </div>
</div>`,
  },
  es: {
    subject: (firstName) => `Recibimos tu consulta, ${firstName}`,
    html: (firstName) => `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;line-height:1.7">
  <div style="background:#0A1628;padding:24px 32px;border-radius:8px 8px 0 0">
    <span style="color:#fff;font-size:22px;font-weight:700;letter-spacing:2px">QUANTUM</span>
  </div>
  <div style="padding:32px;background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
    <p>Hola ${firstName},</p>
    <p>Gracias por contactarnos. Ya tenemos tus datos y estamos analizando tu situacion.</p>
    <p>Un miembro de nuestro equipo se comunicara contigo en las proximas 24 horas para entender exactamente lo que buscas y como podemos ayudarte.</p>
    <p>Mientras tanto, preparamos una guia breve con lo que necesitas saber antes de entrar al mercado de Pinui-Binui:</p>
    <p style="margin:24px 0"><a href="${GUIDE_URL}" style="background:#0A1628;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">Leer la guia completa</a></p>
    <p>No trabajamos con cientos de clientes. Trabajamos con pocos, a fondo. Asi es como las operaciones se cierran bien.</p>
    <p>Hablamos pronto,</p>
    <p><strong>El equipo QUANTUM</strong><br>Cada cliente recibe todo de nosotros<br><a href="https://u-r-quantum.com" style="color:#0A1628">u-r-quantum.com</a></p>
  </div>
</div>`,
  },
  ru: {
    subject: (firstName) => `Мы получили ваш запрос, ${firstName}`,
    html: (firstName) => `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;line-height:1.7">
  <div style="background:#0A1628;padding:24px 32px;border-radius:8px 8px 0 0">
    <span style="color:#fff;font-size:22px;font-weight:700;letter-spacing:2px">QUANTUM</span>
  </div>
  <div style="padding:32px;background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
    <p>Здравствуйте, ${firstName},</p>
    <p>Спасибо, что обратились к нам. Мы получили ваши данные и уже начали работу.</p>
    <p>Один из членов нашей команды свяжется с вами в течение 24 часов, чтобы точно понять, что вы ищете и как мы можем помочь.</p>
    <p>А пока мы подготовили для вас краткое руководство о том, что важно знать перед выходом на рынок Пинуй-Бинуй:</p>
    <p style="margin:24px 0"><a href="${GUIDE_URL}" style="background:#0A1628;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">Читать полное руководство</a></p>
    <p>Мы не работаем с сотнями клиентов. Мы работаем с немногими, но глубоко. Именно так сделки закрываются правильно.</p>
    <p>До скорой связи,</p>
    <p><strong>Команда QUANTUM</strong><br>Каждый клиент получает всех нас<br><a href="https://u-r-quantum.com" style="color:#0A1628">u-r-quantum.com</a></p>
  </div>
</div>`,
  },
  de: {
    subject: (firstName) => `Wir haben Ihre Anfrage erhalten, ${firstName}`,
    html: (firstName) => `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;line-height:1.7">
  <div style="background:#0A1628;padding:24px 32px;border-radius:8px 8px 0 0">
    <span style="color:#fff;font-size:22px;font-weight:700;letter-spacing:2px">QUANTUM</span>
  </div>
  <div style="padding:32px;background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
    <p>Hallo ${firstName},</p>
    <p>Vielen Dank fur Ihre Anfrage. Wir haben Ihre Daten erhalten und beginnen bereits mit der Bearbeitung.</p>
    <p>Ein Mitglied unseres Teams wird sich innerhalb von 24 Stunden mit Ihnen in Verbindung setzen, um genau zu verstehen, was Sie suchen und wie wir Ihnen helfen konnen.</p>
    <p>In der Zwischenzeit haben wir einen kurzen Leitfaden vorbereitet, der die wichtigsten Punkte vor dem Einstieg in den Pinui-Binui-Markt erlautert:</p>
    <p style="margin:24px 0"><a href="${GUIDE_URL}" style="background:#0A1628;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">Den vollstandigen Leitfaden lesen</a></p>
    <p>Wir arbeiten nicht mit Hunderten von Kunden. Wir arbeiten mit wenigen, dafur intensiv. So werden Geschafte richtig abgeschlossen.</p>
    <p>Bis bald,</p>
    <p><strong>Das QUANTUM-Team</strong><br>Jeder Kunde bekommt uns alle<br><a href="https://u-r-quantum.com" style="color:#0A1628">u-r-quantum.com</a></p>
  </div>
</div>`,
  },
};

function detectLang(leadData) {
  const lang = leadData.form_data?.lang || leadData.utm_campaign?.match(/_(he|en|fr|es|ru|de)$/i)?.[1]?.toLowerCase();
  return WELCOME_EMAIL[lang] ? lang : 'en';
}

async function sendWelcomeEmail(leadData) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    logger.warn('[Brevo] BREVO_API_KEY not set — welcome email skipped');
    return { sent: false, reason: 'no_api_key' };
  }

  const firstName = leadData.name?.split(' ')[0] || leadData.name || '';
  const lang = detectLang(leadData);
  const template = WELCOME_EMAIL[lang];

  try {
    const res = await fetch(BREVO_API_URL, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sender: SENDER,
        to: [{ email: leadData.email, name: leadData.name }],
        subject: template.subject(firstName),
        htmlContent: template.html(firstName),
        tags: ['welcome-sequence', 'email-1', `lang-${lang}`, leadData.user_type || 'lead'],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      logger.error('[Brevo] Send failed:', res.status, err);
      return { sent: false, status: res.status };
    }

    logger.info(`[Brevo] Welcome email sent to ${leadData.email} (lang: ${lang})`);
    return { sent: true, lang };
  } catch (err) {
    logger.error('[Brevo] Request error:', err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = { sendWelcomeEmail };
