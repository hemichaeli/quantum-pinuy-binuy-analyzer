/**
 * QUANTUM Campaign Dashboard — v3.0
 * Tabs: קמפיינים | בניית קמפיין | שליחה לקמפיין | WA Bot
 */
const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.send(html);
});

const html = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QUANTUM | קמפיינים</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',system-ui,sans-serif;background:#0a0a0f;color:#e0e0e0;min-height:100vh;direction:rtl}
    .topbar{background:linear-gradient(135deg,#0d1117 0%,#161b27 100%);border-bottom:1px solid #1e3a5f;padding:14px 24px;display:flex;align-items:center;justify-content:space-between}
    .logo{color:#4fc3f7;font-size:20px;font-weight:700;letter-spacing:1px}
    .logo span{color:#fff}
    .nav-links a{color:#90a4ae;text-decoration:none;margin-left:20px;font-size:13px;transition:color .2s}
    .nav-links a:hover,.nav-links a.active{color:#4fc3f7}
    .container{max-width:1300px;margin:0 auto;padding:24px}
    h1{font-size:22px;color:#fff;margin-bottom:4px}
    .subtitle{color:#78909c;font-size:13px;margin-bottom:20px}
    .tabs{display:flex;gap:0;border-bottom:2px solid #1e3a5f;margin-bottom:24px}
    .tab-btn{padding:11px 22px;cursor:pointer;font-size:13px;font-weight:600;color:#78909c;background:transparent;border:none;border-bottom:3px solid transparent;margin-bottom:-2px;transition:all .2s}
    .tab-btn.active{color:#4fc3f7;border-bottom-color:#4fc3f7}
    .tab-btn:hover:not(.active){color:#b0bec5}
    .tab-pane{display:none}
    .tab-pane.active{display:block}
    .stats-row{display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap}
    .stat-card{background:#0d1117;border:1px solid #1e3a5f;border-radius:8px;padding:14px 20px;flex:1;min-width:120px}
    .stat-card .num{font-size:26px;font-weight:700;color:#4fc3f7}
    .stat-card .lbl{font-size:11px;color:#78909c;margin-top:2px}
    .panel{background:#0d1117;border:1px solid #1e3a5f;border-radius:10px;overflow:hidden;margin-bottom:20px}
    .panel-header{padding:14px 18px;border-bottom:1px solid #1e3a5f;display:flex;align-items:center;justify-content:space-between}
    .panel-header h2{font-size:14px;color:#e0e0e0}
    .panel-body{padding:18px}
    .form-group{margin-bottom:14px}
    label{display:block;font-size:12px;color:#90a4ae;margin-bottom:5px}
    input[type=text],input[type=number],textarea,select{width:100%;background:#161b27;border:1px solid #2a4a6b;border-radius:6px;padding:9px 12px;color:#e0e0e0;font-size:13px;direction:rtl;transition:border .2s}
    input:focus,textarea:focus,select:focus{outline:none;border-color:#4fc3f7}
    textarea{resize:vertical;min-height:80px}
    .voice-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-top:8px}
    .voice-card{background:#161b27;border:2px solid #2a4a6b;border-radius:8px;padding:12px;cursor:pointer;text-align:center;transition:all .2s}
    .voice-card:hover{border-color:#4fc3f7}
    .voice-card.selected{border-color:#4fc3f7;background:#0d2035}
    .voice-card .v-icon{font-size:24px;margin-bottom:4px}
    .voice-card .v-name{font-size:13px;font-weight:600;color:#e0e0e0}
    .voice-card .v-desc{font-size:10px;color:#78909c;margin-top:2px}
    .script-editor{background:#0a0f1a;border:1px solid #2a4a6b;border-radius:8px;padding:14px;font-family:monospace;font-size:12px;min-height:160px;color:#a8d8a8;direction:ltr;text-align:left;width:100%;resize:vertical}
    .script-vars{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
    .var-chip{background:#1a3a5c;color:#4fc3f7;border:1px solid #2a5a8f;border-radius:12px;padding:3px 10px;font-size:11px;cursor:pointer;transition:background .2s}
    .var-chip:hover{background:#2a5a8f}
    .mode-toggle{display:flex;gap:0;border:1px solid #2a4a6b;border-radius:8px;overflow:hidden}
    .mode-btn{flex:1;padding:10px 8px;cursor:pointer;font-size:12px;font-weight:600;text-align:center;background:#161b27;color:#78909c;border:none;transition:all .2s}
    .mode-btn.active{background:#1a3a5c;color:#4fc3f7}
    .mode-btn:hover:not(.active){background:#1e2530;color:#b0bec5}
    .btn{display:inline-flex;align-items:center;gap:6px;padding:10px 18px;border-radius:6px;border:none;font-size:13px;font-weight:600;cursor:pointer;transition:all .2s}
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
    .filter-row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px}
    .filter-row .form-group{margin-bottom:0;flex:1;min-width:130px}
    .leads-table{width:100%;border-collapse:collapse;font-size:12px}
    .leads-table th{background:#0d1a2a;color:#90a4ae;padding:8px 10px;text-align:right;border-bottom:1px solid #1e3a5f;font-weight:600}
    .leads-table td{padding:8px 10px;border-bottom:1px solid #11202f;color:#cdd5de}
    .leads-table tr:hover td{background:#0d2035}
    .leads-table .check-col{width:36px;text-align:center}
    input[type=checkbox]{accent-color:#4fc3f7;width:14px;height:14px;cursor:pointer}
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
    .escalation-card{background:linear-gradient(135deg,#0d1117 0%,#0f1e2d 100%);border:1px solid #1e4a3f;border-radius:10px;padding:20px;margin-bottom:24px}
    .escalation-card .card-title{font-size:15px;font-weight:700;color:#4db6ac;margin-bottom:4px;display:flex;align-items:center;gap:8px}
    .escalation-card .card-sub{font-size:12px;color:#546e7a;margin-bottom:18px}
    .escalation-inner{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}
    .escalation-control{flex:1;min-width:260px}
    .esc-stat{background:#0a1520;border:1px solid #1e3a5f;border-radius:8px;padding:10px 16px;text-align:center;min-width:90px}
    .esc-stat .n{font-size:22px;font-weight:700;color:#4db6ac}
    .esc-stat .l{font-size:10px;color:#78909c;margin-top:2px}
    .slider-row{display:flex;align-items:center;gap:12px;margin-bottom:12px}
    .slider-row input[type=range]{flex:1;accent-color:#4db6ac;height:4px;cursor:pointer}
    .slider-val{background:#0a1520;border:1px solid #1e4a3f;border-radius:6px;padding:6px 14px;font-size:16px;font-weight:700;color:#4db6ac;min-width:90px;text-align:center}
    .slider-hint{font-size:11px;color:#546e7a;margin-bottom:14px}
    .esc-actions{display:flex;gap:8px}
    .status-pill{display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:3px 10px;border-radius:10px;font-weight:600}
    .pill-active{background:#1b4a3f;color:#4db6ac;border:1px solid #2d7a6a}
    .pill-disabled{background:#2a2a2a;color:#78909c;border:1px solid #3a3a3a}
    .dot{width:6px;height:6px;border-radius:50%}
    .dot-active{background:#4db6ac;animation:pulse 1.5s infinite}
    .dot-off{background:#546e7a}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
    .grid2{display:grid;grid-template-columns:1fr 1fr;gap:20px}
    .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1b5e20;color:#a5d6a7;border:1px solid #2e7d32;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600;opacity:0;transition:opacity .3s;z-index:999;pointer-events:none}
    .toast.error{background:#3c1414;color:#ef9a9a;border-color:#7f1616}
    .toast.show{opacity:1}
    .loading{text-align:center;padding:30px;color:#546e7a}
    .spinner{display:inline-block;width:20px;height:20px;border:2px solid #1e3a5f;border-top-color:#4fc3f7;border-radius:50%;animation:spin .7s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    .empty-state{text-align:center;padding:40px 20px;color:#546e7a;font-size:13px}
    .tag{display:inline-block;background:#0d2035;color:#4fc3f7;border:1px solid #1e4a6b;border-radius:10px;padding:2px 8px;font-size:10px;margin-left:4px}
    .ssi-bar{display:inline-block;height:6px;border-radius:3px;background:#1565c0;vertical-align:middle;margin-left:4px}
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

  <div class="tabs">
    <button class="tab-btn active" onclick="switchTab('campaigns',this)">📋 קמפיינים</button>
    <button class="tab-btn" onclick="switchTab('builder',this)">🏗️ בניית קמפיין</button>
    <button class="tab-btn" onclick="switchTab('sendleads',this)">📤 שליחה לקמפיין</button>
    <button class="tab-btn" onclick="switchTab('wabot',this)">🤖 WA Bot</button>
  </div>

  <!-- TAB 1: CAMPAIGNS LIST -->
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
        <button class="btn btn-outline btn-sm" onclick="loadCampaigns()">↻ רענן</button>
      </div>
      <div class="panel-body" id="campaignList"><div class="loading"><div class="spinner"></div></div></div>
    </div>
  </div>

  <!-- TAB 2: CAMPAIGN BUILDER -->
  <div class="tab-pane" id="tab-builder">
    <div class="grid2">
      <div>
        <div class="panel">
          <div class="panel-header"><h2>הגדרות בסיסיות</h2></div>
          <div class="panel-body">
            <div class="form-group"><label>שם הקמפיין *</label><input type="text" id="bName" placeholder="למשל: בת ים Q2 2026"></div>
            <div class="form-group">
              <label>מצב פנייה</label>
              <div class="mode-toggle">
                <button class="mode-btn active" id="bModeWa" onclick="setBuildMode('wa_then_call')">💬 WA קודם</button>
                <button class="mode-btn" id="bModeCall" onclick="setBuildMode('call_only')">📞 שיחה ישירה</button>
              </div>
            </div>
            <div class="form-group" id="bWaWaitGroup">
              <label>המתן לפני שיחה (דקות)</label>
              <input type="number" id="bWaWait" value="60" min="5" max="1440">
            </div>
            <div class="form-group"><label>שם הסוכן</label><input type="text" id="bAgent" value="רן"></div>
            <div class="form-group"><label>הערות פנימיות</label><input type="text" id="bNotes" placeholder="אופציונלי"></div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-header"><h2>🎙️ קול הסוכן</h2></div>
          <div class="panel-body">
            <div class="voice-grid">
              <div class="voice-card selected" onclick="selectVoice('oren','male','vapi')" id="v-oren"><div class="v-icon">👨</div><div class="v-name">אורן</div><div class="v-desc">זכר · עברית</div></div>
              <div class="voice-card" onclick="selectVoice('ran','male','vapi')" id="v-ran"><div class="v-icon">👨‍💼</div><div class="v-name">רן</div><div class="v-desc">זכר · ברירת מחדל</div></div>
              <div class="voice-card" onclick="selectVoice('rachel','female','vapi')" id="v-rachel"><div class="v-icon">👩</div><div class="v-name">רחל</div><div class="v-desc">נקבה · עברית</div></div>
              <div class="voice-card" onclick="selectVoice('maya','female','vapi')" id="v-maya"><div class="v-icon">👩‍💼</div><div class="v-name">מאיה</div><div class="v-desc">נקבה · טבעי</div></div>
              <div class="voice-card" onclick="selectVoice('custom','male','elevenlabs')" id="v-custom"><div class="v-icon">⚙️</div><div class="v-name">מותאם</div><div class="v-desc">Voice ID ידני</div></div>
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
            <button class="btn btn-outline btn-sm" onclick="loadDefaultWa()">טען ברירת מחדל</button>
          </div>
          <div class="panel-body">
            <div class="form-group">
              <label>הודעת WA ראשונית</label>
              <textarea id="bWaMessage" rows="5" placeholder="שלום {{name}}!&#10;אני {{agent_name}} מ-QUANTUM..."></textarea>
              <div class="script-vars">
                <span class="var-chip" onclick="insertVar('bWaMessage','{{name}}')">{{name}}</span>
                <span class="var-chip" onclick="insertVar('bWaMessage','{{agent_name}}')">{{agent_name}}</span>
                <span class="var-chip" onclick="insertVar('bWaMessage','{{city}}')">{{city}}</span>
              </div>
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-header">
            <h2>📞 תסריט שיחה</h2>
            <button class="btn btn-outline btn-sm" onclick="loadDefaultScript()">טען ברירת מחדל</button>
          </div>
          <div class="panel-body">
            <p style="font-size:11px;color:#546e7a;margin-bottom:10px">מחליף את ה-system prompt של Vapi לקמפיין זה בלבד.</p>
            <textarea class="script-editor" id="bCallScript" rows="8" placeholder="אתה רן, סוכן נדל&quot;ן של QUANTUM..."></textarea>
            <div class="script-vars">
              <span class="var-chip" onclick="insertVar('bCallScript','{{name}}')">{{name}}</span>
              <span class="var-chip" onclick="insertVar('bCallScript','{{agent_name}}')">{{agent_name}}</span>
              <span class="var-chip" onclick="insertVar('bCallScript','{{city}}')">{{city}}</span>
              <span class="var-chip" onclick="insertVar('bCallScript','{{campaign_name}}')">{{campaign_name}}</span>
            </div>
          </div>
        </div>
        <button class="btn btn-primary btn-full" onclick="createCampaignFromBuilder()">✚ צור קמפיין</button>
      </div>
    </div>

    <!-- Edit panel (opens when clicking edit on campaign) -->
    <div class="panel" id="editCampPanel" style="margin-top:20px;display:none">
      <div class="panel-header">
        <h2 id="editCampTitle">עריכת קמפיין</h2>
        <button class="btn btn-outline btn-sm" onclick="document.getElementById('editCampPanel').style.display='none'">✕ סגור</button>
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
            <div class="form-group"><label>תסריט שיחה (System Prompt)</label><textarea class="script-editor" id="editCallScript" rows="6"></textarea></div>
          </div>
        </div>
        <button class="btn btn-teal" onclick="saveEditCampaign()">💾 שמור שינויים</button>
      </div>
    </div>
  </div>

  <!-- TAB 3: SEND TO CAMPAIGN -->
  <div class="tab-pane" id="tab-sendleads">
    <div class="panel">
      <div class="panel-header"><h2>🔍 בחירת ליידים לשליחה</h2></div>
      <div class="panel-body">
        <div class="filter-row">
          <div class="form-group"><label>עיר</label><select id="fCity"><option value="">כל הערים</option></select></div>
          <div class="form-group">
            <label>סטטוס</label>
            <select id="fStatus">
              <option value="">כל הסטטוסים</option>
              <option value="new">חדש</option>
              <option value="contacted">פנו אליו</option>
              <option value="interested">מעוניין</option>
              <option value="not_interested">לא מעוניין</option>
              <option value="meeting_set">פגישה נקבעה</option>
            </select>
          </div>
          <div class="form-group">
            <label>מקור</label>
            <select id="fSource">
              <option value="">כל המקורות</option>
              <option value="whatsapp_bot">WA Bot</option>
              <option value="facebook">פייסבוק</option>
              <option value="yad2">יד2</option>
              <option value="manual">ידני</option>
            </select>
          </div>
          <div class="form-group"><label>SSI מינימום</label><input type="number" id="fMinSsi" placeholder="0" min="0" max="100" style="width:90px"></div>
          <div><button class="btn btn-outline" style="margin-top:20px" onclick="previewLeads()">🔍 חפש</button></div>
        </div>

        <div id="leadsPreviewArea" style="display:none">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
            <div style="font-size:13px;color:#90a4ae">
              נמצאו <strong id="leadsCount" style="color:#4fc3f7">0</strong> ליידים
              <span id="leadsSelectedCount" style="margin-right:10px;color:#4db6ac"></span>
            </div>
            <label style="font-size:12px;cursor:pointer"><input type="checkbox" id="selectAll" onchange="toggleSelectAll(this.checked)"> בחר הכל</label>
          </div>
          <div style="overflow-x:auto;max-height:340px;overflow-y:auto">
            <table class="leads-table">
              <thead><tr>
                <th class="check-col"></th>
                <th>שם</th><th>טלפון</th><th>עיר</th><th>סטטוס</th><th>SSI</th><th>מקור</th>
              </tr></thead>
              <tbody id="leadsTableBody"></tbody>
            </table>
          </div>
          <hr class="divider">
          <div class="grid2" style="margin-top:14px">
            <div class="form-group">
              <label>בחר קמפיין יעד</label>
              <select id="targetCampaign"><option value="">-- בחר קמפיין --</option></select>
            </div>
            <div class="form-group">
              <label>ערוץ פנייה</label>
              <div class="mode-toggle">
                <button class="mode-btn active" id="sendModeWa" onclick="setSendMode('wa_then_call')">💬 WA קודם</button>
                <button class="mode-btn" id="sendModeCall" onclick="setSendMode('call_only')">📞 שיחה ישירה</button>
              </div>
            </div>
          </div>
          <button class="btn btn-success btn-full" style="margin-top:6px" onclick="sendSelectedLeads()">📤 שלח ליידים נבחרים לקמפיין</button>
        </div>
      </div>
    </div>
  </div>

  <!-- TAB 4: WA BOT -->
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
            <input type="range" id="escSlider" min="0" max="240" step="5" value="60" oninput="onSliderChange(this.value)">
            <div class="slider-val" id="escSliderVal">60 דק'</div>
          </div>
          <div class="slider-hint" id="escSliderHint">אחרי 60 דקות ללא מענה ב-WA — רן מתקשר</div>
          <div class="esc-actions">
            <button class="btn btn-teal btn-sm" onclick="saveEscalation()">💾 שמור</button>
            <button class="btn btn-outline btn-sm" onclick="runEscalationNow()" id="runNowBtn">▶ הרץ עכשיו</button>
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

</div>
<div class="toast" id="toast"></div>
<script>
const API = '/api/campaigns';
let selBuildMode = 'wa_then_call';
let selSendMode  = 'wa_then_call';
let selVoiceName = 'oren', selVoiceGender = 'male', selVoiceProvider = 'vapi';
let allLeads = [], selLeadIds = new Set(), allCampaigns = [];

function switchTab(tab, btn) {
  document.querySelectorAll('.tab-pane').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('tab-'+tab).classList.add('active');
  btn.classList.add('active');
  if(tab==='sendleads'){loadCampaignsForDropdown();loadCitiesForFilter();}
  if(tab==='campaigns') loadCampaigns();
  if(tab==='wabot') loadEscalationSettings();
}
function showToast(msg,type='success'){const t=document.getElementById('toast');t.textContent=msg;t.className='toast '+type+' show';setTimeout(()=>t.classList.remove('show'),3200);}
async function api(url,method='GET',body=null){const o={method,headers:{'Content-Type':'application/json'}};if(body)o.body=JSON.stringify(body);return(await fetch(url,o)).json();}
function statusLabel(s){return{draft:'טיוטה',active:'פעיל',paused:'מושהה',completed:'הסתיים'}[s]||s;}

// TAB 1
async function loadCampaigns(){
  const el=document.getElementById('campaignList');
  el.innerHTML='<div class="loading"><div class="spinner"></div></div>';
  try{
    const data=await api(API);
    allCampaigns=data.campaigns||[];
    let wa=0,calls=0,rep=0,act=0;
    allCampaigns.forEach(c=>{wa+=parseInt(c.wa_sent||0);calls+=parseInt(c.calls_made||0);rep+=parseInt(c.wa_replied||0);if(c.status==='active')act++;});
    document.getElementById('statTotal').textContent=allCampaigns.length;
    document.getElementById('statActive').textContent=act;
    document.getElementById('statWaSent').textContent=wa;
    document.getElementById('statCalls').textContent=calls;
    document.getElementById('statReplied').textContent=rep;
    if(!allCampaigns.length){el.innerHTML='<div class="empty-state"><div style="font-size:36px;margin-bottom:10px">📋</div>צור קמפיין חדש בטאב "בניית קמפיין"</div>';return;}
    el.innerHTML=allCampaigns.map(c=>{
      const ml=c.mode==='wa_then_call'?'💬→📞 '+c.wa_wait_minutes+" דק'"+'':"📞 שיחה ישירה";
      const vl=c.voice_name?' · '+c.voice_name:'';
      return '<div class="campaign-item"><div class="camp-header" onclick="toggleCamp('+c.id+')">'+
        '<div><div class="camp-title">'+c.name+'</div><div class="camp-meta">'+ml+' | '+c.agent_name+vl+'</div></div>'+
        '<span class="status-badge s-'+c.status+'">'+statusLabel(c.status)+'</span></div>'+
        '<div class="camp-body" id="body-'+c.id+'">'+
        '<div class="camp-stats">'+
        '<div class="cs"><div class="n">'+(c.total_leads||0)+'</div><div class="l">ליידים</div></div>'+
        '<div class="cs"><div class="n">'+(c.wa_sent||0)+'</div><div class="l">WA</div></div>'+
        '<div class="cs"><div class="n">'+(c.wa_replied||0)+'</div><div class="l">מענו</div></div>'+
        '<div class="cs"><div class="n">'+(c.calls_made||0)+'</div><div class="l">שיחות</div></div>'+
        '</div><div class="camp-actions">'+
        (c.status==='draft'||c.status==='paused'?'<button class="btn btn-success btn-sm" onclick="launchCampaign('+c.id+',\''+c.name+'\')">▶ הפעל</button>':'')+
        (c.status==='active'?'<button class="btn btn-outline btn-sm" onclick="pauseCampaign('+c.id+')">⏸ השהה</button>':'')+
        '<button class="btn btn-outline btn-sm" onclick="openEditCampaign('+c.id+')">✏️ תסריט</button>'+
        '<button class="btn btn-danger" onclick="deleteCampaign('+c.id+',\''+c.name+'\')">🗑</button>'+
        '</div></div></div>';
    }).join('');
  }catch(e){el.innerHTML='<div class="empty-state">שגיאת טעינה</div>';}
}
function toggleCamp(id){document.getElementById('body-'+id).classList.toggle('open');}
async function launchCampaign(id,name){if(!confirm('להפעיל "'+name+'"?'))return;const d=await api(API+'/'+id+'/launch','POST');if(d.success){showToast(d.message||'הופעל!');loadCampaigns();}else showToast(d.error||'שגיאה','error');}
async function pauseCampaign(id){const d=await api(API+'/'+id+'/pause','POST');if(d.success){showToast('הושהה');loadCampaigns();}else showToast(d.error||'שגיאה','error');}
async function deleteCampaign(id,name){if(!confirm('למחוק "'+name+'"?'))return;const d=await api(API+'/'+id,'DELETE');if(d.success){showToast('נמחק');loadCampaigns();}else showToast(d.error||'שגיאה','error');}

// TAB 2
function setBuildMode(m){selBuildMode=m;document.getElementById('bModeWa').classList.toggle('active',m==='wa_then_call');document.getElementById('bModeCall').classList.toggle('active',m==='call_only');document.getElementById('bWaWaitGroup').style.display=m==='wa_then_call'?'':'none';}
function selectVoice(name,gender,prov){selVoiceName=name;selVoiceGender=gender;selVoiceProvider=prov;document.querySelectorAll('.voice-card').forEach(c=>c.classList.remove('selected'));document.getElementById('v-'+name)?.classList.add('selected');document.getElementById('customVoiceGroup').style.display=name==='custom'?'':'none';}
function insertVar(fid,v){const el=document.getElementById(fid);const p=el.selectionStart;el.value=el.value.slice(0,p)+v+el.value.slice(p);el.focus();el.selectionStart=el.selectionEnd=p+v.length;}
async function loadDefaultWa(){const d=await api(API+'/scripts/preview?name=שם&city=עיר');if(d.scripts?.initial)document.getElementById('bWaMessage').value=d.scripts.initial;}
function loadDefaultScript(){document.getElementById('bCallScript').value='אתה רן, סוכן נדל"ן בכיר של QUANTUM — חברת תיווך בוטיק המתמחה בפינוי-בינוי.\n\nאתה מתקשר אל {{name}} שגר/ת ב-{{city}}.\n\nהמטרה שלך: לקבוע פגישת ייעוץ ראשונית חינמית.\n\nהיה חם, מקצועי, קצר. אל תציע מחירים — רק פגישה.\nאם מתנגדים — הדגש את הגישה לנכסים סודיים ואת הערך הייחודי של QUANTUM.';}
async function createCampaignFromBuilder(){
  const name=document.getElementById('bName').value.trim();
  if(!name){showToast('חסר שם','error');return;}
  const vid=selVoiceName==='custom'?document.getElementById('bVoiceId').value.trim():selVoiceName;
  const d=await api(API,'POST',{name,mode:selBuildMode,wa_wait_minutes:parseInt(document.getElementById('bWaWait').value)||60,agent_name:document.getElementById('bAgent').value||'רן',wa_message:document.getElementById('bWaMessage').value||null,call_script:document.getElementById('bCallScript').value||null,notes:document.getElementById('bNotes').value||null,voice_gender:selVoiceGender,voice_name:vid||null,voice_provider:selVoiceProvider});
  if(d.success){showToast('קמפיין "'+name+'" נוצר!');['bName','bNotes','bWaMessage','bCallScript'].forEach(id=>document.getElementById(id).value='');}
  else showToast(d.error||'שגיאה','error');
}
async function openEditCampaign(id){
  const c=allCampaigns.find(x=>x.id===id);if(!c)return;
  document.getElementById('editCampId').value=id;
  document.getElementById('editCampTitle').textContent='עריכת: '+c.name;
  document.getElementById('editWaMessage').value=c.wa_message||'';
  document.getElementById('editCallScript').value=c.call_script||'';
  document.getElementById('editVoiceName').value=c.voice_name||'oren';
  document.getElementById('editCampPanel').style.display='';
  document.querySelectorAll('.tab-pane').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('tab-builder').classList.add('active');
  document.querySelectorAll('.tab-btn')[1].classList.add('active');
  setTimeout(()=>document.getElementById('editCampPanel').scrollIntoView({behavior:'smooth'}),100);
}
async function saveEditCampaign(){
  const id=document.getElementById('editCampId').value;
  const d=await api(API+'/'+id,'PATCH',{wa_message:document.getElementById('editWaMessage').value||null,call_script:document.getElementById('editCallScript').value||null,voice_name:document.getElementById('editVoiceName').value||null});
  if(d.success){showToast('נשמר!');document.getElementById('editCampPanel').style.display='none';loadCampaigns();}
  else showToast(d.error||'שגיאה','error');
}

// TAB 3
function setSendMode(m){selSendMode=m;document.getElementById('sendModeWa').classList.toggle('active',m==='wa_then_call');document.getElementById('sendModeCall').classList.toggle('active',m==='call_only');}
async function loadCitiesForFilter(){try{const d=await api(API+'/leads/filter-preview?limit=0');const s=document.getElementById('fCity');s.innerHTML='<option value="">כל הערים</option>';(d.cities||[]).forEach(c=>{const o=document.createElement('option');o.value=c;o.textContent=c;s.appendChild(o);});}catch(e){}}
async function loadCampaignsForDropdown(){try{const d=await api(API);const s=document.getElementById('targetCampaign');s.innerHTML='<option value="">-- בחר קמפיין --</option>';(d.campaigns||[]).forEach(c=>{const o=document.createElement('option');o.value=c.id;o.textContent=c.name+' ('+statusLabel(c.status)+')';s.appendChild(o);});}catch(e){}}
async function previewLeads(){
  const p=new URLSearchParams();
  const city=document.getElementById('fCity').value;
  const st=document.getElementById('fStatus').value;
  const src=document.getElementById('fSource').value;
  const ssi=document.getElementById('fMinSsi').value;
  if(city)p.set('city',city);if(st)p.set('status',st);if(src)p.set('source',src);if(ssi)p.set('min_ssi',ssi);p.set('limit','100');
  const area=document.getElementById('leadsPreviewArea');
  const tbody=document.getElementById('leadsTableBody');
  tbody.innerHTML='<tr><td colspan="7" style="text-align:center;padding:20px"><div class="spinner"></div></td></tr>';
  area.style.display='';
  try{
    const d=await api(API+'/leads/filter-preview?'+p.toString());
    allLeads=d.leads||[];selLeadIds=new Set();
    document.getElementById('leadsCount').textContent=d.total_count||allLeads.length;
    document.getElementById('leadsSelectedCount').textContent='';
    document.getElementById('selectAll').checked=false;
    if(!allLeads.length){tbody.innerHTML='<tr><td colspan="7" style="text-align:center;color:#546e7a;padding:20px">לא נמצאו ליידים</td></tr>';return;}
    renderLeadsTable();
  }catch(e){tbody.innerHTML='<tr><td colspan="7" style="color:#ef9a9a;padding:20px">שגיאת טעינה</td></tr>';}
}
function renderLeadsTable(){
  document.getElementById('leadsTableBody').innerHTML=allLeads.map(l=>{
    const ssi=l.ssi_score?'<span class="ssi-bar" style="width:'+Math.min(l.ssi_score,60)+'px"></span>'+l.ssi_score:'-';
    return '<tr><td class="check-col"><input type="checkbox" '+(selLeadIds.has(l.id)?'checked':'')+' onchange="toggleLead('+l.id+',this.checked)"></td>'+
      '<td>'+(l.name||'-')+'</td><td style="direction:ltr">'+(l.phone||'-')+'</td><td>'+(l.city||'-')+'</td>'+
      '<td><span class="tag">'+(l.status||'-')+'</span></td><td>'+ssi+'</td>'+
      '<td style="font-size:10px;color:#546e7a">'+(l.source||'-')+'</td></tr>';
  }).join('');
}
function toggleLead(id,chk){if(chk)selLeadIds.add(id);else selLeadIds.delete(id);updateSelCount();}
function toggleSelectAll(chk){selLeadIds=chk?new Set(allLeads.map(l=>l.id)):new Set();renderLeadsTable();updateSelCount();}
function updateSelCount(){document.getElementById('leadsSelectedCount').textContent=selLeadIds.size>0?'| '+selLeadIds.size+' נבחרו':'';}
async function sendSelectedLeads(){
  const cid=document.getElementById('targetCampaign').value;
  if(!cid){showToast('בחר קמפיין','error');return;}
  if(!selLeadIds.size){showToast('לא נבחרו ליידים','error');return;}
  const leads=allLeads.filter(l=>selLeadIds.has(l.id)).map(l=>({phone:l.phone,name:l.name,source:l.source||'leads_db',lead_id:l.id}));
  const d=await api(API+'/'+cid+'/leads','POST',{leads,mode_override:selSendMode});
  if(d.success){showToast('נוספו '+d.inserted+' ליידים לקמפיין!');selLeadIds=new Set();renderLeadsTable();updateSelCount();}
  else showToast(d.error||'שגיאה','error');
}

// TAB 4
async function loadEscalationSettings(){
  try{const d=await api(API+'/settings');if(!d.success)return;
  const m=parseInt(d.escalation_minutes)||0;
  document.getElementById('escSlider').value=m;onSliderChange(m,false);
  document.getElementById('escStatPending').textContent=d.stats?.pending_escalation??'-';
  document.getElementById('escStatCalled').textContent=d.stats?.escalated_total??'-';
  document.getElementById('escStatTimeout').textContent=m===0?'כבוי':m;
  const pill=document.getElementById('escStatusPill'),dot=document.getElementById('escDot'),txt=document.getElementById('escStatusText');
  if(m===0){pill.className='status-pill pill-disabled';dot.className='dot dot-off';txt.textContent='כבוי';}
  else{pill.className='status-pill pill-active';dot.className='dot dot-active';txt.textContent='פעיל — '+m+" דק'";}
  }catch(e){}
}
function onSliderChange(v,upd=true){v=parseInt(v);document.getElementById('escSliderVal').textContent=v===0?'כבוי':v+" דק'";if(upd)document.getElementById('escSliderHint').textContent=v===0?'הסלמה אוטומטית מבוטלת':'אחרי '+v+' דקות ללא מענה — רן מתקשר';}
async function saveEscalation(){const v=parseInt(document.getElementById('escSlider').value);const d=await api(API+'/settings','PATCH',{wa_bot_escalation_minutes:v});if(d.success){showToast(v===0?'הסלמה בוטלה':'נשמר! הסלמה אחרי '+v+" דקות");loadEscalationSettings();}else showToast(d.error||'שגיאה','error');}
async function runEscalationNow(){const btn=document.getElementById('runNowBtn');btn.disabled=true;btn.textContent='מריץ...';try{const d=await api(API+'/escalation/run','POST');showToast((d.result?.called??0)>0?'הועברו '+d.result.called+' ליידים':'אין ליידים');loadEscalationSettings();}catch(e){showToast('שגיאה','error');}btn.disabled=false;btn.textContent='▶ הרץ עכשיו';}

loadCampaigns();
setInterval(loadCampaigns,30000);
</script>
</body>
</html>`;

module.exports = router;
