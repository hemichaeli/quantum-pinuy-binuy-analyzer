// Background Service Worker - פינוי-בינוי Phone Collector v2
const API_BASE = 'https://pinuy-binuy-analyzer-production.up.railway.app';

let stats = { sent: 0, phonesFound: 0, errors: 0, lastSent: null, lastPhone: null };

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PHONE_FOUND') {
    handlePhoneFound(message.data).then(result => sendResponse(result));
    return true;
  }
  if (message.type === 'LISTING_FOUND') {
    handleListingFound(message.data).then(result => sendResponse(result));
    return true;
  }
  if (message.type === 'BULK_LISTINGS') {
    handleBulkListings(message.data).then(result => sendResponse(result));
    return true;
  }
  if (message.type === 'GET_STATS') {
    sendResponse(stats);
    return false;
  }
});

async function handlePhoneFound(data) {
  try {
    console.log('[BG] Phone found:', data.phone, 'source:', data.source, 'id:', data.source_listing_id);
    
    const response = await fetch(`${API_BASE}/api/dashboard/ads/update-phone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: data.phone,
        contact_name: data.contact_name || null,
        source: data.source,
        source_listing_id: data.source_listing_id || null,
        source_url: data.url || null
      })
    });
    
    const result = await response.json();
    stats.phonesFound++;
    stats.lastPhone = data.phone;
    
    if (result.updated > 0) {
      stats.sent++;
      stats.lastSent = new Date().toISOString();
      showNotification(`📞 טלפון נשמר: ${data.phone}`, `עודכן ${result.updated} מודעה`);
      console.log('[BG] Phone saved successfully:', data.phone);
    } else {
      console.log('[BG] Phone not matched to any listing:', data.phone, 'result:', result);
    }
    return { success: true, updated: result.updated || 0 };
  } catch (err) {
    stats.errors++;
    console.error('[BG] Phone send error:', err);
    return { success: false, error: err.message };
  }
}

async function handleListingFound(data) {
  try {
    console.log('[BG] Listing found:', data.source, data.source_listing_id, data.url);
    
    const response = await fetch(`${API_BASE}/api/dashboard/ads/bulk-insert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listings: [data] })
    });
    const result = await response.json();
    
    if (result.inserted > 0) {
      stats.sent++;
      stats.lastSent = new Date().toISOString();
      console.log('[BG] New listing inserted:', data.source_listing_id);
    }
    return { success: true, ...result };
  } catch (err) {
    stats.errors++;
    console.error('[BG] Listing send error:', err);
    return { success: false, error: err.message };
  }
}

async function handleBulkListings(listings) {
  try {
    const response = await fetch(`${API_BASE}/api/dashboard/ads/bulk-insert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listings })
    });
    const result = await response.json();
    stats.sent += result.inserted || 0;
    stats.lastSent = new Date().toISOString();
    if ((result.inserted || 0) > 0) {
      showNotification(`✅ ${result.inserted} מודעות נוספו`, `עודכנו ${result.updated || 0} קיימות`);
    }
    return { success: true, ...result };
  } catch (err) {
    stats.errors++;
    console.error('[BG] Bulk send error:', err);
    return { success: false, error: err.message };
  }
}

function showNotification(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: title,
    message: message
  });
}

// Auto-scrape when tab is updated
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    const url = tab.url;
    if (isListingPage(url)) {
      chrome.tabs.sendMessage(tabId, { type: 'AUTO_SCRAPE' }).catch(() => {});
    }
  }
});

function isListingPage(url) {
  return (
    // Komo listing pages
    (url.includes('komo.co.il') && (url.includes('modaaNum=') || url.includes('/item/'))) ||
    // Yad2 listing pages
    (url.includes('yad2.co.il') && url.includes('/item/')) ||
    // Yad1 listing pages
    (url.includes('yad1.co.il') && (url.includes('/item/') || url.includes('/listing/'))) ||
    // Homeless listing pages
    (url.includes('homeless.co.il') && url.includes('viewad')) ||
    // Madlan listing pages
    (url.includes('madlan.co.il') && url.includes('/listing/')) ||
    // Winwin listing pages
    (url.includes('winwin.co.il') && url.includes('/nadlan/'))
  );
}
