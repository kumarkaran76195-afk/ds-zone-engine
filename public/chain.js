/* ─── DS Zone — Live Option Chain + Paper Trading (APK only) ─── */
(function () {
  const START_CASH = 100000;
  let cSym = 'NIFTY', cExpiry = '', cData = null, cTimer = null, cLoading = false;
  let cSig = null;
  let paper = loadPaper();

  function loadPaper() {
    try {
      const j = JSON.parse(localStorage.getItem('ds_paper'));
      if (j && typeof j.cash === 'number') return { cash: j.cash, pos: j.pos || [] };
    } catch (e) {}
    return { cash: START_CASH, pos: [] };
  }
  function savePaper() { try { localStorage.setItem('ds_paper', JSON.stringify(paper)); } catch (e) {} }

  function fmt(n) { return (Math.round(n * 100) / 100).toLocaleString('en-IN'); }
  function fmt0(n) { return Math.round(n).toLocaleString('en-IN'); }
  function $(id) { return document.getElementById(id); }

  // visibility: sirf APK (non-localhost) + login ke baad
  function syncBtn() {
    const b = $('chainBtn');
    if (!b) return;
    const show = (typeof isLocalHost === 'function') && !isLocalHost() && typeof authed !== 'undefined' && authed && !(typeof paywallOn !== 'undefined' && paywallOn);
    b.style.display = show ? '' : 'none';
  }
  setInterval(syncBtn, 800);

  async function loadChain() {
    if (cLoading) return;
    cLoading = true;
    try {
      const held = paper.pos.filter(p => !cExpiry || p.expiry === cExpiry).map(p => p.strike);
      const u = '/api/chain/' + cSym + (cExpiry ? '?expiry=' + cExpiry : '') + (held.length ? (cExpiry ? '&' : '?') + 'strike=' + held.join(',') : '');
      const r = await fetch(u);
      const j = await r.json();
      if (j.error) { $('chainErr').textContent = j.error; cLoading = false; return; }
      $('chainErr').textContent = '';
      cData = j;
      if (!cExpiry && j.expiry) cExpiry = j.expiry;
      renderExpiries(j);
      renderHead(j);
      cSig = calcSignal(j);
      renderSigBanner();
      renderRows(j);
      markPositions();
      updatePosLtp(j);
      renderPositions();
      renderWallet();
      scrollToAtm(j);
    } catch (e) { $('chainErr').textContent = 'Network error'; }
    cLoading = false;
  }

  function renderExpiries(j) {
    const s = $('chainExp');
    if (!s || !j.expiries || !j.expiries.length) return;
    const cur = cExpiry || j.expiry;
    if (s.dataset.sig !== j.expiries.join(',') + cur) {
      s.innerHTML = j.expiries.map(e => '<option value="' + e + '"' + (e === cur ? ' selected' : '') + '>' + e + '</option>').join('');
      s.dataset.sig = j.expiries.join(',') + cur;
      s.onchange = () => { cExpiry = s.value; loadChain(); };
    }
  }

  function renderHead(j) {
    $('chainSpot').textContent = j.sym + ' ' + fmt(j.spot || 0);
    $('chainLot').textContent = 'LOT ' + j.lot;
    $('chainMkt').textContent = j.mktOpen ? 'LIVE' : 'CLOSED';
    $('chainMkt').className = 'ch-mkt ' + (j.mktOpen ? 'on' : 'off');
  }

  // ── auto signal: market hisab CE/PE + strike (engine analysis + OI) ──
  function nearestStrike(j) {
    const step = j.sym === 'NIFTY' ? 50 : 100;
    return Math.round((j.spot || 0) / step) * step;
  }

  function calcSignal(j) {
    if (!j || !j.spot || !j.rows || !j.rows.length) return null;
    let ceV = 0, peV = 0;
    const why = [];
    let a = null;
    try { a = (typeof lastA !== 'undefined') ? lastA : null; } catch (e) {}
    const sameSym = (typeof sym !== 'undefined') && sym === j.sym;
    let setupStrike = null;
    if (a && sameSym) {
      const s = a.activeSetup;
      if (s && (s.status === 'WAITING' || s.status === 'ENTRY_TRIGGERED')) {
        if (s.direction === 'BUY') ceV += 2; else peV += 2;
        why.push('SETUP ' + s.direction + ' ' + s.zoneTF + 'm');
        const step = j.sym === 'NIFTY' ? 50 : 100;
        setupStrike = Math.round((s.entry || 0) / step) * step;
      }
      let tv = 0;
      ['t1', 't3', 't5'].forEach(k => {
        const t = a[k];
        if (!t) return;
        if (t.trend === 'up') { ceV++; tv++; }
        else if (t.trend === 'down') { peV++; tv++; }
      });
      if (tv) why.push('TREND 1/3/5m');
    }
    const step = j.sym === 'NIFTY' ? 50 : 100;
    const atm = nearestStrike(j);
    const near = j.rows.filter(r => Math.abs(r.strike - atm) <= step * 4);
    let ceOI = 0, peOI = 0;
    near.forEach(r => { ceOI += (r.ce.oi || 0); peOI += (r.pe.oi || 0); });
    if (ceOI && peOI) {
      if (peOI > ceOI * 1.15) { ceV++; why.push('PUT WRITING > CALL'); }
      else if (ceOI > peOI * 1.15) { peV++; why.push('CALL WRITING > PUT'); }
    }
    if (!ceV && !peV) return { side: null, strike: atm, ceV: 0, peV: 0, why: ['NO BIAS'] };
    const side = ceV > peV ? 'CE' : peV > ceV ? 'PE' : null;
    if (!side) return { side: null, strike: atm, ceV: ceV, peV: peV, why: ['MIXED SIGNAL'] };
    let strike = atm;
    if (setupStrike && j.rows.some(r => r.strike === setupStrike)) strike = setupStrike;
    const conf = Math.abs(ceV - peV) >= 3 ? 'STRONG' : Math.abs(ceV - peV) === 2 ? 'GOOD' : 'WEAK';
    return { side: side, strike: strike, ceV: ceV, peV: peV, why: why, conf: conf };
  }

  function renderSigBanner() {
    const el = $('chainSig');
    if (!el) return;
    if (!cSig) { el.textContent = ''; el.className = 'ch-sig'; return; }
    const s = cSig;
    if (!s.side) {
      el.className = 'ch-sig none';
      el.innerHTML = '<b>— NO SIGNAL</b><span>' + s.why.join(' · ') + ' — wait karo</span>';
      return;
    }
    el.className = 'ch-sig ' + (s.side === 'CE' ? 'ce' : 'pe');
    el.innerHTML = '<b>' + (s.side === 'CE' ? '▲ BUY CE' : '▼ BUY PE') + ' ' + s.strike + '</b>' +
      '<span>' + s.why.join(' · ') + '</span>' +
      '<em>' + s.conf + ' · CE ' + s.ceV + ':' + s.peV + ' PE</em>';
  }

  function renderRows(j) {
    const box = $('chainRows');
    const sigK = (cSig && cSig.side) ? cSig.strike : null;
    let h = '<div class="ch-hd"><span>OI</span><span>CALL</span><span>STRIKE</span><span>PUT</span><span>OI</span></div>';
    for (const r of j.rows) {
      const atm = j.spot && Math.abs(r.strike - j.spot) <= (j.sym === 'NIFTY' ? 100 : 250);
      const sig = sigK === r.strike;
      h += '<div class="ch-row' + (atm ? ' atm' : '') + (sig ? ' sig' : '') + '" data-k="' + r.strike + '">' +
        '<span class="ch-oi">' + (r.ce.oi ? oiFmt(r.ce.oi) : '--') + '</span>' +
        '<span class="ch-px ce">' + (r.ce.ltp ? fmt(r.ce.ltp) : '--') + '</span>' +
        '<span class="ch-k">' + r.strike + (sig ? '<i class="ch-sigtag">' + (cSig.side === 'CE' ? '▲' : '▼') + '</i>' : '') + '</span>' +
        '<span class="ch-px pe">' + (r.pe.ltp ? fmt(r.pe.ltp) : '--') + '</span>' +
        '<span class="ch-oi">' + (r.pe.oi ? oiFmt(r.pe.oi) : '--') + '</span>' +
        '</div>' +
        '<div class="ch-btns" data-k="' + r.strike + '">' +
        '<button class="ch-b buy-ce' + (sig && cSig.side === 'CE' ? ' rec' : '') + '" ' + (r.ce.ltp ? '' : 'disabled') + '>' + (sig && cSig.side === 'CE' ? '★ ' : '') + 'BUY CE ' + (r.ce.ltp ? '₹' + fmt(r.ce.ltp) : '') + '</button>' +
        '<button class="ch-b buy-pe' + (sig && cSig.side === 'PE' ? ' rec' : '') + '" ' + (r.pe.ltp ? '' : 'disabled') + '>' + (sig && cSig.side === 'PE' ? '★ ' : '') + 'BUY PE ' + (r.pe.ltp ? '₹' + fmt(r.pe.ltp) : '') + '</button>' +
        '</div>';
    }
    box.innerHTML = h;
    box.querySelectorAll('.ch-b').forEach(btn => {
      btn.onclick = () => {
        const k = parseFloat(btn.parentNode.dataset.k);
        const side = btn.classList.contains('buy-ce') ? 'CE' : 'PE';
        openOrder(k, side);
      };
    });
  }

  function oiFmt(n) {
    if (n >= 10000000) return (n / 10000000).toFixed(1) + 'Cr';
    if (n >= 100000) return (n / 100000).toFixed(1) + 'L';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  let atmKey = null;
  function scrollToAtm(j) {
    if (!j.spot) return;
    const step = j.sym === 'NIFTY' ? 50 : 100;
    let key = Math.round(j.spot / step) * step;
    if (cSig && cSig.side && cSig.strike) key = cSig.strike;
    const el = document.querySelector('.ch-row[data-k="' + key + '"]');
    if (!el) return;
    const box = $('chainRows');
    const first = box.querySelector('.ch-row');
    if (!first) return;
    const target = el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2;
    const same = atmKey === key;
    atmKey = key;
    if (!same) box.scrollTop = Math.max(0, target);
  }

  // ── order sheet ──
  let ord = null;
  function openOrder(strike, side) {
    if (!cData) return;
    const r = cData.rows.find(x => x.strike === strike);
    if (!r) return;
    const px = side === 'CE' ? r.ce.ltp : r.pe.ltp;
    if (!px) return;
    ord = { strike, side, px, lots: 1 };
    $('ordTitle').textContent = cSym + ' ' + strike + ' ' + side;
    $('ordPx').textContent = '₹' + fmt(px);
    $('ordLots').value = 1;
    updOrder();
    $('orderSheet').style.display = 'flex';
    $('chainBack').style.display = 'block';
  }
  function updOrder() {
    if (!ord) return;
    const lots = Math.max(1, parseInt($('ordLots').value) || 1);
    ord.lots = lots;
    const qty = lots * (cData ? cData.lot : 1);
    const cost = ord.px * qty;
    $('ordQty').textContent = qty + ' qty (' + lots + ' lot)';
    $('ordCost').textContent = '₹' + fmt(cost);
    $('ordCash').textContent = '₹' + fmt(paper.cash);
    const ok = cost <= paper.cash;
    $('ordOk').disabled = !ok;
    $('ordOk').textContent = ok ? 'CONFIRM BUY' : 'INSUFFICIENT CASH';
    $('ordNote').textContent = ok ? '' : 'Demo cash kam hai — RESET karo';
  }
  function closeOrder() { ord = null; $('orderSheet').style.display = 'none'; $('chainBack').style.display = 'none'; }

  function confirmOrder() {
    if (!ord || !cData) return;
    const qty = ord.lots * cData.lot;
    const cost = ord.px * qty;
    if (cost > paper.cash) return;
    paper.cash -= cost;
    paper.pos.push({
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      sym: cSym, expiry: cExpiry, strike: ord.strike, side: ord.side,
      lots: ord.lots, qty, entry: ord.px, ltp: ord.px, entryTs: Date.now()
    });
    savePaper();
    closeOrder();
    markPositions();
    renderPositions();
    renderWallet();
  }

  // ── positions ──
  function updatePosLtp(j) {
    for (const p of paper.pos) {
      if (p.sym !== j.sym || (cExpiry && p.expiry && p.expiry !== cExpiry)) continue;
      const r = j.rows.find(x => x.strike === p.strike);
      if (!r) continue;
      const px = p.side === 'CE' ? r.ce.ltp : r.pe.ltp;
      if (px) p.ltp = px;
    }
    savePaper();
  }

  function posPnl(p) { return (p.ltp - p.entry) * p.qty; }

  function renderPositions() {
    const box = $('chainPos');
    const totEl = $('chainPnl');
    if (!paper.pos.length) {
      box.innerHTML = '<div class="ch-none">Koi position nahi — BUY CE / BUY PE dabao</div>';
      totEl.textContent = '₹0';
      totEl.className = 'ch-pnl-v';
      return;
    }
    let tot = 0, h = '';
    for (const p of paper.pos) {
      const pnl = posPnl(p);
      tot += pnl;
      h += '<div class="ch-pos" data-id="' + p.id + '">' +
        '<div class="ch-pos-l"><b>' + p.sym + ' ' + p.strike + ' ' + p.side + '</b>' +
        '<span>' + p.qty + ' qty · IN ₹' + fmt(p.entry) + ' · LTP ₹' + fmt(p.ltp) + '</span></div>' +
        '<div class="ch-pos-r ' + (pnl >= 0 ? 'up' : 'dn') + '">' +
        '<b>' + (pnl >= 0 ? '+' : '') + '₹' + fmt(pnl) + '</b>' +
        '<button class="ch-exit">EXIT</button></div></div>';
    }
    box.innerHTML = h;
    totEl.textContent = (tot >= 0 ? '+' : '') + '₹' + fmt(tot);
    totEl.className = 'ch-pnl-v ' + (tot >= 0 ? 'up' : 'dn');
    box.querySelectorAll('.ch-exit').forEach(b => {
      b.onclick = () => exitPos(b.closest('.ch-pos').dataset.id);
    });
  }

  function exitPos(id) {
    const i = paper.pos.findIndex(p => p.id === id);
    if (i < 0) return;
    const p = paper.pos[i];
    paper.cash += p.ltp * p.qty;
    paper.pos.splice(i, 1);
    savePaper();
    renderPositions();
    renderWallet();
    markPositions();
  }

  function markPositions() {
    document.querySelectorAll('.ch-row').forEach(r => r.classList.remove('mine'));
    for (const p of paper.pos) {
      if (p.sym !== cSym || (cExpiry && p.expiry && p.expiry !== cExpiry)) continue;
      const el = document.querySelector('.ch-row[data-k="' + p.strike + '"]');
      if (el) el.classList.add('mine');
    }
  }

  function renderWallet() {
    $('chainCash').textContent = '₹' + fmt(paper.cash);
    $('chainCnt').textContent = paper.pos.length + ' POS';
  }

  function resetWallet() {
    if (!confirm('Demo wallet reset karke ₹1,00,000 mil jayega?')) return;
    paper = { cash: START_CASH, pos: [] };
    savePaper();
    renderWallet(); renderPositions(); markPositions();
  }

  // ── open / close ──
  function openChain() {
    $('chainScreen').style.display = 'flex';
    cExpiry = cExpiry || '';
    loadChain();
    if (cTimer) clearInterval(cTimer);
    cTimer = setInterval(loadChain, 5000);
  }
  function closeChain() {
    $('chainScreen').style.display = 'none';
    if (cTimer) { clearInterval(cTimer); cTimer = null; }
    closeOrder();
  }

  document.addEventListener('DOMContentLoaded', () => {
    syncBtn();
    const cb = $('chainBtn'); if (cb) cb.onclick = openChain;
    const cx = $('chainClose'); if (cx) cx.onclick = closeChain;
    const cbk = $('chainBack'); if (cbk) cbk.onclick = closeOrder;
    const ok = $('ordOk'); if (ok) ok.onclick = confirmOrder;
    const cc = $('ordCancel'); if (cc) cc.onclick = closeOrder;
    const rl = $('ordLots'); if (rl) rl.oninput = updOrder;
    const rr = $('chainReset'); if (rr) rr.onclick = resetWallet;
    document.querySelectorAll('.ch-sym').forEach(b => {
      b.onclick = () => {
        document.querySelectorAll('.ch-sym').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        cSym = b.dataset.sym;
        cExpiry = '';
        $('chainExp').dataset.sig = '';
        loadChain();
      };
    });
    // bahar touch karke band
    const sc = $('chainScreen');
    if (sc) sc.addEventListener('click', e => { if (e.target === sc) closeChain(); });
  });
})();
