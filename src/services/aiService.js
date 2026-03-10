/**
 * QUANTUM AI Service — v1.0
 * Auto-fallback: Claude → Gemini on credit error
 * Sends WhatsApp alert to owner on provider switch
 */

const axios = require('axios');

const INFORU_CAPI_BASE = 'https://capi.inforu.co.il/api/v2';
const OWNER_PHONE = '972546550815'; // Hemi

// In-memory state — resets on redeploy (good: forces re-check after fix)
let currentProvider = 'claude'; // 'claude' | 'gemini'
let lastProviderSwitch = null;
let switchCount = 0;

function getProvider() { return currentProvider; }

async function sendOwnerAlert(message) {
  try {
    const username = process.env.INFORU_USERNAME;
    const password = process.env.INFORU_PASSWORD;
    if (!username || !password) return;
    const auth = Buffer.from(`${username}:${password}`).toString('base64');
    await axios.post(`${INFORU_CAPI_BASE}/WhatsApp/SendWhatsAppChat`, {
      Data: {
        Message: message,
        Phone: OWNER_PHONE,
        Settings: { CustomerMessageId: `alert_${Date.now()}`, CustomerParameter: 'QUANTUM_SYSTEM_ALERT' }
      }
    }, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
      timeout: 10000,
      validateStatus: () => true
    });
    console.log(`[AIService] Owner alert sent: ${message.substring(0, 60)}...`);
  } catch (err) {
    console.error('[AIService] Failed to send owner alert:', err.message);
  }
}

async function callClaude(systemPrompt, userMessage) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw Object.assign(new Error('No ANTHROPIC_API_KEY'), { code: 'NO_KEY' });

  const response = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 400,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }]
  }, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    timeout: 12000
  });

  return response.data.content[0].text;
}

async function callGemini(systemPrompt, userMessage) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw Object.assign(new Error('No GEMINI_API_KEY'), { code: 'NO_KEY' });

  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      generationConfig: { maxOutputTokens: 400, temperature: 0.7 }
    },
    { timeout: 12000 }
  );

  return response.data.candidates[0].content.parts[0].text;
}

/**
 * Main AI call — tries Claude, falls back to Gemini on credit error
 */
async function generateResponse(systemPrompt, userMessage) {
  // If already switched to Gemini, use it directly
  if (currentProvider === 'gemini') {
    try {
      const text = await callGemini(systemPrompt, userMessage);
      console.log('[AIService] ✅ Gemini response OK');
      return { text, provider: 'gemini' };
    } catch (err) {
      console.error('[AIService] Gemini error:', err.message);
      return { text: 'שלום! במה אפשר לעזור?', provider: 'gemini_fallback' };
    }
  }

  // Try Claude first
  try {
    const text = await callClaude(systemPrompt, userMessage);
    console.log('[AIService] ✅ Claude response OK');
    return { text, provider: 'claude' };
  } catch (err) {
    const status = err.response?.status;
    const errMsg = err.response?.data?.error?.message || err.message || '';
    const isCreditError = status === 400 && errMsg.toLowerCase().includes('credit');
    const isAuthError = status === 401;

    if (isCreditError || isAuthError) {
      // Switch to Gemini
      currentProvider = 'gemini';
      lastProviderSwitch = new Date().toISOString();
      switchCount++;

      console.warn(`[AIService] ⚠️ Claude ${isCreditError ? 'credit depleted' : 'auth error'} — switching to Gemini (switch #${switchCount})`);

      // Alert owner via WhatsApp
      await sendOwnerAlert(
        `⚠️ *QUANTUM Bot — התראה*\n\n` +
        `Claude API ${isCreditError ? 'נגמר קרדיט' : 'שגיאת הרשאה'}.\n` +
        `*עבר אוטומטית ל-Gemini* ✅\n\n` +
        `הבוט ממשיך לעבוד רגיל.\n` +
        `לחזרה ל-Claude: הוסף קרדיט ב-console.anthropic.com ואז redeploy ב-Railway.\n\n` +
        `שגיאה: ${errMsg.substring(0, 100)}`
      );

      // Now try Gemini
      try {
        const text = await callGemini(systemPrompt, userMessage);
        console.log('[AIService] ✅ Gemini fallback response OK');
        return { text, provider: 'gemini' };
      } catch (geminiErr) {
        console.error('[AIService] Gemini also failed:', geminiErr.message);
        return { text: 'שלום! במה אפשר לעזור?', provider: 'error_fallback' };
      }
    }

    // Other Claude error (network, timeout, etc.) — don't switch, just fallback text
    console.error(`[AIService] Claude error (${status}): ${errMsg}`);
    return { text: 'שלום! במה אפשר לעזור?', provider: 'error_fallback' };
  }
}

/**
 * Status endpoint data
 */
function getStatus() {
  return {
    currentProvider,
    lastProviderSwitch,
    switchCount,
    claudeKeySet: !!process.env.ANTHROPIC_API_KEY,
    geminiKeySet: !!process.env.GEMINI_API_KEY
  };
}

/**
 * Manual reset to Claude (call after adding credits + redeploy)
 */
function resetToClaud() {
  currentProvider = 'claude';
  console.log('[AIService] Reset to Claude');
}

module.exports = { generateResponse, getProvider, getStatus, resetToClaud };
