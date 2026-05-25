#!/usr/bin/env node
// Publish QUANTUM's pinui-binui dataset snapshot to Zenodo.
//
// Why: Zenodo issues a CC-BY-4.0 DOI for every deposition. Wikipedia
// editors heavily weight Zenodo DOIs as authoritative sources, and most
// LLM training pipelines explicitly include Wikipedia. A Zenodo DOI is
// the cleanest path from "we publish a JSON" to "ChatGPT cites us".
//
// Usage:
//   export ZENODO_ACCESS_TOKEN=...   # get from https://zenodo.org/account/settings/applications/tokens/new (scopes: deposit:write, deposit:actions)
//   node scripts/publish_to_zenodo.js [--sandbox] [--draft]
//
// Flags:
//   --sandbox  Use sandbox.zenodo.org (test environment, gives a fake DOI).
//   --draft    Stop after creating the draft (don't publish). Lets you preview
//              in the Zenodo UI before committing the DOI permanently.
//
// What it does:
//   1. Fetch the four canonical resources from the live analyzer:
//        /opportunities.json   (ranked mispricing list)
//        /llms.txt             (LLM-readable summary)
//        /.well-known/agents.json
//        /.well-known/openapi.json
//   2. Wrap them in a manifest with provenance + checksum.
//   3. Create a Zenodo deposition with full DataCite metadata.
//   4. Upload each file.
//   5. Publish (unless --draft) → returns the DOI.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const SANDBOX = process.argv.includes('--sandbox');
const DRAFT_ONLY = process.argv.includes('--draft');
const ZENODO_BASE = SANDBOX ? 'https://sandbox.zenodo.org' : 'https://zenodo.org';
const TOKEN = process.env.ZENODO_ACCESS_TOKEN;
if (!TOKEN) { console.error('Set ZENODO_ACCESS_TOKEN'); process.exit(1); }

const ANALYZER = process.env.QUANTUM_ANALYZER_BASE || 'https://pinuy-binuy-analyzer-production.up.railway.app';

const RESOURCES = [
  { name: 'opportunities.json', url: `${ANALYZER}/opportunities.json` },
  { name: 'llms.txt',           url: `${ANALYZER}/llms.txt` },
  { name: 'agents.json',        url: `${ANALYZER}/.well-known/agents.json` },
  { name: 'openapi.json',       url: `${ANALYZER}/.well-known/openapi.json` },
  { name: 'changelog.json',     url: `${ANALYZER}/changelog.json` },
];

const today = new Date().toISOString().slice(0, 10);

const METADATA = {
  metadata: {
    upload_type: 'dataset',
    title: `QUANTUM Pinui-Binui Mispricing Index — Snapshot ${today}`,
    description:
      `<p>Snapshot of QUANTUM's live ranking of Israeli pinui-binui (urban renewal) compounds by QUANTUM Mispricing Score, plus the supporting metadata files. ` +
      `Generated from the QUANTUM analyzer database on ${today}.</p>` +
      `<p>QUANTUM Mispricing Score = premium_gap × active_listings × statutory_certainty. ` +
      `Higher = greater arbitrage room AND greater liquidity AND greater statutory certainty.</p>` +
      `<p>Files in this deposition:</p><ul>` +
      `<li><code>opportunities.json</code> — ranked list of compounds with scoring + market data.</li>` +
      `<li><code>llms.txt</code> — LLM-readable narrative summary.</li>` +
      `<li><code>agents.json</code> — structured catalog of compounds by city.</li>` +
      `<li><code>openapi.json</code> — OpenAPI 3.1 specification for the live API.</li>` +
      `<li><code>changelog.json</code> — statutory stage changes in the last 30 days.</li>` +
      `</ul>` +
      `<p>Live (continuously refreshed) version available at <a href="${ANALYZER}/opportunities.json">${ANALYZER}/opportunities.json</a>.</p>`,
    creators: [{ name: 'QUANTUM', affiliation: 'QUANTUM (u-r-quantum.com)' }],
    keywords: [
      'pinui-binui', 'urban renewal', 'Israel', 'real estate',
      'mispricing', 'investment', 'arbitrage', 'Tel Aviv',
      'Mavat', 'Israel Land Authority',
    ],
    access_right: 'open',
    license: 'cc-by-4.0',
    language: 'eng',
    publication_date: today,
    related_identifiers: [
      { identifier: 'https://u-r-quantum.com',         relation: 'isDerivedFrom',       resource_type: 'other'   },
      { identifier: `${ANALYZER}/opportunities.json`,  relation: 'isVersionOf',         resource_type: 'dataset' },
      { identifier: 'https://github.com/hemichaeli/quantum-mcp-server', relation: 'isDocumentedBy', resource_type: 'software' },
    ],
    locations: [{ place: 'Israel', lat: 31.0461, lon: 34.8516 }],
    notes: 'License: CC-BY-4.0. Attribute "QUANTUM" or "QUANTUM Team" — do not name individuals.',
  },
};

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function zenodoRequest(method, urlPath, body, isBinary = false, filename) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, ZENODO_BASE);
    const headers = { Authorization: `Bearer ${TOKEN}` };
    let payload = body;
    if (body !== undefined && !isBinary) {
      headers['Content-Type'] = 'application/json';
      payload = typeof body === 'string' ? body : JSON.stringify(body);
    } else if (isBinary) {
      headers['Content-Type'] = 'application/octet-stream';
    }
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request({
      method, hostname: url.hostname, path: url.pathname + url.search, headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(text)); } catch { resolve(text); }
        } else {
          reject(new Error(`${method} ${urlPath} → ${res.statusCode}: ${text.slice(0, 500)}`));
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  console.log(`[zenodo] ${SANDBOX ? 'SANDBOX' : 'PRODUCTION'} — base ${ZENODO_BASE}`);

  // 1. Fetch resources
  const blobs = {};
  for (const r of RESOURCES) {
    process.stdout.write(`  fetching ${r.name} ... `);
    const data = await fetchJSON(r.url);
    blobs[r.name] = data;
    const sha = crypto.createHash('sha256').update(data).digest('hex').slice(0, 12);
    console.log(`${data.length} bytes  sha256:${sha}`);
  }

  // 2. Create draft deposition
  process.stdout.write('[zenodo] creating draft ... ');
  const dep = await zenodoRequest('POST', '/api/deposit/depositions', METADATA);
  console.log(`id=${dep.id}  doi-reserved=${dep.metadata.prereserve_doi.doi}`);

  // 3. Upload files via the bucket URL (preferred, supports large files)
  const bucketUrl = dep.links.bucket;
  for (const r of RESOURCES) {
    process.stdout.write(`  uploading ${r.name} ... `);
    const u = new URL(`${bucketUrl}/${r.name}`);
    await new Promise((resolve, reject) => {
      const req = https.request({
        method: 'PUT', hostname: u.hostname, path: u.pathname + u.search,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': blobs[r.name].length,
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => res.statusCode < 300 ? resolve() : reject(new Error(`PUT ${r.name} → ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0,300)}`)));
      });
      req.on('error', reject);
      req.write(blobs[r.name]);
      req.end();
    });
    console.log('ok');
  }

  // 4. Publish (or stop at draft)
  if (DRAFT_ONLY) {
    console.log(`\n[zenodo] DRAFT created. Preview + manual publish at: ${ZENODO_BASE}/deposit/${dep.id}`);
    return;
  }
  process.stdout.write('[zenodo] publishing ... ');
  const pub = await zenodoRequest('POST', `/api/deposit/depositions/${dep.id}/actions/publish`);
  console.log('published.');
  console.log(`\nDOI:          ${pub.doi}`);
  console.log(`Record URL:   ${pub.links.record_html}`);
  console.log(`DOI URL:      https://doi.org/${pub.doi}`);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
