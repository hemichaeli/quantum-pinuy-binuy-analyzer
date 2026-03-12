// Winwin.co.il Content Script - Phone Extractor v1
// Winwin blocks server-side requests (timeout)
// This extension runs in the real browser

(function() {
  'use strict';
  
  const SOURCE = 'winwin';
  let scraped = false;
  let phoneRevealed = false;
  
  function getListingId() {
    const url = window.location.href;
    let match = url.match(/\/nadlan\/[^/]+\/(\d+)/);
    if (match) return match[1];
    match = url.match(/\/item\/(\d+)/);
    if (match) return match[1];
    match = url.match(/\/listing\/(\d+)/);
    if (match) return match[1];
    match = url.match(/[?&]id=(\d+)/);
    if (match) return match[1];
    match = window.location.pathname.match(/\/(\d{5,})/);
    if (match) return match[1];
    return null;
  }
  
  function interceptPhoneAPI() {
    const origFetch = window.fetch;
    window.fetch = function(url, options) {
      const urlStr = typeof url === 'string' ? url : (url?.url || '');
      return origFetch.apply(this, arguments).then(response => {
        if (urlStr.includes('phone') || urlStr.includes('contact') || urlStr.includes('seller')) {
          response.clone().json().then(data => {
            const phone = data.phone || data.phoneNumber || data.contactPhone || 
                          (data.data && (data.data.phone || data.data.phoneNumber));
            const name = data.name || data.contactName || (data.data && data.data.name);
            if (phone && !phoneRevealed) {
              phoneRevealed = true;
              const listingId = getListingId();
              console.log('[WINWIN] Phone from API:', phone);
              chrome.runtime.sendMessage({
                type: 'PHONE_FOUND',
                data: { source: SOURCE, source_listing_id: listingId, url: window.location.href, phone, contact_name: name || null }
              });
            }
          }).catch(() => {});
        }
        return response;
      });
    };
  }
  
  function clickPhoneButton() {
    const allBtns = document.querySelectorAll('button, a, [role="button"]');
    for (const btn of allBtns) {
      const text = btn.textContent.trim();
      if ((text.includes('טלפון') || text.includes('חייג') || text.includes('הצג מספר') || 
           text.includes('הצג טלפון') || text.includes('לחץ לטלפון')) && 
          !btn.dataset.clicked) {
        btn.dataset.clicked = 'true';
        console.log('[WINWIN] Clicking phone button:', text);
        btn.click();
        return true;
      }
    }
    return false;
  }
  
  function checkVisiblePhone() {
    const listingId = getListingId();
    if (!listingId || phoneRevealed) return false;
    
    const phoneRegex = /0[5-9]\d[-\s]?\d{3}[-\s]?\d{4}|0[2-4]\d[-\s]?\d{3}[-\s]?\d{4}/g;
    const phones = document.body.innerText.match(phoneRegex);
    
    if (phones && phones.length > 0) {
      phoneRevealed = true;
      const phone = phones[0].replace(/\s/g, '-');
      console.log('[WINWIN] Phone visible:', phone);
      chrome.runtime.sendMessage({
        type: 'PHONE_FOUND',
        data: { source: SOURCE, source_listing_id: listingId, url: window.location.href, phone }
      });
      return true;
    }
    return false;
  }
  
  function extractListingData() {
    const listingId = getListingId();
    if (!listingId || scraped) return;
    scraped = true;
    
    const data = { source: SOURCE, url: window.location.href, source_listing_id: listingId };
    
    const priceMatch = document.body.innerText.match(/([0-9,]+)\s*₪/);
    if (priceMatch) data.price = parseInt(priceMatch[1].replace(/,/g, ''));
    
    const h1 = document.querySelector('h1');
    if (h1) data.title = h1.textContent.trim();
    
    const roomsMatch = document.body.innerText.match(/(\d+(?:\.\d+)?)\s*חדרים/);
    if (roomsMatch) data.rooms = parseFloat(roomsMatch[1]);
    
    const areaMatch = document.body.innerText.match(/(\d+)\s*מ"ר/);
    if (areaMatch) data.area = parseInt(areaMatch[1]);
    
    const floorMatch = document.body.innerText.match(/קומה[:\s]+(\d+)/);
    if (floorMatch) data.floor = parseInt(floorMatch[1]);
    
    console.log('[WINWIN] Sending listing:', data);
    chrome.runtime.sendMessage({ type: 'LISTING_FOUND', data });
  }
  
  async function init() {
    const listingId = getListingId();
    if (!listingId) return;
    
    console.log('[WINWIN] Initializing for listing:', listingId);
    interceptPhoneAPI();
    
    await new Promise(r => setTimeout(r, 1500));
    
    if (!checkVisiblePhone()) {
      clickPhoneButton();
      await new Promise(r => setTimeout(r, 2000));
      checkVisiblePhone();
    }
    
    extractListingData();
    setTimeout(checkVisiblePhone, 5000);
  }
  
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'AUTO_SCRAPE') { scraped = false; phoneRevealed = false; init(); }
  });
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
