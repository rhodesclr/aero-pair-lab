// Live data layer: DEX Screener (pool TVL / volume / price), Base RPC (on-chain pool state), GeckoTerminal (7-day pool volume).
(function () {
  const RPCS = ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base.drpc.org'];
  const subs = new Set();
  const Live = { pools: {}, lastUpdate: 0, ok: false, onUpdate: (fn) => subs.add(fn) };
  const emit = (what) => subs.forEach((fn) => { try { fn(what); } catch (e) { console.error(e); } });

  async function getJSON(url, opts = {}, timeout = 15000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { ...opts, signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  // ---------- DEX Screener: all pools, batched 30 per call ----------
  let D = null;
  async function refreshPools() {
    if (!D) return;
    const addrs = D.pools.map((p) => p.addr);
    const chunks = [];
    for (let i = 0; i < addrs.length; i += 30) chunks.push(addrs.slice(i, i + 30));
    let got = 0;
    await Promise.all(chunks.map(async (c) => {
      try {
        const j = await getJSON('https://api.dexscreener.com/latest/dex/pairs/base/' + c.join(','));
        for (const x of j.pairs || []) {
          const p = D.pools.find((q) => q.addr.toLowerCase() === x.pairAddress.toLowerCase());
          if (!p) continue;
          got++;
          p.liq = Math.round(x.liquidity?.usd || 0);
          p.vol = Math.round(x.volume?.h24 || 0);
          p.vol6 = x.volume?.h6 ?? null;
          p.vol1 = x.volume?.h1 ?? null;
          p.price = x.priceNative != null ? +x.priceNative : null; // base (a) priced in quote (b)
          p.priceUsd = x.priceUsd != null ? +x.priceUsd : null;
          p.chg24 = x.priceChange?.h24 ?? null;
          p.baseAddr = x.baseToken?.address; p.quoteAddr = x.quoteToken?.address;
          p.apr = p.fee != null && p.liq > 0 ? (p.vol * p.fee * 365) / p.liq : null;
          p.liveTs = Date.now();
        }
      } catch (e) { /* keep previous values */ }
    }));
    if (got) { Live.ok = true; Live.lastUpdate = Date.now(); emit('pools'); }
  }

  // ---------- Base RPC ----------
  async function rpc(calls) {
    const body = calls.map(([to, data], i) => ({ jsonrpc: '2.0', id: i, method: 'eth_call', params: [{ to, data }, 'latest'] }));
    for (const url of RPCS) {
      try {
        const out = await getJSON(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 10000);
        const arr = Array.isArray(out) ? out : [out];
        const res = new Array(calls.length).fill(null);
        for (const o of arr) if (o && o.id != null) res[o.id] = o.result && o.result !== '0x' ? o.result : null;
        if (res.some((r) => r != null)) return res;
      } catch (e) { /* try next RPC */ }
    }
    return new Array(calls.length).fill(null);
  }
  const SEL = { token0: '0x0dfe1681', token1: '0xd21220a7', decimals: '0x313ce567', slot0: '0x3850c7bd', liquidity: '0x1a686502', fee: '0xddca3f43', reserves: '0x0902f1ac' };
  const metaCache = {};
  async function poolState(p) {
    const a = p.addr;
    const isCL = p.kind && p.kind.startsWith('CL');
    let meta = metaCache[a];
    if (!meta) {
      const [t0, t1] = await rpc([[a, SEL.token0], [a, SEL.token1]]);
      if (!t0 || !t1) return null;
      const a0 = '0x' + t0.slice(-40), a1 = '0x' + t1.slice(-40);
      const [d0, d1] = await rpc([[a0, SEL.decimals], [a1, SEL.decimals]]);
      meta = metaCache[a] = { t0: a0.toLowerCase(), t1: a1.toLowerCase(), d0: parseInt(d0, 16), d1: parseInt(d1, 16) };
    }
    const st = { ...meta, ts: Date.now() };
    if (isCL) {
      const [s0, L, f] = await rpc([[a, SEL.slot0], [a, SEL.liquidity], [a, SEL.fee]]);
      if (s0) {
        const sp = Number(BigInt('0x' + s0.slice(2, 66))) / 2 ** 96;
        st.p10 = sp * sp * 10 ** (meta.d0 - meta.d1); // token1 per token0
      }
      if (L) st.L = Number(BigInt(L));
      if (f) st.fee = parseInt(f, 16) / 1e6;
    } else {
      const [r] = await rpc([[a, SEL.reserves]]);
      if (r) {
        st.r0 = Number(BigInt('0x' + r.slice(2, 66))) / 10 ** meta.d0;
        st.r1 = Number(BigInt('0x' + r.slice(66, 130))) / 10 ** meta.d1;
        if (p.kind !== 'stable' && st.r0 > 0) st.p10 = st.r1 / st.r0;
      }
    }
    // orient to the app's a/b (a priced in b)
    if (st.p10 && p.baseAddr) st.price = p.baseAddr.toLowerCase() === meta.t0 ? st.p10 : 1 / st.p10;
    if (p.baseAddr) {
      const aIs0 = p.baseAddr.toLowerCase() === meta.t0;
      st.decA = aIs0 ? meta.d0 : meta.d1; st.decB = aIs0 ? meta.d1 : meta.d0;
    }
    return st;
  }

  // ---------- GeckoTerminal: average daily volume, last 7 full days ----------
  const volCache = {};
  async function avgVolume7d(addr) {
    if (volCache[addr] && Date.now() - volCache[addr].ts < 30 * 60e3) return volCache[addr].v;
    try {
      const j = await getJSON(`https://api.geckoterminal.com/api/v2/networks/base/pools/${addr}/ohlcv/day?limit=8`);
      const l = (j.data?.attributes?.ohlcv_list || []).slice().sort((x, y) => x[0] - y[0]);
      const full = l.slice(0, -1).slice(-7); // drop today's partial day
      const v = full.length ? { avg: full.reduce((s, r) => s + r[5], 0) / full.length, days: full.length } : null;
      volCache[addr] = { v, ts: Date.now() };
      return v;
    } catch (e) { return null; }
  }

  Live.start = (data) => {
    D = data;
    refreshPools();
    setInterval(refreshPools, 60e3);
    setInterval(() => emit('tick'), 5e3);
  };
  Live.refreshPools = refreshPools;
  Live.poolState = poolState;
  Live.avgVolume7d = avgVolume7d;
  window.Live = Live;
})();
