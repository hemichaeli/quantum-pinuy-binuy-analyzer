// start.js - Combined startup script with auto-fix for base64-encoded files
const fs = require('fs');
const path = require('path');

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
// Phase 2: Legacy fix-escapes - DISABLED (v4.43.0+)
// The fix-escapes phase was corrupting valid template literal
// escape sequences in dashboardRoutes.js. No longer needed.
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
