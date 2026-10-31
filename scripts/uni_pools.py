# Uniswap (v2/v3/v4) pools on Base, Optimism and Robinhood Chain whose two tokens are both coins in the app.
# Robinhood Chain stock tokens map to the same stock as the Coinbase token (AAPL -> AAPLc); USDG counts as the dollar side.
import json, re, time, urllib.request, concurrent.futures as cf
def get(u):
    for k in range(4):
        try:
            r = urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'})
            return json.load(urllib.request.urlopen(r, timeout=30))
        except Exception as e:
            last = e; time.sleep(2 * (k + 1))
    raise last
ZERO = '0x0000000000000000000000000000000000000000'
STOCKS = re.search(r"STOCKS='([^']+)'", open('build.py').read()).group(1).split()
cb = {x['symbol']: x for x in json.load(open('cb_stocks.json'))}
cp = json.load(open('crypto_pools.json'))
TOK = {'base': {}, 'optimism': {}, 'robinhood': {}}
SYMS = set(STOCKS) | set(cp['meta'].keys())
for s, (n, a, cg) in cp['meta'].items(): TOK['base'][a.lower()] = s
for s, ads in (cp.get('extra') or {}).items():
    for a in ads: TOK['base'][a.lower()] = s
for s in STOCKS:
    if s in cb: TOK['base'][cb[s]['contract_address'].lower()] = s
for c in TOK: TOK[c][ZERO] = 'ETH'
TOK['optimism'].update({
    '0x4200000000000000000000000000000000000006': 'ETH',
    '0x0b2c639c533813f4aa9d7837caf62653d097ff85': 'USDC',
    '0x7f5c764cbc14f9669b88837ca1490cca17c31607': 'USDC',  # USDC.e (bridged)
    '0x68f180fcce6836688e9084f035309e29bf0a2095': 'BTC',   # WBTC
    '0x350a791bfc2c21f9ed5d10980dad2e2638ffa7f6': 'LINK',
    '0x76fb31fb4af56892a25e32cfc43de717950c9278': 'AAVE',
})
TOK['robinhood'].update({
    '0x0bd7d308f8e1639fab988df18a8011f41eacad73': 'ETH',   # Robinhood Wrapped ETH
    '0x5fc5360d0400a0fd4f2af552add042d716f1d168': 'USDC',  # USDG (Paxos Global Dollar) as the dollar side
})
# Robinhood Chain stock tokens: find each app stock's Robinhood token by its ticker
def find_rh(s):
    y = s[:-1]
    for q in (y + ' USDG', y + ' WETH'):
        try: d = get('https://api.dexscreener.com/latest/dex/search?q=' + urllib.parse.quote(q))
        except Exception: continue
        for p in d.get('pairs') or []:
            if p.get('chainId') != 'robinhood': continue
            for side in ('baseToken', 'quoteToken'):
                t = p[side]
                if t['symbol'] == y and 'robinhood' in t['name'].lower(): return s, t['address'].lower(), t['name']
        time.sleep(0.2)
    return s, None, None
import urllib.parse
with cf.ThreadPoolExecutor(4) as ex:
    for s, a, n in ex.map(find_rh, STOCKS):
        if a: TOK['robinhood'][a] = s; print('RH token', s, a, n)
# pools touching each token, kept when both sides are app coins
pools = {}
def pairs(item):
    chain, addr = item
    if addr == ZERO: return chain, []
    try: return chain, get(f'https://api.dexscreener.com/token-pairs/v1/{chain}/{addr}')
    except Exception: return chain, []
items = [(c, a) for c in TOK for a in TOK[c]]
STOCK = set(STOCKS)
with cf.ThreadPoolExecutor(4) as ex:
    for chain, d in ex.map(pairs, items):
        for p in d or []:
            if p.get('dexId') != 'uniswap' or p.get('chainId') != chain: continue
            ta, tb = p['baseToken']['address'].lower(), p['quoteToken']['address'].lower()
            a, b = TOK[chain].get(ta), TOK[chain].get(tb)
            if not a or not b or a == b: continue
            liq = (p.get('liquidity') or {}).get('usd', 0) or 0
            if liq < 2000: continue
            ver = (p.get('labels') or ['v2'])[0]
            sa, sb = p['baseToken']['symbol'], p['quoteToken']['symbol']
            base, quote = p['baseToken']['address'], p['quoteToken']['address']
            # orientation like the Aero pools: stock / crypto / USD
            if (b in STOCK and a not in STOCK) or a == 'USDC' or (a == 'ETH' and b != 'USDC'):
                a, b, sa, sb, base, quote = b, a, sb, sa, quote, base
                inv = True
            else: inv = False
            key = p['pairAddress']
            if key.lower() in pools: continue
            try: pn = float(p.get('priceNative') or 0)
            except Exception: pn = 0
            pools[key.lower()] = dict(addr=key, chain=chain, venue='uniswap', ver=ver, a=a, b=b, sa=sa, sb=sb, baseAddr=base, quoteAddr=quote,
                liq=round(liq), vol=round((p.get('volume') or {}).get('h24', 0) or 0), url=p['url'],
                app=f'https://app.uniswap.org/explore/pools/{chain}/{key}', label=ver)
        time.sleep(0.1)
print('uniswap pools', len(pools), {c: sum(p['chain'] == c for p in pools.values()) for c in TOK})
json.dump({'tokens': TOK, 'pools': list(pools.values())}, open('uni_pools.json', 'w'))
