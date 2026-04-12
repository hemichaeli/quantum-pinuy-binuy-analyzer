/**
 * Pilot Stats Patch
 * 1. Intercepts GET /api/stats — augments with pilotWaSent + pilotReplied
 * 2. Intercepts GET / (dashboard HTML) — injects pilot stat card via <script>
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

const PILOT_IDS = [250, 205, 1077, 64, 122, 458, 1240, 769];

// ── 1. Augment /api/stats ─────────────────────────────────────────────────────
router.get('/api/stats', async (req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = async function(data) {
    if (data && data.success && data.data) {
      try {
        const { rows } = await pool.query(`
          SELECT
            COUNT(DISTINCT phone) FILTER (WHERE message_status = 'נשלחה') as wa_sent,
            COUNT(DISTINCT phone) FILTER (WHERE last_reply_at IS NOT NULL) as replied
          FROM listings
          WHERE complex_id = ANY($1) AND is_active = TRUE
        `, [PILOT_IDS]);
        data.data.pilotWaSent  = parseInt(rows[0]?.wa_sent)  || 0;
        data.data.pilotReplied = parseInt(rows[0]?.replied)  || 0;
      } catch (e) {
        data.data.pilotWaSent  = 0;
        data.data.pilotReplied = 0;
      }
    }
    return originalJson(data);
  };
  next();
});

// ── 2. Inject pilot card into dashboard HTML ──────────────────────────────────
// Appends a <script> that creates the card after the stats grid renders.
router.get('/', (req, res, next) => {
  const originalSendFile = res.sendFile.bind(res);
  res.sendFile = function(filePath, options, callback) {
    // Call original sendFile, then intercept via send
    const originalSend = res.send.bind(res);
    res.send = function(body) {
      if (typeof body === 'string' && body.includes('data-stat="konesCount"')) {
        const injection = `
<script>
(function injectPilotCard() {
  function doInject() {
    var grid = document.querySelector('.stats-grid');
    if (!grid) return;
    if (document.getElementById('pilot-stat-card')) return;
    var card = document.createElement('div');
    card.id = 'pilot-stat-card';
    card.className = 'stat-card';
    card.style.cssText = 'cursor:pointer;border-color:rgba(245,158,11,0.4);';
    card.onclick = function() { if(window.switchTab) switchTab('ads'); };
    card.innerHTML =
      '<div class="stat-number" style="color:#f59e0b;">' +
        '<span class="stat-val" data-stat="pilotWaSent">...</span>' +
      '</div>' +
      '<div class="stat-label">\u{1F4E4} \u05E4\u05D9\u05D9\u05DC\u05D5\u05D8 \u2014 \u05E0\u05E9\u05DC\u05D7</div>' +
      '<div class="stat-hint">' +
        '<span class="stat-val" data-stat="pilotReplied">0</span>' +
        ' \u05E2\u05E0\u05D5 \u05E2\u05D3 \u05DB\u05D4' +
      '</div>' +
      '<div class="stat-change" style="background:rgba(245,158,11,0.1);color:#f59e0b;border-color:rgba(245,158,11,0.3);">' +
        '\u05E4\u05D9\u05D9\u05DC\u05D5\u05D8 \u05DE\u05E9\u05E7\u05D9\u05E2\u05D9\u05DD' +
      '</div>';
    grid.appendChild(card);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', doInject);
  } else {
    doInject();
  }
})();
</script>`;
        body = body.replace('</body>', injection + '\n</body>');
      }
      return originalSend(body);
    };
    return originalSendFile(filePath, options, callback);
  };
  next();
});

module.exports = router;
