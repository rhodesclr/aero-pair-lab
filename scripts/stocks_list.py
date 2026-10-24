# Fetch the full Coinbase tokenized-stock list (paginated) -> cb_stocks.json
import json,urllib.request
def get(u):
    r=urllib.request.Request(u,headers={'User-Agent':'Mozilla/5.0'})
    return json.load(urllib.request.urlopen(r,timeout=30))
toks=[];tok=None
while True:
    d=get("https://api.coinbase.com/v1/tokenized-stocks"+(f"?page_token={tok}" if tok else ""))
    toks+=d['tokens'];tok=d.get('next_page_token')
    if not tok: break
print(len(toks),'tokenized stocks')
json.dump(toks,open('cb_stocks.json','w'))
