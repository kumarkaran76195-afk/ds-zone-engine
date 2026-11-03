/* ─── DS ZONE BACKTEST — 1 YEAR REPLAY: KONSA TIME ME SABSE JYADA TARGET ───
   • DSEngine (public/indicator.js) ko 1 saal ke REAL 1m candles par replay
   • Auto-bot jaisi execution: sirf 3m + 5m zones par entry (spot points),
     ek TF par ek hi open setup, first-touch limit entry, SL first (conservative),
     15:15 EOD square-off, session 09:15–15:15
   • Date.now() ko simulated candle-time par patch kiya — session/day logic sahi chale
   • Har trade ka ENTRY TIME IST capture → 15/30-min buckets me target/SL count
   Usage: node run.js [--default]   (--default = AI-agent tuning ke bina, system rules)
   ────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');

// localStorage fake — DSEngine history/used-zones memory me (disk writes nahi)
const store = {};
global.localStorage = {
  getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; }
};

const { DSEngine } = require(path.join(__dirname, '..', 'public', 'indicator.js'));

const REAL_NOW = Date.now;
let SIM = REAL_NOW();
Date.now = () => SIM;                 // session/EOD/day logic simulated time par

const USE_DEFAULT = process.argv.includes('--default');
const TFS = [1, 3, 5, 15, 30];
const data = {};
for (const tf of TFS) {
  const f = path.join(__dirname, 'data', tf + 'm.json');
  if (!fs.existsSync(f)) { console.error('MISSING ' + f + ' — pehle node fetch-data.js chalao'); process.exit(1); }
  data[tf] = JSON.parse(fs.readFileSync(f, 'utf8'));
  console.log('data ' + tf + 'm: ' + data[tf].length + ' candles  ' +
    (data[tf].length ? new Date(data[tf][0].time).toISOString().slice(0, 10) + ' .. ' + new Date(data[tf][data[tf].length - 1].time).toISOString().slice(0, 10) : ''));
}
if (!data[1].length) { console.error('1m data khaali'); process.exit(1); }

const engine = new DSEngine();
engine.getDailyHistory = () => ({});                 // perf: sirf UI ke liye tha
if (!USE_DEFAULT) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'ai-agent.json'), 'utf8')).params;
    engine.setTuning(p);
    console.log('tuning = LIVE ai-agent params: ' + JSON.stringify(p));
  } catch (e) { console.log('tuning = engine defaults (ai-agent.json nahi mila)'); }
} else {
  console.log('tuning = system defaults (minScore 5, trendAlign off)');
}

// auto-bot lookbacks (candles): 1m=200, 3m=1440min, 5m=1440min, 15m=2880min, 30m=4320min
const WIN = { 1: 200, 3: 480, 5: 288, 15: 192, 30: 144 };
const ptr = { 1: 0, 3: 0, 5: 0, 15: 0, 30: 0 };
function advance(tf) {
  const arr = data[tf], end = SIM - tf * 60000;
  while (ptr[tf] < arr.length && arr[ptr[tf]].time <= end) ptr[tf]++;
}
function win(tf) {
  const p = ptr[tf];
  return data[tf].slice(Math.max(0, p - WIN[tf]), p);
}

const TFK = ['1m', '3m', '5m', '15m', '30m'];
const isTerm = st => st === 'TARGET_HIT' || st === 'STOP_LOSS_HIT' || st === 'SQUARE_OFF' || st === 'INVALIDATED';
const trades = [];
const watch = {};

function openTrade(w, s, now) {
  w.entered = true; w.closed = false;
  w.trade = {
    tf: s.zoneTF, dir: s.direction, entryTs: now, entry: s.entry, sl: s.stopLoss, tgt: s.target,
    score: s.zoneScore, pattern: s.pattern, strength: s.zoneStrength, fresh: s.zoneFreshness,
    entryType: s.entryType, zoneTime: s.zoneTime, status: 'OPEN'
  };
}
function closeTrade(w, s, now) {
  if (!w.entered || w.closed || !w.trade) return;
  const t = w.trade;
  w.closed = true;
  t.exitTs = now; t.status = s.status;
  if (s.status === 'TARGET_HIT') {
    t.points = (t.dir === 'BUY' ? 1 : -1) * (t.tgt - t.entry);   // limit fill target par
  } else {
    t.points = s.pnl != null ? s.pnl : 0;                        // SL/gap: trigger price se
  }
  t.holdMin = Math.round((now - t.entryTs) / 60000);
  trades.push(t);
}
function syncTrades(now) {
  for (const tf of TFK) {
    const s = engine.activeByTF[tf];
    let w = watch[tf];
    if (w && (!s || s !== w.ref)) {
      if (w.entered && !w.closed) closeTrade(w, w.ref, now);
      watch[tf] = null; w = null;
    }
    if (!s) continue;
    if (!w) { watch[tf] = { ref: s, status: s.status, entered: false, closed: false, trade: null }; w = watch[tf]; }
    if (s.status !== w.status) {
      const prev = w.status;
      w.status = s.status;
      if (!w.entered && prev !== 'ENTRY_TRIGGERED') {
        if (s.status === 'ENTRY_TRIGGERED') openTrade(w, s, now);
        else if (isTerm(s.status) && s.status !== 'INVALIDATED') { openTrade(w, s, now); closeTrade(w, s, now); }
      }
      if (w.entered && !w.closed && isTerm(s.status)) closeTrade(w, s, now);
    }
  }
}

// 1m candle ke andar: SL pehle (conservative) — BUY me low→high, SELL me high→low
function trackCandle(c) {
  for (const tf of TFK) {
    const s = engine.activeByTF[tf];
    if (!s) continue;
    const seq = s.direction === 'BUY' ? [c.low, c.high] : [c.high, c.low];
    for (const p of seq) {
      engine._track(s, p);
      if (!engine._isActive(s)) {
        engine._recordHit(tf, s, s.status);
        engine.activeByTF[tf] = null;
        break;
      }
    }
  }
}

const t0 = REAL_NOW();
const startDataTs = data[1][0].time;
const warmEnd = startDataTs + 2 * 86400000;         // 2 din ka window warm-up
let i = 0;
for (const c of data[1]) {
  SIM = c.time + 60000;
  TFS.forEach(advance);
  trackCandle(c);
  syncTrades(SIM);
  engine.analyze(win(1), win(3), win(5), win(15), win(30), c.close, '3m');
  syncTrades(SIM);
  if (++i % 20000 === 0) console.log('step ' + i + '  sim=' + new Date(SIM).toISOString().replace('T', ' ').slice(0, 16) + '  trades=' + trades.length + '  ' + Math.round((REAL_NOW() - t0) / 1000) + 's');
}
console.log('replay done: ' + i + ' steps, ' + Math.round((REAL_NOW() - t0) / 1000) + 's wall, trades captured=' + trades.length + ', engine history=' + engine.history.length);
const perTf = {};
for (const t of trades) perTf[t.tf] = (perTf[t.tf] || 0) + 1;
console.log('captured per TF: ' + JSON.stringify(perTf));

// ── REPORT ──────────────────────────────────────────────────────────────
const dayMs = 86400000;
const bt = trades.filter(t => (t.tf === '3m' || t.tf === '5m') && t.entryTs >= warmEnd && t.status !== 'INVALIDATED');
const istParts = ts => { const d = new Date(ts + 19800000); return { m: d.getUTCHours() * 60 + d.getUTCMinutes(), day: d.toISOString().slice(0, 10), wd: d.getUTCDay(), mon: d.toISOString().slice(0, 7), h: d.getUTCHours(), mi: d.getUTCMinutes() }; };
const hhmm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

function agg(list) {
  const a = { n: 0, tgt: 0, sl: 0, sq: 0, other: 0, net: 0, pts: [] };
  for (const t of list) {
    a.n++;
    if (t.status === 'TARGET_HIT') a.tgt++;
    else if (t.status === 'STOP_LOSS_HIT') a.sl++;
    else if (t.status === 'SQUARE_OFF') a.sq++;
    else a.other++;
    a.net += t.points || 0;
    a.pts.push(t.points || 0);
  }
  a.decided = a.tgt + a.sl;
  a.win = a.decided ? (a.tgt * 100 / a.decided) : 0;
  a.avg = a.n ? a.net / a.n : 0;
  a.net = Math.round(a.net * 10) / 10;
  a.avg = Math.round(a.avg * 10) / 10;
  a.win = Math.round(a.win * 10) / 10;
  return a;
}

function bucketTable(size) {
  const rows = [];
  const nb = Math.ceil((915 - 555) / size);
  for (let b = 0; b < nb; b++) {
    const from = 555 + b * size, to = from + size;
    const list = bt.filter(t => { const m = istParts(t.entryTs).m; return m >= from && m < to; });
    rows.push({ time: hhmm(from) + '-' + hhmm(Math.min(to, 915)), ...agg(list) });
  }
  return rows;
}

function printRows(title, rows) {
  console.log('\n=== ' + title + ' ===');
  console.log('time        | entries | TARGET | SL | sqoff | win%  | net pts | avg/trade');
  console.log('-'.repeat(72));
  for (const r of rows) {
    console.log(
      r.time.padEnd(11) + ' | ' + String(r.n).padStart(7) + ' | ' +
      String(r.tgt).padStart(6) + ' | ' + String(r.sl).padStart(2) + ' | ' +
      String(r.sq).padStart(4) + ' | ' + String(r.win).padStart(5) + ' | ' +
      String(r.net).padStart(7) + ' | ' + String(r.avg).padStart(5));
  }
}

const overall = agg(bt);
console.log('\n=== OVERALL (3m+5m entries, 1 saal) ===');
console.log(JSON.stringify({ ...overall, pts: undefined }));

const r30 = bucketTable(30);
const r15 = bucketTable(15);
printRows('30-MIN BUCKETS (entry time IST)', r30);
printRows('15-MIN BUCKETS (entry time IST)', r15);

const rankedNet = r30.filter(r => r.n >= 15).slice().sort((a, b) => b.net - a.net);
const rankedWin = r30.filter(r => r.decided >= 12).slice().sort((a, b) => b.win - a.win);
const rankedTgt = r30.filter(r => r.n >= 15).slice().sort((a, b) => b.tgt - a.tgt);
console.log('\n=== TOP WINDOWS ===');
console.log('net points par:   ' + rankedNet.slice(0, 3).map(r => r.time + ' (' + r.net + ' pts, win ' + r.win + '%, n=' + r.n + ')').join('  |  '));
console.log('win% par:         ' + rankedWin.slice(0, 3).map(r => r.time + ' (' + r.win + '%, n=' + r.n + ')').join('  |  '));
console.log('target count par: ' + rankedTgt.slice(0, 3).map(r => r.time + ' (' + r.tgt + ' targets, n=' + r.n + ')').join('  |  '));
const worst = r30.filter(r => r.n >= 15).slice().sort((a, b) => a.net - b.net).slice(0, 3);
console.log('sabse kharab:     ' + worst.map(r => r.time + ' (' + r.net + ' pts, win ' + r.win + '%)').join('  |  '));

// per-TF split for top-3 net windows
console.log('\n=== TOP WINDOW × TF ===');
for (const r of rankedNet.slice(0, 3)) {
  const [fs_] = r.time.split('-');
  const from = 555 + r30.findIndex(x => x.time === r.time) * 30;
  for (const tf of ['3m', '5m']) {
    const list = bt.filter(t => t.tf === tf && istParts(t.entryTs).m >= from && istParts(t.entryTs).m < from + 30);
    const a = agg(list);
    console.log(r.time + '  ' + tf + ': n=' + a.n + ' tgt=' + a.tgt + ' sl=' + a.sl + ' win=' + a.win + '% net=' + a.net);
  }
}

// monthly consistency of best net window
console.log('\n=== BEST WINDOW — MONTHLY CONSISTENCY ===');
if (rankedNet[0]) {
  const bIdx = r30.findIndex(x => x.time === rankedNet[0].time);
  const from = 555 + bIdx * 30;
  const months = {};
  for (const t of bt) {
    const m = istParts(t.entryTs).m;
    if (m >= from && m < from + 30) {
      const mo = istParts(t.entryTs).mon;
      months[mo] = months[mo] || [];
      months[mo].push(t);
    }
  }
  for (const mo of Object.keys(months).sort()) {
    const a = agg(months[mo]);
    console.log(mo + ': n=' + a.n + ' tgt=' + a.tgt + ' sl=' + a.sl + ' win=' + a.win + '% net=' + a.net);
  }
}

// weekday split
console.log('\n=== WEEKDAY (3m+5m) ===');
const wdNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
for (let wd = 1; wd <= 5; wd++) {
  const a = agg(bt.filter(t => istParts(t.entryTs).wd === wd));
  console.log(wdNames[wd] + ': n=' + a.n + ' tgt=' + a.tgt + ' sl=' + a.sl + ' win=' + a.win + '% net=' + a.net);
}

// direction split
console.log('\n=== DIRECTION ===');
for (const d of ['BUY', 'SELL']) {
  const a = agg(bt.filter(t => t.dir === d));
  console.log(d + ': n=' + a.n + ' tgt=' + a.tgt + ' sl=' + a.sl + ' sq=' + a.sq + ' win=' + a.win + '% net=' + a.net);
}

const outFile = path.join(__dirname, USE_DEFAULT ? 'report-default.json' : 'report-live.json');
fs.writeFileSync(outFile, JSON.stringify({
  generatedAt: new Date().toISOString(), tuning: USE_DEFAULT ? 'system-default' : 'live-ai-agent',
  overall, buckets30: r30, buckets15: r15,
  trades: bt.map(t => ({ ...t, entryTs: new Date(t.entryTs).toISOString(), exitTs: new Date(t.exitTs).toISOString() }))
}, null, 1));
console.log('\n' + path.basename(outFile) + ' saved (' + bt.length + ' trades)');
