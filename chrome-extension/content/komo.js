// Komo.co.il Content Script - Phone Extractor v2
// Uses Komo's phone API: /api/modaotService/showPhoneDetails/post/{id}
// Also handles the search page to extract listing IDs

(function() {
  'use strict';
  
  const SOURCE = 'komo';
  let scraped = false;
  let phoneRevealed = false;
  
  // Extract listing ID from URL patterns:
  // /code/nadlan/details/?modaaNum=XXXXXX
  // /item/XXXXXX
  function getListingId() {
    const url = window.location.href;
    let match = url.match(/modaaNum=(\d+)/);
    if (match) return match[1];
    match = url.match(/\/item\/(\d+)/);
    if (match) return match[1];
    // Try from page content
    const metaId = document.querySelector('[data-listing-id], [data-modaa-num], [data-id]');
    if (metaId) return metaId.dataset.listingId || metaId.dataset.modaaNum || metaId.dataset.id;
    return null;
  }
  
  // Fetch phone via Komo API
  async function fetchPhoneFromAPI(listingId) {
    try {
      const formData = new FormData();
      formData.append('ajaxElement', 'showPhoneDetails');
      formData.append('listingId', listingId);
      
      const response = await fetch('/api/modaotService/showPhoneDetails/post/' + listingId, {
        method: 'POST',
        body: formData,
        credentials: 'include'
      });
      
      if (!response.ok) return null;
      const data = await response.json();
      
      // Phone format: phone1_pre + phone1
      const pre = data.phone1_pre || data.phone_pre || '';
      const num = data.phone1 || data.phone || '';
      if (num) {
        return pre ? `0${pre}-${num}` : num;
      }
      return data.phoneNumber || data.contactPhone || null;
    } catch(e) {
      console.log('[KOMO] Phone API error:', e.message);
      return null;
    }
  }
  
  // Extract all listing data from the page
  function extractListingData(listingId) {
    const data = {
      source: SOURCE,
      url: window.location.href,
      source_listing_id: listingId
    };
    
    // Try to get price from page
    const priceSelectors = [
      '[class*="price"]', '[class*="Price"]', 
      '.modaa-price', '#price', '.item-price',
      '[data-price]'
    ];
    for (const sel of priceSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const priceText = el.textContent.replace(/[^\d]/g, '');
        if (priceText && priceText.length >= 6) {
          data.price = parseInt(priceText);
          break;
        }
      }
    }
    
    // Rooms
    const pageText = document.body.innerText;
    const roomsMatch = pageText.match(/(\d+(?:\.\d+)?)\s*(?:חדרים|חד')/);
    if (roomsMatch) data.rooms = parseFloat(roomsMatch[1]);
    
    // Area
    const areaMatch = pageText.match(/(\d+)\s*מ"ר/);
    if (areaMatch) data.area = parseInt(areaMatch[1]);
    
    // Floor
    const floorMatch = pageText.match(/קומה\s*(\d+)/);
    if (floorMatch) data.floor = parseInt(floorMatch[1]);
    
    // Title from h1
    const h1 = document.querySelector('h1');
    if (h1) data.title = h1.textContent.trim();
    
    // City/address from meta or breadcrumbs
    const metaCity = document.querySelector('meta[property="og:locality"], [class*="city"], [class*="location"]');
    if (metaCity) data.city = (metaCity.content || metaCity.textContent || '').trim();
    
    return data;
  }
  
  // Send phone to backend
  function sendPhone(listingId, phone, contactName) {
    if (!phone || phoneRevealed) return;
    phoneRevealed = true;
    console.log('[KOMO] Sending phone:', phone, 'for listing:', listingId);
    chrome.runtime.sendMessage({
      type: 'PHONE_FOUND',
      data: {
        source: SOURCE,
        source_listing_id: listingId,
        url: window.location.href,
        phone: phone,
        contact_name: contactName || null
      }
    });
  }
  
  // Also intercept XHR/fetch phone calls (in case user clicks manually)
  function interceptPhoneAPI() {
    const origFetch = window.fetch;
    window.fetch = function(url, options) {
      const urlStr = typeof url === 'string' ? url : (url?.url || '');
      return origFetch.apply(this, arguments).then(response => {
        if (urlStr.includes('showPhoneDetails') || urlStr.includes('showPhone')) {
          response.clone().json().then(data => {
            const pre = data.phone1_pre || '';
            const num = data.phone1 || data.phone || '';
            const phone = num ? (pre ? `0${pre}-${num}` : num) : null;
            const name = data.name || data.contactName || null;
            if (phone) {
              const listingId = getListingId();
              sendPhone(listingId, phone, name);
            }
          }).catch(() => {});
        }
        return response;
      });
    };
  }
  
  async function init() {
    const listingId = getListingId();
    if (!listingId) return;
    
    console.log('[KOMO] Initializing for listing:', listingId);
    interceptPhoneAPI();
    
    // Wait for page to load
    await new Promise(r => setTimeout(r, 1500));
    
    // First check if phone is already visible
    const phoneRegex = /0[5-9]\d[-\s]?\d{3}[-\s]?\d{4}/g;
    const visiblePhones = document.body.innerText.match(phoneRegex);
    if (visiblePhones && visiblePhones.length > 0) {
      sendPhone(listingId, visiblePhones[0].replace(/\s/g, '-'), null);
    } else {
      // Try to fetch phone via API
      const phone = await fetchPhoneFromAPI(listingId);
      if (phone) {
        sendPhone(listingId, phone, null);
      }
    }
    
    // Send listing data
    if (!scraped) {
      scraped = true;
      const listing = extractListingData(listingId);
      chrome.runtime.sendMessage({ type: 'LISTING_FOUND', data: listing });
    }
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
