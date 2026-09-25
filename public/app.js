/* ─── DS Zone Engine v1.0 — Frontend ──────────────────────── */
let ws, chart, candleS, volS, smaS;
let zoneLines = [], labels = [];
let sym = 'NIFTY', tf = 5, allC = {}, lastA = null, engine = new DSEngine();
let mktOpen = false, wsOk = false, chartInitDone = false, pendingInit = false;
let lastSetupKey = '', livePriceLine = null, lastLTP = 0, lastTrackTime = 0;
let authed = false;

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
}

function loginErr(m) { document.getElementById('loginErr').textContent = m || ''; }

async function initAuth() {
  if (isLocalHost()) { hideLogin(); startApp(); return; }
  const token = localStorage.getItem('ds_token');
  if (token) {
    try {
      const r = await fetch('/api/otp/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      const d = await r.json();
      if (d.ok) { hideLogin(); startApp(); return; }
      localStorage.removeItem('ds_token');
    } catch (e) {}
  }
  showLogin();
  document.getElementById('btnSendOtp').onclick = async () => {
    const email = document.getElementById('loginEmail').value.trim();
    loginErr('');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { loginErr('Valid email daalo'); return; }
    const btn = document.getElementById('btnSendOtp');
    btn.disabled = true; btn.textContent = 'SENDING...';
    try {
      const r = await fetch('/api/otp/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
      const d = await r.json();
      if (d.ok) {
        document.getElementById('loginStep1').style.display = 'none';
        document.getElementById('loginStep2').style.display = 'flex';
        document.getElementById('otpSentMsg').textContent = 'OTP sent to ' + email;
        document.getElementById('loginOtp').focus();
      } else loginErr(d.error || 'Failed to send OTP');
    } catch (e) { loginErr('Network error'); }
    btn.disabled = false; btn.textContent = 'SEND OTP';
  };
  document.getElementById('btnVerifyOtp').onclick = async () => {
    const email = document.getElementById('loginEmail').value.trim();
    const otp = document.getElementById('loginOtp').value.trim();
    loginErr('');
    if (otp.length !== 6) { loginErr('6-digit OTP daalo'); return; }
    const btn = document.getElementById('btnVerifyOtp');
    btn.disabled = true; btn.textContent = 'VERIFYING...';
    try {
      const r = await fetch('/api/otp/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, otp }) });
      const d = await r.json();
      if (d.ok) {
        localStorage.setItem('ds_token', d.token);
        hideLogin();
        startApp();
      } else loginErr(d.error || 'Wrong OTP');
    } catch (e) { loginErr('Network error'); }
    btn.disabled = false; btn.textContent = 'VERIFY & OPEN';
  };
  document.getElementById('btnResendOtp').onclick = () => {
    document.getElementById('loginStep2').style.display = 'none';
    document.getElementById('loginStep1').style.display = 'flex';
    loginErr('');
    document.getElementById('btnSendOtp').click();
  };
}

function startApp() {
  connect();
  httpFetchAll();
}

function connect() {
  try {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws');
    ws.onopen = () => { wsOk = true; document.getElementById('dot').classList.add('on'); document.getElementById('connTxt').textContent = 'Connected'; subAll(); };
    ws.onclose = () => { wsOk = false; document.getElementById('dot').classList.remove('on'); document.getElementById('connTxt').textContent = 'HTTP Mode'; setTimeout(connect, 10000); };
    ws.onerror = () => { wsOk = false; };
    ws.onmessage = e => { try { msg(JSON.parse(e.data)); } catch (err) {} };
  } catch (e) { wsOk = false; }
  setTimeout(() => { if (!wsOk) httpFetchAll(); }, 3000);
}

function subAll() {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ action: 'subscribe', symbol: sym, interval: tf }));
}

async function httpFetchAll() {
  debugLog('httpFetchAll started');
  const tfs = [1,3,5,15,30];
  for (const t of tfs) {
    try {
      const r = await fetch('/api/candles/' + sym + '/' + t);
      const d = await r.json();
      if (d.candles && d.candles.length) allC[sym + '_' + t] = d.candles;
      if (d.mktOpen !== undefined) { mktOpen = d.mktOpen; updMktBadge(); }
    } catch (e) {}
  }
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
    if (arr.length && arr[arr.length - 1].time === ct) arr[arr.length - 1] = d.candle;
    else { arr.push(d.candle); if (arr.length > 800) arr.shift(); }
    if (d.sym === sym && d.tf === tf && candleS) {
      try {
        candleS.update({ time: d.candle.time / 1000, open: d.candle.open, high: d.candle.high, low: d.candle.low, close: d.candle.close });
        if (livePriceLine) livePriceLine.update({ time: Math.floor(d.candle.time / 1000), value: d.candle.close });
      } catch(e) {}
    }
  }
  else if (d.type === 'candles' && d.candles && d.candles.length) {
    allC[d.sym + '_' + d.tf] = d.candles;
    if (d.sym === sym && d.tf === tf && !chartInitDone && !pendingInit) scheduleInit();
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
  document.querySelectorAll('.tf-tab').forEach(el => el.classList.toggle('active', +el.dataset.tf === t));
  lastSetupKey = '';
  chartInitDone = false;
  clearAllOverlays();
  if (chart) { try { chart.remove(); } catch(e){} chart = null; candleS = volS = smaS = null; }
  ws.send(JSON.stringify({ action: 'subscribe', symbol: sym, interval: t }));
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
  if (now - lastTrackTime >= 1000) {
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
  return engine.analyze(l1, l3, l5, l15, l30, p, tf + 'm');
}

function setupKey(s) { return s ? s.direction + '|' + s.zoneTF + '|' + s.entry.toFixed(2) + '|' + s.stopLoss.toFixed(2) + '|' + s.status : ''; }

function updAnalysis(a) {
  if (!a) return; lastA = a;
  const trendEl = document.getElementById('sumTrend');
  if (a.t1) { trendEl.textContent = a.t1.trend.toUpperCase(); trendEl.className = 'si-v ' + (a.t1.trend === 'up' ? 'up' : a.t1.trend === 'down' ? 'dn' : 'fl'); }
  if (a.sma50 != null) document.getElementById('sumSma').textContent = a.sma50.toFixed(1);

  const tfs = ['1m','3m','5m','15m','30m'], atf = a.allTF || {};
  tfs.forEach((tfk, i) => {
    const r = atf[tfk] || a;
    const td = r.trend || a['t' + ['1','3','5','15','30'][i]] || {};
    const el = document.getElementById('tf' + ['1','3','5','15','30'][i]);
    if (el) { el.textContent = td.trend ? td.trend.toUpperCase() : '--'; el.className = 'tv ' + (td.trend === 'up' ? 'up' : td.trend === 'down' ? 'dn' : 'fl'); }
  });

  const tfZoneEl = document.getElementById('tfZones');
  if (tfZoneEl) {
    let html = '<div style="font-size:10px;color:#666;letter-spacing:1px;margin-bottom:4px">ALL TF ZONES</div>';
    for (const tfk of tfs) {
      const r = atf[tfk];
      if (r && r.activeSetup) {
        const s = r.activeSetup, col = s.direction === 'BUY' ? '#00D09C' : '#ff4757';
        const stCol = {WAITING:'#f1c40f',ENTRY_TRIGGERED:'#3498db',TARGET_HIT:'#00D09C',STOP_LOSS_HIT:'#ff4757',INVALIDATED:'#888'}[s.status] || '#888';
        html += '<div style="padding:4px 0;border-bottom:1px solid #1a1a2e;font-size:10px">';
        html += '<div style="display:flex;align-items:center;gap:4px">';
        html += '<span style="width:26px;font-weight:700;color:' + col + '">' + tfk + '</span>';
        html += '<span style="width:28px;color:' + col + ';font-weight:700">' + s.direction + '</span>';
        html += '<span style="width:26px;color:#888">' + s.pattern + '</span>';
        html += '<span style="color:' + stCol + ';font-weight:600;font-size:9px">' + s.status.replace(/_/g,' ').substring(0,8) + '</span>';
        html += '</div>';
        html += '<div style="display:flex;gap:8px;margin-top:2px;font-size:9px;font-family:monospace">';
        html += '<span style="color:#00D09C">E:' + s.entry.toFixed(1) + '</span>';
        html += '<span style="color:#ff4757">SL:' + s.stopLoss.toFixed(1) + '</span>';
        html += '<span style="color:#59c2ff">T:' + s.target.toFixed(1) + '</span>';
        html += '</div></div>';
      } else {
        html += '<div style="display:flex;align-items:center;gap:4px;padding:3px 0;border-bottom:1px solid #1a1a2e;font-size:11px"><span style="width:26px;font-weight:700;color:#555">' + tfk + '</span><span style="color:#555">No zone</span></div>';
      }
    }
    tfZoneEl.innerHTML = html;
  }

  const compEl = document.getElementById('completedSection');
  if (compEl && a.completedByTF) {
    let chtml = '<div style="font-size:10px;color:#666;letter-spacing:1px;margin-bottom:4px">COMPLETED TRADES</div>';
    let hasComp = false;
    for (const tfk of tfs) { const comp = a.completedByTF[tfk]; if (comp && comp.length) { for (const t of comp.slice(-3).reverse()) {
      hasComp = true; const tcol = t.hitStatus === 'TARGET_HIT' ? '#00D09C' : '#ff4757';
      chtml += '<div style="display:flex;gap:6px;align-items:center;padding:3px 0;border-bottom:1px solid #1a1a2e;font-size:10px">';
      chtml += '<span style="color:' + tcol + ';font-weight:700">' + (t.hitStatus === 'TARGET_HIT' ? 'T' : 'X') + '</span>';
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
    document.getElementById('sScore').textContent = (s.zoneScore || 0) + '/14';
    document.getElementById('sET').textContent = 'Type ' + (s.entryType || 3);
    document.getElementById('sStr').textContent = (s.zoneStrength || 'normal').toUpperCase().replace('_', ' ');
    document.getElementById('sFr').textContent = (s.zoneFreshness || 'fresh').replace('_', ' ').toUpperCase();
    document.getElementById('sDist').textContent = s.zoneDist ? Number(s.zoneDist).toFixed(1) : '--';
    document.getElementById('sProx').textContent = Number(s.proximal).toFixed(2);
    document.getElementById('sDistal').textContent = Number(s.distal).toFixed(2);
    const tfSum = tfs.map(t => { const r = atf[t]; return t + ':' + (r && r.activeSetup ? r.activeSetup.status.substring(0,6) : r && r.reason ? r.reason.substring(0,6) : '--'); }).join(' | ');
    document.getElementById('tfSum').textContent = tfSum;
    const stEl = document.getElementById('sStatus');
    stEl.textContent = s.status.replace(/_/g, ' ');
    stEl.className = 's-val ' + ({WAITING:'wait',ENTRY_TRIGGERED:'entry',TARGET_HIT:'tgt',STOP_LOSS_HIT:'sl'}[s.status] || 'inval');
    const r = s.risk || {};
    document.getElementById('rPct').textContent = (r.riskPercent || 1) + '%';
    document.getElementById('rAmt').textContent = r.riskAmount ? 'Rs.' + r.riskAmount.toFixed(0) : '--';
    document.getElementById('rQty').textContent = r.quantity || '--';
    document.getElementById('rRPU').textContent = r.riskPerUnit ? Number(r.riskPerUnit).toFixed(2) : '--';
    document.getElementById('pTitle').textContent = s.direction + ' ' + s.pattern;
    document.getElementById('pBadge').textContent = s.status.replace(/_/g, ' ');
    document.getElementById('pBadge').className = 'badge ' + s.direction.toLowerCase();
    if (setupChanged && chartInitDone) drawZoneOnChart(s);
  } else {
    document.getElementById('noSetup').style.display = 'flex';
    document.getElementById('setupInfo').style.display = 'none';
    const reason = a.reason || '';
    if (reason.includes('Trend DOWN')) {
      document.getElementById('pTitle').textContent = 'WAIT — Trend DOWN';
      document.getElementById('pBadge').textContent = 'WAIT';
      document.getElementById('pBadge').className = 'badge wait';
    } else if (reason.includes('Trend UP')) {
      document.getElementById('pTitle').textContent = 'WAIT — Trend UP';
      document.getElementById('pBadge').textContent = 'WAIT';
      document.getElementById('pBadge').className = 'badge wait';
    } else if (reason.includes('Wait')) {
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
}

function drawZoneOnChart(s) {
  clearAllOverlays();
  if (!chart || !s) return;
  const candles = allC[sym + '_' + tf] || [];
  if (!candles.length) return;
  const isBuy = s.direction === 'BUY';
  const lastT = candles[candles.length - 1].time / 1000;
  const zStart = lastT - 3600, zEnd = lastT + 1800;

  try {
    const mkLine = (col, w, st) => { const l = chart.addLineSeries({ color: col, lineWidth: w, lineStyle: st||0, priceLineVisible: false, lastValueVisible: false }); zoneLines.push(l); return l; };
    const mkArea = (tC, bC) => { const a = chart.addAreaSeries({ topColor: tC, bottomColor: bC, lineColor: 'transparent', lineWidth: 0, priceLineVisible: false, lastValueVisible: false }); zoneLines.push(a); return a; };

    const slTop = Math.max(s.entry, s.stopLoss), slBot = Math.min(s.entry, s.stopLoss);
    const tgTop = Math.max(s.entry, s.target), tgBot = Math.min(s.entry, s.target);

    mkArea('rgba(255,71,87,0.25)','rgba(255,71,87,0.08)').setData([{time:zStart,value:slTop},{time:zEnd,value:slTop}]);
    mkArea('rgba(255,71,87,0.25)','rgba(255,71,87,0.08)').setData([{time:zStart,value:slBot},{time:zEnd,value:slBot}]);
    mkArea('rgba(0,208,156,0.25)','rgba(0,208,156,0.08)').setData([{time:zStart,value:tgTop},{time:zEnd,value:tgTop}]);
    mkArea('rgba(0,208,156,0.25)','rgba(0,208,156,0.08)').setData([{time:zStart,value:tgBot},{time:zEnd,value:tgBot}]);

    mkLine('#ff4757',2).setData([{time:zStart,value:s.stopLoss},{time:zEnd,value:s.stopLoss}]);
    mkLine('#00D09C',2).setData([{time:zStart,value:s.entry},{time:zEnd,value:s.entry}]);
    mkLine('#59c2ff',2).setData([{time:zStart,value:s.target},{time:zEnd,value:s.target}]);

    livePriceLine = chart.addLineSeries({ color: '#f1c40f', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: true });
    zoneLines.push(livePriceLine);
    livePriceLine.setData([{ time: zStart, value: s.price || s.entry }, { time: zEnd, value: s.price || s.entry }]);
  } catch(e) {}

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
}

function applyRisk() { engine.setAccount(parseInt(document.getElementById('riskCap').value)||100000, parseFloat(document.getElementById('riskPct').value)||1); }

document.getElementById('tfTabs').innerHTML = '';
[1,3,5,15,30].forEach(t => { const b = document.createElement('button'); b.className = 'tf-tab' + (t === tf ? ' active' : ''); b.dataset.tf = t; b.textContent = t + 'm'; b.onclick = () => switchTF(t); document.getElementById('tfTabs').appendChild(b); });
const tfG = document.getElementById('tfGrid'); tfG.innerHTML = '';
['1','3','5','15','30'].forEach(t => { const d = document.createElement('div'); d.className = 'tf-item'; d.innerHTML = '<span class="tf-l">' + t + 'm</span><span class="tv" id="tf' + t + '">--</span>'; tfG.appendChild(d); });

document.getElementById('symSel').addEventListener('change', function() {
  sym = this.value; document.getElementById('ltpSym').textContent = this.options[this.selectedIndex].text;
  chartInitDone = false; lastSetupKey = ''; allC = {}; clearAllOverlays();
  if (chart) { try { chart.remove(); } catch(e){} chart = null; candleS = volS = smaS = null; }
  if (wsOk) { ws.send(JSON.stringify({ action: 'subscribe', symbol: sym, interval: tf })); scheduleInit(); }
  else httpFetchAll();
});

setInterval(() => {
  try {
    if (!authed) return;
    if (!wsOk) httpFetchAll();
    const a = runAnalysis();
    const debugEl = document.getElementById('debugInfo');
    if (debugEl) { let s = '3m:' + (allC[sym+'_3']||[]).length + ' chart:' + (chartInitDone?'OK':'NO'); if(a) s += ' | ' + a.status + (a.activeSetup ? ' E:' + a.activeSetup.entry.toFixed(1) + ' ' + a.activeSetup.status : '') + (a.reason ? ' ' + a.reason : ''); debugEl.textContent = s; }
    if (a) updAnalysis(a);
  } catch (err) {}
}, 5000);
initAuth();
