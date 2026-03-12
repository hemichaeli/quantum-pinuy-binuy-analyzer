// Homeless.co.il Content Script - Phone Extractor v2
// Homeless uses ASP.NET UpdatePanel - phone is revealed via button click
// URL format: /sale/viewad,258428.aspx

(function() {
  'use strict';
  
  const SOURCE = 'homeless';
  let scraped = false;
  let phoneRevealed = false;
  
  function getListingId() {
    // Match /sale/viewad,258428.aspx or /rent/viewad,258428.aspx
    const match = window.location.pathname.match(/viewad[,_](\d+)/i);
    if (match) return match[1];
    // Also match from ad_ row IDs on list pages
    return null;
  }
  
  // Intercept ASP.NET UpdatePanel XHR calls (ScriptManager __doPostBack)
  function interceptUpdatePanel() {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
      this._url = url;
      this._method = method;
      return origOpen.apply(this, [method, url, ...args]);
    };
    
    XMLHttpRequest.prototype.send = function(body) {
      this.addEventListener('load', function() {
        try {
          const responseText = this.responseText || '';
          // ASP.NET UpdatePanel returns pipe-delimited response
          // Look for phone numbers in the response
          const phoneRegex = /0[5-9]\d[-\s]?\d{3}[-\s]?\d{4}|0[2-4]\d[-\s]?\d{3}[-\s]?\d{4}/g;
          const phones = responseText.match(phoneRegex);
          if (phones && phones.length > 0 && !phoneRevealed) {
            phoneRevealed = true;
            const phone = phones[0].replace(/\s/g, '-');
            console.log('[HOMELESS] Phone from UpdatePanel:', phone);
            chrome.runtime.sendMessage({
              type: 'PHONE_FOUND',
              data: { source: SOURCE, source_listing_id: getListingId(), url: window.location.href, phone }
            });
          }
        } catch(e) {}
      });
      return origSend.apply(this, arguments);
    };
  }
  
  // Click the phone reveal button (btnvcPhone1)
  function clickPhoneButton() {
    const phoneBtn = document.querySelector('#btnvcPhone1, [id*="vcPhone"], [id*="showPhone"]');
    if (phoneBtn && !phoneBtn.dataset.clicked) {
      phoneBtn.dataset.clicked = 'true';
      console.log('[HOMELESS] Clicking phone button:', phoneBtn.id);
      phoneBtn.click();
      return true;
    }
    return false;
  }
  
  // Check if phone is already visible in DOM
  function checkVisiblePhone() {
    const listingId = getListingId();
    if (!listingId || phoneRevealed) return false;
    
    const phoneRegex = /0[5-9]\d[-\s]?\d{3}[-\s]?\d{4}|0[2-4]\d[-\s]?\d{3}[-\s]?\d{4}/g;
    const phones = document.body.innerText.match(phoneRegex);
    
    if (phones && phones.length > 0) {
      phoneRevealed = true;
      const phone = phones[0].replace(/\s/g, '-');
      console.log('[HOMELESS] Phone visible:', phone);
      chrome.runtime.sendMessage({
        type: 'PHONE_FOUND',
        data: { source: SOURCE, source_listing_id: listingId, url: window.location.href, phone }
      });
      return true;
    }
    return false;
  }
  
  // Extract listing data from the detail page
  function extractListingData() {
    const listingId = getListingId();
    if (!listingId || scraped) return;
    scraped = true;
    
    const data = { source: SOURCE, url: window.location.href, source_listing_id: listingId };
    
    // Price - look for ₪ symbol
    const priceMatch = document.body.innerText.match(/([0-9,]+)\s*₪/);
    if (priceMatch) {
      data.price = parseInt(priceMatch[1].replace(/,/g, ''));
    }
    
    // Title from h1
    const h1 = document.querySelector('h1');
    if (h1) data.title = h1.textContent.trim();
    
    // Rooms
    const roomsMatch = document.body.innerText.match(/(\d+(?:\.\d+)?)\s*חדרים/);
    if (roomsMatch) data.rooms = parseFloat(roomsMatch[1]);
    
    // Area
    const areaMatch = document.body.innerText.match(/(\d+)\s*מ"ר/);
    if (areaMatch) data.area = parseInt(areaMatch[1]);
    
    // Floor
    const floorMatch = document.body.innerText.match(/קומה[:\s]+(\d+)/);
    if (floorMatch) data.floor = parseInt(floorMatch[1]);
    
    // City from breadcrumbs or title
    const cityEl = document.querySelector('.breadcrumb a, [class*="city"]');
    if (cityEl) data.city = cityEl.textContent.trim();
    
    // Contact name
    const contactEl = document.querySelector('[class*="contact"], [class*="owner"], #contactName');
    if (contactEl) data.contact_name = contactEl.textContent.trim();
    
    console.log('[HOMELESS] Sending listing data:', data);
    chrome.runtime.sendMessage({ type: 'LISTING_FOUND', data });
  }
  
  async function init() {
    const listingId = getListingId();
    if (!listingId) return; // Only run on listing detail pages
    
    console.log('[HOMELESS] Initializing for listing:', listingId);
    interceptUpdatePanel();
    
    // Wait for page to load
    await new Promise(r => setTimeout(r, 1500));
    
    // Check if phone already visible
    if (!checkVisiblePhone()) {
      // Click the phone button
      clickPhoneButton();
      
      // Check again after button click
      await new Promise(r => setTimeout(r, 2000));
      checkVisiblePhone();
    }
    
    // Extract listing data
    extractListingData();
    
    // Final check after 5 seconds
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
