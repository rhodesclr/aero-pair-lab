# Reads each Aerodrome pool's swap fee on-chain (Base public RPC). CL = Slipstream (fee() in pips), else basic pool via PoolFactory.getFee(pool, stable).
import json,urllib.request,time
RPCS=['https://base-rpc.publicnode.com','https://mainnet.base.org','https://base.llamarpc.com']
def call(to,data):
    body={"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":to,"data":data},"latest"]}
    for k in range(6):
        rpc=RPCS[k%len(RPCS)]
        try:
            r=urllib.request.Request(rpc,data=json.dumps(body).encode(),headers={'Content-Type':'application/json','User-Agent':'Mozilla/5.0'})
            o=json.load(urllib.request.urlopen(r,timeout=20))
        except Exception as e: time.sleep(1); continue
        if 'result' in o: return o['result']
        msg=str(o.get('error',{}).get('message',''))
        if 'revert' in msg.lower() or 'execution' in msg.lower(): return None
        time.sleep(1)
    return 'ERR'
def pool_fee(a):
    f=call(a,'0xddca3f43')
    if f and f!='ERR' and len(f)>=66: return ('CL',int(f,16)/1e6, int(call(a,'0xd0c93a7c') or '0x0',16))
    s=call(a,'0x22be3de1'); fac=call(a,'0xc45a0155')
    if not s or s=='ERR' or not fac or fac=='ERR': return (None,None,None)
    stable=int(s,16); facaddr='0x'+fac[-40:]
    g=call(facaddr,'0xcc56b2c5'+a[2:].lower().rjust(64,'0')+hex(stable)[2:].rjust(64,'0'))
    if not g or g=='ERR': return ('stable' if stable else 'volatile',None,None)
    return ('stable' if stable else 'volatile', int(g,16)/10000, None)
