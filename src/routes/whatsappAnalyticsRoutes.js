/**
 * WhatsApp Bot Analytics & Handoff Management
 * v1.0 - Comprehensive analytics + human handoff system
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const axios = require('axios');

const INFORU_CAPI_BASE = 'https://capi.inforu.co.il/api/v2';

function getBasicAuth() {
  const username = process.env.INFORU_USERNAME;
  const password = process.env.INFORU_PASSWORD;
  if (!username || !password) throw new Error('INFORU credentials not configured');
  return Buffer.from(`${username}:${password}`).toString('base64');
}

// ============================================
// ANALYTICS DASHBOARD
// ============================================
router.get('/whatsapp/analytics', async (req, res) => {
  try {
    const { period = '7d' } = req.query;
    
    // Calculate date range
    let dateFilter = "created_at >= NOW() - INTERVAL '7 days'";
    if (period === '24h') dateFilter = "created_at >= NOW() - INTERVAL '24 hours'";
    else if (period === '30d') dateFilter = "created_at >= NOW() - INTERVAL '30 days'";
    else if (period === 'all') dateFilter = "1=1";
    
    // Overall metrics
    const overallStats = await pool.query(`
      SELECT 
        COUNT(DISTINCT l.id) as total_leads,
        COUNT(DISTINCT CASE WHEN l.status = 'new' THEN l.id END) as new_leads,
        COUNT(DISTINCT CASE WHEN l.status = 'active' THEN l.id END) as active_leads,
        COUNT(DISTINCT CASE WHEN l.status = 'qualified' THEN l.id END) as qualified_leads,
        COUNT(DISTINCT CASE WHEN l.status = 'converted' THEN l.id END) as converted_leads,
        COUNT(DISTINCT CASE WHEN l.status = 'closed' THEN l.id END) as closed_leads,
        COUNT(DISTINCT CASE WHEN l.raw_data->>'handoff_requested' = 'true' THEN l.id END) as handoff_requested,
        COUNT(DISTINCT CASE WHEN l.user_type = 'buyer' THEN l.id END) as buyers,
        COUNT(DISTINCT CASE WHEN l.user_type = 'seller' THEN l.id END) as sellers
      FROM leads l
      WHERE l.source = 'whatsapp_bot' AND ${dateFilter}
    `);
    
    // Conversation metrics
    const conversationStats = await pool.query(`
      SELECT 
        COUNT(*) as total_messages,
        COUNT(CASE WHEN sender = 'user' THEN 1 END) as user_messages,
        COUNT(CASE WHEN sender = 'bot' THEN 1 END) as bot_messages,
        AVG(CASE WHEN sender = 'user' THEN length(message) END)::int as avg_user_message_length,
        AVG(CASE WHEN sender = 'bot' THEN length(message) END)::int as avg_bot_message_length
      FROM whatsapp_conversations wc
      INNER JOIN leads l ON wc.lead_id = l.id
      WHERE l.source = 'whatsapp_bot' AND ${dateFilter.replace('created_at', 'wc.created_at')}
    `);
    
    // Average messages per lead
    const avgMessagesPerLead = await pool.query(`
      SELECT 
        AVG(message_count)::numeric(10,2) as avg_messages_per_lead,
        MAX(message_count) as max_messages,
        MIN(message_count) as min_messages
      FROM (
        SELECT lead_id, COUNT(*) as message_count
        FROM whatsapp_conversations wc
        INNER JOIN leads l ON wc.lead_id = l.id
        WHERE l.source = 'whatsapp_bot' AND ${dateFilter.replace('created_at', 'wc.created_at')}
        GROUP BY lead_id
      ) t
    `);
    
    // Stage distribution
    const stageDistribution = await pool.query(`
      SELECT 
        COALESCE(raw_data->>'stage', 'unknown') as stage,
        COUNT(*) as count
      FROM leads
      WHERE source = 'whatsapp_bot' AND ${dateFilter}
      GROUP BY raw_data->>'stage'
      ORDER BY count DESC
    `);
    
    // Response time (time from user message to bot response)
    const responseTime = await pool.query(`
      WITH response_times AS (
        SELECT 
          wc1.created_at as user_time,
          wc2.created_at as bot_time,
          EXTRACT(EPOCH FROM (wc2.created_at - wc1.created_at)) as seconds
        FROM whatsapp_conversations wc1
        INNER JOIN whatsapp_conversations wc2 
          ON wc1.lead_id = wc2.lead_id 
          AND wc2.id = (
            SELECT MIN(id) 
            FROM whatsapp_conversations 
            WHERE lead_id = wc1.lead_id 
              AND sender = 'bot' 
              AND created_at > wc1.created_at
          )
        WHERE wc1.sender = 'user'
      )
      SELECT 
        AVG(seconds)::numeric(10,2) as avg_response_seconds,
        MIN(seconds)::numeric(10,2) as min_response_seconds,
        MAX(seconds)::numeric(10,2) as max_response_seconds
      FROM response_times
      WHERE seconds < 3600
    `);
    
    // Conversion funnel
    const conversionFunnel = {
      greeting: 0,
      info_gathering: 0,
      scheduling: 0,
      qualified: 0,
      converted: 0
    };
    
    const funnelData = await pool.query(`
      SELECT 
        COALESCE(raw_data->>'stage', 'greeting') as stage,
        status,
        COUNT(*) as count
      FROM leads
      WHERE source = 'whatsapp_bot' AND ${dateFilter}
      GROUP BY raw_data->>'stage', status
    `);
    
    funnelData.rows.forEach(row => {
      if (row.stage === 'greeting') conversionFunnel.greeting += parseInt(row.count);
      if (row.stage === 'info_gathering') conversionFunnel.info_gathering += parseInt(row.count);
      if (row.stage === 'scheduling') conversionFunnel.scheduling += parseInt(row.count);
      if (row.status === 'qualified') conversionFunnel.qualified += parseInt(row.count);
      if (row.status === 'converted') conversionFunnel.converted += parseInt(row.count);
    });
    
    // Calculate conversion rates
    const totalLeads = parseInt(overallStats.rows[0].total_leads);
    const conversionRate = totalLeads > 0 
      ? ((parseInt(overallStats.rows[0].converted_leads) / totalLeads) * 100).toFixed(2)
      : 0;
    const qualificationRate = totalLeads > 0
      ? ((parseInt(overallStats.rows[0].qualified_leads) / totalLeads) * 100).toFixed(2)
      : 0;
    
    // Hourly activity
    const hourlyActivity = await pool.query(`
      SELECT 
        EXTRACT(HOUR FROM created_at) as hour,
        COUNT(*) as messages
      FROM whatsapp_conversations wc
      INNER JOIN leads l ON wc.lead_id = l.id
      WHERE l.source = 'whatsapp_bot' AND ${dateFilter.replace('created_at', 'wc.created_at')}
      GROUP BY EXTRACT(HOUR FROM created_at)
      ORDER BY hour
    `);
    
    res.json({
      success: true,
      period,
      generated_at: new Date().toISOString(),
      overview: {
        total_leads: parseInt(overallStats.rows[0].total_leads),
        new_leads: parseInt(overallStats.rows[0].new_leads),
        active_leads: parseInt(overallStats.rows[0].active_leads),
        qualified_leads: parseInt(overallStats.rows[0].qualified_leads),
        converted_leads: parseInt(overallStats.rows[0].converted_leads),
        closed_leads: parseInt(overallStats.rows[0].closed_leads),
        handoff_requested: parseInt(overallStats.rows[0].handoff_requested),
        buyers: parseInt(overallStats.rows[0].buyers),
        sellers: parseInt(overallStats.rows[0].sellers),
        conversion_rate: `${conversionRate}%`,
        qualification_rate: `${qualificationRate}%`
      },
      messages: {
        total: parseInt(conversationStats.rows[0].total_messages),
        from_users: parseInt(conversationStats.rows[0].user_messages),
        from_bot: parseInt(conversationStats.rows[0].bot_messages),
        avg_user_length: conversationStats.rows[0].avg_user_message_length,
        avg_bot_length: conversationStats.rows[0].avg_bot_message_length,
        avg_per_lead: parseFloat(avgMessagesPerLead.rows[0]?.avg_messages_per_lead || 0),
        max_per_lead: parseInt(avgMessagesPerLead.rows[0]?.max_messages || 0),
        min_per_lead: parseInt(avgMessagesPerLead.rows[0]?.min_messages || 0)
      },
      performance: {
        avg_response_time_seconds: parseFloat(responseTime.rows[0]?.avg_response_seconds || 0),
        min_response_time_seconds: parseFloat(responseTime.rows[0]?.min_response_seconds || 0),
        max_response_time_seconds: parseFloat(responseTime.rows[0]?.max_response_seconds || 0)
      },
      stages: stageDistribution.rows,
      conversion_funnel: conversionFunnel,
      hourly_activity: hourlyActivity.rows
    });
    
  } catch (error) {
    console.error('Analytics error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// HANDOFF TO HUMAN - Request handoff
// ============================================
router.post('/whatsapp/handoff/request', async (req, res) => {
  try {
    const { leadId, reason, urgency = 'normal', notes } = req.body;
    
    if (!leadId) {
      return res.status(400).json({ error: 'leadId required' });
    }
    
    // Get lead info
    const leadResult = await pool.query(`SELECT * FROM leads WHERE id = $1`, [leadId]);
    
    if (leadResult.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    
    const lead = leadResult.rows[0];
    
    // Update lead with handoff request
    await pool.query(`
      UPDATE leads 
      SET 
        status = 'pending_handoff',
        raw_data = jsonb_set(
          jsonb_set(
            jsonb_set(
              COALESCE(raw_data, '{}'::jsonb),
              '{handoff_requested}', 'true'
            ),
            '{handoff_reason}', $1
          ),
          '{handoff_urgency}', $2
        ),
        notes = COALESCE(notes, '') || $3,
        updated_at = NOW()
      WHERE id = $4
    `, [
      JSON.stringify(reason || 'bot_escalation'),
      JSON.stringify(urgency),
      `\n[HANDOFF ${new Date().toISOString()}]: ${notes || reason || 'Escalated to human'}`,
      leadId
    ]);
    
    // Send notification to team (via email/Trello/etc)
    // TODO: Integrate with notification system
    
    // Send WhatsApp message to lead
    const handoffMessage = `${lead.name ? lead.name + ', ' : ''}תודה על הסבלנות!\n\nאני מעביר אותך לאחד המומחים שלנו שיחזור אליך בהקדם.\n\nזמן המתנה משוער: ${urgency === 'high' ? '30 דקות' : urgency === 'urgent' ? '15 דקות' : 'שעה-שעתיים'}.`;
    
    try {
      const auth = getBasicAuth();
      await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/SendWhatsAppChat`, {
        Data: { 
          Message: handoffMessage, 
          Phone: lead.phone,
          Settings: {
            CustomerMessageId: `handoff_${Date.now()}`,
            CustomerParameter: 'QUANTUM_HANDOFF'
          }
        }
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${auth}`
        },
        timeout: 15000
      });
      
      // Save handoff message
      await pool.query(`
        INSERT INTO whatsapp_conversations (lead_id, sender, message, ai_metadata, created_at)
        VALUES ($1, 'bot', $2, $3, NOW())
      `, [leadId, handoffMessage, JSON.stringify({ type: 'handoff', urgency })]);
      
    } catch (error) {
      console.error('Failed to send handoff message:', error.message);
    }
    
    res.json({
      success: true,
      leadId,
      status: 'pending_handoff',
      message: 'Handoff requested successfully'
    });
    
  } catch (error) {
    console.error('Handoff request error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// HANDOFF TO HUMAN - Complete handoff
// ============================================
router.post('/whatsapp/handoff/complete', async (req, res) => {
  try {
    const { leadId, handledBy, outcome, notes } = req.body;
    
    if (!leadId) {
      return res.status(400).json({ error: 'leadId required' });
    }
    
    await pool.query(`
      UPDATE leads 
      SET 
        status = $1,
        raw_data = jsonb_set(
          jsonb_set(
            COALESCE(raw_data, '{}'::jsonb),
            '{handoff_completed}', 'true'
          ),
          '{handoff_handled_by}', $2
        ),
        notes = COALESCE(notes, '') || $3,
        updated_at = NOW()
      WHERE id = $4
    `, [
      outcome === 'qualified' ? 'qualified' : outcome === 'converted' ? 'converted' : 'active',
      JSON.stringify(handledBy || 'team'),
      `\n[HANDOFF COMPLETE ${new Date().toISOString()}]: ${notes || 'Handled by human'}`,
      leadId
    ]);
    
    res.json({
      success: true,
      leadId,
      message: 'Handoff completed'
    });
    
  } catch (error) {
    console.error('Handoff complete error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// HANDOFF QUEUE - Get pending handoffs
// ============================================
router.get('/whatsapp/handoff/queue', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        l.id,
        l.phone,
        l.name,
        l.user_type,
        l.status,
        l.raw_data->>'stage' as stage,
        l.raw_data->>'handoff_reason' as reason,
        l.raw_data->>'handoff_urgency' as urgency,
        l.created_at,
        l.updated_at,
        COUNT(wc.id) as message_count,
        MAX(wc.created_at) as last_message_at
      FROM leads l
      LEFT JOIN whatsapp_conversations wc ON l.id = wc.lead_id
      WHERE l.status = 'pending_handoff'
        AND l.source = 'whatsapp_bot'
      GROUP BY l.id
      ORDER BY 
        CASE l.raw_data->>'handoff_urgency'
          WHEN '"urgent"' THEN 1
          WHEN '"high"' THEN 2
          ELSE 3
        END,
        l.updated_at DESC
    `);
    
    res.json({
      success: true,
      queue: result.rows,
      count: result.rows.length
    });
    
  } catch (error) {
    console.error('Handoff queue error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PERFORMANCE REPORT - Executive summary
// ============================================
router.get('/whatsapp/report', async (req, res) => {
  try {
    const { format = 'json' } = req.query;
    
    // Get analytics for last 7 days
    const analytics = await axios.get('http://localhost:3000/api/whatsapp/analytics?period=7d');
    const data = analytics.data;
    
    if (format === 'html') {
      // Generate HTML report
      const html = `
<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
  <meta charset="UTF-8">
  <title>QUANTUM WhatsApp Bot - דוח ביצועים</title>
  <style>
    body { font-family: -apple-system, system-ui; max-width: 1200px; margin: 40px auto; padding: 20px; }
    h1 { color: #2563eb; }
    .metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin: 20px 0; }
    .metric-card { background: #f3f4f6; padding: 20px; border-radius: 8px; border-right: 4px solid #2563eb; }
    .metric-value { font-size: 32px; font-weight: bold; color: #1e40af; }
    .metric-label { color: #6b7280; margin-top: 5px; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th, td { border: 1px solid #e5e7eb; padding: 12px; text-align: right; }
    th { background: #f3f4f6; }
  </style>
</head>
<body>
  <h1>🤖 QUANTUM WhatsApp Bot - דוח ביצועים</h1>
  <p><strong>תקופה:</strong> 7 ימים אחרונים | <strong>נוצר:</strong> ${new Date().toLocaleString('he-IL')}</p>
  
  <h2>📊 סקירה כללית</h2>
  <div class="metric-grid">
    <div class="metric-card">
      <div class="metric-value">${data.overview.total_leads}</div>
      <div class="metric-label">לידים סה"כ</div>
    </div>
    <div class="metric-card">
      <div class="metric-value">${data.overview.conversion_rate}</div>
      <div class="metric-label">שיעור המרה</div>
    </div>
    <div class="metric-card">
      <div class="metric-value">${data.messages.avg_per_lead.toFixed(1)}</div>
      <div class="metric-label">הודעות ממוצע לליד</div>
    </div>
    <div class="metric-card">
      <div class="metric-value">${data.performance.avg_response_time_seconds.toFixed(1)}s</div>
      <div class="metric-label">זמן תגובה ממוצע</div>
    </div>
  </div>
  
  <h2>📈 משפך המרה</h2>
  <table>
    <tr><th>שלב</th><th>כמות</th></tr>
    <tr><td>פתיחה</td><td>${data.conversion_funnel.greeting}</td></tr>
    <tr><td>איסוף מידע</td><td>${data.conversion_funnel.info_gathering}</td></tr>
    <tr><td>תיאום פגישה</td><td>${data.conversion_funnel.scheduling}</td></tr>
    <tr><td>מוסמך</td><td>${data.conversion_funnel.qualified}</td></tr>
    <tr><td>הומר</td><td>${data.conversion_funnel.converted}</td></tr>
  </table>
  
  <p style="color: #6b7280; margin-top: 40px;">QUANTUM - Powered by AI</p>
</body>
</html>
      `;
      
      res.type('text/html').send(html);
    } else {
      res.json(data);
    }
    
  } catch (error) {
    console.error('Report error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
