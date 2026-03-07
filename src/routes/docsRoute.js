const express = require('express');
const router = express.Router();

const openApiSpec = {
  openapi: '3.0.0',
  info: {
    title: 'QUANTUM Pinuy-Binuy Analyzer API',
    version: '4.62.0',
    description: 'API לניהול מתחמי פינוי-בינוי, לידים, CRM ודאשבורד ניהולי - QUANTUM Real Estate',
    contact: { name: 'QUANTUM', email: 'Office@u-r-quantum.com', url: 'https://u-r-quantum.com' }
  },
  servers: [{ url: 'https://pinuy-binuy-analyzer-production.up.railway.app', description: 'Production' }],
  tags: [
    { name: 'Complexes', description: 'מתחמי פינוי-בינוי' },
    { name: 'Leads', description: 'ניהול לידים ו-CRM' },
    { name: 'Search', description: 'חיפוש מתקדם' },
    { name: 'CRM', description: 'שיחות, תזכורות, עסקאות' },
    { name: 'Analytics', description: 'אנליטיקס ודוחות' },
    { name: 'Export', description: 'ייצוא נתונים' },
    { name: 'WhatsApp', description: 'הודעות WhatsApp' },
    { name: 'Users', description: 'ניהול משתמשים' },
    { name: 'System', description: 'בריאות המערכת' }
  ],
  paths: {
    '/health': { get: { tags: ['System'], summary: 'בדיקת בריאות', responses: { 200: { description: 'OK' } } } },
    '/api/debug': { get: { tags: ['System'], summary: 'מידע על גרסה ונתיבים', responses: { 200: { description: 'Debug info' } } } },
    '/api/complexes': {
      get: { tags: ['Complexes'], summary: 'רשימת מתחמים', parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 100 } }], responses: { 200: { description: 'רשימת מתחמים' } } }
    },
    '/api/leads': {
      get: { tags: ['Leads'], summary: 'רשימת לידים', parameters: [{ name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'source', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } }], responses: { 200: { description: 'רשימת לידים' } } },
      post: { tags: ['Leads'], summary: 'יצירת ליד', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, phone: { type: 'string' }, source: { type: 'string' } } } } } }, responses: { 201: { description: 'ליד נוצר' } } }
    },
    '/api/search/global': {
      post: { tags: ['Search'], summary: 'חיפוש גלובלי - לידים, מתחמים, מודעות', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { query: { type: 'string', example: 'תל אביב' }, filters: { type: 'object', properties: { city: { type: 'string' }, status: { type: 'string' }, min_iai: { type: 'number' } } }, limit: { type: 'integer', default: 20 } } } } } }, responses: { 200: { description: 'תוצאות חיפוש' } } }
    },
    '/api/search/suggestions': { get: { tags: ['Search'], summary: 'הצעות חיפוש', parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'הצעות' } } } },
    '/api/search/saved': {
      get: { tags: ['Search'], summary: 'חיפושים שמורים', responses: { 200: { description: 'רשימת חיפושים שמורים' } } },
      post: { tags: ['Search'], summary: 'שמירת חיפוש', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, query: { type: 'string' }, filters: { type: 'object' } } } } } }, responses: { 200: { description: 'נשמר' } } }
    },
    '/api/crm/calls': {
      get: { tags: ['CRM'], summary: 'יומן שיחות', parameters: [{ name: 'lead_id', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'שיחות' } } },
      post: { tags: ['CRM'], summary: 'רישום שיחה', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['lead_id'], properties: { lead_id: { type: 'integer' }, duration_seconds: { type: 'integer' }, notes: { type: 'string' }, outcome: { type: 'string', enum: ['answered', 'no_answer', 'busy', 'voicemail'] } } } } } }, responses: { 200: { description: 'שיחה נרשמה' } } }
    },
    '/api/crm/reminders': {
      get: { tags: ['CRM'], summary: 'תזכורות', parameters: [{ name: 'status', in: 'query', schema: { type: 'string', default: 'pending' } }], responses: { 200: { description: 'תזכורות' } } },
      post: { tags: ['CRM'], summary: 'יצירת תזכורת', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['lead_id', 'title', 'due_at'], properties: { lead_id: { type: 'integer' }, title: { type: 'string' }, due_at: { type: 'string', format: 'date-time' }, reminder_type: { type: 'string', default: 'follow_up' } } } } } }, responses: { 200: { description: 'תזכורת נוצרה' } } }
    },
    '/api/crm/pipeline': { get: { tags: ['CRM'], summary: 'Pipeline - כל שלבי העסקאות', responses: { 200: { description: 'Pipeline data' } } } },
    '/api/crm/deals': {
      get: { tags: ['CRM'], summary: 'עסקאות', parameters: [{ name: 'stage', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'עסקאות' } } },
      post: { tags: ['CRM'], summary: 'יצירת עסקה', responses: { 200: { description: 'עסקה נוצרה' } } }
    },
    '/api/crm/deals/{id}/stage': { put: { tags: ['CRM'], summary: 'עדכון שלב עסקה', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { stage: { type: 'string', enum: ['prospect', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] } } } } } }, responses: { 200: { description: 'שלב עודכן' } } } },
    '/api/analytics/overview': { get: { tags: ['Analytics'], summary: 'סקירה כללית', parameters: [{ name: 'period', in: 'query', schema: { type: 'string', enum: ['7d', '30d', '90d', '1y'], default: '30d' } }], responses: { 200: { description: 'סטטיסטיקות כלליות' } } } },
    '/api/analytics/leads': { get: { tags: ['Analytics'], summary: 'אנליזת לידים', responses: { 200: { description: 'ניתוח לידים לפי מקור, סטטוס, עיר' } } } },
    '/api/analytics/market': { get: { tags: ['Analytics'], summary: 'מגמות שוק', responses: { 200: { description: 'ניתוח שוק' } } } },
    '/api/analytics/performance': { get: { tags: ['Analytics'], summary: 'ביצועי מערכת', responses: { 200: { description: 'ביצועים' } } } },
    '/api/analytics/revenue': { get: { tags: ['Analytics'], summary: 'הכנסות ועסקאות', responses: { 200: { description: 'נתוי הכנסות' } } } },
    '/api/export/leads': { get: { tags: ['Export'], summary: 'ייצוא לידים', parameters: [{ name: 'format', in: 'query', schema: { type: 'string', enum: ['xlsx', 'csv'], default: 'xlsx' } }], responses: { 200: { description: 'קובץ Excel/CSV' } } } },
    '/api/export/complexes': { get: { tags: ['Export'], summary: 'ייצוא מתחמים', parameters: [{ name: 'format', in: 'query', schema: { type: 'string', enum: ['xlsx', 'csv'], default: 'xlsx' } }], responses: { 200: { description: 'קובץ' } } } },
    '/api/export/full-report': { get: { tags: ['Export'], summary: 'דוח מלא Excel', responses: { 200: { description: 'Excel מרובה גליונות' } } } },
    '/api/users': {
      get: { tags: ['Users'], summary: 'רשימת משתמשים', responses: { 200: { description: 'משתמשים' } } },
      post: { tags: ['Users'], summary: 'יצירת משתמש', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['name', 'email', 'password'], properties: { name: { type: 'string' }, email: { type: 'string', format: 'email' }, password: { type: 'string' }, role: { type: 'string', enum: ['admin', 'manager', 'agent', 'viewer'], default: 'agent' } } } } } }, responses: { 201: { description: 'משתמש נוצר' } } }
    },
    '/api/users/login': { post: { tags: ['Users'], summary: 'כניסה למערכת', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string' }, password: { type: 'string' } } } } } }, responses: { 200: { description: 'Token + פרטי משתמש' } } } }
  }
};

// GET /api/docs/json - OpenAPI JSON
router.get('/json', (req, res) => {
  res.json(openApiSpec);
});

// GET /api/docs - Swagger UI
router.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="he">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QUANTUM API Documentation</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui.min.css">
<style>
  body { background: #0a0a0a; color: #e0e0e0; font-family: 'Segoe UI', sans-serif; }
  .topbar { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%) !important; }
  .topbar-wrapper { padding: 12px 20px; }
  .topbar-wrapper img { display: none; }
  .topbar-wrapper::before { content: 'QUANTUM API Documentation v4.62.0'; font-size: 18px; font-weight: 800; color: #FFD700; }
  .swagger-ui .info .title { color: #FFD700 !important; }
  .swagger-ui { background: #0a0a0a; }
  .swagger-ui .scheme-container { background: #111 !important; box-shadow: none; }
  .swagger-ui .opblock-tag { background: #111 !important; border-bottom: 1px solid #333; }
  .swagger-ui .opblock-tag-section h3 { color: #FFD700 !important; }
  .swagger-ui .opblock.opblock-get .opblock-summary { background: rgba(97,175,254,.1); }
  .swagger-ui .opblock.opblock-post .opblock-summary { background: rgba(73,204,144,.1); }
  .swagger-ui .opblock.opblock-put .opblock-summary { background: rgba(252,161,48,.1); }
  .swagger-ui .opblock.opblock-delete .opblock-summary { background: rgba(249,62,62,.1); }
  .swagger-ui .btn.execute { background: #FFD700; color: #000; font-weight: 700; }
</style>
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui-bundle.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui-standalone-preset.min.js"></script>
<script>
window.onload = function() {
  SwaggerUIBundle({
    url: '/api/docs/json',
    dom_id: '#swagger-ui',
    deepLinking: true,
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
    plugins: [SwaggerUIBundle.plugins.DownloadUrl],
    layout: 'StandaloneLayout',
    tryItOutEnabled: true,
    persistAuthorization: true,
    filter: true,
    docExpansion: 'list'
  });
};
</script>
</body>
</html>`);
});

module.exports = router;
