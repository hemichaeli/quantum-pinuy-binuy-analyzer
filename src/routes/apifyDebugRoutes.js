// Diagnostic endpoint for the Apify phone-reveal 403 outage.
// Isolates whether the problem is:
//   (a) token invalid          → /users/me returns 401
//   (b) account out of credits → /users/me 200, "monthlyUsageUsd" near limit
//   (c) actor access revoked   → /users/me 200 but /acts/<id> returns 403/404
// Never echoes the token itself. Mounted at /api/debug.

const express = require('express');
const axios = require('axios');
const router = express.Router();
const { logger } = require('../services/logger');

const APIFY_BASE = 'https://api.apify.com/v2';

// When does the monthly budget reset?
// Apify exposes the current billing period via /v2/users/me/usage/monthly.
router.get('/apify-cycle', async (req, res) => {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) return res.status(500).json({ ok: false, error: 'APIFY_API_TOKEN not set' });

  try {
    const r = await axios.get(`${APIFY_BASE}/users/me/usage/monthly`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
      validateStatus: () => true
    });
    return res.json({
      ok: r.status === 200,
      status: r.status,
      data: r.data?.data || r.data,
      hint: 'periodEnd / billingCycleEnd is when the $29 hard cap resets'
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/apify-status', async (req, res) => {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    return res.status(500).json({ ok: false, error: 'APIFY_API_TOKEN not set' });
  }

  const actorId = (process.env.APIFY_PHONE_REVEAL_ACTOR || 'quantum-phone-reveal').replace('/', '~');
  const result = {
    ok: true,
    tokenLength: token.length,
    tokenPrefix: token.slice(0, 6) + '…',
    actorId,
    me: null,
    actor: null,
    runDryHead: null
  };

  // 1) /users/me — is the token still valid?
  try {
    const r = await axios.get(`${APIFY_BASE}/users/me`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
      validateStatus: () => true
    });
    result.me = {
      status: r.status,
      username: r.data?.data?.username || null,
      plan: r.data?.data?.plan || null,
      monthlyUsageUsd: r.data?.data?.usage?.monthlyUsageUsd ?? null,
      monthlyLimitUsd: r.data?.data?.limits?.maxMonthlyUsageUsd ?? null,
      body: r.status >= 400 ? r.data : undefined
    };
  } catch (err) {
    result.me = { status: 'network_error', error: err.message };
  }

  // 2) /acts/<actorId> — is the actor still accessible to this account?
  try {
    const r = await axios.get(`${APIFY_BASE}/acts/${actorId}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
      validateStatus: () => true
    });
    result.actor = {
      status: r.status,
      name: r.data?.data?.name || null,
      isPublic: r.data?.data?.isPublic ?? null,
      isDeprecated: r.data?.data?.isDeprecated ?? null,
      pricingInfo: r.data?.data?.pricingInfos?.[0] || null,
      body: r.status >= 400 ? r.data : undefined
    };
  } catch (err) {
    result.actor = { status: 'network_error', error: err.message };
  }

  // 3) HEAD on the run endpoint we actually call — same 403 surface as production
  try {
    const r = await axios.post(
      `${APIFY_BASE}/acts/${actorId}/runs`,
      { adUrls: [], waitForFinish: 0 },
      {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 10000,
        validateStatus: () => true
      }
    );
    result.runDryHead = {
      status: r.status,
      body: r.status >= 400 ? r.data : { id: r.data?.data?.id }
    };
    // If a run somehow got created, abort it immediately so we don't burn credits.
    if (r.data?.data?.id) {
      await axios.post(
        `${APIFY_BASE}/actor-runs/${r.data.data.id}/abort`,
        {},
        { headers: { Authorization: `Bearer ${token}` }, timeout: 5000, validateStatus: () => true }
      ).catch(() => null);
    }
  } catch (err) {
    result.runDryHead = { status: 'network_error', error: err.message };
  }

  logger.info('[apify-debug] status check', result);
  res.json(result);
});

module.exports = router;
