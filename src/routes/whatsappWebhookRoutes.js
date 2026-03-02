/**
 * QUANTUM WhatsApp Bot - v5.1
 * Unified: All WhatsApp via QUANTUM account (037572229)
 * Fixed: Correct INFORU webhook payload parsing
 */

const express = require('express');
const router = express.Router();

const INFORU_CAPI_BASE = 'https://capi.inforu.co.il/api/v2';
const DEPLOYMENT_TIME = new Date().toISOString();

function getBasicAuth() {
  const username = process.env.INFORU_USERNAME;
  const password = process.env.INFORU_PASSWORD;
  if (!username || !password) throw new Error('INFORU credentials not configured');
  return Buffer.from(`${username}:${password}`).toString('base64');
}

/**
 * Parse INFORU webhook payload
 * INFORU sends: { Data: [{ Value: "phone", Message: "text", Network: "WhatsApp", ... }], CustomerId, ProjectId }
 */
function parseInforuWebhook(body) {
  // Format 1: INFORU standard webhook
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
  
  // Format 2: Simple format (manual trigger / other)
  return {
    phone: body.phone || body.from || body.Phone || null,
    message: body.message || body.text || body.body || body.Message || null,
    network: 'Direct',
    channel: 'Direct',
    raw: body
  };
}

// Simple AI call function
async function callClaude(systemPrompt, userPrompt) {
  try {
    const axios = require('axios');
    
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    }, {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      timeout: 8000
    });
    
    return response.data.content[0].text;
  } catch (error) {
    console.error('Claude API error:', error.message);
    return 'שלום! אני מ-QUANTUM. איך אני יכול לעזור לך?';
  }
}

const SALES_SYSTEM_PROMPT = `אתה QUANTUM Sales AI - המתווך הדיגיטלי החכם ביותר בישראל.
מומחה בפינוי-בינוי ואיכות מכירות מעולה.

המטרה שלך היא:
1. לזהות אם הלקוח קונה או מוכר
2. לגלות מה המצב עם התיווך הנוכחי  
3. להוביל לפגישה עם מומחה QUANTUM

תגובות לפי סיטואציות:
- פתיחה: "שלום! אני מ-QUANTUM 👋 איך קוראים לך?"
- מוכר: "מעולה! איפה הנכס ומה סוגו? יש לנו קונים מחפשים"
- קונה: "נהדר! איזה אזור מעניין אותך? יש לנו נכסים מיוחדים"
- אין מתווך: "מעולה! יש לך יתרון - תוכל לבחור את הטובים ביותר"
- יש מתווך: "איך אתה מרגיש עם ההתקדמות?"
- לא מרוצה ממתווך: "יש לנו גישה לקונים/נכסים שאחרים לא מכירים"

היה קצר, ישיר ומקצועי.`;

// INFORU webhook receiver
router.post('/whatsapp/webhook', async (req, res) => {
  try {
    const parsed = parseInforuWebhook(req.body);
    
    if (!parsed.phone || !parsed.message) {
      console.log('Webhook: incomplete data:', JSON.stringify(req.body).substring(0, 300));
      return res.status(200).json({ 
        received: true, 
        processed: false, 
        reason: 'Missing phone or message',
        parsedPhone: parsed.phone,
        parsedMessage: parsed.message
      });
    }
    
    console.log('WEBHOOK: Message received:', { 
      phone: parsed.phone, 
      message: parsed.message.substring(0, 50),
      network: parsed.network,
      timestamp: new Date().toISOString()
    });
    
    // Only auto-reply to WhatsApp messages
    if (parsed.network !== 'WhatsApp' && parsed.network !== 'Direct') {
      console.log('Webhook: Non-WhatsApp message, skipping auto-reply:', parsed.network);
      return res.json({ received: true, processed: false, reason: `Network: ${parsed.network}` });
    }
    
    // Generate AI response
    const aiResponse = await callClaude(SALES_SYSTEM_PROMPT, parsed.message);
    
    // Send response via QUANTUM credentials (037572229)
    const axios = require('axios');
    const auth = getBasicAuth();
    
    const result = await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/SendWhatsAppChat`, {
      Data: { 
        Message: aiResponse, 
        Phone: parsed.phone,
        Settings: {
          CustomerMessageId: `bot_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
          CustomerParameter: 'QUANTUM_BOT'
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
    console.log(`Bot reply ${success ? 'sent' : 'failed'}:`, { 
      status: result.data.StatusId, 
      description: result.data.StatusDescription,
      phone: parsed.phone
    });
    
    res.json({ 
      success,
      processed: true,
      incomingPhone: parsed.phone,
      incomingMessage: parsed.message,
      autoReplyStatus: result.data.StatusId,
      autoReplyDescription: result.data.StatusDescription,
      deploymentTime: DEPLOYMENT_TIME
    });
    
  } catch (error) {
    console.error('Webhook processing error:', error.message);
    res.status(500).json({ 
      error: 'Processing failed', 
      details: error.message,
      webhookReceived: true,
      deploymentTime: DEPLOYMENT_TIME
    });
  }
});

// Manual trigger for testing
router.post('/whatsapp/trigger', async (req, res) => {
  try {
    const { phone, message } = req.body;
    
    if (!phone || !message) {
      return res.status(400).json({ error: 'Phone and message required' });
    }
    
    console.log('Manual trigger:', { phone, message });
    
    const aiResponse = await callClaude(SALES_SYSTEM_PROMPT, message);
    
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
      inforuResult: result.data,
      credentials: 'QUANTUM (env vars)',
      whatsappNumber: '037572229',
      deploymentTime: DEPLOYMENT_TIME
    });
    
  } catch (error) {
    console.error('Manual trigger error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Stats endpoint  
router.get('/whatsapp/stats', async (req, res) => {
  try {
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      deploymentTime: DEPLOYMENT_TIME,
      whatsappNumber: '037572229',
      credentials: {
        source: 'env vars (INFORU_USERNAME/INFORU_PASSWORD)',
        account: process.env.INFORU_USERNAME || 'NOT SET'
      },
      webhookFormat: 'INFORU standard (Data array with Value/Message/Network)',
      status: 'ACTIVE - Send message to 037572229 to test'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
