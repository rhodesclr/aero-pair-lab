#!/bin/bash
# Daily refresh: token list -> Aerodrome pools -> prices -> ../data.json
set -euo pipefail
cd "$(dirname "$0")"
rm -rf cache && mkdir -p cache
python3 -u stocks_list.py
python3 -u stocks_list2.py | tail -3
python3 -u crypto_pools.py
# Uniswap pools (Base, OP Mainnet, Robinhood Chain); keep the last good list if this step fails
cp uni_pools.json uni_pools.prev.json 2>/dev/null || true
if ! (python3 -u uni_pools.py | tail -2 && python3 -u uni_enrich.py); then echo 'Uniswap step failed - keeping previous list'; cp uni_pools.prev.json uni_pools.json || true; fi
rm -f uni_pools.prev.json
cp ../data.json ../data.prev.json
python3 -u build.py
python3 - <<'PY'
import json,re,sys,time
d=json.load(open('../data.json'))
n=len(d['assets']); p=len(d['pools'])
stale=[k for k,v in d['daily']['prices'].items() if k!='USDC' and sum(x is not None for x in v[-10:])==0]
print('generated',time.strftime('%Y-%m-%d %H:%M UTC',time.gmtime(d['generated'])),'assets',n,'pools',p,'stale',stale)
S=set(re.search(r"STOCKS='([^']+)'",open('build.py').read()).group(1).split())
res=json.load(open('aero_stock_pools.json'))
new=sorted(((s,round(sum((q.get('liquidity') or {}).get('usd',0) or 0 for q in ps))) for s,ps in res.items() if s not in S),key=lambda x:-x[1])
print('new_eligible_stocks',[x for x in new if x[1]>=5000])
if n<60 or p<300 or len(stale)>5:
    print('Sanity check failed - restoring previous data.json'); 
    import shutil; shutil.copy('../data.prev.json','../data.json'); sys.exit(1)
PY
rm -f ../data.prev.json
