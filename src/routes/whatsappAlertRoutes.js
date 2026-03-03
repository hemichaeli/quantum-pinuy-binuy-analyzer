/**
 * WhatsApp Alert Subscription Routes
 * Manage custom alert subscriptions per lead
 */

const express = require('express');
const router = express.Router();
const alertService = require('../services/whatsappAlertService');
const pool = require('../db/pool');

// Get all subscriptions for a lead
router.get('/whatsapp/subscriptions/:leadId', async (req, res) => {
  try {
    const { leadId } = req.params;
    const subscriptions = await alertService.getSubscriptions(leadId);
    
    res.json({
      success: true,
      leadId: parseInt(leadId),
      subscriptions,
      total: subscriptions.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create new subscription
router.post('/whatsapp/subscriptions', async (req, res) => {
  try {
    const { leadId, criteria } = req.body;
    
    if (!leadId) {
      return res.status(400).json({ error: 'leadId is required' });
    }
    
    // Validate criteria structure
    const validCriteria = {
      cities: criteria.cities || null,  // Array of city names
      rooms_min: criteria.rooms_min || null,
      rooms_max: criteria.rooms_max || null,
      size_min: criteria.size_min || null,
      size_max: criteria.size_max || null,
      price_min: criteria.price_min || null,
      price_max: criteria.price_max || null,
      complex_ids: criteria.complex_ids || null  // Array of complex IDs
    };
    
    const subscription = await alertService.createSubscription(leadId, validCriteria);
    
    res.json({
      success: true,
      subscription,
      message: 'Subscription created - you will receive WhatsApp alerts for matching listings'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update subscription criteria
router.put('/whatsapp/subscriptions/:subscriptionId', async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    const { criteria } = req.body;
    
    const validCriteria = {
      cities: criteria.cities || null,
      rooms_min: criteria.rooms_min || null,
      rooms_max: criteria.rooms_max || null,
      size_min: criteria.size_min || null,
      size_max: criteria.size_max || null,
      price_min: criteria.price_min || null,
      price_max: criteria.price_max || null,
      complex_ids: criteria.complex_ids || null
    };
    
    const subscription = await alertService.updateSubscription(subscriptionId, validCriteria);
    
    res.json({
      success: true,
      subscription,
      message: 'Subscription updated'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Toggle subscription active/inactive
router.patch('/whatsapp/subscriptions/:subscriptionId/toggle', async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    const { active } = req.body;
    
    const subscription = await alertService.toggleSubscription(subscriptionId, active);
    
    res.json({
      success: true,
      subscription,
      message: active ? 'Subscription activated' : 'Subscription paused'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete subscription
router.delete('/whatsapp/subscriptions/:subscriptionId', async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    
    await pool.query('DELETE FROM whatsapp_subscriptions WHERE id = $1', [subscriptionId]);
    
    res.json({
      success: true,
      message: 'Subscription deleted'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get alert history for a subscription
router.get('/whatsapp/subscriptions/:subscriptionId/history', async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    const { limit = 50 } = req.query;
    
    const history = await pool.query(`
      SELECT 
        wal.*,
        l.address,
        l.city,
        l.price,
        l.rooms,
        l.size_sqm,
        l.source_url
      FROM whatsapp_alert_log wal
      INNER JOIN listings l ON wal.listing_id = l.id
      WHERE wal.subscription_id = $1
      ORDER BY wal.sent_at DESC
      LIMIT $2
    `, [subscriptionId, limit]);
    
    res.json({
      success: true,
      history: history.rows,
      total: history.rows.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test subscription - show what listings would match
router.post('/whatsapp/subscriptions/test', async (req, res) => {
  try {
    const { criteria, limit = 10 } = req.body;
    
    // Build WHERE clause from criteria
    const conditions = ['created_at > NOW() - INTERVAL \'7 days\''];
    const params = [];
    let paramIdx = 1;
    
    if (criteria.cities && criteria.cities.length > 0) {
      conditions.push(`city = ANY($${paramIdx++})`);
      params.push(criteria.cities);
    }
    
    if (criteria.rooms_min) {
      conditions.push(`rooms >= $${paramIdx++}`);
      params.push(criteria.rooms_min);
    }
    
    if (criteria.rooms_max) {
      conditions.push(`rooms <= $${paramIdx++}`);
      params.push(criteria.rooms_max);
    }
    
    if (criteria.size_min) {
      conditions.push(`size_sqm >= $${paramIdx++}`);
      params.push(criteria.size_min);
    }
    
    if (criteria.size_max) {
      conditions.push(`size_sqm <= $${paramIdx++}`);
      params.push(criteria.size_max);
    }
    
    if (criteria.price_min) {
      conditions.push(`price >= $${paramIdx++}`);
      params.push(criteria.price_min);
    }
    
    if (criteria.price_max) {
      conditions.push(`price <= $${paramIdx++}`);
      params.push(criteria.price_max);
    }
    
    if (criteria.complex_ids && criteria.complex_ids.length > 0) {
      conditions.push(`complex_id = ANY($${paramIdx++})`);
      params.push(criteria.complex_ids);
    }
    
    params.push(limit);
    
    const query = `
      SELECT 
        id, address, city, price, rooms, size_sqm, 
        complex_id, source, created_at
      FROM listings
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${paramIdx}
    `;
    
    const matches = await pool.query(query, params);
    
    res.json({
      success: true,
      criteria,
      matches: matches.rows,
      matchCount: matches.rows.length,
      message: `Found ${matches.rows.length} listings matching your criteria from the last 7 days`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Manually trigger alert for specific listing (testing)
router.post('/whatsapp/alerts/trigger', async (req, res) => {
  try {
    const { listingId } = req.body;
    
    if (!listingId) {
      return res.status(400).json({ error: 'listingId is required' });
    }
    
    const listing = await pool.query('SELECT * FROM listings WHERE id = $1', [listingId]);
    
    if (listing.rows.length === 0) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    
    const result = await alertService.processNewListing(listing.rows[0]);
    
    res.json({
      success: true,
      result,
      message: `Alert sent to ${result.sent} subscribers`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get subscription stats
router.get('/whatsapp/subscriptions/stats', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(DISTINCT ws.id) as total_subscriptions,
        COUNT(DISTINCT CASE WHEN ws.active = true THEN ws.id END) as active_subscriptions,
        COUNT(DISTINCT ws.lead_id) as unique_leads,
        COUNT(wal.id) as total_alerts_sent,
        COUNT(DISTINCT CASE WHEN wal.sent_at >= NOW() - INTERVAL '24 hours' THEN wal.id END) as alerts_last_24h,
        COUNT(DISTINCT CASE WHEN wal.sent_at >= NOW() - INTERVAL '7 days' THEN wal.id END) as alerts_last_7d
      FROM whatsapp_subscriptions ws
      LEFT JOIN whatsapp_alert_log wal ON ws.id = wal.subscription_id
    `);
    
    // Most popular filters
    const popularFilters = await pool.query(`
      SELECT 
        jsonb_object_keys(criteria) as filter_type,
        COUNT(*) as usage_count
      FROM whatsapp_subscriptions
      WHERE active = true
      GROUP BY filter_type
      ORDER BY usage_count DESC
    `);
    
    res.json({
      success: true,
      stats: stats.rows[0],
      popularFilters: popularFilters.rows
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
