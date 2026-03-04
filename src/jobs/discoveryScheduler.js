const cron = require('node-cron');
const { logger } = require('../services/logger');

// Weekly Discovery scan - Sunday 3:00 AM (quiet time)
const DISCOVERY_CRON = process.env.DISCOVERY_CRON || '0 3 * * 0';

let discoveryTask = null;
let lastRunResult = null;

/**
 * Run Discovery scan for all cities
 */
async function runDiscoverySync() {
  logger.info('🔍 Weekly Discovery scan started...');
  
  const discoveryService = require('../services/discoveryService');
  if (!discoveryService) {
    logger.error('Discovery service not available');
    return { error: 'Discovery service not loaded' };
  }

  try {
    const results = await discoveryService.discoverAll({ region: null, limit: null });
    
    lastRunResult = {
      completedAt: new Date().toISOString(),
      citiesScanned: results.cities_scanned,
      totalDiscovered: results.total_discovered,
      newAdded: results.new_added,
      alreadyExisted: results.already_existed
    };

    logger.info(`🔍 Weekly Discovery complete: ${results.cities_scanned} cities, ${results.new_added} NEW complexes!`);
    
    return lastRunResult;
  } catch (err) {
    logger.error('Weekly Discovery failed', { error: err.message });
    lastRunResult = { error: err.message, completedAt: new Date().toISOString() };
    return lastRunResult;
  }
}

/**
 * Start the Discovery scheduler
 */
function startDiscoveryScheduler() {
  if (discoveryTask) {
    logger.warn('Discovery scheduler already running');
    return;
  }

  if (!cron.validate(DISCOVERY_CRON)) {
    logger.error(`Invalid Discovery cron: ${DISCOVERY_CRON}`);
    return;
  }

  discoveryTask = cron.schedule(DISCOVERY_CRON, async () => {
    logger.info('🔍 Triggered weekly Discovery scan');
    await runDiscoverySync();
  }, { timezone: 'Asia/Jerusalem' });

  logger.info(`Discovery scheduler started: ${DISCOVERY_CRON} (Sunday 3:00 AM Israel time)`);
}

/**
 * Stop the Discovery scheduler
 */
function stopDiscoveryScheduler() {
  if (discoveryTask) {
    discoveryTask.stop();
    discoveryTask = null;
    logger.info('Discovery scheduler stopped');
  }
}

/**
 * Get Discovery scheduler status
 */
function getDiscoveryStatus() {
  return {
    enabled: !!discoveryTask,
    cron: DISCOVERY_CRON,
    schedule: 'Weekly - Sunday 3:00 AM',
    timezone: 'Asia/Jerusalem',
    lastRun: lastRunResult
  };
}

module.exports = {
  startDiscoveryScheduler,
  stopDiscoveryScheduler,
  getDiscoveryStatus,
  runDiscoverySync
};
