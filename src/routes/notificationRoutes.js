const express = require('express');
const router = express.Router();
const notificationService = require('../services/notificationService');
const { logger } = require('../services/logger');

// ============================================================
// QUANTUM Notification Routes - SSE + REST API
// ============================================================
// GET  /api/notifications/stream   - SSE live stream
// GET  /api/notifications/history  - Last N notifications
// GET  /api/notifications/stats    - Connected clients + counts
// POST /api/notifications/broadcast - Send notification
// POST /api/notifications/test     - Send test notification
// ============================================================

// SSE Stream - clients connect here for live updates
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Important for nginx/Railway
  res.flushHeaders();

  const clientId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  notificationService.addClient(clientId, res);

  // Keep-alive ping every 25s (prevents Railway/proxy timeout)
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (e) {
      clearInterval(ping);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    notificationService.removeClient(clientId);
  });

  req.on('error', () => {
    clearInterval(ping);
    notificationService.removeClient(clientId);
  });
});

// Get notification history
router.get('/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({
    success: true,
    notifications: notificationService.getHistory(limit),
    stats: notificationService.getStats()
  });
});

// Stats endpoint
router.get('/stats', (req, res) => {
  res.json({
    success: true,
    ...notificationService.getStats()
  });
});

// Broadcast notification (internal / webhook use)
router.post('/broadcast', (req, res) => {
  const { type, data } = req.body;
  if (!type) {
    return res.status(400).json({ error: 'type is required' });
  }
  const notification = notificationService.broadcast(type, data || {});
  logger.info(`[NOTIFY API] Manual broadcast: ${type}`);
  res.json({ success: true, notification });
});

// Test notification (dev/debug)
router.post('/test', (req, res) => {
  const types = ['new_lead', 'new_message', 'hot_opportunity', 'system_alert'];
  const type = req.body.type || types[Math.floor(Math.random() * types.length)];

  const testData = {
    new_lead: { name: 'דוד כהן', phone: '050-1234567', budget: '₪2.5M', source: 'טסט' },
    new_message: { from: 'יוסי לוי', preview: 'שלום, אני מעוניין בדירה בתל אביב...', channel: 'whatsapp' },
    hot_opportunity: { name: 'מתחם הרצל 45', city: 'תל אביב', iai: 92, reason: 'אישור ועדה צפוי' },
    system_alert: { message: 'מערכת פועלת תקין', level: 'info' }
  };

  const notification = notificationService.broadcast(type, testData[type] || { message: 'Test' });
  res.json({ success: true, notification, message: 'Test notification sent to all connected clients' });
});

module.exports = router;
