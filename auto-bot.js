/* ─── DS ZONE — SERVER AUTO BOT (24/7) ───────────────────────────
   Laptop/phone band ho tab bhi chalta hai (Railway server par):
   • sirf 3m timeframe ke zones
   • entry par auto paper ENTRY — BUY zone → CE, SELL zone → PE, 1 lot
   • SL / Target / zone-out par auto EXIT (real charges ke saath)
   • wallet + zone memory + active setup server pe persist
   ──────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');

const START_CASH = 2000000;
const AUTO_TF = '3m';

function makeStorage(file) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { data = {}; }
  const persist = () => { try { fs.writeFileSync(file, JSON.stringify(data)); } catch (e) {} };
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem(k, v) { data[k] = String(v); persist(); },
    removeItem(k) { delete data[k]; persist(); }
  };
}

function calcCharges(buyVal, sellVal) {
  buyVal = buyVal || 0; sellVal = sellVal || 0;
  const turn = buyVal + sellVal;
  const brokerage = turn * 0.0003;
  const stt = sellVal * 0.001;
  const exch = turn * 0.0000297;
  const sebi = turn * 0.000001;
  const stamp = buyVal * 0.00003;
  const gst = (brokerage + exch + sebi) * 0.18;
  return brokerage + stt + exch + sebi + stamp + gst;
}

function autoKey(s) { return s.zoneTF + '|' + s.zoneTime + '|' + Math.round((s.entry || 0) * 10) / 10; }
function dayKey(ts) { return new Date(ts).toISOString().slice(0, 10); }

function createAutoBot(deps) {
  const { storeDir, symbol, fetchCandles, getMgr, startPolling, isMarketOpen, chainQuote, getPrices } = deps;
  const file = path.join(storeDir, 'auto-bot.json');
  const storage = makeStorage(file);
  global.localStorage = storage;   // DSEngine zone-memory + trade history yahin persist hoti hai

  const { DSEngine } = require('./public/indicator.js');
  const engine = deps.engine || new DSEngine();
  if (!deps.engine) {
    try { engine.activeByTF = JSON.parse(storage.getItem('auto_active') || '{}'); } catch (e) {}
  }

  let wallet = { cash: START_CASH, start: START_CASH, pos: [], trades: [], seen: {} };
  try {
    const w = JSON.parse(storage.getItem('auto_wallet') || 'null');
    if (w && typeof w.cash === 'number') wallet = Object.assign(wallet, w);
  } catch (e) {}
  const saveWallet = () => storage.setItem('auto_wallet', JSON.stringify(wallet));

  let lastRun = 0, lastError = '', busy = false, started = false;
  const ccache = {};

  async function getCandles(tf, minsBack) {
    const ttl = tf <= 5 ? 25000 : 60000;
    const hit = ccache[tf];
    if (hit && Date.now() - hit.at < ttl) return hit.v;
    const v = await fetchCandles(symbol, tf, minsBack);
    if (v && v.length) ccache[tf] = { at: Date.now(), v };
    return (ccache[tf] && ccache[tf].v) || [];
  }

  async function seed3m() {
    try {
      const c = await fetchCandles(symbol, 3, 1440);
      if (c && c.length) getMgr(symbol, 3).setHistory(c);
    } catch (e) {}
  }

  function pruneSeen() {
    const ks = Object.keys(wallet.seen);
    if (ks.length > 300) {
      ks.sort((a, b) => wallet.seen[b] - wallet.seen[a]);
      const t = {}; ks.slice(0, 300).forEach(k => { t[k] = wallet.seen[k]; });
      wallet.seen = t;
    }
  }

  async function enter(s) {
    const key = autoKey(s);
    if (wallet.seen[key] || wallet.pos.some(p => p.setupKey === key)) return;   // ek zone = ek entry
    wallet.seen[key] = Date.now(); pruneSeen(); saveWallet();
    const retry = () => { delete wallet.seen[key]; pruneSeen(); saveWallet(); };
    try {
      const step = symbol === 'NIFTY' ? 50 : 100;
      const strike = Math.round((s.entry || 0) / step) * step;
      const side = s.direction === 'BUY' ? 'CE' : 'PE';
      const q = await chainQuote(symbol, strike, side);
      if (!q || !q.ltp) return retry();
      const lots = 1;
      const qty = lots * (q.lot || 1);
      const cost = q.ltp * qty;
      const chg = calcCharges(cost, 0);
      if (cost + chg > wallet.cash) return retry();
      wallet.cash -= cost + chg;
      wallet.pos.push({
        id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
        sym: symbol, expiry: q.expiry || '', strike, side, lots, qty,
        entry: q.ltp, ltp: q.ltp, chg, entryTs: Date.now(), setupKey: key, zoneDir: s.direction
      });
      saveWallet();
      console.log('[AUTOBOT] ENTRY ' + s.direction + ' ' + strike + ' ' + side + ' ' + lots + ' lot @ ' + q.ltp);
    } catch (e) { lastError = 'entry: ' + e.message; retry(); }
  }

  async function exitPos(p, reason) {
    try {
      const q = await chainQuote(p.sym, p.strike, p.side);
      if (q && q.ltp) p.ltp = q.ltp;
      const sellChg = calcCharges(0, p.ltp * p.qty);
      const net = p.ltp * p.qty - sellChg;
      wallet.cash += net;
      const pnl = (p.ltp - p.entry) * p.qty - ((p.chg || 0) + sellChg);
      wallet.trades.unshift({
        sym: p.sym, strike: p.strike, side: p.side, lots: p.lots, qty: p.qty,
        entry: p.entry, exit: p.ltp, chg: (p.chg || 0) + sellChg, pnl,
        entryTs: p.entryTs, exitTs: Date.now(), reason
      });
      if (wallet.trades.length > 100) wallet.trades.length = 100;
      wallet.pos = wallet.pos.filter(x => x.id !== p.id);
      saveWallet();
      console.log('[AUTOBOT] EXIT ' + reason + ' ' + p.strike + ' ' + p.side + ' pnl ' + Math.round(pnl));
    } catch (e) { lastError = 'exit: ' + e.message; }
  }

  async function runOnce() {
    if (busy) return;
    busy = true;
    try {
      lastRun = Date.now();
      if (!isMarketOpen()) { busy = false; return; }

      // EOD safety: market band hone se pehle sab auto position square-off
      const now = Date.now();
      for (const p of wallet.pos.slice()) {
        if (now - p.entryTs > 6.5 * 3600 * 1000) await exitPos(p, 'AUTO BOT · EOD');
      }

      const mgr = getMgr(symbol, 3);
      let c3 = mgr.get();
      if (c3.length < 10) { await seed3m(); c3 = mgr.get(); }
      if (c3.length < 6) { busy = false; return; }

      const [c1, c5, c15, c30] = await Promise.all([
        getCandles(1, 200), getCandles(5, 1440), getCandles(15, 2880), getCandles(30, 4320)
      ]);
      if (!c1.length || !c5.length) { busy = false; return; }

      const pr = (getPrices() || {})[symbol];
      const ltp = (pr && pr.ltp) || c3[c3.length - 1].close;
      const a = engine.analyze(c1, c3, c5, c15, c30, ltp, AUTO_TF);
      storage.setItem('auto_active', JSON.stringify(engine.activeByTF || {}));

      const s = a && a.activeSetup;
      if (s && s.zoneTF === AUTO_TF && s.status === 'ENTRY_TRIGGERED') await enter(s);

      const comp = (a && a.completedByTF && a.completedByTF[AUTO_TF]) || [];
      for (const t of comp.slice(-8)) {
        if (!t || !t.zoneTime) continue;
        const key = autoKey(t);
        const p = wallet.pos.find(x => x.setupKey === key);
        if (!p) continue;
        const reason = t.hitStatus === 'TARGET_HIT' ? 'AUTO BOT · TARGET'
          : t.hitStatus === 'STOP_LOSS_HIT' ? 'AUTO BOT · STOP LOSS'
          : 'AUTO BOT · ZONE OUT';
        await exitPos(p, reason);
      }
      lastError = '';
    } catch (e) { lastError = e.message; console.log('[AUTOBOT] ERR ' + e.message); }
    busy = false;
  }

  function status() {
    const today = dayKey(Date.now());
    let entriesToday = 0, total = 0, wins = 0, losses = 0;
    for (const t of wallet.trades) {
      total += t.pnl;
      if (t.pnl >= 0) wins++; else losses++;
      if (t.entryTs && dayKey(t.entryTs) === today) entriesToday++;
    }
    for (const p of wallet.pos) { if (p.entryTs && dayKey(p.entryTs) === today) entriesToday++; }
    return {
      sym: symbol, tf: AUTO_TF, mktOpen: isMarketOpen(), lot: 1,
      cash: wallet.cash, start: wallet.start,
      pos: wallet.pos, trades: wallet.trades.slice(0, 20),
      active: (engine.activeByTF && engine.activeByTF[AUTO_TF]) || null,
      entriesToday, netPnl: Math.round(total * 100) / 100, wins, losses,
      lastRun, lastError, serverTime: Date.now()
    };
  }

  async function start() {
    if (started) return;
    started = true;
    startPolling(symbol);                    // client ke bhi live 3m ticks chahiye
    await seed3m();
    await runOnce();
    setInterval(runOnce, 5000);              // har 5 sec: zone → entry → SL/Target exit
    console.log('[AUTOBOT] started — 3m auto paper trading (' + symbol + ', 1 lot)');
  }

  return { start, runOnce, status };
}

module.exports = createAutoBot;
