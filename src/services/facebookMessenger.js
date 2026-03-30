/**
 * Facebook Messenger Service v2 - Multi-account pool with anti-block protection
 *
 * Uses fbAccountPool for account rotation, fb_dtsg tokens, random delays,
 * and per-account daily limits to avoid blocks.
 *
 * Priority: Marketplace GraphQL mutation → cookie fallback → manual link
 */

const axios = require('axios');
const { logger } = require('./logger');

// Lazy-load account pool
let _pool;
function getPool() {
  if (!_pool) {
    try { _pool = require('./fbAccountPool'); }
    catch (e) { logger.warn('[FBMessenger] fbAccountPool not available:', e.message); _pool = null; }
  }
  return _pool;
}

// ─── Send to Marketplace Listing (PRIMARY) ───

/**
 * Send a message to a Facebook Marketplace listing seller.
 * Uses account pool rotation with anti-block protection.
 */
async function sendToMarketplaceListing(listingUrl, messageText, options = {}) {
  const pool = getPool();
  if (!pool) {
    return { success: false, error: 'FB account pool not configured', channel: 'fb_messenger', fallback: 'manual', manualUrl: listingUrl };
  }

  // Extract listing ID from URL
  const listingMatch = listingUrl?.match(/marketplace\/item\/(\d+)/);
  const listingId = listingMatch ? listingMatch[1] : null;

  if (!listingId) {
    return { success: false, error: 'Cannot extract listing ID from URL', channel: 'fb_messenger', fallback: 'manual', manualUrl: listingUrl };
  }

  // Get next available account from pool
  const account = pool.getNextAccount();
  if (!account) {
    return { success: false, error: 'No available FB accounts (all in cooldown/expired/at daily limit)', channel: 'fb_messenger', fallback: 'manual', manualUrl: listingUrl };
  }

  // Wait for anti-block delay
  await pool.waitForDelay();

  // Get fb_dtsg token (required for GraphQL mutations)
  const dtsg = await pool.getDtsg(account);
  if (!dtsg) {
    pool.markAccountError(account.id, 'expired');
    // Try next account
    const fallbackAccount = pool.getNextAccount();
    if (fallbackAccount) {
      const dtsg2 = await pool.getDtsg(fallbackAccount);
      if (dtsg2) {
        return await _sendMarketplaceMessage(fallbackAccount, listingId, messageText, dtsg2, listingUrl);
      }
    }
    return { success: false, error: 'Could not get fb_dtsg token from any account', channel: 'fb_messenger', fallback: 'manual', manualUrl: listingUrl };
  }

  return await _sendMarketplaceMessage(account, listingId, messageText, dtsg, listingUrl);
}

/**
 * Internal: send marketplace message via GraphQL mutation
 */
async function _sendMarketplaceMessage(account, listingId, messageText, dtsg, listingUrl) {
  const pool = getPool();
  const proxyConfig = pool.getProxyConfig();

  try {
    // Facebook's marketplace messaging GraphQL mutation
    const response = await axios.post(
      'https://www.facebook.com/api/graphql/',
      new URLSearchParams({
        'fb_dtsg': dtsg,
        'fb_api_req_friendly_name': 'MarketplaceSendMessageMutation',
        'variables': JSON.stringify({
          input: {
            listing_id: listingId,
            message: { text: messageText },
            actor_id: account.userId,
            client_mutation_id: `msg_${Date.now()}`
          }
        }),
        'doc_id': '5889623031114251',
        '__a': '1',
        '__user': account.userId,
        '__rev': '0'
      }).toString(),
      {
        headers: {
          'Cookie': account.cookieStr,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': account.userAgent,
          'Origin': 'https://www.facebook.com',
          'Referer': `https://www.facebook.com/marketplace/item/${listingId}/`,
          'X-FB-Friendly-Name': 'MarketplaceSendMessageMutation',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin'
        },
        timeout: 20000,
        ...(proxyConfig ? { proxy: proxyConfig } : {})
      }
    );

    const data = response.data;
    const hasErrors = data?.errors || data?.error;

    // Check for rate limit / block indicators
    if (hasErrors) {
      const errorStr = JSON.stringify(data.errors || data.error);
      if (errorStr.includes('rate') || errorStr.includes('too many') || errorStr.includes('spam')) {
        pool.markAccountError(account.id, 'rate_limit');
        return { success: false, error: 'Rate limited', channel: 'fb_messenger', method: 'graphql', listingId, accountId: account.id };
      }
      if (errorStr.includes('block') || errorStr.includes('restricted') || errorStr.includes('suspended')) {
        pool.markAccountError(account.id, 'blocked');
        return { success: false, error: 'Account blocked', channel: 'fb_messenger', method: 'graphql', listingId, accountId: account.id };
      }
      if (errorStr.includes('login') || errorStr.includes('session') || errorStr.includes('expired')) {
        pool.markAccountError(account.id, 'expired');
        return { success: false, error: 'Session expired', channel: 'fb_messenger', method: 'graphql', listingId, accountId: account.id };
      }
      pool.markAccountError(account.id, 'unknown');
      return { success: false, error: errorStr.substring(0, 200), channel: 'fb_messenger', method: 'graphql', listingId, accountId: account.id };
    }

    // Check if response indicates success (status 200 + no errors)
    if (response.status === 200) {
      pool.markAccountUsed(account.id);
      logger.info(`[FBMessenger] Message sent to listing ${listingId} via account ${account.id}`);
      return {
        success: true,
        channel: 'fb_messenger',
        method: 'graphql',
        listingId,
        accountId: account.id,
        messageId: data?.data?.marketplace_send_message?.message?.id || null
      };
    }

    pool.markAccountError(account.id, 'unknown');
    return { success: false, error: `HTTP ${response.status}`, channel: 'fb_messenger', method: 'graphql', listingId };

  } catch (err) {
    const status = err.response?.status;
    if (status === 429 || (err.message && err.message.includes('429'))) {
      pool.markAccountError(account.id, 'rate_limit');
    } else if (status === 401 || status === 403) {
      pool.markAccountError(account.id, 'expired');
    } else {
      pool.markAccountError(account.id, 'unknown');
    }

    logger.warn(`[FBMessenger] GraphQL send failed for account ${account.id}: ${err.message}`);

    // Try old-style /messaging/send/ as last resort
    try {
      const fallbackResult = await _sendViaMessagingEndpoint(account, listingId, messageText);
      if (fallbackResult.success) {
        pool.markAccountUsed(account.id);
        return fallbackResult;
      }
    } catch (e2) {
      // ignore fallback failure
    }

    return {
      success: false,
      error: err.message,
      channel: 'fb_messenger',
      method: 'graphql',
      listingId,
      fallback: 'manual',
      manualUrl: listingUrl || `https://www.facebook.com/marketplace/item/${listingId}/`
    };
  }
}

/**
 * Fallback: send via /messaging/send/ endpoint
 */
async function _sendViaMessagingEndpoint(account, listingId, messageText) {
  const pool = getPool();
  const proxyConfig = pool.getProxyConfig();
  const dtsg = account.dtsg || '';

  const response = await axios.post(
    'https://www.facebook.com/messaging/send/',
    new URLSearchParams({
      'body': messageText,
      'other_user_fbid': listingId,
      'action_type': 'ma-type:user-generated-message',
      'fb_dtsg': dtsg,
      '__user': account.userId,
      '__a': '1'
    }).toString(),
    {
      headers: {
        'Cookie': account.cookieStr,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': account.userAgent,
        'Origin': 'https://www.facebook.com',
        'Referer': 'https://www.facebook.com/messages/'
      },
      timeout: 15000,
      ...(proxyConfig ? { proxy: proxyConfig } : {})
    }
  );

  return {
    success: response.status === 200,
    channel: 'fb_messenger',
    method: 'messaging_endpoint',
    listingId,
    accountId: account.id
  };
}

// ─── Send Direct Message (to a user/seller by ID) ───

async function sendMessage(recipientId, messageText) {
  const pool = getPool();
  if (!pool) {
    return { success: false, error: 'FB account pool not configured', channel: 'fb_messenger' };
  }

  const account = pool.getNextAccount();
  if (!account) {
    return { success: false, error: 'No available FB accounts', channel: 'fb_messenger' };
  }

  await pool.waitForDelay();
  const dtsg = await pool.getDtsg(account);

  try {
    const response = await axios.post(
      'https://www.facebook.com/messaging/send/',
      new URLSearchParams({
        'body': messageText,
        'other_user_fbid': recipientId,
        'action_type': 'ma-type:user-generated-message',
        'fb_dtsg': dtsg || '',
        '__user': account.userId,
        '__a': '1'
      }).toString(),
      {
        headers: {
          'Cookie': account.cookieStr,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': account.userAgent,
          'Origin': 'https://www.facebook.com',
          'Referer': 'https://www.facebook.com/messages/'
        },
        timeout: 15000
      }
    );

    if (response.status === 200) {
      pool.markAccountUsed(account.id);
      return { success: true, channel: 'fb_messenger', method: 'messaging_endpoint', recipientId, accountId: account.id };
    }
    pool.markAccountError(account.id, 'unknown');
    return { success: false, error: `HTTP ${response.status}`, channel: 'fb_messenger' };
  } catch (err) {
    pool.markAccountError(account.id, 'unknown');
    return { success: false, error: err.message, channel: 'fb_messenger' };
  }
}

// ─── Check Inbox (cookie-based) ───

async function checkInbox(sinceTimestamp = null) {
  const pool = getPool();
  if (!pool) return { success: false, error: 'FB account pool not configured', messages: [] };

  const account = pool.getNextAccount();
  if (!account) return { success: false, error: 'No available accounts', messages: [] };

  try {
    const dtsg = await pool.getDtsg(account);
    const response = await axios.post(
      'https://www.facebook.com/api/graphql/',
      new URLSearchParams({
        'fb_dtsg': dtsg || '',
        'fb_api_req_friendly_name': 'MessengerInboxQuery',
        'variables': JSON.stringify({
          limit: 20,
          before: null,
          includeDeliveryReceipts: false,
          includeSeqID: false
        }),
        'doc_id': '7251498888213983',
        '__user': account.userId,
        '__a': '1'
      }).toString(),
      {
        headers: {
          'Cookie': account.cookieStr,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': account.userAgent,
          'Origin': 'https://www.facebook.com'
        },
        timeout: 15000
      }
    );

    // Parse thread list from response
    const threads = response.data?.data?.viewer?.message_threads?.nodes || [];
    const messages = [];
    for (const thread of threads) {
      const lastMsg = thread.last_message?.nodes?.[0];
      if (lastMsg && lastMsg.message_sender?.id !== account.userId) {
        messages.push({
          threadId: thread.thread_key?.thread_fbid || thread.thread_key?.other_user_id,
          from: { id: lastMsg.message_sender?.id, name: lastMsg.message_sender?.name },
          text: lastMsg.snippet || lastMsg.message?.text,
          createdAt: lastMsg.timestamp_precise ? new Date(parseInt(lastMsg.timestamp_precise)).toISOString() : null,
          channel: 'fb_messenger'
        });
      }
    }

    return { success: true, messages, count: messages.length, accountId: account.id };
  } catch (err) {
    logger.warn(`[FBMessenger] Inbox check failed: ${err.message}`);
    return { success: false, error: err.message, messages: [] };
  }
}

// ─── Status & Pool Info ───

function getStatus() {
  const pool = getPool();
  if (!pool) {
    return { configured: false, hasToken: false, hasCookies: false, userId: null, channel: 'fb_messenger' };
  }
  const poolStatus = pool.getPoolStatus();
  return {
    configured: poolStatus.totalAccounts > 0,
    hasToken: false, // We use cookies, not Graph API tokens
    hasCookies: poolStatus.totalAccounts > 0,
    userId: poolStatus.accounts[0]?.userId || null,
    channel: 'fb_messenger',
    pool: poolStatus
  };
}

function getPoolStatus() {
  const pool = getPool();
  return pool ? pool.getPoolStatus() : { totalAccounts: 0 };
}

module.exports = {
  sendMessage,
  sendToMarketplaceListing,
  checkInbox,
  getStatus,
  getPoolStatus
};
