/* spot-check: report ke trades ko 1m data se verify karo */
const fs = require('fs'), path = require('path');
const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', '1m.json'), 'utf8'));
const rep = JSON.parse(fs.readFileSync(path.join(__dirname, 'report-default.json'), 'utf8'));
const trades = rep.trades;

// index 1m candles by minute ts
const byTs = new Map();
for (const c of data) byTs.set(c.time, c);

function check(t) {
  const eTs = Date.parse(t.entryTs), xTs = Date.parse(t.exitTs);
  const isBuy = t.dir === 'BUY';
  // entry candle: 1m candle jisme entry hui (entryTs = candle close)
  const probs = [];
  // path: entryTs se exitTs tak ke candles
  const pathC = [];
  for (let ts = eTs - 60000; ts <= xTs; ts += 60000) {
    const c = byTs.get(ts);
    if (c) pathC.push(c);
  }
  if (!pathC.length) { probs.push('no candles in path!'); return probs; }
  // entry touch: entry candle par price entry tak aaya?
  const ec = byTs.get(eTs - 60000) || pathC[0];
  const touched = isBuy ? ec.low <= t.entry + 0.01 : ec.high >= t.entry - 0.01;
  if (!touched) probs.push('entry candle par entry touch nahi mila (c=' + ec.close + ' l=' + ec.low + ' h=' + ec.high + ' e=' + t.entry + ')');
  // conservative: exit se pehle SL aur target dono hue to SL chahiye
  let slFirst = null, tgtHit = false, slHit = false;
  for (const c of pathC) {
    const sl = isBuy ? c.low <= t.sl + 0.001 : c.high >= t.sl - 0.001;
    const tg = isBuy ? c.high >= t.tgt - 0.001 : c.low <= t.tgt + 0.001;
    if (sl && tg) { slFirst = 'same-candle-both->SL'; break; }
    if (sl) { slFirst = c.time; break; }
    if (tg) { tgtHit = true; break; }
  }
  if (t.status === 'TARGET_HIT') {
    if (slFirst !== null) probs.push('TARGET likha hai par path me SL pehle mila: ' + JSON.stringify(slFirst));
    if (!tgtHit && slFirst === null) probs.push('target hi nahi mila path me');
  } else if (t.status === 'STOP_LOSS_HIT') {
    if (slFirst === null) probs.push('SL likha hai par path me SL nahi mila');
  } else if (t.status === 'SQUARE_OFF') {
    // 15:15 par square — exit time check
    const ed = new Date(xTs + 19800000);
    const m = ed.getUTCHours() * 60 + ed.getUTCMinutes();
    if (m < 915 || m > 930) probs.push('square-off time odd: ' + ed.toISOString());
  }
  return probs;
}

let ok = 0, bad = 0;
const badList = [];
for (const t of trades) {
  const p = check(t);
  if (p.length) { bad++; if (badList.length < 8) badList.push({ t, p }); }
  else ok++;
}
console.log('checked ' + trades.length + ' trades: OK=' + ok + ' BAD=' + bad);
for (const b of badList) {
  console.log('---');
  console.log(b.t.dir + ' ' + b.t.tf + ' ' + b.t.status + ' entry=' + b.t.entry + ' sl=' + b.t.sl + ' tgt=' + b.t.tgt);
  console.log('  entryTs=' + b.t.entryTs + ' exitTs=' + b.t.exitTs + ' pts=' + b.t.points);
  console.log('  PROBLEM: ' + b.p.join(' | '));
}

// random samples dikhao
console.log('\n--- sample trades ---');
for (const i of [0, 100, 250, 400, 530]) {
  const t = trades[i];
  if (t) console.log(t.entryTs.slice(0, 16) + ' ' + t.dir + ' ' + t.tf + ' ' + t.status + ' e=' + t.entry.toFixed(1) + ' sl=' + t.sl.toFixed(1) + ' tgt=' + t.tgt.toFixed(1) + ' pts=' + t.points.toFixed(1) + ' hold=' + t.holdMin + 'm');
}
