/* ─── DS Zone — Live Option Chain + Paper Trading (APK only) ─── */
(function () {
  const START_CASH = 2000000;
  let cSym = 'NIFTY', cExpiry = '', cData = null, cTimer = null, cLoading = false;
  let cSig = null;
  let paper = loadPaper();

  function loadPaper() {
    try {
      const j = JSON.parse(localStorage.getItem('ds_paper'));
      if (j && typeof j.cash === 'number') {
        let start = (typeof j.start === 'number' && j.start > 0) ? j.start : 100000;
        if (start < START_CASH) {
          // purana wallet (1L/12L) → 20L: P&L preserve, sirf capital 20 lakh
          j.cash = Math.max(0, START_CASH + (j.cash - start));
          start = START_CASH;
        }
        return { cash: j.cash, pos: j.pos || [], trades: j.trades || [], start: start };
      }
    } catch (e) {}
    return { cash: START_CASH, pos: [], trades: [], start: START_CASH };
  }
  function savePaper() { try { localStorage.setItem('ds_paper', JSON.stringify(paper)); } catch (e) {} }

  // ── real market jaisa charges (NSE options): brokerage + STT + exch + SEBI + stamp + GST ──
  function calcCharges(buyVal, sellVal) {
    buyVal = buyVal || 0; sellVal = sellVal || 0;
    const turn = buyVal + sellVal;
    const brokerage = turn * 0.0003;
    const stt = sellVal * 0.001;
    const exch = turn * 0.0000297;
    const sebi = turn * 0.000001;
    const stamp = buyVal * 0.00003;
    const gst = (brokerage + exch + sebi) * 0.18;
    return { brokerage: brokerage, stt: stt, exch: exch, sebi: sebi, stamp: stamp, gst: gst, total: brokerage + stt + exch + sebi + stamp + gst };
  }

  function openInvested() {
    let s = 0;
    for (const p of paper.pos) s += p.entry * p.qty + (p.chg || 0);
    return s;
  }

  function fmt(n) { return (Math.round(n * 100) / 100).toLocaleString('en-IN'); }
  function fmt0(n) { return Math.round(n).toLocaleString('en-IN'); }
  function $(id) { return document.getElementById(id); }

  // visibility: localhost par bhi (dev/demo) + APK me (non-localhost) login ke baad
  function syncBtn() {
    const b = $('chainBtn');
    if (!b) return;
    const local = (typeof isLocalHost === 'function') && isLocalHost();
    const apkAuthed = !local && typeof authed !== 'undefined' && authed && !(typeof paywallOn !== 'undefined' && paywallOn);
    b.style.display = (local || apkAuthed) ? '' : 'none';
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
      renderTrades();
      renderNet();
      renderWallet();
      loadAutoBot();
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
    let zone = null;                                   // active zone: entry/SL/TARGET (loss/profit plan ke liye)
    if (a && sameSym) {
      const s = a.activeSetup;
      if (s && (s.status === 'WAITING' || s.status === 'ARMED' || s.status === 'ENTRY_TRIGGERED')) {
        if (s.direction === 'BUY') ceV += 2; else peV += 2;
        why.push('SETUP ' + s.direction + ' ' + (/m$/.test(String(s.zoneTF)) ? s.zoneTF : s.zoneTF + 'm'));
        const step = j.sym === 'NIFTY' ? 50 : 100;
        setupStrike = Math.round((s.entry || 0) / step) * step;
        if (s.entry && s.stopLoss && s.target) zone = { entry: s.entry, sl: s.stopLoss, tgt: s.target, dir: s.direction || 'BUY' };
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
    const rws = j.rows.find(x => x.strike === strike);
    const buyPx = rws ? (side === 'CE' ? rws.ce.ltp : rws.pe.ltp) : 0;
    return { side: side, strike: strike, ceV: ceV, peV: peV, why: why, conf: conf, zone: zone, buyPx: buyPx || 0 };
  }

  // ── LOTS + LOSS + PROFIT plan — kitne lot, SL par kitna katga, target par kitna milega ──
  // zone points → ₹ (1:1 spot move approx) — premium actual delta se kam/badh sakta hai (label: approx)
  function lotPlan(side, px) {
    const lot = cData && cData.lot ? cData.lot : 65;
    const cost = (px || 0) * lot;
    const chg = calcCharges(cost, 0).total;
    const z = (cSig && cSig.zone && cSig.side === side && px) ? cSig.zone : null;
    let riskPts = 0, rewardPts = 0;
    if (z) {
      const buy = z.dir === 'BUY';
      riskPts = Math.max(0, Math.round(buy ? (z.entry - z.sl) : (z.sl - z.entry)));
      rewardPts = Math.max(0, Math.round(buy ? (z.tgt - z.entry) : (z.entry - z.tgt)));
    }
    const perLotRisk = riskPts * lot;                 // 1 lot ka approx loss (SL hit par)
    const perLotReward = rewardPts * lot;             // 1 lot ka approx profit (target par)
    const budget = Math.round((paper.start || 2000000) * 0.01);   // 1% risk budget (20L → ₹20,000)
    let sug = 1;
    if (perLotRisk > 0) sug = Math.max(1, Math.floor(budget / perLotRisk));
    const unit = cost + chg;
    const afford = unit > 0 ? Math.floor(paper.cash / unit) : 1;
    sug = Math.max(1, Math.min(sug, afford, 20));
    return { lot: lot, cost: cost, chg: chg, sug: sug, budget: budget, hasZone: !!z, riskPts: riskPts, rewardPts: rewardPts, perLotRisk: perLotRisk, perLotReward: perLotReward };
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
    const plan = lotPlan(s.side, s.buyPx || 0);
    const planLine = s.buyPx
      ? '<span class="ch-plan">LOTS: ' + plan.sug + ' · 1 lot cost ₹' + fmt(plan.cost) +
        (plan.hasZone
          ? ' · SL par LOSS −₹' + fmt(plan.perLotRisk) + ' (' + plan.riskPts + 'pt) · TARGET par PROFIT +₹' + fmt(plan.perLotReward) + ' (' + plan.rewardPts + 'pt) · RR 1:' + (plan.riskPts ? (plan.rewardPts / plan.riskPts).toFixed(1) : '--')
          : ' · SL/TARGET zone abhi nahi — max loss = premium ₹' + fmt(plan.cost)) +
        ' (approx) · 1 lot se shuru</span>'
      : '';
    el.innerHTML = '<b>' + (s.side === 'CE' ? '▲ BUY CE' : '▼ BUY PE') + ' ' + s.strike + '</b>' +
      '<span>' + s.why.join(' · ') + '</span>' +
      '<em>' + s.conf + ' · CE ' + s.ceV + ':' + s.peV + ' PE</em>' +
      planLine;
  }

  function renderRows(j) {
    const box = $('chainRows');
    const sigK = (cSig && cSig.side) ? cSig.strike : null;
    let h = '<div class="ch-hd"><span>OI</span><span>CALL</span><span>STRIKE</span><span>PUT</span><span>OI</span></div>';
    for (const r of j.rows) {
      const atm = j.spot && Math.abs(r.strike - j.spot) <= (j.sym === 'NIFTY' ? 100 : 250);
      const sig = sigK === r.strike;
      const buySide = sig ? cSig.side : null;              // bot jis side (CE/PE) kharidega
      h += '<div class="ch-row' + (atm ? ' atm' : '') + (sig ? ' sig' : '') + '" data-k="' + r.strike + '">' +
        '<span class="ch-oi">' + (r.ce.oi ? oiFmt(r.ce.oi) : '--') + '</span>' +
        '<span class="ch-px ce' + (buySide === 'CE' ? ' buy' : '') + '">' + (r.ce.ltp ? fmt(r.ce.ltp) : '--') + '</span>' +
        '<span class="ch-k">' + r.strike + (sig ? '<i class="ch-sigtag">' + (cSig.side === 'CE' ? '▲' : '▼') + '</i>' : '') + '</span>' +
        '<span class="ch-px pe' + (buySide === 'PE' ? ' buy' : '') + '">' + (r.pe.ltp ? fmt(r.pe.ltp) : '--') + '</span>' +
        '<span class="ch-oi">' + (r.pe.oi ? oiFmt(r.pe.oi) : '--') + '</span>' +
        '</div>' +
        '<div class="ch-btns" data-k="' + r.strike + '">' +
        '<button class="ch-b buy-ce' + (sig && cSig.side === 'CE' ? ' rec' : '') + '" ' + (r.ce.ltp ? '' : 'disabled') + '>' + (sig && cSig.side === 'CE' ? '★ ' : '') + 'BUY CE ' + (r.ce.ltp ? '₹' + fmt(r.ce.ltp) : '') + '</button>' +
        '<button class="ch-b buy-pe' + (sig && cSig.side === 'PE' ? ' rec' : '') + '" ' + (r.pe.ltp ? '' : 'disabled') + '>' + (sig && cSig.side === 'PE' ? '★ ' : '') + 'BUY PE ' + (r.pe.ltp ? '₹' + fmt(r.pe.ltp) : '') + '</button>' +
        '</div>';
      // bot ke buy price ke NEECHE line — jahan 1-lot auto ENTRY hogi (3m+5m zone par)
      if (sig) {
        const bpx = cSig.side === 'CE' ? r.ce.ltp : r.pe.ltp;
        const pl = lotPlan(cSig.side, bpx || 0);
        h += '<div class="ch-botline ' + (cSig.side === 'CE' ? 'ce' : 'pe') + '">━ AUTO ' + cSig.side +
          ' BUY LINE @ ₹' + (bpx ? fmt(bpx) : '--') + ' · ' + pl.sug + ' lot' +
          (pl.hasZone
            ? ' · SL LOSS −₹' + fmt(pl.perLotRisk) + ' · TARGET PROFIT +₹' + fmt(pl.perLotReward) + ' (approx)'
            : ' · cost ₹' + fmt(pl.cost)) +
          ' · bot isi price par kharidga ━</div>';
      }
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
    const sugL = lotPlan(side, px).sug;              // suggest lots (1% risk rule) — user dekh lega
    $('ordLots').value = sugL;
    ord.lots = sugL;
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
    const chg = calcCharges(cost, 0).total;
    $('ordQty').textContent = qty + ' qty (' + lots + ' lot)';
    $('ordCost').textContent = '₹' + fmt(cost);
    if ($('ordChg')) $('ordChg').textContent = '₹' + fmt(chg);
    if ($('ordTotal')) $('ordTotal').textContent = '₹' + fmt(cost + chg);
    $('ordCash').textContent = '₹' + fmt(paper.cash);
    // ── kitne lot (suggest) + kitna loss (SL) + kitna profit (target) + RR ──
    const plan = lotPlan(ord.side, ord.px);
    if ($('ordSug')) $('ordSug').textContent = plan.sug + ' lot' + (plan.hasZone ? ' (1% risk ₹' + fmt(plan.budget) + ')' : '');
    if ($('ordLoss')) $('ordLoss').textContent = plan.hasZone
      ? '−₹' + fmt(plan.perLotRisk * lots) + ' · ' + plan.riskPts + 'pt SL'
      : '≈ ₹' + fmt(cost) + ' (premium)';
    if ($('ordWin')) $('ordWin').textContent = plan.hasZone
      ? '+₹' + fmt(plan.perLotReward * lots) + ' · ' + plan.rewardPts + 'pt TGT'
      : 'zone nahi — target nahi';
    if ($('ordRR')) $('ordRR').textContent = plan.hasZone && plan.riskPts ? '1:' + (plan.rewardPts / plan.riskPts).toFixed(1) : '--';
    const ok = (cost + chg) <= paper.cash;
    $('ordOk').disabled = !ok;
    $('ordOk').textContent = ok ? 'CONFIRM BUY' : 'INSUFFICIENT CASH';
    $('ordNote').textContent = ok
      ? 'Buy charge ₹' + fmt(chg) + ' + exit par aur lagega (brokerage, STT, GST)'
      : 'Demo cash kam hai — RESET karo';
  }
  function closeOrder() { ord = null; $('orderSheet').style.display = 'none'; $('chainBack').style.display = 'none'; }

  function confirmOrder() {
    if (!ord || !cData) return;
    const qty = ord.lots * cData.lot;
    const cost = ord.px * qty;
    const chg = calcCharges(cost, 0).total;
    if (cost + chg > paper.cash) return;
    paper.cash -= (cost + chg);
    paper.pos.push({
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      sym: cSym, expiry: cExpiry, strike: ord.strike, side: ord.side,
      lots: ord.lots, qty, entry: ord.px, ltp: ord.px, chg: chg, entryTs: Date.now()
    });
    savePaper();
    reportAuto('ENTRY', { tf: 'manual', dir: '', sym: cSym, strike: ord.strike, side: ord.side, entry: ord.px, qty: qty, lots: ord.lots });
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

  function exitPos(id, reason) {
    const i = paper.pos.findIndex(p => p.id === id);
    if (i < 0) return;
    const p = paper.pos[i];
    const sellChg = calcCharges(0, p.ltp * p.qty).total;
    const net = p.ltp * p.qty - sellChg;
    paper.cash += net;
    paper.pos.splice(i, 1);
    paper.trades = paper.trades || [];
    paper.trades.unshift({
      sym: p.sym, strike: p.strike, side: p.side, lots: p.lots, qty: p.qty,
      entry: p.entry, exit: p.ltp, chg: (p.chg || 0) + sellChg,
      pnl: (p.ltp - p.entry) * p.qty - ((p.chg || 0) + sellChg),
      entryTs: p.entryTs, exitTs: Date.now(), reason: reason || (p.auto ? 'AUTO' : '')
    });
    if (paper.trades.length > 100) paper.trades.length = 100;
    savePaper();
    // har EXIT (auto + manual) → AI agent ko bridge (chain detail ke liye)
    reportAuto('EXIT', {
      tf: (p.setupKey || '').split('|')[0] || 'manual', dir: '', sym: p.sym, strike: p.strike, side: p.side,
      entry: p.entry, exit: p.ltp, pnl: (p.ltp - p.entry) * p.qty - ((p.chg || 0) + sellChg),
      reason: reason || (p.auto ? 'AUTO' : 'MANUAL')
    });
    renderPositions();
    renderTrades();
    renderNet();
    renderWallet();
    markPositions();
  }

  function timeAgo(ts) {
    const d = new Date(ts), now = new Date();
    const hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    if (d.toDateString() === now.toDateString()) return hm;
    return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + ' ' + hm;
  }

  function renderTrades() {
    const box = $('chainTrades');
    if (!box) return;
    const t = paper.trades || [];
    const cnt = $('chainTradesCnt');
    if (cnt) cnt.textContent = t.length ? '(' + t.length + ')' : '';
    if (!t.length) {
      box.innerHTML = '<div class="ch-none">Abhi koi trade close nahi — EXIT dabao, yahan profit/loss dikhega</div>';
      return;
    }
    let wins = 0, losses = 0, tot = 0, prof = 0, lossSum = 0, chgTot = 0, h = '';
    for (const x of t) {
      if (x.pnl >= 0) { wins++; prof += x.pnl; } else { losses++; lossSum += -x.pnl; }
      tot += x.pnl;
      chgTot += (x.chg || 0);
      const win = x.pnl >= 0;
      h += '<div class="ch-tr">' +
        '<div class="ch-pos-l"><b>' + x.sym + ' ' + x.strike + ' ' + x.side + '</b>' +
        '<span>' + x.qty + ' qty · IN ₹' + fmt(x.entry) + ' → OUT ₹' + fmt(x.exit) + ' · ' + timeAgo(x.exitTs) + '</span>' +
        (x.reason ? '<span class="ch-chg">' + x.reason + '</span>' : '') +
        (x.chg ? '<span class="ch-chg">Charges ₹' + fmt(x.chg) + ' (brokerage+STT+GST)</span>' : '') + '</div>' +
        '<div class="ch-pos-r ' + (win ? 'up' : 'dn') + '">' +
        '<b>' + (win ? '+' : '-') + '₹' + fmt(Math.abs(x.pnl)) + '</b>' +
        '<em class="ch-tag ' + (win ? 'win' : 'loss') + '">' + (win ? 'PROFIT' : 'LOSS') + '</em></div></div>';
    }
    const start = paper.start || START_CASH;
    h = '<div class="ch-tr-sum">' +
      '<div class="ch-tr-calc ' + (tot >= 0 ? 'up' : 'dn') + '">' +
      '<span class="cc-i">START <b>₹' + fmt(start) + '</b></span>' +
      '<span class="cc-op">+</span><span class="cc-i up">PROFIT <b>₹' + fmt(prof) + '</b></span>' +
      '<span class="cc-op">−</span><span class="cc-i dn">LOSS <b>₹' + fmt(lossSum) + '</b></span>' +
      '<span class="cc-op">=</span><span class="cc-i">DEMO <b>₹' + fmt(paper.cash) + '</b></span>' +
      '</div>' +
      '<div class="ch-tr-line ' + (tot >= 0 ? 'up' : 'dn') + '">' +
      wins + ' WIN ✅ / ' + losses + ' LOSS ❌ · TOTAL ' + (tot >= 0 ? '+' : '-') + '₹' + fmt(Math.abs(tot)) +
      (chgTot ? ' · CHARGES ₹' + fmt(chgTot) : '') + '</div>' +
      '</div>' + h;
    box.innerHTML = h;
  }

  // wallet snapshot → AI agent (chain detail: cash/open/net P&L) — 60s throttle
  let lastSyncAt = 0;
  function syncWallet() {
    const now = Date.now();
    if (now - lastSyncAt < 60000) return;
    lastSyncAt = now;
    const t = paper.trades || [];
    let closedNet = 0;
    for (const x of t) closedNet += x.pnl;
    let openPnl = 0;
    for (const p of paper.pos) openPnl += posPnl(p);
    reportAuto('SYNC', {
      cash: Math.round(paper.cash), closedNet: Math.round((closedNet + openPnl) * 100) / 100,
      netPnl: Math.round((closedNet + openPnl) * 100) / 100, open: paper.pos.length, tradesN: t.length
    });
  }

  function renderNet() {
    const el = $('chainNet');
    if (!el) return;
    const t = paper.trades || [];
    let tot = 0, wins = 0, losses = 0;
    for (const x of t) { tot += x.pnl; if (x.pnl >= 0) wins++; else losses++; }
    el.textContent = t.length ? (tot >= 0 ? '+' : '-') + '₹' + fmt(Math.abs(tot)) + ' · ' + wins + 'W/' + losses + 'L' : '₹0';
    el.className = 'ch-pnl-v ' + (tot >= 0 ? 'up' : 'dn');
    syncWallet();
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
    if (!confirm('Demo wallet reset karke ₹20,00,000 mil jayega? Trade history bhi delete hogi.')) return;
    paper = { cash: START_CASH, pos: [], trades: [], start: START_CASH };
    savePaper();
    renderWallet(); renderPositions(); renderTrades(); renderNet(); markPositions();
  }

  // ── AUTO PAPER TRADING — 3m ke har zone: entry par auto ENTRY, SL/Target par auto EXIT, 1 lot ──
  let autoSeen = {};
  try { autoSeen = JSON.parse(localStorage.getItem('ds_auto_seen') || '{}') || {}; } catch (e) { autoSeen = {}; }
  function saveAutoSeen() {
    const ks = Object.keys(autoSeen);
    if (ks.length > 300) {
      ks.sort((a, b) => autoSeen[b] - autoSeen[a]);
      const t = {}; ks.slice(0, 300).forEach(k => { t[k] = autoSeen[k]; }); autoSeen = t;
    }
    try { localStorage.setItem('ds_auto_seen', JSON.stringify(autoSeen)); } catch (e) {}
  }
  function autoKey(s) { return s.zoneTF + '|' + s.zoneTime + '|' + Math.round((s.entry || 0) * 10) / 10; }

  // auto ENTRY/EXIT events → server AI agent ko (status + chat me 3m autotrade dikhe)
  function reportAuto(kind, data) {
    try {
      fetch('/api/agent/autotrade', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ src: 'chain', kind: kind }, data))
      }).catch(function () {});
    } catch (e) {}
  }

  async function fetchChain(symKey) {
    try {
      const r = await fetch('/api/chain/' + symKey);
      const j = await r.json();
      if (j && !j.error) return j;
    } catch (e) {}
    return null;
  }

  async function autoEnter(s) {
    const key = autoKey(s);
    if (autoSeen[key]) return;
    autoSeen[key] = Date.now(); saveAutoSeen();          // ek zone par sirf ek entry
    const fail = () => { delete autoSeen[key]; saveAutoSeen(); };
    const symKey = (typeof sym !== 'undefined' && sym) ? sym : cSym;
    const j = await fetchChain(symKey);
    if (!j || !j.mktOpen || !j.rows || !j.rows.length) return fail();
    const step = symKey === 'NIFTY' ? 50 : 100;
    const strike = Math.round((s.entry || 0) / step) * step;
    const row = j.rows.find(x => x.strike === strike);
    if (!row) return fail();
    const side = s.direction === 'BUY' ? 'CE' : 'PE';     // BUY zone → CE, SELL zone → PE
    const px = side === 'CE' ? row.ce.ltp : row.pe.ltp;
    if (!px) return fail();
    const lots = 1;                                        // har entry 1 lot
    const qty = lots * (j.lot || 1);
    const cost = px * qty;
    const chg = calcCharges(cost, 0).total;
    if (cost + chg > paper.cash) return fail();
    paper.cash -= (cost + chg);
    paper.pos.push({
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      sym: symKey, expiry: j.expiry || '', strike, side, lots, qty,
      entry: px, ltp: px, chg, entryTs: Date.now(), auto: true, setupKey: key
    });
    savePaper();
    reportAuto('ENTRY', { tf: s.zoneTF || '3m', dir: s.direction || '', sym: symKey, strike, side, entry: px, qty });
    markPositions(); renderPositions(); renderTrades(); renderNet(); renderWallet();
  }

  async function autoExit(t) {
    const key = autoKey(t);
    const p = paper.pos.find(x => x.setupKey === key);
    if (!p) return;
    const j = await fetchChain(p.sym);
    if (j && j.rows) {
      const r = j.rows.find(x => x.strike === p.strike);
      const px = p.side === 'CE' ? (r && r.ce.ltp) : (r && r.pe.ltp);
      if (px) p.ltp = px;
    }
    const reason = t.hitStatus === 'TARGET_HIT' ? 'AUTO · TARGET'
      : t.hitStatus === 'STOP_LOSS_HIT' ? 'AUTO · STOP LOSS'
      : t.hitStatus === 'SQUARE_OFF' ? 'AUTO · 15:15 SQUARE OFF'
      : 'AUTO · ZONE OUT';
    exitPos(p.id, reason);
  }

  // app.js har analysis update par ye call karta hai
  window.dsAutoTrade = function (a) {
    try {
      if (!a) return;
      const atf = a.allTF || {};
      for (const tf of ['3m', '5m']) {
        const s = atf[tf] && atf[tf].activeSetup;
        if (s && s.zoneTF === tf && s.status === 'ENTRY_TRIGGERED') autoEnter(s);
        const comp = a.completedByTF && a.completedByTF[tf];
        if (comp) {
          for (const t of comp.slice(-8)) {
            if (!t || t.zoneTF !== tf || !t.zoneTime) continue;
            if (paper.pos.some(x => x.setupKey === autoKey(t))) autoExit(t);
          }
        }
      }
    } catch (e) {}
  };

  // ── AUTO BOT (server 24/7) status — chain screen par ──
  async function loadAutoBot() {
    try {
      const r = await fetch('/api/autopaper');
      const j = await r.json();
      renderAutoBot(j);
    } catch (e) {}
  }

  function renderAutoBot(j) {
    const el = $('chainAuto');
    if (!el || !j || !j.sym) return;
    const trades = j.trades || [];
    let tot = 0, wins = 0, losses = 0;
    for (const t of trades) { tot += t.pnl; if (t.pnl >= 0) wins++; else losses++; }
    const open = (j.pos || []).length;
    let h = '<div class="ab-hd"><b>AUTO BOT · SERVER 24/7</b>' +
      '<span class="ab-mk ' + (j.mktOpen ? 'on' : 'off') + '">' + (j.mktOpen ? 'LIVE' : 'CLOSED') + '</span>' +
      '<span>' + j.sym + ' · ' + j.tf + ' · 1 LOT</span>' +
      (j.lastError ? '<span class="ab-err">' + j.lastError + '</span>' : '') + '</div>';
    h += '<div class="ab-row">DEMO <b>₹' + fmt(j.cash) + '</b> · OPEN <b>' + open + '</b> · TODAY <b>' + (j.entriesToday || 0) + '</b>' +
      ' · NET <b class="' + (j.netPnl >= 0 ? 'up' : 'dn') + '">' + (j.netPnl >= 0 ? '+' : '-') + '₹' + fmt(Math.abs(j.netPnl || 0)) + '</b>' +
      ' · ' + (j.wins || 0) + 'W/' + (j.losses || 0) + 'L</div>';
    const acts = (j.actives && j.actives.length ? j.actives : (j.active ? [{ tf: j.active.zoneTF, setup: j.active }] : []));
    for (const a2 of acts) {
      const s = a2.setup;
      if (s && s.entry != null) {
        const ztf = String(s.zoneTF || a2.tf || '');
        h += '<div class="ab-row ab-act">' + (s.direction || '') + ' ' + (/[mDWM]$/.test(ztf) ? ztf : ztf + 'm') + ' · E ₹' + fmt(s.entry) +
          ' · SL ₹' + fmt(s.stopLoss) + ' · T ₹' + fmt(s.target) + ' · ' + (s.status || '') + '</div>';
      }
    }
    for (const t of trades.slice(0, 5)) {
      h += '<div class="ab-tr ' + (t.pnl >= 0 ? 'up' : 'dn') + '">' +
        '<b>' + (t.pnl >= 0 ? '+' : '-') + '₹' + fmt(Math.abs(t.pnl)) + '</b>' +
        '<span>' + t.strike + ' ' + t.side + (t.tf ? ' · ' + t.tf : '') + ' · ' + t.qty + ' qty · ₹' + fmt(t.entry) + ' → ₹' + fmt(t.exit) + '</span>' +
        '<em>' + (t.reason || 'AUTO') + '</em></div>';
    }
    // ── AI AGENT: SL reason + auto-fix status ──
    const ag = j.agent;
    if (ag && ag.params) {
      const P = ag.params, S = ag.stats || {};
      const cool = ag.cooldownLeftMs > 0 ? ' · PAUSE ' + Math.ceil(ag.cooldownLeftMs / 60000) + 'm' : '';
      h += '<div class="ab-row ab-act">AI AGENT · ' + (S.targets || 0) + 'T / ' + (S.sls || 0) + 'SL' +
        ' · win ' + (S.winRate || 0) + '%' + (S.whipsaw ? ' · ' + S.whipsaw + ' whipsaw' : '') + cool + '</div>';
      h += '<div class="ab-row">SL FIX: buffer ' + Math.round((P.slBufAtr || 0) * 100) + '% ATR · target ×' + P.tgtMult +
        ' · score ≥' + P.minScore + (P.trendAlign ? ' · trend-ON' : '') + (P.freshOnly ? ' · fresh-ON' : '') +
        (P.allowStale === false ? ' · stale-OFF' : '') +
        ' · <b>STRATEGY VERSION ' + (ag.version || 'v1.0') + '</b></div>';
      if (ag.caution && ag.caution.on) {
        h += '<div class="ab-row ab-act">⚠ CAUTION MODE: ' + String(ag.caution.reason || '') + ' — ' + String(ag.caution.investigate || '').slice(0, 140) + '</div>';
      }
      if (ag.validation) {
        h += '<div class="ab-row">VALIDATION: ' + (ag.validation.key || '?') + ' = <b>' + (ag.validation.status || '?') + '</b>' +
          (ag.validation.why ? ' — ' + String(ag.validation.why).slice(0, 130) : '') + '</div>';
      }
      const AI = ag.ai || {};
      if (AI.enabled) {
        h += '<div class="ab-row ab-act">GEMINI AI DOCTOR: ON' + (AI.calls ? ' — ' + AI.calls + ' calls' : '') + '</div>';
        if (AI.last && AI.last.reason) {
          h += '<div class="ab-tr"><b>AI-DIAG</b><span>' + String(AI.last.reason).slice(0, 150) +
            (AI.last.fix && AI.last.fix.length ? ' — ' + AI.last.fix.join(', ') : '') + '</span></div>';
        }
      }
      // requirement #9: LIVE MARKET ANALYSIS panel (real data — snap)
      const SN = ag.snap;
      if (SN && SN.dataOk) {
        h += '<div class="ab-row ab-act">LIVE MARKET ANALYSIS</div>';
        h += '<div class="ab-row">Trend: 1m ' + ((SN.trends && SN.trends['1m']) || '—') + ' · 5m ' + ((SN.trends && SN.trends['5m']) || '—') +
          ' · 15m ' + ((SN.trends && SN.trends['15m']) || '—') + '</div>';
        h += '<div class="ab-row">Market Structure: ' + ((SN.structure && SN.structure['5m']) || '—') +
          (SN.structure && SN.structure['15m'] ? ' · 15m ' + SN.structure['15m'] : '') + '</div>';
        h += '<div class="ab-row">Market Condition: ' + (SN.condition || '—') + ' · ATR vol ×' + ((SN.atrVol && SN.atrVol['5m']) || 1) + '</div>';
        // requirement #17: engine facts — HTF location / ITF trend (50SMA) / LTF / Curve
        const EN = ag.engine;
        if (EN) {
          const crv = EN.curve;
          h += '<div class="ab-row">HTF: 15m ' + (EN.trends && EN.trends['15m'] || '—') + ' · 30m ' + (EN.trends && EN.trends['30m'] || '—') +
            ' · ITF(50SMA 5m): ' + (EN.sma50 && EN.sma50['5m'] != null ? '₹' + fmt(EN.sma50['5m']) + ' (' + (EN.trends && EN.trends['5m'] || '—') + ')' : (EN.trends && EN.trends['5m'] || '—')) + '</div>';
          h += '<div class="ab-row">Curve: ' + (crv && crv.pos && crv.pos !== 'N/A' ? crv.pos + (crv.pct != null ? ' (' + crv.pct + '%)' : '') : '—') +
            ' · Regime: ' + (EN.regime || '—') + (EN.price ? ' · LTP ₹' + fmt(EN.price) : '') + '</div>';
        }
        const z0 = acts[0] && acts[0].setup;
        if (z0 && z0.entry != null) {
          h += '<div class="ab-row">Active Zone: ' + z0.zoneTF + ' ' + z0.direction + ' · E ₹' + fmt(z0.entry) +
            ' · SL ₹' + fmt(z0.stopLoss) + ' · T ₹' + fmt(z0.target) +
            ' · Zone Strength: score ' + z0.zoneScore + ' (' + (z0.zoneFreshness || '') + ')</div>';
        } else {
          h += '<div class="ab-row">Active Zone: koi nahi (scan chalu)</div>';
        }
        h += '<div class="ab-row">Current Risk: ' +
          (S.consecSL ? 'lagatar ' + S.consecSL + ' SL' : (ag.cooldownLeftMs > 0 ? 'entry PAUSE chalu' : 'normal')) +
          ' · SL buffer ' + Math.round(P.slBufAtr * 100) + '% ATR · score ≥' + P.minScore + '</div>';
      }
      // requirement #6: pending SUGGESTION — approval par hi lagta hai
      const SUG = ag.suggest;
      if (SUG) {
        h += '<div class="ab-tr"><b>SUGGEST</b><span>' + SUG.k + ' = ' + SUG.v + ' — ' + String(SUG.why || '').slice(0, 110) +
          ' (chat me bolo "apply karo")</span></div>';
      }
      // ── MARKET INTELLIGENCE: global + news + FII/DII + calendar (real data, source+time+status) ──
      const esc = x => String(x == null ? '' : x).replace(/[<>]/g, '');
      const MI = ag.intel;
      if (MI && (MI.globalLine || MI.headline)) {
        h += '<div class="ab-row ab-act">MARKET INTEL</div>';
        if (MI.globalLine) h += '<div class="ab-row">GLOBAL: ' + esc(MI.globalLine).slice(0, 170) + ' <span style="color:#667">(DELAYED feeds)</span></div>';
        if (MI.headline) h += '<div class="ab-row">NEWS [' + esc(MI.headline.impact) + '] ' + esc(MI.headline.t).slice(0, 95) +
          ' — ' + esc(MI.headline.src) + ' · ' + esc(MI.headline.time) + ' · ' + esc(MI.headline.v) + '</div>';
        if (MI.fii) h += '<div class="ab-row">' + (MI.fii.status === 'CONFIRMED DATA' && MI.fii.net != null
          ? 'FII/DII: net ₹' + Math.round(MI.fii.net).toLocaleString('en-IN') + ' Cr (' + esc(MI.fii.date) + ' · CONFIRMED — NSE)'
          : 'FII/DII: UNAVAILABLE (NSE data nahi mila)') + '</div>';
        if (MI.nextEvent) h += '<div class="ab-row">NEXT EVENT: ' + esc(MI.nextEvent.t) + ' — ' + esc(MI.nextEvent.at) +
          ' (' + esc(MI.nextEvent.impact) + ' impact · ' + esc(MI.nextEvent.src) + ')</div>';
      }
      // requirement #9 + #10: ⚠ STOP LOSS DETECTED → ROOT CAUSE report (PDF facts + fix + validation + version)
      const SLA = (ag.slAnalysis || []).slice(-1)[0];
      if (SLA) {
        if (SLA.causeCode) {
          h += '<div class="ab-row ab-act">⚠ STOP LOSS DETECTED → ROOT CAUSE [' + SLA.causeCode + '] (' + (SLA.tf || '') + ' ' + (SLA.dir || '') +
            (SLA.confidence != null ? ' · conf ' + SLA.confidence + '%' : '') + ')</div>';
          h += '<div class="ab-row">Root Cause: ' + String(SLA.primaryRootCause || SLA.primaryReason || '—').slice(0, 140) +
            (SLA.secondaryCause ? ' · Secondary: ' + String(SLA.secondaryCause).slice(0, 60) : '') + '</div>';
          h += '<div class="ab-row">Zone/Entry: ' + (SLA.zoneType || '—') + ' · ' + (SLA.pattern || '—') +
            ' · score ' + (SLA.tradeScore != null ? SLA.tradeScore : '—') + (SLA.fresh ? ' · ' + SLA.fresh : '') +
            ' · Entry Type ' + (SLA.entryType || '—') + (SLA.baseCount ? ' · base ' + SLA.baseCount : '') +
            (SLA.authentic === false ? ' · NON-AUTHENTIC' : '') + '</div>';
          h += '<div class="ab-row">HTF/ITF/LTF: ' + String(SLA.htfLocation || '—').slice(0, 40) + ' / ' + String(SLA.itfTrend || '—').slice(0, 30) +
            ' / ' + String(SLA.ltfExecution || '—').slice(0, 30) + ' · Curve: ' + String(SLA.curve || '—').slice(0, 40) + '</div>';
          h += '<div class="ab-row">Post-SL: ' + String(SLA.postSl || '—').slice(0, 90) +
            ' · SL Placement: ' + (SLA.slPlacement || '—') + ' · ATR: ' + (SLA.atrAnalysis || '—') + '</div>';
          if (SLA.explanation) h += '<div class="ab-row">Explanation: ' + String(SLA.explanation).slice(0, 170) + '</div>';
          if (SLA.dataOk === false) h += '<div class="ab-row ab-act">Insufficient market data for reliable root-cause analysis.</div>';
          // AUTO FIX + VALIDATION + OLD/NEW RULE + VERSION (#11-#14)
          if (SLA.fix && SLA.fix.k != null) {
            h += '<div class="ab-row">AUTO FIX: ' + SLA.fix.k + ' = ' + SLA.fix.v + ' — ' + String(SLA.fix.why || '').slice(0, 110) + '</div>';
            if (SLA.validation) h += '<div class="ab-row">VALIDATION: <b>' + SLA.validation.status + '</b> — ' + String(SLA.validation.why || '').slice(0, 130) + '</div>';
            const ver = (ag.versions || []).filter(v2 => v2.key === SLA.fix.k).pop();
            if (ver) h += '<div class="ab-row">RULE: ' + ver.key + ' ' + ver.oldVal + ' → ' + ver.newVal + ' · ' + ver.v +
              (SLA.action === 'ACTIVATED' ? ' · ACTIVE (auto, rollback par purana wapas)' : ' · pending approval ("apply karo")') + '</div>';
            else h += '<div class="ab-row">RULE: ' + SLA.fix.k + ' ' + SLA.fix.v + ' (pending — "apply karo" bolo) · ' + (SLA.version || ag.version || 'v1.0') + '</div>';
          } else if (SLA.fixNote) {
            h += '<div class="ab-row">AUTO FIX: ' + String(SLA.fixNote).slice(0, 130) + '</div>';
          }
          h += '<div class="ab-row">STRATEGY VERSION: ' + (SLA.version || ag.version || 'v1.0') +
            (ag.versions && ag.versions.length ? ' · ' + ag.versions.length + ' changes (rollback on)' : '') +
            (SLA.action === 'ACTIVATED' ? ' · <b>new rule ACTIVE</b>' : '') + '</div>';
        } else {
          h += '<div class="ab-row ab-act">⚠ STOP LOSS DETECTED (' + (SLA.tf || '') + ' ' + (SLA.dir || '') + ')</div>';
          h += '<div class="ab-row">Reason: ' + String(SLA.primaryReason || '—').slice(0, 150) + (SLA.category ? ' [' + SLA.category + ']' : '') + '</div>';
          h += '<div class="ab-row">Market Analysis: ' + String(SLA.mistake || SLA.marketCondition || '—').slice(0, 130) +
            (SLA.afterSl ? ' · after SL: ' + String(SLA.afterSl).slice(0, 60) : '') + '</div>';
          h += '<div class="ab-row">Recommended Improvement: ' + String(SLA.improvement || '—').slice(0, 150) + '</div>';
          h += '<div class="ab-row">ATR change: ' + (SLA.atrChange && SLA.atrChange.yes
            ? 'YES (' + SLA.atrChange.old + ' → ' + SLA.atrChange.new + ')'
            : 'NO (reason ATR me nahi)') +
            ' · Zone: ' + (SLA.zoneAnalysis || '-') + ' · Entry: ' + (SLA.entryAnalysis || '-') + ' · SL: ' + (SLA.slAnalysis || '-') + '</div>';
        }
      }
      for (const l of (ag.log || []).slice(0, 3)) {
        h += '<div class="ab-tr"><b>' + (l.type || 'AI') + '</b><span>' + (l.msg || '') + '</span></div>';
      }
      h += '<div class="ab-row ab-idle">Agent se baat karo — corner me 🤖 button dabao (mic se bolo ya type karo)</div>';
    }
    if (!trades.length && !open) h += '<div class="ab-row ab-idle">Market hours me 3m+5m zone ki ENTRY bot lega — SL/Target par auto EXIT · AI agent SL ka asli reason batata hai (sirf ATR nahi) — fix ki suggestion apply aap karoge</div>';
    el.innerHTML = h;
  }

  // ── open / close ──
  function openChain() {
    $('chainScreen').style.display = 'flex';
    cExpiry = cExpiry || '';
    loadChain();
    if (cTimer) clearInterval(cTimer);
    cTimer = setInterval(() => { loadChain(); loadAutoBot(); }, 5000);
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
    renderTrades();
    renderNet();
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
