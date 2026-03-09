// start.js - Combined startup script with auto-fix for base64-encoded files
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ============================================================
// Phase 1: Fix base64-encoded .js files (caused by bad commits)
// ============================================================
console.log('[START] Checking for base64-encoded files...');

function isBase64Encoded(content) {
  const first100 = content.substring(0, 100);
  if (/^(\s*(\/\*|\/\/|const |var |let |import |module|'|"|require|\(|\{|class ))/.test(first100)) {
    return false;
  }
  const first80noNewline = first100.replace(/[\r\n]/g, '').substring(0, 80);
  return /^[A-Za-z0-9+/=]{60,}$/.test(first80noNewline);
}

function fixBase64Files(dir) {
  let fixed = 0;
  if (!fs.existsSync(dir)) return fixed;
  
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      if (isBase64Encoded(content)) {
        const decoded = Buffer.from(content.trim(), 'base64').toString('utf8');
        if (/^(\s*(\/\*|\/\/|const |var |let |import |module|'|"|require))/.test(decoded.substring(0, 50))) {
          fs.writeFileSync(filePath, decoded, 'utf8');
          console.log(`[START] FIXED base64: ${file} (${content.length} -> ${decoded.length} bytes)`);
          fixed++;
        } else {
          console.log(`[START] WARNING: ${file} appears base64 but decoded content doesn't look like JS`);
        }
      }
    } catch (err) {
      console.log(`[START] Error checking ${file}: ${err.message}`);
    }
  }
  return fixed;
}

let totalFixed = 0;
totalFixed += fixBase64Files(path.join(__dirname, 'src', 'routes'));
totalFixed += fixBase64Files(path.join(__dirname, 'src', 'services'));
totalFixed += fixBase64Files(path.join(__dirname, 'src', 'jobs'));
totalFixed += fixBase64Files(path.join(__dirname, 'src'));

if (totalFixed > 0) {
  console.log(`[START] Fixed ${totalFixed} base64-encoded file(s)`);
} else {
  console.log('[START] All files OK - no base64 issues');
}

// ============================================================
// Phase 1.5: Restore Bloomberg Terminal HTML template from gz.b64
// ============================================================
const templateB64Path = path.join(__dirname, 'public', 'dashboard-template.html.gz.b64');
const templateHtmlPath = path.join(__dirname, 'public', 'dashboard-template.html');

if (fs.existsSync(templateB64Path)) {
  try {
    const b64Content = fs.readFileSync(templateB64Path, 'utf8').trim();
    const gzBuffer = Buffer.from(b64Content, 'base64');
    const htmlContent = zlib.gunzipSync(gzBuffer).toString('utf8');
    fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });
    fs.writeFileSync(templateHtmlPath, htmlContent, 'utf8');
    console.log(`[START] Restored dashboard template: ${htmlContent.length} bytes`);
  } catch (err) {
    console.log(`[START] ERROR restoring dashboard template: ${err.message}`);
  }
} else {
  console.log('[START] No dashboard template gz.b64 found - skipping');
}

// ============================================================
// Phase 1.6: Decompress .js.gz.b64 files in src/routes/
// ============================================================
console.log('[START] Checking for .js.gz.b64 compressed route files...');
function decompressGzB64Routes(dir) {
  let restored = 0;
  if (!fs.existsSync(dir)) return restored;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js.gz.b64'));
  for (const file of files) {
    const b64Path = path.join(dir, file);
    const jsPath = path.join(dir, file.replace('.gz.b64', ''));
    try {
      const b64Content = fs.readFileSync(b64Path, 'utf8').trim();
      const gzBuffer = Buffer.from(b64Content, 'base64');
      const jsContent = zlib.gunzipSync(gzBuffer).toString('utf8');
      // Phase 1.6b: Fix literal newlines in alert strings (SyntaxError patch)
      let fixedContent = jsContent;
      if (file.includes('dashboardRoute.js.gz.b64')) {
        const before = fixedContent.length;
        // Fix literal newlines inside alert() string literals
        fixedContent = fixedContent.replace(/alert\('([^']*?)\n([^']*?)'/g, (m, a, b) => `alert('${a}\\n${b}'`);
        // More robust: fix all literal newlines inside single-quoted strings in alert calls
        fixedContent = fixedContent.replace(/alert\('((?:[^'\\]|\\.)*)'/gs, (match, inner) => {
          return `alert('${inner.replace(/\n/g, '\\n')}')`;
        });
        if (fixedContent.length !== before) console.log('[START] Applied SyntaxError patch to dashboardRoute.js');
      }
      fs.writeFileSync(jsPath, fixedContent, 'utf8');
      console.log(`[START] Decompressed ${file} -> ${path.basename(jsPath)} (${fixedContent.length} bytes)`);
      restored++;
    } catch (err) {
      console.log(`[START] ERROR decompressing ${file}: ${err.message}`);
    }
  }
  return restored;
}

const routesRestored = decompressGzB64Routes(path.join(__dirname, 'src', 'routes'));
if (routesRestored > 0) {
  console.log(`[START] Restored ${routesRestored} compressed route file(s)`);
} else {
  console.log('[START] No .js.gz.b64 route files found - skipping');
}

// ============================================================
// Phase 2: Legacy fix-escapes - DISABLED (v4.43.0+)
// ============================================================
console.log('[START] fix-escapes: Skipped (legacy mode disabled)');

// ============================================================
// Phase 3: Start server
// ============================================================
console.log('[START] Starting server...');
require('./src/index.js');

// ============================================================
// Phase 4: Missed scan detection (30s after startup)
// ============================================================
setTimeout(async () => {
  try {
    const { checkMissedScans } = require('./src/jobs/missedScanDetector');
    await checkMissedScans();
  } catch (err) {
    console.log('[START] Missed scan check failed:', err.message);
  }
}, 30000);
