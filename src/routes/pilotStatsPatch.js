/**
 * Pilot Stats Patch
 * 1. GET /api/stats — augments with pilotWaSent + pilotReplied
 * 2. GET / (dashboard HTML) — injects:
 *    a) Pilot stat card in the main stats grid
 *    b) Pilot outreach panel in the messages tab (with status filters)
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const fs = require('fs');
const path = require('path');

const PILOT_IDS = [250, 205, 1077, 64, 122, 458, 1240, 769];
const DASHBOARD_PATH = path.join(__dirname, '../public/dashboard.html');

// ── Pilot stat card (main stats grid) ────────────────────────────────────────
const PILOT_CARD_HTML = `
            <div id="pilot-stat-card" class="stat-card" style="cursor:pointer;border-color:rgba(245,158,11,0.4);" onclick="loadPilotOutreach('all')">
                <div class="stat-number" style="color:#f59e0b;"><span class="stat-val" data-stat="pilotWaSent">...</span></div>
                <div class="stat-label">📤 פיילוט — נשלח</div>
                <div class="stat-hint"><span class="stat-val" data-stat="pilotReplied">0</span> ענו עד כה</div>
                <div class="stat-change" style="background:rgba(245,158,11,0.1);color:#f59e0b;border-color:rgba(245,158,11,0.3);">פיילוט משקיעים</div>
            </div>`;

// ── Pilot outreach panel (messages tab) ───────────────────────────────────────
const PILOT_MESSAGES_PANEL = `
        <!-- PILOT OUTREACH PANEL -->
        <div id="pilot-outreach-panel" class="section" style="margin:0;border-radius:0;border-left:none;border-right:none;border-top:none;padding:14px 20px;border-bottom:1px solid var(--border-subtle);">
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:12px;">
                <h2 style="margin:0;font-size:14px;">📤 פיילוט משקיעים — הודעות יוצאות</h2>
                <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                    <button class="btn" id="pilot-filter-all"     onclick="loadPilotOutreach('all')"     style="padding:4px 12px;font-size:12px;background:var(--teal);">הכל</button>
                    <button class="btn btn-secondary" id="pilot-filter-sent"    onclick="loadPilotOutreach('sent')"    style="padding:4px 12px;font-size:12px;">📤 יוצאות</button>
                    <button class="btn btn-secondary" id="pilot-filter-replied" onclick="loadPilotOutreach('replied')" style="padding:4px 12px;font-size:12px;">✅ נענו</button>
                    <button class="btn btn-secondary" id="pilot-filter-waiting" onclick="loadPilotOutreach('waiting')" style="padding:4px 12px;font-size:12px;">⏳ ממתין</button>
                    <button class="btn btn-secondary" id="pilot-filter-none"    onclick="loadPilotOutreach('none')"    style="padding:4px 12px;font-size:12px;">🔴 לא נשלח</button>
                    <button class="btn btn-secondary" onclick="loadPilotOutreach(window._pilotFilter||'all')" style="padding:4px 10px;font-size:12px;">🔄</button>
                </div>
            </div>
            <div id="pilot-outreach-list" style="display:flex;flex-direction:column;gap:6px;max-height:280px;overflow-y:auto;">
                <div class="loading" style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px;">לוחץ לטעינה...</div>
            </div>
        </div>

        <script>
        window._pilotFilter = 'all';
        async function loadPilotOutreach(filter) {
            window._pilotFilter = filter || 'all';
            // Update active button
            ['all','sent','replied','waiting','none'].forEach(function(f) {
                var btn = document.getElementById('pilot-filter-' + f);
                if (btn) btn.className = f === window._pilotFilter ? 'btn' : 'btn btn-secondary';
                if (btn && f === window._pilotFilter) btn.style.background = 'var(--teal)';
                else if (btn) btn.style.background = '';
            });
            var list = document.getElementById('pilot-outreach-list');
            if (!list) return;
            list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px;">טוען...</div>';
            try {
                var data = await fetch('/api/pilot/contacts').then(function(r){return r.json();});
                var contacts = data.contacts || [];

                // Apply filter
                if (filter === 'sent')    contacts = contacts.filter(function(c){ return c.message_status === 'נשלחה' && !c.last_reply_at; });
                if (filter === 'replied') contacts = contacts.filter(function(c){ return !!c.last_reply_at; });
                if (filter === 'waiting') contacts = contacts.filter(function(c){ return c.message_status === 'נשלחה' && !c.last_reply_at; });
                if (filter === 'none')    contacts = contacts.filter(function(c){ return c.message_status !== 'נשלחה'; });

                if (contacts.length === 0) {
                    list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px;">אין תוצאות לסינון זה</div>';
                    return;
                }

                var html = '';
                contacts.forEach(function(c) {
                    var statusColor = c.last_reply_at ? '#4ade80' : c.message_status === 'נשלחה' ? '#f59e0b' : '#6b7280';
                    var statusLabel = c.last_reply_at ? '✅ ענה' : c.message_status === 'נשלחה' ? '⏳ ממתין' : '🔴 לא נשלח';
                    var sentTime = c.last_message_sent_at ? new Date(c.last_message_sent_at).toLocaleString('he-IL',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : '';
                    var replyText = c.last_reply_text ? ('<div style="font-size:11px;color:#4ade80;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:300px;">↩ ' + c.last_reply_text.substring(0,60) + '</div>') : '';
                    var price = c.asking_price ? '₪' + Number(c.asking_price).toLocaleString('he-IL') : '';
                    html += '<div style="display:flex;align-items:center;gap:12px;padding:8px 10px;background:var(--bg-primary);border:1px solid var(--border-subtle);border-radius:6px;font-size:12px;">' +
                        '<div style="min-width:90px;font-weight:600;color:var(--teal);">' + (c.phone || '') + '</div>' +
                        '<div style="flex:1;min-width:0;">' +
                            '<div style="font-weight:500;">' + (c.complex_name || '') + ' <span style="color:var(--text-muted);">— ' + (c.city || '') + '</span></div>' +
                            '<div style="color:var(--text-muted);font-size:11px;">' + (c.contact_name || 'ללא שם') + (price ? ' · ' + price : '') + (c.rooms ? ' · ' + c.rooms + ' חד׳' : '') + '</div>' +
                            replyText +
                        '</div>' +
                        '<div style="text-align:left;min-width:110px;">' +
                            '<span style="color:' + statusColor + ';font-weight:600;">' + statusLabel + '</span>' +
                            (sentTime ? '<div style="color:var(--text-muted);font-size:11px;margin-top:2px;">' + sentTime + '</div>' : '') +
                        '</div>' +
                        '<div>' +
                            '<a href="https://wa.me/972' + (c.phone||'').replace(/^0/,'') + '" target="_blank" style="color:var(--teal);font-size:11px;text-decoration:none;">📱 פתח</a>' +
                        '</div>' +
                    '</div>';
                });
                list.innerHTML = html;
            } catch(e) {
                list.innerHTML = '<div style="text-align:center;padding:16px;color:var(--red);font-size:12px;">שגיאה בטעינת נתוני פיילוט</div>';
            }
        }
        // Auto-load when messages tab opens
        document.addEventListener('DOMContentLoaded', function() {
            var orig = window.switchTab;
            window.switchTab = function(tab, filter) {
                if (orig) orig.apply(this, arguments);
                if (tab === 'messages') setTimeout(function(){ loadPilotOutreach(window._pilotFilter||'all'); }, 200);
            };
        });
        </script>`;

// ── 1. Serve modified dashboard HTML ─────────────────────────────────────────
router.get('/', (req, res, next) => {
  try {
    let html = fs.readFileSync(DASHBOARD_PATH, 'utf8');

    // a) Inject pilot card into stats grid (after kones card)
    const cardAnchor = 'נכסים בכינוס</div>\n            </div>\n        </div>';
    if (html.includes(cardAnchor) && !html.includes('pilot-stat-card')) {
      html = html.replace(
        cardAnchor,
        'נכסים בכינוס</div>\n            </div>' + PILOT_CARD_HTML + '\n        </div>'
      );
    }

    // b) Inject pilot outreach panel into messages tab (before "שיחות - כל הערוצים")
    const msgAnchor = '<div class="section" style="margin:0;border-radius:0;border-left:none;border-right:none;border-top:none;">\n            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">\n                <h2 style="margin:0;">💬 שיחות - כל הערוצים</h2>';
    if (html.includes(msgAnchor) && !html.includes('pilot-outreach-panel')) {
      html = html.replace(msgAnchor, PILOT_MESSAGES_PANEL + '\n        ' + msgAnchor);
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    next();
  }
});

// ── 2. Augment /api/stats with pilot data ─────────────────────────────────────
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

module.exports = router;
