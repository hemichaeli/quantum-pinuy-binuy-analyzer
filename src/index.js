function loadAllRoutes() {
  const routes = [
    ['./routes/projects', '/api/projects'],
    ['./routes/opportunities', '/api'],
    ['./routes/scan', '/api/scan'],
    ['./routes/alerts', '/api/alerts'],
    ['./routes/ssiRoutes', '/api/ssi'],
    ['./routes/enhancedData', '/api/enhanced'],
    ['./routes/konesRoutes', '/api/kones'],
    ['./routes/perplexityRoutes', '/api/perplexity'],
    ['./routes/intelligenceRoutes', '/api/intelligence'],
    ['./routes/chatRoutes', '/api/chat'],
    ['./routes/dashboardRoutes', '/api/dashboard'],
    ['./routes/governmentDataRoutes', '/api/government'],
    ['./routes/newsRoutes', '/api/news'],
    ['./routes/pricingRoutes', '/api/pricing'],
    ['./routes/messagingRoutes', '/api/messaging'],
    ['./routes/facebookRoutes', '/api/facebook'],
    ['./routes/admin', '/api/admin'],
    ['./routes/enrichmentRoutes', '/api/enrichment'],
    ['./routes/inforuRoutes', '/api/inforu'],
    ['./routes/premiumRoutes', '/api/premium'],
    ['./routes/signatureRoutes', '/api/signatures'],
    ['./routes/schedulerRoutes', '/api/scheduler/v2'],
    ['./routes/leadRoutes', '/api/leads'],
    ['./routes/botRoutes', '/api/bot'],
    ['./routes/whatsappWebhookRoutes', '/api'],
    ['./routes/whatsappAnalyticsRoutes', '/api'], // Analytics
    ['./routes/whatsappAlertRoutes', '/api'], // Auto-alerts + subscriptions
    ['./routes/whatsappDashboardRoutes', '/api'],
    ['./routes/whatsappSubscriptionDashboard', '/api'], // Subscription management UI
    ['./routes/firefliesWebhookRoutes', '/api/fireflies'],
    ['./routes/mavatBuildingRoutes', '/api/mavat'],
    ['./routes/scan-fixes', '/api/scan-fixes'],
  ];
  
  let loaded = 0, failed = 0;
  for (const [routePath, mountPath] of routes) {
    if (loadRoute(routePath, mountPath)) loaded++;
    else failed++;
  }
  logger.info(`Routes: ${loaded} loaded, ${failed} skipped`);
}