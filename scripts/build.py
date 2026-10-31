import json,urllib.request,time,math,datetime as dt
import os
def cget(u):
    import hashlib
    f='cache/'+hashlib.md5(u.encode()).hexdigest()+'.json'
    if os.path.exists(f): return json.load(open(f))
    d=get(u); json.dump(d,open(f,'w')); return d
def get(u):
    last=None
    for k in range(5):
        uu=u.replace('query1.','query2.') if (k%2 and 'query1.' in u) else u
        try:
            r=urllib.request.Request(uu,headers={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36','Accept':'application/json'})
            return json.load(urllib.request.urlopen(r,timeout=40))
        except Exception as e:
            last=e; time.sleep(3*(k+1))
    raise last
STOCKS='NVDAc GOOGLc MSTRc SNDKc MUc SPCXc AAPLc METAc AMZNc SKHYc NOKc PLTRc TSLAc ARMc SAPc INFYc BILIc BIDUc SONYc PDDc ULc SANc VALEc BUDc SEc NIOc WRDc MSFTc HSAIc LIc NVOc NFLXc AVGOc MRNAc CRWVc RDDTc WENc HIMSc AMDc ORCLc LLYc BEc GMEc TTWOc MRVLc CBRSc RKLBc BMNRc'.split()
cb={x['symbol']:x for x in json.load(open('cb_stocks.json'))}
spools=json.load(open('aero_stock_pools.json'))
cp=json.load(open('crypto_pools.json')); CM=cp['meta']; CM.pop('KAITO',None)
assets=[];daily={};hourly={}
DAY=86400
def r6(x): return None if x is None else float(f"{x:.6g}")
# stocks
for s in STOCKS:
    y=s[:-1]
    d=cget(f"https://query1.finance.yahoo.com/v8/finance/chart/{y}?range=1y&interval=1d")['chart']['result'][0]
    ts=d['timestamp']; adj=d['indicators'].get('adjclose',[{}])[0].get('adjclose') or d['indicators']['quote'][0]['close']
    daily[s]={ (t//DAY):r6(v) for t,v in zip(ts,adj) if v}
    h=cget(f"https://query1.finance.yahoo.com/v8/finance/chart/{y}?range=3mo&interval=60m")['chart']['result'][0]
    hourly[s]={ ((t+3600)//3600):r6(v) for t,v in zip(h['timestamp'],h['indicators']['quote'][0]['close']) if v}
    # last regular price as latest point (close of last bar)
    assets.append(dict(sym=s,name=cb[s]['name'],type='stock',icon=cb[s].get('icon_url'),under=y,addr=cb[s]['contract_address']))
    print(s,len(daily[s]),len(hourly[s])); time.sleep(0.3)
# crypto (Coinbase Exchange candles)
CM.pop('BRETT',None); CM.pop('wstETH',None)
CBP={'cbETH':'CBETH-USD','EURC':'EURC-USDC'}
def candles(prod,gran,n):
    end=int(time.time())//gran*gran; outc={}
    while n>0:
        k=min(300,n); st=end-k*gran
        u=f"https://api.exchange.coinbase.com/products/{prod}/candles?granularity={gran}&start={dt.datetime.utcfromtimestamp(st).isoformat()}&end={dt.datetime.utcfromtimestamp(end).isoformat()}"
        for t in range(4):
            try: rows=get(u); break
            except Exception as e: print('retry',prod,e); time.sleep(2)
        for r in rows: outc[r[0]]=r[4]
        end=st; n-=k; time.sleep(0.15)
    return outc
for s,(n,a,cg) in CM.items():
    if cg is None:
        assets.append(dict(sym=s,name=n,type='stable',icon=None,addr=a)); continue
    prod=CBP.get(s,s+'-USD')
    d=candles(prod,86400,366); h=candles(prod,3600,24*92)
    daily[s]={t//DAY:r6(v) for t,v in d.items()}
    hourly[s]={(t+3600)//3600:r6(v) for t,v in h.items()}
    assets.append(dict(sym=s,name=n,type='crypto',icon=None,addr=a,cg=cg))
    print(s,len(daily[s]),len(hourly[s]))
# pools
SYM={'WETH':'ETH','cbBTC':'BTC','cbXRP':'XRP','cbDOGE':'DOGE','cbADA':'ADA','cbLTC':'LTC','uSOL':'SOL','USDC':'USDC'}
uni={a['sym'] for a in assets}
def norm(x): x=SYM.get(x,x); return x if x in uni else None
pools={}
allp=[p for v in spools.values() for p in v]+[p for v in cp['pools'].values() for p in v]
for p in allp:
    a=norm(p['baseToken']['symbol']); b=norm(p['quoteToken']['symbol'])
    if not a or not b or a==b: continue
    pools[p['pairAddress']]=dict(addr=p['pairAddress'],a=a,b=b,liq=round((p.get('liquidity') or {}).get('usd',0) or 0),vol=round((p.get('volume') or {}).get('h24',0) or 0),url=p['url'],label=(p.get('labels') or [None])[0],venue=('aero' if p.get('dexId')=='aero' else 'legacy'))
# on-chain fee per pool -> fee APR = 24h volume x fee x 365 / TVL
from pool_fees import pool_fee
import concurrent.futures as _cf
def _fee(item):
    addr,p=item
    try: kind,fee,ts=pool_fee(addr)
    except Exception: kind,fee,ts=None,None,None
    p['kind']=('CL'+str(ts)) if kind=='CL' and ts else kind
    p['fee']=fee
    p['apr']=round(p['vol']*fee*365/p['liq'],4) if fee is not None and p['liq']>0 else None
with _cf.ThreadPoolExecutor(6) as _ex: list(_ex.map(_fee,pools.items()))
print('fees', sum(p['fee'] is not None for p in pools.values()),'/',len(pools))
# Aero pools straight from Aero's LP Sugar contract: adds pools DEX Screener doesn't index (e.g. Aero basic pools)
from aero_rewards import sugar_all, decimals
_sym={}
for x in assets:
    if x.get('addr'): _sym[x['addr'].lower()]=x['sym']
for s_,ads in (cp.get('extra') or {}).items():
    for ad in ads: _sym[ad.lower()]=s_
_last={s_:next((v for v in reversed([hourly[s_][k] for k in sorted(hourly[s_])]) if v),None) for s_ in hourly}
def _px(addr,sym):
    if sym=='USDC': return 1.0
    return _usd_pre.get(addr) or _last.get(sym)
_usd_pre={}
for p in allp:
    try:
        pu=float(p.get('priceUsd') or 0); pn=float(p.get('priceNative') or 0)
        if pu>0: _usd_pre.setdefault(p['baseToken']['address'].lower(),pu)
        if pu>0 and pn>0: _usd_pre.setdefault(p['quoteToken']['address'].lower(),pu/pn)
    except Exception: pass
_have={k.lower() for k in pools}
_added=0
try: _sp=sugar_all()
except Exception as e: _sp=[]; print('sugar_all failed',e)
for q in _sp:
    if q['lp'] in _have: continue
    sa,sb=_sym.get(q['t0']),_sym.get(q['t1'])
    if not sa or not sb or sa==sb: continue
    try:
        d0=decimals(q['t0']); d1=decimals(q['t1'])
        u0=_px(q['t0'],sa); u1=_px(q['t1'],sb)
        if u0 is None or u1 is None: continue
        liq=q['reserve0']/10**d0*u0+q['reserve1']/10**d1*u1
        if liq<1000: continue
        vol=(q['vol0']/2/10**d0*u0+q['vol1']/2/10**d1*u1) if q['wEnd']>q['wStart'] else 0
        cl=q['type']>0
        fee=q['poolFee']/1e6 if cl else q['poolFee']/1e4
    except Exception: continue
    # orientation like DEX Screener: USDC (then ETH) as quote, stock tokens as base
    a_,b_,ta,tb=sa,sb,q['t0'],q['t1']
    _st=lambda s_: any(x['sym']==s_ and x['type']=='stock' for x in assets)
    if (_st(b_) and not _st(a_)) or a_=='USDC' or (a_=='ETH' and b_!='USDC'):
        a_,b_,ta,tb=b_,a_,tb,ta
    pools[q['lp']]=dict(addr=q['lp'],a=a_,b=b_,baseAddr=ta,quoteAddr=tb,liq=round(liq),vol=round(vol),url='https://app.aero.xyz/deposit/8453-'+q['lp'],label=None,venue='aero',
        kind=('CL'+str(q['type'])) if cl else ('stable' if q['type']==0 else 'volatile'),fee=fee,apr=round(vol*fee*365/liq,4) if liq>0 else None,src='sugar')
    _added+=1
print('sugar pools added',_added)
# AERO reward APR (Aero pools only; legacy gauges stopped emitting at the Aero launch)
from aero_rewards import pool_rewards, aero_usd, decimals
_usd={}
for p in allp:
    try:
        pu=float(p.get('priceUsd') or 0); pn=float(p.get('priceNative') or 0)
        if pu>0: _usd.setdefault(p['baseToken']['address'].lower(),pu)
        if pu>0 and pn>0: _usd.setdefault(p['quoteToken']['address'].lower(),pu/pn)
    except Exception: pass
for k_,v_ in _usd_pre.items(): _usd.setdefault(k_,v_)
for ad,s_ in _sym.items():
    if s_ in _last and _last[s_]: _usd.setdefault(ad,_last[s_])
_usd.setdefault('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',1.0)
_aero=aero_usd()
print('AERO usd',_aero)
def _rew(p):
    try: r=pool_rewards(p['addr'],_usd,_aero)
    except Exception: r=None
    if r: p.update(rapr=r.get('rapr'),em=r.get('em'),staked=r.get('staked'),ufee=r.get('ufee'))
with _cf.ThreadPoolExecutor(6) as _ex: list(_ex.map(_rew,[p for p in pools.values() if p['venue']=='aero']))
print('aero apr', sum(p.get('rapr') is not None for p in pools.values()))
def pack(series,step):
    keys=sorted({k for s in series.values() for k in s})
    return dict(start=keys[0],end=keys[-1],step=step,prices={s:[series[s].get(k) for k in range(keys[0],keys[-1]+1)] for s in series})
D=pack(daily,DAY); H=pack(hourly,3600)
out=dict(generated=int(time.time()),aeroUsd=_aero,assets=assets,daily=D,hourly=H,pools=sorted(pools.values(),key=lambda x:-x['liq']))
json.dump(out,open('../data.json','w'),separators=(',',':'))
print('pools',len(pools))
