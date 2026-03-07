/**
 * QUANTUM WhatsApp Bot - v6.1
 * Full conversation tracking + enhanced AI + lead management + auto-handoff
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const axios = require('axios');

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

// Check if handoff is needed
function shouldHandoff(message, history, leadInfo) {
  const messageCount = history.length;
  
  // 1. Explicit request for human
  if (message.match(/רוצה לדבר עם אדם|תעביר אותי לאדם|אני רוצה אדם|לדבר עם מישהו|אנשי|מוקד|מתווך אמיתי/i)) {
    return { should: true, reason: 'explicit_request', urgency: 'high' };
  }
  
  // 2. Frustration indicators
  if (message.match(/לא מבין|לא עוזר|לא עונה|מה קורה|די|מספיק|תפסיק/i)) {
    return { should: true, reason: 'frustration', urgency: 'high' };
  }
  
  // 3. Complex pricing/legal questions
  if (message.match(/עורך דין|משפטי|חוזה|מיסים|היטל השבחה|מע"מ|רישוי/i)) {
    return { should: true, reason: 'complex_legal', urgency: 'normal' };
  }
  
  // 4. Too many messages without progress (stuck in loop)
  if (messageCount >= 8) {
    const userMessages = history.filter(m => m.sender === 'user').map(m => m.message);
    const lastThree = userMessages.slice(-3);
    
    // Check if user keeps asking similar things
    const similarityCount = lastThree.filter((msg, idx) => 
      lastThree.some((other, otherIdx) => 
        idx !== otherIdx && 
        msg.length > 10 && 
        other.length > 10 &&
        (msg.includes(other.substring(0, 20)) || other.includes(msg.substring(0, 20)))
      )
    ).length;
    
    if (similarityCount >= 2) {
      return { should: true, reason: 'stuck_in_loop', urgency: 'normal' };
    }
  }
  
  // 5. Very long conversation (10+ messages) - might need human touch
  if (messageCount >= 10 && leadInfo.stage !== 'scheduling') {
    return { should: true, reason: 'long_conversation', urgency: 'normal' };
  }
  
  return { should: false };
}

// Request handoff
async function requestHandoff(leadId, reason, urgency, phone, name) {
  try {
    // Update lead status
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
        updated_at = NOW()
      WHERE id = $3
    `, [JSON.stringify(reason), JSON.stringify(urgency), leadId]);
    
    // Send handoff message
    const handoffMessage = `${name ? name + ', ' : ''}אני מעביר אותך למומחה שלנו שיוכל לעזור לך יותר טוב.\n\nהוא יחזור אליך תוך ${urgency === 'high' ? '30 דקות' : 'שעה-שעתיים'}. תודה על הסבלנות! 🙏`;
    
    const auth = getBasicAuth();
    await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/SendWhatsAppChat`, {
      Data: { 
        Message: handoffMessage, 
        Phone: phone,
        Settings: {
          CustomerMessageId: `handoff_${Date.now()}`,
          CustomerParameter: 'QUANTUM_AUTO_HANDOFF'
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
    
    // Save handoff message
    await pool.query(`
      INSERT INTO whatsapp_conversations (lead_id, sender, message, ai_metadata, created_at)
      VALUES ($1, 'bot', $2, $3, NOW())
    `, [leadId, handoffMessage, JSON.stringify({ type: 'auto_handoff', reason, urgency })]);
    
    console.log(`[HANDOFF] Auto-handoff triggered for lead ${leadId}: ${reason} (${urgency})`);
    
    return true;
  } catch (error) {
    console.error('[HANDOFF] Error:', error.message);
    return false;
  }
}

// Enhanced AI call with conversation context
async function callClaudeWithContext(conversationHistory, currentMessage, leadInfo) {
  try {
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
  
  let basePrompt = `אתה QUANTUM Sales AI - הבוט החכם ביותר בתחום הנדל"ן בישראל.\n\n## זהות QUANTUM\n- מתווכים בוטיק עם מומחיות בפינוי-בינוי\n- "מח חד, הבנה עמוקה, גישה לנכסים סודיים"\n- כל לקוח מרגיש כמו "בן יחיד"\n- לא פלטפורמה טכנולוגית - אנשים אמיתיים עם יתרון טכנולוגי\n\n## הסגנון שלך\n- חד אבל חם - חכם אבל לא יהיר\n- ישיר אבל אכפתי\n- קצר - לא יותר מ-2-3 משפטים\n- אמוג'י במינון - רק 👋 בפתיחה או ✨ לנקודות חשובות\n- עברית טבעית - לא פורמלית מדי\n\n## המטרה שלך (לפי שלבים)`;

  // Stage-specific instructions
  if (stage === 'greeting') {
    basePrompt += `\n\n### שלב: פתיחה\n1. שאל את השם (אם אין)\n2. זהה מהר: קונה או מוכר?\n3. המשך ישר לשאלות הנכונות`;
  } else if (stage === 'info_gathering') {
    basePrompt += `\n\n### שלב: איסוף מידע\n${userType === 'buyer' ? `\n**קונה:**\n- איזה אזור מעניין?\n- באיזה תקציב?\n- יש מתווך כבר?\n- למה לא מצא עדיין? (חשוב!)\n` : userType === 'seller' ? `\n**מוכר:**\n- איפה הנכס ומה הסוג?\n- למה רוצה למכור? (דחיפות!)\n- יש מתווך כבר?\n- מה לא עובד עם המתווך הנוכחי?\n` : `\n- קודם כל: קונה או מוכר?\n`}`;
  } else if (stage === 'scheduling') {
    basePrompt += `\n\n### שלב: קביעת פגישה\n- "בוא נקבע שיחת היכרות קצרה עם [שם מומחה]"\n- שאל מתי נוח - היום? מחר?\n- אל תהיה לחוץ - תן ללקוח להחליט`;
  }

  // Add conversation context if exists
  if (conversationContext) {
    basePrompt += `\n\n## השיחה עד כה:\n${conversationContext}\n\nהמשך את השיחה באופן טבעי בהתאם למה שכבר נאמר.`;
  }

  // Add name if we have it
  if (name) {
    basePrompt += `\n\nשם הלקוח: ${name} - השתמש בשם מדי פעם.`;
  }

  basePrompt += `\n\n## חוקי זהב\n❌ לעולם אל תשאל את אותה שאלה פעמיים\n❌ אל תהיה דוחף - תן ללקוח לנשום\n❌ אל תדבר יותר מדי - שאל, הקשב, המשך\n✓ היה אנושי - לא סקריפט\n✓ התאם את עצמך ללקוח - יש כאלה שרוצים עסקי, יש שרוצים יותר חברותי\n✓ אם הלקוח לא מעוניין - בסדר! "אם תשנה דעתך, אני כאן"\n\nתן תשובה אחת קצרה, ממוקדת, טבעית.`;

  return basePrompt;
}

// Database functions
async function getOrCreateLead(phone) {
  try {
    let result = await pool.query(
      `SELECT * FROM leads WHERE phone = $1 AND source = 'whatsapp_bot' ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    
    if (result.rows.length > 0) {
      return result.rows[0];
    }
    
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

function extractInsights(message, history) {
  const insights = {};
  
  const nameMatch = message.match(/שמי ([\u0590-\u05FF]+)|קוראים לי ([\u0590-\u05FF]+)|אני ([\u0590-\u05FF]+)/);
  if (nameMatch) {
    insights.name = nameMatch[1] || nameMatch[2] || nameMatch[3];
  }
  
  if (message.match(/רוצה לקנות|מחפש דירה|קונה|מעוניין לקנות/)) {
    insights.user_type = 'buyer';
  } else if (message.match(/רוצה למכור|יש לי דירה|מוכר|למכירה/)) {
    insights.user_type = 'seller';
  }
  
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
  res.status(200).json({
    success: true,
    message: 'QUANTUM WhatsApp Webhook - Active',
    version: '6.1',
    features: ['conversation_tracking', 'context_awareness', 'lead_management', 'auto_handoff'],
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
    
    const parsed = parseInforuWebhook(req.body);
    
    if (!parsed.phone || !parsed.message) {
      return res.status(200).json({ received: true, processed: false, reason: 'Missing phone or message' });
    }
    
    if (parsed.network !== 'WhatsApp' && parsed.network !== 'Direct') {
      return res.json({ received: true, processed: false, reason: `Network: ${parsed.network}` });
    }
    
    const lead = await getOrCreateLead(parsed.phone);
    if (!lead) throw new Error('Failed to get/create lead');
    
    const history = await getConversationHistory(lead.id);
    await saveMessage(lead.id, 'user', parsed.message);
    
    const insights = extractInsights(parsed.message, history);
    const leadInfo = {
      id: lead.id,
      name: insights.name || lead.name,
      user_type: insights.user_type || lead.user_type,
      stage: insights.stage,
      status: lead.status
    };
    
    // Check if handoff needed
    const handoffCheck = shouldHandoff(parsed.message, history, leadInfo);
    if (handoffCheck.should) {
      console.log(`[AUTO-HANDOFF] Triggered: ${handoffCheck.reason}`);
      await requestHandoff(lead.id, handoffCheck.reason, handoffCheck.urgency, parsed.phone, leadInfo.name);
      
      return res.json({
        success: true,
        processed: true,
        handoff: true,
        reason: handoffCheck.reason,
        urgency: handoffCheck.urgency,
        leadId: lead.id
      });
    }
    
    // Normal flow - generate AI response
    const aiResponse = await callClaudeWithContext(history, parsed.message, leadInfo);
    await saveMessage(lead.id, 'bot', aiResponse, { model: 'claude-sonnet-4-20250514', stage: insights.stage });
    await updateLead(lead.id, insights);
    
    // Send WhatsApp reply
    const auth = getBasicAuth();
    const result = await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/SendWhatsAppChat`, {
      Data: { 
        Message: aiResponse, 
        Phone: parsed.phone,
        Settings: {
          CustomerMessageId: `bot_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
          CustomerParameter: 'QUANTUM_BOT_V6_1'
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
      processed: true,
      leadId: lead.id,
      insights,
      conversationLength: history.length + 2,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('✗ Webhook error:', error.message);
    res.status(500).json({ error: 'Processing failed', details: error.message });
  }
});

// Conversations dashboard - returns both 'conversations' and 'data' for compatibility
router.get('/whatsapp/conversations', async (req, res) => {
  try {
    const { search, status } = req.query;
    let query = `
      SELECT 
        l.id, l.phone, l.name, l.user_type, l.status,
        l.raw_data->>'stage' as stage,
        l.created_at,
        COUNT(wc.id) as message_count,
        MAX(wc.created_at) as last_message_at
      FROM leads l
      LEFT JOIN whatsapp_conversations wc ON l.id = wc.lead_id
      WHERE l.source = 'whatsapp_bot'`;
    const params = [];
    let n = 1;
    if (search) {
      query += ` AND (l.phone ILIKE $${n} OR COALESCE(l.name,'') ILIKE $${n})`;
      params.push('%' + search + '%');
      n++;
    }
    if (status) {
      query += ` AND l.status = $${n}`;
      params.push(status);
      n++;
    }
    query += ` GROUP BY l.id ORDER BY MAX(wc.created_at) DESC NULLS LAST LIMIT 50`;
    
    const result = await pool.query(query, params);
    // Return both keys for dashboard compatibility
    res.json({ success: true, conversations: result.rows, data: result.rows, total: result.rows.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get messages by leadId
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
    
    res.json({ success: true, lead: leadResult.rows[0], messages: messagesResult.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get messages by phone OR leadId - dashboard compatibility endpoint
router.get('/whatsapp/conversations/:identifier/messages', async (req, res) => {
  try {
    const { identifier } = req.params;
    let leadId;

    // Short numeric = leadId, longer string or phone = look up by phone
    if (/^\d{1,8}$/.test(identifier)) {
      leadId = parseInt(identifier);
    } else {
      const byPhone = await pool.query(
        `SELECT id FROM leads WHERE phone = $1 AND source = 'whatsapp_bot' ORDER BY created_at DESC LIMIT 1`,
        [identifier]
      );
      if (!byPhone.rows.length) {
        return res.status(404).json({ success: false, error: 'Lead not found' });
      }
      leadId = byPhone.rows[0].id;
    }

    const leadResult = await pool.query(`SELECT * FROM leads WHERE id = $1`, [leadId]);
    const msgResult = await pool.query(
      `SELECT sender, message, ai_metadata, created_at
       FROM whatsapp_conversations WHERE lead_id = $1 ORDER BY created_at ASC`,
      [leadId]
    );

    if (!leadResult.rows.length) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }

    const lead = leadResult.rows[0];
    // Transform to format dashboard JS expects: direction instead of sender
    const data = msgResult.rows.map(m => ({
      direction: m.sender === 'bot' ? 'outgoing' : 'incoming',
      message: m.message,
      message_content: m.message,
      created_at: m.created_at
    }));

    res.json({
      success: true,
      conversation: {
        display_name: lead.name || lead.phone,
        phone: lead.phone,
        city: lead.city || null,
        address: null
      },
      data
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/whatsapp/setup-guide', (req, res) => {
  const webhookUrl = getWebhookUrl();
  res.type('text/html').send(`
<!DOCTYPE html>
<html dir="rtl" lang="he">
<head><meta charset="UTF-8"><title>QUANTUM WhatsApp v6.1</title></head>
<body style="font-family:system-ui;max-width:900px;margin:40px auto;padding:20px">
  <h1 style="color:#2563eb">🚀 QUANTUM WhatsApp Bot v6.1</h1>
  <div style="background:#ecfdf5;border-right:4px solid #10b981;padding:15px">
    <strong>✓ Active!</strong> Auto-handoff, conversation tracking, analytics.
  </div>
  <p><strong>Webhook:</strong> <code>${webhookUrl}</code></p>
  <ul>
    <li>✓ Auto-handoff detection</li>
    <li>✓ Follow-up automation</li>
    <li>✓ Analytics dashboard</li>
  </ul>
</body>
</html>
  `);
});

router.post('/whatsapp/trigger', async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'Phone and message required' });
    
    const lead = await getOrCreateLead(phone);
    const history = await getConversationHistory(lead.id);
    await saveMessage(lead.id, 'user', message);
    
    const insights = extractInsights(message, history);
    const leadInfo = { id: lead.id, name: insights.name || lead.name, user_type: insights.user_type || lead.user_type, stage: insights.stage };
    
    const aiResponse = await callClaudeWithContext(history, message, leadInfo);
    await saveMessage(lead.id, 'bot', aiResponse);
    await updateLead(lead.id, insights);
    
    const auth = getBasicAuth();
    const result = await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/SendWhatsAppChat`, {
      Data: { Message: aiResponse, Phone: phone, Settings: { CustomerMessageId: `trigger_${Date.now()}` } }
    }, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
      timeout: 15000,
      validateStatus: () => true
    });
    
    res.json({ success: result.data.StatusId === 1, aiResponse, leadId: lead.id, insights });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/whatsapp/stats', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(DISTINCT l.id) as total_leads,
        COUNT(DISTINCT CASE WHEN l.status = 'new' THEN l.id END) as new_leads,
        COUNT(DISTINCT CASE WHEN l.status = 'active' THEN l.id END) as active_leads,
        COUNT(DISTINCT CASE WHEN l.status = 'pending_handoff' THEN l.id END) as pending_handoff,
        COUNT(wc.id) as total_messages
      FROM leads l
      LEFT JOIN whatsapp_conversations wc ON l.id = wc.lead_id
      WHERE l.source = 'whatsapp_bot'
    `);
    
    res.json({
      success: true,
      version: '6.1',
      timestamp: new Date().toISOString(),
      webhookUrl: getWebhookUrl(),
      stats: stats.rows[0],
      features: ['Conversation tracking', 'Context-aware AI', 'Lead management', 'Auto-handoff', 'Analytics']
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
