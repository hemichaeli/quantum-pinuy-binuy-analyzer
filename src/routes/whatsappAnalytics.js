/**
 * WhatsApp Bot Analytics & Insights
 * Conversion rates, performance metrics, handoff analytics
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// Main analytics dashboard
router.get('/whatsapp/analytics', async (req, res) => {
  try {
    // Overall stats
    const overallStats = await pool.query(`
      SELECT 
        COUNT(DISTINCT l.id) as total_leads,
        COUNT(DISTINCT CASE WHEN l.status = 'new' THEN l.id END) as new_leads,
        COUNT(DISTINCT CASE WHEN l.status = 'active' THEN l.id END) as active_leads,
        COUNT(DISTINCT CASE WHEN l.status = 'qualified' THEN l.id END) as qualified_leads,
        COUNT(DISTINCT CASE WHEN l.status = 'meeting_scheduled' THEN l.id END) as meetings_scheduled,
        COUNT(DISTINCT CASE WHEN l.status = 'closed_won' THEN l.id END) as closed_won,
        COUNT(DISTINCT CASE WHEN l.status = 'closed_lost' THEN l.id END) as closed_lost,
        COUNT(DISTINCT CASE WHEN l.raw_data->>'handoff_requested' = 'true' THEN l.id END) as handoff_requests,
        COUNT(DISTINCT CASE WHEN l.user_type = 'buyer' THEN l.id END) as buyers,
        COUNT(DISTINCT CASE WHEN l.user_type = 'seller' THEN l.id END) as sellers
      FROM leads l
      WHERE l.source = 'whatsapp_bot'
    `);
    
    // Conversation metrics
    const conversationMetrics = await pool.query(`
      SELECT 
        COUNT(*) as total_messages,
        COUNT(CASE WHEN sender = 'user' THEN 1 END) as user_messages,
        COUNT(CASE WHEN sender = 'bot' THEN 1 END) as bot_messages,
        ROUND(AVG(message_count), 2) as avg_messages_per_lead
      FROM whatsapp_conversations wc
      CROSS JOIN LATERAL (
        SELECT COUNT(*) as message_count
        FROM whatsapp_conversations
        WHERE lead_id = wc.lead_id
      ) mc
    `);
    
    // Time-based metrics
    const timeMetrics = await pool.query(`
      SELECT 
        ROUND(AVG(EXTRACT(EPOCH FROM (first_bot_response - first_user_message)) / 60), 2) as avg_first_response_minutes,
        ROUND(AVG(conversation_duration_hours), 2) as avg_conversation_duration_hours
      FROM (
        SELECT 
          l.id,
          MIN(CASE WHEN wc.sender = 'user' THEN wc.created_at END) as first_user_message,
          MIN(CASE WHEN wc.sender = 'bot' THEN wc.created_at END) as first_bot_response,
          EXTRACT(EPOCH FROM (MAX(wc.created_at) - MIN(wc.created_at))) / 3600 as conversation_duration_hours
        FROM leads l
        INNER JOIN whatsapp_conversations wc ON l.id = wc.lead_id
        WHERE l.source = 'whatsapp_bot'
        GROUP BY l.id
      ) timing
    `);
    
    // Stage distribution
    const stageDistribution = await pool.query(`
      SELECT 
        COALESCE(raw_data->>'stage', 'unknown') as stage,
        COUNT(*) as count
      FROM leads
      WHERE source = 'whatsapp_bot'
      GROUP BY raw_data->>'stage'
      ORDER BY count DESC
    `);
    
    // Conversion funnel
    const conversionFunnel = await pool.query(`
      SELECT 
        COUNT(*) as started,
        COUNT(CASE WHEN raw_data->>'stage' IN ('info_gathering', 'scheduling') THEN 1 END) as engaged,
        COUNT(CASE WHEN raw_data->>'stage' = 'scheduling' THEN 1 END) as scheduling,
        COUNT(CASE WHEN status = 'meeting_scheduled' THEN 1 END) as meeting_scheduled,
        COUNT(CASE WHEN status = 'closed_won' THEN 1 END) as closed
      FROM leads
      WHERE source = 'whatsapp_bot'
    `);
    
    // Calculate conversion rates
    const funnel = conversionFunnel.rows[0];
    const conversionRates = {
      started_to_engaged: funnel.started > 0 ? ((funnel.engaged / funnel.started) * 100).toFixed(2) : 0,
      engaged_to_scheduling: funnel.engaged > 0 ? ((funnel.scheduling / funnel.engaged) * 100).toFixed(2) : 0,
      scheduling_to_meeting: funnel.scheduling > 0 ? ((funnel.meeting_scheduled / funnel.scheduling) * 100).toFixed(2) : 0,
      meeting_to_closed: funnel.meeting_scheduled > 0 ? ((funnel.closed / funnel.meeting_scheduled) * 100).toFixed(2) : 0,
      overall: funnel.started > 0 ? ((funnel.closed / funnel.started) * 100).toFixed(2) : 0
    };
    
    // Daily activity (last 7 days)
    const dailyActivity = await pool.query(`
      SELECT 
        DATE(created_at) as date,
        COUNT(DISTINCT lead_id) as active_leads,
        COUNT(*) as messages
      FROM whatsapp_conversations
      WHERE created_at >= NOW() - INTERVAL '7 days'
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `);
    
    // Top performing hours
    const hourlyPerformance = await pool.query(`
      SELECT 
        EXTRACT(HOUR FROM created_at) as hour,
        COUNT(DISTINCT lead_id) as leads,
        COUNT(*) as messages
      FROM whatsapp_conversations
      WHERE sender = 'user'
      GROUP BY EXTRACT(HOUR FROM created_at)
      ORDER BY messages DESC
      LIMIT 5
    `);
    
    // Handoff analytics
    const handoffAnalytics = await pool.query(`
      SELECT 
        COUNT(*) as total_handoffs,
        COUNT(CASE WHEN raw_data->>'handoff_completed' = 'true' THEN 1 END) as completed_handoffs,
        ROUND(AVG(
          CASE 
            WHEN raw_data->>'handoff_completed_at' IS NOT NULL 
            THEN EXTRACT(EPOCH FROM (
              (raw_data->>'handoff_completed_at')::timestamp - 
              (raw_data->>'handoff_requested_at')::timestamp
            )) / 3600
          END
        ), 2) as avg_handoff_time_hours
      FROM leads
      WHERE source = 'whatsapp_bot' 
        AND raw_data->>'handoff_requested' = 'true'
    `);
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      overall: overallStats.rows[0],
      conversations: conversationMetrics.rows[0],
      timing: timeMetrics.rows[0],
      stages: stageDistribution.rows,
      funnel: funnel,
      conversion_rates: conversionRates,
      daily_activity: dailyActivity.rows,
      peak_hours: hourlyPerformance.rows,
      handoffs: handoffAnalytics.rows[0]
    });
  } catch (error) {
    console.error('Analytics error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Lead quality scoring
router.get('/whatsapp/lead-quality', async (req, res) => {
  try {
    const leads = await pool.query(`
      SELECT 
        l.id,
        l.phone,
        l.name,
        l.user_type,
        l.status,
        l.raw_data->>'stage' as stage,
        COUNT(wc.id) as message_count,
        MAX(wc.created_at) as last_activity,
        EXTRACT(EPOCH FROM (NOW() - MAX(wc.created_at))) / 3600 as hours_since_last_activity,
        -- Quality score calculation
        CASE 
          WHEN l.status = 'meeting_scheduled' THEN 100
          WHEN l.status = 'qualified' THEN 90
          WHEN l.raw_data->>'stage' = 'scheduling' THEN 80
          WHEN l.raw_data->>'stage' = 'info_gathering' AND COUNT(wc.id) >= 5 THEN 70
          WHEN l.raw_data->>'stage' = 'info_gathering' THEN 60
          WHEN l.raw_data->>'stage' = 'greeting' AND COUNT(wc.id) >= 3 THEN 50
          ELSE 30
        END as quality_score
      FROM leads l
      LEFT JOIN whatsapp_conversations wc ON l.id = wc.lead_id
      WHERE l.source = 'whatsapp_bot'
        AND l.status NOT IN ('closed_won', 'closed_lost')
      GROUP BY l.id
      ORDER BY quality_score DESC, last_activity DESC
      LIMIT 50
    `);
    
    res.json({
      success: true,
      leads: leads.rows,
      scoring_rules: {
        100: 'Meeting scheduled',
        90: 'Qualified lead',
        80: 'In scheduling stage',
        70: 'Info gathering - engaged (5+ messages)',
        60: 'Info gathering',
        50: 'Greeting - engaged (3+ messages)',
        30: 'Low engagement'
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Performance by time period
router.get('/whatsapp/performance/:period', async (req, res) => {
  try {
    const { period } = req.params; // 'day', 'week', 'month'
    
    let interval;
    if (period === 'day') interval = '1 day';
    else if (period === 'week') interval = '7 days';
    else if (period === 'month') interval = '30 days';
    else return res.status(400).json({ error: 'Invalid period. Use: day, week, month' });
    
    const stats = await pool.query(`
      SELECT 
        COUNT(DISTINCT l.id) as new_leads,
        COUNT(DISTINCT CASE WHEN l.status = 'qualified' THEN l.id END) as qualified,
        COUNT(DISTINCT CASE WHEN l.status = 'meeting_scheduled' THEN l.id END) as meetings,
        COUNT(DISTINCT CASE WHEN l.status = 'closed_won' THEN l.id END) as closed_won,
        COUNT(wc.id) as total_messages,
        ROUND(AVG(messages_per_lead.count), 2) as avg_messages_per_lead
      FROM leads l
      LEFT JOIN whatsapp_conversations wc ON l.id = wc.lead_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*) as count
        FROM whatsapp_conversations
        WHERE lead_id = l.id
      ) messages_per_lead ON true
      WHERE l.source = 'whatsapp_bot'
        AND l.created_at >= NOW() - INTERVAL '${interval}'
    `);
    
    res.json({
      success: true,
      period: period,
      interval: interval,
      stats: stats.rows[0]
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
