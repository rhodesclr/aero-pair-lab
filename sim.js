// LP Simulator: live pool state + up to 1 year of price history + draggable range + backtest + range optimizer.
(function () {
  const $ = (s) => document.querySelector(s);
  const LC = window.LightweightCharts;
  let D, A;
  let pool = null, chainSt = null, ser = null, avg7 = null;
  const S = { addr: null, dep: 1000, lo: null, hi: null, full: false, period: '90D', mode: 'fixed', earn: 'fees', aeroApr: 0, volMode: 'live', customVol: null, feeShare: 100, inv: false };
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
  const kindFmt = (k) => (!k ? 'Pool' : k.startsWith('CL') ? 'Slipstream ' + k : k === 'stable' ? 'Basic stable' : 'Basic volatile');
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
  function buildSeries() {
    const [res, n] = PERIODS[S.period];
    const src = D[res], len = src.end - src.start + 1, i0 = Math.max(0, len - n - 1);
    const sa = usdArr(pool.a, res), sb = usdArr(pool.b, res);
    const t = [], P = [], ua = [], ub = [];
    for (let i = i0; i < len; i++) {
      const x = sa ? sa[i] : 1, y = sb ? sb[i] : 1;
      if (x == null || y == null) continue;
      t.push((src.start + i) * src.step); P.push(x / y); ua.push(x); ub.push(y);
    }
    const lu = liveUsd();
    const now = Math.floor(Date.now() / 1000);
    if (lu && t.length && now > t[t.length - 1] + 60) { t.push(now); P.push(lu[0] / lu[1]); ua.push(lu[0]); ub.push(lu[1]); }
    ser = { t, P, ua, ub, step: src.step };
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
    const vol = S.volMode === 'custom' ? (S.customVol || 0) : S.volMode === 'avg7' && avg7 ? avg7.avg : pool.vol || 0;
    const decA = chainSt?.decA ?? 18, decB = chainSt?.decB ?? 18;
    return { dep: S.dep, fee: fee || 0, vol, feeShare: S.feeShare / 100, earn: S.earn, aeroApr: S.aeroApr / 100, cl: isCL(pool), Lpool: chainSt?.L ?? null, decA, decB, tvl: pool.liq || 0 };
  }
  function shareFor(L, o) {
    if (o.cl && o.Lpool > 0) { const Lr = L * Math.pow(10, (o.decA + o.decB) / 2); return Lr / (o.Lpool + Lr); }
    return o.dep / (o.tvl + o.dep);
  }
  function btRange(lo, hi) { // range used for the backtest
    if (S.mode === 'relative' && lo > 0 && isFinite(hi)) { const k = ser.P[0] / livePriceOrLast(); return [lo * k, hi * k]; }
    return [lo, hi];
  }
  function livePriceOrLast() { return livePrice() || ser.P[ser.P.length - 1]; }

  function backtest(lo0, hi0, o, keepPath) {
    const n = ser.t.length;
    if (n < 3) return null;
    const [lo, hi] = btRange(lo0, hi0);
    const P0 = ser.P[0];
    const [x1, y1] = amounts(1, P0, lo, hi);
    const L = o.dep / (x1 * ser.ua[0] + y1 * ser.ub[0]);
    const x0 = x1 * L, y0 = y1 * L;
    const share = shareFor(L, o);
    let fees = 0, rew = 0, exits = 0, tIn = 0, tTot = 0, outRun = 0, longestOut = 0;
    let prevIn = inRange(P0, lo, hi), prevV = o.dep;
    const path = keepPath ? { t: [], v: [], h: [], f: [] } : null;
    let V = o.dep, H = o.dep;
    for (let i = 0; i < n; i++) {
      const P = ser.P[i];
      const [x, y] = amounts(L, P, lo, hi);
      V = x * ser.ua[i] + y * ser.ub[i];
      H = x0 * ser.ua[i] + y0 * ser.ub[i];
      const inR = inRange(P, lo, hi);
      if (i > 0) {
        const dt = (ser.t[i] - ser.t[i - 1]) / 86400;
        tTot += dt;
        if (prevIn) {
          tIn += dt;
          if (o.earn === 'fees') fees += o.vol * o.fee * o.feeShare * share * dt;
          else rew += (prevV * o.aeroApr * dt) / 365;
          outRun = 0;
        } else { outRun += dt; longestOut = Math.max(longestOut, outRun); }
        if (prevIn && !inR) exits++;
      }
      prevIn = inR; prevV = V;
      if (path) { path.t.push(ser.t[i]); path.v.push(V); path.h.push(H); path.f.push(fees + rew); }
    }
    const earned = fees + rew;
    return {
      lo, hi, share, L, x0, y0, timeIn: tTot ? tIn / tTot : 0, exits, longestOut, fees, rew, earned,
      Vend: V, Hend: H, il: V - H, ilPct: H ? (V - H) / H : 0, net: V + earned - H, netPct: H ? (V + earned - H) / H : 0,
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
    const daily = !inR ? 0 : o.earn === 'fees' ? o.vol * o.fee * o.feeShare * share : (o.dep * o.aeroApr) / 365;
    const Lfull = o.dep / (2 * Math.sqrt(Pn) * lu[1]);
    return { x, y, ua: x * lu[0], ub: y * lu[1], inR, share, daily, apr: (daily * 365) / o.dep, eff: L / Lfull };
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
  function poolOptions() {
    const q = ($('#simSearch').value || '').trim().toLowerCase();
    const legacy = $('#simLegacy').checked;
    const list = D.pools.filter((p) => (legacy || p.venue !== 'legacy') && (!q || (p.a + '/' + p.b).toLowerCase().includes(q) || (p.b + '/' + p.a).toLowerCase().includes(q)))
      .slice().sort((x, y) => (y.liq || 0) - (x.liq || 0));
    const opt = (p) => `<option value="${p.addr}" ${pool && p.addr === pool.addr ? 'selected' : ''}>${p.a}/${p.b} · ${kindFmt(p.kind)} · ${feeFmt(p.fee)} · TVL ${usdK(p.liq)}${p.venue === 'legacy' ? ' · old Aerodrome' : ''}</option>`;
    const aero = list.filter((p) => p.venue !== 'legacy'), old = list.filter((p) => p.venue === 'legacy');
    let h = '';
    if (aero.length) h += `<optgroup label="Aero pools">${aero.map(opt).join('')}</optgroup>`;
    if (old.length) h += `<optgroup label="Old Aerodrome pools">${old.map(opt).join('')}</optgroup>`;
    if (pool && !list.includes(pool)) h = opt(pool) + h;
    $('#simPool').innerHTML = h || '<option>No pools match</option>';
  }
  function seg(el, items, cur, onPick) {
    el.innerHTML = items.map(([id, label]) => `<button data-id="${id}" class="${id === cur ? 'on' : ''}">${label}</button>`).join('');
    el.onclick = (e) => { const b = e.target.closest('button'); if (b) onPick(b.dataset.id); };
  }
  function renderSegs() {
    seg($('#simPeriods'), Object.keys(PERIODS).map((k) => [k, k]), S.period, (id) => { S.period = id; renderSegs(); buildSeries(); setChartData(); compute(); });
    seg($('#simMode'), [['fixed', 'My exact prices'], ['relative', 'Same % width from start']], S.mode, (id) => { S.mode = id; renderSegs(); compute(); });
    seg($('#simEarn'), [['fees', 'Trading fees'], ['aero', 'AERO rewards']], S.earn, (id) => { S.earn = id; renderSegs(); compute(); });
    const v7 = avg7 ? `7-day avg ${usdK(avg7.avg)}` : '7-day avg';
    seg($('#simVolMode'), [['live', `Live 24h ${pool ? usdK(pool.vol) : ''}`], ['avg7', v7], ['custom', 'Custom']], S.volMode, (id) => {
      S.volMode = id;
      if (id === 'custom' && S.customVol == null) S.customVol = pool?.vol || 0;
      renderSegs(); compute();
    });
    $('#simAeroWrap').hidden = S.earn !== 'aero';
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
    $('#simMinPct').textContent = S.full || !dP ? '' : spct(dl / dP - 1) + ' from current';
    $('#simMaxPct').textContent = S.full || !dP ? '' : spct(dh / dP - 1) + ' from current';
    $('#simUnit').textContent = pool ? pairLabel() : '';
    $('#simBasicNote').hidden = isCL(pool);
    updatePriceLines();
  }
  function renderLive() {
    if (!pool) return;
    const P = livePrice();
    const age = Math.round((Date.now() - Math.max(pool.liveTs || 0, chainSt?.ts || 0)) / 1000);
    const fresh = (pool.liveTs || chainSt?.ts) && age < 150;
    const fee = chainSt?.fee ?? pool.fee;
    const k = (l, v, s = '', c = '') => `<div class="kpi"><div class="k">${l}</div><div class="v ${c}">${v}</div><div class="s">${s}</div></div>`;
    $('#simLive').innerHTML =
      k(priceLabel(), fmtP(disp(P)), pairLabel()) +
      k('24h change', pool.chg24 == null ? '—' : spct(pool.chg24 / 100), `${pool.a} in USD`, cls(pool.chg24)) +
      k('Pool TVL', usdK(pool.liq), `${pool.venue === 'legacy' ? 'Old Aerodrome' : 'Aero'} · ${kindFmt(pool.kind)}`) +
      k('24h volume', usdK(pool.vol), pool.vol1 != null ? `last 1h ${usdK(pool.vol1)}` : '') +
      k('Fee now', feeFmt(fee), isCL(pool) ? 'dynamic, read on-chain' : 'pool fee') +
      k('Pool fee APR', pool.liq ? pct((pool.vol * (fee || 0) * 365) / pool.liq, 1) : '—', 'full pool average');
    $('#simLiveTxt').textContent = fresh ? `Live · ${age}s ago` : 'Connecting…';
    $('#simLiveDot').className = 'live-dot ' + (fresh ? 'on' : 'off');
    $('#simTitle').textContent = `${pool.a}/${pool.b}`;
    $('#simLinks').innerHTML = `<a href="${pool.url}" target="_blank" rel="noopener">DEX Screener ↗</a> · <a href="https://basescan.org/address/${pool.addr}" target="_blank" rel="noopener">BaseScan ↗</a>`;
  }
  let lightPending = false;
  function lightCompute() { if (lightPending) return; lightPending = true; requestAnimationFrame(() => { lightPending = false; renderNow(); }); }
  function renderNow() {
    if (!pool || !ser) return;
    const o = params();
    const n = nowEst(S.lo, S.hi, o);
    const lu = liveUsd();
    const k = (l, v, s = '', c = '') => `<div class="kpi"><div class="k">${l}</div><div class="v ${c}">${v}</div><div class="s">${s}</div></div>`;
    if (!n) { $('#simNow').innerHTML = '<div class="nopool">Waiting for the live pool price…</div>'; return; }
    const what = S.earn === 'fees' ? 'fee' : 'AERO reward';
    const warn = isCL(pool) && !(o.Lpool > 0) ? ' · on-chain liquidity unavailable, rough estimate' : '';
    $('#simNow').innerHTML =
      k(`Est. ${what} APR`, n.inR ? pct(n.apr, 1) : '0%', n.inR ? 'at current price & volume' + warn : 'price is outside your range', n.inR ? (n.apr > 0.2 ? 'good' : '') : 'bad') +
      k('Est. earnings', n.inR ? usd(n.daily, 2) + '/day' : '$0/day', n.inR ? usd(n.daily * 30, 0) + '/month' : 'until price re-enters') +
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
      k('Start split', `${amt(r.x0)} ${pool.a} + ${amt(r.y0)} ${pool.b}`, S.mode === 'relative' ? `range ${fmtP(disp(S.inv ? r.hi : r.lo))}–${fmtP(disp(S.inv ? r.lo : r.hi))} at start` : 'at the start price');
    renderValueChart(r);
    renderOptimizer(o);
    writeHash();
  }
  function renderOptimizer(o) {
    const tb = $('#simOpt tbody');
    if (!isCL(pool)) { tb.innerHTML = `<tr><td colspan="7" class="muted">Basic pools are always full range, so there's no range to optimize. Pick a Slipstream pool to compare ranges.</td></tr>`; return; }
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
    if (!pool || location.hash.indexOf('#sim') !== 0) return;
    const q = new URLSearchParams({ pool: pool.addr, d: S.dep, p: S.period });
    if (!S.full) { q.set('lo', +S.lo.toPrecision(8)); q.set('hi', +S.hi.toPrecision(8)); } else q.set('full', 1);
    if (S.inv) q.set('inv', 1);
    if (S.mode !== 'fixed') q.set('m', S.mode);
    history.replaceState(null, '', '#sim?' + q.toString());
  }

  async function refreshChain() {
    if (!pool) return;
    const p = pool;
    const stt = await Live.poolState(p).catch(() => null);
    if (stt && p === pool) { chainSt = { ...stt, addr: p.addr }; renderLive(); pushLivePoint(); renderNow(); }
  }
  async function selectPool(addr, keep) {
    const p = D.pools.find((x) => x.addr.toLowerCase() === String(addr).toLowerCase());
    if (!p) return;
    pool = p; chainSt = null; avg7 = null; S.addr = p.addr;
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
    Live.avgVolume7d(p.addr).then((v) => { if (p === pool) { avg7 = v; renderSegs(); if (S.volMode === 'avg7') compute(); } });
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
    $('#simDep').oninput = (e) => { const v = +e.target.value; if (v > 0) { S.dep = v; compute(); } };
    const parseNum = (v) => +String(v).replace(/[, ]/g, '');
    const onRange = () => { const dl = parseNum($('#simMin').value), dh = parseNum($('#simMax').value); if (dl > 0 && dh > dl) { setDispRange(dl, dh); compute(); } };
    $('#simMin').onchange = onRange; $('#simMax').onchange = onRange;
    $('#simPresets').onclick = (e) => { const b = e.target.closest('button[data-w]'); if (!b || b.disabled) return; applyWidth(b.dataset.w === 'full' ? 'full' : +b.dataset.w); compute(); };
    $('#simFlip').onclick = () => { S.inv = !S.inv; setChartData(); compute(); renderLive(); };
    $('#simAero').oninput = (e) => { S.aeroApr = +e.target.value || 0; compute(); };
    $('#simCustomVol').oninput = (e) => { S.customVol = +e.target.value || 0; compute(); };
    $('#simFeeShare').oninput = (e) => { const v = +e.target.value; if (v >= 0 && v <= 100) { S.feeShare = v; compute(); } };
    $('#simOpt tbody').onclick = (e) => { const tr = e.target.closest('tr[data-w]'); if (!tr) return; applyWidth(tr.dataset.w === 'full' ? 'full' : +tr.dataset.w); compute(); };
    Live.onUpdate((w) => { if (!pool || $('#view-sim').hidden) return; if (w === 'pools') { renderLive(); pushLivePoint(); renderNow(); poolOptions(); } else renderLive(); });
    setInterval(() => { if (pool && !$('#view-sim').hidden && !document.hidden) refreshChain(); }, 15e3);
    // initial pool: from hash, else the biggest Aero Slipstream pool
    const q = new URLSearchParams((location.hash.split('?')[1] || ''));
    if (q.get('d')) S.dep = +q.get('d') || 1000;
    if (q.get('p') && PERIODS[q.get('p')]) S.period = q.get('p');
    if (q.get('inv')) S.inv = true;
    if (q.get('m') === 'relative') S.mode = 'relative';
    $('#simDep').value = S.dep;
    $('#simFeeShare').value = S.feeShare;
    const start = q.get('pool') || D.pools.filter((p) => p.venue !== 'legacy' && isCL(p)).sort((x, y) => y.liq - x.liq)[0]?.addr;
    const lo = +q.get('lo'), hi = +q.get('hi');
    if (q.get('pool') && (q.get('full') || (lo > 0 && hi > lo))) {
      if (q.get('full')) { S.full = true; S.lo = 0; S.hi = Infinity; } else { S.full = false; S.lo = lo; S.hi = hi; }
      selectPool(start, true);
    } else selectPool(start);
  }

  // ---------- views ----------
  function showView(v) {
    $('#view-lab').hidden = v !== 'lab';
    $('#view-sim').hidden = v !== 'sim';
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
    if (v === 'sim') { init(); if (location.hash.indexOf('#sim') !== 0) history.replaceState(null, '', '#sim'); writeHash(); }
    else if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  }
  window.SimOpen = (addr) => {
    showView('sim');
    if (inited) selectPool(addr); else { history.replaceState(null, '', '#sim?pool=' + addr); }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  function boot() {
    document.querySelector('.tabs').onclick = (e) => { const b = e.target.closest('button[data-view]'); if (b) showView(b.dataset.view); };
    showView(location.hash.indexOf('#sim') === 0 ? 'sim' : 'lab');
  }
  if (window.PL) boot(); else document.addEventListener('pl-ready', boot, { once: true });
})();
