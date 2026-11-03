/* ─── DS ZONE — SERVER AUTO BOT (24/7) ───────────────────────────
   Laptop/phone band ho tab bhi chalta hai (Railway server par):
   • 3m + 5m dono timeframe ke zones
   • entry par auto paper ENTRY — BUY zone → CE, SELL zone → PE, 1 lot
   • SL / Target / zone-out par auto EXIT (real charges ke saath)
   • wallet + zone memory + active setup server pe persist
   • AI AGENT: har SL ka reason dekhta hai aur SL/score/filters
     khud-a-khud fix karta hai taaki aage kam SL lage aur
     jyada TARGET mile
   ──────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');

const START_CASH = 2000000;
const AUTO_TF = '3m';
const AUTO_TFS = ['3m', '5m'];        // AI agent dono TF ke zones dekhta hai
const AI_REVIEW_MS = 60000;           // har 1 min: SL reason review + auto-fix

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
    // restore active zones — lekin SIRF aaj ke (purane din ka setup restart
    // ke baad galat entry/SL de sakta hai)
    try {
      const raw = JSON.parse(storage.getItem('auto_active') || '{}');
      const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
      const cleaned = {};
      for (const tf of Object.keys(raw)) {
        const s = raw[tf];
        if (!s || typeof s !== 'object') continue;
        if (['TARGET_HIT', 'STOP_LOSS_HIT', 'INVALIDATED', 'SQUARE_OFF'].includes(s.status)) continue;
        const day = s.createdAt ? new Date(s.createdAt + 19800000).toISOString().slice(0, 10) : today;
        if (day === today) cleaned[tf] = s;
      }
      engine.activeByTF = cleaned;
    } catch (e) {}
  }

  // ── AI AGENT: SL reason dekhta hai + tuning khud fix karta hai ──
  const createAiAgent = require('./ai-agent');
  const agent = createAiAgent({ storeDir, fetchCandles, symbol });
  engine.setTuning(agent.params());

  let wallet = { cash: START_CASH, start: START_CASH, pos: [], trades: [], seen: {} };
  try {
    const w = JSON.parse(storage.getItem('auto_wallet') || 'null');
    if (w && typeof w.cash === 'number') wallet = Object.assign(wallet, w);
  } catch (e) {}
  const saveWallet = () => storage.setItem('auto_wallet', JSON.stringify(wallet));

  let lastRun = 0, lastError = '', busy = false, started = false;
  let lastAiReview = 0;
  let lastA = null, lastPrice = 0;   // latest analyze() — AI agent ko har TF ka live analysis
  const ccache = {};

  async function getCandles(tf, minsBack) {
    // chhota TF = chhota TTL — 25s purane candles par entry/SL late + galat fire hote the
    const ttl = tf <= 5 ? 6000 : 15000;
    const hit = ccache[tf];
    if (hit && Date.now() - hit.at < ttl) return hit.v;
    const v = await fetchCandles(symbol, tf, minsBack);
    if (v && v.length) ccache[tf] = { at: Date.now(), v };
    return (ccache[tf] && ccache[tf].v) || [];
  }

  async function seedTf(tf) {
    try {
      const c = await fetchCandles(symbol, tf, 1440);
      if (c && c.length) getMgr(symbol, tf).setHistory(c);
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

  async function enter(s, a) {
    const key = autoKey(s);
    if (wallet.seen[key] || wallet.pos.some(p => p.setupKey === key)) return;   // ek zone = ek entry
    if (wallet.pos.some(p => p.meta && p.meta.tf === s.zoneTF)) return;          // ek TF = ek open position
    // AI AGENT guard — cooldown ke dauran entry block
    const g = agent.canEnter({ tf: s.zoneTF, dir: s.direction, score: s.zoneScore });
    if (!g.ok) return;
    // AI AGENT ke liye entry ka pura context (baad me SL root-cause analysis ke liye)
    // — PDF methodology: pattern/type/levels + baseCount + zone strength + entry type/rule
    //   + marking/authentic + curve (HIGH/EQUILIBRIUM/LOW) + HTF trend (15m/30m) + 50 SMA trend
    const tr = (a && (s.zoneTF === '5m' ? a.t5 : a.t3)) || {};
    const all = a && a.allTF && a.allTF[s.zoneTF];
    const loc = a && a.location;
    const meta = {
      tf: s.zoneTF, dir: s.direction, score: s.zoneScore, fresh: s.zoneFreshness,
      trend: tr.trend || 'sideways', regime: (a && a.regime) || '', atr: (all && all.atr) || 0,
      spot: (a && a.price) || 0, zoneEntry: s.entry, zoneSl: s.stopLoss, zoneTgt: s.target,
      pattern: s.pattern || '', zoneType: s.zoneType || '', entryType: s.entryType || '',
      proximal: s.proximal || 0, distal: s.distal || 0, zoneTime: s.zoneTime || 0,
      baseCount: s.baseCount || 0, zoneStrength: s.zoneStrength || '',
      entryRule: s.entryRule || '', marking: s.marking || 'NORMAL', authentic: s.authentic !== false,
      zoneDist: s.zoneDist || 0, riskReward: s.riskReward || 0,
      sma50: tr.smaVal || 0,
      htfTrend: (a && a.t15 && a.t15.trend ? a.t15.trend : '') + '/' + (a && a.t30 && a.t30.trend ? a.t30.trend : ''),
      curve: loc ? (loc.pos + (loc.pct != null ? ' ' + loc.pct + '%' : '')) : ''
    };
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
        entry: q.ltp, ltp: q.ltp, chg, entryTs: Date.now(), setupKey: key, zoneDir: s.direction, meta
      });
      saveWallet();
      console.log('[AUTOBOT] ENTRY ' + s.direction + ' ' + s.zoneTF + ' ' + strike + ' ' + side + ' ' + lots + ' lot @ ' + q.ltp);
    } catch (e) { lastError = 'entry: ' + e.message; retry(); }
  }

  async function exitPos(p, reason, t) {
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
        entryTs: p.entryTs, exitTs: Date.now(), reason,
        tf: (p.meta && p.meta.tf) || (t && t.zoneTF) || '', meta: p.meta || null
      });
      if (wallet.trades.length > 100) wallet.trades.length = 100;
      wallet.pos = wallet.pos.filter(x => x.id !== p.id);
      saveWallet();
      console.log('[AUTOBOT] EXIT ' + reason + ' ' + p.strike + ' ' + p.side + ' pnl ' + Math.round(pnl));
      // AI AGENT ko result bhejo — SL ka reason wo khud diagnose karega
      try {
        const pr = (getPrices() || {})[p.sym];
        agent.observe({
          kind: /STOP LOSS/.test(reason) ? 'SL' : /TARGET/.test(reason) ? 'TARGET' : 'OUT',
          exitTs: Date.now(), entryTs: p.entryTs || 0, slHitTs: Date.now(),
          meta: p.meta || {}, pnl,
          tf: (p.meta && p.meta.tf) || (t && t.zoneTF) || '3m',
          dir: (p.meta && p.meta.dir) || (t && t.direction) || p.zoneDir || '',
          score: p.meta && p.meta.score, fresh: p.meta && p.meta.fresh,
          trend: p.meta && p.meta.trend, regime: p.meta && p.meta.regime, atr: p.meta && p.meta.atr,
          spotAtEntry: p.meta && p.meta.spot, spotAtExit: (pr && pr.ltp) || 0,
          zone: t ? { entry: t.entry, sl: t.stopLoss, tgt: t.target }
            : (p.meta && p.meta.zoneTgt ? { entry: p.meta.zoneEntry, sl: p.meta.zoneSl, tgt: p.meta.zoneTgt } : null)
        });
      } catch (e) {}
      // exit ke turant baad review — naya fix agle entry se pehle lag jaye
      try { lastAiReview = Date.now(); agent.review().catch(() => {}); } catch (e) {}
      // turant journal sync — SL hua to usi second me agent ke paas price ke saath pahunch jaye
      try { agent.syncHistory(engine.history); } catch (e) {}
    } catch (e) { lastError = 'exit: ' + e.message; }
  }

  async function runOnce() {
    if (busy) return;
    busy = true;
    try {
      lastRun = Date.now();

      // AI AGENT review — SL reasons check + auto-fix (market band ho tab bhi chalta hai)
      if (Date.now() - lastAiReview >= AI_REVIEW_MS) {
        lastAiReview = Date.now();
        agent.review().catch(() => {});
      }
      if (!isMarketOpen()) { busy = false; return; }

      // EOD safety: market band hone se pehle sab auto position square-off
      const now = Date.now();
      for (const p of wallet.pos.slice()) {
        if (now - p.entryTs > 6.5 * 3600 * 1000) await exitPos(p, 'AUTO BOT · EOD', null);
      }

      const mgr = getMgr(symbol, 3);
      let c3 = mgr.get();
      if (c3.length < 10) { await seedTf(3); c3 = mgr.get(); }
      if (c3.length < 6) { busy = false; return; }

      const [c1, c5, c15, c30] = await Promise.all([
        getCandles(1, 200), getCandles(5, 1440), getCandles(15, 2880), getCandles(30, 4320)
      ]);
      if (!c1.length || !c5.length) { busy = false; return; }

      // AI agent ki latest tuning engine me lagao (SL buffer / score / filters)
      engine.setTuning(agent.params());

      const pr = (getPrices() || {})[symbol];
      const ltp = (pr && pr.ltp) || c3[c3.length - 1].close;
      const a = engine.analyze(c1, c3, c5, c15, c30, ltp, AUTO_TF);
      lastA = a; lastPrice = ltp;
      // AI agent ko live engine context (trends/50SMA/curve/location) — root-cause analysis + panel
      try { agent.setEngine(a); } catch (e) {}
      // har zone result (entry/SL/target) agent ke daily journal me — persist + naye SL par auto AI-fix
      try { agent.syncHistory(engine.history); } catch (e) {}
      // aaj ke saare zones (3m + baaki TF) bhi save — daily zone diary
      try { agent.syncZones(engine.allZonesByTF); } catch (e) {}
      storage.setItem('auto_active', JSON.stringify(engine.activeByTF || {}));

      // 3m + 5m dono TF ke zones par ENTRY
      for (const tf of AUTO_TFS) {
        const s = engine.activeByTF[tf];
        if (s && s.status === 'ENTRY_TRIGGERED') await enter(s, a);
      }

      // dono TF ke completed setups par auto EXIT (SL / Target / zone-out)
      for (const tf of AUTO_TFS) {
        const comp = (a.completedByTF && a.completedByTF[tf]) || [];
        for (const t of comp.slice(-8)) {
          if (!t || !t.zoneTime) continue;
          const key = autoKey(t);
          const p = wallet.pos.find(x => x.setupKey === key);
          if (!p) continue;
          const reason = t.hitStatus === 'TARGET_HIT' ? 'AUTO BOT · TARGET'
            : t.hitStatus === 'STOP_LOSS_HIT' ? 'AUTO BOT · STOP LOSS'
            : t.hitStatus === 'SQUARE_OFF' ? 'AUTO BOT · 15:15 SQUARE OFF'
            : 'AUTO BOT · ZONE OUT';
          await exitPos(p, reason, t);
        }
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
    // har TF ke zones (engine 1m/3m/5m/15m/30m sab scan karta hai) — AI agent jo TF khola ho uska bata sake
    const rank = t => { const i = AUTO_TFS.indexOf(t); return i < 0 ? 9 : i; };
    const actives = Object.keys(engine.activeByTF || {})
      .filter(t => engine.activeByTF[t] && engine.activeByTF[t].entry != null)
      .map(t => ({ tf: t, setup: engine.activeByTF[t] }))
      .sort((x, y) => rank(x.tf) - rank(y.tf));
    // live analysis summary (jo TF user ne khola hai uske liye): trend/status/zone-result har TF ka
    const an = { price: lastPrice, regime: lastA && lastA.regime, trends: {}, tf: {} };
    if (lastA) {
      an.trends = { '1m': lastA.t1 && lastA.t1.trend, '3m': lastA.t3 && lastA.t3.trend, '5m': lastA.t5 && lastA.t5.trend, '15m': lastA.t15 && lastA.t15.trend, '30m': lastA.t30 && lastA.t30.trend };
      Object.keys(lastA.allTF || {}).forEach(k => {
        const r = lastA.allTF[k] || {}, s = r.activeSetup || {};
        an.tf[k] = { status: r.status, note: r.reason || '', dir: s.direction || '', score: s.zoneScore, entry: s.entry, sl: s.stopLoss, tgt: s.target, atr: r.atr };
      });
    }
    return {
      sym: symbol, tf: AUTO_TFS.join('+'), mktOpen: isMarketOpen(), lot: 1,
      cash: wallet.cash, start: wallet.start,
      pos: wallet.pos, trades: wallet.trades.slice(0, 20),
      active: engine.activeByTF[AUTO_TF] || engine.activeByTF['5m'] || null,
      actives,
      completed: engine.completedByTF || {},
      analysis: an.trends['1m'] ? an : null,
      agent: agent.status(),
      entriesToday, netPnl: Math.round(total * 100) / 100, wins, losses,
      lastRun, lastError, serverTime: Date.now()
    };
  }

  async function start() {
    if (started) return;
    started = true;
    startPolling(symbol);                    // client ke bhi live 3m ticks chahiye
    await seedTf(3);
    await seedTf(5);
    await runOnce();
    setInterval(runOnce, 5000);              // har 5 sec: zone → entry → SL/Target exit
    console.log('[AUTOBOT] started — 3m+5m auto paper trading (' + symbol + ', 1 lot) + AI agent');
  }

  return { start, runOnce, status, agent };
}

module.exports = createAutoBot;
