// LP Simulators (Aero and Uniswap, on Base / OP Mainnet / Robinhood Chain): live pool state + up to 1 year of price history + draggable range + backtest + range optimizer.
(function () {
  const $ = (s) => document.querySelector(s);
  const LC = window.LightweightCharts;
  let D, A;
  let pool = null, chainSt = null, ser = null, avg7 = null, aeroPx = null;
  const WIDTH_BPS = { 1: 10, 10: 50, 50: 300, 100: 500, 150: 750, 200: 1000, 250: 1250 };
  const S = { addr: null, dep: 1000, lo: null, hi: null, full: false, period: '90D', mode: 'fixed', earn: 'fees', aeroSrc: 'live', aeroApr: 0, volMode: 'hist', customVol: null, reb: 'off', rebDelay: 6, slip: 0.1, gas: 0.05, feeShare: 100, inv: false, chain: 'all' };
  // which simulator is showing: 'aero' (Aero + old Aerodrome pools) or 'uni' (Uniswap v2/v3/v4)
  let mode = 'aero';
  const modeState = { aero: { addr: null, earn: 'fees', chain: 'all' }, uni: { addr: null, earn: 'fees', chain: 'all' } };
  const CHAINS = { base: 'Base', optimism: 'OP Mainnet', robinhood: 'Robinhood Chain' };
  const EXPL = { base: ['BaseScan', 'https://basescan.org/address/'], optimism: ['OP Etherscan', 'https://optimistic.etherscan.io/address/'], robinhood: ['Blockscout', 'https://robinhoodchain.blockscout.com/address/'] };
  const chainOf = (p) => (p && p.chain) || 'base';
  const isUni = (p) => !!(p && p.venue === 'uniswap');
  const inMode = (p) => (mode === 'uni' ? isUni(p) : !isUni(p));
  const venueName = (p) => (isUni(p) ? 'Uniswap' : p.venue === 'legacy' ? 'Old Aerodrome' : 'Aero');
  const venueTag = (p) => `<span class="venue ${isUni(p) ? 'uni' : p.venue === 'legacy' ? 'legacy' : 'aero'}">${venueName(p)}</span>`;
  const chainTag = (p) => `<span class="chain ${chainOf(p)}">${CHAINS[chainOf(p)]}</span>`;
  const PERIODS = { '7D': ['hourly', 168], '30D': ['hourly', 720], '90D': ['hourly', 2160], '180D': ['daily', 180], '1Y': ['daily', 365] };
  const WIDTHS = [0.01, 0.02, 0.03, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.5, 'full'];

  // ---------- formatting ----------
  function fmtP(x) {
    if (x == null || isNaN(x)) return '—';
    if (!isFinite(x)) return '∞';
    const a = Math.abs(x);
    if (a === 0) return '0';
    if (a >= 1000) return x.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (a >= 1) return String(+x.toPrecision(6));
    return x.toFixed(Math.min(12, Math.ceil(-Math.log10(a)) + 4)).replace(/0+$/, '');
  }
  const usd = (x, d = 0) => (x == null || isNaN(x) ? '—' : (x < 0 ? '−$' : '$') + Math.abs(x).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
  const usdK = (x) => (x == null ? '—' : x >= 1e6 ? '$' + (x / 1e6).toFixed(2) + 'M' : x >= 1e3 ? '$' + (x / 1e3).toFixed(1) + 'K' : '$' + Math.round(x));
  const pct = (x, d = 1) => (x == null || isNaN(x) ? '—' : (x * 100).toFixed(d) + '%');
  const spct = (x, d = 1) => (x == null || isNaN(x) ? '—' : (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x * 100).toFixed(d) + '%');
  const amt = (x) => (x == null ? '—' : x === 0 ? '0' : Math.abs(x) >= 1000 ? x.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(+x.toPrecision(5)));
  const kindFmt = (p) => {
    const k = p && p.kind;
    if (isUni(p)) return `Uniswap ${p.ver || ''}${k && k.startsWith('CL') && p.ts ? ' · tick ' + p.ts : ''}`;
    return !k ? 'Pool' : k.startsWith('CL') ? 'Slipstream ' + k : k === 'stable' ? 'Basic stable' : 'Basic volatile';
  };
  const feeFmt = (f) => (f == null ? '—' : +(f * 100).toFixed(4) + '%');
  const cls = (x) => (x == null ? '' : x > 0 ? 'good' : x < 0 ? 'bad' : '');
  const isCL = (p) => !!(p && p.kind && p.kind.startsWith('CL'));

  // ---------- price series (a priced in b) ----------
  function usdArr(sym, res) { return sym === 'USDC' ? null : D[res].prices[sym]; }
  function livePrice() {
    if (!pool) return null;
    if (chainSt && chainSt.addr === pool.addr && chainSt.price) return chainSt.price;
    return pool.price || null;
  }
  function liveUsd() { // [usd of a, usd of b] right now
    const P = livePrice();
    if (!P) return null;
    let ub = pool.b === 'USDC' ? 1 : pool.priceUsd && pool.price ? pool.priceUsd / pool.price : null;
    if (ub == null && ser) ub = ser.ub[ser.ub.length - 1];
    if (pool.a === 'USDC') return [1, 1 / P];
    return [P * ub, ub];
  }
  // ---------- pool trade history (GeckoTerminal) + on-chain daily history (hist.json) ----------
  // histStore[chain:addr:res] = { map: {key: [o, h, l, c, volUSD-or-null, volUnits, unitIsB]}, k0, k1, n } oriented to that pool's a/b
  const histStore = {};
  let chainHist = null, chainDayIdx = null;
  const hkey = (p, res) => chainOf(p) + ':' + p.addr.toLowerCase() + ':' + res;
  const pairAll = (p) => D.pools.filter((x) => (x.a === p.a && x.b === p.b) || (x.a === p.b && x.b === p.a));
  function orientHist(p, gt, res) {
    if (!gt || !gt.bars || !gt.bars.length) return null;
    // which way round? compare GeckoTerminal's last close with the pool's live price (or the USD feeds)
    const lastC = gt.bars[gt.bars.length - 1][4];
    let ref = p.price || null;
    if (!ref) {
      const sa = usdArr(p.a, 'daily'), sb = usdArr(p.b, 'daily');
      const la = sa ? sa.filter((x) => x != null).pop() : 1, lb = sb ? sb.filter((x) => x != null).pop() : 1;
      if (la && lb) ref = la / lb;
    }
    const aIsBase = ref ? Math.abs(Math.log(lastC / ref)) <= Math.abs(Math.log(1 / lastC / ref)) : true;
    const map = {};
    const step = res === 'day' ? 86400 : 3600;
    let k0 = Infinity, k1 = -Infinity;
    for (const [t, o, h, l, c, v] of gt.bars) {
      if (!(c > 0)) continue;
      // keys line up with the app's price arrays: daily = day of the bar, hourly = hour the bar ends
      const k = res === 'day' ? Math.round(t / 86400) : Math.round(t / 3600) + 1;
      map[k] = aIsBase ? [o, h, l, c, v, true] : [1 / o, 1 / l, 1 / h, 1 / c, v, false];
      k0 = Math.min(k0, k); k1 = Math.max(k1, k);
    }
    return { map, k0, k1, n: k1 - k0 + 1, step };
  }
  async function loadHistory(p, prio, onStage) {
    const res = PERIODS[S.period][0];
    const need = PERIODS[S.period][1];
    const jobs = [];
    const want = (x, r, n, pr) => {
      const key = hkey(x, r);
      if (histStore[key] !== undefined) { if (histStore[key] && histStore[key].then) jobs.push(histStore[key]); return; }
      const job = Live.poolHistory(x.addr, chainOf(x), r, n, pr).then((gt) => { histStore[key] = orientHist(x, gt, r) || false; }).catch(() => { histStore[key] = false; setTimeout(() => { if (histStore[key] === false) delete histStore[key]; }, 5 * 60e3); }); // failed: allow a fresh try in 5 min
      histStore[key] = job; jobs.push(job);
    };
    const got = (x, r) => { const h = histStore[hkey(x, r)]; return h && !h.then ? h : null; };
    // 1) this pool's own trades
    want(p, 'day', 400, prio + 3);
    if (res === 'hourly') want(p, 'hour', need + 48, prio + 3);
    await Promise.all(jobs.splice(0));
    onStage && onStage();
    // 2) the pool's history may be short (new Aero pools launched Oct 22, 2026): extend the price path with the same
    //    pair's longest-lived other pools (old Aerodrome, Uniswap, other chains)
    const own = got(p, res === 'hourly' ? 'hour' : 'day');
    if (!own || own.n < need) {
      const sibs = pairAll(p).filter((x) => x !== p && (x.liq || 0) > 5000).sort((x, y) => (y.liq || 0) - (x.liq || 0)).slice(0, 4);
      for (const x of sibs) want(x, 'day', 400, prio + 2);
      await Promise.all(jobs.splice(0));
      if (res === 'hourly') {
        const best = sibs.map((x) => ({ x, h: got(x, 'day') })).filter((o) => o.h).sort((u, v) => u.h.k0 - v.h.k0)[0];
        if (best && (!own || best.h.k0 * 24 < own.k0 - 24)) want(best.x, 'hour', need + 48, prio + 2);
        await Promise.all(jobs.splice(0));
      }
      onStage && onStage();
    }
    // 3) daily volume for the other pools in the compare table
    for (const x of pairPools(p)) if (x !== p) want(x, 'day', 400, prio);
    await Promise.all(jobs);
    onStage && onStage();
  }
  function chainRow(p, day) { // on-chain snapshot for a pool on a day (nearest earlier day, else the earliest)
    if (!chainHist || !chainDayIdx) return null;
    const arr = chainHist.p[p.addr.toLowerCase()];
    if (!arr) return null;
    let i = chainDayIdx[day];
    if (i == null) { const ds = chainHist.days; i = day > ds[ds.length - 1] ? ds.length - 1 : day < ds[0] ? 0 : ds.findIndex((d) => d > day) - 1; }
    for (let j = i; j >= 0; j--) if (arr[j]) return arr[j];
    for (let j = i + 1; j < arr.length; j++) if (arr[j]) return arr[j];
    return null;
  }

  function buildSeries() {
    const [res, n] = PERIODS[S.period];
    const r2 = res === 'hourly' ? 'hour' : 'day';
    const src = D[res], len = src.end - src.start + 1, i0 = Math.max(0, len - n - 1);
    const sa = usdArr(pool.a, res), sb = usdArr(pool.b, res), sAero = D[res].prices.AERO;
    // price sources: this pool first, then the same pair's other pools, longest history first
    const hs = (x, r) => { const h = histStore[hkey(x, r)]; return h && !h.then ? h : null; };
    const own = hs(pool, r2);
    const ownDay = hs(pool, 'day');
    const sibs = pairAll(pool).filter((x) => x !== pool).map((x) => ({ x, h: hs(x, r2) })).filter((o) => o.h).sort((u, v) => v.h.n - u.h.n);
    const srcs = [...(own ? [{ x: pool, h: own }] : []), ...sibs];
    // average daily USD volume of this pool over its own full days (used before the pool existed)
    let avgDayVol = null;
    if (ownDay) {
      let tot = 0, cnt = 0;
      for (let k = ownDay.k0; k < ownDay.k1; k++) { // full days only (the last bar is today, still filling)
        const bb = ownDay.map[k], di = k - D.daily.start;
        cnt++;
        if (!bb) continue;
        const uB = pool.b === 'USDC' ? 1 : D.daily.prices[pool.b]?.[di], uA = pool.a === 'USDC' ? 1 : D.daily.prices[pool.a]?.[di];
        const u = bb[5] ? uB : uA;
        if (u) tot += bb[4] * u;
      }
      if (cnt) avgDayVol = tot / cnt;
    }
    const t = [], P = [], H = [], L = [], ua = [], ub = [], vol = [], ps = [], vs = [], ae = [], hc = [];
    const last = srcs.map(() => null);
    let feedK = null; // scale factor so the USD-feed ratio lines up with pool prices where they meet
    const raw = [];
    for (let i = i0; i < len; i++) {
      const k = src.start + i;
      const x = sa ? sa[i] : 1, y = sb ? sb[i] : 1;
      let bar = null, from = null, flip = false;
      for (let j = 0; j < srcs.length; j++) {
        const h = srcs[j].h;
        if (k < h.k0 || k > h.k1) continue;
        const f = srcs[j].x.a !== pool.a;
        let b0 = h.map[k];
        if (!b0) { const lc = last[j]; if (lc == null) continue; b0 = [lc, lc, lc, lc, 0, true]; } // no trades that bar: price unchanged
        last[j] = b0[3];
        bar = f ? [1 / b0[0], 1 / b0[2], 1 / b0[1], 1 / b0[3], b0[4], !b0[5]] : b0; from = srcs[j].x; flip = f;
        break;
      }
      // keep carrying "last close" for sources even when an earlier one won this bar
      for (let j = 0; j < srcs.length; j++) { const b0 = srcs[j].h.map[k]; if (b0) last[j] = b0[3]; }
      raw.push({ k, x, y, bar, from });
    }
    // align the feed ratio to the pool price at the boundary
    const firstPool = raw.findIndex((r) => r.bar && r.x != null && r.y != null);
    if (firstPool >= 0) feedK = raw[firstPool].bar[3] / (raw[firstPool].x / raw[firstPool].y);
    let lastPoolIdx = -1;
    for (let i = raw.length - 1; i >= 0; i--) if (raw[i].bar && raw[i].x != null && raw[i].y != null) { lastPoolIdx = i; break; }
    const feedK2 = lastPoolIdx >= 0 ? raw[lastPoolIdx].bar[3] / (raw[lastPoolIdx].x / raw[lastPoolIdx].y) : feedK;
    const info = { pool: 0, pair: 0, feed: 0, vPool: 0, vAvg: 0, vLive: 0, pairName: null };
    for (let ii = 0; ii < raw.length; ii++) {
      const { k, x, y, bar, from } = raw[ii];
      if (x == null || y == null) continue;
      let Pc, Ph, Pl;
      if (bar) { Pc = bar[3]; Ph = Math.max(bar[1], Pc); Pl = Math.min(bar[2], Pc); if (from === pool) info.pool++; else { info.pair++; info.pairName = info.pairName || from; } }
      else { const fk = (ii < firstPool ? feedK : feedK2) || 1; Pc = (x / y) * fk; Ph = Pl = Pc; info.feed++; }
      // USD: quote side from the USD feed (USDC = $1), base side = pool price × quote
      let uA, uB;
      if (pool.a === 'USDC' && pool.b !== 'USDC') { uA = 1; uB = 1 / Pc; } else { uB = sb ? y : 1; uA = Pc * uB; }
      // this pool's own volume for the bar (USD)
      let v = null;
      const ob = own && own.map[k];
      if (own && k >= own.k0 && k <= own.k1) { v = ob ? ob[4] * (ob[5] ? uB : uA) : 0; info.vPool++; }
      else if (res === 'hourly' && ownDay) {
        const dk = Math.floor(((k - 1) * 3600) / 86400), db = ownDay.map[dk];
        if (dk >= ownDay.k0 && dk <= ownDay.k1) { v = db ? (db[4] * (db[5] ? uB : uA)) / 24 : 0; info.vPool++; }
      }
      if (v == null && avgDayVol != null) { v = avgDayVol * (src.step / 86400); info.vAvg++; }
      if (v == null) info.vLive++;
      t.push(k * src.step); P.push(Pc); H.push(Ph); L.push(Pl); ua.push(uA); ub.push(uB); vol.push(v);
      ae.push(sAero ? sAero[k - src.start] : null);
      hc.push(chainRow(pool, Math.floor(((res === 'hourly' ? k - 1 : k) * src.step) / 86400)));
    }
    const lu = liveUsd();
    const now = Math.floor(Date.now() / 1000);
    if (lu && t.length && now > t[t.length - 1] + 60) { const Pn = lu[0] / lu[1]; t.push(now); P.push(Pn); H.push(Pn); L.push(Pn); ua.push(lu[0]); ub.push(lu[1]); vol.push(null); ae.push(aeroPx || ae[ae.length - 1]); hc.push(hc[hc.length - 1] || null); }
    ser = { t, P, H, L, ua, ub, vol, aero: ae, hc, step: src.step, info };
  }

  // ---------- concentrated-liquidity math ----------
  function amounts(L, P, lo, hi) {
    if (!(lo > 0) || !isFinite(hi)) { const sp = Math.sqrt(P); return [L / sp, L * sp]; }
    const sa = Math.sqrt(lo), sb = Math.sqrt(hi);
    if (P <= lo) return [L * (1 / sa - 1 / sb), 0];
    if (P >= hi) return [0, L * (sb - sa)];
    const sp = Math.sqrt(P);
    return [L * (1 / sp - 1 / sb), L * (sp - sa)];
  }
  function inRange(P, lo, hi) { return !(lo > 0) || !isFinite(hi) ? true : P >= lo && P <= hi; }
  function params() {
    const fee = chainSt && chainSt.fee != null ? chainSt.fee : pool.fee;
    const vol = S.volMode === 'custom' ? (S.customVol || 0) : S.volMode === 'avg7' && avg7 ? avg7.avg : pool.vol || 0; // 'hist' uses each bar's real volume, this only fills gaps
    const decA = chainSt?.decA ?? 18, decB = chainSt?.decB ?? 18;
    const sg = chainSt?.sugar;
    const lu = liveUsd();
    const ufee = sg ? sg.unstakedFee : pool.ufee ?? 0;
    const emUsdDay = sg && sg.alive && aeroPx ? sg.emPerSec * 86400 * aeroPx : 0;
    const stakedUsd = sg && lu ? (sg.stakedA || 0) * lu[0] + (sg.stakedB || 0) * lu[1] : null;
    return {
      dep: S.dep, fee: fee || 0, vol, feeShare: (S.feeShare / 100) * (1 - ufee), ufee, earn: S.earn, aeroApr: S.aeroApr / 100,
      aeroLive: S.aeroSrc === 'live' && !!sg, emUsdDay, Lstaked: sg ? sg.gaugeL : null, stakedUsd, gaugeAlive: sg ? sg.alive : null,
      cl: isCL(pool), Lpool: chainSt?.L ?? null, decA, decB, tvl: pool.liq || 0,
      hist: S.volMode === 'hist', emAeroDay: sg && sg.alive ? sg.emPerSec * 86400 : 0, aeroPxNow: aeroPx,
      reb: S.reb, rebDelay: S.rebDelay, slip: S.slip / 100, gas: S.gas,
    };
  }
  function shareFor(L, o) {
    if (o.cl && o.Lpool > 0) { const Lr = L * Math.pow(10, (o.decA + o.decB) / 2); return Lr / (o.Lpool + Lr); }
    return o.dep / (o.tvl + o.dep);
  }
  function aeroShare(L, o) { // your share of the gauge's AERO stream (only in-range staked liquidity earns on Slipstream)
    if (o.cl) { if (!(o.Lstaked >= 0)) return 0; const Lr = L * Math.pow(10, (o.decA + o.decB) / 2); return Lr / (o.Lstaked + Lr); }
    return o.stakedUsd != null ? o.dep / (o.stakedUsd + o.dep) : 0;
  }
  function btRange(lo, hi) { // range used for the backtest
    if (S.mode === 'relative' && lo > 0 && isFinite(hi)) { const k = ser.P[0] / livePriceOrLast(); return [lo * k, hi * k]; }
    return [lo, hi];
  }
  function livePriceOrLast() { return livePrice() || ser.P[ser.P.length - 1]; }

  // share of the bar's time spent inside [lo, hi], following the usual OHLC path: open → nearer extreme → other extreme → close
  function barInFrac(p0, h, l, c, lo, hi) {
    if (!(lo > 0) || !isFinite(hi)) return 1;
    const pts = h === l ? [p0, c] : (c >= p0 ? [p0, l, h, c] : [p0, h, l, c]);
    let tot = 0, inn = 0;
    for (let j = 1; j < pts.length; j++) {
      const a = pts[j - 1], b = pts[j], d = Math.abs(b - a);
      tot += d;
      if (d === 0) continue;
      const x = Math.max(Math.min(a, b), lo), y = Math.min(Math.max(a, b), hi);
      if (y > x) inn += y - x;
    }
    return tot > 0 ? inn / tot : (c >= lo && c <= hi ? 1 : 0);
  }
  function backtest(lo0, hi0, o, keepPath) {
    const n = ser.t.length;
    if (n < 3) return null;
    let [lo, hi] = btRange(lo0, hi0);
    const full = !(lo > 0) || !isFinite(hi);
    const P0 = ser.P[0];
    const [x1, y1] = amounts(1, P0, lo, hi);
    let L = o.dep / (x1 * ser.ua[0] + y1 * ser.ub[0]);
    const x0 = x1 * L, y0 = y1 * L;
    // range shape kept when re-centering: multiples of the centre price
    const c0 = !full && P0 >= lo && P0 <= hi ? P0 : Math.sqrt(lo * hi);
    const wLo = full ? 0 : lo / c0, wHi = full ? Infinity : hi / c0;
    const dec = Math.pow(10, (o.decA + o.decB) / 2);
    const shareAt = (Lx, hc, V, i) => {
      // o.self: checking a real position, whose liquidity is already inside the pool's recorded totals while in range
      if (o.cl) { let Lp = o.hist && hc && hc[2] > 0 ? hc[2] : o.Lpool; if (Lp > 0) { const Lr = Lx * dec; if (o.self && Lp > Lr) Lp -= Lr; /* if smaller than yours, it was out of range at that snapshot */ return Lr / (Lp + Lr); } }
      const tvl = o.hist && hc && hc[5] != null ? hc[5] * ser.ua[i] + hc[6] * ser.ub[i] : o.tvl;
      return V / (tvl + V);
    };
    const aShareAt = (Lx, hc, V, i) => {
      if (o.cl) { let gl = o.hist && hc ? hc[1] : o.Lstaked; if (!(gl >= 0)) return 0; const Lr = Lx * dec; if (o.self && gl > Lr) gl -= Lr; return Lr / (gl + Lr); }
      const st = o.hist && hc && hc[3] != null ? hc[3] * ser.ua[i] + hc[4] * ser.ub[i] : o.stakedUsd;
      return st != null ? V / (st + V) : 0;
    };
    let fees = 0, rew = 0, exits = 0, tIn = 0, tTot = 0, outRun = 0, longestOut = 0, reb = 0, rebCost = 0;
    let prevIn = inRange(P0, lo, hi), prevV = o.dep;
    const path = keepPath ? { t: [], v: [], h: [], f: [] } : null;
    let V = o.dep, Hd = o.dep;
    for (let i = 0; i < n; i++) {
      const P = ser.P[i];
      let [x, y] = amounts(L, P, lo, hi);
      V = x * ser.ua[i] + y * ser.ub[i];
      Hd = x0 * ser.ua[i] + y0 * ser.ub[i];
      const inR = inRange(P, lo, hi);
      if (i > 0) {
        const dt = (ser.t[i] - ser.t[i - 1]) / 86400;
        const f = full ? 1 : barInFrac(ser.P[i - 1], ser.H[i], ser.L[i], P, lo, hi);
        const hc = ser.hc[i];
        tTot += dt; tIn += f * dt;
        if (f > 0) {
          if (o.earn === 'fees') {
            const v = o.hist && ser.vol[i] != null ? ser.vol[i] : o.vol * dt;
            fees += v * o.fee * o.feeShare * shareAt(L, hc, prevV, i) * f;
          } else if (o.aeroLive) {
            const emA = o.hist && hc ? hc[0] : o.emAeroDay;
            const px = o.hist && ser.aero[i] ? ser.aero[i] : o.aeroPxNow;
            rew += (emA || 0) * (px || 0) * aShareAt(L, hc, prevV, i) * f * dt;
          } else rew += (prevV * o.aeroApr * dt * f) / 365;
        }
        if (prevIn && (f < 1 || !inR)) exits++;
        if (!inR) { outRun += dt; longestOut = Math.max(longestOut, outRun); } else outRun = 0;
        // re-center the range when price leaves it (swap to the new mix, pay pool fee + slippage + gas)
        if (!full && o.reb !== 'off' && !inR && outRun * 24 >= (o.reb === 'delay' ? o.rebDelay : 0) - 1e-9) {
          lo = P * wLo; hi = P * wHi;
          const [nx1, ny1] = amounts(1, P, lo, hi);
          const Lnew0 = V / (nx1 * ser.ua[i] + ny1 * ser.ub[i]);
          const swapUsd = Math.abs(nx1 * Lnew0 - x) * ser.ua[i];
          const cost = swapUsd * (o.fee + o.slip) + o.gas;
          V -= cost; rebCost += cost; reb++;
          L = V / (nx1 * ser.ua[i] + ny1 * ser.ub[i]);
          outRun = 0;
        }
      }
      prevIn = inRange(P, lo, hi); prevV = V;
      if (path) { path.t.push(ser.t[i]); path.v.push(V); path.h.push(Hd); path.f.push(fees + rew); }
    }
    const share = shareAt(L, ser.hc[n - 1], V, n - 1), ashare = aShareAt(L, ser.hc[n - 1], V, n - 1);
    const earned = fees + rew;
    return {
      lo, hi, share, ashare, L, x0, y0, timeIn: tTot ? tIn / tTot : 0, exits, longestOut, fees, rew, earned, reb, rebCost,
      Vend: V, Hend: Hd, il: V - Hd, ilPct: Hd ? (V - Hd) / Hd : 0, net: V + earned - Hd, netPct: Hd ? (V + earned - Hd) / Hd : 0,
      pnl: V + earned - o.dep, pnlPct: (V + earned - o.dep) / o.dep, apr: tTot ? (earned / o.dep) * (365 / tTot) : 0, days: tTot, path,
    };
  }
  function nowEst(lo, hi, o) {
    const lu = liveUsd();
    const Pn = livePrice();
    if (!lu || !Pn) return null;
    const [x1, y1] = amounts(1, Pn, lo, hi);
    const L = o.dep / (x1 * lu[0] + y1 * lu[1]);
    const [x, y] = [x1 * L, y1 * L];
    const inR = inRange(Pn, lo, hi);
    const share = shareFor(L, o);
    const feeDaily = inR ? o.vol * o.fee * o.feeShare * share : 0;
    const ash = aeroShare(L, o);
    const aeroDaily = !inR ? 0 : o.aeroLive ? o.emUsdDay * ash : (o.dep * o.aeroApr) / 365;
    const daily = o.earn === 'fees' ? feeDaily : aeroDaily;
    const Lfull = o.dep / (2 * Math.sqrt(Pn) * lu[1]);
    return { x, y, ua: x * lu[0], ub: y * lu[1], inR, share, ash, daily, feeDaily, aeroDaily, feeApr: (feeDaily * 365) / o.dep, aeroAprNow: (aeroDaily * 365) / o.dep, apr: (daily * 365) / o.dep, eff: L / Lfull };
  }

  // ---------- display transform (invert) ----------
  const disp = (x) => (S.inv ? (x > 0 ? 1 / x : Infinity) : x);
  function dispRange() {
    if (S.full) return [null, null];
    return S.inv ? [1 / S.hi, 1 / S.lo] : [S.lo, S.hi];
  }
  function setDispRange(dl, dh) {
    if (!(dl > 0) || !(dh > dl)) return;
    S.full = false;
    if (S.inv) { S.lo = 1 / dh; S.hi = 1 / dl; } else { S.lo = dl; S.hi = dh; }
  }
  const pairLabel = () => (S.inv ? `${pool.a} per ${pool.b}` : `${pool.b} per ${pool.a}`);
  const priceLabel = () => (S.inv ? `Price of ${pool.b} in ${pool.a}` : `Price of ${pool.a} in ${pool.b}`);

  // ---------- chart (Lightweight Charts) ----------
  let chart, line, plLo, plHi, overlay = {}, drag = null, lastT = 0;
  function initChart() {
    const el = $('#simChart');
    chart = LC.createChart(el, {
      autoSize: true,
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#8a93a6', fontFamily: "'Satoshi', system-ui, sans-serif" },
      grid: { vertLines: { color: '#141b27' }, horzLines: { color: '#141b27' } },
      rightPriceScale: { borderColor: '#232d3f', scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderColor: '#232d3f', timeVisible: true, secondsVisible: false },
      crosshair: { mode: LC.CrosshairMode.Normal },
      localization: { priceFormatter: fmtP },
    });
    line = chart.addLineSeries({
      color: '#e7eaf0', lineWidth: 2, priceFormat: { type: 'custom', formatter: fmtP, minMove: 1e-12 },
      autoscaleInfoProvider: (orig) => {
        const r = orig();
        const [dl, dh] = dispRange();
        if (r && dl > 0 && isFinite(dh)) {
          const span = r.priceRange.maxValue - r.priceRange.minValue;
          // keep the range visible, but don't let a huge range flatten the price line
          r.priceRange.minValue = Math.min(r.priceRange.minValue, Math.max(dl, r.priceRange.minValue - span * 1.5));
          r.priceRange.maxValue = Math.max(r.priceRange.maxValue, Math.min(dh, r.priceRange.maxValue + span * 1.5));
        }
        return r;
      },
    });
    plLo = line.createPriceLine({ price: 0, color: '#3ecf8e', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'Min' });
    plHi = line.createPriceLine({ price: 0, color: '#3ecf8e', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'Max' });
    for (const k of ['band', 'hHi', 'hLo', 'hMid']) {
      const d = document.createElement('div');
      d.className = 'sim-' + k;
      el.appendChild(d);
      overlay[k] = d;
    }
    overlay.hHi.innerHTML = '<span>Max</span>'; overlay.hLo.innerHTML = '<span>Min</span>'; overlay.hMid.innerHTML = '⇕';
    overlay.hHi.title = 'Drag to set max price'; overlay.hLo.title = 'Drag to set min price'; overlay.hMid.title = 'Drag to move the whole range';
    for (const [k, which] of [['hHi', 'hi'], ['hLo', 'lo'], ['hMid', 'mid']]) {
      overlay[k].addEventListener('pointerdown', (e) => {
        e.preventDefault();
        overlay[k].setPointerCapture(e.pointerId);
        const [dl, dh] = dispRange();
        drag = { which, y0: e.clientY, dl, dh, p0: line.coordinateToPrice(e.clientY - el.getBoundingClientRect().top) };
      });
      overlay[k].addEventListener('pointermove', (e) => {
        if (!drag) return;
        const y = e.clientY - el.getBoundingClientRect().top;
        const pr = line.coordinateToPrice(y);
        if (!(pr > 0)) return;
        if (drag.which === 'hi') setDispRange(drag.dl, Math.max(pr, drag.dl * 1.0005));
        else if (drag.which === 'lo') setDispRange(Math.min(pr, drag.dh / 1.0005), drag.dh);
        else { const k = pr / drag.p0; setDispRange(drag.dl * k, drag.dh * k); }
        syncRangeUI(); lightCompute();
      });
      const end = () => { if (drag) { drag = null; compute(); } };
      overlay[k].addEventListener('pointerup', end);
      overlay[k].addEventListener('pointercancel', end);
    }
    const loop = () => { positionOverlay(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
  function positionOverlay() {
    if (!chart || !line) return;
    const el = $('#simChart');
    const [dl, dh] = dispRange();
    const show = dl > 0 && isFinite(dh) && ser && ser.t.length;
    const paneH = el.clientHeight - chart.timeScale().height();
    const paneW = el.clientWidth - chart.priceScale('right').width();
    let yT = show ? line.priceToCoordinate(dh) : null, yB = show ? line.priceToCoordinate(dl) : null;
    if (yT == null || yB == null) { for (const k in overlay) overlay[k].style.display = 'none'; return; }
    const cT = Math.max(0, Math.min(paneH, yT)), cB = Math.max(0, Math.min(paneH, yB));
    Object.assign(overlay.band.style, { display: 'block', top: cT + 'px', height: Math.max(0, cB - cT) + 'px', width: paneW + 'px' });
    const place = (d, y, vis) => Object.assign(d.style, { display: vis ? 'flex' : 'none', top: y + 'px', width: paneW + 'px' });
    place(overlay.hHi, cT, yT >= -2 && yT <= paneH + 2);
    place(overlay.hLo, cB, yB >= -2 && yB <= paneH + 2);
    Object.assign(overlay.hMid.style, { display: cB - cT > 34 ? 'flex' : 'none', top: (cT + cB) / 2 + 'px', left: paneW - 34 + 'px' });
  }
  function setChartData() {
    if (!chart) return;
    const data = [];
    let prev = -1;
    for (let i = 0; i < ser.t.length; i++) { if (ser.t[i] <= prev) continue; data.push({ time: ser.t[i], value: disp(ser.P[i]) }); prev = ser.t[i]; }
    line.setData(data);
    lastT = prev;
    chart.timeScale().fitContent();
    updatePriceLines();
  }
  function updatePriceLines() {
    const [dl, dh] = dispRange();
    const vis = dl > 0 && isFinite(dh);
    plLo.applyOptions({ price: vis ? dl : 0, lineVisible: vis, axisLabelVisible: vis });
    plHi.applyOptions({ price: vis ? dh : 0, lineVisible: vis, axisLabelVisible: vis });
  }
  function pushLivePoint() {
    if (!line || !ser) return;
    const P = livePrice();
    if (!P) return;
    const now = Math.floor(Date.now() / 1000);
    if (now < lastT) return;
    line.update({ time: now, value: disp(P) });
    lastT = now;
  }

  // ---------- value chart (Chart.js) ----------
  let vChart;
  function renderValueChart(r) {
    const cv = $('#simValue');
    if (!r || !r.path) return;
    const step = Math.max(1, Math.floor(r.path.t.length / 400));
    const idx = [];
    for (let i = 0; i < r.path.t.length; i += step) idx.push(i);
    if (idx[idx.length - 1] !== r.path.t.length - 1) idx.push(r.path.t.length - 1);
    const hourly = ser.step === 3600;
    const labels = idx.map((i) => new Date(r.path.t[i] * 1000).toLocaleDateString(undefined, hourly ? { month: 'short', day: 'numeric', hour: '2-digit' } : { month: 'short', day: 'numeric', year: '2-digit' }));
    const ds = [
      { label: 'LP position + ' + (S.earn === 'fees' ? 'fees' : 'AERO rewards'), data: idx.map((i) => r.path.v[i] + r.path.f[i]), borderColor: '#5b8cff', backgroundColor: 'rgba(91,140,255,.08)', fill: true },
      { label: 'Just holding (HODL)', data: idx.map((i) => r.path.h[i]), borderColor: '#f6c177' },
      { label: 'LP position, no fees', data: idx.map((i) => r.path.v[i]), borderColor: '#8a93a6', borderDash: [4, 4] },
    ];
    if (vChart) { vChart.data.labels = labels; vChart.data.datasets = ds; vChart.update('none'); return; }
    vChart = new Chart(cv, {
      type: 'line', data: { labels, datasets: ds },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { boxWidth: 10, boxHeight: 10 } }, tooltip: { backgroundColor: '#161e2b', borderColor: '#232d3f', borderWidth: 1, callbacks: { label: (c) => `${c.dataset.label}: ${usd(c.parsed.y, 2)}` } } },
        scales: { x: { ticks: { maxTicksLimit: 6, maxRotation: 0 }, grid: { display: false } }, y: { ticks: { maxTicksLimit: 5, callback: (v) => usdK(v) } } },
        elements: { point: { radius: 0 }, line: { borderWidth: 1.6, tension: 0 } },
      },
    });
  }

  // ---------- UI ----------
  function modePools() {
    const legacy = $('#simLegacy').checked;
    return D.pools.filter((p) => inMode(p) && (mode === 'uni' || legacy || p.venue !== 'legacy'));
  }
  function poolOptions() {
    const q = ($('#simSearch').value || '').trim().toLowerCase();
    const match = (p) => !q || [p.a + '/' + p.b, p.b + '/' + p.a, (p.sa || '') + '/' + (p.sb || ''), (p.sb || '') + '/' + (p.sa || '')].some((x) => x.toLowerCase().includes(q));
    const list = modePools().filter((p) => (S.chain === 'all' || chainOf(p) === S.chain) && match(p)).slice().sort((x, y) => (y.liq || 0) - (x.liq || 0));
    const sym = (p) => (isUni(p) && chainOf(p) === 'robinhood' && p.sa && p.sa !== p.a ? ` (${p.sa}/${p.sb})` : '');
    const opt = (p) => `<option value="${p.addr}" ${pool && p.addr === pool.addr ? 'selected' : ''}>${p.a}/${p.b}${sym(p)} · ${kindFmt(p)} · ${feeFmt(p.fee)} · TVL ${usdK(p.liq)}</option>`;
    let h = '';
    for (const c of Object.keys(CHAINS)) {
      const g = list.filter((p) => chainOf(p) === c && p.venue !== 'legacy');
      if (g.length) h += `<optgroup label="${mode === 'uni' ? 'Uniswap' : 'Aero'} · ${CHAINS[c]}">${g.map(opt).join('')}</optgroup>`;
    }
    const old = list.filter((p) => p.venue === 'legacy');
    if (old.length) h += `<optgroup label="Old Aerodrome pools · Base">${old.map(opt).join('')}</optgroup>`;
    if (pool && !list.includes(pool)) h = opt(pool) + h;
    $('#simPool').innerHTML = h || '<option>No pools match</option>';
  }
  function defaultPool() {
    const ps = modePools().filter((p) => p.venue !== 'legacy' && (S.chain === 'all' || chainOf(p) === S.chain));
    return (ps.filter(isCL).sort((x, y) => y.liq - x.liq)[0] || ps.sort((x, y) => y.liq - x.liq)[0])?.addr;
  }
  function seg(el, items, cur, onPick) {
    el.innerHTML = items.map(([id, label]) => `<button data-id="${id}" class="${id === cur ? 'on' : ''}">${label}</button>`).join('');
    el.onclick = (e) => { const b = e.target.closest('button'); if (b) onPick(b.dataset.id); };
  }
  function renderSegs() {
    seg($('#simPeriods'), Object.keys(PERIODS).map((k) => [k, k]), S.period, (id) => { S.period = id; renderSegs(); buildSeries(); setChartData(); compute(); refreshHistory(); });
    seg($('#simMode'), [['fixed', 'My exact prices'], ['relative', 'Same % width from start']], S.mode, (id) => { S.mode = id; renderSegs(); compute(); });
    seg($('#simEarn'), [['fees', 'Trading fees'], ['aero', 'AERO rewards']], S.earn, (id) => { S.earn = id; renderSegs(); compute(); });
    const cnt = (c) => modePools().filter((p) => p.venue !== 'legacy' && (c === 'all' || chainOf(p) === c)).length;
    seg($('#simChains'), [['all', `All chains ${cnt('all')}`], ...Object.entries(CHAINS).map(([c, n]) => [c, `${n} ${cnt(c)}`])], S.chain, (id) => {
      S.chain = id; renderSegs(); poolOptions();
      if (pool && id !== 'all' && chainOf(pool) !== id) { const a = defaultPool(); if (a) selectPool(a); }
    });
    const v7 = avg7 ? `7-day avg ${usdK(avg7.avg)}` : '7-day avg';
    seg($('#simVolMode'), [['hist', 'Real pool history'], ['live', `Live 24h ${pool ? usdK(pool.vol) : ''}`], ['avg7', v7], ['custom', 'Custom']], S.volMode, (id) => {
      S.volMode = id;
      if (id === 'custom' && S.customVol == null) S.customVol = pool?.vol || 0;
      renderSegs(); compute();
    });
    seg($('#simReb'), [['off', 'Never'], ['exit', 'When price exits'], ['delay', 'After hours out']], S.reb, (id) => { S.reb = id; renderSegs(); compute(); });
    $('#simRebOpts').hidden = S.reb === 'off';
    $('#simRebDelayWrap').hidden = S.reb !== 'delay';
    seg($('#simAeroSrc'), [['live', 'Live from Aero'], ['manual', 'Enter my own']], S.aeroSrc, (id) => { S.aeroSrc = id; renderSegs(); compute(); });
    $('#simAeroSrcWrap').hidden = S.earn !== 'aero';
    $('#simAeroWrap').hidden = S.earn !== 'aero' || S.aeroSrc !== 'manual';
    $('#simCustomVolWrap').hidden = S.volMode !== 'custom';
    if (S.volMode === 'custom') $('#simCustomVol').value = Math.round(S.customVol || 0);
    const presets = [['0.01', '±1%'], ['0.02', '±2%'], ['0.05', '±5%'], ['0.1', '±10%'], ['0.2', '±20%'], ['0.5', '±50%'], ['full', 'Full range']];
    $('#simPresets').innerHTML = presets.map(([k, l]) => `<button data-w="${k}" ${!isCL(pool) && k !== 'full' ? 'disabled' : ''}>${l}</button>`).join('');
  }
  function applyWidth(w) {
    const Pn = livePrice() || ser.P[ser.P.length - 1];
    if (w === 'full') { S.full = true; S.lo = 0; S.hi = Infinity; }
    else { S.full = false; S.lo = Pn * (1 - w); S.hi = Pn * (1 + w); }
  }
  function syncRangeUI() {
    const [dl, dh] = dispRange();
    const Pn = livePrice() || (ser ? ser.P[ser.P.length - 1] : null);
    const dP = Pn ? disp(Pn) : null;
    const minI = $('#simMin'), maxI = $('#simMax');
    if (document.activeElement !== minI) minI.value = S.full ? '0' : fmtP(dl).replace(/,/g, '');
    if (document.activeElement !== maxI) maxI.value = S.full ? '∞' : fmtP(dh).replace(/,/g, '');
    minI.disabled = maxI.disabled = !isCL(pool);
    const dnI = $('#simDnPct'), upI = $('#simUpPct');
    dnI.disabled = upI.disabled = !isCL(pool);
    if (document.activeElement !== dnI) dnI.value = S.full || !dP ? '' : +((1 - dl / dP) * 100).toFixed(2);
    if (document.activeElement !== upI) upI.value = S.full || !dP ? '' : +((dh / dP - 1) * 100).toFixed(2);
    $('#simUnit').textContent = pool ? pairLabel() : '';
    $('#simBasicNote').hidden = isCL(pool);
    updatePriceLines();
  }
  function poolAeroApr() {
    const sg = chainSt?.sugar, lu = liveUsd();
    if (!sg || !aeroPx || !lu) return pool.rapr ?? null;
    if (!sg.alive || !sg.emPerSec) return 0;
    const emYr = sg.emPerSec * 365 * 86400 * aeroPx;
    let val;
    if (sg.type > 0) {
      const aIs0 = pool.baseAddr ? pool.baseAddr.toLowerCase() === chainSt.t0 : true;
      const u1 = aIs0 ? lu[1] : lu[0];
      val = (sg.gaugeL / Math.pow(10, (chainSt.d0 + chainSt.d1) / 2)) * Math.sqrt(chainSt.p10) * ((WIDTH_BPS[sg.type] ?? 300) / 1e4) * u1;
    } else val = (sg.stakedA || 0) * lu[0] + (sg.stakedB || 0) * lu[1];
    return val > 0 ? emYr / val : null;
  }
  function renderLive() {
    if (!pool) return;
    const P = livePrice();
    const age = Math.round((Date.now() - Math.max(pool.liveTs || 0, chainSt?.ts || 0)) / 1000);
    const fresh = (pool.liveTs || chainSt?.ts) && age < 150;
    const tvlNote = pool.src === 'sugar' ? ' · TVL/vol hourly from Aero' : '';
    const fee = chainSt?.fee ?? pool.fee;
    const k = (l, v, s = '', c = '') => `<div class="kpi"><div class="k">${l}</div><div class="v ${c}">${v}</div><div class="s">${s}</div></div>`;
    const n = ser && S.lo != null ? nowEst(S.lo, S.hi, params()) : null;
    $('#simLive').innerHTML =
      k(priceLabel(), fmtP(disp(P)), `${pairLabel()}${pool.chg24 == null ? '' : ' · 24h ' + spct(pool.chg24 / 100)}`) +
      (() => {
        if (isUni(pool)) return k('Protocol fee', pool.ufee ? pct(pool.ufee, 1) : 'Off', pool.ufee ? 'of swap fees goes to Uniswap, already taken off' : 'LPs keep 100% of swap fees');
        if (pool.venue === 'legacy') return k('AERO APR · your range', '0%', 'old Aerodrome gauges stopped');
        const ref = poolAeroApr();
        const refTxt = ref == null ? '' : isCL(pool) ? `Aero app shows ${pct(ref, 1)} (its ±${((WIDTH_BPS[pool.kind?.slice(2)] ?? 300) / 100).toFixed(2).replace(/\.?0+$/, '')}% reference range)` : `Aero app shows ${pct(ref, 1)}`;
        if (!n) return k('AERO APR · your range', '—', refTxt);
        return k('AERO APR · your range', n.inR ? pct(n.aeroAprNow, 1) : '0%', n.inR ? refTxt : 'out of range · ' + refTxt, n.inR && n.aeroAprNow > 0 ? 'good' : n.inR ? '' : 'bad');
      })() +
      k('Pool TVL', usdK(pool.liq), `${venueName(pool)} · ${CHAINS[chainOf(pool)]} · ${kindFmt(pool)}${tvlNote}`) +
      k('24h volume', usdK(pool.vol), pool.vol1 != null ? `last 1h ${usdK(pool.vol1)}` : '') +
      k('Fee now', feeFmt(fee), isUni(pool) ? 'fee tier, read on-chain' : isCL(pool) ? 'dynamic, read on-chain' : 'pool fee') +
      k('Fee APR · your range', !n ? '—' : n.inR ? pct(n.feeApr, 1) : '0%', `${isUni(pool) ? 'after protocol fee' : 'unstaked'} · pool average ${pool.liq ? pct((pool.vol * (fee || 0) * (isUni(pool) ? 1 - (pool.ufee || 0) : 1) * 365) / pool.liq, 1) : '—'}`, n && !n.inR ? 'bad' : '');
    $('#simLiveTxt').textContent = fresh ? `Live · ${age}s ago` : 'Connecting…';
    $('#simLiveDot').className = 'live-dot ' + (fresh ? 'on' : 'off');
    $('#simTitle').innerHTML = `${pool.a}/${pool.b} ${venueTag(pool)} ${chainTag(pool)}`;
    const L = [];
    const a = (href, t) => L.push(`<a href="${href}" target="_blank" rel="noopener">${t} ↗</a>`);
    if (isUni(pool)) { if (pool.app) a(pool.app, 'Uniswap app'); a(pool.url, 'DEX Screener'); }
    else { a(pool.url, pool.src === 'sugar' ? 'Aero app' : 'DEX Screener'); if (pool.ds) a(pool.ds, 'DEX Screener'); }
    if (pool.addr.length === 42) a(EXPL[chainOf(pool)][1] + pool.addr, EXPL[chainOf(pool)][0]);
    $('#simLinks').innerHTML = L.join(' · ');
  }
  let lightPending = false;
  function lightCompute() { if (lightPending) return; lightPending = true; requestAnimationFrame(() => { lightPending = false; renderNow(); }); }
  function renderNow() {
    if (!pool || !ser) return;
    renderLive();
    const o = params();
    const n = nowEst(S.lo, S.hi, o);
    const lu = liveUsd();
    const k = (l, v, s = '', c = '') => `<div class="kpi"><div class="k">${l}</div><div class="v ${c}">${v}</div><div class="s">${s}</div></div>`;
    if (!n) { $('#simNow').innerHTML = '<div class="nopool">Waiting for the live pool price…</div>'; return; }
    const warn = isCL(pool) && !(o.Lpool > 0) ? ' · on-chain liquidity unavailable, rough estimate' : isCL(pool) && n.share > 0.05 ? ' · very thin in-range liquidity: your deposit would be most of it, so real fees would likely be far lower' : '';
    const legacy = pool.venue === 'legacy', uni = isUni(pool);
    const aeroSub = legacy ? 'old Aerodrome gauges stopped' : o.gaugeAlive === false ? 'no active gauge on this pool' : !n.inR ? 'price is outside your range' : o.aeroLive ? `live · AERO ${usd(aeroPx, 4)} · ${pct(n.ash, n.ash < 0.001 ? 3 : 2)} of staked L` : S.aeroSrc === 'live' ? 'waiting for Aero data…' : 'your manual APR';
    const pick = (m) => (S.earn === m ? ' picked' : '');
    $('#simNow').innerHTML =
      `<div class="kpi${uni ? '' : pick('fees')}"><div class="k">Est. fee APR${uni ? '' : ' · unstaked'}</div><div class="v ${n.inR ? (n.feeApr > 0.2 ? 'good' : '') : 'bad'}">${n.inR ? pct(n.feeApr, 1) : '0%'}</div><div class="s">${n.inR ? 'trading fees at current volume' + (o.ufee ? ` · after ${pct(o.ufee, uni ? 1 : 0)} ${uni ? 'protocol' : 'unstaked'} fee` : '') + warn : 'price is outside your range'}</div></div>` +
      (uni ? '' : `<div class="kpi${pick('aero')}"><div class="k">Est. AERO APR · staked</div><div class="v ${n.inR && n.aeroAprNow > 0 ? 'good' : n.inR ? '' : 'bad'}">${legacy ? '0%' : pct(n.aeroAprNow, 1)}</div><div class="s">${aeroSub}</div></div>`) +
      k(`Est. earnings · ${S.earn === 'fees' ? 'fees' : 'AERO'}`, n.inR ? usd(n.daily, 2) + '/day' : '$0/day', n.inR ? usd(n.daily * 30, 0) + '/month' : 'until price re-enters') +
      k('Your share of pool', pct(n.share, n.share < 0.001 ? 3 : 2), isCL(pool) ? 'of in-range liquidity' : 'of pool TVL') +
      k('Capital efficiency', isCL(pool) && !S.full ? '×' + n.eff.toFixed(1) : '×1', 'vs full range') +
      `<div class="kpi wide"><div class="k">Deposit now (${usd(S.dep)})</div><div class="v sm">${amt(n.x)} ${pool.a} <span class="muted">${usd(n.ua)}</span> + ${amt(n.y)} ${pool.b} <span class="muted">${usd(n.ub)}</span></div><div class="s">${lu ? `${pool.a} ${usd(lu[0], lu[0] < 10 ? 4 : 2)} · ${pool.b} ${usd(lu[1], lu[1] < 10 ? 4 : 2)}` : ''}</div></div>`;
  }
  function compute() {
    if (!pool || !ser) return;
    syncRangeUI();
    renderNow();
    const o = params();
    const r = backtest(S.lo, S.hi, o, true);
    const k = (l, v, s = '', c = '') => `<div class="kpi"><div class="k">${l}</div><div class="v ${c}">${v}</div><div class="s">${s}</div></div>`;
    if (!r) { $('#simBt').innerHTML = '<div class="nopool">Not enough price history for this pool in this period.</div>'; return; }
    const startD = new Date(ser.t[0] * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const lbl = S.earn === 'fees' ? 'Fees earned' : 'AERO rewards';
    $('#simBtTitle').textContent = `Backtest · deposit ${usd(S.dep)} on ${startD} (${S.period})`;
    $('#simBt').innerHTML =
      k('Time in range', pct(r.timeIn, 0), `${r.exits} exit${r.exits === 1 ? '' : 's'} · longest out ${r.longestOut < 1 ? Math.round(r.longestOut * 24) + 'h' : r.longestOut.toFixed(1) + 'd'}`, r.timeIn > 0.8 ? 'good' : r.timeIn < 0.5 ? 'bad' : 'warn') +
      k(lbl, usd(r.earned, 2), `${pct(r.apr, 1)} APR over ${Math.round(r.days)}d`, 'good') +
      k('Impermanent loss', usd(r.il, 2), spct(r.ilPct, 2) + ' vs holding', r.il < -0.5 ? 'bad' : '') +
      k('Net vs holding', usd(r.net, 2), spct(r.netPct, 2) + ' (fees − IL)', cls(r.net)) +
      k('Total P&L in USD', usd(r.pnl, 2), spct(r.pnlPct, 2) + ` · end value ${usd(r.Vend + r.earned, 0)}`, cls(r.pnl)) +
      k('Start split', `${amt(r.x0)} ${pool.a} + ${amt(r.y0)} ${pool.b}`, S.mode === 'relative' ? `range ${fmtP(disp(S.inv ? r.hi : r.lo))}–${fmtP(disp(S.inv ? r.lo : r.hi))} at start` : 'at the start price') +
      (S.reb === 'off' || !isCL(pool) || S.full ? '' : k('Re-centers', String(r.reb), `cost ${usd(r.rebCost, 2)} (fee + slippage + gas) · now ${fmtP(disp(S.inv ? r.hi : r.lo))}–${fmtP(disp(S.inv ? r.lo : r.hi))}`, r.reb ? 'warn' : ''));
    renderHistNote();
    renderValueChart(r);
    renderOptimizer(o);
    renderCompare();
    renderPos();
    writeHash();
  }


  // ---------- check against a real position ----------
  // Reads the position NFT on-chain (Live.positionCheck), then runs the same backtest over the same window,
  // with the position's exact ticks and starting tokens, so actual vs simulated is like-for-like.
  const pos = { pool: null, id: null, r: null, err: null, busy: false, msg: '' };
  function simWindow(t0, t1, earn, lo, hi, a0, b0) {
    const n = ser.t.length;
    let i0 = 0; for (let i = 0; i < n; i++) { if (ser.t[i] <= t0) i0 = i; else break; }
    let i1 = n - 1; for (let i = i0; i < n; i++) if (ser.t[i] >= t1) { i1 = i; break; }
    if (i1 - i0 < 2) return null;
    const sl = (arr) => arr.slice(i0, i1 + 1);
    const full = ser;
    ser = { ...full, t: sl(full.t), P: sl(full.P), H: sl(full.H), L: sl(full.L), ua: sl(full.ua), ub: sl(full.ub), vol: sl(full.vol), aero: sl(full.aero), hc: sl(full.hc) };
    const mode0 = S.mode; S.mode = 'fixed';
    try {
      const dep = a0 * ser.ua[0] + b0 * ser.ub[0];
      if (!(dep > 0)) return null;
      const o = { ...params(), dep, earn, reb: 'off', hist: S.volMode === 'hist', self: true };
      if (earn === 'aero') o.aeroLive = !!chainSt?.sugar;
      const r = backtest(lo, hi, o, false);
      return r && { ...r, dep, from: ser.t[0], to: ser.t[ser.t.length - 1] };
    } finally { ser = full; S.mode = mode0; }
  }
  function renderPos() {
    const out = $('#posOut'), stEl = $('#posStatus');
    if (!out) return;
    if (pos.pool !== pool) { out.innerHTML = ''; return; }
    if (pos.busy) { stEl.textContent = pos.msg || 'Reading the position on-chain…'; out.innerHTML = ''; return; }
    if (pos.err) { stEl.innerHTML = `<span class="pos-warn">${pos.err}</span>`; out.innerHTML = ''; return; }
    const r = pos.r;
    if (!r || !ser) return;
    const aIs0 = pool.baseAddr && pool.baseAddr.toLowerCase() === r.t0;
    const p10 = (tk) => Math.pow(1.0001, tk) * Math.pow(10, r.d0 - r.d1);
    const lo = aIs0 ? p10(r.tl) : 1 / p10(r.tu), hi = aIs0 ? p10(r.tu) : 1 / p10(r.tl);
    const a0 = aIs0 ? r.start0 : r.start1, b0 = aIs0 ? r.start1 : r.start0;
    const fa = aIs0 ? r.fees0 : r.fees1, fb = aIs0 ? r.fees1 : r.fees0;
    const lu = liveUsd() || [ser.ua[ser.ua.length - 1], ser.ub[ser.ub.length - 1]];
    const now = Math.floor(Date.now() / 1000);
    const end = r.closeTs || now;
    const feeEnd = r.staked ? Math.max(r.windowTs, r.stakeTs) : end;
    const stakeFrom = r.staked ? Math.max(r.windowTs, r.stakeTs) : null;
    const realFees = fa * lu[0] + fb * lu[1];
    const realAero = r.aero != null ? r.aero * (aeroPx || 0) : null;
    const simF = feeEnd - r.windowTs > 2 * ser.step ? simWindow(r.windowTs, feeEnd, 'fees', lo, hi, a0, b0) : null;
    let simA = null;
    if (r.staked && now - stakeFrom > 2 * ser.step) {
      // starting tokens at the stake time: same liquidity, priced at that bar
      let j = 0; for (let i = 0; i < ser.t.length; i++) { if (ser.t[i] <= stakeFrom) j = i; else break; }
      const Lh = r.Lmint / Math.pow(10, (r.d0 + r.d1) / 2); // position liquidity in whole-token units
      const [xs, ys] = amounts(Lh, ser.P[j], lo, hi);
      simA = simWindow(stakeFrom, now, 'aero', lo, hi, xs, ys);
    }
    const dt = (t) => new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const days = (a, b) => { const d = (b - a) / 86400; return d < 2 ? Math.round(d * 24) + 'h' : d.toFixed(1) + 'd'; };
    const diff = (real, sim) => (real > 0 && sim != null ? spct(sim / real - 1, 0) : '—');
    const rows = [];
    if (simF || realFees > 0 || !r.staked) rows.push(`<tr><td>Trading fees${r.staked ? ' (before staking)' : ''}<div class="muted small">${dt(r.windowTs)} → ${r.staked ? dt(feeEnd) : r.closeTs ? dt(end) + ' (closed)' : 'now'} · ${days(r.windowTs, feeEnd)}</div></td><td class="num">${usd(realFees, 2)}<div class="muted small">${amt(fa)} ${pool.a} + ${amt(fb)} ${pool.b}</div></td><td class="num">${simF ? usd(simF.fees, 2) : '—'}<div class="muted small">${simF ? pct(simF.timeIn, 0) + ' in range' : 'too short to simulate'}</div></td><td class="num">${simF ? diff(realFees, simF.fees) : '—'}</td></tr>`);
    if (r.staked) rows.push(`<tr><td>AERO rewards (staked)<div class="muted small">${dt(stakeFrom)} → now · ${days(stakeFrom, now)}</div></td><td class="num">${realAero != null ? usd(realAero, 2) : '—'}<div class="muted small">${r.aero != null ? amt(r.aero) + ' AERO at today\u2019s price' : ''}</div></td><td class="num">${simA ? usd(simA.rew, 2) : '—'}<div class="muted small">${simA ? pct(simA.timeIn, 0) + ' in range' : 'too short to simulate'}</div></td><td class="num">${simA ? diff(realAero, simA.rew) : '—'}</td></tr>`);
    const notes = [];
    if (r.windowTs > r.mintTs + 3600) notes.push(`minted ${dt(r.mintTs)}; compared over the last year only`);
    if (r.changed) notes.push('<span class="pos-warn">liquidity was added or removed after minting, so the real numbers assume today\u2019s liquidity for the whole time</span>');
    if (!isUni(pool) && !r.staked && !r.closed) notes.push('if this position was staked for part of its life, fees during that time went to voters and are over-counted here');
    if (simF && simF.from > r.windowTs + ser.step * 1.5) notes.push('the simulator\u2019s history starts after the mint, so the window is shorter on the simulated side');
    const p5 = (x) => (x >= 1000 ? fmtP(x) : (+x).toPrecision(5));
    const stTxt = `Position #${pos.id} · ${p5(disp(S.inv ? hi : lo))}–${p5(disp(S.inv ? lo : hi))} ${S.inv ? pool.a : pool.b} per ${S.inv ? pool.b : pool.a} · minted ${dt(r.mintTs)} with ${amt(a0)} ${pool.a} + ${amt(b0)} ${pool.b}${r.staked ? ' · staked in the gauge' : r.closed ? ' · closed' : ' · not staked'}`;
    stEl.textContent = stTxt;
    out.innerHTML = `<div class="table-wrap" style="max-height:none"><table class="pos-tbl"><thead><tr><th>Earned</th><th class="num">Actual (on-chain)</th><th class="num">Simulator</th><th class="num">Sim vs actual</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
      <p class="muted small">Actual = the pool's own fee and reward counters for this NFT (the same math the contract uses when you collect), valued at today's prices. Simulator = this page's backtest with the same ticks, start date and starting tokens, using the volume, liquidity and AERO settings above.${notes.length ? ' Note: ' + notes.join('; ') + '.' : ''}</p>
      <button class="btn" type="button" id="posUse">Load this range into the simulator</button>`;
    $('#posUse').onclick = () => { S.full = false; S.lo = lo; S.hi = hi; S.mode = 'fixed'; if (simF) S.dep = Math.round(simF.dep); $('#simDep').value = S.dep; renderSegs(); updatePriceLines(); compute(); };
  }
  async function runPosCheck(id) {
    if (!pool) return;
    const p = pool;
    Object.assign(pos, { pool: p, id, r: null, err: null, busy: true, msg: '' });
    $('#posGo').disabled = true;
    renderPos();
    try {
      const r = await Live.positionCheck(p, id, Math.floor(Date.now() / 1000) - 364 * 86400, (m) => { pos.msg = m; if (pos.pool === pool) $('#posStatus').textContent = m; });
      if (p !== pool) return;
      pos.r = r;
      // make sure the backtest period covers the position's window
      const age = (Date.now() / 1000 - r.windowTs) / 86400;
      const need = age <= 6.9 ? '7D' : age <= 29.5 ? '30D' : age <= 89.5 ? '90D' : age <= 179 ? '180D' : '1Y';
      const order = Object.keys(PERIODS);
      if (order.indexOf(S.period) < order.indexOf(need)) { S.period = need; renderSegs(); buildSeries(); setChartData(); refreshHistory(); }
    } catch (e) { pos.err = e.message || String(e); }
    finally { pos.busy = false; $('#posGo').disabled = false; }
    compute();
  }

  // ---------- compare venues: same pair on Aero and Uniswap, every chain ----------
  const cmpSt = {};
  const pkey = (p) => chainOf(p) + ':' + p.addr.toLowerCase();
  function pairPools(p) {
    const same = D.pools.filter((x) => x.venue !== 'legacy' && ((x.a === p.a && x.b === p.b) || (x.a === p.b && x.b === p.a)));
    const top = same.sort((x, y) => (y.liq || 0) - (x.liq || 0)).slice(0, 14);
    if (!top.includes(p)) top.unshift(p);
    return top;
  }
  async function loadCompare() {
    if (!pool) return;
    const p0 = pool;
    await Promise.all(pairPools(p0).map(async (x) => {
      if (x === p0) return;
      const c = cmpSt[pkey(x)];
      if (c && Date.now() - c.ts < 60e3) return;
      const st = await Live.poolState(x).catch(() => null);
      if (st) cmpSt[pkey(x)] = { st: { ...st, addr: x.addr }, ts: Date.now() };
    }));
    if (p0 === pool) renderCompare();
  }
  function evalPool(x) {
    const sv = { pool, chainSt, ser, avg7, lo: S.lo, hi: S.hi, earn: S.earn, volMode: S.volMode, full: S.full };
    try {
      if (x !== sv.pool) {
        const flip = x.a !== sv.pool.a;
        pool = x; chainSt = cmpSt[pkey(x)]?.st || null; avg7 = null;
        if (S.volMode === 'custom') S.volMode = 'hist';
        if (flip) { S.lo = sv.hi > 0 && isFinite(sv.hi) ? 1 / sv.hi : 0; S.hi = sv.lo > 0 ? 1 / sv.lo : Infinity; }
        buildSeries();
      }
      const cl = isCL(x);
      const lo = cl && !S.full ? S.lo : 0, hi = cl && !S.full ? S.hi : Infinity;
      S.earn = 'fees';
      const of = params();
      const out = { x, cl, nf: nowEst(lo, hi, of), bf: backtest(lo, hi, of, false), live: !!chainSt };
      out.thin = cl && out.nf && out.nf.share > 0.05;
      if (x.venue === 'aero') { S.earn = 'aero'; const oa = params(); out.na = nowEst(lo, hi, oa); out.ba = backtest(lo, hi, oa, false); }
      return out;
    } catch (e) { return { x, err: true }; }
    finally { pool = sv.pool; chainSt = sv.chainSt; ser = sv.ser; avg7 = sv.avg7; S.lo = sv.lo; S.hi = sv.hi; S.earn = sv.earn; S.volMode = sv.volMode; }
  }
  function renderCompare() {
    const tb = $('#simCmp tbody');
    if (!pool || !ser || !tb) return;
    const ps = pairPools(pool);
    $('#simCmpTitle').textContent = `Compare venues · ${pool.a}/${pool.b}`;
    if (ps.length < 2) { tb.innerHTML = `<tr><td colspan="8" class="muted">${pool.a}/${pool.b} only has this one pool across Aero and Uniswap on Base, OP Mainnet and Robinhood Chain.</td></tr>`; return; }
    const rows = ps.map(evalPool);
    const score = (r) => Math.max(r.bf ? r.bf.net : -Infinity, r.ba ? r.ba.net : -Infinity);
    const best = rows.filter((r) => !r.err && !r.thin).reduce((b, r) => (score(r) > (b ? score(b) : -Infinity) ? r : b), null);
    const ap = (n, key) => (!n ? '—' : n.inR ? pct(n[key], 1) : '<span class="bad">0% · out</span>');
    tb.innerHTML = rows.map((r) => {
      const x = r.x, cur = x === pool;
      const sym = isUni(x) && x.sa && x.sa !== x.a ? ` <span class="muted">${x.sa}/${x.sb}</span>` : '';
      return `<tr class="${cur ? 'cur' : ''}">
        <td class="c-venue">${venueTag(x)} ${chainTag(x)}</td>
        <td class="c-pool">${kindFmt(x)} · ${feeFmt(x.fee)}${sym}${r.cl ? '' : ' <span class="muted">full range</span>'}</td>
        <td class="num" data-l="TVL">${usdK(x.liq)}</td>
        <td class="num" data-l="24h vol">${usdK(x.vol)}</td>
        <td class="num" data-l="Fee APR">${r.err ? '—' : ap(r.nf, 'feeApr')}${r.thin ? '<br><span class="warn small" title="Your deposit would be most of the in-range liquidity, so this estimate is unrealistic">thin liquidity</span>' : ''}</td>
        <td class="num" data-l="AERO APR">${x.venue === 'aero' && !r.err ? ap(r.na, 'aeroAprNow') : '<span class="muted">n/a</span>'}</td>
        <td class="num" data-l="Net vs hold">${r.bf ? `<span class="${cls(r.bf.net)}">${usd(r.bf.net, 0)}</span>${r.ba ? ` <span class="muted small">fees</span><br><span class="${cls(r.ba.net)}">${usd(r.ba.net, 0)}</span> <span class="muted small">AERO</span>` : ''}` : '—'}${r === best ? ' <span class="venue aero">Best</span>' : ''}</td>
        <td class="c-act">${cur ? '<span class="muted small">Viewing</span>' : `<button class="btn small" data-cmp="${x.addr}">Simulate</button>`}</td></tr>`;
    }).join('');
    $('#simCmpSub').textContent = `your ${S.full ? 'full' : 'price'} range, ${usd(S.dep)} deposit and ${S.period} backtest applied to each pool${rows.some((r) => !r.live && r.x !== pool) ? ' · loading live pool data…' : ''}`;
  }
  function renderOptimizer(o) {
    const tb = $('#simOpt tbody');
    if (!isCL(pool)) { tb.innerHTML = `<tr><td colspan="7" class="muted">${isUni(pool) ? 'Uniswap v2 pools are always full range, so there\'s no range to optimize. Pick a v3 or v4 pool to compare ranges.' : 'Basic pools are always full range, so there\'s no range to optimize. Pick a Slipstream pool to compare ranges.'}</td></tr>`; return; }
    const Pn = livePrice() || ser.P[ser.P.length - 1];
    const rows = WIDTHS.map((w) => {
      const lo = w === 'full' ? 0 : Pn * (1 - w), hi = w === 'full' ? Infinity : Pn * (1 + w);
      const r = backtest(lo, hi, o, false), n = nowEst(lo, hi, o);
      return { w, r, n };
    }).filter((x) => x.r);
    const best = rows.reduce((b, x) => (x.r.net > (b?.r.net ?? -Infinity) ? x : b), null);
    tb.innerHTML = rows.map((x) => `<tr data-w="${x.w}" class="${x === best ? 'best' : ''}">
      <td>${x.w === 'full' ? 'Full range' : '±' + +(x.w * 100).toFixed(1) + '%'}${x === best ? ' <span class="venue aero">Best</span>' : ''}</td>
      <td class="num">${pct(x.r.timeIn, 0)}</td>
      <td class="num">${x.r.exits}</td>
      <td class="num good">${usd(x.r.earned, 2)}</td>
      <td class="num ${x.r.il < -0.5 ? 'bad' : ''}">${usd(x.r.il, 2)}</td>
      <td class="num ${cls(x.r.net)}">${usd(x.r.net, 2)}</td>
      <td class="num">${x.n && x.n.inR ? pct(x.n.apr, 0) : '0%'}</td></tr>`).join('');
  }
  function writeHash() {
    const tag = mode === 'uni' ? '#uni' : '#sim';
    if (!pool || location.hash.indexOf(tag) !== 0) return;
    const q = new URLSearchParams({ pool: pool.addr, d: S.dep, p: S.period });
    if (!S.full) { q.set('lo', +S.lo.toPrecision(8)); q.set('hi', +S.hi.toPrecision(8)); } else q.set('full', 1);
    if (S.inv) q.set('inv', 1);
    if (S.mode !== 'fixed') q.set('m', S.mode);
    if (S.earn !== 'fees') q.set('e', S.earn);
    if (S.reb !== 'off') { q.set('rb', S.reb); if (S.reb === 'delay') q.set('rh', S.rebDelay); }
    if (S.volMode !== 'hist' && S.volMode !== 'custom') q.set('v', S.volMode);
    history.replaceState(null, '', tag + '?' + q.toString());
  }

  async function refreshChain() {
    if (!pool) return;
    const p = pool;
    const [stt, ap] = await Promise.all([Live.poolState(p).catch(() => null), Live.aeroUsd().catch(() => null)]);
    if (ap) aeroPx = ap;
    if (stt && p === pool) { const first = !chainSt?.sugar && stt.sugar; chainSt = { ...stt, addr: p.addr }; renderLive(); pushLivePoint(); if (first) compute(); else renderNow(); }
  }
  let histSeq = 0;
  async function refreshHistory() {
    if (!pool) return;
    const p = pool, my = ++histSeq;
    S.histLoading = true; renderHistNote();
    const done = () => { if (p !== pool || my !== histSeq) return; buildSeries(); setChartData(); compute(); };
    const ch = Live.onchainHist().then((h) => { if (h && !chainHist) { chainHist = h; chainDayIdx = Object.fromEntries(h.days.map((d, i) => [d, i])); } });
    // first pass: this pool's own history; second: the pair's other pools + compare-table volumes
    let first = true;
    try { await Promise.all([ch, loadHistory(p, 0, () => { if (first) { first = false; S.histLoading = false; } done(); })]); } catch (e) { /* fall back to feeds */ }
    S.histLoading = false;
    done();
  }
  function renderHistNote() {
    const el = $('#simHistNote');
    if (!el) return;
    if (!ser || !ser.info) { el.textContent = ''; return; }
    const i = ser.info, unit = ser.step === 3600 ? 'h' : 'd';
    const tot = i.pool + i.pair + i.feed;
    const parts = [];
    if (i.pool) parts.push(`this pool's trades ${i.pool}${unit}`);
    if (i.pair) parts.push(`same pair on ${i.pairName ? venueName(i.pairName) + (chainOf(i.pairName) !== chainOf(pool) ? ' ' + CHAINS[chainOf(i.pairName)] : '') : 'other pools'} ${i.pair}${unit}`);
    if (i.feed) parts.push(`USD price feeds ${i.feed}${unit}`);
    let v = '';
    if (S.volMode === 'hist') {
      const vp = [];
      if (i.vPool) vp.push(`this pool's real volume ${i.vPool}${unit}`);
      if (i.vAvg) vp.push(`its average day before it existed ${i.vAvg}${unit}`);
      if (i.vLive) vp.push(`live 24h ${i.vLive}${unit}`);
      v = ' · Volume: ' + vp.join(', ');
      const hc = chainHist && chainHist.p[pool.addr.toLowerCase()];
      if (hc) v += ` · Liquidity & AERO: on-chain daily since ${new Date(chainHist.days[hc.findIndex((x) => x)] * 86400e3).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
      else if (pool.venue === 'aero' && chainOf(pool) === 'base') v += ' · Liquidity & AERO: today\'s values';
      else v += ' · Liquidity: today\'s value';
    }
    el.textContent = (S.histLoading ? 'Loading this pool\'s trade history… ' : '') + (tot ? 'Price: ' + parts.join(', ') : '') + v;
  }
  async function selectPool(addr, keep) {
    const p = D.pools.find((x) => x.addr.toLowerCase() === String(addr).toLowerCase());
    if (!p) return;
    pool = p; chainSt = null; avg7 = null; S.addr = p.addr; modeState[mode].addr = p.addr;
    poolOptions();
    buildSeries();
    if (!keep) { if (isCL(p)) applyWidth(0.1); else applyWidth('full'); }
    if (!isCL(p)) applyWidth('full');
    renderSegs(); renderLive(); setChartData(); compute();
    if (!p.liveTs) await Live.refreshPools();
    await refreshChain();
    if (p !== pool) return;
    buildSeries(); setChartData();
    if (!keep && isCL(p)) applyWidth(0.1);
    compute();
    loadCompare();
    refreshHistory();
    Live.avgVolume7d(p.addr, chainOf(p)).then((v) => { if (p === pool) { avg7 = v; renderSegs(); if (S.volMode === 'avg7') compute(); } });
  }

  // ---------- wiring ----------
  let inited = false;
  function init() {
    if (inited) return;
    inited = true;
    D = window.PL.D; A = window.PL.A;
    initChart();
    $('#simSearch').oninput = poolOptions;
    $('#simLegacy').onchange = poolOptions;
    $('#simPool').onchange = (e) => selectPool(e.target.value);
    $('#posForm').onsubmit = (e) => { e.preventDefault(); const v = $('#posId').value.trim().replace(/^#/, ''); if (/^\d+$/.test(v)) runPosCheck(+v); else { pos.pool = pool; pos.err = 'Enter the numeric NFT token ID.'; renderPos(); } };
    $('#simDep').oninput = (e) => { const v = +e.target.value; if (v > 0) { S.dep = v; compute(); } };
    const parseNum = (v) => +String(v).replace(/[, ]/g, '');
    const onRange = () => { const dl = parseNum($('#simMin').value), dh = parseNum($('#simMax').value); if (dl > 0 && dh > dl) { setDispRange(dl, dh); compute(); } };
    $('#simMin').onchange = onRange; $('#simMax').onchange = onRange;
    const onPct = () => {
      const dn = parseNum($('#simDnPct').value), up = parseNum($('#simUpPct').value);
      const P = livePrice() || ser?.P[ser.P.length - 1];
      if (!P || isNaN(dn) || isNaN(up) || dn >= 100 || -dn >= up) return;
      const dP = disp(P);
      setDispRange(dP * (1 - dn / 100), dP * (1 + up / 100));
      compute();
    };
    $('#simDnPct').oninput = onPct; $('#simUpPct').oninput = onPct;
    $('#simPresets').onclick = (e) => { const b = e.target.closest('button[data-w]'); if (!b || b.disabled) return; applyWidth(b.dataset.w === 'full' ? 'full' : +b.dataset.w); compute(); };
    $('#simFlip').onclick = () => { S.inv = !S.inv; setChartData(); compute(); renderLive(); };
    $('#simAero').oninput = (e) => { S.aeroApr = +e.target.value || 0; compute(); };
    $('#simCustomVol').oninput = (e) => { S.customVol = +e.target.value || 0; compute(); };
    $('#simRebDelay').oninput = (e) => { const v = +e.target.value; if (v > 0) { S.rebDelay = v; compute(); } };
    $('#simSlip').oninput = (e) => { const v = +e.target.value; if (v >= 0) { S.slip = v; compute(); } };
    $('#simGas').oninput = (e) => { const v = +e.target.value; if (v >= 0) { S.gas = v; compute(); } };
    $('#simFeeShare').oninput = (e) => { const v = +e.target.value; if (v >= 0 && v <= 100) { S.feeShare = v; compute(); } };
    $('#simCmp tbody').onclick = (e) => { const b = e.target.closest('button[data-cmp]'); if (b) window.SimOpen(b.dataset.cmp); };
    $('#simOpt tbody').onclick = (e) => { const tr = e.target.closest('tr[data-w]'); if (!tr) return; applyWidth(tr.dataset.w === 'full' ? 'full' : +tr.dataset.w); compute(); };
    Live.onUpdate((w) => { if (!pool || $('#view-sim').hidden) return; if (w === 'pools') { renderLive(); pushLivePoint(); renderNow(); poolOptions(); } else renderLive(); });
    setInterval(() => { if (pool && !$('#view-sim').hidden && !document.hidden) refreshChain(); }, 15e3);
    setInterval(() => { if (pool && !$('#view-sim').hidden && !document.hidden) loadCompare(); }, 60e3);
    // initial pool: from hash, else the biggest Aero Slipstream pool
    const q = new URLSearchParams((location.hash.split('?')[1] || ''));
    if (q.get('d')) S.dep = +q.get('d') || 1000;
    if (q.get('p') && PERIODS[q.get('p')]) S.period = q.get('p');
    if (q.get('inv')) S.inv = true;
    if (q.get('m') === 'relative') S.mode = 'relative';
    if (q.get('e') === 'aero') S.earn = 'aero';
    if (['exit', 'delay'].includes(q.get('rb'))) S.reb = q.get('rb');
    if (+q.get('rh') > 0) { S.rebDelay = +q.get('rh'); $('#simRebDelay').value = S.rebDelay; }
    if (['live', 'avg7'].includes(q.get('v'))) S.volMode = q.get('v');
    $('#simDep').value = S.dep;
    $('#simFeeShare').value = S.feeShare;
    applyModeUI();
    const hp = q.get('pool') && D.pools.find((p) => p.addr.toLowerCase() === q.get('pool').toLowerCase());
    if (q.get('pool') && (!hp || !inMode(hp))) q.delete('pool'); // unknown or other-simulator pool: start on the default one
    const start = q.get('pool') || defaultPool();
    const lo = +q.get('lo'), hi = +q.get('hi');
    if (q.get('pool') && (q.get('full') || (lo > 0 && hi > lo))) {
      if (q.get('full')) { S.full = true; S.lo = 0; S.hi = Infinity; } else { S.full = false; S.lo = lo; S.hi = hi; }
      selectPool(start, true);
    } else selectPool(start);
  }

  // ---------- views ----------
  function applyModeUI() {
    const uni = mode === 'uni';
    $('#simLegacyWrap').hidden = uni;
    $('#simEarnCtl').hidden = uni;
    $('#simFeeNote').textContent = uni ? "Uniswap's protocol fee (where it's switched on) is already taken off automatically. Lower this only to stress-test." : "Aero's unstaked fee is already taken off automatically. Lower this only to stress-test.";
    $('#simSearch').placeholder = uni ? 'Search pools, e.g. NVDA, ETH/USDC' : 'Search pools, e.g. NVDAc, ETH/USDC';
  }
  function setMode(m) {
    if (m === mode) return false;
    modeState[mode] = { addr: pool ? pool.addr : modeState[mode].addr, earn: S.earn, chain: S.chain };
    mode = m;
    S.earn = m === 'uni' ? 'fees' : modeState[m].earn;
    S.chain = modeState[m].chain;
    applyModeUI();
    return true;
  }
  function showView(v) {
    $('#view-lab').hidden = v !== 'lab';
    $('#view-sim').hidden = v === 'lab';
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
    if (v === 'lab') { if (location.hash) history.replaceState(null, '', location.pathname + location.search); return; }
    const m = v === 'uni' ? 'uni' : 'aero', tag = '#' + v;
    const changed = setMode(m);
    if (location.hash.indexOf(tag) !== 0) history.replaceState(null, '', tag);
    if (!inited) { init(); return; }
    if (changed) {
      const a = modeState[m].addr || defaultPool();
      renderSegs(); poolOptions();
      if (a) selectPool(a, false);
    }
    writeHash();
  }
  window.SimOpen = (addr) => {
    const p = D ? D.pools.find((x) => x.addr.toLowerCase() === String(addr).toLowerCase()) : (window.PL && window.PL.D.pools.find((x) => x.addr.toLowerCase() === String(addr).toLowerCase()));
    const v = p && p.venue === 'uniswap' ? 'uni' : 'sim';
    if (p) { const ms = modeState[v === 'uni' ? 'uni' : 'aero']; ms.addr = p.addr; if (ms.chain !== 'all' && chainOf(p) !== ms.chain) ms.chain = 'all'; if (S.chain !== 'all' && chainOf(p) !== S.chain && (v === 'uni') === (mode === 'uni')) S.chain = 'all'; if (p.venue === 'legacy') { const c = document.querySelector('#simLegacy'); if (c) c.checked = true; } }
    if (!inited) { history.replaceState(null, '', '#' + v + '?pool=' + addr); showView(v); }
    else { showView(v); selectPool(addr); }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  function boot() {
    document.querySelector('.tabs').onclick = (e) => { const b = e.target.closest('button[data-view]'); if (b) showView(b.dataset.view); };
    showView(location.hash.indexOf('#sim') === 0 ? 'sim' : location.hash.indexOf('#uni') === 0 ? 'uni' : 'lab');
  }
  if (window.PL) boot(); else document.addEventListener('pl-ready', boot, { once: true });
})();
