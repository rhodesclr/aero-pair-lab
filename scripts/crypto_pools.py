import json,urllib.request,time
def get(u):
    r=urllib.request.Request(u,headers={'User-Agent':'Mozilla/5.0'})
    return json.load(urllib.request.urlopen(r,timeout=30))
C={ # sym: (name, base address, coingecko id)
'ETH':('Ethereum (WETH)','0x4200000000000000000000000000000000000006','ethereum'),
'BTC':('Bitcoin (cbBTC)','0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf','bitcoin'),
'AERO':('Aerodrome','0x940181a94A35A4569E4529A3CDfB74e38FD98631','aerodrome-finance'),
'VIRTUAL':('Virtuals Protocol','0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b','virtual-protocol'),
'XRP':('XRP (cbXRP)','0xcb585250f852C6c6bf90434AB21A00f02833a4af','ripple'),
'DOGE':('Dogecoin (cbDOGE)','0xcbD06E5A2B0C65597161de254AA074E489dEb510','dogecoin'),
'ADA':('Cardano (cbADA)','0xcbADA732173e39521CDBE8bf59a6Dc85A9fc7b8c','cardano'),
'LTC':('Litecoin (cbLTC)','0xcb17C9Db87B595717C857a08468793f5bAb6445F','litecoin'),
'SOL':('Solana (uSOL)','0x9B8Df6E244526ab5F6e6400d331DB28C8fdDdb55','solana'),
'TAO':('Bittensor','0xf3081494B87e8D5fb7960f066E931D1D0e6E3d67','bittensor'),
'LINK':('Chainlink','0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196','chainlink'),
'AAVE':('Aave','0x63706e401c06ac8513145b7687A14804d17f814b','aave'),
'MORPHO':('Morpho','0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842','morpho'),
'WELL':('Moonwell','0xA88594D404727625A9437C3f886C7643872296AE','moonwell-artemis'),
'ZORA':('Zora','0x1111111111166b7FE7bd91427724B487980aFc69','zora'),
'VVV':('Venice Token','0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf','venice-token'),
'KAITO':('Kaito','0x98d0baa52b2D063E780DE12F615f963Fe8537553','kaito'),
'BRETT':('Brett','0x532f27101965dd16442E59d40670FaF5eBB142E4','based-brett'),
'DEGEN':('Degen','0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed','degen-base'),
'TOSHI':('Toshi','0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4','toshi'),
'cbETH':('Coinbase Wrapped Staked ETH','0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22','coinbase-wrapped-staked-eth'),
'wstETH':('Lido Wrapped stETH','0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452','wrapped-steth'),
'EURC':('Euro Coin','0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42','euro-coin'),
'DIEM':('Diem (Venice compute)','0xf4d97f2da56e8c3098f3a8d538db630a2606a024','diem'),
'USDC':('USD Coin','0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',None),
}
out={}
for s,(n,a,cg) in C.items():
    d=get("https://api.dexscreener.com/token-pairs/v1/base/"+a)
    ps=[p for p in d if p.get('dexId') in ('aerodrome','aero')]
    syms=set()
    for p in ps:
        for side in('baseToken','quoteToken'):
            if p[side]['address'].lower()==a.lower(): syms.add(p[side]['symbol'])
    liq=sum((p.get('liquidity') or {}).get('usd',0) or 0 for p in ps)
    print(f"{s:8} {syms} pools={len(ps)} liq={liq:,.0f}")
    out[s]=ps; time.sleep(0.5)
# New AERO token (Aero launch, Oct 22 2026) - pools on Aero pair against this address
NEW_AERO='0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee'
try:
    d=get("https://api.dexscreener.com/token-pairs/v1/base/"+NEW_AERO)
    extra=[p for p in d if p.get('dexId') in ('aerodrome','aero')]
    seen={p['pairAddress'] for p in out['AERO']}
    out['AERO']+= [p for p in extra if p['pairAddress'] not in seen]
    print('new AERO pools',len(extra))
except Exception as e: print('new AERO lookup failed',e)
json.dump({'meta':C,'pools':out},open('crypto_pools.json','w'))
