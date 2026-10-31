# AERO reward APR per Aero pool, read from Aero's LP Sugar contract on Base (the same contract the Aero app uses).
# Pool-level APR follows the Aero app's formula:
#   AERO/sec x AERO price x seconds/year  /  USD value of gauge-staked liquidity
#   (Slipstream: staked L priced over the app's reference width for that tick spacing; basic pools: staked reserves).
import json, urllib.request
from pool_fees import call

LP_SUGAR = '0x082965f28c1aF8c7e236F8A8909596B01D8C6e72'
# Aero LP Sugar per chain (from the Aero app's config)
SUGARS = {'base': LP_SUGAR, 'optimism': '0x81538A32F7C98796132dE4F700EAbDbE773BE5BE', 'robinhood': '0x548245396B5a74c416590580434b9E4bc4CFe3b6'}
CHAIN_ID = {'base': 8453, 'optimism': 10, 'robinhood': 4663}
NEW_AERO = '0x3f5bf3edac59d650d8fdf9657a71f2f904a3a4ee'
WIDTH_BPS = {1: 10, 10: 50, 50: 300, 100: 500, 150: 750, 200: 1000, 250: 1250}
Q96 = 2 ** 96
YEAR = 365 * 86400
_dec = {}

def _int(w, signed=False):
    v = int(w, 16)
    return v - (1 << 256) if signed and v >= 1 << 255 else v

def sugar(addr, window=86400, chain='base'):
    r = call(SUGARS[chain], '0xa773f925' + addr[2:].lower().rjust(64, '0') + hex(window)[2:].rjust(64, '0'), chain)
    if not r or r == 'ERR' or len(r) < 66 * 40: return None
    w = [r[2 + i * 64: 2 + (i + 1) * 64] for i in range((len(r) - 2) // 64)]
    b = _int(w[0]) // 32  # offset of the tuple
    f = lambda i, s=False: _int(w[b + i], s)
    a = lambda i: '0x' + w[b + i][-40:]
    return dict(liquidity=f(3), type=f(4, True), tick=f(5, True), sqrt=f(6), t0=a(7), staked0=f(9), t1=a(10), staked1=f(12),
                gauge=a(13), gaugeL=f(14), alive=bool(f(15)), emissions=f(18), etoken=a(19), poolFee=f(21), unstakedFee=f(22))

def decimals(t, chain='base'):
    k = (chain, t.lower())
    if k not in _dec:
        r = call(t, '0x313ce567', chain)
        _dec[k] = int(r, 16) if r and r != 'ERR' else 18
    return _dec[k]

def aero_usd():
    try:
        req = urllib.request.Request('https://api.dexscreener.com/latest/dex/tokens/' + NEW_AERO, headers={'User-Agent': 'Mozilla/5.0'})
        ps = [p for p in json.load(urllib.request.urlopen(req, timeout=20)).get('pairs') or [] if p['baseToken']['address'].lower() == NEW_AERO]
        ps.sort(key=lambda p: -((p.get('liquidity') or {}).get('usd') or 0))
        return float(ps[0]['priceUsd']) if ps else None
    except Exception:
        return None

def pool_rewards(addr, usd_by_token, aero, chain='base'):
    """usd_by_token: {lowercase token address: USD price}. Returns dict or None."""
    s = sugar(addr, chain=chain)
    if not s: return None
    out = dict(gauge=s['alive'] and s['gauge'] != '0x' + '0' * 40, ufee=s['unstakedFee'] / 1e6)
    if s['liquidity'] > 0 and s['type'] > 0: out['staked'] = round(s['gaugeL'] / s['liquidity'], 4)
    em = s['emissions'] / 1e18
    out['em'] = round(em * 86400, 2)  # AERO per day to this pool
    u0, u1 = usd_by_token.get(s['t0'].lower()), usd_by_token.get(s['t1'].lower())
    if not aero or not em or not out['gauge']:
        out['rapr'] = 0.0 if aero else None
        return out
    if s['type'] > 0:
        if u1 is None: return out
        c = WIDTH_BPS.get(s['type'], 300)
        val = s['gaugeL'] * s['sqrt'] * c / (Q96 * 10000) / 10 ** decimals(s['t1'], chain) * u1
    else:
        if u0 is None or u1 is None: return out
        val = s['staked0'] / 10 ** decimals(s['t0'], chain) * u0 + s['staked1'] / 10 ** decimals(s['t1'], chain) * u1
    out['rapr'] = round(em * aero * YEAR / val, 4) if val > 0 else None
    return out

# ---------- full Aero pool list (catches pools DEX Screener doesn't index, e.g. Aero basic pools) ----------
FIELDS = ['lp', 'symbol', 'decimals', 'liquidity', 'type', 'tick', 'sqrt', 't0', 'reserve0', 'staked0', 't1', 'reserve1', 'staked1', 'gauge', 'gaugeL',
          'alive', 'rewardsManager', 'factory', 'emissions', 'etoken', 'cap', 'poolFee', 'unstakedFee', 'f0', 'f1', 'createdAt', 'nfpm', 'wStart', 'wEnd',
          'openTick', 'closeTick', 'swaps', 'vol0', 'vol1', 'fee0', 'fee1', 'mev0', 'mev1', 'mevf0', 'mevf1']
ADDR = {'lp', 't0', 't1', 'gauge', 'rewardsManager', 'factory', 'etoken', 'nfpm'}
SIGNED = {'type', 'tick', 'openTick', 'closeTick'}

def _decode_lps(r):
    w = [r[2 + i * 64: 2 + (i + 1) * 64] for i in range((len(r) - 2) // 64)]
    arr = int(w[0], 16) // 32
    n = int(w[arr], 16)
    out = []
    for k in range(n):
        b = arr + 1 + int(w[arr + 1 + k], 16) // 32
        d = {}
        for i, f in enumerate(FIELDS):
            if f == 'symbol': continue
            d[f] = '0x' + w[b + i][-40:] if f in ADDR else _int(w[b + i], f in SIGNED)
        d['alive'] = bool(d['alive'])
        out.append(d)
    return out

SEL_ALL = '0x814b0f0c'
def sugar_all(page=25, chain='base'):
    cnt = call(SUGARS[chain], '0x06661abd', chain)  # count()
    n = int(cnt, 16) if cnt and cnt != 'ERR' else 0
    res = []
    for off in range(0, n, page):
        r = call(SUGARS[chain], SEL_ALL + hex(page)[2:].rjust(64, '0') + hex(off)[2:].rjust(64, '0') + hex(86400)[2:].rjust(64, '0') + '0'.rjust(64, '0'), chain)
        if r and r != 'ERR': res += _decode_lps(r)
    return res
