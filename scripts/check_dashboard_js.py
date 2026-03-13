#!/usr/bin/env python3
"""
Pre-commit syntax checker for dashboardRoute.js
Run: python3 scripts/check_dashboard_js.py
"""
import re, subprocess, tempfile, os, sys

files_to_check = [
    'src/routes/dashboardRoute.js',
    'src/routes/campaignDashboardRoute.js',
]

all_ok = True
for filepath in files_to_check:
    if not os.path.exists(filepath):
        continue
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    match = re.search(r'<script>(.*?)</script>', content, re.DOTALL)
    if not match:
        continue

    js = match.group(1)
    with tempfile.NamedTemporaryFile(mode='w', suffix='.js', delete=False, encoding='utf-8') as f:
        f.write(js)
        fname = f.name

    result = subprocess.run(['node', '--check', fname], capture_output=True, text=True)
    os.unlink(fname)

    if result.returncode != 0:
        print(f"FAIL JS syntax error in {filepath}:")
        print(result.stderr)
        all_ok = False
    else:
        print(f"OK {filepath} JS syntax OK")

sys.exit(0 if all_ok else 1)
