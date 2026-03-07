const pool = require('../db/pool');
const { logger } = require('./logger');

/**
 * AUTO FIRST CONTACT SERVICE - P0
 * Sends automatic WhatsApp first contact to new sellers from Yad2 + Facebook + Kones.
 * Runs every 30 minutes via cron.
 * Issue #3: https://github.com/hemichaeli/pinuy-binuy-analyzer/issues/3
 * Issue #5: https://github.com/hemichaeli/pinuy-binuy-analyzer/issues/5 (kones)
 */

const MAX_PER_RUN = 20;        // max messages per cron run
const DELAY_BETWEEN_MS = 2500; // 2.5s between sends to avoid INFORU rate limits
const LOOKBACK_HOURS = 48;     // only contact listings created in last 48 hours

// Ensure required columns exist in listings table
async function runMigrations() {
  const migrations = [
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS phone VARCHAR(30)`,
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS contact_name VARCHAR(200)`,
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS contact_status VARCHAR(30) DEFAULT NULL`,
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS contact_attempts INT DEFAULT 0`,
    `ALTER TABLE listings ADD COLUMN IF NOT EXISTS last_contact_at TIMESTAMP`,
    `CREATE INDEX IF NOT EXISTS idx_listings_contact_status ON listings(contact_status) WHERE is_active = TRUE`,
    `CREATE INDEX IF NOT EXISTS idx_listings_phone ON listings(phone) WHERE phone IS NOT NULL`,
    // Kones contact columns
    `ALTER TABLE kones_listings ADD COLUMN IF NOT EXISTS phone VARCHAR(30)`,
    `ALTER TABLE kones_listings ADD COLUMN IF NOT EXISTS contact_status VARCHAR(30) DEFAULT NULL`,
    `ALTER TABLE kones_listings ADD COLUMN IF NOT EXISTS contact_attempts INTEGER DEFAULT 0`,
    `ALTER TABLE kones_listings ADD COLUMN IF NOT EXISTS last_contact_at TIMESTAMP`,
    `CREATE INDEX IF NOT EXISTS idx_kones_contact_status ON kones_listings(contact_status) WHERE is_active = TRUE`,
    `CREATE INDEX IF NOT EXISTS idx_kones_phone ON kones_listings(phone) WHERE phone IS NOT NULL`,
  ];

  for (const sql of migrations) {
    try {
      await pool.query(sql);
    } catch (err) {
      if (!err.message.includes('already exists')) {
        logger.warn('[AutoContact] Migration warning:', err.message);
      }
    }
  }
  logger.info('[AutoContact] Migrations applied');
}

// Build personalized message based on listing source and details
function buildMessage(listing) {
  const city = listing.city || 'האזור';
  const address = listing.address || city;
  const source = listing.source || 'yad2';

  if (source === 'facebook') {
    return `שלום,\nראיתי את הפרסום שלך על הדירה ב${address}.\nאנחנו מ-QUANTUM, משרד תיווך בוטיק המתמחה בפינוי-בינוי.\nיש לנו קונים רציניים לאזור שלך - נשמח לשוחח.\nQUANTUM Real Estate 📱`;
  }

  // yad2 / default
  return `שלום,\nראיתי שיש לך נכס למכירה ב${address}.\nאנחנו מ-QUANTUM, משרד תיווך המתמחה בפינוי-בינוי.\nיש לנו קונים רציניים מאוד לאזור שלך.\nנשמח לשוחח - QUANTUM Real Estate 🏠`;
}

// Build message for kones (receivership) listings
function buildKonesMessage(listing) {
  const city = listing.city || 'האזור';
  const address = listing.address || city;
  return `שלום,\nראינו שיש נכס בכינוס נכסים ב${address}${city !== address ? ', ' + city : ''}.\nאנחנו מ-QUANTUM, משרד תיווך בוטיק המתמחה בפינוי-בינוי.\nיש לנו קונים מעוניינים.\nהאם תרצה לשוחח? - QUANTUM Real Estate 🏗`;
}

// Normalize phone to Israeli format
function normalizePhone(phone) {
  if (!phone) return null;
  let p = String(phone).replace(/\D/g, '');
  if (p.startsWith('972')) return p;
  if (p.startsWith('0')) return '972' + p.slice(1);
  if (p.length === 9) return '972' + p;
  if (p.length === 10 && p.startsWith('05')) return '972' + p.slice(1);
  return p.length >= 9 ? p : null;
}

// Save outgoing message to whatsapp_conversations + whatsapp_messages tables
async function saveToWhatsAppTables(phone, message, listingId, source) {
  try {
    const convResult = await pool.query(
      `INSERT INTO whatsapp_conversations (phone, status, source, created_at, updated_at)
       VALUES ($1, 'active', $2, NOW(), NOW())
       ON CONFLICT (phone) DO UPDATE SET updated_at = NOW(), status = 'active'
       RETURNING id`,
      [phone, source || 'yad2']
    );

    const conversationId = convResult.rows[0]?.id;
    if (!conversationId) return;

    await pool.query(
      `INSERT INTO whatsapp_messages (conversation_id, phone, direction, message, status, listing_id, created_at)
       VALUES ($1, $2, 'outgoing', $3, 'sent', $4, NOW())`,
      [conversationId, phone, message, listingId]
    );
  } catch (err) {
    logger.warn(`[AutoContact] Could not save to WA tables: ${err.message}`);
  }
}

// Send WhatsApp via INFORU CAPI (free-text chat message)
async function sendWhatsAppMessage(phone, message) {
  const axios = require('axios');
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) throw new Error(`Invalid phone: ${phone}`);

  const username = process.env.INFORU_USERNAME || 'hemichaeli';
  const password = process.env.INFORU_PASSWORD;
  if (!password) throw new Error('INFORU_PASSWORD not configured');

  const auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

  const payload = {
    Data: {
      Message: message,
      Phone: normalizedPhone,
      Settings: {
        CustomerMessageId: `qac_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        CustomerParameter: 'QUANTUM_AUTO_CONTACT'
      }
    }
  };

  const response = await axios.post(
    'https://capi.inforu.co.il/api/v2/WhatsApp/SendWhatsAppChat',
    payload,
    {
      headers: { 'Content-Type': 'application/json', 'Authorization': auth },
      timeout: 15000,
      validateStatus: () => true
    }
  );

  return {
    success: response.data?.StatusId === 1 || response.status === 200,
    status: response.data?.StatusId,
    description: response.data?.StatusDescription,
    phone: normalizedPhone
  };
}

// Main job: find new listings and send first contact
async function runAutoFirstContact() {
  logger.info('[AutoContact] Starting run...');

  try {
    const { rows: listings } = await pool.query(
      `SELECT id, source, address, city, phone, contact_name, asking_price, source_listing_id
       FROM listings
       WHERE contact_status IS NULL
         AND phone IS NOT NULL
         AND phone != ''
         AND is_active = TRUE
         AND created_at > NOW() - INTERVAL '${LOOKBACK_HOURS} hours'
       ORDER BY created_at DESC
       LIMIT $1`,
      [MAX_PER_RUN]
    );

    if (listings.length === 0) {
      logger.info('[AutoContact] No new listings to contact');
      return { contacted: 0, skipped: 0, errors: 0 };
    }

    logger.info(`[AutoContact] Found ${listings.length} listings to contact`);

    let contacted = 0, skipped = 0, errors = 0;

    for (const listing of listings) {
      const phone = normalizePhone(listing.phone);
      if (!phone) {
        skipped++;
        await pool.query(
          `UPDATE listings SET contact_status = 'invalid_phone' WHERE id = $1`,
          [listing.id]
        );
        continue;
      }

      try {
        const message = buildMessage(listing);
        const result = await sendWhatsAppMessage(phone, message);

        if (result.success) {
          await pool.query(
            `UPDATE listings
             SET contact_status = 'contacted',
                 contact_attempts = 1,
                 last_contact_at = NOW()
             WHERE id = $1`,
            [listing.id]
          );
          await saveToWhatsAppTables(phone, message, listing.id, listing.source);
          contacted++;
          logger.info(`[AutoContact] Sent to ${phone} (listing ${listing.id}, ${listing.city})`);
        } else {
          await pool.query(
            `UPDATE listings
             SET contact_status = 'send_failed',
                 contact_attempts = COALESCE(contact_attempts, 0) + 1,
                 last_contact_at = NOW()
             WHERE id = $1`,
            [listing.id]
          );
          errors++;
          logger.warn(`[AutoContact] Send failed for ${phone}: ${result.description}`);
        }
      } catch (err) {
        errors++;
        logger.error(`[AutoContact] Error for listing ${listing.id}: ${err.message}`);
        try {
          await pool.query(
            `UPDATE listings SET contact_status = 'error', last_contact_at = NOW() WHERE id = $1`,
            [listing.id]
          );
        } catch (e) { /* ignore */ }
      }

      if (contacted + errors + skipped < listings.length) {
        await new Promise(r => setTimeout(r, DELAY_BETWEEN_MS));
      }
    }

    const summary = { contacted, skipped, errors, total: listings.length };
    logger.info('[AutoContact] Run complete:', summary);
    return summary;

  } catch (err) {
    logger.error('[AutoContact] Run failed:', err.message);
    return { contacted: 0, skipped: 0, errors: 1, fatal: err.message };
  }
}

// Issue #5: Auto first contact for KONES listings
async function runKonesAutoContact() {
  logger.info('[KonesContact] Starting run...');

  try {
    const { rows: listings } = await pool.query(
      `SELECT id, address, city, phone, contact_name, price, source_site
       FROM kones_listings
       WHERE contact_status IS NULL
         AND phone IS NOT NULL
         AND phone != ''
         AND is_active = TRUE
         AND created_at > NOW() - INTERVAL '72 hours'
       ORDER BY created_at DESC
       LIMIT $1`,
      [10]  // smaller batch for kones - more sensitive
    );

    if (listings.length === 0) {
      logger.info('[KonesContact] No new kones listings to contact');
      return { contacted: 0, skipped: 0, errors: 0 };
    }

    logger.info(`[KonesContact] Found ${listings.length} kones listings to contact`);

    let contacted = 0, skipped = 0, errors = 0;

    for (const listing of listings) {
      const phone = normalizePhone(listing.phone);
      if (!phone) {
        skipped++;
        await pool.query(
          `UPDATE kones_listings SET contact_status = 'invalid_phone' WHERE id = $1`,
          [listing.id]
        );
        continue;
      }

      try {
        const message = buildKonesMessage(listing);
        const result = await sendWhatsAppMessage(phone, message);

        if (result.success) {
          await pool.query(
            `UPDATE kones_listings
             SET contact_status = 'contacted',
                 contact_attempts = 1,
                 last_contact_at = NOW()
             WHERE id = $1`,
            [listing.id]
          );
          await saveToWhatsAppTables(phone, message, null, 'kones');
          contacted++;
          logger.info(`[KonesContact] Sent to ${phone} (kones ${listing.id}, ${listing.city})`);
        } else {
          await pool.query(
            `UPDATE kones_listings
             SET contact_status = 'send_failed',
                 contact_attempts = COALESCE(contact_attempts, 0) + 1,
                 last_contact_at = NOW()
             WHERE id = $1`,
            [listing.id]
          );
          errors++;
          logger.warn(`[KonesContact] Send failed for ${phone}: ${result.description}`);
        }
      } catch (err) {
        errors++;
        logger.error(`[KonesContact] Error for kones ${listing.id}: ${err.message}`);
        try {
          await pool.query(
            `UPDATE kones_listings SET contact_status = 'error', last_contact_at = NOW() WHERE id = $1`,
            [listing.id]
          );
        } catch (e) { /* ignore */ }
      }

      if (contacted + errors + skipped < listings.length) {
        await new Promise(r => setTimeout(r, DELAY_BETWEEN_MS));
      }
    }

    const summary = { contacted, skipped, errors, total: listings.length };
    logger.info('[KonesContact] Run complete:', summary);
    return summary;

  } catch (err) {
    logger.error('[KonesContact] Run failed:', err.message);
    return { contacted: 0, skipped: 0, errors: 1, fatal: err.message };
  }
}

// Get stats about contact activity
async function getContactStats() {
  try {
    const { rows } = await pool.query(`
      SELECT
        contact_status,
        COUNT(*) as count,
        MAX(last_contact_at) as last_sent
      FROM listings
      WHERE contact_status IS NOT NULL
      GROUP BY contact_status
      ORDER BY count DESC
    `);

    const { rows: pending } = await pool.query(`
      SELECT COUNT(*) as count
      FROM listings
      WHERE contact_status IS NULL
        AND phone IS NOT NULL
        AND is_active = TRUE
        AND created_at > NOW() - INTERVAL '48 hours'
    `);

    let konesStats = [];
    try {
      const { rows: kr } = await pool.query(`
        SELECT contact_status, COUNT(*) as count
        FROM kones_listings
        WHERE contact_status IS NOT NULL
        GROUP BY contact_status
        ORDER BY count DESC
      `);
      konesStats = kr;
    } catch (e) { /* kones columns might not exist yet */ }

    return {
      statuses: rows,
      pending_count: parseInt(pending[0]?.count || 0),
      kones_statuses: konesStats,
      timestamp: new Date().toISOString()
    };
  } catch (err) {
    return { error: err.message };
  }
}

// Initialize: run migrations and return public interface
async function initialize() {
  await runMigrations();
  logger.info('[AutoContact] Service initialized');
}

module.exports = {
  initialize,
  runAutoFirstContact,
  runKonesAutoContact,
  getContactStats,
  runMigrations
};
