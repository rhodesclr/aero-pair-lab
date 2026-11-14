# Quick health check for the site files. Run from the repo root:  python3 scripts/check.py
# The hourly workflow runs it before every deploy; if it fails, the site keeps its last good version.
# Checks: the JavaScript parses, the Python scripts compile, and data.json / hist.json have the shape the app expects.
import json, os, shutil, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
bad = []
def fail(msg): bad.append(msg); print('FAIL', msg)

# 1) JavaScript syntax (needs Node, which GitHub's runners have)
if shutil.which('node'):
    for f in ('app.js', 'sim.js', 'live.js', 'sw.js'):
        r = subprocess.run(['node', '--check', os.path.join(ROOT, f)], capture_output=True, text=True)
        if r.returncode: fail(f'{f} does not parse: {r.stderr.strip()[:300]}')
else:
    print('skip  JavaScript check (node not installed)')

# 2) Python scripts compile
for f in sorted(os.listdir(os.path.join(ROOT, 'scripts'))):
    if f.endswith('.py'):
        try: compile(open(os.path.join(ROOT, 'scripts', f)).read(), f, 'exec')
        except SyntaxError as e: fail(f'scripts/{f} line {e.lineno}: {e.msg}')

# 3) data.json shape
try:
    D = json.load(open(os.path.join(ROOT, 'data.json')))
    syms = {a['sym'] for a in D['assets']}
    if len(syms) < 60: fail(f'data.json has only {len(syms)} assets')
    if len(D['pools']) < 300: fail(f"data.json has only {len(D['pools'])} pools")
    for k in ('daily', 'hourly'):
        pr = D[k]['prices']; lens = {len(v) for v in pr.values()}
        if len(lens) != 1: fail(f'{k} price arrays have different lengths {sorted(lens)[:5]}')
        odd = (syms - set(pr) - {'USDC'}) | (set(pr) - syms)  # USDC is the $1 base and has no price row
        if odd: fail(f'{k} prices / assets mismatch: {sorted(odd)[:8]}')
    for p in D['pools']:
        if p['a'] not in syms or p['b'] not in syms: fail(f"pool {p['addr']} uses unknown asset {p['a']}/{p['b']}"); break
    print('data.json', len(syms), 'assets', len(D['pools']), 'pools, generated', time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime(D['generated'])))
except Exception as e:
    fail(f'data.json unreadable: {e}')

# 4) hist.json shape (simulator's daily on-chain history)
try:
    H = json.load(open(os.path.join(ROOT, 'hist.json')))
    n = len(H['days'])
    if any(len(v) != n for v in H['p'].values()): fail('hist.json rows do not match its day list')
    print('hist.json', n, 'days', len(H['p']), 'pools')
except Exception as e:
    fail(f'hist.json unreadable: {e}')

print('OK' if not bad else f'{len(bad)} problem(s)')
sys.exit(1 if bad else 0)
