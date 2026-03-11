/**
 * QUANTUM Event Admin UI — v1.2
 * Served at: GET /events/admin
 * Auth: custom HTML login form (no WWW-Authenticate header — avoids Chrome ERR_TOO_MANY_RETRIES)
 */

const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const { logger } = require('../services/logger');

const EXPECTED_AUTH = process.env.EVENT_BASIC_AUTH || 'Basic UVVBTlRVTTpkZDRhN2U5YS0xOWYyLTQzYjktOTM2Yy01YmQ0OTRlZWRjNWM=';

// ── JSON auth check (for fetch() calls from browser) ──────────────────────────
function apiAuth(req, res, next) {
  if ((req.headers['authorization'] || '') === EXPECTED_AUTH) return next();
  return res.status(401).json({ success: false, error: 'Unauthorized' });
}

// ── Add attendee manually ─────────────────────────────────────────────────────
router.post('/:id/attendees', apiAuth, async (req, res) => {
  try {
    const { station_id, name, phone, unit_number, floor, building_name, compound_name } = req.body;
    if (!station_id || !name) return res.status(400).json({ success: false, error: 'station_id and name required' });
    const { rows: st } = await pool.query('SELECT id FROM event_stations WHERE id=$1 AND event_id=$2', [station_id, req.params.id]);
    if (!st.length) return res.status(404).json({ success: false, error: 'Station not found' });
    const { rows } = await pool.query(
      `INSERT INTO event_attendees (station_id,name,phone,unit_number,floor,building_name,compound_name) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [station_id, name, phone, unit_number, floor, building_name, compound_name]
    );
    res.json({ success: true, attendee: rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Admin UI — NO server-side auth; login handled in JS via sessionStorage ────
router.get('/admin', (req, res) => {
  const BASE = 'https://pinuy-binuy-analyzer-production.up.railway.app';

  res.type('html').send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QUANTUM | ניהול כנסים</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=Heebo:wght@300;400;500;700;900&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#07090f;--bg1:#0c0f1a;--bg2:#111827;--bg3:#1a2435;
  --border:#1e3a5f;--border2:#2a4a6b;
  --text:#e2e8f0;--text2:#94a3b8;--text3:#475569;
  --blue:#3b82f6;--blue-dark:#1d4ed8;--blue-glow:rgba(59,130,246,.2);
  --green:#10b981;--green-dark:#064e3b;
  --red:#ef4444;--red-dark:#7f1d1d;
  --amber:#f59e0b;--amber-dark:#78350f;
  --cyan:#06b6d4;
  --mono:'IBM Plex Mono',monospace;
  --sans:'Heebo',sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--sans);background:var(--bg);color:var(--text);direction:rtl;min-height:100vh}

/* Login screen */
.login-screen{display:none;position:fixed;inset:0;background:var(--bg);z-index:9999;align-items:center;justify-content:center}
.login-screen.show{display:flex}
.login-card{background:var(--bg1);border:1px solid var(--border2);border-radius:14px;padding:32px 28px;width:92%;max-width:360px;text-align:center}
.login-logo{font-family:var(--mono);font-size:20px;font-weight:700;color:var(--cyan);letter-spacing:3px;margin-bottom:6px}
.login-sub{font-size:11px;color:var(--text3);margin-bottom:24px}
.login-field{display:flex;flex-direction:column;gap:5px;margin-bottom:14px;text-align:right}
.login-field label{font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.7px}
.login-field input{background:var(--bg2);border:1px solid var(--border2);border-radius:7px;padding:10px 12px;color:var(--text);font-size:13px;font-family:var(--sans);width:100%}
.login-field input:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px var(--blue-glow)}
.login-btn{width:100%;padding:11px;background:var(--blue);color:#fff;border:none;border-radius:7px;font-size:14px;font-weight:700;font-family:var(--sans);cursor:pointer;margin-top:4px}
.login-btn:hover{background:var(--blue-dark)}
.login-err{color:#f87171;font-size:12px;margin-top:10px;min-height:18px}

/* App layout */
.shell{display:grid;grid-template-rows:52px 1fr;height:100vh;overflow:hidden}
.topbar{background:var(--bg1);border-bottom:1px solid var(--border);padding:0 22px;display:flex;align-items:center;justify-content:space-between}
.logo{font-family:var(--mono);font-size:14px;font-weight:600;color:var(--cyan);letter-spacing:2px}
.logo span{color:var(--text3);font-size:10px;margin-right:8px;font-weight:400;letter-spacing:0}
.main{display:grid;grid-template-columns:290px 1fr;overflow:hidden}
.sidebar{background:var(--bg1);border-left:1px solid var(--border);overflow-y:auto;display:flex;flex-direction:column}
.content{overflow-y:auto}
.sidebar-hd{padding:13px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.sidebar-label{font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:1.5px}
.ev-item{padding:12px 16px;border-bottom:1px solid rgba(30,58,95,.35);cursor:pointer;transition:background .12s}
.ev-item:hover{background:var(--bg2)}
.ev-item.active{background:var(--bg3);border-right:2px solid var(--blue)}
.ev-title{font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:2px}
.ev-meta{font-size:10px;color:var(--text3);font-family:var(--mono)}
.ev-pills{display:flex;gap:3px;margin-top:5px;flex-wrap:wrap}
.pill{display:inline-block;padding:1px 7px;border-radius:9px;font-size:9px;font-weight:700;letter-spacing:.3px}
.pg{background:rgba(71,85,105,.2);color:#94a3b8;border:1px solid rgba(71,85,105,.3)}
.pb{background:rgba(59,130,246,.15);color:#60a5fa;border:1px solid rgba(59,130,246,.25)}
.pgr{background:rgba(16,185,129,.12);color:#34d399;border:1px solid rgba(16,185,129,.25)}
.pr{background:rgba(239,68,68,.12);color:#f87171;border:1px solid rgba(239,68,68,.25)}
.pa{background:rgba(245,158,11,.12);color:#fbbf24;border:1px solid rgba(245,158,11,.25)}
.empty{padding:24px 16px;text-align:center;color:var(--text3);font-size:12px;line-height:1.6}
.panel{padding:22px;max-width:940px}
.ph{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:16px;gap:12px;flex-wrap:wrap}
.pt{font-size:17px;font-weight:700;color:var(--text)}
.pm{font-size:11px;color:var(--text3);font-family:var(--mono);margin-top:3px}
.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:18px}
.sc{background:var(--bg1);border:1px solid var(--border);border-radius:8px;padding:12px;text-align:center}
.sn{font-size:24px;font-weight:900;font-family:var(--mono);color:var(--cyan)}
.sl{font-size:9px;color:var(--text3);margin-top:2px;text-transform:uppercase;letter-spacing:.8px}
.card{background:var(--bg1);border:1px solid var(--border);border-radius:9px;margin-bottom:14px}
.ch{padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:8px}
.ct{font-size:12px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ca{display:flex;gap:6px;flex-wrap:wrap}
.cb{padding:16px}
.btn{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;font-family:var(--sans);transition:all .12s;text-decoration:none;white-space:nowrap}
.btn:disabled{opacity:.4;cursor:default}
.bp{background:var(--blue);color:#fff}.bp:hover:not(:disabled){background:var(--blue-dark)}
.bg{background:transparent;color:var(--text2);border:1px solid var(--border2)}.bg:hover:not(:disabled){background:var(--bg3)}
.bs{background:var(--green-dark);color:#a7f3d0;border:1px solid var(--green)}.bs:hover:not(:disabled){background:#047857}
.ba{background:var(--amber-dark);color:#fde68a;border:1px solid var(--amber)}.ba:hover:not(:disabled){background:#92400e}
.bsm{padding:5px 10px;font-size:11px;border-radius:5px}
.fg{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.fi{display:flex;flex-direction:column;gap:4px}
.fi.s2{grid-column:span 2}
label{font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.7px}
input,select,textarea{background:var(--bg2);border:1px solid var(--border2);border-radius:6px;padding:8px 10px;color:var(--text);font-size:12px;font-family:var(--sans);width:100%;transition:border-color .15s}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px var(--blue-glow)}
select option{background:var(--bg2)}
table{width:100%;border-collapse:collapse;font-size:11px}
th{background:var(--bg2);color:var(--text3);padding:8px 10px;text-align:right;border-bottom:1px solid var(--border);font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap}
td{padding:8px 10px;border-bottom:1px solid rgba(30,58,95,.25);vertical-align:middle}
tr:last-child td{border:none}
tr:hover td{background:rgba(30,58,95,.12)}
.mono{font-family:var(--mono);font-size:10px}
.lb{display:flex;gap:7px;align-items:center;background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:7px 10px;margin-bottom:12px}
.lb code{font-family:var(--mono);font-size:10px;color:var(--cyan);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sh{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.slabel{font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:1.5px}
.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:500;align-items:center;justify-content:center}
.overlay.open{display:flex}
.modal{background:var(--bg1);border:1px solid var(--border2);border-radius:11px;padding:22px;width:92%;max-width:490px;max-height:90vh;overflow-y:auto}
.mt{font-size:14px;font-weight:700;color:var(--text);margin-bottom:14px;display:flex;align-items:center;gap:7px}
.ma{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
.toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);padding:9px 18px;border-radius:7px;font-size:12px;font-weight:600;opacity:0;transition:opacity .3s;z-index:9999;pointer-events:none;min-width:200px;text-align:center}
.toast.show{opacity:1}
.tok{background:#064e3b;color:#a7f3d0;border:1px solid var(--green)}
.terr{background:var(--red-dark);color:#fca5a5;border:1px solid var(--red)}
.welcome{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:12px;padding:40px;text-align:center}
.wi{font-size:44px;opacity:.25}
.wt{font-size:16px;font-weight:700;color:var(--text2)}
.ws{font-size:12px;color:var(--text3);max-width:290px;line-height:1.6}
</style>
</head>
<body>

<!-- Login Screen -->
<div class="login-screen" id="loginScreen">
  <div class="login-card">
    <div class="login-logo">QUANTUM</div>
    <div class="login-sub">ניהול כנסים ואירועים</div>
    <div class="login-field"><label>שם משתמש</label><input id="lu" value="QUANTUM" autocomplete="username"></div>
    <div class="login-field"><label>סיסמה</label><input id="lp" type="password" autocomplete="current-password" onkeydown="if(event.key==='Enter')doLogin()"></div>
    <button class="login-btn" onclick="doLogin()">כניסה ←</button>
    <div class="login-err" id="loginErr"></div>
  </div>
</div>

<!-- App Shell -->
<div class="shell" id="appShell" style="display:none">
<div class="topbar">
  <div class="logo">QUANTUM <span>| ניהול כנסים</span></div>
  <div style="display:flex;gap:7px;align-items:center">
    <button class="btn bp bsm" onclick="openModal('ne')">＋ כנס חדש</button>
    <button class="btn bg bsm" onclick="doLogout()" title="התנתק" style="padding:5px 8px">⎋</button>
  </div>
</div>
<div class="main">
  <div class="sidebar">
    <div class="sidebar-hd">
      <span class="sidebar-label">כנסים</span>
      <button class="btn bg bsm" onclick="loadEvents()" style="padding:4px 8px">↻</button>
    </div>
    <div id="evList"><div class="empty">טוען...</div></div>
  </div>
  <div class="content" id="mc">
    <div class="welcome"><div class="wi">📋</div><div class="wt">בחר כנס מהרשימה</div><div class="ws">או צור כנס חדש כדי לנהל חתימות, מדידות ושמאות</div></div>
  </div>
</div>
</div>

<div class="toast" id="toast"></div>

<!-- New Event -->
<div class="overlay" id="modal-ne"><div class="modal">
  <div class="mt">📅 כנס חדש</div>
  <div class="fg">
    <div class="fi s2"><label>שם הכנס</label><input id="ne-t" placeholder="חתימות פינוי-בינוי — רחוב הרצל 12"></div>
    <div class="fi"><label>סוג</label><select id="ne-tp"><option value="signing">חתימות</option><option value="survey">מדידות</option><option value="appraisal">שמאות</option><option value="other">אחר</option></select></div>
    <div class="fi"><label>תאריך ושעה</label><input type="datetime-local" id="ne-d"></div>
    <div class="fi s2"><label>מיקום</label><input id="ne-l" placeholder="כתובת מלאה"></div>
    <div class="fi"><label>מתחם</label><input id="ne-c" placeholder="מתחם X"></div>
    <div class="fi"><label>הערות</label><input id="ne-n"></div>
  </div>
  <div class="ma"><button class="btn bg" onclick="closeModal('ne')">ביטול</button><button class="btn bp" onclick="createEvent()">✓ צור כנס</button></div>
</div></div>

<!-- New Station -->
<div class="overlay" id="modal-ns"><div class="modal">
  <div class="mt">👤 הוסף עמדה</div>
  <div class="fg">
    <div class="fi s2"><label>שם איש מקצוע</label><input id="ns-n" placeholder='עו"ד ישראל ישראלי'></div>
    <div class="fi"><label>תפקיד</label><select id="ns-r"><option value="lawyer">עורך דין</option><option value="surveyor">מודד</option><option value="appraiser">שמאי</option><option value="other">אחר</option></select></div>
    <div class="fi"><label>מספר עמדה</label><input type="number" id="ns-num" min="1" placeholder="1"></div>
    <div class="fi"><label>טלפון (לWA)</label><input id="ns-p" placeholder="05X-XXXXXXX"></div>
    <div class="fi"><label>אימייל</label><input id="ns-e" type="email"></div>
  </div>
  <div class="ma"><button class="btn bg" onclick="closeModal('ns')">ביטול</button><button class="btn bp" onclick="addStation()">✓ הוסף עמדה</button></div>
</div></div>

<!-- Generate Slots -->
<div class="overlay" id="modal-sl"><div class="modal">
  <div class="mt">⏱ slots — <span id="slName"></span></div>
  <div class="fg">
    <div class="fi"><label>שעת התחלה</label><input type="datetime-local" id="sl-s" oninput="calcSlots()"></div>
    <div class="fi"><label>שעת סיום</label><input type="datetime-local" id="sl-e" oninput="calcSlots()"></div>
    <div class="fi"><label>משך (דקות)</label><input type="number" id="sl-d" value="15" min="5" max="120" oninput="calcSlots()"></div>
    <div class="fi"><label id="sl-calc" style="color:var(--cyan);font-size:11px;align-self:flex-end;padding-bottom:10px"></label></div>
  </div>
  <div class="ma"><button class="btn bg" onclick="closeModal('sl')">ביטול</button><button class="btn bp" onclick="genSlots()">✓ צור slots</button></div>
</div></div>

<!-- Add Attendee -->
<div class="overlay" id="modal-aa"><div class="modal">
  <div class="mt">🏠 הוסף דייר/ת ידנית</div>
  <div class="fg">
    <div class="fi s2"><label>שם מלא</label><input id="aa-n" placeholder="ישראל ישראלי"></div>
    <div class="fi"><label>טלפון</label><input id="aa-p" placeholder="05X-XXXXXXX"></div>
    <div class="fi"><label>מספר דירה</label><input id="aa-u" placeholder="12"></div>
    <div class="fi"><label>קומה</label><input id="aa-f" placeholder="3"></div>
    <div class="fi"><label>שם בניין</label><input id="aa-b" placeholder='בניין א'></div>
  </div>
  <div class="ma"><button class="btn bg" onclick="closeModal('aa')">ביטול</button><button class="btn bp" onclick="addAttendee()">✓ הוסף</button></div>
</div></div>

<!-- Notify -->
<div class="overlay" id="modal-nt"><div class="modal">
  <div class="mt">📱 שליחת WhatsApp</div>
  <p style="font-size:12px;color:var(--text2);margin-bottom:14px;line-height:1.6">שלח הודעת WA עם קישור אישור לדיירים ו/או קישור נוכחות לאנשי מקצוע.</p>
  <div class="fi"><label>שלח ל</label><select id="nt-t"><option value="attendees">דיירים בלבד</option><option value="pros">אנשי מקצוע בלבד</option><option value="all">כולם</option></select></div>
  <p style="font-size:10px;color:var(--text3);margin-top:8px">* נשלח רק לדיירים עם סטטוס ממתין שטרם קיבלו הודעה</p>
  <div class="ma"><button class="btn bg" onclick="closeModal('nt')">ביטול</button><button class="btn bs" onclick="sendNotify()">📤 שלח</button></div>
</div></div>

<script>
const BASE='${BASE}';
const SS_KEY='q_event_auth';
let AUTH=sessionStorage.getItem(SS_KEY)||'';
let curEvId=null, curSid=null;

const TYPE={signing:'חתימות',survey:'מדידות',appraisal:'שמאות',other:'אחר'};
const ROLE={lawyer:'עורך דין',surveyor:'מודד',appraiser:'שמאי',other:'אחר'};
const SL={pending:'ממתין',confirmed:'אישר',cancelled:'ביטל',arrived:'הגיע',no_show:'לא הגיע',rescheduled:'תיאם'};
const SC={pending:'pg',confirmed:'pgr',cancelled:'pr',arrived:'pb',no_show:'pr',rescheduled:'pa'};

// ── Auth ──────────────────────────────────────────────────────────────────────

function showLogin(){
  document.getElementById('loginScreen').classList.add('show');
  document.getElementById('appShell').style.display='none';
}
function showApp(){
  document.getElementById('loginScreen').classList.remove('show');
  document.getElementById('appShell').style.display='grid';
}

async function doLogin(){
  const u=document.getElementById('lu').value.trim();
  const p=document.getElementById('lp').value;
  const authHeader='Basic '+btoa(u+':'+p);
  const errEl=document.getElementById('loginErr');
  errEl.textContent='בודק...';
  try{
    const r=await fetch(BASE+'/events/',{headers:{'Authorization':authHeader}});
    if(r.status===401){errEl.textContent='שם משתמש או סיסמה שגויים';return;}
    AUTH=authHeader;
    sessionStorage.setItem(SS_KEY,AUTH);
    errEl.textContent='';
    showApp();
    loadEvents();
  }catch(e){errEl.textContent='שגיאת רשת';}
}

function doLogout(){
  sessionStorage.removeItem(SS_KEY);
  AUTH='';
  showLogin();
}

// ── Init ──────────────────────────────────────────────────────────────────────

(async function init(){
  if(!AUTH){showLogin();return;}
  // verify stored token still valid
  try{
    const r=await fetch(BASE+'/events/',{headers:{'Authorization':AUTH}});
    if(r.status===401){showLogin();return;}
    showApp();
    loadEvents();
  }catch(e){showLogin();}
})();

// ── Helpers ───────────────────────────────────────────────────────────────────

function toast(m,t='ok'){const el=document.getElementById('toast');el.textContent=m;el.className='toast show '+(t==='ok'?'tok':'terr');setTimeout(()=>el.classList.remove('show'),3500);}
function openModal(id){document.getElementById('modal-'+id).classList.add('open');}
function closeModal(id){document.getElementById('modal-'+id).classList.remove('open');}
document.querySelectorAll('.overlay').forEach(o=>o.addEventListener('click',e=>{if(e.target===o)o.classList.remove('open');}));
function fmtD(d){if(!d)return'';return new Date(d).toLocaleString('he-IL',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});}

async function api(method,path,body){
  const opts={method,headers:{'Content-Type':'application/json','Authorization':AUTH}};
  if(body)opts.body=JSON.stringify(body);
  const r=await fetch(BASE+'/events'+path,opts);
  if(r.status===401){doLogout();throw new Error('Unauthorized');}
  return r.json();
}

// ── Events list ───────────────────────────────────────────────────────────────

async function loadEvents(){
  const el=document.getElementById('evList');
  el.innerHTML='<div class="empty">טוען...</div>';
  try{
    const d=await api('GET','/');
    if(!d.success||!d.events.length){el.innerHTML='<div class="empty">אין כנסים עדיין.<br>לחץ "＋ כנס חדש" כדי להתחיל</div>';return;}
    el.innerHTML=d.events.map(e=>\`<div class="ev-item" id="ei-\${e.id}" onclick="loadEvent(\${e.id})">
      <div class="ev-title">\${e.title}</div>
      <div class="ev-meta">\${fmtD(e.event_date)}</div>
      <div class="ev-pills">
        <span class="pill pb">\${TYPE[e.event_type]||e.event_type}</span>
        \${e.attendee_count?'<span class="pill pg">'+e.attendee_count+' דיירים</span>':''}
        \${e.confirmed_count?'<span class="pill pgr">'+e.confirmed_count+' אישרו</span>':''}
      </div>
    </div>\`).join('');
  }catch(e){if(e.message!=='Unauthorized')el.innerHTML='<div class="empty">שגיאה</div>';}
}

// ── Event detail ──────────────────────────────────────────────────────────────

async function loadEvent(id){
  curEvId=id;
  document.querySelectorAll('.ev-item').forEach(el=>el.classList.remove('active'));
  const ei=document.getElementById('ei-'+id);
  if(ei)ei.classList.add('active');
  const mc=document.getElementById('mc');
  mc.innerHTML='<div class="welcome"><div style="color:var(--text3);font-size:12px">טוען...</div></div>';
  try{
    const d=await api('GET','/'+id);
    if(!d.success){mc.innerHTML='<div class="panel"><p style="color:red">'+d.error+'</p></div>';return;}
    const ev=d.event;
    let ta=0,co=0,ca=0,ar=0,ns=0,fs=0;
    (ev.stations||[]).forEach(s=>{
      (s.attendees||[]).forEach(a=>{ta++;if(a.status==='confirmed')co++;if(a.status==='cancelled')ca++;if(a.status==='arrived')ar++;if(a.status==='no_show')ns++;});
      fs+=(s.slots||[]).filter(sl=>sl.status==='free').length;
    });

    const stHtml=(ev.stations||[]).map(st=>{
      const fc=(st.slots||[]).filter(sl=>sl.status==='free').length;
      const pl=BASE+'/events/pro/'+st.token;
      const atRows=(st.attendees||[]).map(a=>{
        const tm=a.start_time?fmtD(a.start_time).split(' ')[1]:'-';
        return \`<tr>
          <td class="mono">\${tm}</td>
          <td><strong>\${a.name}</strong></td>
          <td style="color:var(--text3)">\${a.unit_number?'ד'+a.unit_number+(a.floor?'/ק'+a.floor:''):'-'}</td>
          <td style="color:var(--text3);font-size:10px">\${a.building_name||'-'}</td>
          <td class="mono" style="direction:ltr">\${a.phone||'-'}</td>
          <td><span class="pill \${SC[a.status]||'pg'}">\${SL[a.status]||a.status}</span></td>
          <td>\${a.wa_sent_at?'<span style="color:var(--green)">✓</span>':''}</td>
        </tr>\`;
      }).join('');
      return \`<div class="card">
        <div class="ch">
          <div class="ct">
            <span>עמדה \${st.station_number||'?'}</span>
            <span class="pill pb">\${ROLE[st.pro_role]||st.pro_role}</span>
            <strong>\${st.pro_name}</strong>
            \${st.pro_phone?'<span class="pill pg mono">'+st.pro_phone+'</span>':''}
            <span class="pill \${fc?'pgr':'pr'}">\${fc} פנויים / \${(st.slots||[]).length} סה"כ</span>
          </div>
          <div class="ca">
            <button class="btn bg bsm" onclick="openSlots(\${st.id},'\${st.pro_name.replace(/'/g,&quot;\\\\'\&quot;)}')">⏱ slots</button>
            <button class="btn bg bsm" onclick="openAA(\${st.id})">＋ דייר</button>
            <button class="btn ba bsm" onclick="autoAssign(\${ev.id},\${st.id})">⚡ חלק</button>
          </div>
        </div>
        <div class="cb">
          <div class="lb"><code>\${pl}</code>
            <button class="btn bg bsm" onclick="cpLink('\${pl}')" title="העתק">📋</button>
            <a href="\${pl}" target="_blank" class="btn bg bsm" title="פתח">↗</a>
          </div>
          \${(st.attendees||[]).length?
            '<div style="overflow-x:auto"><table><thead><tr><th>שעה</th><th>שם</th><th>דירה</th><th>בניין</th><th>טלפון</th><th>סטטוס</th><th>WA</th></tr></thead><tbody>'+atRows+'</tbody></table></div>'
            :'<p style="font-size:11px;color:var(--text3);text-align:center;padding:12px 0">אין דיירים — הוסף ידנית</p>'}
        </div>
      </div>\`;
    }).join('')||'<p style="font-size:11px;color:var(--text3);padding:4px 0">אין עמדות — הוסף עמדה ←</p>';

    mc.innerHTML=\`<div class="panel">
      <div class="ph">
        <div><div class="pt">\${ev.title}</div><div class="pm">\${fmtD(ev.event_date)}\${ev.location?' | 📍 '+ev.location:''}\${ev.compound_name?' | '+ev.compound_name:''}</div></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn bg bsm" onclick="openModal('ns')">＋ עמדה</button>
          <button class="btn bs bsm" onclick="openModal('nt')">📱 WA</button>
          <button class="btn bg bsm" onclick="loadEvent(\${ev.id})">↻</button>
        </div>
      </div>
      <div class="stats">
        <div class="sc"><div class="sn">\${ta}</div><div class="sl">דיירים</div></div>
        <div class="sc"><div class="sn" style="color:#34d399">\${co}</div><div class="sl">אישרו</div></div>
        <div class="sc"><div class="sn" style="color:var(--cyan)">\${ar}</div><div class="sl">הגיעו</div></div>
        <div class="sc"><div class="sn" style="color:#f87171">\${ns}</div><div class="sl">לא הגיעו</div></div>
        <div class="sc"><div class="sn" style="color:#fbbf24">\${fs}</div><div class="sl">slots פנויים</div></div>
      </div>
      <div class="sh"><span class="slabel">עמדות (\${(ev.stations||[]).length})</span></div>
      \${stHtml}
    </div>\`;
  }catch(e){if(e.message!=='Unauthorized')mc.innerHTML='<div class="panel"><p style="color:red">'+e.message+'</p></div>';}
}

// ── CRUD actions ──────────────────────────────────────────────────────────────

async function createEvent(){
  const t=document.getElementById('ne-t').value.trim();
  const dt=document.getElementById('ne-d').value;
  if(!t||!dt){toast('חובה: שם + תאריך','err');return;}
  const d=await api('POST','/',{title:t,event_type:document.getElementById('ne-tp').value,event_date:new Date(dt).toISOString(),location:document.getElementById('ne-l').value,compound_name:document.getElementById('ne-c').value,notes:document.getElementById('ne-n').value});
  if(d.success){toast('✅ כנס נוצר!');closeModal('ne');await loadEvents();loadEvent(d.event.id);}
  else toast(d.error,'err');
}

async function addStation(){
  if(!curEvId)return;
  const n=document.getElementById('ns-n').value.trim();
  if(!n){toast('חובה: שם','err');return;}
  const d=await api('POST','/'+curEvId+'/stations',{pro_name:n,pro_role:document.getElementById('ns-r').value,station_number:parseInt(document.getElementById('ns-num').value)||1,pro_phone:document.getElementById('ns-p').value,pro_email:document.getElementById('ns-e').value});
  if(d.success){toast('✅ עמדה נוספה!');closeModal('ns');loadEvent(curEvId);loadEvents();}
  else toast(d.error,'err');
}

function openSlots(sid,name){curSid=sid;document.getElementById('slName').textContent=name;openModal('sl');}
function calcSlots(){
  const s=document.getElementById('sl-s').value,e=document.getElementById('sl-e').value,dur=parseInt(document.getElementById('sl-d').value)||15;
  if(s&&e){const cnt=Math.floor((new Date(e)-new Date(s))/60000/dur);document.getElementById('sl-calc').textContent=cnt>0?'← '+cnt+' slots':'שעות לא תקינות';}
}
async function genSlots(){
  if(!curEvId||!curSid)return;
  const s=document.getElementById('sl-s').value,e=document.getElementById('sl-e').value,dur=parseInt(document.getElementById('sl-d').value)||15;
  if(!s||!e){toast('חובה: שעת התחלה וסיום','err');return;}
  const d=await api('POST','/'+curEvId+'/stations/'+curSid+'/slots',{start_time:new Date(s).toISOString(),end_time:new Date(e).toISOString(),slot_duration_minutes:dur});
  if(d.success){toast('✅ נוצרו '+d.count+' slots');closeModal('sl');loadEvent(curEvId);}
  else toast(d.error,'err');
}

function openAA(sid){curSid=sid;openModal('aa');}
async function addAttendee(){
  const name=document.getElementById('aa-n').value.trim();
  if(!name){toast('חובה: שם','err');return;}
  const d=await api('POST','/'+curEvId+'/attendees',{station_id:curSid,name,phone:document.getElementById('aa-p').value,unit_number:document.getElementById('aa-u').value,floor:document.getElementById('aa-f').value,building_name:document.getElementById('aa-b').value});
  if(d.success){toast('✅ דייר נוסף!');closeModal('aa');loadEvent(curEvId);}
  else toast(d.error,'err');
}

async function autoAssign(eid,sid){
  if(!confirm('לחלק דיירים אוטומטית ל-slots?'))return;
  const d=await api('POST','/'+eid+'/stations/'+sid+'/assign');
  if(d.success)toast('✅ חולקו '+d.assigned+' דיירים');
  else toast(d.error,'err');
  loadEvent(eid);
}

async function sendNotify(){
  if(!curEvId)return;
  const t=document.getElementById('nt-t').value;
  const d=await api('POST','/'+curEvId+'/notify',{target:t});
  if(d.success){toast('📱 '+d.wa_sent+' נשלחו, '+d.wa_failed+' כשלו');closeModal('nt');}
  else toast(d.error,'err');
}

async function cpLink(url){
  try{await navigator.clipboard.writeText(url);toast('✅ קישור הועתק');}
  catch(e){toast('לא ניתן להעתיק','err');}
}
</script>
</body></html>`);
});

module.exports = router;
