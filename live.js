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
  const LP_SUGAR = '0x082965f28c1aF8c7e236F8A8909596B01D8C6e72'; // Aero LP Sugar (same contract the Aero app reads)
  const NEW_AERO = '0x3f5bf3edac59d650d8fdf9657a71f2f904a3a4ee';
  function decodeSugar(r, meta) {
    if (!r || r.length < 2 + 64 * 41) return null;
    const w = (i) => r.slice(2 + i * 64, 2 + (i + 1) * 64);
    const b = parseInt(w(0), 16) / 32;
    const u = (i) => BigInt('0x' + w(b + i));
    const sgn = (i) => { const v = u(i); return Number(v >= 1n << 255n ? v - (1n << 256n) : v); };
    return {
      liquidity: Number(u(3)), type: sgn(4), gaugeL: Number(u(14)), alive: u(15) === 1n,
      gauge: '0x' + w(b + 13).slice(-40), staked0: Number(u(9)) / 10 ** meta.d0, staked1: Number(u(12)) / 10 ** meta.d1,
      emPerSec: Number(u(18)) / 1e18, unstakedFee: Number(u(22)) / 1e6, poolFee: Number(u(21)) / 1e6,
    };
  }
  let aeroPx = { v: null, ts: 0 };
  async function aeroUsd() {
    if (aeroPx.v && Date.now() - aeroPx.ts < 60e3) return aeroPx.v;
    try {
      const j = await getJSON('https://api.dexscreener.com/latest/dex/tokens/' + NEW_AERO);
      const ps = (j.pairs || []).filter((p) => p.chainId === 'base' && p.baseToken.address.toLowerCase() === NEW_AERO).sort((x, y) => (y.liquidity?.usd || 0) - (x.liquidity?.usd || 0));
      if (ps.length) aeroPx = { v: +ps[0].priceUsd, ts: Date.now() };
    } catch (e) { /* keep last */ }
    return aeroPx.v || (D && D.aeroUsd) || null;
  }
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
      const calls = [[a, SEL.slot0], [a, SEL.liquidity], [a, SEL.fee]];
      if (p.venue === 'aero') calls.push([LP_SUGAR, '0xa773f925' + a.slice(2).toLowerCase().padStart(64, '0') + (86400).toString(16).padStart(64, '0')]);
      const [s0, L, f, sg] = await rpc(calls);
      st.sugar = decodeSugar(sg, meta);
      if (s0) {
        const sp = Number(BigInt('0x' + s0.slice(2, 66))) / 2 ** 96;
        st.p10 = sp * sp * 10 ** (meta.d0 - meta.d1); // token1 per token0
      }
      if (L) st.L = Number(BigInt(L));
      if (f) st.fee = parseInt(f, 16) / 1e6;
    } else {
      const calls = [[a, SEL.reserves]];
      if (p.venue === 'aero') calls.push([LP_SUGAR, '0xa773f925' + a.slice(2).toLowerCase().padStart(64, '0') + (86400).toString(16).padStart(64, '0')]);
      const [r, sg] = await rpc(calls);
      st.sugar = decodeSugar(sg, meta);
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
      if (st.sugar) { st.sugar.stakedA = aIs0 ? st.sugar.staked0 : st.sugar.staked1; st.sugar.stakedB = aIs0 ? st.sugar.staked1 : st.sugar.staked0; }
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
  Live.aeroUsd = aeroUsd;
  Live.avgVolume7d = avgVolume7d;
  window.Live = Live;
})();
