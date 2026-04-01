/**
 * External Call Center Routes
 *
 * Allows QUANTUM admin to create "call lists" from filtered listings,
 * share a link with an external call center, and let agents update
 * call outcomes: interested, sent agreement, not interested, etc.
 *
 * Admin routes (require dashboard access):
 *   POST /api/callcenter/lists           — Create new call list
 *   GET  /api/callcenter/lists           — All lists
 *   GET  /api/callcenter/lists/:id       — Single list with items
 *   DELETE /api/callcenter/lists/:id     — Delete list
 *   GET  /api/callcenter/lists/:id/stats — Summary stats
 *
 * External routes (token-based, no auth):
 *   GET  /callcenter/:token              — Serve call center page
 *   GET  /api/callcenter/ext/:token      — Get list data (JSON)
 *   PUT  /api/callcenter/ext/:token/item/:itemId — Update item status
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const pool = require('../db/pool');
const { logger } = require('../services/logger');

// ── Auto-migration ──────────────────────────────────────────────────────────

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS callcenter_lists (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        token VARCHAR(64) NOT NULL UNIQUE,
        created_by VARCHAR(100) DEFAULT 'admin',
        filters JSONB DEFAULT '{}',
        notes TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS callcenter_items (
        id SERIAL PRIMARY KEY,
        list_id INTEGER NOT NULL REFERENCES callcenter_lists(id) ON DELETE CASCADE,
        listing_id INTEGER REFERENCES listings(id),
        contact_name VARCHAR(255),
        phone VARCHAR(50) NOT NULL,
        address VARCHAR(500),
        city VARCHAR(100),
        rooms VARCHAR(20),
        price VARCHAR(50),
        source VARCHAR(50),
        notes TEXT,
        call_status VARCHAR(50) DEFAULT 'pending',
        call_outcome VARCHAR(100),
        agent_name VARCHAR(100),
        called_at TIMESTAMPTZ,
        agreement_sent BOOLEAN DEFAULT FALSE,
        agreement_sent_at TIMESTAMPTZ,
        interested BOOLEAN,
        follow_up_date DATE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_callcenter_items_list ON callcenter_items(list_id);
      CREATE INDEX IF NOT EXISTS idx_callcenter_items_status ON callcenter_items(call_status);
      CREATE INDEX IF NOT EXISTS idx_callcenter_lists_token ON callcenter_lists(token);
    `);
    logger.info('[CallCenter] Tables ready');
  } catch (e) {
    logger.warn('[CallCenter] Migration:', e.message);
  }
})();

// ============================================================
// ADMIN: Create call list from filtered listings
// ============================================================

router.post('/lists', async (req, res) => {
  try {
    const { name, listing_ids, filters, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const token = crypto.randomBytes(24).toString('hex');

    // Create list
    const { rows: [list] } = await pool.query(`
      INSERT INTO callcenter_lists (name, token, filters, notes)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [name, token, JSON.stringify(filters || {}), notes || null]);

    let items = [];

    if (listing_ids && listing_ids.length > 0) {
      // Use specific listing IDs
      const { rows: listings } = await pool.query(`
        SELECT id, contact_name, phone, contact_phone, address, city,
               rooms, asking_price, source
        FROM listings
        WHERE id = ANY($1) AND phone IS NOT NULL AND phone != ''
      `, [listing_ids]);
      items = listings;
    } else if (filters) {
      // Build from filters
      let conditions = ["l.is_active = TRUE", "(l.phone IS NOT NULL AND l.phone != '')"];
      let params = [];
      let idx = 1;

      if (filters.city) { conditions.push(`l.city = $${idx++}`); params.push(filters.city); }
      if (filters.cities && filters.cities.length) { conditions.push(`l.city = ANY($${idx++})`); params.push(filters.cities); }
      if (filters.source) { conditions.push(`l.source = $${idx++}`); params.push(filters.source); }
      if (filters.min_price) { conditions.push(`l.asking_price >= $${idx++}`); params.push(filters.min_price); }
      if (filters.max_price) { conditions.push(`l.asking_price <= $${idx++}`); params.push(filters.max_price); }
      if (filters.min_rooms) { conditions.push(`l.rooms >= $${idx++}`); params.push(filters.min_rooms); }
      if (filters.max_rooms) { conditions.push(`l.rooms <= $${idx++}`); params.push(filters.max_rooms); }
      if (filters.message_status) { conditions.push(`l.message_status = $${idx++}`); params.push(filters.message_status); }
      if (filters.no_message) { conditions.push(`(l.message_status IS NULL OR l.message_status = 'לא נשלחה')`); }

      const limit = filters.limit || 500;
      const { rows: listings } = await pool.query(`
        SELECT id, contact_name, phone, contact_phone, address, city,
               rooms, asking_price, source
        FROM listings l
        WHERE ${conditions.join(' AND ')}
        ORDER BY l.created_at DESC LIMIT ${parseInt(limit)}
      `, params);
      items = listings;
    }

    if (items.length === 0) {
      // Clean up empty list
      await pool.query(`DELETE FROM callcenter_lists WHERE id = $1`, [list.id]);
      return res.status(400).json({ error: 'No listings match filters / no phone numbers' });
    }

    // Insert items
    const insertValues = items.map((l, i) => {
      const base = i * 8;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
    }).join(', ');

    const insertParams = items.flatMap(l => [
      list.id,
      l.id,
      l.contact_name || '',
      l.phone || l.contact_phone || '',
      l.address || '',
      l.city || '',
      l.rooms ? String(l.rooms) : '',
      l.asking_price ? `${Number(l.asking_price).toLocaleString()} ₪` : '',
    ]);

    await pool.query(`
      INSERT INTO callcenter_items (list_id, listing_id, contact_name, phone, address, city, rooms, price)
      VALUES ${insertValues}
    `, insertParams);

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({
      success: true,
      list: { ...list, item_count: items.length },
      share_url: `${baseUrl}/callcenter/${token}`,
      token,
    });
  } catch (err) {
    logger.error('[CallCenter] Create list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── List all call lists ─────────────────────────────────────────────────────

router.get('/lists', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT cl.*,
        (SELECT COUNT(*) FROM callcenter_items ci WHERE ci.list_id = cl.id) as total_items,
        (SELECT COUNT(*) FROM callcenter_items ci WHERE ci.list_id = cl.id AND ci.call_status = 'called') as called,
        (SELECT COUNT(*) FROM callcenter_items ci WHERE ci.list_id = cl.id AND ci.interested = TRUE) as interested,
        (SELECT COUNT(*) FROM callcenter_items ci WHERE ci.list_id = cl.id AND ci.agreement_sent = TRUE) as agreements_sent
      FROM callcenter_lists cl
      WHERE cl.is_active = TRUE
      ORDER BY cl.created_at DESC
    `);
    res.json({ lists: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Single list with items ──────────────────────────────────────────────────

router.get('/lists/:id', async (req, res) => {
  try {
    const { rows: [list] } = await pool.query(`SELECT * FROM callcenter_lists WHERE id = $1`, [req.params.id]);
    if (!list) return res.status(404).json({ error: 'List not found' });

    const { rows: items } = await pool.query(`
      SELECT * FROM callcenter_items WHERE list_id = $1 ORDER BY id ASC
    `, [list.id]);

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({ list, items, share_url: `${baseUrl}/callcenter/${list.token}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Delete list ─────────────────────────────────────────────────────────────

router.delete('/lists/:id', async (req, res) => {
  try {
    await pool.query(`UPDATE callcenter_lists SET is_active = FALSE WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── List stats ──────────────────────────────────────────────────────────────

router.get('/lists/:id/stats', async (req, res) => {
  try {
    const { rows: [stats] } = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE call_status = 'pending') as pending,
        COUNT(*) FILTER (WHERE call_status = 'called') as called,
        COUNT(*) FILTER (WHERE call_status = 'no_answer') as no_answer,
        COUNT(*) FILTER (WHERE call_status = 'callback') as callback,
        COUNT(*) FILTER (WHERE interested = TRUE) as interested,
        COUNT(*) FILTER (WHERE interested = FALSE) as not_interested,
        COUNT(*) FILTER (WHERE agreement_sent = TRUE) as agreements_sent,
        COUNT(*) FILTER (WHERE follow_up_date IS NOT NULL) as has_followup
      FROM callcenter_items WHERE list_id = $1
    `, [req.params.id]);
    res.json(stats);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// EXTERNAL: Token-based access for call center agents
// ============================================================

// ── Serve the call center page ──────────────────────────────────────────────

router.get('/:token', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name FROM callcenter_lists WHERE token = $1 AND is_active = TRUE`, [req.params.token]
    );
    if (rows.length === 0) return res.status(404).send('רשימה לא נמצאה או לא פעילה');
    res.sendFile(path.join(__dirname, '../public/callcenter.html'));
  } catch (err) { res.status(500).send('שגיאת שרת'); }
});

// ── Get list data via token ─────────────────────────────────────────────────

router.get('/ext/:token', async (req, res) => {
  try {
    const { rows: [list] } = await pool.query(
      `SELECT id, name, notes, created_at FROM callcenter_lists WHERE token = $1 AND is_active = TRUE`,
      [req.params.token]
    );
    if (!list) return res.status(404).json({ error: 'List not found' });

    const { status, agent } = req.query;
    let conditions = ['list_id = $1'];
    let params = [list.id];
    let idx = 2;

    if (status) { conditions.push(`call_status = $${idx++}`); params.push(status); }
    if (agent) { conditions.push(`agent_name = $${idx++}`); params.push(agent); }

    const { rows: items } = await pool.query(`
      SELECT * FROM callcenter_items
      WHERE ${conditions.join(' AND ')}
      ORDER BY
        CASE call_status
          WHEN 'pending' THEN 0
          WHEN 'callback' THEN 1
          WHEN 'no_answer' THEN 2
          WHEN 'called' THEN 3
        END,
        id ASC
    `, params);

    // Stats
    const { rows: [stats] } = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE call_status = 'pending') as pending,
        COUNT(*) FILTER (WHERE call_status = 'called') as called,
        COUNT(*) FILTER (WHERE call_status = 'no_answer') as no_answer,
        COUNT(*) FILTER (WHERE call_status = 'callback') as callback,
        COUNT(*) FILTER (WHERE interested = TRUE) as interested,
        COUNT(*) FILTER (WHERE agreement_sent = TRUE) as agreements_sent
      FROM callcenter_items WHERE list_id = $1
    `, [list.id]);

    res.json({ list, items, stats });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Update item status ──────────────────────────────────────────────────────

router.put('/ext/:token/item/:itemId', async (req, res) => {
  try {
    // Verify token
    const { rows: [list] } = await pool.query(
      `SELECT id FROM callcenter_lists WHERE token = $1 AND is_active = TRUE`,
      [req.params.token]
    );
    if (!list) return res.status(404).json({ error: 'Invalid token' });

    const itemId = parseInt(req.params.itemId);
    const {
      call_status, call_outcome, agent_name, notes,
      interested, agreement_sent, follow_up_date
    } = req.body;

    let updates = ['updated_at = NOW()'];
    let params = [];
    let idx = 1;

    if (call_status !== undefined) {
      updates.push(`call_status = $${idx++}`); params.push(call_status);
      if (call_status === 'called' || call_status === 'no_answer' || call_status === 'callback') {
        updates.push(`called_at = COALESCE(called_at, NOW())`);
      }
    }
    if (call_outcome !== undefined) { updates.push(`call_outcome = $${idx++}`); params.push(call_outcome); }
    if (agent_name !== undefined) { updates.push(`agent_name = $${idx++}`); params.push(agent_name); }
    if (notes !== undefined) { updates.push(`notes = $${idx++}`); params.push(notes); }
    if (interested !== undefined) { updates.push(`interested = $${idx++}`); params.push(interested); }
    if (agreement_sent !== undefined) {
      updates.push(`agreement_sent = $${idx++}`); params.push(agreement_sent);
      if (agreement_sent) updates.push(`agreement_sent_at = COALESCE(agreement_sent_at, NOW())`);
    }
    if (follow_up_date !== undefined) { updates.push(`follow_up_date = $${idx++}`); params.push(follow_up_date || null); }

    params.push(itemId, list.id);
    const { rows } = await pool.query(`
      UPDATE callcenter_items SET ${updates.join(', ')}
      WHERE id = $${idx++} AND list_id = $${idx++}
      RETURNING *
    `, params);

    if (rows.length === 0) return res.status(404).json({ error: 'Item not found' });

    // Sync back to listings table if interested or agreement sent
    const item = rows[0];
    if (item.listing_id) {
      if (interested === true) {
        await pool.query(`UPDATE listings SET deal_status = 'בטיפול', updated_at = NOW() WHERE id = $1`, [item.listing_id]).catch(() => {});
      }
      if (agreement_sent === true) {
        await pool.query(`UPDATE listings SET deal_status = 'תיווך', notes = COALESCE(notes, '') || ' | הסכם תיווך נשלח ' || NOW()::DATE::TEXT, updated_at = NOW() WHERE id = $1`, [item.listing_id]).catch(() => {});
      }
      if (interested === false) {
        await pool.query(`UPDATE listings SET deal_status = 'לא רלוונטי', updated_at = NOW() WHERE id = $1`, [item.listing_id]).catch(() => {});
      }
    }

    res.json({ success: true, item: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
