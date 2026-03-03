/**
 * WhatsApp Bot Analytics
 * Conversion metrics, funnel analysis, and performance tracking
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// Overall analytics
router.get('/whatsapp/analytics', async (req, res) => {
  try {
    const { period = '30' } = req.query; // days
    
    // Overall stats
    const overallStats = await pool.query(`
      SELECT 
        COUNT(DISTINCT l.id) as total_leads,
        COUNT(DISTINCT CASE WHEN l.status = 'converted' THEN l.id END) as converted_leads,
        COUNT(DISTINCT CASE WHEN l.status = 'active' THEN l.id END) as active_leads,
        COUNT(DISTINCT CASE WHEN l.status = 'dead' THEN l.id END) as dead_leads,
        COUNT(DISTINCT CASE WHEN l.raw_data->>'handoff' = 'true' THEN l.id END) as handed_off,
        COUNT(wc.id) as total_messages,
        COUNT(CASE WHEN wc.sender = 'user' THEN 1 END) as user_messages,
        COUNT(CASE WHEN wc.sender = 'bot' THEN 1 END) as bot_messages,
        AVG(CASE WHEN wc.sender = 'bot' AND wc.ai_metadata->>'response_time' IS NOT NULL 
            THEN (wc.ai_metadata->>'response_time')::integer END) as avg_response_time_ms
      FROM leads l
      LEFT JOIN whatsapp_conversations wc ON l.id = wc.lead_id
      WHERE l.source = 'whatsapp_bot'
        AND l.created_at >= NOW() - INTERVAL '${period} days'
    `);
    
    // Conversion rate
    const stats = overallStats.rows[0];
    const conversionRate = stats.total_leads > 0 
      ? ((stats.converted_leads / stats.total_leads) * 100).toFixed(2)
      : 0;
    
    // Average messages to conversion
    const avgMessagesToConversion = await pool.query(`
      SELECT AVG(message_count) as avg_messages
      FROM (
        SELECT l.id, COUNT(wc.id) as message_count
        FROM leads l
        INNER JOIN whatsapp_conversations wc ON l.id = wc.lead_id
        WHERE l.source = 'whatsapp_bot'
          AND l.status = 'converted'
          AND l.created_at >= NOW() - INTERVAL '${period} days'
        GROUP BY l.id
      ) as subq
    `);
    
    // Stage distribution
    const stageDistribution = await pool.query(`
      SELECT 
        COALESCE(l.raw_data->>'stage', 'unknown') as stage,
        COUNT(*) as count,
        ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) as percentage
      FROM leads l
      WHERE l.source = 'whatsapp_bot'
        AND l.created_at >= NOW() - INTERVAL '${period} days'
      GROUP BY l.raw_data->>'stage'
      ORDER BY count DESC
    `);
    
    // User type distribution
    const userTypeDistribution = await pool.query(`
      SELECT 
        COALESCE(user_type, 'unknown') as user_type,
        COUNT(*) as count,
        COUNT(CASE WHEN status = 'converted' THEN 1 END) as converted,
        ROUND(COUNT(CASE WHEN status = 'converted' THEN 1 END) * 100.0 / COUNT(*), 2) as conversion_rate
      FROM leads
      WHERE source = 'whatsapp_bot'
        AND created_at >= NOW() - INTERVAL '${period} days'
      GROUP BY user_type
    `);
    
    // Daily trends (last 7 days)
    const dailyTrends = await pool.query(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as new_leads,
        COUNT(CASE WHEN status = 'converted' THEN 1 END) as converted
      FROM leads
      WHERE source = 'whatsapp_bot'
        AND created_at >= NOW() - INTERVAL '7 days'
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `);
    
    // Response time distribution
    const responseTimeStats = await pool.query(`
      SELECT 
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (ai_metadata->>'response_time')::integer) as median_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY (ai_metadata->>'response_time')::integer) as p95_ms,
        MIN((ai_metadata->>'response_time')::integer) as min_ms,
        MAX((ai_metadata->>'response_time')::integer) as max_ms
      FROM whatsapp_conversations
      WHERE sender = 'bot' 
        AND ai_metadata->>'response_time' IS NOT NULL
        AND created_at >= NOW() - INTERVAL '${period} days'
    `);
    
    // Top performing hours
    const hourlyStats = await pool.query(`
      SELECT 
        EXTRACT(HOUR FROM created_at) as hour,
        COUNT(*) as messages,
        COUNT(DISTINCT lead_id) as unique_leads
      FROM whatsapp_conversations
      WHERE created_at >= NOW() - INTERVAL '7 days'
      GROUP BY EXTRACT(HOUR FROM created_at)
      ORDER BY hour
    `);
    
    res.json({
      success: true,
      period: `${period} days`,
      timestamp: new Date().toISOString(),
      overall: {
        total_leads: parseInt(stats.total_leads),
        converted_leads: parseInt(stats.converted_leads),
        active_leads: parseInt(stats.active_leads),
        dead_leads: parseInt(stats.dead_leads),
        handed_off_to_human: parseInt(stats.handed_off),
        conversion_rate: parseFloat(conversionRate),
        total_messages: parseInt(stats.total_messages),
        user_messages: parseInt(stats.user_messages),
        bot_messages: parseInt(stats.bot_messages),
        avg_messages_to_conversion: avgMessagesToConversion.rows[0].avg_messages 
          ? parseFloat(avgMessagesToConversion.rows[0].avg_messages).toFixed(2)
          : null,
        avg_response_time_ms: stats.avg_response_time_ms 
          ? parseFloat(stats.avg_response_time_ms).toFixed(0)
          : null
      },
      funnel: {
        by_stage: stageDistribution.rows,
        by_user_type: userTypeDistribution.rows
      },
      trends: {
        daily: dailyTrends.rows,
        hourly: hourlyStats.rows
      },
      performance: {
        response_times: responseTimeStats.rows[0]
      }
    });
  } catch (error) {
    console.error('Analytics error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Handoff candidates - leads ready for human intervention
router.get('/whatsapp/handoff-candidates', async (req, res) => {
  try {
    const candidates = await pool.query(`
      SELECT 
        l.id,
        l.phone,
        l.name,
        l.user_type,
        l.status,
        l.raw_data->>'stage' as stage,
        l.created_at,
        COUNT(wc.id) as message_count,
        MAX(wc.created_at) as last_message_at,
        l.raw_data->>'handoff_reason' as handoff_reason,
        l.raw_data->>'handoff_score' as handoff_score
      FROM leads l
      LEFT JOIN whatsapp_conversations wc ON l.id = wc.lead_id
      WHERE l.source = 'whatsapp_bot'
        AND l.status IN ('active', 'new')
        AND (
          -- Many messages (engaged but not converting)
          (SELECT COUNT(*) FROM whatsapp_conversations WHERE lead_id = l.id) >= 8
          OR 
          -- Reached scheduling stage
          l.raw_data->>'stage' = 'scheduling'
          OR
          -- High handoff score
          (l.raw_data->>'handoff_score')::integer >= 70
        )
        AND l.raw_data->>'handoff' IS NULL
      GROUP BY l.id
      ORDER BY 
        (l.raw_data->>'handoff_score')::integer DESC NULLS LAST,
        COUNT(wc.id) DESC
      LIMIT 50
    `);
    
    res.json({
      success: true,
      candidates: candidates.rows,
      total: candidates.rows.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mark lead for handoff
router.post('/whatsapp/handoff/:leadId', async (req, res) => {
  try {
    const { leadId } = req.params;
    const { assignedTo, notes } = req.body;
    
    await pool.query(`
      UPDATE leads
      SET 
        raw_data = jsonb_set(
          jsonb_set(
            jsonb_set(
              COALESCE(raw_data, '{}'::jsonb),
              '{handoff}', 'true'
            ),
            '{handoff_at}', $2
          ),
          '{handoff_to}', $3
        ),
        notes = COALESCE(notes, '') || $4,
        updated_at = NOW()
      WHERE id = $1
    `, [
      leadId, 
      JSON.stringify(new Date().toISOString()),
      JSON.stringify(assignedTo || 'human'),
      notes ? `\n[HANDOFF] ${notes}` : ''
    ]);
    
    res.json({ success: true, message: 'Lead marked for handoff' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Lead journey - full conversation flow
router.get('/whatsapp/journey/:leadId', async (req, res) => {
  try {
    const { leadId } = req.params;
    
    const lead = await pool.query(`SELECT * FROM leads WHERE id = $1`, [leadId]);
    
    if (lead.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    
    const messages = await pool.query(`
      SELECT 
        sender,
        message,
        ai_metadata,
        created_at,
        EXTRACT(EPOCH FROM (created_at - LAG(created_at) OVER (ORDER BY created_at))) as time_since_last_sec
      FROM whatsapp_conversations
      WHERE lead_id = $1
      ORDER BY created_at ASC
    `, [leadId]);
    
    // Calculate journey metrics
    const totalMessages = messages.rows.length;
    const userMessages = messages.rows.filter(m => m.sender === 'user').length;
    const botMessages = messages.rows.filter(m => m.sender === 'bot').length;
    const avgTimeBetweenMessages = messages.rows
      .filter(m => m.time_since_last_sec !== null)
      .reduce((sum, m) => sum + m.time_since_last_sec, 0) / (totalMessages - 1);
    
    // Stage progression
    const stageChanges = [];
    let currentStage = null;
    messages.rows.forEach(msg => {
      if (msg.ai_metadata?.stage && msg.ai_metadata.stage !== currentStage) {
        stageChanges.push({
          stage: msg.ai_metadata.stage,
          timestamp: msg.created_at
        });
        currentStage = msg.ai_metadata.stage;
      }
    });
    
    res.json({
      success: true,
      lead: lead.rows[0],
      messages: messages.rows,
      metrics: {
        total_messages: totalMessages,
        user_messages: userMessages,
        bot_messages: botMessages,
        avg_time_between_messages_sec: avgTimeBetweenMessages ? avgTimeBetweenMessages.toFixed(1) : null,
        conversation_duration_hours: totalMessages > 0 
          ? ((new Date(messages.rows[totalMessages - 1].created_at) - new Date(messages.rows[0].created_at)) / 3600000).toFixed(2)
          : 0
      },
      journey: {
        stage_progression: stageChanges,
        current_stage: currentStage
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
