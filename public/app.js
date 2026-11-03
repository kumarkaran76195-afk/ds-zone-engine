/* ─── DS Zone Engine v1.0 — Frontend ──────────────────────── */
let ws, chart, candleS, volS, smaS;
let zoneLines = [], labels = [], zoneBoxLines = [], zoneLbls = [], lastZoneKey = '';
let sym = 'NIFTY', tf = 5, allC = {}, lastA = null, engine = new DSEngine();
let mktOpen = false, wsOk = false, chartInitDone = false, pendingInit = false;
let lastSetupKey = '', livePriceLine = null, lastLTP = 0, lastTrackTime = 0;
let authed = false;
let paywallOn = false, dsTrialInfo = null, buyBannerClosed = false;

function isLocalHost() {
  return location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '';
}

function showLogin() {
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}

function hideLogin() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  authed = true;
  updateBuyBanner();
}

function loginErr(m) { document.getElementById('loginErr').textContent = m || ''; }

function showPaywall() {
  paywallOn = true;
  authed = false;
  updateBuyBanner();
  try { if (ws) { ws.onclose = null; ws.close(); } } catch (e) {}
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('app').style.display = 'none';
  document.getElementById('paywallScreen').style.display = 'flex';
  authed = true;
}

function updateBuyBanner() {
  const b = document.getElementById('buyBanner');
  if (!b) return;
  const show = !isLocalHost() && !paywallOn && authed && dsTrialInfo && !dsTrialInfo.paid && !buyBannerClosed;
  b.style.display = show ? 'flex' : 'none';
}

function getDeviceId() {
  let id = localStorage.getItem('ds_did');
  if (!id) {
    id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2);
    localStorage.setItem('ds_did', id);
  }
  return id;
}

async function initAuth() {
  // Gmail/OTP login HATA DIYA — seedha app khulta hai (koi login nahi)
  hideLogin();
  startApp();
}

function startApp() {
  try { engine.useSymbol(sym); } catch (e) {}   // aaj ke active zone wapas lao (refresh ke baad)
  connect();
  httpFetchAll();
}

function connect() {
  if (paywallOn) return;
  try {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws');
    ws.onopen = () => { wsOk = true; document.getElementById('dot').classList.add('on'); document.getElementById('connTxt').textContent = 'Connected'; subAll(); };
    ws.onclose = () => { wsOk = false; document.getElementById('dot').classList.remove('on'); document.getElementById('connTxt').textContent = 'HTTP Mode'; setTimeout(connect, 3000); };
    ws.onerror = () => { wsOk = false; };
    ws.onmessage = e => { try { msg(JSON.parse(e.data)); } catch (err) {} };
  } catch (e) { wsOk = false; }
  setTimeout(() => { if (!wsOk) httpFetchAll(); }, 3000);
}

function subAll() {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ action: 'subscribe', symbol: sym, interval: tf }));
}

// tf numeric → zone/result key: 1440→'1D', 10080→'1W', 43200→'1M', warna '5m' jaisa
function tfKey(t) {
  return t >= 43200 ? '1M' : t >= 10080 ? '1W' : t >= 1440 ? '1D' : t + 'm';
}

async function httpFetchAll() {
  debugLog('httpFetchAll started');
  const tfs = [1,3,5,15,30,1440,10080,43200];
  // PARALLEL — pehle sequential the, ek slow fetch (12s) baaki sab delay karta tha
  await Promise.all(tfs.map(async t => {
    try {
      const r = await fetch('/api/candles/' + sym + '/' + t);
      const d = await r.json();
      if (d.candles && d.candles.length) allC[sym + '_' + t] = d.candles;
      if (d.mktOpen !== undefined) { mktOpen = d.mktOpen; updMktBadge(); }
    } catch (e) {}
  }));
  document.getElementById('dot').classList.add('on');
  document.getElementById('connTxt').textContent = wsOk ? 'Connected' : 'HTTP Mode';
  if (!chartInitDone) scheduleInit();
}

function updMktBadge() {
  const el = document.getElementById('mktStatus');
  if (el) el.style.display = !mktOpen ? 'inline-block' : 'none';
}

function msg(d) {
  if (d.type === 'candle' && d.candle) {
    const k = d.sym + '_' + d.tf;
    if (!allC[k]) allC[k] = [];
    const arr = allC[k], ct = d.candle.time;
    const lastT = arr.length ? arr[arr.length - 1].time : 0;
    if (arr.length && lastT === ct) arr[arr.length - 1] = d.candle;
    else if (ct > lastT) { arr.push(d.candle); if (arr.length > 800) arr.shift(); }
    // out-of-order (purani) candle ko ignore — array me push karne se chart data corrupt hota tha
    if (d.sym === sym && d.tf === tf && candleS && ct >= lastT) {
      try {
        candleS.update({ time: d.candle.time / 1000, open: d.candle.open, high: d.candle.high, low: d.candle.low, close: d.candle.close });
        if (livePriceLine) livePriceLine.update({ time: Math.floor(d.candle.time / 1000), value: d.candle.close });
      } catch(e) {}
    }
  }
  else if (d.type === 'candles' && d.candles && d.candles.length) {
    allC[d.sym + '_' + d.tf] = d.candles;
    if (d.sym === sym && d.tf === tf) {
      // chart already init hai to bhi naye snapshot se refresh karo
      // (pehle sirf !chartInitDone par schedule hota tha — reconnect/stale ke baad chart purana reh jata tha)
      if (chartInitDone && candleS) setChartData(d.candles);
      else if (!pendingInit) scheduleInit();
    }
  }
  else if (d.type === 'tick') updTick(d);
  else if (d.type === 'marketStatus') { mktOpen = d.open; updMktBadge(); }
}

function debugLog(msg) {
  const el = document.getElementById('debugInfo');
  if (el) { el.textContent += '\n' + new Date().toLocaleTimeString() + ': ' + msg; el.scrollTop = el.scrollHeight; }
  console.log(msg);
}

function scheduleInit() {
  if (pendingInit) return;
  pendingInit = true;
  setTimeout(() => { pendingInit = false; tryInitChart(); }, 300);
}

function switchTF(t) {
  tf = t;
  window.__dsTF = t;   // AI agent ko pata chale userne kaunsa timeframe khol rakha hai
  document.querySelectorAll('.tf-tab').forEach(el => el.classList.toggle('active', +el.dataset.tf === t));
  lastSetupKey = '';
  chartInitDone = false;
  clearAllOverlays();
  if (chart) { try { chart.remove(); } catch(e){} chart = null; candleS = volS = smaS = null; }
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ action: 'subscribe', symbol: sym, interval: t }));
  else { subAll(); }   // socket connecting/closed — readyState check, warna send throw karta aur init reh jata
  scheduleInit();
}

function tryInitChart() {
  if (chartInitDone && chart && candleS) {
    const candles = allC[sym + '_' + tf];
    if (candles && candles.length) setChartData(candles);
    return;
  }
  const candles = allC[sym + '_' + tf];
  debugLog('tryInitChart: candles=' + (candles ? candles.length : 0) + ', tf=' + tf + ', LightweightCharts=' + (typeof LightweightCharts !== 'undefined'));
  if (!candles || candles.length < 3) { debugLog('Not enough candles'); return; }
  const el = document.getElementById('chart');
  if (!el) { debugLog('Chart element not found'); return; }
  const w = el.clientWidth, h = el.clientHeight;
  if (w < 10 || h < 10) { 
    debugLog('Chart element no size: ' + w + 'x' + h + ', forcing 400px');
    el.style.minHeight = '400px';
    setTimeout(tryInitChart, 100);
    return;
  }
  if (chart) { try { chart.remove(); } catch(e){} chart = null; candleS = volS = smaS = null; }

  if (typeof LightweightCharts === 'undefined') {
    debugLog('LightweightCharts not loaded, retrying...');
    setTimeout(tryInitChart, 500);
    return;
  }

  try {
    chart = LightweightCharts.createChart(el, {
      width: el.clientWidth, height: el.clientHeight,
      layout: { background: { type: 'solid', color: '#0a0a0f' }, textColor: '#d1d4dc' },
      grid: { vertLines: { color: '#14141e' }, horzLines: { color: '#14141e' } },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: '#1e1e2a', scaleMargins: { top: 0.1, bottom: 0.1 } },
      timeScale: { borderColor: '#1e1e2a', timeVisible: true, secondsVisible: false }
    });
    candleS = chart.addCandlestickSeries({ upColor: '#00D09C', downColor: '#ff4757', borderDownColor: '#ff4757', borderUpColor: '#00D09C', wickDownColor: '#ff4757', wickUpColor: '#00D09C' });
    volS = chart.addHistogramSeries({ color: '#26a69a', priceFormat: { type: 'volume' }, priceScaleId: 'vol', scaleMargins: { top: 0.85, bottom: 0 } });
    smaS = chart.addLineSeries({ color: '#9b59b6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });

    setChartData(candles);
    const ts = chart.timeScale();
    if (candles.length > 80) {
      ts.setVisibleLogicalRange({ from: Math.max(0, candles.length - 80), to: candles.length + 5 });
    } else {
      ts.fitContent();
    }
    chartInitDone = true;
    // chart init hone ke baad overlays wapas draw karo (warna boxes/labels kabhi nahi aate)
    if (lastA && lastA.activeSetup) {
      try { drawZoneOnChart(lastA.activeSetup); } catch (e) {}
    }
    if (chartInitDone) syncFreshZones();
    debugLog('Chart initialized OK! ' + w + 'x' + h + ' candles=' + candles.length);
    new ResizeObserver(() => { if (chart && el) chart.applyOptions({ width: el.clientWidth, height: el.clientHeight }); }).observe(el);
  } catch (e) {
    debugLog('Chart init failed: ' + e.message);
    setTimeout(tryInitChart, 1000);
  }
}

function setChartData(candles) {
  if (!candleS || !candles || !candles.length) return;
  try {
    const fmt = candles.map(c => ({ time: Math.floor(c.time / 1000), open: c.open, high: c.high, low: c.low, close: c.close }));
    candleS.setData(fmt);
    volS.setData(candles.map(c => ({ time: Math.floor(c.time / 1000), value: c.volume || 1, color: c.close >= c.open ? 'rgba(0,208,156,0.25)' : 'rgba(255,71,87,0.25)' })));
    if (fmt.length >= 20) {
      const p = Math.min(50, fmt.length), sma = [];
      for (let i = p - 1; i < fmt.length; i++) { let s = 0; for (let j = i - p + 1; j <= i; j++) s += fmt[j].close; sma.push({ time: fmt[i].time, value: s / p }); }
      smaS.setData(sma);
    }
  } catch(e) {}
}

function updTick(d) {
  document.getElementById('ltpVal').textContent = Number(d.ltp).toFixed(2);
  document.getElementById('clock').textContent = new Date(d.ts).toLocaleTimeString('en-IN');
  lastLTP = d.ltp;
  if (livePriceLine && chartInitDone) { try { livePriceLine.update({ time: Math.floor(d.ts / 1000), value: d.ltp }); } catch(e) {} }
  if (candleS && chartInitDone) labels.forEach(l => { const cls = l.className.match(/elbl|slbl|tlbl|plbl/); if (cls) { const p = parseFloat(l.textContent.match(/[\d.]+/)); if (p) { const y = candleS.priceScale().priceToCoordinate(p); if (y != null) l.style.transform = 'translateY(' + Math.round(y - 12) + 'px)'; } } });
  const now = Date.now();
  if (now - lastTrackTime >= 500) {
    lastTrackTime = now;
    try {
      if (engine.trackTick(d.ltp)) { const a = runAnalysis(); if (a) updAnalysis(a); }
    } catch(e) {}
  }
}

function runAnalysis() {
  const l1 = allC[sym + '_1'] || [], l3 = allC[sym + '_3'] || [], l5 = allC[sym + '_5'] || [];
  const l15 = allC[sym + '_15'] || [], l30 = allC[sym + '_30'] || [];
  if (!l3.length) return null;
  const p = lastLTP || l3[l3.length - 1].close;
  // D/W/M candles → HTF demand/supply zone display (sirf panel/chart, setup intraday par hi)
  const htf = { d: allC[sym + '_1440'] || [], w: allC[sym + '_10080'] || [], m: allC[sym + '_43200'] || [] };
  return engine.analyze(l1, l3, l5, l15, l30, p, tfKey(tf), htf);
}

function setupKey(s) { return s ? s.direction + '|' + s.zoneTF + '|' + s.entry.toFixed(2) + '|' + s.stopLoss.toFixed(2) + '|' + s.status : ''; }

// panel labels: WAITING/ARMED → WAITING, ENTRY_TRIGGERED → ENTRY
function stLabel(st) {
  if (st === 'ARMED') return 'WAITING';
  if (st === 'ENTRY_TRIGGERED') return 'ENTRY';
  return String(st || '--').replace(/_/g, ' ');
}

function updAnalysis(a) {
  if (!a) return; lastA = a;
  const trendEl = document.getElementById('sumTrend');
  if (a.t1) { trendEl.textContent = a.t1.trend.toUpperCase(); trendEl.className = 'si-v ' + (a.t1.trend === 'up' ? 'up' : a.t1.trend === 'down' ? 'dn' : 'fl'); trendEl.title = '50 SMA clock: ' + (a.t1.clock || '3'); }
  if (a.sma50 != null) document.getElementById('sumSma').textContent = a.sma50.toFixed(1);
  const cvEl = document.getElementById('sumCurve');
  if (cvEl && a.location) {
    const L = a.location;
    cvEl.textContent = L.pct != null ? L.pos.replace(' ON CURVE', '') + ' ' + L.pct + '%' : L.pos;
    cvEl.className = 'si-v ' + (L.action === 'BUY' ? 'up' : L.action === 'SELL' ? 'dn' : 'fl');
    cvEl.title = 'Curve action: ' + L.action;
  }

  const tfs = ['1m','3m','5m','15m','30m','1D','1W','1M'], atf = a.allTF || {};
  const tfNums = ['1','3','5','15','30','D','W','M'];
  tfs.forEach((tfk, i) => {
    const r = atf[tfk];
    const td = (r && r.trend) || (i < 5 ? a['t' + tfNums[i]] : null) || {};
    const el = document.getElementById('tf' + tfNums[i]);
    if (el) { el.textContent = td.trend ? td.trend.toUpperCase() : '--'; el.className = 'tv ' + (td.trend === 'up' ? 'up' : td.trend === 'down' ? 'dn' : 'fl'); }
  });

  const tfZoneEl = document.getElementById('tfZones');
  if (tfZoneEl) {
    let html = '<div style="font-size:10px;color:#666;letter-spacing:1px;margin-bottom:4px">ALL TF ZONES</div>';
    for (const tfk of tfs) {
      const r = atf[tfk];
      const fz = (r && r.freshCount) || 0;
      const tz = (r && r.allFreshZones) || 0;
      if (r && r.activeSetup) {
        const s = r.activeSetup, col = s.direction === 'BUY' ? '#00D09C' : '#ff4757';
        const stCol = {WAITING:'#f1c40f',ARMED:'#e67e22',ENTRY_TRIGGERED:'#3498db',TARGET_HIT:'#00D09C',STOP_LOSS_HIT:'#ff4757',INVALIDATED:'#888',SQUARE_OFF:'#8e44ad'}[s.status] || '#888';
        html += '<div style="padding:4px 0;border-bottom:1px solid #1a1a2e;font-size:10px">';
        html += '<div style="display:flex;align-items:center;gap:4px">';
        html += '<span style="width:26px;font-weight:700;color:' + col + '">' + tfk + '</span>';
        html += '<span style="width:28px;color:' + col + ';font-weight:700">' + s.direction + '</span>';
        html += '<span style="width:26px;color:#888">' + s.pattern + '</span>';
        html += '<span style="color:' + stCol + ';font-weight:600;font-size:9px">' + stLabel(s.status).substring(0,8) + '</span>';
        html += '<span style="margin-left:auto;color:#00D09C;font-size:9px">' + fz + 'F/' + tz + 'Z</span>';
        html += '</div>';
        html += '<div style="display:flex;gap:8px;margin-top:2px;font-size:9px;font-family:monospace">';
        html += '<span style="color:#00D09C">E:' + s.entry.toFixed(1) + '</span>';
        html += '<span style="color:#ff4757">SL:' + s.stopLoss.toFixed(1) + '</span>';
        html += '<span style="color:#59c2ff">T:' + s.target.toFixed(1) + '</span>';
        html += '</div></div>';
      } else {
        const fCol = tz ? '#00D09C' : '#555';
        const fTxt = tz ? fz + ' fresh / ' + tz + ' zone' : 'No zone';
        html += '<div style="display:flex;align-items:center;gap:4px;padding:3px 0;border-bottom:1px solid #1a1a2e;font-size:11px"><span style="width:26px;font-weight:700;color:' + (tz ? '#00D09C' : '#555') + '">' + tfk + '</span><span style="color:' + fCol + '">' + fTxt + '</span></div>';
      }
    }
    tfZoneEl.innerHTML = html;
  }

  // ── D/W/M ZONE LOG — purane zone apni E/SL/T ke saath bane rahe, naye add hote rahe ──
  const htfEl = document.getElementById('htfZones');
  if (htfEl) {
    const zbt = a.allZonesByTF || {};
    const zoneLine = z => {
      const isNew = z.addedAt && Date.now() - z.addedAt < 86400000;
      const isD = z.type === 'demand';
      const sc = (z.tradeScore && z.tradeScore.score) || 0;
      return '<div class="hz-line ' + (isD ? 'hz-d' : 'hz-s') + (isNew ? ' hz-new' : (z.fresh ? '' : ' hz-old')) + '">' +
        '<span class="hz-type">' + (isD ? '▲ D' : '▼ S') + '</span>' +
        '<span class="hz-px">' + Number(z.proximal).toFixed(1) + '-' + Number(z.distal).toFixed(1) + '</span>' +
        '<span class="hz-sc">s' + sc + (z.fresh ? ' FRESH' : ' T' + (z.tested || 0)) + '</span>' +
        (z.entry != null
          ? '<span class="hz-est">E ' + Number(z.entry).toFixed(1) + ' · SL ' + Number(z.sl).toFixed(1) + ' · T ' + Number(z.tgt).toFixed(1) + '</span>'
          : '') +
        (isNew ? '<span class="hz-tag">NEW</span>' : '') + '</div>';
    };
    const block = (lbl, g) => {
      const col = g.tr === 'up' ? '#00D09C' : g.tr === 'down' ? '#ff4757' : '#f1c40f';
      const dem = g.zs.filter(z => z.type === 'demand').length;
      let s = '<div class="hz-head"><b>' + lbl + '</b><span style="color:' + col + '">' + (g.tr ? g.tr.toUpperCase() : '--') + '</span>' +
        '<span class="hz-cnt">' + dem + 'D / ' + (g.zs.length - dem) + 'S</span></div>';
      s += g.zs.slice(0, 5).map(zoneLine).join('');
      if (g.zs.length > 5) s += '<div class="hz-more">+' + (g.zs.length - 5) + ' aur purane zone</div>';
      return s;
    };
    const g = k => { const r = atf[k]; return { tr: r && r.trend ? r.trend.trend : null, zs: zbt[k] || [] }; };
    const d = g('1D'), w = g('1W'), m = g('1M');
    const has = d.zs.length || w.zs.length || m.zs.length;
    htfEl.innerHTML = has
      ? '<div class="tf-title">D / W / M ZONE LOG <span style="color:#555">purane E/SL/T bane rahe · naye NEW</span></div>' +
        block('D', d) + block('W', w) + block('M', m)
      : '<div class="tf-title">D / W / M ZONES (HTF)</div><div style="color:#444;font-size:10px;padding:3px 0">D/W/M candles load ho rahi hain...</div>';
  }

  const compEl = document.getElementById('completedSection');
  if (compEl && a.completedByTF) {
    let chtml = '<div style="font-size:10px;color:#666;letter-spacing:1px;margin-bottom:4px">COMPLETED TRADES</div>';
    let hasComp = false;
    for (const tfk of tfs) { const comp = a.completedByTF[tfk]; if (comp && comp.length) { for (const t of comp.slice(-3).reverse()) {
      hasComp = true; const tcol = t.hitStatus === 'TARGET_HIT' ? '#00D09C' : t.hitStatus === 'SQUARE_OFF' ? '#8e44ad' : '#ff4757';
      const tip = (t.abandonReason || t.exitReason || t.hitStatus || '').replace(/"/g, '&quot;');
      chtml += '<div title="' + tip + '" style="display:flex;gap:6px;align-items:center;padding:3px 0;border-bottom:1px solid #1a1a2e;font-size:10px">';
      chtml += '<span style="color:' + tcol + ';font-weight:700">' + (t.hitStatus === 'TARGET_HIT' ? 'T' : t.hitStatus === 'SQUARE_OFF' ? 'SQ' : 'X') + '</span>';
      chtml += '<span style="width:22px;color:' + tcol + '">' + tfk + '</span>';
      chtml += '<span style="width:24px;color:' + tcol + '">' + t.direction + '</span>';
      chtml += '<span style="color:#888">' + t.pattern + '</span>';
      chtml += '<span style="color:#ccc">E:' + t.entry.toFixed(1) + '</span>';
      chtml += '<span style="color:#555">' + t.hitTime + '</span></div>';
    }}}
    if (!hasComp) chtml += '<div style="color:#333;font-size:10px;padding:4px">No completed trades yet</div>';
    compEl.innerHTML = chtml;
  }

  const sk = setupKey(a.activeSetup), setupChanged = sk !== lastSetupKey;
  lastSetupKey = sk;

  if (a.activeSetup) {
    const s = a.activeSetup;
    document.getElementById('noSetup').style.display = 'none';
    document.getElementById('setupInfo').style.display = 'block';
    document.getElementById('dirTxt').textContent = s.direction;
    document.getElementById('dirBadge').className = 'dir ' + s.direction.toLowerCase();
    document.getElementById('dirIcon').textContent = s.direction === 'BUY' ? '\u25B2' : '\u25BC';
    document.getElementById('sZType').textContent = s.zoneType.toUpperCase();
    document.getElementById('sPat').textContent = s.pattern;
    document.getElementById('sZTF').textContent = s.zoneTF || '--';
    document.getElementById('sEntry').textContent = Number(s.entry).toFixed(2);
    document.getElementById('sSL').textContent = Number(s.stopLoss).toFixed(2);
    document.getElementById('sTgt').textContent = Number(s.target).toFixed(2);
    document.getElementById('sRR').textContent = '1:' + Number(s.riskReward).toFixed(1);
    document.getElementById('sScore').textContent = (s.zoneScore || 0) + '/' + (s.maxScore || 11);
    document.getElementById('sET').textContent = 'Type ' + (s.entryType || 3);
    document.getElementById('sET').title = s.entryRule || '';
    document.getElementById('sStr').textContent = (s.zoneStrength || 'normal').toUpperCase().replace('_', ' ');
    document.getElementById('sFr').textContent = (s.zoneFreshness || 'fresh').replace('_', ' ').toUpperCase();
    document.getElementById('sDist').textContent = s.zoneDist ? Number(s.zoneDist).toFixed(1) : '--';
    document.getElementById('sProx').textContent = Number(s.proximal).toFixed(2);
    document.getElementById('sDistal').textContent = Number(s.distal).toFixed(2);
    const tfSum = tfs.map(t => { const r = atf[t]; return t + ':' + (r && r.activeSetup ? stLabel(r.activeSetup.status) : r && r.reason ? r.reason.substring(0,6) : '--'); }).join(' | ');
    const notes = [];
    if (s.monthLimit) notes.push('<span style="color:#ff4757">10 trades/month limit (PDF) — entry band, sirf monitoring</span>');
    if (s.status === 'SQUARE_OFF') notes.push('<span style="color:#8e44ad">15:15 EOD square-off — trade band</span>');
    if (a.backtestOnly) notes.push('<span style="color:#666">BACKTEST ONLY — live trading koi bhi trade execute nahi karta</span>');
    if (s.staleTarget) notes.push('<span style="color:#f1c40f">Target LTP ke peeche — retest ka wait</span>');
    document.getElementById('tfSum').innerHTML = (notes.length ? notes.join('<br>') + '<br>' : '') + tfSum;
    const stEl = document.getElementById('sStatus');
    stEl.textContent = stLabel(s.status);
    stEl.className = 's-val ' + ({WAITING:'wait',ARMED:'wait',ENTRY_TRIGGERED:'entry',TARGET_HIT:'tgt',STOP_LOSS_HIT:'sl',SQUARE_OFF:'wait'}[s.status] || 'inval');
    const r = s.risk || {};
    document.getElementById('rPct').textContent = (r.riskPercent || 1) + '%';
    document.getElementById('rAmt').textContent = r.riskAmount ? 'Rs.' + r.riskAmount.toFixed(0) : '--';
    document.getElementById('rQty').textContent = r.quantity || '--';
    document.getElementById('rRPU').textContent = r.riskPerUnit ? Number(r.riskPerUnit).toFixed(2) : '--';
    document.getElementById('pTitle').textContent = s.direction + ' ' + s.pattern;
    document.getElementById('pBadge').textContent = stLabel(s.status);
    document.getElementById('pBadge').className = 'badge ' + s.direction.toLowerCase();
    if (setupChanged || !zoneLines.length) { if (chartInitDone) drawZoneOnChart(s); }
  } else {
    document.getElementById('noSetup').style.display = 'flex';
    document.getElementById('setupInfo').style.display = 'none';
    const reason = a.reason || '';
    const zs = (a.allZonesByTF && a.allZonesByTF[tfKey(tf)]) || [];
    const fz = zs.filter(z => z.fresh).length;
    if (zs.length) document.querySelector('#noSetup .ns-sub').textContent = fz + ' fresh / ' + zs.length + ' zone mile — chart par draw ho rahe hain';
    else document.querySelector('#noSetup .ns-sub').textContent = 'Waiting for valid zone structure';
    if (reason.includes('Trend DOWN')) {
      document.getElementById('pTitle').textContent = 'WAIT — Trend DOWN';
      document.getElementById('pBadge').textContent = 'WAIT';
      document.getElementById('pBadge').className = 'badge wait';
    } else if (reason.includes('Trend UP')) {
      document.getElementById('pTitle').textContent = 'WAIT — Trend UP';
      document.getElementById('pBadge').textContent = 'WAIT';
      document.getElementById('pBadge').className = 'badge wait';
    } else if (reason.includes('Wait') || reason.includes('trade') || reason.includes('Session') || reason.includes('15:15') || reason.includes('Sideways')) {
      document.getElementById('pTitle').textContent = reason;
      document.getElementById('pBadge').textContent = 'WAIT';
      document.getElementById('pBadge').className = 'badge wait';
    } else {
      document.getElementById('pTitle').textContent = a.status === 'NO_SETUP' ? 'NO VALID SETUP' : 'SCANNING';
      document.getElementById('pBadge').textContent = '--';
      document.getElementById('pBadge').className = 'badge';
    }
    if (setupChanged) clearAllOverlays();
  }
  if (chartInitDone) syncFreshZones();
  if (window.dsAutoTrade) { try { dsAutoTrade(a); } catch (e) {} }
}

function freshZoneKey(zs) {
  return zs.map(z => z.type + '|' + Math.round(z.proximal * 10) + '|' + Math.round(z.distal * 10) + '|' + z.zoneTime).join(';');
}

function clearZoneBoxes() {
  zoneBoxLines.forEach(s => { try { chart.removeSeries(s); } catch (e) {} });
  zoneBoxLines = [];
  // zone ke E/SL/T labels bhi hatao (active setup ke labels alag hain — unhe mat chhua)
  zoneLbls.forEach(l => {
    l.remove();
    const i = labels.indexOf(l);
    if (i >= 0) labels.splice(i, 1);
  });
  zoneLbls = [];
}

function syncFreshZones() {
  if (!chart || !chartInitDone) return;
  let zs = (lastA && lastA.allZonesByTF && lastA.allZonesByTF[tfKey(tf)]) || [];
  // sirf paas ke zones (5 ATR) max 10 — warna chart stripy ho jata hai
  const ltp = (lastA && lastA.price) || 0;
  const candles = allC[sym + '_' + tf] || [];
  let atrv = (lastA && lastA.atr) || 0;
  if (!atrv) atrv = (typeof simpleAtr === 'function' ? simpleAtr(candles) : 0) || 0;   // SL buffer ke liye ATR
  if (ltp && atrv) zs = zs.filter(z => Math.abs(z.proximal - ltp) <= atrv * 5);
  zs = zs.slice(0, 10);
  // key me ATR (0.5 point granularity) — stale SL/target lines na rahen, lekin
  // har tick par ATR ke chhote badlaav se redraw/flicker bhi na ho
  const k = freshZoneKey(zs) + '|a' + Math.round(atrv * 2);
  if (k === lastZoneKey && zoneBoxLines.length) return;
  clearZoneBoxes();
  lastZoneKey = k;
  if (!zs.length) return;
  if (!candles.length) return;
  // D/W/M candle ka time bucket-start hota hai (09:15) — zone tab tak hi khichna
  // chahiye jitna chart dikh raha hai (aaj + 1 din tak), warna zone left par hi khatam
  const lastT = Math.floor(candles[candles.length - 1].time / 1000);
  const zEnd = tf >= 1440 ? Math.floor(Date.now() / 1000) + 86400 : lastT + 900;
  // active setup ka zone E/SL/T already drawZoneOnChart ne draw kiya — skip (double lines/labels nahi chahiye)
  const act = (lastA && lastA.activeSetup) || null;
  zs.forEach(z => {
    const t0 = Math.floor(z.zoneTime / 1000);
    if (!isFinite(t0) || t0 <= 0 || t0 >= zEnd) return;
    const isD = z.type === 'demand';
    const auth = z.authentic !== false;   // PDF: non-authentic zone = grey dashed
    const fresh = !!z.fresh;
    const col = isD ? '0,208,156' : '255,71,87';
    try {
      const s = chart.addBaselineSeries({
        topColor: !auth ? 'rgba(140,140,140,0.06)' : fresh ? 'rgba(' + col + ',0.12)' : 'rgba(' + col + ',0.05)',
        bottomColor: !auth ? 'rgba(140,140,140,0.06)' : fresh ? 'rgba(' + col + ',0.12)' : 'rgba(' + col + ',0.05)',
        lineColor: !auth ? 'rgba(140,140,140,0.5)' : fresh ? 'rgba(' + col + ',0.7)' : 'rgba(' + col + ',0.3)',
        baseLineColor: 'transparent',
        lineWidth: 1,
        lineStyle: (auth && fresh) ? 0 : 2,
        baseValue: { type: 'price', value: z.distal },
        priceLineVisible: false, lastValueVisible: false
      });
      s.setData([{ time: t0, value: z.proximal }, { time: zEnd, value: z.proximal }]);
      zoneBoxLines.push(s);
    } catch (e) {}

    // ── har zone ke ENTRY / STOP-LOSS / TARGET price line + label ──
    // (PDF: entry = proximal, SL = distal ∓ 0.10×ATR, target = risk × 2)
    const isActiveZone = act && Math.abs(act.proximal - z.proximal) < 0.05 && Math.abs(act.distal - z.distal) < 0.05;
    if (isActiveZone) return;
    const entry = z.proximal;
    const sl = isD ? z.distal - atrv * 0.10 : z.distal + atrv * 0.10;
    const risk = Math.abs(entry - sl);
    const tgt = isD ? entry + risk * 2 : entry - risk * 2;
    const line = (val, lc, dash) => {
      try {
        const l = chart.addLineSeries({
          color: lc, lineWidth: 1, lineStyle: dash ? 2 : 0,
          priceLineVisible: false, lastValueVisible: false
        });
        l.setData([{ time: t0, value: val }, { time: zEnd, value: val }]);
        zoneBoxLines.push(l);
      } catch (e) {}
    };
    const style = (auth && fresh) ? 0 : 2;   // fresh+auth = solid, baaki dashed (box ke jaisa)
    line(entry, isD ? '#00D09C' : '#ff4757', style);
    line(sl, '#ff4757', style);
    line(tgt, '#59c2ff', style);
    // har zone ke ENTRY / SL / TARGET price label (chart par box ke saath)
    addZoneLbl(entry, isD ? '#00D09C' : '#ff4757', 'E ' + Number(entry).toFixed(1), isD ? 'elbl' : 'slbl');
    addZoneLbl(sl, '#ff4757', 'SL ' + Number(sl).toFixed(1), 'slbl');
    addZoneLbl(tgt, '#59c2ff', 'T ' + Number(tgt).toFixed(1), 'tlbl');
  });
}

function addZoneLbl(p, col, txt, cls) {
  addLbl(p, col, txt, cls);
  zoneLbls.push(labels[labels.length - 1]);
}

function drawZoneOnChart(s) {
  clearAllOverlays();
  if (!chart || !s) return;
  const candles = allC[sym + '_' + tf] || [];
  if (!candles.length) return;
  const isBuy = s.direction === 'BUY';
  const lastT = candles[candles.length - 1].time / 1000;
  const firstT = candles[0].time / 1000;
  const zStart = Math.min(firstT, lastT - 3600), zEnd = lastT + 1800;

  const mk = (fn) => { try { fn(); } catch (e) { try { debugLog('overlay fail: ' + e.message); } catch (e2) {} } };

  const slTop = Math.max(s.entry, s.stopLoss), slBot = Math.min(s.entry, s.stopLoss);
  const tgTop = Math.max(s.entry, s.target), tgBot = Math.min(s.entry, s.target);

  // RED box: entry → stop loss | GREEN box: entry → target (baseline fill, fallback area)
  const mkBox = (lo, hi, col) => mk(() => {
    if (!(hi > lo)) return;
    let b;
    try {
      b = chart.addBaselineSeries({
        topColor: col, bottomColor: 'transparent', lineColor: 'transparent', lineWidth: 0,
        baseLineColor: 'transparent', baseValue: { type: 'price', value: lo },
        priceLineVisible: false, lastValueVisible: false
      });
    } catch (e1) {
      b = chart.addAreaSeries({
        topColor: col, bottomColor: 'rgba(0,0,0,0)', lineColor: 'transparent', lineWidth: 0,
        baseValue: { type: 'price', value: lo }, priceLineVisible: false, lastValueVisible: false
      });
    }
    b.setData([{ time: zStart, value: hi }, { time: zEnd, value: hi }]);
    zoneLines.push(b);
  });
  mkBox(slBot, slTop, 'rgba(255,71,87,0.30)');   // entry se SL tak laal
  mkBox(tgBot, tgTop, 'rgba(0,208,156,0.30)');   // entry se target tak hara

  const line = (val, col, w) => mk(() => {
    const l = chart.addLineSeries({ color: col, lineWidth: w, priceLineVisible: false, lastValueVisible: false });
    zoneLines.push(l);
    l.setData([{ time: zStart, value: val }, { time: zEnd, value: val }]);
  });
  line(s.stopLoss, '#ff4757', 2);
  line(s.entry, '#00D09C', 2);
  line(s.target, '#59c2ff', 2);

  mk(() => {
    livePriceLine = chart.addLineSeries({ color: '#f1c40f', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: true });
    zoneLines.push(livePriceLine);
    livePriceLine.setData([{ time: zStart, value: s.price || s.entry }, { time: zEnd, value: s.price || s.entry }]);
  });

  addLbl(s.entry,'#00D09C','ENTRY '+Number(s.entry).toFixed(1),'elbl');
  addLbl(s.stopLoss,'#ff4757','SL '+Number(s.stopLoss).toFixed(1),'slbl');
  addLbl(s.target,'#59c2ff','TARGET '+Number(s.target).toFixed(1),'tlbl');
  if (s.price) addLbl(s.price,'#f1c40f','LTP '+Number(s.price).toFixed(1),'plbl');
}

function addLbl(p,col,txt,cls) {
  const el = document.createElement('div'); el.className = 'cl ' + cls;
  el.innerHTML = '<span class="cd"></span>' + txt;
  document.getElementById('labels').appendChild(el); labels.push(el);
  if (candleS && chartInitDone) {
    const y = candleS.priceScale().priceToCoordinate(p);
    if (y != null) el.style.transform = 'translateY(' + Math.round(y - 12) + 'px)';
  }
}

function clearAllOverlays() {
  if (chart) zoneLines.forEach(l => { try { chart.removeSeries(l); } catch(e){} });
  zoneLines = []; labels.forEach(l => l.remove()); labels = []; livePriceLine = null;
  clearZoneBoxes(); lastZoneKey = '';
}

function applyRisk() { engine.setAccount(parseInt(document.getElementById('riskCap').value)||100000, parseFloat(document.getElementById('riskPct').value)||1); }

document.getElementById('tfTabs').innerHTML = '';
const tfLbl = t => t >= 43200 ? '1M' : t >= 10080 ? '1W' : t >= 1440 ? 'D' : t + 'm';
[1,3,5,15,30,1440,10080,43200].forEach(t => { const b = document.createElement('button'); b.className = 'tf-tab' + (t === tf ? ' active' : ''); b.dataset.tf = t; b.textContent = tfLbl(t); b.onclick = () => switchTF(t); document.getElementById('tfTabs').appendChild(b); });
window.__dsTF = tf;   // currently open timeframe (AI agent context)
const tfG = document.getElementById('tfGrid'); tfG.innerHTML = '';
['1','3','5','15','30','D','W','M'].forEach(t => { const d = document.createElement('div'); d.className = 'tf-item'; d.innerHTML = '<span class="tf-l">' + (t.length === 1 && t !== 'D' && t !== 'W' && t !== 'M' ? t + 'm' : t) + '</span><span class="tv" id="tf' + t + '">--</span>'; tfG.appendChild(d); });

// symbol switch — search dropdown + BEST BUY box dono yahin se select karte hain
function selectSymbol(s, n) {
  if (s === sym) return;
  sym = s;
  document.getElementById('ltpSym').textContent = n || s;
  chartInitDone = false; lastSetupKey = ''; allC = {}; clearAllOverlays();
  try { engine.useSymbol(sym); } catch (e) {}   // naye symbol ke zones load, purane hatao
  if (chart) { try { chart.remove(); } catch (e) {} chart = null; candleS = volS = smaS = null; }
  if (wsOk) { ws.send(JSON.stringify({ action: 'subscribe', symbol: sym, interval: tf })); scheduleInit(); }
  else httpFetchAll();
}

// ── SYMBOL SEARCH (Nifty50/Nifty500 + koi bhi NSE symbol) ──
(function () {
  const inp = document.getElementById('symInput');
  const drop = document.getElementById('symDrop');
  if (!inp || !drop) return;
  const LIST = window.DS_SYMBOLS || [];
  const ALIAS = { SBI: 'SBIN', 'SBI ': 'SBIN', NIFTY: 'NIFTY', NIFTY50: 'NIFTY', BANKNIFTY: 'BANKNIFTY', FINNIFTY: 'FINNIFTY', SENSEX: 'SENSEX' };
  const fmt = (s, n) => '<div class="sym-opt" data-s="' + s + '"><b>' + s + '</b><span>' + n + '</span></div>';
  let selIdx = -1, opts = [];

  function pick(s, n) {
    drop.style.display = 'none'; inp.value = ''; selIdx = -1;
    selectSymbol(s, n);
  }

  function render(q) {
    q = (q || '').trim().toUpperCase();
    if (q) q = ALIAS[q] || q;
    let list = !q ? LIST.slice(0, 12)
      : LIST.filter(x => x.s.startsWith(q) || x.n.toUpperCase().includes(q)).slice(0, 12);
    opts = list.slice();
    if (q.length >= 3 && /^[A-Z][A-Z0-9&-]{0,19}$/.test(q) && !list.some(x => x.s === q)) {
      opts.push({ s: q, n: q + ' (custom NSE)' });
    }
    drop.innerHTML = opts.map(x => fmt(x.s, x.n)).join('') ||
      '<div class="sym-opt sym-empty">Koi match nahi — seedha NSE symbol type karo</div>';
    drop.style.display = 'block'; selIdx = -1;
  }

  inp.addEventListener('input', () => render(inp.value));
  inp.addEventListener('focus', () => render(inp.value));
  inp.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = drop.querySelectorAll('.sym-opt[data-s]').length;
      if (!n) return;
      selIdx = (selIdx + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      drop.querySelectorAll('.sym-opt').forEach((el, i) => el.classList.toggle('sel', i === selIdx));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = opts[selIdx >= 0 ? selIdx : 0];
      if (target) pick(target.s, target.n);
      else {
        const q = (inp.value || '').trim().toUpperCase();
        if (/^[A-Z][A-Z0-9&-]{0,19}$/.test(q)) pick(ALIAS[q] || q, q);
      }
    } else if (e.key === 'Escape') drop.style.display = 'none';
  });
  drop.addEventListener('mousedown', e => {
    const o = e.target.closest('.sym-opt[data-s]');
    if (o) { e.preventDefault(); const m = opts.find(x => x.s === o.dataset.s); if (m) pick(m.s, m.n); }
  });
  document.addEventListener('click', e => {
    if (!document.getElementById('symSearch').contains(e.target)) drop.style.display = 'none';
  });
  inp.value = '';  // default symbol NIFTY (app.js top par set hai)
})();

// ── BEST DEMAND ZONE BOX — Nifty500/50: DAILY | WEEKLY | MONTHLY alag buttons.
//    Har row: sector badge (achha perform tabhi aayega — server gate) + H/L (ATH/ATL) +
//    all-time low ke paas best demand zone E/SL/T + LIVE ENTER badge. Click = chart. ──
let bbTab = '1D', bbData = null;
const BB_TABS = [['1D', 'DAILY'], ['1W', 'WEEKLY'], ['1M', 'MONTHLY']];

async function refreshBestBuy() {
  try {
    const r = await fetch('/api/scan/bestbuy');
    const d = await r.json();
    if (d && d.ok) bbData = d;
    renderBestBuy();
  } catch (e) {}
}

function renderBestBuy(scrollTop) {
  const box = document.getElementById('bestBuyBox');
  if (!box || !bbData) return;
  if (scrollTop !== undefined) box._reqTop = scrollTop;   // pending scroll request (deferred render ke liye)
  const tabs = bbData.tabs || {};
  const total = BB_TABS.reduce((n, t) => n + ((tabs[t[0]] || []).length), 0);
  if (!total) { box.style.display = 'none'; box.innerHTML = ''; box._bbKey = null; return; }
  box.style.display = 'block';
  // scroll bug fix: 30s refresh par list ka scroll top na jaaye — data same ho to rebuild hi mat karo
  const prevList = box.querySelector('.bb-list');
  const prevTop = prevList ? prevList.scrollTop : 0;
  const key = bbTab + '|' + JSON.stringify(tabs[bbTab] || []);
  if (box._bbKey === key && box.innerHTML) { box._reqTop = undefined; return; }  // wahi data = scroll na hile
  // TOUCH FIX: user dabaye hue ho to rebuild mat karo (tap beech me element hatne se
  // miss ho jata tha) — pointer up ke 500ms baad dobara render
  if (box._interacting) {
    if (!box._re) box._re = setTimeout(() => { box._re = null; renderBestBuy(box._reqTop); }, 500);
    return;
  }
  box._reqTop = undefined;
  const effTop = scrollTop !== undefined ? scrollTop : prevTop;
  // PAGE-JUMP FIX: box ke andar jo bhi focused ho use pehle blur karo — focused button
  // innerHTML se remove hone par mobile browser page ko upar kheenchta tha
  const ae = document.activeElement;
  if (ae && box.contains(ae) && typeof ae.blur === 'function') ae.blur();
  const fmtPct = v => (v == null ? '' : (v >= 0 ? '+' : '') + Number(v).toFixed(1) + '%');
  const btns = BB_TABS.map(t =>
    '<button class="bb-tab' + (bbTab === t[0] ? ' on' : '') + '" data-t="' + t[0] + '">' + t[1] +
    ' <span>' + Math.min((tabs[t[0]] || []).length, 8) + '</span></button>').join('');
  const rows = (tabs[bbTab] || []).slice(0, 8).map(h => {
    const z = h.zone || {};
    const on = h.sym === sym;
    const secCol = h.secPct == null ? '#889' : h.secPct >= 0 ? '#00D09C' : '#ff4757';
    const nameOf = s => { const m = (window.DS_SYMBOLS || []).find(x => x.s === s); return m ? m.n : s; };
    return '<div class="bb-row' + (on ? ' on' : '') + '" data-s="' + h.sym + '" title="Click = chart kholo">' +
      '<b>' + h.sym + '</b><span class="bb-n">' + nameOf(h.sym) + '</span>' +
      '<span class="bb-ltp">' + Number(h.ltp).toFixed(2) + '</span>' +
      (h.enter
        ? '<i class="bb-badge bb-enter">LIVE ENTRY</i>'
        : '<i class="bb-badge bb-near">TOUCHED E</i>') +
      '<span class="bb-prices"><b class="bb-e">E ' + Number(z.entry).toFixed(1) + '</b>' +
      '<b class="bb-s">SL ' + Number(z.sl).toFixed(1) + '</b>' +
      '<b class="bb-t">T ' + Number(z.tgt).toFixed(1) + '</b>' +
      '<span class="bb-sec" style="color:' + secCol + '">' + h.sec + fmtPct(h.secPct) + '</span>' +
      (z.fresh ? ' <i class="bb-f">NEW</i>' : '') + '</span>' +
      '<span class="bb-hl">H ' + Number(h.ath).toFixed(1) + ' · L ' + Number(h.atl).toFixed(1) +
      ' · ' + z.tf + ' · s' + (z.score || 0) + '</span></div>';
  }).join('');
  box.innerHTML =
    '<div class="tf-title">ENTRY TOUCHED (LIVE) — NIFTY 500 / 50 <span class="bb-count">SECTOR GATE</span></div>' +
    '<div class="bb-tabs">' + btns + '</div>' +
    '<div class="bb-list">' + (rows ||
      '<div class="bb-empty">is timeframe par abhi kisi stock ne entry touch nahi ki (zone + achha sector dono chahiye)</div>') + '</div>';
  box._bbKey = key;
  // purana scroll position wapas (refresh ke baad niche wahi rehna chahiye); tab click = 0
  const newList = box.querySelector('.bb-list');
  if (newList) newList.scrollTop = effTop;
  // naye tab button ko bina scroll ke wapas focus karo (touch delay khatam, page na hile)
  try {
    const nt = box.querySelector('.bb-tab[data-t="' + bbTab + '"]');
    if (nt && document.activeElement !== nt) nt.focus({ preventScroll: true });
  } catch (e) {}
}

document.addEventListener('click', e => {
  const box = document.getElementById('bestBuyBox');
  if (!box) return;
  const tab = e.target.closest('.bb-tab');
  if (tab) { bbTab = tab.dataset.t; renderBestBuy(0); return; }
  const row = e.target.closest('.bb-row');
  if (row && box.contains(row)) {
    const m = (window.DS_SYMBOLS || []).find(x => x.s === row.dataset.s);
    selectSymbol(row.dataset.s, m ? m.n : row.dataset.s);
  }
});
// touch: dabate hue rebuild na ho (tab/row ka tap miss na ho) — up ke 400ms baad free
(function () {
  const box = document.getElementById('bestBuyBox');
  if (!box) return;
  box.addEventListener('pointerdown', () => { box._interacting = true; clearTimeout(box._iTimer); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => box.addEventListener(ev, () => {
    clearTimeout(box._iTimer);
    box._iTimer = setTimeout(() => { box._interacting = false; }, 400);
  }));
})();
refreshBestBuy();
setInterval(refreshBestBuy, 30000);

setInterval(() => {
  try {
    if (!authed) return;
    if (!wsOk) httpFetchAll();
    const a = runAnalysis();
    const debugEl = document.getElementById('debugInfo');
    if (debugEl) { let s = '3m:' + (allC[sym+'_3']||[]).length + ' chart:' + (chartInitDone?'OK':'NO'); if(a) s += ' | ' + a.status + (a.activeSetup ? ' E:' + a.activeSetup.entry.toFixed(1) + ' ' + a.activeSetup.status : '') + (a.reason ? ' ' + a.reason : ''); debugEl.textContent = s; }
    if (a) updAnalysis(a);
  } catch (err) {}
}, 2000);
initAuth();

const bbX = document.getElementById('buyBannerX');
if (bbX) bbX.onclick = () => { buyBannerClosed = true; updateBuyBanner(); };

// Trial/paywall auto-close interval HATA DIYA (login hi nahi ab)

// ── AI AGENT strip (main window panel) — /api/agent se live:
//    W/L + win%, Strategy Version, CAUTION, pending SUGGEST, latest ROOT CAUSE,
//    VALIDATION. Click = agent chat khulta hai (🤖 FAB) ──
const aiEsc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function refreshAiAgent() {
  const lineEl = document.getElementById('aiAgentLine');
  const verEl = document.getElementById('aiVer');
  if (!lineEl) return;
  try {
    const r = await fetch('/api/agent', { cache: 'no-store' });
    const d = await r.json();
    if (!d || !d.ok || !d.agent) { lineEl.textContent = 'Agent nahi mila — server check karo'; return; }
    const a = d.agent, S = a.stats || {};
    if (verEl) verEl.textContent = a.version ? '· ' + a.version : '';
    const bits = [(S.targets || 0) + 'T/' + (S.sls || 0) + 'SL · win ' + (S.winRate || 0) + '%'];
    if (a.cooldownLeftMs > 0) bits.push('PAUSE ' + Math.ceil(a.cooldownLeftMs / 60000) + 'm');
    if (a.caution && a.caution.on) bits.push('CAUTION: ' + a.caution.reason);
    let html = '<div style="color:#c9d4ff">' + aiEsc(bits.join(' · ')) + '</div>';
    if (a.suggest) html += '<div style="color:#ffcc66;margin-top:3px">SUGGEST: ' + aiEsc(a.suggest.k + ' = ' + a.suggest.v) + ' → chat me "apply karo"</div>';
    const rc = a.rootCause;
    if (rc) html += '<div style="color:#8fe3b6;margin-top:3px">ROOT [' + aiEsc(rc.causeCode || '?') + '] ' + aiEsc(String(rc.name || '').slice(0, 70)) + (rc.confidence ? ' · ' + rc.confidence + '%' : '') + '</div>';
    const mi2 = a.intel;
    if (mi2 && (mi2.globalLine || mi2.headline)) {
      if (mi2.globalLine) html += '<div style="color:#8ab8e8;margin-top:3px">GLOBAL: ' + aiEsc(String(mi2.globalLine).slice(0, 120)) + '</div>';
      if (mi2.headline) html += '<div style="color:#9ab;margin-top:3px">NEWS [' + aiEsc(mi2.headline.impact) + '] ' + aiEsc(String(mi2.headline.t).slice(0, 75)) + ' · ' + aiEsc(mi2.headline.src) + ' ' + aiEsc(mi2.headline.time) + '</div>';
      if (mi2.nextEvent) html += '<div style="color:#e9c46a;margin-top:3px">EVENT: ' + aiEsc(String(mi2.nextEvent.t).slice(0, 60)) + ' · ' + aiEsc(mi2.nextEvent.at) + '</div>';
    }
    const vv = (a.versions || []).slice(-1)[0];
    if (vv) html += '<div style="color:#7aa2ff;margin-top:3px">RULE: ' + aiEsc(vv.key + ' ' + vv.oldVal + ' → ' + vv.newVal) + ' · ' + aiEsc(vv.v) + (vv.status === 'rolledback' ? ' (rolledback)' : '') + '</div>';
    if (a.validation) html += '<div style="color:' + (a.validation.status === 'PASS' ? '#00D09C' : '#889') + ';margin-top:3px">VALIDATION: ' + aiEsc(a.validation.key + ' = ' + a.validation.status) + '</div>';
    lineEl.innerHTML = html;
  } catch (e) { lineEl.textContent = 'Agent offline — server chalu karo (node server.js)'; }
}
const aiBox = document.getElementById('aiAgentBox');
if (aiBox) aiBox.onclick = () => { const f = document.getElementById('dsFab'); if (f) f.click(); };
refreshAiAgent();
setInterval(refreshAiAgent, 12000);
