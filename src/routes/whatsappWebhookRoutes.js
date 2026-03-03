/**
 * QUANTUM WhatsApp Bot - v6.0
 * Full conversation tracking + enhanced AI + lead management
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

const INFORU_CAPI_BASE = 'https://capi.inforu.co.il/api/v2';
const DEPLOYMENT_TIME = new Date().toISOString();

function getBasicAuth() {
  const username = process.env.INFORU_USERNAME;
  const password = process.env.INFORU_PASSWORD;
  if (!username || !password) throw new Error('INFORU credentials not configured');
  return Buffer.from(`${username}:${password}`).toString('base64');
}

function getWebhookUrl() {
  const domain = process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN || 'pinuy-binuy-analyzer-production-ab85.up.railway.app';
  return `https://${domain}/api/whatsapp/webhook`;
}

function parseInforuWebhook(body) {
  if (body.Data && Array.isArray(body.Data) && body.Data.length > 0) {
    const item = body.Data[0];
    return {
      phone: item.Value || item.Phone || null,
      message: item.Message || item.Keyword || item.Text || null,
      network: item.Network || 'Unknown',
      channel: item.Channel || 'Unknown',
      shortCode: item.ShortCode || null,
      sessionId: item.MoSessionId || null,
      customerParam: item.CustomerParam || null,
      additionalInfo: item.AdditionalInfo ? (typeof item.AdditionalInfo === 'string' ? JSON.parse(item.AdditionalInfo) : item.AdditionalInfo) : null,
      customerId: body.CustomerId || null,
      projectId: body.ProjectId || null,
      raw: body
    };
  }
  
  return {
    phone: body.phone || body.from || body.Phone || null,
    message: body.message || body.text || body.body || body.Message || null,
    network: 'Direct',
    channel: 'Direct',
    raw: body
  };
}

// Enhanced AI call with conversation context
async function callClaudeWithContext(conversationHistory, currentMessage, leadInfo) {
  try {
    const axios = require('axios');
    
    // Build context from history
    let contextSummary = '';
    if (conversationHistory.length > 0) {
      const lastFew = conversationHistory.slice(-4); // Last 4 messages
      contextSummary = lastFew.map(msg => 
        `${msg.sender === 'user' ? 'לקוח' : 'אתה'}: ${msg.message}`
      ).join('\n');
    }
    
    const systemPrompt = buildEnhancedPrompt(leadInfo, contextSummary);
    
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: 'user', content: currentMessage }]
    }, {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      timeout: 10000
    });
    
    return response.data.content[0].text;
  } catch (error) {
    console.error('Claude API error:', error.message);
    return 'שלום! אני מ-QUANTUM. איך אני יכול לעזור לך?';
  }
}

function buildEnhancedPrompt(leadInfo, conversationContext) {
  const stage = leadInfo?.stage || 'greeting';
  const name = leadInfo?.name || null;
  const userType = leadInfo?.user_type || null;
  
  let basePrompt = `אתה QUANTUM Sales AI - הבוט החכם ביותר בתחום הנדל"ן בישראל.

## זהות QUANTUM
- מתווכים בוטיק עם מומחיות בפינוי-בינוי
- "מח חד, הבנה עמוקה, גישה לנכסים סודיים"
- כל לקוח מרגיש כמו "בן יחיד"
- לא פלטפורמה טכנולוגית - אנשים אמיתיים עם יתרון טכנולוגי

## הסגנון שלך
- חד אבל חם - חכם אבל לא יהיר
- ישיר אבל אכפתי
- קצר - לא יותר מ-2-3 משפטים
- אמוג'י במינון - רק 👋 בפתיחה או ✨ לנקודות חשובות
- עברית טבעית - לא פורמלית מדי

## המטרה שלך (לפי שלבים)`;

  // Stage-specific instructions
  if (stage === 'greeting') {
    basePrompt += `

### שלב: פתיחה
1. שאל את השם (אם אין)
2. זהה מהר: קונה או מוכר?
3. המשך ישר לשאלות הנכונות`;
  } else if (stage === 'info_gathering') {
    basePrompt += `

### שלב: איסוף מידע
${userType === 'buyer' ? `
**קונה:**
- איזה אזור מעניין?
- באיזה תקציב?
- יש מתווך כבר?
- למה לא מצא עדיין? (חשוב!)
` : userType === 'seller' ? `
**מוכר:**
- איפה הנכס ומה הסוג?
- למה רוצה למכור? (דחיפות!)
- יש מתווך כבר?
- מה לא עובד עם המתווך הנוכחי?
` : `
- קודם כל: קונה או מוכר?
`}`;
  } else if (stage === 'scheduling') {
    basePrompt += `

### שלב: קביעת פגישה
- "בוא נקבע שיחת היכרות קצרה עם [שם מומחה]"
- שאל מתי נוח - היום? מחר?
- אל תהיה לחוץ - תן ללקוח להחליט`;
  }

  // Add conversation context if exists
  if (conversationContext) {
    basePrompt += `

## השיחה עד כה:
${conversationContext}

המשך את השיחה באופן טבעי בהתאם למה שכבר נאמר.`;
  }

  // Add name if we have it
  if (name) {
    basePrompt += `\n\nשם הלקוח: ${name} - השתמש בשם מדי פעם.`;
  }

  basePrompt += `

## חוקי זהב
❌ לעולם אל תשאל את אותה שאלה פעמיים
❌ אל תהיה דוחף - תן ללקוח לנשום
❌ אל תדבר יותר מדי - שאל, הקשב, המשך
✓ היה אנושי - לא סקריפט
✓ התאם את עצמך ללקוח - יש כאלה שרוצים עסקי, יש שרוצים יותר חברותי
✓ אם הלקוח לא מעוניין - בסדר! "אם תשנה דעתך, אני כאן"

תן תשובה אחת קצרה, ממוקדת, טבעית.`;

  return basePrompt;
}

// Database: Get or create lead
async function getOrCreateLead(phone) {
  try {
    // Try to find existing lead
    let result = await pool.query(
      `SELECT * FROM leads WHERE phone = $1 AND source = 'whatsapp_bot' ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    
    if (result.rows.length > 0) {
      return result.rows[0];
    }
    
    // Create new lead
    result = await pool.query(
      `INSERT INTO leads (phone, source, status, raw_data, created_at, updated_at)
       VALUES ($1, 'whatsapp_bot', 'new', '{}', NOW(), NOW())
       RETURNING *`,
      [phone]
    );
    
    return result.rows[0];
  } catch (error) {
    console.error('DB error (getOrCreateLead):', error.message);
    return null;
  }
}

// Database: Get conversation history
async function getConversationHistory(leadId) {
  try {
    const result = await pool.query(
      `SELECT sender, message, created_at 
       FROM whatsapp_conversations 
       WHERE lead_id = $1 
       ORDER BY created_at ASC`,
      [leadId]
    );
    return result.rows;
  } catch (error) {
    console.error('DB error (getConversationHistory):', error.message);
    return [];
  }
}

// Database: Save message
async function saveMessage(leadId, sender, message, aiMetadata = null) {
  try {
    await pool.query(
      `INSERT INTO whatsapp_conversations (lead_id, sender, message, ai_metadata, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [leadId, sender, message, aiMetadata ? JSON.stringify(aiMetadata) : null]
    );
  } catch (error) {
    console.error('DB error (saveMessage):', error.message);
  }
}

// Database: Update lead info
async function updateLead(leadId, updates) {
  try {
    const fields = [];
    const values = [];
    let idx = 1;
    
    if (updates.name) { fields.push(`name = $${idx++}`); values.push(updates.name); }
    if (updates.user_type) { fields.push(`user_type = $${idx++}`); values.push(updates.user_type); }
    if (updates.stage) { fields.push(`raw_data = jsonb_set(COALESCE(raw_data, '{}'::jsonb), '{stage}', $${idx++})`); values.push(JSON.stringify(updates.stage)); }
    if (updates.status) { fields.push(`status = $${idx++}`); values.push(updates.status); }
    
    fields.push(`updated_at = NOW()`);
    fields.push(`raw_data = jsonb_set(COALESCE(raw_data, '{}'::jsonb), '{last_contact}', $${idx++})`);
    values.push(JSON.stringify(new Date().toISOString()));
    
    values.push(leadId);
    
    await pool.query(
      `UPDATE leads SET ${fields.join(', ')} WHERE id = $${idx}`,
      values
    );
  } catch (error) {
    console.error('DB error (updateLead):', error.message);
  }
}

// Extract insights from conversation
function extractInsights(message, history) {
  const insights = {};
  
  // Name detection
  const nameMatch = message.match(/שמי ([\u0590-\u05FF]+)|קוראים לי ([\u0590-\u05FF]+)|אני ([\u0590-\u05FF]+)/);
  if (nameMatch) {
    insights.name = nameMatch[1] || nameMatch[2] || nameMatch[3];
  }
  
  // User type detection
  if (message.match(/רוצה לקנות|מחפש דירה|קונה|מעוניין לקנות/)) {
    insights.user_type = 'buyer';
  } else if (message.match(/רוצה למכור|יש לי דירה|מוכר|למכירה/)) {
    insights.user_type = 'seller';
  }
  
  // Stage detection
  if (history.length === 0) {
    insights.stage = 'greeting';
  } else if (history.length < 4) {
    insights.stage = 'info_gathering';
  } else if (message.match(/פגישה|שיחה|נדבר|מתי נוח/)) {
    insights.stage = 'scheduling';
  } else {
    insights.stage = 'info_gathering';
  }
  
  return insights;
}

// ============================================
// WEBHOOK VERIFICATION (GET)
// ============================================
router.get('/whatsapp/webhook', (req, res) => {
  console.log('Webhook verification GET request:', req.query);
  res.status(200).json({
    success: true,
    message: 'QUANTUM WhatsApp Webhook - Active',
    version: '6.0',
    features: ['conversation_tracking', 'context_awareness', 'lead_management'],
    webhookUrl: getWebhookUrl(),
    whatsappNumber: '037572229',
    timestamp: new Date().toISOString()
  });
});

// ============================================
// INFORU WEBHOOK RECEIVER (POST)
// ============================================
router.post('/whatsapp/webhook', async (req, res) => {
  try {
    console.log('=== WEBHOOK RECEIVED ===');
    console.log('Body:', JSON.stringify(req.body, null, 2));
    
    const parsed = parseInforuWebhook(req.body);
    
    if (!parsed.phone || !parsed.message) {
      console.log('Webhook: incomplete data');
      return res.status(200).json({ 
        received: true, 
        processed: false, 
        reason: 'Missing phone or message'
      });
    }
    
    console.log('✓ Valid message:', { phone: parsed.phone, message: parsed.message.substring(0, 50) });
    
    // Skip non-WhatsApp
    if (parsed.network !== 'WhatsApp' && parsed.network !== 'Direct') {
      console.log('Non-WhatsApp message, skipping');
      return res.json({ received: true, processed: false, reason: `Network: ${parsed.network}` });
    }
    
    // Get or create lead
    const lead = await getOrCreateLead(parsed.phone);
    if (!lead) {
      throw new Error('Failed to get/create lead');
    }
    
    console.log(`Lead ID: ${lead.id}, Status: ${lead.status}`);
    
    // Get conversation history
    const history = await getConversationHistory(lead.id);
    console.log(`Conversation history: ${history.length} messages`);
    
    // Save incoming message
    await saveMessage(lead.id, 'user', parsed.message);
    
    // Extract insights
    const insights = extractInsights(parsed.message, history);
    console.log('Insights:', insights);
    
    // Get lead info with insights
    const leadInfo = {
      id: lead.id,
      name: insights.name || lead.name,
      user_type: insights.user_type || lead.user_type,
      stage: insights.stage,
      status: lead.status
    };
    
    // Generate AI response with context
    console.log('→ Calling Claude AI with context...');
    const aiResponse = await callClaudeWithContext(history, parsed.message, leadInfo);
    console.log('✓ AI Response:', aiResponse.substring(0, 100));
    
    // Save bot response
    await saveMessage(lead.id, 'bot', aiResponse, { 
      model: 'claude-sonnet-4-20250514',
      stage: insights.stage 
    });
    
    // Update lead with insights
    await updateLead(lead.id, insights);
    
    // Send WhatsApp reply
    console.log('→ Sending WhatsApp reply...');
    const axios = require('axios');
    const auth = getBasicAuth();
    
    const result = await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/SendWhatsAppChat`, {
      Data: { 
        Message: aiResponse, 
        Phone: parsed.phone,
        Settings: {
          CustomerMessageId: `bot_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
          CustomerParameter: 'QUANTUM_BOT_V6'
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
    
    const success = result.data.StatusId === 1;
    console.log(success ? '✓ Reply sent' : '✗ Reply failed');
    
    res.json({ 
      success,
      processed: true,
      leadId: lead.id,
      insights: insights,
      conversationLength: history.length + 2, // +2 for current exchange
      aiResponse: aiResponse,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('✗ Webhook error:', error.message);
    console.error('Stack:', error.stack);
    res.status(500).json({ 
      error: 'Processing failed', 
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ============================================
// CONVERSATION DASHBOARD
// ============================================
router.get('/whatsapp/conversations', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        l.id,
        l.phone,
        l.name,
        l.user_type,
        l.status,
        l.raw_data->>'stage' as stage,
        l.raw_data->>'last_contact' as last_contact,
        l.created_at,
        COUNT(wc.id) as message_count,
        MAX(wc.created_at) as last_message_at
      FROM leads l
      LEFT JOIN whatsapp_conversations wc ON l.id = wc.lead_id
      WHERE l.source = 'whatsapp_bot'
      GROUP BY l.id
      ORDER BY MAX(wc.created_at) DESC NULLS LAST
      LIMIT 50
    `);
    
    res.json({
      success: true,
      conversations: result.rows,
      total: result.rows.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get specific conversation
router.get('/whatsapp/conversations/:leadId', async (req, res) => {
  try {
    const { leadId } = req.params;
    
    const leadResult = await pool.query(`SELECT * FROM leads WHERE id = $1`, [leadId]);
    const messagesResult = await pool.query(`
      SELECT sender, message, ai_metadata, created_at 
      FROM whatsapp_conversations 
      WHERE lead_id = $1 
      ORDER BY created_at ASC
    `, [leadId]);
    
    if (leadResult.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    
    res.json({
      success: true,
      lead: leadResult.rows[0],
      messages: messagesResult.rows
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Setup guide (unchanged)
router.get('/whatsapp/setup-guide', (req, res) => {
  const webhookUrl = getWebhookUrl();
  res.type('text/html').send(`
<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
  <meta charset="UTF-8">
  <title>QUANTUM WhatsApp - מדריך</title>
  <style>
    body { font-family: system-ui; max-width: 900px; margin: 40px auto; padding: 20px; }
    h1 { color: #2563eb; }
    .success { background: #ecfdf5; border-right: 4px solid #10b981; padding: 15px; margin: 15px 0; }
    code { background: #1e293b; color: #10b981; padding: 2px 6px; border-radius: 3px; }
  </style>
</head>
<body>
  <h1>🚀 QUANTUM WhatsApp Bot v6.0</h1>
  <div class="success">
    <strong>✓ ה-Webhook מוכן ופעיל!</strong><br>
    גרסה 6.0 כוללת מעקב שיחות, זיכרון, וניהול לידים אוטומטי.
  </div>
  <p><strong>Webhook URL:</strong> <code>${webhookUrl}</code></p>
  <p><strong>תכונות חדשות:</strong></p>
  <ul>
    <li>✓ שמירת כל שיחה ב-DB</li>
    <li>✓ זיכרון והקשר בין הודעות</li>
    <li>✓ ניהול לידים אוטומטי</li>
    <li>✓ מעקב stage בשיחה</li>
    <li>✓ Dashboard לצפייה בשיחות</li>
  </ul>
  <p><strong>Dashboard:</strong> <a href="/api/whatsapp/conversations">/api/whatsapp/conversations</a></p>
</body>
</html>
  `);
});

// Manual trigger
router.post('/whatsapp/trigger', async (req, res) => {
  try {
    const { phone, message } = req.body;
    
    if (!phone || !message) {
      return res.status(400).json({ error: 'Phone and message required' });
    }
    
    const lead = await getOrCreateLead(phone);
    const history = await getConversationHistory(lead.id);
    
    await saveMessage(lead.id, 'user', message);
    
    const insights = extractInsights(message, history);
    const leadInfo = {
      id: lead.id,
      name: insights.name || lead.name,
      user_type: insights.user_type || lead.user_type,
      stage: insights.stage
    };
    
    const aiResponse = await callClaudeWithContext(history, message, leadInfo);
    
    await saveMessage(lead.id, 'bot', aiResponse);
    await updateLead(lead.id, insights);
    
    const axios = require('axios');
    const auth = getBasicAuth();
    
    const result = await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/SendWhatsAppChat`, {
      Data: { 
        Message: aiResponse, 
        Phone: phone,
        Settings: {
          CustomerMessageId: `trigger_${Date.now()}`,
          CustomerParameter: 'QUANTUM_TRIGGER'
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
    
    res.json({ 
      success: result.data.StatusId === 1, 
      aiResponse,
      leadId: lead.id,
      insights,
      conversationLength: history.length + 2
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stats
router.get('/whatsapp/stats', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(DISTINCT l.id) as total_leads,
        COUNT(DISTINCT CASE WHEN l.status = 'new' THEN l.id END) as new_leads,
        COUNT(DISTINCT CASE WHEN l.status = 'active' THEN l.id END) as active_leads,
        COUNT(wc.id) as total_messages,
        COUNT(CASE WHEN wc.sender = 'user' THEN 1 END) as user_messages,
        COUNT(CASE WHEN wc.sender = 'bot' THEN 1 END) as bot_messages
      FROM leads l
      LEFT JOIN whatsapp_conversations wc ON l.id = wc.lead_id
      WHERE l.source = 'whatsapp_bot'
    `);
    
    res.json({
      success: true,
      version: '6.0',
      timestamp: new Date().toISOString(),
      webhookUrl: getWebhookUrl(),
      stats: stats.rows[0],
      features: [
        'Conversation tracking',
        'Context-aware AI',
        'Lead management', 
        'Stage progression',
        'Conversation dashboard'
      ]
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
