# Zoho CRM OAuth Setup Guide for QUANTUM

## Why this is needed
The scheduling bot needs to read contacts from Zoho CRM campaigns.
Without valid OAuth credentials, it runs in "DB-only" mode (still works, but can't fetch Zoho contacts automatically).

---

## Step 1: Create Zoho OAuth App

1. Go to [Zoho API Console](https://api-console.zoho.com/)
2. Click **"Add Client"** → choose **"Server-based Applications"**
3. Fill in:
   - **Client Name**: QUANTUM Scheduling Bot
   - **Homepage URL**: `https://pinuy-binuy-analyzer-production.up.railway.app`
   - **Authorized Redirect URIs**: `https://pinuy-binuy-analyzer-production.up.railway.app/api/crm/oauth/callback`
4. Click **Create**
5. Copy your **Client ID** and **Client Secret**

---

## Step 2: Generate Refresh Token

Open this URL in your browser (replace YOUR_CLIENT_ID):

```
https://accounts.zoho.com/oauth/v2/auth?scope=ZohoCRM.modules.ALL,ZohoCRM.settings.ALL&client_id=YOUR_CLIENT_ID&response_type=code&access_type=offline&redirect_uri=https://pinuy-binuy-analyzer-production.up.railway.app/api/crm/oauth/callback
```

This will:
1. Ask you to authorize access to Zoho CRM
2. Redirect to your callback URL with a `code` parameter

---

## Step 3: Exchange Code for Refresh Token

After authorizing, the callback page will automatically exchange the code and display your refresh token.

**OR** manually:
```bash
curl -X POST https://accounts.zoho.com/oauth/v2/token \
  -d "code=YOUR_CODE" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "redirect_uri=https://pinuy-binuy-analyzer-production.up.railway.app/api/crm/oauth/callback" \
  -d "grant_type=authorization_code"
```

Save the `refresh_token` from the response.

---

## Step 4: Set Railway Environment Variables

```
ZOHO_CLIENT_ID      = your_client_id
ZOHO_CLIENT_SECRET  = your_client_secret
ZOHO_REFRESH_TOKEN  = your_refresh_token
```

Railway: Project → pinuy-binuy-analyzer → Variables → Add Variables

---

## Step 5: Verify

```bash
curl https://pinuy-binuy-analyzer-production.up.railway.app/api/test/optimization/setup
# Should show: "Zoho token OK" instead of "Zoho error (DB-only)"
```

---

## Notes

- The refresh token doesn't expire as long as it's used at least once every 60 days
- Scope needed: `ZohoCRM.modules.ALL` (to read Contacts and Campaigns)
- Region: If your Zoho account is EU, use `accounts.zoho.eu` instead of `accounts.zoho.com`
