// Root-path aliases for the AI-Discovery endpoints.
// Lets AI crawlers (GPTBot, ClaudeBot, PerplexityBot, OAI-SearchBot,
// Google-Extended, etc.) reach the discovery endpoints at canonical AI-bot
// paths on whatever hostname the analyzer is served from
// (pinuy-binuy-analyzer-production.up.railway.app or
// discovery.u-r-quantum.com once the Railway custom domain is attached).
//
// The actual handlers live in aiDiscoveryRoutes.js. This module forwards
// to them via Express sub-app mounting so we don't duplicate code.

const express = require('express');
const router = express.Router();
const discovery = require('./aiDiscoveryRoutes');

// Mount the same router at /api/discovery (already done in index.js) AND at
// these root paths so the same handlers respond to both call styles.
// We can't double-register a single Router on multiple mount paths safely
// across Express versions, so we proxy via thin wrappers.

const proxyTo = (subPath) => (req, res, next) => {
  req.url = subPath;
  return discovery.handle(req, res, next);
};

router.get('/llms.txt',              proxyTo('/llms.txt'));
router.get('/feed.atom',             proxyTo('/feed.atom'));
router.get('/opportunities.json',    proxyTo('/opportunities.json'));
router.get('/changelog.json',        proxyTo('/changelog.json'));
router.get('/.well-known/agents.json',  proxyTo('/agents.json'));
router.get('/.well-known/openapi.json', proxyTo('/openapi.json'));

module.exports = router;
