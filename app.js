(async function () {
  const $ = (s) => document.querySelector(s);
  const D = await fetch('data.json?v=' + Math.floor(Date.now() / 3.6e6), { cache: 'no-cache' }).then((r) => r.json());
  for (const p of D.pools) if (!p.addr) p.addr = p.url.split('/').pop();
  const A = Object.fromEntries(D.assets.map((a) => [a.sym, a]));
  const SYMS = D.assets.map((a) => a.sym);
  const MAX_SEL = 16;

  // ---------- pools ----------
  const poolMap = {};
  for (const p of D.pools) {
    const k = [p.a, p.b].sort().join('|');
    (poolMap[k] = poolMap[k] || []).push(p);
  }
  for (const k in poolMap) poolMap[k].sort((x, y) => y.liq - x.liq);
  const poolsFor = (a, b) => (poolMap[[a, b].sort().join('|')] || []).filter((p) => st.legacy || p.venue !== 'legacy');

  // ---------- state ----------
  const PERIODS = [
    { id: '7D', res: 'hourly', n: 168 },
    { id: '30D', res: 'hourly', n: 720 },
    { id: '90D', res: 'hourly', n: 2160 },
    { id: '180D', res: 'daily', n: 180 },
    { id: '1Y', res: 'daily', n: 365 },
  ];
  const METRICS = [
    { id: 'corr', label: 'Correlation' },
    { id: 'ratioVol', label: 'Ratio vol' },
    { id: 'il', label: 'IL' },
    { id: 'inRange', label: 'In range' },
  ];
  const PRESETS = {
    'Stocks × crypto': ['BTC', 'ETH', 'AERO', 'USDC', 'MSTRc', 'NVDAc', 'GOOGLc', 'AAPLc', 'METAc', 'AMZNc', 'TSLAc', 'SPCXc'],
    'Mag 7': ['AAPLc', 'MSFTc', 'GOOGLc', 'AMZNc', 'METAc', 'NVDAc', 'TSLAc', 'ETH', 'BTC'],
    'Top Aero stocks': ['NVDAc', 'GOOGLc', 'MSTRc', 'SNDKc', 'MUc', 'SPCXc', 'AAPLc', 'METAc', 'AMZNc', 'SKHYc', 'PLTRc', 'TSLAc'],
    'Base crypto': ['ETH', 'BTC', 'cbETH', 'AERO', 'VIRTUAL', 'SOL', 'XRP', 'TAO', 'MORPHO', 'WELL', 'VVV', 'DIEM', 'ZORA', 'EURC', 'USDC'],
    'Chips & AI': ['NVDAc', 'AVGOc', 'AMDc', 'MRVLc', 'CBRSc', 'MUc', 'SNDKc', 'SKHYc', 'ARMc', 'PLTRc', 'CRWVc', 'GOOGLc', 'TAO', 'VIRTUAL', 'VVV', 'DIEM'],
  };
  const st = {
    sel: PRESETS['Stocks × crypto'].filter((s) => A[s]),
    period: '30D',
    metric: 'corr',
    dn: 10,
    up: 10,
    pair: ['NVDAc', 'GOOGLc'],
    sortK: 'ratioVol',
    sortDesc: false,
    legacy: false,
  };

  // ---------- math ----------
  const cache = new Map();
  function getSeries(sym, res) {
    if (A[sym].type === 'stable' && sym === 'USDC') return null; // constant 1
    return D[res].prices[sym];
  }
  function pairStats(a, b, pid = st.period, dn = st.dn, up = st.up) {
    const key = a + '|' + b + '|' + pid + '|' + dn + '|' + up;
    if (cache.has(key)) return cache.get(key);
    const P = PERIODS.find((p) => p.id === pid);
    const src = D[P.res];
    const len = src.end - src.start + 1;
    const i0 = Math.max(0, len - P.n - 1);
    const sa = getSeries(a, P.res), sb = getSeries(b, P.res);
    const t = [], pa = [], pb = [];
    for (let i = i0; i < len; i++) {
      const x = sa ? sa[i] : 1, y = sb ? sb[i] : 1;
      if (x == null || y == null) continue;
      t.push(src.start + i); pa.push(x); pb.push(y);
    }
    let res = null;
    if (t.length >= 6) {
      const n = t.length;
      let sA = 0, sB = 0, sAA = 0, sBB = 0, sAB = 0, sR2 = 0;
      for (let i = 1; i < n; i++) {
        const ra = Math.log(pa[i] / pa[i - 1]), rb = Math.log(pb[i] / pb[i - 1]);
        sA += ra; sB += rb; sAA += ra * ra; sBB += rb * rb; sAB += ra * rb;
        const rr = ra - rb; sR2 += rr * rr;
      }
      const m = n - 1;
      const cov = sAB / m - (sA / m) * (sB / m);
      const vA = sAA / m - (sA / m) ** 2, vB = sBB / m - (sB / m) ** 2;
      const years = ((t[n - 1] - t[0]) * src.step) / (365 * 86400);
      const corr = vA > 1e-14 && vB > 1e-14 ? cov / Math.sqrt(vA * vB) : null;
      const beta = vB > 1e-14 ? cov / vB : null;
      const ratioVol = Math.sqrt(sR2 / years);
      const volA = Math.sqrt(sAA / years), volB = Math.sqrt(sBB / years);
      const r0 = pa[0] / pb[0];
      let inR = 0, maxIL = 0;
      const lo = 1 - dn / 100, hi = 1 + up / 100;
      const ratio = new Array(n);
      for (let i = 0; i < n; i++) {
        const k = pa[i] / pb[i] / r0;
        ratio[i] = k;
        if (k >= lo && k <= hi) inR++;
        const il = (2 * Math.sqrt(k)) / (1 + k) - 1;
        if (il < maxIL) maxIL = il;
      }
      const kEnd = ratio[n - 1];
      const il = (2 * Math.sqrt(kEnd)) / (1 + kEnd) - 1;
      res = { corr, beta, ratioVol, volA, volB, il, maxIL, inRange: inR / n, n, t, pa, pb, ratio, step: src.step, retA: pa[n - 1] / pa[0] - 1, retB: pb[n - 1] / pb[0] - 1 };
    }
    cache.set(key, res);
    return res;
  }

  // ---------- formatting ----------
  const pct = (x, d = 1) => { if (x == null || isNaN(x)) return '—'; let v = (x * 100).toFixed(d); if (/^-0\.?0*$/.test(v)) v = v.slice(1); return v + '%'; };
  const sgnPct = (x, d = 1) => (x == null ? '—' : (x > 0 ? '+' : '') + (x * 100).toFixed(d) + '%');
  const aprFmt = (x) => (x == null ? '—' : x >= 10 ? Math.round(x * 100).toLocaleString() + '%' : x >= 0.1 ? (x * 100).toFixed(0) + '%' : (x * 100).toFixed(1) + '%');
  const feeFmt = (f) => (f == null ? '' : +(f * 100).toFixed(4) + '% fee');
  const kindFmt = (k) => (!k ? '' : k.startsWith('CL') ? 'Slipstream ' + k : k === 'stable' ? 'Basic stable' : 'Basic volatile');
  const f2 = (x) => (x == null ? '—' : x.toFixed(2));
  const usd = (x) => (x == null ? '—' : x >= 1e6 ? '$' + (x / 1e6).toFixed(2) + 'M' : x >= 1e3 ? '$' + (x / 1e3).toFixed(1) + 'K' : '$' + Math.round(x));
  const badge = (s) => {
    const a = A[s];
    const txt = s.replace(/c$/, '').replace(/^cb/, '').slice(0, 4);
    return `<span class="badge ${a.type}" title="${a.name}">${txt.length > 3 ? txt.slice(0, 3) : txt}</span>`;
  };

  // ---------- colors ----------
  function lerp(c1, c2, t) { return c1.map((v, i) => Math.round(v + (c2[i] - v) * t)); }
  const BASE = [22, 30, 43], POS = [64, 120, 255], NEG = [240, 128, 70], GOOD = [36, 170, 120], BAD = [220, 70, 70], MID = [200, 160, 70];
  function rgb(c) { return `rgb(${c[0]},${c[1]},${c[2]})`; }
  function textOn(c) { const l = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]; return l > 150 ? '#0a0e15' : '#e7eaf0'; }
  function colorFor(metric, v) {
    if (v == null || isNaN(v)) return null;
    if (metric === 'corr') return v >= 0 ? lerp(BASE, POS, Math.min(1, v)) : lerp(BASE, NEG, Math.min(1, -v));
    let t;
    if (metric === 'ratioVol') t = Math.min(1, v / 1.2);
    else if (metric === 'il') t = Math.min(1, -v / 0.15);
    else if (metric === 'inRange') t = 1 - v;
    return t < 0.5 ? lerp(GOOD, MID, t * 2) : lerp(MID, BAD, (t - 0.5) * 2);
  }
  function cellText(metric, v) {
    if (v == null || isNaN(v)) return '—';
    if (metric === 'corr') return v.toFixed(2);
    if (metric === 'ratioVol') return Math.round(v * 100) + '%';
    if (metric === 'il') return (v * 100).toFixed(1);
    if (metric === 'inRange') return Math.round(v * 100) + '%';
  }
  function legend() {
    const m = st.metric;
    let g, l, r;
    if (m === 'corr') { g = `linear-gradient(90deg,${rgb(NEG)},${rgb(BASE)},${rgb(POS)})`; l = '−1'; r = '+1'; }
    else { g = `linear-gradient(90deg,${rgb(GOOD)},${rgb(MID)},${rgb(BAD)})`; [l, r] = m === 'ratioVol' ? ['0%', '120%+'] : m === 'il' ? ['0%', '−15%'] : ['100%', '0%']; }
    $('#legend').innerHTML = `<span>${l}</span><span class="bar" style="background:${g}"></span><span>${r}</span>`;
    const titles = { corr: 'Correlation matrix', ratioVol: 'Ratio volatility (annualized)', il: 'Impermanent loss, full range (%)', inRange: `Time in ${rangeTxt()} range` };
    $('#matrixTitle').textContent = titles[m] + ' · ' + st.period;
  }

  // ---------- controls ----------
  function seg(el, items, cur, onPick) {
    el.innerHTML = items.map((it) => `<button data-id="${it.id}" class="${it.id === cur ? 'on' : ''}">${it.label || it.id}</button>`).join('');
    el.onclick = (e) => { const b = e.target.closest('button'); if (b) onPick(b.dataset.id); };
  }
  function renderControls() {
    seg($('#periods'), PERIODS, st.period, (id) => { st.period = id; renderAll(); });
    seg($('#metrics'), METRICS, st.metric, (id) => { st.metric = id; renderAll(); });
    const pk = Object.keys(PRESETS).map((k) => ({ id: k }));
    seg($('#presets'), pk, null, (id) => { st.sel = PRESETS[id].filter((s) => A[s]); if (!st.sel.includes(st.pair[0]) || !st.sel.includes(st.pair[1])) st.pair = [st.sel[0], st.sel[1]]; renderAll(); });
    $('#chips').innerHTML = st.sel.map((s) => `<span class="chip">${badge(s)}${s}<button data-rm="${s}" aria-label="Remove ${s}">×</button></span>`).join('');
    $('#selCount').textContent = `(${st.sel.length}/${MAX_SEL})`;
  }
  $('#chips').addEventListener('click', (e) => {
    const s = e.target.dataset.rm; if (!s) return;
    if (st.sel.length <= 2) return;
    st.sel = st.sel.filter((x) => x !== s); renderAll();
  });
  // popover
  const pop = $('#pop');
  function renderPop() {
    const q = $('#search').value.trim().toLowerCase();
    const groups = { stock: 'Stock tokens (Coinbase)', crypto: 'Crypto on Base', stable: 'Stablecoins' };
    let html = '';
    for (const g of ['stock', 'crypto', 'stable']) {
      const items = D.assets.filter((a) => a.type === g && (!q || a.sym.toLowerCase().includes(q) || a.name.toLowerCase().includes(q)));
      if (!items.length) continue;
      html += `<div class="pop-group">${groups[g]}</div>`;
      for (const a of items) {
        const on = st.sel.includes(a.sym);
        const dis = !on && st.sel.length >= MAX_SEL;
        html += `<div class="opt ${dis ? 'dis' : ''}" data-s="${a.sym}" role="option" aria-selected="${on}">${badge(a.sym)}<b>${a.sym}</b><span class="nm">${a.name}</span><span class="tick">${on ? '✓' : ''}</span></div>`;
      }
    }
    $('#popList').innerHTML = html || '<div class="opt dis">No match</div>';
  }
  $('#addBtn').onclick = (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; if (!pop.hidden) { renderPop(); $('#search').focus(); } };
  $('#search').oninput = renderPop;
  $('#popList').onclick = (e) => {
    const o = e.target.closest('.opt'); if (!o || o.classList.contains('dis')) return;
    const s = o.dataset.s;
    if (st.sel.includes(s)) { if (st.sel.length > 2) st.sel = st.sel.filter((x) => x !== s); }
    else st.sel.push(s);
    renderAll(); renderPop();
  };
  document.addEventListener('click', (e) => { if (!pop.hidden && !$('#picker').contains(e.target)) pop.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') pop.hidden = true; });
  function rangeTxt() { return st.dn === st.up ? `±${st.dn}%` : `−${st.dn}% / +${st.up}%`; }
  function syncRangeCtl() {
    $('#rangeVal').textContent = rangeTxt();
    if (document.activeElement !== $('#rangeDn')) $('#rangeDn').value = st.dn;
    if (document.activeElement !== $('#rangeUp')) $('#rangeUp').value = st.up;
    $('#range').value = Math.min(50, Math.max(1, Math.round((st.dn + st.up) / 2)));
  }
  const applyRange = () => { cache.clear(); syncRangeCtl(); renderAll(true); };
  $('#range').oninput = (e) => { st.dn = st.up = +e.target.value; applyRange(); };
  for (const [id, k] of [['#rangeDn', 'dn'], ['#rangeUp', 'up']]) {
    $(id).oninput = (e) => {
      const v = +e.target.value;
      if (!(v > 0) || v > (k === 'dn' ? 99 : 1000)) return;
      st[k] = v; applyRange();
    };
  }
  syncRangeCtl();

  // ---------- matrix ----------
  function renderMatrix() {
    const s = st.sel, m = st.metric, n = s.length;
    const el = $('#matrix');
    el.style.gridTemplateColumns = `auto repeat(${n}, minmax(46px, 1fr))`;
    let h = '<div></div>' + s.map((x) => `<div class="mhead col">${x}</div>`).join('');
    for (const a of s) {
      h += `<div class="mhead row">${a}</div>`;
      for (const b of s) {
        if (a === b) { h += `<div class="mcell diag">${m === 'corr' ? '1.00' : '·'}</div>`; continue; }
        const r = pairStats(a, b);
        const v = r ? r[m] : null;
        const c = colorFor(m, v);
        const sel = (st.pair[0] === a && st.pair[1] === b) || (st.pair[0] === b && st.pair[1] === a);
        const hp = poolsFor(a, b).length > 0;
        const style = c ? `background:${rgb(c)};color:${textOn(c)}` : '';
        const tip = `${a}/${b}: corr ${r ? f2(r.corr) : '—'}, ratio vol ${r ? pct(r.ratioVol, 0) : '—'}${hp ? ' · Aero pool' : ''}`;
        h += `<div class="mcell ${c ? '' : 'na'} ${sel ? 'sel' : ''}" style="${style};position:relative" data-a="${a}" data-b="${b}" title="${tip}">${cellText(m, v)}${hp ? '<span style="position:absolute;top:3px;right:4px;width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.75"></span>' : ''}</div>`;
      }
    }
    el.innerHTML = h;
  }
  $('#matrix').addEventListener('click', (e) => {
    const c = e.target.closest('.mcell'); if (!c || !c.dataset.a) return;
    st.pair = [c.dataset.a, c.dataset.b]; renderMatrix(); renderDetail();
    if (window.innerWidth < 1100) $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // ---------- detail ----------
  const selA = $('#selA'), selB = $('#selB');
  const opts = D.assets.map((a) => `<option value="${a.sym}">${a.sym}</option>`).join('');
  selA.innerHTML = opts; selB.innerHTML = opts;
  selA.onchange = () => { st.pair[0] = selA.value; renderMatrix(); renderDetail(); };
  selB.onchange = () => { st.pair[1] = selB.value; renderMatrix(); renderDetail(); };
  let perfChart, ratioChart;
  Chart.defaults.color = '#8a93a6';
  Chart.defaults.font.family = "'Satoshi', system-ui, sans-serif";
  Chart.defaults.borderColor = '#1a2231';
  function fmtT(t, step) {
    const d = new Date(t * step * 1000);
    return step === 3600 ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
  }
  function kpi(k, v, s = '', cls = '') { return `<div class="kpi"><div class="k">${k}</div><div class="v ${cls}">${v}</div><div class="s">${s}</div></div>`; }
  function verdict(r) {
    if (!r) return ['—', ''];
    const v = r.ratioVol;
    if (v < 0.2) return ['Low IL risk', 'good'];
    if (v < 0.45) return ['Moderate', 'warn'];
    return ['High IL risk', 'bad'];
  }
  function renderDetail() {
    const [a, b] = st.pair;
    selA.value = a; selB.value = b;
    $('#pairTitle').textContent = `${a} / ${b} · ${st.period}`;
    const r = a === b ? null : pairStats(a, b);
    if (!r) {
      $('#kpis').innerHTML = `<div class="nopool" style="grid-column:1/-1">Not enough overlapping data for this pair in ${st.period}.</div>`;
      if (perfChart) perfChart.destroy(); if (ratioChart) ratioChart.destroy(); perfChart = ratioChart = null;
      $('#poolList').innerHTML = ''; return;
    }
    const [vt, vc] = verdict(r);
    $('#kpis').innerHTML =
      kpi('Correlation', f2(r.corr), r.corr == null ? 'vs stable — n/a' : r.corr > 0.8 ? 'strong' : r.corr > 0.5 ? 'moderate' : 'weak') +
      kpi('Ratio vol (ann.)', pct(r.ratioVol, 0), vt, vc) +
      kpi('Beta', f2(r.beta), `${a} vol ${pct(r.volA, 0)} · ${b} vol ${pct(r.volB, 0)}`) +
      kpi('IL full range', pct(r.il, 2), `worst in period ${pct(r.maxIL, 2)}`, r.il < -0.02 ? 'bad' : '') +
      kpi(`In ${rangeTxt()} range`, pct(r.inRange, 0), 'share of period', r.inRange > 0.8 ? 'good' : r.inRange < 0.5 ? 'bad' : 'warn') +
      kpi('Period return', `${sgnPct(r.retA, 1)}`, `${a} · ${b} ${sgnPct(r.retB, 1)}`);
    const labels = r.t.map((t) => fmtT(t, r.step));
    const pa = r.pa.map((x) => (x / r.pa[0]) * 100), pb = r.pb.map((x) => (x / r.pb[0]) * 100);
    const common = {
      responsive: true, maintainAspectRatio: false, animation: { duration: 250 }, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { boxWidth: 10, boxHeight: 10 } }, tooltip: { backgroundColor: '#161e2b', borderColor: '#232d3f', borderWidth: 1 } },
      scales: { x: { ticks: { maxTicksLimit: 6, maxRotation: 0 }, grid: { display: false } }, y: { ticks: { maxTicksLimit: 5 } } },
      elements: { point: { radius: 0 }, line: { borderWidth: 1.6, tension: 0 } },
    };
    if (perfChart) perfChart.destroy();
    perfChart = new Chart($('#perfChart'), {
      type: 'line',
      data: { labels, datasets: [
        { label: `${a} (rebased 100)`, data: pa, borderColor: '#5b8cff' },
        { label: `${b} (rebased 100)`, data: pb, borderColor: '#f6c177' },
      ] },
      options: common,
    });
    const lo = 1 - st.dn / 100, hi = 1 + st.up / 100;
    if (ratioChart) ratioChart.destroy();
    ratioChart = new Chart($('#ratioChart'), {
      type: 'line',
      data: { labels, datasets: [
        { label: `Range +${st.up}%`, data: labels.map(() => hi), borderColor: 'rgba(62,207,142,.6)', borderDash: [4, 4], borderWidth: 1, fill: false },
        { label: `Range −${st.dn}%`, data: labels.map(() => lo), borderColor: 'rgba(62,207,142,.6)', borderDash: [4, 4], borderWidth: 1, fill: '-1', backgroundColor: 'rgba(62,207,142,.07)' },
        { label: `${a}/${b} price ratio (start = 1)`, data: r.ratio, borderColor: '#e7eaf0' },
      ] },
      options: { ...common, plugins: { ...common.plugins, legend: { labels: { boxWidth: 10, boxHeight: 10, filter: (i) => i.datasetIndex !== 0 } } } },
    });
    renderPoolList();
  }

  // ---------- ranking ----------
  function rankRows() {
    const onlyPool = $('#fPool').checked, onlySel = $('#fSel').checked, usdOk = $('#fUsd').checked;
    const q = $('#fText').value.trim().toLowerCase();
    const minTvl = +$('#fTvl').value;
    const uni = onlySel ? st.sel : SYMS;
    const rows = [];
    for (let i = 0; i < uni.length; i++) for (let j = i + 1; j < uni.length; j++) {
      let a = uni[i], b = uni[j];
      const ta = A[a].type, tb = A[b].type;
      if (ta === 'stable' && tb === 'stable') continue;
      if (!usdOk && (a === 'USDC' || b === 'USDC')) continue;
      const ps = poolsFor(a, b);
      if (onlyPool && !ps.length) continue;
      if (ps.length) { a = ps[0].a; b = ps[0].b; }
      else if (tb === 'stock' && ta !== 'stock') [a, b] = [b, a];
      if (q && !(a + '/' + b).toLowerCase().includes(q)) continue;
      const r = pairStats(a, b);
      if (!r) continue;
      const liq = ps.reduce((s, p) => s + p.liq, 0), vol = ps.reduce((s, p) => s + p.vol, 0);
      if (minTvl && (!ps.length || liq < minTvl)) continue;
      const feeUsd = ps.reduce((s, p) => s + (p.fee != null ? p.vol * p.fee : 0), 0);
      const feeLiq = ps.reduce((s, p) => s + (p.fee != null ? p.liq : 0), 0);
      const apr = feeLiq > 0 ? (feeUsd * 365) / feeLiq : null;
      const top = ps.slice().sort((x, y) => y.liq - x.liq)[0];
      rows.push({ rapr: top ? top.rapr ?? null : null, a, b, pair: a + '/' + b, ...r, liq: ps.length ? liq : null, vol: ps.length ? vol : null, turn: ps.length && liq > 0 ? vol / liq : null, apr, url: ps.slice().sort((x, y) => y.liq - x.liq)[0]?.url, sim: ps.slice().sort((x, y) => y.liq - x.liq)[0]?.addr });
    }
    return rows;
  }
  function renderRank() {
    const rows = rankRows();
    const k = st.sortK, d = st.sortDesc ? -1 : 1;
    rows.sort((x, y) => {
      const vx = x[k], vy = y[k];
      if (vx == null && vy == null) return 0; if (vx == null) return 1; if (vy == null) return -1;
      return typeof vx === 'string' ? vx.localeCompare(vy) * d : (vx - vy) * d;
    });
    const shown = rows.slice(0, 300);
    const maxRV = Math.max(...shown.map((r) => r.ratioVol).filter(isFinite), 0.01);
    $('#rank tbody').innerHTML = shown.map((r) => {
      const ilc = r.il < -0.02 ? 'bad' : r.il > -0.005 ? 'good' : '';
      const rvc = r.ratioVol < 0.2 ? 'good' : r.ratioVol > 0.45 ? 'bad' : 'warn';
      return `<tr data-a="${r.a}" data-b="${r.b}">
        <td><span class="pp">${badge(r.a)}${badge(r.b)} ${r.pair}</span></td>
        <td class="num"><span class="bar-cell" style="width:${Math.max(2, (r.ratioVol / maxRV) * 50)}px"></span><span class="${rvc}">${pct(r.ratioVol, 0)}</span></td>
        <td class="num">${f2(r.corr)}</td>
        <td class="num">${f2(r.beta)}</td>
        <td class="num ${ilc}">${pct(r.il, 2)}</td>
        <td class="num">${pct(r.inRange, 0)}</td>
        <td class="num">${usd(r.liq)}</td>
        <td class="num">${usd(r.vol)}</td>
        <td class="num">${r.turn == null ? '—' : r.turn.toFixed(2) + '×'}</td>
        <td class="num ${r.apr == null ? '' : r.apr >= 0.2 ? 'good' : r.apr < 0.02 ? 'muted' : ''}">${aprFmt(r.apr)}</td>
        <td class="num ${r.rapr == null ? '' : r.rapr >= 0.3 ? 'good' : r.rapr < 0.02 ? 'muted' : ''}">${aprFmt(r.rapr)}</td>
        <td>${r.url ? `<button class="btn sim-btn sm" data-sim="${r.sim}">Sim</button> <a href="${r.url}" target="_blank" rel="noopener">View ↗</a>` : '<span class="muted small">none</span>'}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="12" class="muted">No pairs match these filters.</td></tr>`;
    document.querySelectorAll('#rank th[data-k]').forEach((th) => { th.classList.toggle('sorted', th.dataset.k === k); th.classList.toggle('desc', th.dataset.k === k && st.sortDesc); });
    $('#rankNote').textContent = `${rows.length} pairs · ${st.period} · range ${rangeTxt()}${rows.length > 300 ? ' · showing first 300' : ''}${{ratioVol:'Sorted by lowest ratio vol = least IL',apr:'Sorted by fee APR'}[k] && !(k==='ratioVol'&&st.sortDesc) && !(k==='apr'&&!st.sortDesc) ? ' · '+{ratioVol:'Sorted by lowest ratio vol = least IL',apr:'Sorted by highest fee APR'}[k] : ''}. Tap a row for detail.`;
  }
  document.querySelectorAll('#rank th[data-k]').forEach((th) => th.onclick = () => {
    const k = th.dataset.k;
    if (st.sortK === k) st.sortDesc = !st.sortDesc; else { st.sortK = k; st.sortDesc = ['corr', 'inRange', 'liq', 'vol', 'turn', 'apr', 'rapr', 'il'].includes(k); }
    renderRank();
  });
  ['#fPool', '#fSel', '#fUsd', '#fTvl'].forEach((s) => $(s).onchange = renderRank);
  $('#fLegacy').onchange = (e) => { st.legacy = e.target.checked; renderMatrix(); renderDetail(); renderRank(); };
  $('#fText').oninput = renderRank;
  $('#rank tbody').onclick = (e) => {
    const tr = e.target.closest('tr'); if (!tr || !tr.dataset.a || e.target.closest('a,button')) return;
    st.pair = [tr.dataset.a, tr.dataset.b]; renderMatrix(); renderDetail();
    $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  function renderPoolList() {
    const [a, b] = st.pair;
    if (a === b) { $('#poolList').innerHTML = ''; return; }
    const ps = poolsFor(a, b).slice().sort((x, y) => y.liq - x.liq);
    $('#poolList').innerHTML = ps.length
      ? `<div class="lbl">${st.legacy ? 'Aero + old Aerodrome pools' : 'Aero pools'}</div>` + ps.slice(0, 4).map((p) => `<div class="pool"><span><b>${p.a}/${p.b}</b> <span class="venue ${p.venue}">${p.venue === 'legacy' ? 'Old Aerodrome' : 'Aero'}</span> <span class="muted mono">${kindFmt(p.kind)}${p.fee != null ? ' · ' + feeFmt(p.fee) : ''}</span><br><span class="muted mono">TVL ${usd(p.liq)} · 24h vol ${usd(p.vol)} · fee APR <span class="${p.apr >= 0.2 ? 'good' : ''}">${aprFmt(p.apr)}</span>${p.venue === 'aero' ? ` · AERO APR <span class="${p.rapr >= 0.3 ? 'good' : ''}">${aprFmt(p.rapr)}</span>` : ''}</span></span><span class="pool-acts"><button class="btn sim-btn" data-sim="${p.addr}">Simulate</button><a href="${p.url}" target="_blank" rel="noopener">View ↗</a></span></div>`).join('')
      : `<div class="nopool">No ${st.legacy ? '' : 'Aero '}pool found for ${a}/${b}. You'd have to create it, or LP each side against USDC.${st.legacy ? '' : ' (Tick "Include old Aerodrome pools" to see pre-migration pools.)'}</div>`;

  }
  function renderAll() { renderControls(); legend(); renderMatrix(); renderDetail(); renderRank(); }
  const gen = new Date(D.generated * 1000);
  $('#asofTxt').textContent = `${D.assets.filter((a) => a.type === 'stock').length} stock tokens · ${D.assets.filter((a) => a.type !== 'stock').length} crypto · history ${gen.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sim]');
    if (b && window.SimOpen) { e.preventDefault(); window.SimOpen(b.dataset.sim); }
  });
  renderAll();
  window.PL = { D, A, poolsFor, legacy: () => st.legacy };
  // live: pool TVL / volume / fee APR from DEX Screener every 60s
  if (window.Live) {
    Live.onUpdate((w) => {
      if (w === 'pools') { renderRank(); renderPoolList(); }
      const age = Live.lastUpdate ? Math.round((Date.now() - Live.lastUpdate) / 1000) : null;
      $('#liveDot').className = 'live-dot ' + (Live.ok && age < 150 ? 'on' : 'off');
      $('#liveTxt').textContent = Live.ok ? `Live pools · ${age}s ago` : 'Connecting…';
    });
    Live.start(D);
  }
  document.dispatchEvent(new CustomEvent('pl-ready'));
})();
