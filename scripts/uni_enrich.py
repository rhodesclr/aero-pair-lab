# On-chain details for the Uniswap pools in uni_pools.json:
#  - finds extra v3 pools through each chain's v3 factory (the market-data index misses some, e.g. most Optimism v3 pools)
#  - fee tier, protocol fee cut, tick spacing, in-range liquidity, token order and decimals
#  - fee APR = 24h volume x LP fee x (1 - protocol cut) x 365 / TVL
import json, time, urllib.request
RPC = {'base': ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
       'optimism': ['https://optimism-rpc.publicnode.com'],
       'robinhood': ['https://rpc.mainnet.chain.robinhood.com']}
STATEVIEW = {'base': '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71', 'optimism': '0xc18a3169788f4f75a170290584eca6395c75ecdb',
             'robinhood': '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'}
V3F = {'base': '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', 'optimism': '0x1F98431c8aD98523631AE4a59f267346ea31F984',
       'robinhood': '0x1f7d7550b1b028f7571e69a784071f0205fd2efa'}
WETH = {'base': '0x4200000000000000000000000000000000000006', 'optimism': '0x4200000000000000000000000000000000000006',
        'robinhood': '0x0bd7d308f8e1639fab988df18a8011f41eacad73'}
ZERO = '0x' + '0' * 40
RH_BEACON = None  # set from the first verified Robinhood stock token

MC3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
def _post(chain, body):
    for k in range(8):
        u = RPC[chain][k % len(RPC[chain])]
        try:
            r = json.load(urllib.request.urlopen(urllib.request.Request(u, json.dumps(body).encode(), {'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'}), timeout=40))
            if 'result' in r: return r['result']
        except Exception: pass
        time.sleep(2 * (k + 1))
    return None

def batch(chain, calls, size=120):
    """calls: list of (to, data) -> list of hex results (None on revert), via Multicall3.aggregate3."""
    out = []
    for i in range(0, len(calls), size):
        part = calls[i:i + size]
        n = len(part)
        enc = [hex(32)[2:].rjust(64, '0'), hex(n)[2:].rjust(64, '0')]
        tails, off = [], 32 * n
        for to, data in part:
            d = data[2:]
            ln = len(d) // 2
            t = to.lower()[2:].rjust(64, '0') + '1'.rjust(64, '0') + hex(96)[2:].rjust(64, '0') + hex(ln)[2:].rjust(64, '0') + d.ljust(((ln + 31) // 32) * 64, '0')
            enc.append(hex(off)[2:].rjust(64, '0')); tails.append(t); off += len(t) // 2
        data = '0x82ad56cb' + ''.join(enc) + ''.join(tails)
        r = _post(chain, {'jsonrpc': '2.0', 'id': 1, 'method': 'eth_call', 'params': [{'to': MC3, 'data': data}, 'latest']})
        if not r or r == '0x': out += [None] * n; continue
        h = r[2:]
        W = lambda j: int(h[64 * j:64 * (j + 1)], 16)
        a = W(0) // 32
        m = W(a)
        for k in range(m):
            b = a + 1 + W(a + 1 + k) // 32
            ok = W(b); doff = b + W(b + 1) // 32; ln = W(doff)
            rd = h[64 * (doff + 1): 64 * (doff + 1) + 2 * ln]
            out.append('0x' + rd if ok and ln else None)
        time.sleep(0.3)
    return out

def raw(chain, method, params):
    return _post(chain, {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params})

def w(h, i): return int(h[2 + 64 * i: 2 + 64 * (i + 1)], 16)
def sw(h, i, bits=24):
    v = w(h, i) & ((1 << bits) - 1)
    return v - (1 << bits) if v >= 1 << (bits - 1) else v
def pad(a): return a.lower().replace('0x', '').rjust(64, '0')
def get(u):
    for k in range(4):
        try: return json.load(urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=30))
        except Exception: time.sleep(2 * (k + 1))
    return {}

U = json.load(open('uni_pools.json'))
TOK, pools = U['tokens'], U['pools']
TOK['robinhood'].update({'0xcec185eb182c47d1ba1efc84e6959e18cd620be4': 'BTC', '0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31': 'VIRTUAL'})
STOCKS = {s for c in TOK for s in TOK[c].values() if s.endswith('c')}

# 1) Robinhood stock tokens must be Robinhood's own (all share one beacon proxy); drop look-alikes
BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'
beac = {}
for a, s in TOK['robinhood'].items():
    if s in STOCKS:
        beac[a] = (raw('robinhood', 'eth_getStorageAt', [a, BEACON_SLOT, 'latest']) or '')[-40:]
from collections import Counter
main = Counter(beac.values()).most_common(1)[0][0] if beac else None
for a, b in beac.items():
    if b != main or int(b or '0', 16) == 0:
        print('dropping unverified Robinhood token', TOK['robinhood'][a], a); TOK['robinhood'].pop(a)
pools = [p for p in pools if not (p['chain'] == 'robinhood' and (TOK['robinhood'].get(p['baseAddr'].lower()) is None and p['baseAddr'].lower() != WETH['robinhood']))]

# 2) discover v3 pools on Optimism and Robinhood Chain via the factory
have = {p['addr'].lower() for p in pools}
FEES = [100, 500, 3000, 10000]
def disc_pairs(chain):
    toks = {}
    for a, s in TOK[chain].items():
        if a == ZERO: continue
        toks.setdefault(s, []).append(a)
    syms = sorted(toks)
    if chain == 'robinhood':  # stocks x (ETH, USDG) + ETH/USDG
        pr = [(x, y) for x in syms for y in ('ETH', 'USDC') if x != y and x not in ('ETH', 'USDC')] + [('ETH', 'USDC')]
    elif chain == 'optimism':
        pr = [(x, y) for i, x in enumerate(syms) for y in syms[i + 1:]]
    else: return []
    return [(ta, tb) for x, y in pr for ta in toks[x] for tb in toks[y]]
found = {}
for chain in ('optimism', 'robinhood'):
    prs = disc_pairs(chain)
    calls = [(V3F[chain], '0x1698ee82' + pad(ta) + pad(tb) + pad(hex(f))) for ta, tb in prs for f in FEES]
    res = batch(chain, calls)
    for r in res:
        if r and int(r, 16):
            a = '0x' + r[-40:]
            if a.lower() not in have: found.setdefault(chain, set()).add(a.lower())
    print('v3 factory', chain, len(prs), 'pairs ->', len(found.get(chain, [])), 'new pools')
STOCKSET = STOCKS
for chain, addrs in found.items():
    addrs = sorted(addrs)
    for i in range(0, len(addrs), 30):
        d = get(f'https://api.dexscreener.com/latest/dex/pairs/{chain}/' + ','.join(addrs[i:i + 30]))
        for p in d.get('pairs') or []:
            ta, tb = p['baseToken']['address'].lower(), p['quoteToken']['address'].lower()
            a, b = TOK[chain].get(ta), TOK[chain].get(tb)
            liq = (p.get('liquidity') or {}).get('usd', 0) or 0
            if not a or not b or a == b or liq < 2000: continue
            sa, sb, base, quote = p['baseToken']['symbol'], p['quoteToken']['symbol'], p['baseToken']['address'], p['quoteToken']['address']
            if (b in STOCKSET and a not in STOCKSET) or a == 'USDC' or (a == 'ETH' and b != 'USDC'):
                a, b, sa, sb, base, quote = b, a, sb, sa, quote, base
            key = p['pairAddress']
            pools.append(dict(addr=key, chain=chain, venue='uniswap', ver='v3', a=a, b=b, sa=sa, sb=sb, baseAddr=base, quoteAddr=quote,
                              liq=round(liq), vol=round((p.get('volume') or {}).get('h24', 0) or 0), url=p['url'],
                              app=f'https://app.uniswap.org/explore/pools/{chain}/{key}', label='v3', pn=p.get('priceNative')))
            have.add(key.lower())
        time.sleep(0.3)

# priceNative for existing pools (for v4 token-order check)
for chain in TOK:
    ps = [p for p in pools if p['chain'] == chain and 'pn' not in p]
    for i in range(0, len(ps), 30):
        d = get(f'https://api.dexscreener.com/latest/dex/pairs/{chain}/' + ','.join(p['addr'] for p in ps[i:i + 30]))
        m = {x['pairAddress'].lower(): x for x in d.get('pairs') or []}
        for p in ps[i:i + 30]:
            x = m.get(p['addr'].lower())
            if not x: continue
            pn = float(x.get('priceNative') or 0)
            # priceNative is quote per DEX Screener base; flip if we re-oriented
            p['pn'] = pn if x['baseToken']['address'].lower() == p['baseAddr'].lower() else (1 / pn if pn else 0)
        time.sleep(0.3)

# 3) decimals
dec = {}
for chain in TOK:
    ads = sorted({x.lower() for p in pools if p['chain'] == chain for x in (p['baseAddr'], p['quoteAddr'])} - {ZERO})
    for a, r in zip(ads, batch(chain, [(a, '0x313ce567') for a in ads])):
        dec[(chain, a)] = int(r, 16) if r else 18
def D(chain, a): return 18 if a.lower() == ZERO else dec.get((chain, a.lower()), 18)

# 4) per-pool state
for chain in TOK:
    ps = [p for p in pools if p['chain'] == chain]
    v4 = [p for p in ps if len(p['addr']) == 66]
    v23 = [p for p in ps if len(p['addr']) == 42]
    # v2/v3: token0, fee, tickSpacing, liquidity, slot0, getReserves
    sels = ['0x0dfe1681', '0xddca3f43', '0xd0c93a7c', '0x1a686502', '0x3850c7bd', '0x0902f1ac', '0xc45a0155']
    res = batch(chain, [(p['addr'], s) for p in v23 for s in sels])
    for i, p in enumerate(v23):
        t0, fee, ts, L, s0, rs, fac = res[i * 7:(i + 1) * 7]
        if not t0: p['bad'] = 1; continue
        t0 = '0x' + t0[-40:]
        p['t0'] = t0
        p['b0'] = t0.lower() == p['baseAddr'].lower()
        p['dec0'] = D(chain, p['baseAddr'] if p['b0'] else p['quoteAddr']); p['dec1'] = D(chain, p['quoteAddr'] if p['b0'] else p['baseAddr'])
        if fee and ts and s0:
            p['ver'] = p['label'] = 'v3'
            p['fee'] = w(fee, 0) / 1e6; p['ts'] = sw(ts, 0); p['kind'] = 'CL' + str(p['ts'])
            fp = w(s0, 5) & 0xff  # feeProtocol: token0 = low 4 bits, token1 = high 4 bits
            f0, f1 = fp & 15, fp >> 4
            p['ufee'] = round(((1 / f0) if f0 else 0) / 2 + ((1 / f1) if f1 else 0) / 2, 4)
            p['L'] = str(w(L, 0)) if L else '0'
        elif rs:
            p['ver'] = p['label'] = 'v2'; p['fee'] = 0.003; p['kind'] = 'volatile'
            p['ufee'] = 0
            if fac:
                ft = batch(chain, [('0x' + fac[-40:], '0x017e7e58')])[0]
                if ft and int(ft, 16): p['ufee'] = round(1 / 6, 4)
        else: p['bad'] = 1
    # v4 via StateView
    res = batch(chain, [(STATEVIEW[chain], s + p['addr'][2:]) for p in v4 for s in ('0xc815641c', '0xfa6793d5')])
    for i, p in enumerate(v4):
        s0, L = res[2 * i], res[2 * i + 1]
        if not s0 or w(s0, 0) == 0: p['bad'] = 1; continue
        sq = w(s0, 0); pf = w(s0, 2); lp = w(s0, 3)
        p['ver'] = p['label'] = 'v4'
        p['fee'] = (lp & 0x7fffff) / 1e6 if lp < 0x800000 else None  # dynamic-fee hooks report a flag
        p['ufee'] = round(((pf & 0xfff) + (pf >> 12)) / 2 / 1e6 / p['fee'], 4) if p['fee'] else 0
        p['ts'] = {100: 1, 500: 10, 3000: 60, 10000: 200}.get(lp)  # standard spacing for the fee tier (StateView doesn't expose it)
        p['kind'] = 'CL' + str(p['ts']) if p['ts'] else 'CL'; p['L'] = str(w(L, 0)) if L else '0'
        # token order: native ETH (address 0) sorts first; DEX Screener shows WETH for it
        ba, qa = p['baseAddr'].lower(), p['quoteAddr'].lower()
        db, dq = D(chain, ba), D(chain, qa)
        raw_p = (sq / 2 ** 96) ** 2
        cands = []
        for b0 in (True, False):
            pr = raw_p * 10 ** ((db - dq) if b0 else (dq - db))  # token1 per token0 in human units
            q_per_b = pr if b0 else (1 / pr if pr else 0)
            cands.append((abs(__import__('math').log((q_per_b or 1e-30) / (p.get('pn') or 1e-30))), b0))
        p['b0'] = min(cands)[1] if p.get('pn') else (ba < qa)
        p['dec0'], p['dec1'] = (db, dq) if p['b0'] else (dq, db)
        p['sqrt'] = str(sq)
    for p in ps:
        if p.get('fee') is not None and p['liq'] > 0:
            p['apr'] = round(p['vol'] * p['fee'] * (1 - (p.get('ufee') or 0)) * 365 / p['liq'], 4)
        else: p['apr'] = None
    print(chain, 'pools', len(ps), 'enriched', sum(p.get('fee') is not None for p in ps), 'bad', sum(1 for p in ps if p.get('bad')))
# v4 pools with a hook-controlled (dynamic) fee report 0 or a flag; their real fee can't be read, so leave them out
pools = [p for p in pools if not p.get('bad') and not (p['ver'] == 'v4' and not p.get('fee'))]
for p in pools: p.pop('pn', None); p.pop('sqrt', None)
json.dump({'tokens': TOK, 'pools': pools}, open('uni_pools.json', 'w'))
print('uniswap pools', len(pools))
