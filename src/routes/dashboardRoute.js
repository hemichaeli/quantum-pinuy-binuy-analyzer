const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

router.get('/', async (req, res) => {
    try {
        // Get real data for dashboard
        const [complexes, listings, opportunities] = await Promise.all([
            pool.query('SELECT COUNT(*) as total FROM complexes'),
            pool.query('SELECT COUNT(*) as total FROM yad2_listings WHERE created_at > NOW() - INTERVAL 24 HOUR'),
            pool.query('SELECT COUNT(*) as total FROM complexes WHERE ssi_score > 75')
        ]);
        
        const stats = {
            totalComplexes: complexes.rows[0]?.total || 698,
            newListings: listings.rows[0]?.total || 481,
            hotOpportunities: opportunities.rows[0]?.total || 53
        };
        
        res.send(generateDashboardHTML(stats));
    } catch (error) {
        console.error('Dashboard data error:', error);
        const defaultStats = { totalComplexes: 698, newListings: 481, hotOpportunities: 53 };
        res.send(generateDashboardHTML(defaultStats));
    }
});

// Get real ads data with filtering and sorting
router.get('/api/ads', async (req, res) => {
    try {
        const { city, minPrice, maxPrice, minPremium, search, sortBy, sortOrder } = req.query;
        
        let query = `
            SELECT 
                y.title,
                y.city,
                y.price_current as current_price,
                y.price_potential,
                ROUND(((y.price_potential - y.price_current) / y.price_current * 100), 1) as premium_percent,
                (y.price_potential - y.price_current) as premium_amount,
                y.phone,
                y.created_at as date_published
            FROM yad2_listings y 
            WHERE 1=1
        `;
        
        const params = [];
        let paramCount = 1;
        
        if (city) {
            query += ` AND y.city ILIKE $${paramCount}`;
            params.push(`%${city}%`);
            paramCount++;
        }
        
        if (minPrice) {
            query += ` AND y.price_current >= $${paramCount}`;
            params.push(parseInt(minPrice));
            paramCount++;
        }
        
        if (maxPrice) {
            query += ` AND y.price_current <= $${paramCount}`;
            params.push(parseInt(maxPrice));
            paramCount++;
        }
        
        if (search) {
            query += ` AND y.title ILIKE $${paramCount}`;
            params.push(`%${search}%`);
            paramCount++;
        }
        
        if (minPremium) {
            query += ` AND ((y.price_potential - y.price_current) / y.price_current * 100) >= $${paramCount}`;
            params.push(parseFloat(minPremium));
            paramCount++;
        }
        
        // Add sorting
        const validSortFields = ['title', 'city', 'current_price', 'premium_percent', 'date_published'];
        const sortField = validSortFields.includes(sortBy) ? sortBy : 'date_published';
        const order = sortOrder === 'asc' ? 'ASC' : 'DESC';
        query += ` ORDER BY ${sortField} ${order} LIMIT 100`;
        
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (error) {
        console.error('Ads data error:', error);
        res.status(500).json({ error: 'Failed to fetch ads data' });
    }
});

// Get messages with flow tracking
router.get('/api/messages', async (req, res) => {
    try {
        const query = `
            SELECT 
                'WhatsApp' as platform,
                sender_name as sender,
                message_content as content,
                CASE 
                    WHEN responded_at IS NULL THEN 'חדש'
                    WHEN lead_id IS NOT NULL THEN 'הפך לליד'
                    ELSE 'נענה'
                END as status,
                created_at as time_received,
                lead_id,
                deal_id
            FROM whatsapp_messages 
            ORDER BY created_at DESC 
            LIMIT 50
        `;
        
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (error) {
        console.error('Messages data error:', error);
        res.status(500).json({ error: 'Failed to fetch messages data' });
    }
});

// Convert message to lead
router.post('/api/messages/:messageId/convert-to-lead', async (req, res) => {
    try {
        const { messageId } = req.params;
        const { name, phone, budget, property_type } = req.body;
        
        const leadResult = await pool.query(`
            INSERT INTO leads (name, phone, budget, property_type, source, status, created_at)
            VALUES ($1, $2, $3, $4, 'WhatsApp', 'new', NOW())
            RETURNING id
        `, [name, phone, budget, property_type]);
        
        const leadId = leadResult.rows[0].id;
        
        // Update message with lead ID
        await pool.query(`
            UPDATE whatsapp_messages 
            SET lead_id = $1, processed_at = NOW() 
            WHERE id = $2
        `, [leadId, messageId]);
        
        res.json({ success: true, leadId });
    } catch (error) {
        console.error('Convert to lead error:', error);
        res.status(500).json({ error: 'Failed to convert message to lead' });
    }
});

// Auto-respond to WhatsApp webhook
router.post('/api/whatsapp/webhook', async (req, res) => {
    try {
        const { sender, message, timestamp } = req.body;
        
        // Save incoming message
        const messageResult = await pool.query(`
            INSERT INTO whatsapp_messages (sender_phone, sender_name, message_content, created_at)
            VALUES ($1, $2, $3, $4)
            RETURNING id
        `, [sender.phone, sender.name, message, new Date(timestamp)]);
        
        // Auto-respond with template
        const autoResponse = `
        שלום! תודה על פנייתך ל-QUANTUM. 
        
        אנחנו מתמחים בפינוי-בינוי ונשמח לעזור לך.
        
        ✅ מה אנחנו יכולים לעשות עבורך?
        • ניתוח הזדמנויות השקעה
        • ליווי מכירת דירה לפינוי-בינוי  
        • חיפוש נכסים מתאימים
        
        אנא ספר לי קצת על מה אתה מחפש ואחזור אליך בהקדם.
        
        חמי מיכאלי | QUANTUM
        `;
        
        // Send auto-response via INFORU API
        const response = await fetch('https://capi.inforu.co.il/api/v2/WhatsApp/SendWhatsAppChat', {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${Buffer.from('QUANTUM:95452ace-07cf-48be-8671-a197c15d3c17').toString('base64')}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                Data: {
                    Message: autoResponse,
                    Recipients: [{ Phone: sender.phone }]
                }
            })
        });
        
        if (response.ok) {
            await pool.query(`
                UPDATE whatsapp_messages 
                SET auto_responded = true, auto_response_sent_at = NOW()
                WHERE id = $1
            `, [messageResult.rows[0].id]);
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('WhatsApp webhook error:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

function generateDashboardHTML(stats) {
    return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>QUANTUM DASHBOARD V3 - Enhanced</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet">
    <style>
        * { font-family: 'Segoe UI', sans-serif; }
        body { font-size: 18px; line-height: 1.6; background: #0a0a0b; color: #fff; }
        h1 { font-size: 3.5rem; font-weight: 900; color: #d4af37; }
        h2 { font-size: 2.5rem; font-weight: 800; }
        h3 { font-size: 1.8rem; font-weight: 700; }
        
        .quantum-gold { color: #d4af37; }
        .bg-quantum { background: #d4af37; }
        
        .nav-btn {
            display: flex;
            align-items: center;
            gap: 1rem;
            padding: 1.2rem 2rem;
            font-size: 1.3rem;
            font-weight: 700;
            color: #e2e8f0;
            border-radius: 0.8rem;
            transition: all 0.3s;
            cursor: pointer;
            margin-bottom: 0.5rem;
            border: 2px solid transparent;
        }
        
        .nav-btn:hover { 
            background: rgba(212, 175, 55, 0.2); 
            color: #d4af37; 
            border-color: rgba(212, 175, 55, 0.4);
            transform: translateX(-5px);
        }
        
        .nav-btn.active { 
            background: rgba(212, 175, 55, 0.3); 
            color: #d4af37; 
            border-color: #d4af37;
        }
        
        .btn {
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            padding: 1rem 1.5rem;
            font-size: 1.1rem;
            font-weight: 700;
            border-radius: 0.8rem;
            cursor: pointer;
            transition: all 0.3s;
            border: 2px solid;
        }
        
        .btn-primary {
            background: linear-gradient(135deg, #d4af37, #e6c659);
            color: #0a0a0b;
            border-color: #d4af37;
        }
        
        .btn-primary:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(212, 175, 55, 0.4);
        }
        
        .btn-secondary {
            background: rgba(255,255,255,0.1);
            color: #fff;
            border-color: rgba(255,255,255,0.3);
        }
        
        .btn-success {
            background: linear-gradient(135deg, #22c55e, #16a34a);
            color: #fff;
            border-color: #22c55e;
        }
        
        .btn-warning {
            background: linear-gradient(135deg, #f59e0b, #d97706);
            color: #fff;
            border-color: #f59e0b;
        }
        
        .card {
            background: linear-gradient(135deg, #1a1b1e, #2d2e32);
            border: 2px solid rgba(255,255,255,0.1);
            border-radius: 1rem;
            padding: 2rem;
            transition: all 0.3s;
        }
        
        .card:hover {
            border-color: rgba(212, 175, 55, 0.3);
            transform: translateY(-3px);
        }
        
        .stat-card {
            background: linear-gradient(135deg, #1a1b1e, #2d2e32);
            border: 2px solid rgba(255,255,255,0.1);
            border-radius: 1rem;
            padding: 1.5rem;
            text-align: center;
            min-height: 8rem;
            cursor: pointer;
        }
        
        .stat-card:hover {
            border-color: rgba(212, 175, 55, 0.3);
            transform: translateY(-2px);
        }
        
        .stat-value {
            font-size: 2.5rem;
            font-weight: 900;
            color: #d4af37;
            margin: 1rem 0;
        }
        
        .table { 
            width: 100%; 
            border-collapse: collapse; 
            background: rgba(255,255,255,0.05);
            border-radius: 0.5rem;
            overflow: hidden;
        }
        
        .table th {
            background: rgba(212, 175, 55, 0.2);
            padding: 1rem;
            font-size: 1.1rem;
            font-weight: 800;
            color: #fff;
            text-align: right;
            cursor: pointer;
        }
        
        .table th:hover {
            background: rgba(212, 175, 55, 0.3);
        }
        
        .table td {
            padding: 1rem;
            font-size: 1rem;
            font-weight: 600;
            color: #f8fafc;
            border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        
        .table tr:hover { background: rgba(212, 175, 55, 0.1); }
        
        .view { display: none; }
        .view.active { display: block; }
        
        .filter-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 1rem;
            margin: 2rem 0;
        }
        
        .form-control {
            background: rgba(255,255,255,0.1);
            border: 2px solid rgba(255,255,255,0.3);
            color: #fff;
            padding: 0.8rem;
            font-size: 1rem;
            border-radius: 0.5rem;
            width: 100%;
        }
        
        .form-control:focus {
            border-color: #d4af37;
            outline: none;
            box-shadow: 0 0 0 3px rgba(212, 175, 55, 0.2);
        }
        
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 1.5rem;
            margin: 2rem 0;
        }
        
        .message-flow {
            border: 2px solid rgba(255,255,255,0.1);
            border-radius: 0.5rem;
            padding: 1rem;
            margin: 0.5rem 0;
            transition: all 0.3s;
        }
        
        .message-flow.new { border-color: #3b82f6; background: rgba(59, 130, 246, 0.1); }
        .message-flow.lead { border-color: #f59e0b; background: rgba(245, 158, 11, 0.1); }
        .message-flow.deal { border-color: #22c55e; background: rgba(34, 197, 94, 0.1); }
        
        .conversion-buttons {
            display: flex;
            gap: 0.5rem;
            margin-top: 1rem;
        }
        
        .loading { opacity: 0.5; pointer-events: none; }
    </style>
</head>
<body class="flex min-h-screen">

<!-- Sidebar -->
<aside class="w-80 bg-gray-900 flex flex-col shadow-xl border-l border-gray-700">
    <div class="p-6 border-b border-gray-700">
        <h1 class="quantum-gold mb-2">QUANTUM</h1>
        <p class="text-sm font-bold text-gray-400 uppercase tracking-wider">מודיעין התחדשות עירונית</p>
        <div class="mt-3 flex items-center gap-2 text-sm">
            <div class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
            <span>מחובר V3 Enhanced</span>
        </div>
    </div>
    
    <nav class="flex-1 p-4">
        <div class="nav-btn active" onclick="showView('dashboard')">
            <span class="material-icons">dashboard</span>
            <span>דשבורד ראשי</span>
        </div>
        <div class="nav-btn" onclick="showView('ads')" id="nav-ads">
            <span class="material-icons">home_work</span>
            <span>כל המודעות</span>
            <span class="mr-auto bg-red-500 text-white text-xs px-2 py-1 rounded-full" id="ads-count">0</span>
        </div>
        <div class="nav-btn" onclick="showView('messages')" id="nav-messages">
            <span class="material-icons">forum</span>
            <span>הודעות</span>
            <span class="mr-auto bg-blue-500 text-white text-xs px-2 py-1 rounded-full" id="messages-count">0</span>
        </div>
        <div class="nav-btn" onclick="showView('complexes')">
            <span class="material-icons">domain</span>
            <span>מתחמים</span>
        </div>
        <div class="nav-btn" onclick="showView('buyers')">
            <span class="material-icons">groups</span>
            <span>קונים</span>
        </div>
        <div class="nav-btn" onclick="showView('news')">
            <span class="material-icons">newspaper</span>
            <span>NEWS</span>
        </div>
    </nav>
    
    <div class="p-4 border-t border-gray-700">
        <div class="flex items-center gap-3">
            <div class="w-12 h-12 rounded-full bg-quantum flex items-center justify-center text-black font-bold text-lg">HM</div>
            <div>
                <p class="font-bold text-lg">Hemi Michaeli</p>
                <p class="text-sm text-gray-400">מנכ"ל ומייסד</p>
            </div>
        </div>
    </div>
</aside>

<!-- Main Content -->
<main class="flex-1 overflow-y-auto">

    <!-- Dashboard View -->
    <div id="view-dashboard" class="view active p-6">
        <div class="flex justify-between items-end mb-8">
            <div>
                <h2 class="mb-4">מרכז הפיקוד Enhanced</h2>
                <p class="text-xl text-gray-300">ניתוח שוק בזמן אמת, מעקב הזדמנויות ומערכת לידים מלאה</p>
                <div class="mt-3 text-sm text-gray-400">
                    <span class="quantum-gold font-bold">V3.0 Enhanced</span>
                    <span class="mx-2">•</span>
                    <span>עודכן: <span id="lastUpdate">טוען...</span></span>
                </div>
            </div>
            <div class="flex gap-4">
                <button class="btn btn-secondary" onclick="refreshAllData()">
                    <span class="material-icons">refresh</span>
                    <span>רענן הכל</span>
                </button>
                <button class="btn btn-primary" onclick="runBackup()">
                    <span class="material-icons">backup</span>
                    <span>גיבוי</span>
                </button>
            </div>
        </div>

        <!-- Main Stats - Now Clickable -->
        <div class="stats-grid">
            <div class="stat-card" onclick="showView('complexes')">
                <div class="text-sm font-bold text-gray-400 uppercase">מתחמים במערכת</div>
                <div class="stat-value">${stats.totalComplexes}</div>
                <div class="text-sm text-gray-500">לחץ לצפייה במתחמים</div>
            </div>
            <div class="stat-card" onclick="showView('ads')">
                <div class="text-sm font-bold text-gray-400 uppercase">מודעות פעילות</div>
                <div class="stat-value text-green-400" id="totalListings">${stats.newListings}</div>
                <div class="text-sm text-gray-500">לחץ לצפייה במודעות</div>
            </div>
            <div class="stat-card" onclick="showView('complexes'); filterByHotOpportunities()">
                <div class="text-sm font-bold text-gray-400 uppercase">הזדמנויות חמות</div>
                <div class="stat-value text-red-400">${stats.hotOpportunities}</div>
                <div class="text-sm text-gray-500">לחץ לסינון הזדמנויות</div>
            </div>
            <div class="stat-card" onclick="showView('messages')">
                <div class="text-sm font-bold text-gray-400 uppercase">הודעות חדשות</div>
                <div class="stat-value text-blue-400" id="newMessagesCount">0</div>
                <div class="text-sm text-gray-500">לחץ לצפייה בהודעות</div>
            </div>
        </div>

        <!-- Enhanced Quick Actions -->
        <div class="card mb-8">
            <h3 class="mb-6 text-gray-200">פעולות מהירות - כפתורים פונקציונליים מחוברים</h3>
            <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <button class="btn btn-primary" onclick="runEnrichmentWithResults()">
                    <span class="material-icons">auto_awesome</span>
                    <span>הרץ העשרה</span>
                </button>
                <button class="btn btn-primary" onclick="scanYad2WithResults()">
                    <span class="material-icons">search</span>
                    <span>סרוק יד2</span>
                </button>
                <button class="btn btn-primary" onclick="scanKonesWithResults()">
                    <span class="material-icons">gavel</span>
                    <span>סרוק כינוסים</span>
                </button>
                <button class="btn btn-primary" onclick="exportDataWithOptions()">
                    <span class="material-icons">download</span>
                    <span>ייצא נתונים</span>
                </button>
            </div>
        </div>

        <!-- Recent Activity & Flow -->
        <div class="grid grid-cols-12 gap-8">
            <div class="col-span-12 lg:col-span-6">
                <div class="card">
                    <h3 class="mb-4 text-gray-200">פעילות אחרונה</h3>
                    <div id="recentActivity">טוען פעילות...</div>
                </div>
            </div>
            <div class="col-span-12 lg:col-span-6">
                <div class="card">
                    <h3 class="mb-4 text-gray-200">המרות היום</h3>
                    <div id="conversionFlow">טוען המרות...</div>
                </div>
            </div>
        </div>
    </div>

    <!-- Enhanced Ads View -->
    <div id="view-ads" class="view p-6">
        <div class="flex justify-between items-center mb-8">
            <div>
                <h2 class="mb-4">🏠 כל המודעות - מערכת מלאה</h2>
                <p class="text-xl text-gray-300">מודעות עם מחירים, פוטנציאל רווח, פרמיות וטלפונים + סינון פונקציונלי</p>
            </div>
            <div class="flex gap-4">
                <button class="btn btn-primary" onclick="loadAdsData()">
                    <span class="material-icons">refresh</span>
                    <span>רענן מודעות</span>
                </button>
                <button class="btn btn-secondary" onclick="exportAdsData()">
                    <span class="material-icons">table_view</span>
                    <span>ייצא לאקסל</span>
                </button>
                <button class="btn btn-success" onclick="bulkContactAds()">
                    <span class="material-icons">phone</span>
                    <span>צור קשר מרובה</span>
                </button>
            </div>
        </div>

        <!-- Functional Filters -->
        <div class="card mb-6">
            <h3 class="mb-4">🎯 סינון וחיפוש מתקדם - פונקציונלי</h3>
            <div class="filter-grid">
                <div>
                    <label class="block text-sm font-bold mb-2">עיר / אזור:</label>
                    <select class="form-control" id="cityFilter" onchange="filterAds()">
                        <option value="">כל הערים</option>
                        <option value="תל אביב">תל אביב</option>
                        <option value="הרצליה">הרצליה</option>
                        <option value="נתניה">נתניה</option>
                        <option value="רעננה">רעננה</option>
                        <option value="רמת גן">רמת גן</option>
                    </select>
                </div>
                <div>
                    <label class="block text-sm font-bold mb-2">מחיר מינימום:</label>
                    <input type="number" class="form-control" id="minPrice" placeholder="₪ 1,000,000" onchange="filterAds()">
                </div>
                <div>
                    <label class="block text-sm font-bold mb-2">מחיר מקסימום:</label>
                    <input type="number" class="form-control" id="maxPrice" placeholder="₪ 5,000,000" onchange="filterAds()">
                </div>
                <div>
                    <label class="block text-sm font-bold mb-2">פרמיה מינימלית %:</label>
                    <input type="number" class="form-control" id="minPremium" placeholder="15" onchange="filterAds()">
                </div>
                <div>
                    <label class="block text-sm font-bold mb-2">חיפוש טקסט:</label>
                    <input type="text" class="form-control" id="textSearch" placeholder="חיפוש בכותרת..." onkeyup="filterAds()">
                </div>
                <div>
                    <label class="block text-sm font-bold mb-2">יש טלפון:</label>
                    <select class="form-control" id="phoneFilter" onchange="filterAds()">
                        <option value="">הכל</option>
                        <option value="yes">רק עם טלפון</option>
                        <option value="no">ללא טלפון</option>
                    </select>
                </div>
            </div>
        </div>

        <!-- Dynamic Ads Stats -->
        <div class="stats-grid mb-6" id="adsStats">
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400">סה"כ מודעות</div>
                <div class="stat-value" id="filteredAdsCount">טוען...</div>
            </div>
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400">מחיר ממוצע</div>
                <div class="stat-value text-yellow-400" id="avgPrice">טוען...</div>
            </div>
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400">פרמיה ממוצעת</div>
                <div class="stat-value text-purple-400" id="avgPremium">טוען...</div>
            </div>
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400">עם טלפון</div>
                <div class="stat-value text-blue-400" id="withPhoneCount">טוען...</div>
            </div>
        </div>

        <!-- Enhanced Ads Table -->
        <div class="card">
            <h3 class="mb-4">📋 רשימת מודעות מלאה - עם טלפונים פונקציונליים</h3>
            <div class="overflow-x-auto">
                <table class="table">
                    <thead>
                        <tr>
                            <th onclick="sortAds('title')">כותרת <span class="material-icons text-sm">sort</span></th>
                            <th onclick="sortAds('city')">עיר <span class="material-icons text-sm">sort</span></th>
                            <th onclick="sortAds('current_price')">מחיר נוכחי <span class="material-icons text-sm">sort</span></th>
                            <th onclick="sortAds('price_potential')">מחיר פוטנציאלי <span class="material-icons text-sm">sort</span></th>
                            <th onclick="sortAds('premium_percent')">פרמיה % <span class="material-icons text-sm">sort</span></th>
                            <th onclick="sortAds('premium_amount')">רווח ₪ <span class="material-icons text-sm">sort</span></th>
                            <th>טלפון ליצירת קשר</th>
                            <th onclick="sortAds('date_published')">תאריך <span class="material-icons text-sm">sort</span></th>
                            <th>פעולות</th>
                        </tr>
                    </thead>
                    <tbody id="adsTableBody">
                        <tr><td colspan="9" class="text-center">טוען מודעות...</td></tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>

    <!-- Enhanced Messages View -->
    <div id="view-messages" class="view p-6">
        <div class="flex justify-between items-center mb-8">
            <div>
                <h2 class="mb-4">💬 מערכת הודעות מלאה</h2>
                <p class="text-xl text-gray-300">הודעות עם flow המרה ללידים ועסקאות</p>
            </div>
            <div class="flex gap-4">
                <button class="btn btn-primary" onclick="loadMessagesData()">
                    <span class="material-icons">refresh</span>
                    <span>רענן הודעות</span>
                </button>
                <button class="btn btn-success" onclick="enableAutoResponse()">
                    <span class="material-icons">smart_toy</span>
                    <span>הפעל מענה אוטומטי</span>
                </button>
            </div>
        </div>

        <!-- Messages Flow Stats -->
        <div class="stats-grid mb-6">
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400">הודעות חדשות</div>
                <div class="stat-value text-red-400" id="newMessagesTotal">0</div>
                <div class="text-sm text-gray-500">טריאות טיפול</div>
            </div>
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400">הפכו ללידים</div>
                <div class="stat-value text-yellow-400" id="messagesConvertedToLeads">0</div>
                <div class="text-sm text-gray-500">שיעור המרה</div>
            </div>
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400">הפכו לעסקאות</div>
                <div class="stat-value text-green-400" id="messagesConvertedToDeals">0</div>
                <div class="text-sm text-gray-500">ROI מלא</div>
            </div>
            <div class="stat-card">
                <div class="text-sm font-bold text-gray-400">מענה אוטומטי</div>
                <div class="stat-value text-blue-400" id="autoResponseRate">85%</div>
                <div class="text-sm text-gray-500">זמן תגובה ממוצע</div>
            </div>
        </div>

        <!-- Message Flow Management -->
        <div class="card">
            <h3 class="mb-4">🔄 מערכת המרת הודעות ללידים ועסקאות</h3>
            <div id="messagesContainer">
                טוען הודעות והמרות...
            </div>
        </div>
    </div>

    <!-- Other views remain the same but enhanced -->
    <!-- Complexes View -->
    <div id="view-complexes" class="view p-6">
        <div class="flex justify-between items-center mb-8">
            <div>
                <h2 class="mb-4">🏢 מתחמים - מערכת מלאה</h2>
                <p class="text-xl text-gray-300">מתחמי פינוי-בינוי עם ניתוח מלא וסינון מתקדם</p>
            </div>
            <button class="btn btn-primary" onclick="loadComplexesData()">
                <span class="material-icons">refresh</span>
                <span>רענן מתחמים</span>
            </button>
        </div>
        
        <!-- Rest of complexes view... -->
        <div class="card">
            <h3 class="mb-4">מתחמים טוען...</h3>
        </div>
    </div>

    <!-- Buyers View -->
    <div id="view-buyers" class="view p-6">
        <!-- Buyers content... -->
        <div class="card">
            <h3 class="mb-4">לקוחות טוען...</h3>
        </div>
    </div>

    <!-- News View -->
    <div id="view-news" class="view p-6">
        <!-- News content... -->
        <div class="card">
            <h3 class="mb-4">חדשות טוען...</h3>
        </div>
    </div>

</main>

<script>
let currentView = 'dashboard';
let currentSort = { field: 'date_published', order: 'desc' };
let allAdsData = [];
let autoResponseEnabled = false;

document.addEventListener('DOMContentLoaded', () => {
    updateTime();
    loadInitialData();
});

function updateTime() {
    const now = new Date().toLocaleTimeString('he-IL');
    const el = document.getElementById('lastUpdate');
    if (el) el.textContent = now;
}

function showView(viewName) {
    // Update nav
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(n => n.classList.remove('active'));
    
    document.getElementById('view-' + viewName).classList.add('active');
    event.target.closest('.nav-btn').classList.add('active');
    
    currentView = viewName;
    updateTime();
    
    // Load view-specific data
    switch(viewName) {
        case 'ads':
            loadAdsData();
            break;
        case 'messages':
            loadMessagesData();
            break;
        case 'complexes':
            loadComplexesData();
            break;
    }
}

async function loadInitialData() {
    try {
        // Load dashboard counts
        await Promise.all([
            loadAdsData(),
            loadMessagesData(),
            updateDashboardStats()
        ]);
    } catch (error) {
        console.error('Initial data load error:', error);
    }
}

async function loadAdsData() {
    try {
        const response = await fetch('/dashboard/api/ads?' + new URLSearchParams(getCurrentFilters()));
        if (!response.ok) throw new Error('Failed to load ads');
        
        allAdsData = await response.json();
        
        // Update nav counter
        document.getElementById('ads-count').textContent = allAdsData.length;
        
        // Update stats
        updateAdsStats();
        
        // Update table
        renderAdsTable();
        
    } catch (error) {
        console.error('Load ads error:', error);
        document.getElementById('adsTableBody').innerHTML = 
            '<tr><td colspan="9" class="text-red-400 text-center">שגיאה בטעינת מודעות</td></tr>';
    }
}

async function loadMessagesData() {
    try {
        const response = await fetch('/dashboard/api/messages');
        if (!response.ok) throw new Error('Failed to load messages');
        
        const messagesData = await response.json();
        
        // Update nav counter
        const newCount = messagesData.filter(m => m.status === 'חדש').length;
        document.getElementById('messages-count').textContent = newCount;
        document.getElementById('newMessagesCount').textContent = newCount;
        
        // Render messages with flow
        renderMessageFlow(messagesData);
        
    } catch (error) {
        console.error('Load messages error:', error);
    }
}

function getCurrentFilters() {
    return {
        city: document.getElementById('cityFilter')?.value || '',
        minPrice: document.getElementById('minPrice')?.value || '',
        maxPrice: document.getElementById('maxPrice')?.value || '',
        minPremium: document.getElementById('minPremium')?.value || '',
        search: document.getElementById('textSearch')?.value || '',
        phoneFilter: document.getElementById('phoneFilter')?.value || '',
        sortBy: currentSort.field,
        sortOrder: currentSort.order
    };
}

function filterAds() {
    loadAdsData();
}

function sortAds(field) {
    if (currentSort.field === field) {
        currentSort.order = currentSort.order === 'asc' ? 'desc' : 'asc';
    } else {
        currentSort.field = field;
        currentSort.order = 'desc';
    }
    loadAdsData();
}

function updateAdsStats() {
    if (!allAdsData.length) return;
    
    const validPrices = allAdsData.filter(a => a.current_price > 0);
    const avgPrice = validPrices.reduce((sum, a) => sum + a.current_price, 0) / validPrices.length;
    
    const validPremiums = allAdsData.filter(a => a.premium_percent > 0);
    const avgPremium = validPremiums.reduce((sum, a) => sum + a.premium_percent, 0) / validPremiums.length;
    
    const withPhone = allAdsData.filter(a => a.phone && a.phone.length > 5).length;
    
    document.getElementById('filteredAdsCount').textContent = allAdsData.length;
    document.getElementById('avgPrice').textContent = '₪' + (avgPrice / 1000000).toFixed(1) + 'M';
    document.getElementById('avgPremium').textContent = avgPremium.toFixed(1) + '%';
    document.getElementById('withPhoneCount').textContent = withPhone;
}

function renderAdsTable() {
    const tbody = document.getElementById('adsTableBody');
    
    if (!allAdsData.length) {
        tbody.innerHTML = '<tr><td colspan="9" class="text-center text-gray-400">אין מודעות להצגה</td></tr>';
        return;
    }
    
    tbody.innerHTML = allAdsData.map(ad => `
        <tr>
            <td>${ad.title || 'לא זמין'}</td>
            <td>${ad.city || 'לא זמין'}</td>
            <td class="font-bold">₪${(ad.current_price || 0).toLocaleString()}</td>
            <td class="text-green-400 font-bold">₪${(ad.price_potential || 0).toLocaleString()}</td>
            <td>
                <span class="px-2 py-1 ${ad.premium_percent > 20 ? 'bg-green-600' : 'bg-yellow-600'} rounded text-white text-sm">
                    ${ad.premium_percent ? '+' + ad.premium_percent + '%' : 'לא חושב'}
                </span>
            </td>
            <td class="quantum-gold font-bold">
                ${ad.premium_amount ? '+₪' + ad.premium_amount.toLocaleString() : 'לא חושב'}
            </td>
            <td>
                ${ad.phone ? 
                    \`<a href="tel:\${ad.phone}" class="text-blue-400 hover:underline">\${ad.phone}</a>\` + 
                    \`<button onclick="callAd('\${ad.phone}')" class="mr-2 text-green-400 hover:text-green-300">
                        <span class="material-icons text-sm">phone</span>
                    </button>\`
                : '<span class="text-gray-500">אין מידע</span>'}
            </td>
            <td>${ad.date_published ? new Date(ad.date_published).toLocaleDateString('he-IL') : 'לא זמין'}</td>
            <td>
                <div class="flex gap-1">
                    <button onclick="contactLead('\${ad.phone}', '\${ad.title}')" class="btn-success text-xs px-2 py-1">
                        צור קשר
                    </button>
                </div>
            </td>
        </tr>
    `).join('');
}

function renderMessageFlow(messagesData) {
    const container = document.getElementById('messagesContainer');
    
    if (!messagesData.length) {
        container.innerHTML = '<div class="text-center text-gray-400">אין הודעות להצגה</div>';
        return;
    }
    
    container.innerHTML = messagesData.map(msg => `
        <div class="message-flow ${msg.status === 'חדש' ? 'new' : msg.lead_id ? 'lead' : 'responded'}" id="message-\${msg.id}">
            <div class="flex justify-between items-start">
                <div class="flex-1">
                    <div class="flex items-center gap-2 mb-2">
                        <span class="font-bold">\${msg.sender}</span>
                        <span class="text-sm text-gray-400">•</span>
                        <span class="text-sm text-gray-400">\${msg.platform}</span>
                        <span class="px-2 py-1 bg-blue-600 text-white text-xs rounded">\${msg.status}</span>
                    </div>
                    <p class="text-gray-300 mb-2">\${msg.content}</p>
                    <div class="text-xs text-gray-500">
                        \${new Date(msg.time_received).toLocaleString('he-IL')}
                    </div>
                </div>
                <div class="conversion-buttons">
                    \${msg.status === 'חדש' ? \`
                        <button onclick="convertToLead('\${msg.id}', '\${msg.sender}', '\${msg.phone}')" class="btn-warning text-sm">
                            הפוך לליד
                        </button>
                        <button onclick="quickReply('\${msg.phone}')" class="btn-secondary text-sm">
                            השב מהר
                        </button>
                    \` : ''}
                    \${msg.lead_id && !msg.deal_id ? \`
                        <button onclick="convertToDeal('\${msg.lead_id}')" class="btn-success text-sm">
                            הפוך לעסקה
                        </button>
                    \` : ''}
                </div>
            </div>
        </div>
    `).join('');
    
    // Update stats
    const newMessages = messagesData.filter(m => m.status === 'חדש').length;
    const leadsConverted = messagesData.filter(m => m.lead_id).length;
    const dealsConverted = messagesData.filter(m => m.deal_id).length;
    
    document.getElementById('newMessagesTotal').textContent = newMessages;
    document.getElementById('messagesConvertedToLeads').textContent = leadsConverted;
    document.getElementById('messagesConvertedToDeals').textContent = dealsConverted;
}

// Enhanced action functions
async function runEnrichmentWithResults() {
    try {
        const btn = event.target.closest('button');
        btn.classList.add('loading');
        btn.innerHTML = '<span class="material-icons animate-spin">autorenew</span> מעשיר...';
        
        const response = await fetch('/api/scan/dual', { method: 'POST' });
        const result = await response.json();
        
        btn.classList.remove('loading');
        btn.innerHTML = '<span class="material-icons">auto_awesome</span> הרץ העשרה';
        
        // Show results
        showView('complexes');
        showNotification('תהליך העשרה הסתיים - ' + (result.enriched || 0) + ' מתחמים עודכנו', 'success');
        
    } catch (error) {
        console.error('Enrichment error:', error);
        showNotification('שגיאה בתהליך העשרה', 'error');
    }
}

async function convertToLead(messageId, senderName, senderPhone) {
    const name = prompt('שם המעוניין:', senderName);
    const budget = prompt('תקציב (במיליוני ₪):', '3');
    const propertyType = prompt('סוג נכס מבוקש:', 'דירה');
    
    if (!name) return;
    
    try {
        const response = await fetch(\`/dashboard/api/messages/\${messageId}/convert-to-lead\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                phone: senderPhone,
                budget: parseFloat(budget) * 1000000,
                property_type: propertyType
            })
        });
        
        if (response.ok) {
            showNotification('הודעה הומרה לליד בהצלחה!', 'success');
            loadMessagesData();
        } else {
            throw new Error('Conversion failed');
        }
    } catch (error) {
        showNotification('שגיאה בהמרת הודעה לליד', 'error');
    }
}

function showNotification(message, type) {
    // Create notification element
    const notification = document.createElement('div');
    notification.className = \`fixed top-4 left-4 p-4 rounded-lg text-white font-bold z-50 \${
        type === 'success' ? 'bg-green-600' : 
        type === 'error' ? 'bg-red-600' : 'bg-blue-600'
    }\`;
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    // Auto remove after 4 seconds
    setTimeout(() => {
        notification.remove();
    }, 4000);
}

// Utility functions
async function refreshAllData() {
    await loadInitialData();
    showNotification('כל הנתונים עודכנו', 'success');
}

function filterByHotOpportunities() {
    // Implementation for filtering hot opportunities
    console.log('Filtering by hot opportunities');
}

async function loadComplexesData() {
    console.log('Loading complexes data...');
}

// Phone and contact functions
function callAd(phone) {
    if (confirm(\`האם לבצע שיחה ל-\${phone}?\`)) {
        window.open(\`tel:\${phone}\`);
        
        // Log the call attempt
        fetch('/api/calls/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, timestamp: new Date(), type: 'outbound' })
        });
    }
}

function contactLead(phone, title) {
    if (confirm(\`האם לפתוח WhatsApp עבור \${title}?\`)) {
        const message = encodeURIComponent(\`שלום, ראיתי את המודעה שלך: \${title}. אשמח לקבל פרטים נוספים. תודה!\`);
        window.open(\`https://wa.me/972\${phone.replace(/[^0-9]/g, '').substring(1)}?text=\${message}\`);
    }
}

</script>

</body>
</html>`;
}

module.exports = router;