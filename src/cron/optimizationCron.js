/**
 * QUANTUM Optimization Cron
 *
 * Runs at 20:00 every evening (Israel time).
 * Identifies isolated confirmed slots for the next day and offers contacts a better time.
 *
 * Also runs at 22:30 to expire stale pending requests (those that never replied)
 * so the reserved proposed slots are released back to 'open'.
 */

const cron = require('node-cron');
const { logger } = require('../services/logger');
const optimizationService = require('../services/optimizationService');

function startOptimizationCron() {
  // ── 20:00 Sunday-Thursday (ראשון-חמישי) ─────────────────────────────────────
  // Skip Friday (5) and Saturday (6) - no field work on weekends
  cron.schedule('0 20 * * 0-4', async () => {
    logger.info('[OptimizationCron] 20:00 — Starting schedule optimization run');
    try {
      const summary = await optimizationService.runOptimizationForAllCampaigns();
      logger.info('[OptimizationCron] Done:', summary);
    } catch (err) {
      logger.error('[OptimizationCron] Run failed:', err.message);
    }
  }, { timezone: 'Asia/Jerusalem' });

  // ── 22:30 daily — Expire stale pending requests ──────────────────────────────
  // Contacts who received a WA offer but didn't reply: release their reserved slot.
  // Vapi calls for these were already queued by optimizationService.
  cron.schedule('30 22 * * *', async () => {
    logger.info('[OptimizationCron] 22:30 — Expiring stale reschedule requests');
    try {
      const expired = await optimizationService.expireStaleRequests();
      logger.info(`[OptimizationCron] ${expired} stale requests expired`);
    } catch (err) {
      logger.error('[OptimizationCron] Expire run failed:', err.message);
    }
  }, { timezone: 'Asia/Jerusalem' });

  logger.info('[OptimizationCron] Registered: 20:00 (optimization) + 22:30 (expire)');
}

module.exports = { startOptimizationCron };
