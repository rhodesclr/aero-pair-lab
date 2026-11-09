# Daily on-chain history for Aero / old Aerodrome pools on Base, read from Aero's LP Sugar contract at each day's
# 00:00 UTC block (Base public RPCs serve historical state). Used by the LP Simulator backtest so AERO rewards and
# your share of fees follow what each pool actually paid / held on each day, instead of today's numbers.
#   ../hist.json = {"days": [unix day, ...], "p": {pool: [[emAeroPerDay, stakedL, activeL, stakedA, stakedB, reserveA, reserveB] | null, ...]}}
# stakedA / stakedB / reserveA / reserveB are token amounts (used for basic pools), oriented to the app's a/b order.
import json, os, sys, time, datetime as dt, urllib.request, concurrent.futures as cf
from aero_rewards import sugar_all, decimals
DAY = 86400
KEEP = int(os.environ.get('HIST_DAYS', '400'))      # how far back to keep
MAXNEW = int(os.environ.get('HIST_MAXNEW', '6'))    # days to backfill per run (the hourly job keeps it short)
EXTRA = {'0x3f5bf3edac59d650d8fdf9657a71f2f904a3a4ee': 'AERO', '0x311935cd80b76769bf2ecc9d8ab7635b2139cf82': 'SOL'}

def rpc(m, p):
    for url in ('https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base.drpc.org'):
        try:
            r = urllib.request.Request(url, data=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': m, 'params': p}).encode(), headers={'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'})
            return json.load(urllib.request.urlopen(r, timeout=20))['result']
        except Exception: time.sleep(1)
    raise RuntimeError('rpc failed')

def r4(x): return None if x is None else float(f'{x:.5g}')

D = json.load(open('../data.json'))
sym = {a['addr'].lower(): a['sym'] for a in D['assets'] if a.get('addr')}
sym.update(EXTRA)
want = {p['addr'].lower(): p for p in D['pools'] if p.get('chain', 'base') == 'base' and p['venue'] in ('aero', 'legacy')}
try: H = json.load(open('../hist.json'))
except Exception: H = {'days': [], 'p': {}}
have = {d: i for i, d in enumerate(H['days'])}
none = set(H.get('none', []))  # days before the Sugar contract existed: don't retry
old = {k: {H['days'][i]: v for i, v in enumerate(vs) if v is not None} for k, vs in H['p'].items()}

bn = int(rpc('eth_blockNumber', []), 16)
bts = int(rpc('eth_getBlockByNumber', [hex(bn), False])['timestamp'], 16)
today = int(time.time()) // DAY
todo = [today] + [d for d in range(today - 1, today - KEEP, -1) if d not in have and d not in none][:MAXNEW]
print('hist: have', len(have), 'days, fetching', len(todo))

_ts = {bn: bts}
def bts_of(b):
    if b not in _ts: _ts[b] = int(rpc('eth_getBlockByNumber', [hex(b), False])['timestamp'], 16)
    return _ts[b]

def block_at(t):
    # last block with timestamp <= t. Block time is not fixed (Base went from 2s to 0.2s blocks in Nov 2026),
    # so search on real block timestamps: secant steps inside a shrinking bracket, a few calls per day.
    lo, hi = 1, bn
    if t >= bts: return bn
    tlo = bts_of(lo)
    if t < tlo: return 0
    for _ in range(60):
        if hi - lo <= 1: return lo
        thi = bts_of(hi)
        g = lo + int((t - tlo) * (hi - lo) / max(1, thi - tlo))
        g = min(hi - 1, max(lo + 1, g))
        tg = bts_of(g)
        if tg <= t:
            lo, tlo = g, tg
            if tg == t: return g
            # nudge: probe just above to shrink fast when the slope is right
            g2 = min(hi - 1, g + max(1, (hi - g) // 64))
            if bts_of(g2) > t: hi = g2
            else: lo, tlo = g2, bts_of(g2)
        else:
            hi = g
            g2 = max(lo + 1, g - max(1, (g - lo) // 64))
            if bts_of(g2) <= t: lo, tlo = g2, bts_of(g2)
            else: hi = g2
    return lo

def snap(d):
    blk = block_at(d * DAY) if d < today else 'latest'
    if isinstance(blk, int) and blk < 1: return d, None
    try: rows = sugar_all(block=blk)
    except ValueError: return d, 'none'  # contract not there yet at that block
    except Exception as e: print('hist day failed', d, e); return d, None
    if not rows: return d, None
    out = {}
    for q in rows:
        k = q['lp'].lower()
        if k not in want: continue
        p = want[k]
        s0, s1 = sym.get(q['t0'].lower()), sym.get(q['t1'].lower())
        aIs0 = s0 == p['a'] or (s1 != p['a'] and s0 != p['b'])
        try: d0, d1 = decimals(q['t0']), decimals(q['t1'])
        except Exception: d0 = d1 = 18
        st0, st1 = q['staked0'] / 10 ** d0, q['staked1'] / 10 ** d1
        rs0, rs1 = q['reserve0'] / 10 ** d0, q['reserve1'] / 10 ** d1
        em = q['emissions'] / 1e18 * DAY if q['alive'] else 0.0
        out[k] = [r4(em), r4(float(q['gaugeL'])), r4(float(q['liquidity'])), r4(st0 if aIs0 else st1), r4(st1 if aIs0 else st0), r4(rs0 if aIs0 else rs1), r4(rs1 if aIs0 else rs0)]
    return d, out

got = {}
with cf.ThreadPoolExecutor(3) as ex:
    for d, out in ex.map(snap, todo):
        if out == 'none': none.add(d)
        elif out: got[d] = out
# today's snapshot is refreshed every run; past days are fixed once fetched
for d, out in got.items():
    for k, v in out.items(): old.setdefault(k, {})[d] = v
days = sorted({d for v in old.values() for d in v} | set(got))
days = [d for d in days if d > today - KEEP]
idx = {d: i for i, d in enumerate(days)}
P = {}
for k, m in old.items():
    if k not in want: continue
    arr = [None] * len(days)
    for d, v in m.items():
        if d in idx: arr[idx[d]] = v
    if any(arr): P[k] = arr
if none:  # the contract didn't exist before the latest failing day, so every earlier day is empty too
    cut = max(none)
    if not any(d < cut for d in days): none |= set(range(today - KEEP, cut))
json.dump({'days': days, 'p': P, 'today': today, 'none': sorted(x for x in none if x > today - KEEP)}, open('../hist.json', 'w'), separators=(',', ':'))
print('hist: days', len(days), 'pools', len(P), 'first', dt.datetime.fromtimestamp(days[0] * DAY, dt.timezone.utc).date() if days else None)
