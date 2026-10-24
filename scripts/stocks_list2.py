import json,urllib.request,time,concurrent.futures as cf
def get(u):
    r=urllib.request.Request(u,headers={'User-Agent':'Mozilla/5.0'})
    return json.load(urllib.request.urlopen(r,timeout=30))
toks=json.load(open('cb_stocks.json'))
def f(t):
    for k in range(3):
        try: return t, get("https://api.dexscreener.com/token-pairs/v1/base/"+t['contract_address'])
        except Exception as e: time.sleep(2)
    return t,[]
res={}
with cf.ThreadPoolExecutor(4) as ex:
    for t,d in ex.map(f,toks):
        res[t['symbol']]=[p for p in d if p.get('dexId') in ('aerodrome','aero')]
json.dump(res,open('aero_stock_pools.json','w'))
rows=[]
for s,ps in res.items():
    if not ps: continue
    liq=sum((p.get('liquidity') or {}).get('usd',0) or 0 for p in ps)
    vol=sum((p.get('volume') or {}).get('h24',0) or 0 for p in ps)
    rows.append((liq,vol,s,[p['baseToken']['symbol']+'/'+p['quoteToken']['symbol']+str(p.get('labels') or '') for p in ps][:4]))
rows.sort(reverse=True)
for r in rows: print(f"{r[2]:8} {r[0]:>12,.0f} {r[1]:>12,.0f} {r[3]}")
print(len(rows))
