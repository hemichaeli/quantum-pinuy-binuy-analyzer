// Popup script for פינוי-בינוי Phone Collector v2

const API_BASE = 'https://pinuy-binuy-analyzer-production.up.railway.app';

function addLog(msg) {
  const log = document.getElementById('log');
  const time = new Date().toLocaleTimeString('he-IL');
  log.innerHTML = `[${time}] ${msg}\n` + log.innerHTML;
}

// Load and display stats
function loadStats() {
  chrome.runtime.sendMessage({ type: 'GET_STATS' }, (stats) => {
    if (!stats) return;
    document.getElementById('statSent').textContent = stats.sent || 0;
    document.getElementById('statPhones').textContent = stats.phonesFound || 0;
    document.getElementById('statErrors').textContent = stats.errors || 0;
    if (stats.lastPhone) {
      document.getElementById('lastPhone').textContent = stats.lastPhone;
    }
    
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    if (stats.errors > 0 && stats.sent === 0) {
      statusDot.style.background = '#ef4444';
      statusText.textContent = 'שגיאת חיבור לשרת';
    } else {
      statusDot.style.background = '#22c55e';
      statusText.textContent = 'מחובר לשרת ✓';
    }
  });
}

// Scrape current tab
document.getElementById('btnScrape').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      addLog('מפעיל סריקה...');
      chrome.tabs.sendMessage(tabs[0].id, { type: 'AUTO_SCRAPE' }, (response) => {
        if (chrome.runtime.lastError) {
          addLog('❌ ' + chrome.runtime.lastError.message);
        } else {
          addLog('✅ סריקה הופעלה');
          setTimeout(loadStats, 3000);
        }
      });
    }
  });
});

// Open dashboard
document.getElementById('btnDashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: API_BASE });
});

// Init
loadStats();
setInterval(loadStats, 5000);
addLog('תוסף פעיל - גלוש לאתרי נדל"ן לסריקה אוטומטית');
