# QUANTUM Platform Contact Actor

Submits contact-form requests on Israeli real-estate platforms for QUANTUM
bulk outreach. Runs on Apify with residential proxy + Chrome stealth.

## Supported sources (Day 10)

| Source        | Status              |
|---------------|---------------------|
| madlan        | ✅ POC implemented   |
| web_madlan    | ✅ shares madlan     |
| yad1          | 🟡 stub — need handler |
| dira          | 🟡 stub — need handler |
| homeless      | 🟡 stub — need handler (login required) |
| winwin        | 🟡 stub — need handler |

## Deploying to Apify

1. Install Apify CLI:
   ```bash
   npm i -g apify-cli
   apify login
   ```

2. From this directory, push to your Apify account:
   ```bash
   cd apify-actors/quantum-platform-contact
   apify push
   ```

   This creates an actor under your username, e.g.
   `quiescent_sunset/quantum-platform-contact`.

3. **Set the actor name in Railway env**:
   `APIFY_PLATFORM_CONTACT_ACTOR=quiescent_sunset/quantum-platform-contact`

4. Test from the Railway analyzer (will be enabled by orchestrator
   automatically once env is set):
   ```bash
   curl -X POST https://pinuy-binuy-analyzer-production.up.railway.app/api/messaging/send-filtered \
     -H "Content-Type: application/json" \
     -d '{"filters":{"source":"madlan","limit":1}, "template_id":"yad2_seller"}'
   ```

## Implementing missing handlers

Each handler in `handlers/<source>.js` is a function:
```js
module.exports = async function handler(page, input) {
  // page is a fully-configured Puppeteer page (residential proxy + stealth)
  // input has { listingUrl, contactName, phone, email, message, credentials, ... }
  return { success: bool, error?: string, detail?: object };
};
```

**Workflow per platform:**
1. Open the platform in Chrome DevTools.
2. Open a listing.
3. Open Network tab; click "צור קשר" / "השאר פרטים".
4. Note: the modal selector + each form field's `name`/`id`/`placeholder`.
5. Note: the submit button selector.
6. Note: the success indicator (toast, banner, redirect).
7. Mirror the madlan handler structure with those selectors.

## Cost (Apify STARTER plan)

- ~30-45 seconds per submission
- Residential proxy: included in plan
- 100 submissions/day = ~1 GB-hour = well within 30 GB-hour STARTER quota
- 2Captcha (only if challenged): ~$0.001 per captcha

Total expected: **$0/month** in incremental Apify cost on STARTER plan
(plus negligible 2Captcha if engaged).
