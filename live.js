// Live data layer: DEX Screener (pool TVL / volume / price), chain RPCs (on-chain pool state), GeckoTerminal (7-day pool volume).
// Chains: Base, OP Mainnet, Robinhood Chain. Venues: Aero (all three) and Uniswap v2/v3/v4.
(function () {
  const CHAIN_RPCS = {
    base: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base.drpc.org'],
    optimism: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'],
    robinhood: ['https://rpc.mainnet.chain.robinhood.com'],
  };
  const STATEVIEW = { base: '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71', optimism: '0xc18a3169788f4f75a170290584eca6395c75ecdb', robinhood: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b' };
  const SUGARS = { base: '0x082965f28c1aF8c7e236F8A8909596B01D8C6e72', optimism: '0x81538A32F7C98796132dE4F700EAbDbE773BE5BE', robinhood: '0x548245396B5a74c416590580434b9E4bc4CFe3b6' };
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
    const byChain = {};
    for (const p of D.pools) (byChain[p.chain || 'base'] = byChain[p.chain || 'base'] || []).push(p);
    const idx = {};
    for (const p of D.pools) idx[(p.chain || 'base') + ':' + p.addr.toLowerCase()] = p;
    const chunks = [];
    for (const [ch, ps] of Object.entries(byChain)) for (let i = 0; i < ps.length; i += 30) chunks.push([ch, ps.slice(i, i + 30).map((p) => p.addr)]);
    let got = 0;
    await Promise.all(chunks.map(async ([ch, c]) => {
      try {
        const j = await getJSON(`https://api.dexscreener.com/latest/dex/pairs/${ch}/` + c.join(','));
        for (const x of j.pairs || []) {
          const p = idx[ch + ':' + x.pairAddress.toLowerCase()];
          if (!p) continue;
          got++;
          p.liq = Math.round(x.liquidity?.usd || 0);
          p.vol = Math.round(x.volume?.h24 || 0);
          p.vol6 = x.volume?.h6 ?? null;
          p.vol1 = x.volume?.h1 ?? null;
          // DEX Screener prices its own base token; the app may list the pair the other way round
          const dsBase = (x.baseToken?.address || '').toLowerCase();
          const same = !p.baseAddr || dsBase === p.baseAddr.toLowerCase() || (p.venue === 'uniswap' && (x.baseToken?.symbol === p.sa));
          const pn = x.priceNative != null ? +x.priceNative : null;
          p.price = pn ? (same ? pn : 1 / pn) : null; // base (a) priced in quote (b)
          p.priceUsd = x.priceUsd != null ? (same ? +x.priceUsd : (pn ? +x.priceUsd / pn : null)) : null;
          p.chg24 = x.priceChange?.h24 ?? null;
          if (!p.baseAddr) { p.baseAddr = x.baseToken?.address; p.quoteAddr = x.quoteToken?.address; }
          p.apr = p.fee != null && p.liq > 0 ? (p.vol * p.fee * (p.venue === 'uniswap' ? 1 - (p.ufee || 0) : 1) * 365) / p.liq : null;
          p.liveTs = Date.now();
        }
      } catch (e) { /* keep previous values */ }
    }));
    if (got) { Live.ok = true; Live.lastUpdate = Date.now(); emit('pools'); }
  }

  // ---------- chain RPCs ----------
  async function rpc(calls, chain = 'base', block = 'latest') {
    const RPCS = CHAIN_RPCS[chain] || CHAIN_RPCS.base;
    const tag = typeof block === 'number' ? '0x' + block.toString(16) : block;
    const body = calls.map(([to, data], i) => ({ jsonrpc: '2.0', id: i, method: 'eth_call', params: [{ to, data }, tag] }));
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
  const sugarCall = (ch, a) => [SUGARS[ch] || SUGARS.base, '0xa773f925' + a.slice(2).toLowerCase().padStart(64, '0') + (86400).toString(16).padStart(64, '0')];
  async function poolState(p) {
    const a = p.addr;
    const ch = p.chain || 'base';
    const isCL = p.kind && p.kind.startsWith('CL');
    const key = ch + ':' + a.toLowerCase();
    let meta = metaCache[key];
    if (!meta && p.venue === 'uniswap' && p.dec0 != null && p.baseAddr) {
      // token order and decimals saved by the build (v4 pools have no token0()/token1())
      const t0 = (p.b0 ? p.baseAddr : p.quoteAddr).toLowerCase(), t1 = (p.b0 ? p.quoteAddr : p.baseAddr).toLowerCase();
      meta = metaCache[key] = { t0, t1, d0: p.dec0, d1: p.dec1 };
    }
    if (!meta) {
      const [t0, t1] = await rpc([[a, SEL.token0], [a, SEL.token1]], ch);
      if (!t0 || !t1) return null;
      const a0 = '0x' + t0.slice(-40), a1 = '0x' + t1.slice(-40);
      const [d0, d1] = await rpc([[a0, SEL.decimals], [a1, SEL.decimals]], ch);
      meta = metaCache[key] = { t0: a0.toLowerCase(), t1: a1.toLowerCase(), d0: parseInt(d0, 16), d1: parseInt(d1, 16) };
    }
    const st = { ...meta, ts: Date.now(), chain: ch };
    const sqrtToP = (hex) => { const sp = Number(BigInt('0x' + hex.slice(2, 66))) / 2 ** 96; return sp * sp * 10 ** (meta.d0 - meta.d1); };
    if (p.venue === 'uniswap' && p.ver === 'v4') {
      const id = a.slice(2).toLowerCase().padStart(64, '0');
      const [s0, L] = await rpc([[STATEVIEW[ch], '0xc815641c' + id], [STATEVIEW[ch], '0xfa6793d5' + id]], ch);
      if (s0 && BigInt('0x' + s0.slice(2, 66)) > 0n) st.p10 = sqrtToP(s0);
      if (L) st.L = Number(BigInt(L));
      if (s0) { const lp = parseInt(s0.slice(2 + 64 * 3, 2 + 64 * 4), 16); if (lp < 0x800000) st.fee = lp / 1e6; }
    } else if (isCL) {
      const calls = [[a, SEL.slot0], [a, SEL.liquidity], [a, SEL.fee]];
      if (p.venue === 'aero') calls.push(sugarCall(ch, a));
      const [s0, L, f, sg] = await rpc(calls, ch);
      st.sugar = decodeSugar(sg, meta);
      if (s0) st.p10 = sqrtToP(s0); // token1 per token0
      if (L) st.L = Number(BigInt(L));
      if (f) st.fee = parseInt(f, 16) / 1e6;
    } else {
      const calls = [[a, SEL.reserves]];
      if (p.venue === 'aero') calls.push(sugarCall(ch, a));
      const [r, sg] = await rpc(calls, ch);
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
  async function avgVolume7d(addr, chain = 'base') {
    if (volCache[addr] && Date.now() - volCache[addr].ts < 30 * 60e3) return volCache[addr].v;
    try {
      const j = await getJSON(`https://api.geckoterminal.com/api/v2/networks/${chain}/pools/${addr}/ohlcv/day?limit=8`);
      const l = (j.data?.attributes?.ohlcv_list || []).slice().sort((x, y) => x[0] - y[0]);
      const full = l.slice(0, -1).slice(-7); // drop today's partial day
      const v = full.length ? { avg: full.reduce((s, r) => s + r[5], 0) / full.length, days: full.length } : null;
      volCache[addr] = { v, ts: Date.now() };
      return v;
    } catch (e) { return null; }
  }

  // ---------- GeckoTerminal: each pool's own trade history (OHLCV in pool-token units) ----------
  // One request at a time, ~2.2s apart (GeckoTerminal allows ~30/min). Cached in memory + localStorage for 30 min.
  // Returns { bars: [[t, o, h, l, c, volQuote], ...] oldest first, base, quote } where prices are the GT base token
  // priced in the GT quote token and volume is in quote-token units.
  let gtNext = 0;
  const gtQueue = [];
  let gtBusy = false;
  function gtFetch(url, prio) {
    return new Promise((res, rej) => {
      gtQueue.push({ url, res, rej, prio: prio || 0 });
      gtQueue.sort((a, b) => b.prio - a.prio);
      pumpGt();
    });
  }
  async function pumpGt() {
    if (gtBusy) return;
    gtBusy = true;
    while (gtQueue.length) {
      const job = gtQueue.shift();
      const w = gtNext - Date.now();
      if (w > 0) await new Promise((r) => setTimeout(r, w));
      let out = null, err = null;
      for (let k = 0; k < 3; k++) {
        gtNext = Date.now() + 2200;
        try { out = await getJSON(job.url, {}, 20000); err = null; break; }
        catch (e) { err = e; if (!/429/.test(String(e))) break; await new Promise((r) => setTimeout(r, 15000 * (k + 1))); }
      }
      if (err) job.rej(err); else job.res(out);
    }
    gtBusy = false;
  }
  const histMem = {};
  const lsGet = (k) => { try { const v = JSON.parse(localStorage.getItem(k)); return v && Date.now() - v.ts < 30 * 60e3 ? v : null; } catch (e) { return null; } };
  const lsSet = (k, v) => {
    try { localStorage.setItem(k, JSON.stringify(v)); }
    catch (e) { try { Object.keys(localStorage).filter((x) => x.startsWith('gt:')).forEach((x) => localStorage.removeItem(x)); localStorage.setItem(k, JSON.stringify(v)); } catch (e2) { /* full */ } }
  };
  // res: 'day' (up to 1000 days) or 'hour' (up to `n` hours, 1000 per request)
  async function poolHistory(addr, chain = 'base', res = 'day', n = 400, prio = 0) {
    const key = `gt:${chain}:${addr.toLowerCase()}:${res}:${n}`;
    if (histMem[key] && Date.now() - histMem[key].ts < 30 * 60e3) return histMem[key];
    const ls = lsGet(key);
    if (ls) { histMem[key] = ls; return ls; }
    if (histMem[key + ':p']) return histMem[key + ':p'];
    const run = (async () => {
      const bars = {};
      let before = null, meta = null, left = n;
      while (left > 0) {
        const lim = Math.min(1000, left);
        const url = `https://api.geckoterminal.com/api/v2/networks/${chain}/pools/${addr}/ohlcv/${res}?aggregate=1&limit=${lim}&currency=token${before ? '&before_timestamp=' + before : ''}`;
        let j;
        try { j = await gtFetch(url, prio); } catch (e) { if (!Object.keys(bars).length) throw e; break; }
        meta = meta || j.meta;
        const l = j.data?.attributes?.ohlcv_list || [];
        for (const r of l) bars[r[0]] = r;
        if (l.length < lim) break;
        before = Math.min(...l.map((r) => r[0]));
        left -= lim;
      }
      const out = {
        ts: Date.now(), res,
        bars: Object.values(bars).sort((x, y) => x[0] - y[0]).map((r) => r.map((v, i) => (i ? +(+v).toPrecision(7) : +v))),
        base: (meta?.base?.address || '').toLowerCase(), quote: (meta?.quote?.address || '').toLowerCase(),
        baseSym: meta?.base?.symbol, quoteSym: meta?.quote?.symbol,
      };
      histMem[key] = out; lsSet(key, out);
      return out;
    })();
    histMem[key + ':p'] = run;
    try { return await run; } finally { delete histMem[key + ':p']; }
  }
  // Daily on-chain pool history built by scripts/hist.py (AERO emissions, staked + active liquidity, reserves)
  let chainHist = null;
  async function onchainHist() {
    if (chainHist) return chainHist;
    chainHist = getJSON('hist.json?v=' + Math.floor(Date.now() / 3.6e6), { cache: 'no-cache' }, 30000).catch(() => ({ days: [], p: {} }));
    return chainHist;
  }


  // ---------- real LP position check (concentrated-liquidity NFTs) ----------
  // Works from the contracts' own counters, so no event-log search is needed:
  //  fees earned  = (feeGrowthInside[end] − feeGrowthInside[start]) × L / 2^128   (unstaked time only)
  //  AERO earned  = (rewardGrowthInside[now] − rewardGrowthInside[stake]) × L / 2^128   (staked time only)
  // Mint and stake blocks are found by binary search over historical state.
  const NFPM = {
    aero: { base: '0x4857db576ee0e45f10525ec59527bfd10beec60b' },
    legacy: { base: '0x827922686190790b37229fd06084350e74485b72' },
    uniswap: { base: '0x03a520b32c04bf3beef7beb72e919cf822ed34f1', optimism: '0xc36442b4a4522e871399cd717abdd847ab11fe88' },
  };
  const Q128 = 1n << 128n, M256 = 1n << 256n;
  const hx = (n) => (BigInt.asUintN(256, BigInt(n))).toString(16).padStart(64, '0');
  const words = (r) => { const o = []; for (let i = 2; i + 64 <= r.length; i += 64) o.push(BigInt('0x' + r.slice(i, i + 64))); return o; };
  const s24 = (v) => Number(BigInt.asIntN(256, v));
  async function rpcRaw(method, params, chain) {
    for (const url of CHAIN_RPCS[chain] || CHAIN_RPCS.base) {
      try { const o = await getJSON(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }, 10000); if (o && o.result != null) return o.result; } catch (e) { /* next */ }
    }
    return null;
  }
  async function positionCheck(p, tokenId, startTs, onStep) {
    const ch = p.chain || 'base', a = p.addr.toLowerCase();
    const step = (m) => onStep && onStep(m);
    const isAero = p.venue === 'aero' || p.venue === 'legacy';
    if (!(p.kind && p.kind.startsWith('CL'))) throw new Error('Only concentrated-liquidity (CL) pools have position NFTs.');
    if (p.venue === 'uniswap' && p.ver !== 'v3') throw new Error('Position check supports Uniswap v3 pools (not v4) for now.');
    const st = await poolState(p);
    if (!st) throw new Error('Could not read the pool contract.');
    let gauge = null;
    if (isAero) { const [g] = await rpc([[a, '0xa6f19c84']], ch); gauge = g && BigInt(g) ? '0x' + g.slice(-40) : null; }
    let nfpm = (NFPM[p.venue] || {})[ch];
    if (gauge) { const [n] = await rpc([[gauge, '0x47ccca02']], ch); if (n && BigInt(n)) nfpm = '0x' + n.slice(-40); }
    if (!nfpm) throw new Error('No position manager known for this pool.');
    const tid = hx(tokenId);
    step('Reading position #' + tokenId + '…');
    const [pr, ow, ts, fe] = await rpc([[nfpm, '0x99fbab88' + tid], [nfpm, '0x6352211e' + tid], [a, '0xd0c93a7c'], [a, '0xddca3f43']], ch);
    if (!pr) throw new Error('Position #' + tokenId + ' does not exist on this pool\u2019s position manager (it may have been burned).');
    const w = words(pr);
    const t0 = '0x' + w[2].toString(16).padStart(40, '0'), t1 = '0x' + w[3].toString(16).padStart(40, '0');
    if (t0 !== st.t0 || t1 !== st.t1) throw new Error('Position #' + tokenId + ' belongs to a different pair.');
    const third = s24(w[4]);
    if (p.venue === 'uniswap' ? fe && third !== parseInt(fe, 16) : ts && third !== s24(BigInt(ts))) throw new Error('Position #' + tokenId + ' is in the same pair but a different pool (fee tier / tick spacing).');
    const tl = s24(w[5]), tu = s24(w[6]), Lnow = w[7];
    const owner = ow ? '0x' + ow.slice(-40) : null;
    const staked = !!(gauge && owner === gauge);
    const bnHex = await rpcRaw('eth_blockNumber', [], ch);
    const bn = parseInt(bnHex, 16);
    const tsC = {};
    const tsOf = async (b) => { if (tsC[b] != null) return tsC[b]; const r = await rpcRaw('eth_getBlockByNumber', ['0x' + b.toString(16), false], ch); return (tsC[b] = r ? parseInt(r.timestamp, 16) : null); };
    // last block at or before time t. Block time isn't fixed (Base went from 2s to 0.2s blocks in Nov 2026),
    // so this searches real block timestamps: interpolation steps inside a shrinking bracket.
    async function blockAt(t) {
      let lo = 1, hi = bn, tlo = await tsOf(1), thi = await tsOf(bn);
      if (t >= thi) return bn;
      if (t <= tlo) return 1;
      for (let i = 0; i < 60 && hi - lo > 1; i++) {
        let g = lo + Math.floor(((t - tlo) * (hi - lo)) / Math.max(1, thi - tlo));
        g = Math.min(hi - 1, Math.max(lo + 1, g));
        const tg = await tsOf(g);
        if (tg <= t) {
          lo = g; tlo = tg;
          const g2 = Math.min(hi - 1, g + Math.max(1, (hi - g) >> 6)), t2 = await tsOf(g2);
          if (t2 > t) { hi = g2; thi = t2; } else { lo = g2; tlo = t2; }
        } else {
          hi = g; thi = tg;
          const g2 = Math.max(lo + 1, g - Math.max(1, (g - lo) >> 6)), t2 = await tsOf(g2);
          if (t2 <= t) { lo = g2; tlo = t2; } else { hi = g2; thi = t2; }
        }
      }
      return lo;
    }
    // binary search: first block where test(b) is true (test is monotonic false→true)
    async function firstTrue(lo, hi, test) {
      while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (await test(mid)) hi = mid; else lo = mid; }
      return hi;
    }
    const nameCall = [nfpm, '0x06fdde03']; // always succeeds, so a reverting positions() still returns a batch
    step('Finding when it was minted…');
    const minted = async (b) => { const [r] = await rpc([[nfpm, '0x99fbab88' + tid], nameCall], ch, b); return !!r; };
    // the position manager's deploy is the lower bound (positions() reverts before the NFT exists)
    const mintBlock = await firstTrue(1, bn, minted);
    const [prM] = await rpc([[nfpm, '0x99fbab88' + tid], nameCall], ch, mintBlock);
    const Lmint = words(prM)[7];
    let stakeBlock = null;
    if (staked) {
      step('Finding when it was staked…');
      const isSt = async (b) => { const [r] = await rpc([[nfpm, '0x6352211e' + tid], nameCall], ch, b); return !!r && '0x' + r.slice(-40) === gauge; };
      stakeBlock = (await isSt(mintBlock)) ? mintBlock : await firstTrue(mintBlock, bn, isSt);
    }
    const [mintTs, stakeTs] = await Promise.all([tsOf(mintBlock), stakeBlock ? tsOf(stakeBlock) : null]);
    // fee growth inside the range at a block (Slipstream ticks() has stakedLiquidityNet before feeGrowthOutside)
    const off = isAero ? 3 : 2;
    async function growth(b) {
      const calls = [[a, '0x3850c7bd'], [a, '0xf3058399'], [a, '0x46141319'], [a, '0xf30dba93' + hx(tl)], [a, '0xf30dba93' + hx(tu)]];
      if (isAero) calls.push([a, '0xa16368c9' + hx(tl) + hx(tu) + hx(0)]);
      const r = await rpc(calls, ch, b);
      if (!r[0] || !r[3] || !r[4]) return null;
      const s0 = words(r[0]), tick = s24(s0[1]), sqrtP = s0[0];
      const g0 = BigInt(r[1]), g1 = BigInt(r[2]), wl = words(r[3]), wu = words(r[4]);
      const ins = (g, ol, ou) => {
        const below = tick >= tl ? ol : (g - ol + M256) % M256;
        const above = tick < tu ? ou : (g - ou + M256) % M256;
        return ((g - below - above) % M256 + 2n * M256) % M256;
      };
      return { tick, sqrtP, f0: ins(g0, wl[off], wu[off]), f1: ins(g1, wl[off + 1], wu[off + 1]), rw: r[5] ? BigInt(r[5]) : null };
    }
    // closed positions (liquidity pulled to 0): stop counting at the block it was emptied
    let closeBlock = null, closeTs = null;
    if (Lnow === 0n && !staked) {
      step('Finding when it was closed…');
      const empty = async (b) => { const [r] = await rpc([[nfpm, '0x99fbab88' + tid], nameCall], ch, b); return !r || words(r)[7] === 0n; };
      closeBlock = await firstTrue(mintBlock, bn, empty);
      closeTs = await tsOf(closeBlock);
    }
    const ws = Math.max(mintTs, startTs || 0);
    const wsBlock = ws > mintTs ? await blockAt(ws) : mintBlock;
    step('Reading fee counters…');
    const feeEnd = staked ? stakeBlock : closeBlock || bn;
    const [gS, gE, gN] = await Promise.all([growth(wsBlock), staked && stakeBlock > wsBlock ? growth(stakeBlock) : null, growth(closeBlock ? closeBlock - 1 : bn)]);
    const gStake = staked ? (stakeBlock > wsBlock ? gE : gS) : null;
    const L = Lnow > 0n ? Lnow : Lmint;
    const d = (x, y) => ((x - y) % M256 + M256) % M256;
    let fees0 = 0n, fees1 = 0n;
    const feeTo = staked ? gStake : gN;
    if (gS && feeTo && feeEnd > wsBlock) { fees0 = (d(feeTo.f0, gS.f0) * L) / Q128; fees1 = (d(feeTo.f1, gS.f1) * L) / Q128; }
    let aero = null;
    if (staked && gN && gN.rw != null) {
      const from = stakeBlock >= wsBlock ? gStake : gS;
      if (from && from.rw != null) aero = Number((d(gN.rw, from.rw) * L) / Q128) / 1e18;
    }
    // starting token amounts from the position's liquidity and the pool price at the window start
    const sqrtAt = (tk) => Math.sqrt(Math.pow(1.0001, tk));
    const amt = (Lx, sp) => { // raw units
      const sa = sqrtAt(tl), sb = sqrtAt(tu), lx = Number(Lx);
      if (sp <= sa) return [lx * (1 / sa - 1 / sb), 0];
      if (sp >= sb) return [0, lx * (sb - sa)];
      return [lx * (1 / sp - 1 / sb), lx * (sp - sa)];
    };
    const spS = gS ? Number(gS.sqrtP) / 2 ** 96 : null;
    const [r0, r1] = spS ? amt(Lmint, spS) : [0, 0];
    return {
      nfpm, gauge, owner, staked, tl, tu, d0: st.d0, d1: st.d1, t0, t1, mintTs, stakeTs, windowTs: ws,
      Lnow: Number(Lnow), Lmint: Number(Lmint), closed: Lnow === 0n, changed: Lnow !== Lmint && Lnow !== 0n,
      fees0: Number(fees0) / 10 ** st.d0, fees1: Number(fees1) / 10 ** st.d1, aero, closeTs,
      start0: r0 / 10 ** st.d0, start1: r1 / 10 ** st.d1, tickNow: gN ? gN.tick : null,
    };
  }
  Live.positionCheck = positionCheck;
  Live.poolHistory = poolHistory;
  Live.onchainHist = onchainHist;
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
  Live.rpc = rpc;
  window.Live = Live;
})();
