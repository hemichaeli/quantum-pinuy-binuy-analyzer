/**
 * QUANTUM Campaign Dashboard — v3.1
 * fix: tab buttons use data-tab, no onclick(this) bug
 */
const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.type('html').send(getHtml());
});

function getHtml() {
return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QUANTUM | קמפיינים</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#0a0a0f;color:#e0e0e0;min-height:100vh;direction:rtl}
.topbar{background:linear-gradient(135deg,#0d1117,#161b27);border-bottom:1px solid #1e3a5f;padding:14px 24px;display:flex;align-items:center;justify-content:space-between}
.logo{color:#4fc3f7;font-size:20px;font-weight:700;letter-spacing:1px}
.logo span{color:#fff}
.nav-links a{color:#90a4ae;text-decoration:none;margin-left:20px;font-size:13px}
.nav-links a:hover,.nav-links a.active{color:#4fc3f7}
.container{max-width:1300px;margin:0 auto;padding:24px}
h1{font-size:22px;color:#fff;margin-bottom:4px}
.subtitle{color:#78909c;font-size:13px;margin-bottom:20px}

/* ── Tabs ── */
.tabs{display:flex;border-bottom:2px solid #1e3a5f;margin-bottom:24px}
.tab-btn{
  padding:11px 22px;cursor:pointer;font-size:13px;font-weight:600;
  color:#78909c;background:transparent;border:none;
  border-bottom:3px solid transparent;margin-bottom:-2px;
  transition:color .2s,border-color .2s;
  position:relative;z-index:1;
}
.tab-btn:hover{color:#b0bec5}
.tab-btn.active{color:#4fc3f7;border-bottom-color:#4fc3f7}
.tab-pane{display:none}
.tab-pane.active{display:block}

/* ── Stats ── */
.stats-row{display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap}
.stat-card{background:#0d1117;border:1px solid #1e3a5f;border-radius:8px;padding:14px 20px;flex:1;min-width:120px}
.stat-card .num{font-size:26px;font-weight:700;color:#4fc3f7}
.stat-card .lbl{font-size:11px;color:#78909c;margin-top:2px}

/* ── Panel ── */
.panel{background:#0d1117;border:1px solid #1e3a5f;border-radius:10px;overflow:hidden;margin-bottom:20px}
.panel-header{padding:14px 18px;border-bottom:1px solid #1e3a5f;display:flex;align-items:center;justify-content:space-between}
.panel-header h2{font-size:14px;color:#e0e0e0}
.panel-body{padding:18px}

/* ── Forms ── */
.form-group{margin-bottom:14px}
label{display:block;font-size:12px;color:#90a4ae;margin-bottom:5px}
input[type=text],input[type=number],textarea,select{
  width:100%;background:#161b27;border:1px solid #2a4a6b;border-radius:6px;
  padding:9px 12px;color:#e0e0e0;font-size:13px;direction:rtl;transition:border .2s
}
input:focus,textarea:focus,select:focus{outline:none;border-color:#4fc3f7}
textarea{resize:vertical;min-height:80px}

/* ── Voice picker ── */
.voice-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-top:8px}
.voice-card{background:#161b27;border:2px solid #2a4a6b;border-radius:8px;padding:12px;cursor:pointer;text-align:center;transition:all .2s;user-select:none}
.voice-card:hover{border-color:#4fc3f7;background:#0d1a2a}
.voice-card.selected{border-color:#4fc3f7;background:#0d2035}
.voice-card .v-icon{font-size:24px;margin-bottom:4px}
.voice-card .v-name{font-size:13px;font-weight:600;color:#e0e0e0}
.voice-card .v-desc{font-size:10px;color:#78909c;margin-top:2px}

/* ── Script editor ── */
.script-editor{background:#0a0f1a;border:1px solid #2a4a6b;border-radius:8px;padding:14px;font-family:monospace;font-size:12px;color:#a8d8a8;direction:ltr;text-align:left;width:100%;resize:vertical;min-height:160px}
.script-vars{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.var-chip{background:#1a3a5c;color:#4fc3f7;border:1px solid #2a5a8f;border-radius:12px;padding:3px 10px;font-size:11px;cursor:pointer;transition:background .2s;user-select:none}
.var-chip:hover{background:#2a5a8f}

/* ── Mode toggle ── */
.mode-toggle{display:flex;border:1px solid #2a4a6b;border-radius:8px;overflow:hidden}
.mode-btn{flex:1;padding:10px 8px;cursor:pointer;font-size:12px;font-weight:600;text-align:center;background:#161b27;color:#78909c;border:none;transition:all .2s;user-select:none}
.mode-btn.active{background:#1a3a5c;color:#4fc3f7}
.mode-btn:hover:not(.active){background:#1e2530;color:#b0bec5}

/* ── Buttons ── */
.btn{display:inline-flex;align-items:center;gap:6px;padding:10px 18px;border-radius:6px;border:none;font-size:13px;font-weight:600;cursor:pointer;transition:all .2s;user-select:none}
.btn-primary{background:#1565c0;color:#fff}
.btn-primary:hover{background:#1976d2}
.btn-teal{background:#1b4a3f;color:#4db6ac;border:1px solid #2d7a6a}
.btn-teal:hover{background:#2d7a6a;color:#e0f7f4}
.btn-success{background:#1b5e20;color:#a5d6a7;border:1px solid #2e7d32}
.btn-success:hover{background:#2e7d32}
.btn-danger{background:#3c1414;color:#ef9a9a;border:1px solid #7f1616;font-size:11px;padding:6px 10px}
.btn-danger:hover{background:#7f1616}
.btn-outline{background:transparent;border:1px solid #2a4a6b;color:#90a4ae}
.btn-outline:hover{border-color:#4fc3f7;color:#4fc3f7}
.btn-sm{padding:6px 12px;font-size:12px}
.btn-full{width:100%;justify-content:center}

/* ── Filter row ── */
.filter-row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px}
.filter-row .form-group{margin-bottom:0;flex:1;min-width:130px}

/* ── Leads table ── */
.leads-table{width:100%;border-collapse:collapse;font-size:12px}
.leads-table th{background:#0d1a2a;color:#90a4ae;padding:8px 10px;text-align:right;border-bottom:1px solid #1e3a5f;font-weight:600}
.leads-table td{padding:8px 10px;border-bottom:1px solid #11202f;color:#cdd5de}
.leads-table tr:hover td{background:#0d2035}
.check-col{width:36px;text-align:center}
input[type=checkbox]{accent-color:#4fc3f7;width:14px;height:14px;cursor:pointer}

/* ── Campaign list ── */
.campaign-item{border:1px solid #1e3a5f;border-radius:8px;margin-bottom:10px;overflow:hidden}
.campaign-item:hover{border-color:#2a5a8f}
.camp-header{padding:12px 14px;cursor:pointer;display:flex;align-items:center;justify-content:space-between}
.camp-title{font-size:14px;font-weight:600;color:#e0e0e0}
.camp-meta{font-size:11px;color:#78909c;margin-top:2px}
.camp-body{padding:14px;border-top:1px solid #1e3a5f;display:none}
.camp-body.open{display:block}
.camp-stats{display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.cs{background:#161b27;border-radius:6px;padding:8px 12px;text-align:center;flex:1;min-width:70px}
.cs .n{font-size:18px;font-weight:700;color:#4fc3f7}
.cs .l{font-size:10px;color:#78909c}
.camp-actions{display:flex;gap:8px;flex-wrap:wrap}
.status-badge{font-size:10px;padding:3px 8px;border-radius:10px;font-weight:600}
.s-draft{background:#263238;color:#90a4ae}
.s-active{background:#1b5e20;color:#a5d6a7}
.s-paused{background:#3e2723;color:#ffab91}
.s-completed{background:#1a237e;color:#9fa8da}

/* ── WA Bot ── */
.escalation-card{background:linear-gradient(135deg,#0d1117,#0f1e2d);border:1px solid #1e4a3f;border-radius:10px;padding:20px;margin-bottom:24px}
.card-title{font-size:15px;font-weight:700;color:#4db6ac;margin-bottom:4px;display:flex;align-items:center;gap:8px}
.card-sub{font-size:12px;color:#546e7a;margin-bottom:18px}
.escalation-inner{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}
.escalation-control{flex:1;min-width:260px}
.esc-stat{background:#0a1520;border:1px solid #1e3a5f;border-radius:8px;padding:10px 16px;text-align:center;min-width:90px}
.esc-stat .n{font-size:22px;font-weight:700;color:#4db6ac}
.esc-stat .l{font-size:10px;color:#78909c;margin-top:2px}
.slider-row{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.slider-row input[type=range]{flex:1;accent-color:#4db6ac;cursor:pointer}
.slider-val{background:#0a1520;border:1px solid #1e4a3f;border-radius:6px;padding:6px 14px;font-size:16px;font-weight:700;color:#4db6ac;min-width:90px;text-align:center}
.slider-hint{font-size:11px;color:#546e7a;margin-bottom:14px}
.esc-actions{display:flex;gap:8px}
.status-pill{display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:3px 10px;border-radius:10px;font-weight:600}
.pill-active{background:#1b4a3f;color:#4db6ac;border:1px solid #2d7a6a}
.pill-disabled{background:#2a2a2a;color:#78909c;border:1px solid #3a3a3a}
.dot{width:6px;height:6px;border-radius:50%}
.dot-active{background:#4db6ac;animation:pulse 1.5s infinite}
.dot-off{background:#546e7a}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}

/* ── Misc ── */
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1b5e20;color:#a5d6a7;border:1px solid #2e7d32;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600;opacity:0;transition:opacity .3s;z-index:9999;pointer-events:none}
.toast.error{background:#3c1414;color:#ef9a9a;border-color:#7f1616}
.toast.show{opacity:1}
.loading{text-align:center;padding:30px;color:#546e7a}
.spinner{display:inline-block;width:20px;height:20px;border:2px solid #1e3a5f;border-top-color:#4fc3f7;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.empty-state{text-align:center;padding:40px 20px;color:#546e7a;font-size:13px}
.tag{display:inline-block;background:#0d2035;color:#4fc3f7;border:1px solid #1e4a6b;border-radius:10px;padding:2px 8px;font-size:10px}
hr.divider{border:none;border-top:1px solid #1e3a5f;margin:16px 0}
@media(max-width:768px){.grid2{grid-template-columns:1fr}.filter-row{flex-direction:column}}
</style>
</head>
<body>

<div class="topbar">
  <div class="logo">QUANTUM <span>|</span> קמפיינים</div>
  <nav class="nav-links">
    <a href="/dashboard">דשבורד</a>
    <a href="/campaigns" class="active">קמפיינים</a>
  </nav>
</div>

<div class="container">
  <h1>מרכז הקמפיינים</h1>
  <p class="subtitle">ניהול מלא — WA, שיחות, תסריטים, קולות, שליחה לקמפיין</p>

  <div class="tabs" id="tabBar">
    <button class="tab-btn active" data-tab="campaigns">📋 קמפיינים</button>
    <button class="tab-btn" data-tab="builder">🏗️ בניית קמפיין</button>
    <button class="tab-btn" data-tab="wabot">🤖 WA Bot</button>
  </div>

  <!-- TAB 1 -->
  <div class="tab-pane active" id="tab-campaigns">
    <div class="stats-row">
      <div class="stat-card"><div class="num" id="statTotal">-</div><div class="lbl">קמפיינים</div></div>
      <div class="stat-card"><div class="num" id="statActive">-</div><div class="lbl">פעילים</div></div>
      <div class="stat-card"><div class="num" id="statWaSent">-</div><div class="lbl">WA נשלחו</div></div>
      <div class="stat-card"><div class="num" id="statCalls">-</div><div class="lbl">שיחות</div></div>
      <div class="stat-card"><div class="num" id="statReplied">-</div><div class="lbl">מענו</div></div>
    </div>
    <div class="panel">
      <div class="panel-header">
        <h2>כל הקמפיינים</h2>
        <button class="btn btn-outline btn-sm" id="btnRefresh">↻ רענן</button>
      </div>
      <div class="panel-body" id="campaignList"><div class="loading"><div class="spinner"></div></div></div>
    </div>
  </div>

  <!-- TAB 2 -->
  <div class="tab-pane" id="tab-builder">
    <div class="grid2">
      <div>
        <div class="panel">
          <div class="panel-header"><h2>הגדרות בסיסיות</h2></div>
          <div class="panel-body">
            <div class="form-group">
              <label>שם הקמפיין *</label>
              <input type="text" id="bName" placeholder="למשל: בת ים Q2 2026">
            </div>
            <div class="form-group">
              <label>מצב פנייה</label>
              <div class="mode-toggle">
                <button class="mode-btn active" id="bModeWa" data-mode="wa_then_call">💬 WA קודם</button>
                <button class="mode-btn" id="bModeCall" data-mode="call_only">📞 שיחה ישירה</button>
              </div>
            </div>
            <div class="form-group" id="bWaWaitGroup">
              <label>המתן לפני שיחה (דקות)</label>
              <input type="number" id="bWaWait" value="60" min="5" max="1440">
            </div>
            <div class="form-group">
              <label>שם הסוכן</label>
              <input type="text" id="bAgent" value="רן">
            </div>
            <div class="form-group">
              <label>הערות פנימיות</label>
              <input type="text" id="bNotes" placeholder="אופציונלי">
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-header"><h2>🎙️ קול הסוכן</h2></div>
          <div class="panel-body">
            <div class="voice-grid" id="voiceGrid">
              <div class="voice-card selected" data-voice="oren" data-gender="male" data-provider="vapi">
                <div class="v-icon">👨</div><div class="v-name">אורן</div><div class="v-desc">זכר · עברית</div>
              </div>
              <div class="voice-card" data-voice="ran" data-gender="male" data-provider="vapi">
                <div class="v-icon">👨‍💼</div><div class="v-name">רן</div><div class="v-desc">זכר · ברירת מחדל</div>
              </div>
              <div class="voice-card" data-voice="rachel" data-gender="female" data-provider="vapi">
                <div class="v-icon">👩</div><div class="v-name">רחל</div><div class="v-desc">נקבה · עברית</div>
              </div>
              <div class="voice-card" data-voice="maya" data-gender="female" data-provider="vapi">
                <div class="v-icon">👩‍💼</div><div class="v-name">מאיה</div><div class="v-desc">נקבה · טבעי</div>
              </div>
              <div class="voice-card" data-voice="custom" data-gender="male" data-provider="elevenlabs">
                <div class="v-icon">⚙️</div><div class="v-name">מותאם</div><div class="v-desc">Voice ID ידני</div>
              </div>
            </div>
            <div class="form-group" id="customVoiceGroup" style="display:none;margin-top:12px">
              <label>Voice ID מותאם</label>
              <input type="text" id="bVoiceId" placeholder="ElevenLabs/Vapi voice ID">
            </div>
          </div>
        </div>
      </div>

      <div>
        <div class="panel">
          <div class="panel-header">
            <h2>💬 תסריט WA</h2>
            <button class="btn btn-outline btn-sm" id="btnDefaultWa">טען ברירת מחדל</button>
          </div>
          <div class="panel-body">
            <div class="form-group">
              <label>הודעת WA ראשונית</label>
              <textarea id="bWaMessage" rows="5" placeholder="שלום {{name}}!&#10;אני {{agent_name}} מ-QUANTUM..."></textarea>
              <div class="script-vars">
                <span class="var-chip" data-field="bWaMessage" data-var="{{name}}">{{name}}</span>
                <span class="var-chip" data-field="bWaMessage" data-var="{{agent_name}}">{{agent_name}}</span>
                <span class="var-chip" data-field="bWaMessage" data-var="{{city}}">{{city}}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-header">
            <h2>📞 תסריט שיחה</h2>
            <button class="btn btn-outline btn-sm" id="btnDefaultScript">טען ברירת מחדל</button>
          </div>
          <div class="panel-body">
            <p style="font-size:11px;color:#546e7a;margin-bottom:10px">מחליף את ה-system prompt של Vapi לקמפיין זה בלבד.</p>
            <textarea class="script-editor" id="bCallScript" rows="8" placeholder="אתה רן, סוכן נדל&quot;ן של QUANTUM..."></textarea>
            <div class="script-vars">
              <span class="var-chip" data-field="bCallScript" data-var="{{name}}">{{name}}</span>
              <span class="var-chip" data-field="bCallScript" data-var="{{agent_name}}">{{agent_name}}</span>
              <span class="var-chip" data-field="bCallScript" data-var="{{city}}">{{city}}</span>
              <span class="var-chip" data-field="bCallScript" data-var="{{campaign_name}}">{{campaign_name}}</span>
            </div>
          </div>
        </div>

        <button class="btn btn-primary btn-full" id="btnCreateCampaign">✚ צור קמפיין</button>
      </div>
    </div>

    <div class="panel" id="editCampPanel" style="margin-top:20px;display:none">
      <div class="panel-header">
        <h2 id="editCampTitle">עריכת קמפיין</h2>
        <button class="btn btn-outline btn-sm" id="btnCloseEdit">✕ סגור</button>
      </div>
      <div class="panel-body">
        <input type="hidden" id="editCampId">
        <div class="grid2">
          <div>
            <div class="form-group"><label>תסריט WA</label><textarea id="editWaMessage" rows="4"></textarea></div>
            <div class="form-group">
              <label>קול</label>
              <select id="editVoiceName">
                <option value="oren">אורן (זכר)</option>
                <option value="ran">רן (זכר)</option>
                <option value="rachel">רחל (נקבה)</option>
                <option value="maya">מאיה (נקבה)</option>
              </select>
            </div>
          </div>
          <div>
            <div class="form-group"><label>תסריט שיחה</label><textarea class="script-editor" id="editCallScript" rows="6"></textarea></div>
          </div>
        </div>
        <button class="btn btn-teal" id="btnSaveEdit">💾 שמור שינויים</button>
      </div>
    </div>
  </div>

  <!-- TAB 4 -->
  <div class="tab-pane" id="tab-wabot">
    <div class="escalation-card">
      <div class="card-title">
        🤖 WA Bot — הסלמה אוטומטית לשיחה
        <span class="status-pill pill-disabled" id="escStatusPill">
          <span class="dot dot-off" id="escDot"></span>
          <span id="escStatusText">טוען...</span>
        </span>
      </div>
      <div class="card-sub">כשלקוח כותב ל-WA Bot ורן לא מקבל מענה — רן מתקשר אוטומטית אחרי X דקות</div>
      <div class="escalation-inner">
        <div class="escalation-control">
          <label style="font-size:12px;color:#90a4ae;margin-bottom:8px;display:block">זמן המתנה לפני שיחה (0 = כבוי)</label>
          <div class="slider-row">
            <input type="range" id="escSlider" min="0" max="240" step="5" value="60">
            <div class="slider-val" id="escSliderVal">60 דק'</div>
          </div>
          <div class="slider-hint" id="escSliderHint">אחרי 60 דקות ללא מענה — רן מתקשר</div>
          <div class="esc-actions">
            <button class="btn btn-teal btn-sm" id="btnSaveEsc">💾 שמור</button>
            <button class="btn btn-outline btn-sm" id="btnRunEsc">▶ הרץ עכשיו</button>
          </div>
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <div class="esc-stat"><div class="n" id="escStatPending">-</div><div class="l">ממתינים</div></div>
          <div class="esc-stat"><div class="n" id="escStatCalled">-</div><div class="l">הועברו לשיחה</div></div>
          <div class="esc-stat"><div class="n" id="escStatTimeout">-</div><div class="l">דקות המתנה</div></div>
        </div>
      </div>
    </div>
  </div>

</div><!-- /container -->
<div class="toast" id="toast"></div>

<script>
(function() {
  'use strict';

  const API = '/api/campaigns';
  let selBuildMode = 'wa_then_call';
  // ── WA Bot Escalation ──────────────────────────────────────────────────
  document.getElementById('escSlider').addEventListener('input', function() {
    updateSliderDisplay(parseInt(this.value));
  });

  function updateSliderDisplay(v) {
    document.getElementById('escSliderVal').textContent  = v === 0 ? 'כבוי' : v + ' דק\\u0027';
    document.getElementById('escSliderHint').textContent = v === 0
      ? 'הסלמה אוטומטית מבוטלת'
      : 'אחרי ' + v + ' דקות ללא מענה ב-WA — רן מתקשר';
  }

  document.getElementById('btnSaveEsc').addEventListener('click', function() {
    var v = parseInt(document.getElementById('escSlider').value);
    apiFetch(API + '/settings', 'PATCH', { wa_bot_escalation_minutes: v }).then(function(d) {
      if (d.success) { toast(v === 0 ? 'הסלמה בוטלה' : 'נשמר! הסלמה אחרי ' + v + ' דקות'); loadEscSettings(); }
      else toast(d.error || 'שגיאה', 'error');
    });
  });

  document.getElementById('btnRunEsc').addEventListener('click', function() {
    var btn = this;
    btn.disabled = true; btn.textContent = 'מריץ...';
    apiFetch(API + '/escalation/run', 'POST').then(function(d) {
      var n = (d.result && d.result.called) || 0;
      toast(n > 0 ? 'הועברו ' + n + ' ליידים לשיחה' : 'אין ליידים להסלמה כרגע');
      loadEscSettings();
      btn.disabled = false; btn.textContent = '▶ הרץ עכשיו';
    }).catch(function() {
      toast('שגיאת רשת', 'error');
      btn.disabled = false; btn.textContent = '▶ הרץ עכשיו';
    });
  });

  function loadEscSettings() {
    apiFetch(API + '/settings').then(function(d) {
      if (!d.success) return;
      var m = parseInt(d.escalation_minutes) || 0;
      document.getElementById('escSlider').value = m;
      updateSliderDisplay(m);
      document.getElementById('escStatPending').textContent = (d.stats && d.stats.pending_escalation != null) ? d.stats.pending_escalation : '-';
      document.getElementById('escStatCalled').textContent  = (d.stats && d.stats.escalated_total  != null) ? d.stats.escalated_total  : '-';
      document.getElementById('escStatTimeout').textContent = m === 0 ? 'כבוי' : m;
      var pill = document.getElementById('escStatusPill');
      var dot  = document.getElementById('escDot');
      var txt  = document.getElementById('escStatusText');
      if (m === 0) {
        pill.className = 'status-pill pill-disabled';
        dot.className  = 'dot dot-off';
        txt.textContent = 'כבוי';
      } else {
        pill.className = 'status-pill pill-active';
        dot.className  = 'dot dot-active';
        txt.textContent = 'פעיל — ' + m + ' דק\\u0027';
      }
    }).catch(function() {});
  }

  // ── Utility ────────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Init ───────────────────────────────────────────────────────────────
  loadCampaigns();
  setInterval(loadCampaigns, 30000);

})();
</script>
</body>
</html>`;
}

module.exports = router;
