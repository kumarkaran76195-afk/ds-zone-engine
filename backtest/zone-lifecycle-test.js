// Scenario test: stale-WAITING invalidation + live-trade no-new-zone + auto new zone after hit
const { DSEngine } = require('../public/indicator.js');
const fs = require('fs');

function mkCandles(n, startPrice, drift, tfMs) {
  const out = [];
  let p = startPrice;
  const base = Date.now() - n * tfMs;
  for (let i = 0; i < n; i++) {
    // har 5 candle me ek base (chhoti body) + legout (badi body) banao
    const isLegout = i % 5 === 4;
    const range = isLegout ? 18 : 6;
    const open = p;
    const close = isLegout ? p + drift * 14 : p + drift * 1.2;
    const high = Math.max(open, close) + range * 0.3;
    const low = Math.min(open, close) - range * 0.3;
    out.push({ time: base + i * tfMs, open, high, low, close, volume: 100 });
    p = close;
  }
  return out;
}

function freshEngine() {
  // localStorage stub (node me nahi hota)
  global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  delete require.cache[require.resolve('../public/indicator.js')];
  return new DSEngine();
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS — ' + name); }
  else { fail++; console.log('  FAIL — ' + name + (extra ? ' | ' + extra : '')); }
}

// ── Test 1: WAITING setup, entry nahi mili, market target paar → INVALIDATED ──
console.log('\n[1] Entry nahi mili + market target paar → setup khatam, naya zone chance');
{
  const e = freshEngine();
  const c = mkCandles(60, 23000, 1, 3 * 60000);   // upar jaata hua market
  const price = c[c.length - 1].close;
  const r = e.analyze(c, c, c, c, c, price, '3m');
  const s = r.activeSetup;
  if (!s) {
    console.log('  INFO — pehle se setup nahi bana (status=' + r.status + ', reason=' + r.reason + ')');
    // zone na bana ho toh ye normal hai — test 1 skip
  } else {
    console.log('  setup: ' + s.direction + ' ' + s.status + ' entry=' + s.entry.toFixed(1) + ' tgt=' + s.target.toFixed(1));
    if (s.status === 'ENTRY_TRIGGERED') {
      console.log('  INFO — entry already trigger ho gayi (price entry par tha)');
    } else {
      // price ko target ke paar le jao (entry hit hue bina)
      const jump = s.direction === 'BUY' ? s.target + 25 : s.target - 25;
      e.trackTick(jump);
      const st = e.activeByTF['3m'];
      check('setup INVALIDATED ho gaya', !st || st.status === 'INVALIDATED', st ? 'status=' + st.status : 'null');
      // analyze chalao → naya zone dhundna chahiye
      const r2 = e.analyze(c, c, c, c, c, jump, '3m');
      check('naya analysis aaya', !!r2, '');
      console.log('  naya result: status=' + r2.status + (r2.activeSetup ? ' setup=' + r2.activeSetup.direction + ' ' + r2.activeSetup.status : ' reason=' + (r2.reason || '')));
      if (e.history.length) console.log('  history: ' + e.history.map(h => h.status + '(' + (h.reason || '') + ')').join(', '));
    }
  }
}

// ── Test 2: ENTRY_TRIGGERED ke baad target tak koi DOOSRA setup nahi banna chahiye ──
console.log('\n[2] Entry hit → target/SL tak doosra setup NAHI');
{
  const e = freshEngine();
  const c = mkCandles(60, 23000, 1, 3 * 60000);
  let price = c[c.length - 1].close;
  let r = e.analyze(c, c, c, c, c, price, '3m');
  let s = r.activeSetup;
  if (!s) {
    console.log('  INFO — setup nahi bana, skip (reason=' + (r.reason || '') + ')');
  } else {
    console.log('  setup: ' + s.direction + ' ' + s.status + ' entry=' + s.entry.toFixed(1));
    // entry tak price le jao
    e.trackTick(s.entry);
    const live = e.activeByTF['3m'];
    check('entry TRIGGERED', live && live.status === 'ENTRY_TRIGGERED', live ? live.status : 'null');
    if (live && live.status === 'ENTRY_TRIGGERED') {
      // price ke saath-saath chalte raho (target ke beech) — analyze bar bar chalayein
      const mid = s.direction === 'BUY' ? (s.entry + s.target) / 2 : (s.entry + s.target) / 2;
      for (let i = 0; i < 5; i++) {
        e.trackTick(mid);
        r = e.analyze(c, c, c, c, c, mid, '3m');
      }
      const st = e.activeByTF['3m'];
      check('trade LIVE hai — wahi setup active', st && st.status === 'ENTRY_TRIGGERED' && st.entry === s.entry, st ? 'status=' + st.status : 'null');
      console.log('  live setup: ' + (st ? st.direction + ' ' + st.status : 'none'));
      // purana zone used nahi hua (trade abhi chal rahi)
      check('zone abhi used nahi hua', Object.keys(e.usedZones).length === 0, 'used=' + Object.keys(e.usedZones).length);
    }
  }
}

// ── Test 3: TARGET_HIT ke baad → zone used + agla analyze naya zone dhundhta hai ──
console.log('\n[3] Target hit → zone used, agla analyze fresh state');
{
  const e = freshEngine();
  const c = mkCandles(60, 23000, 1, 3 * 60000);
  const price = c[c.length - 1].close;
  let r = e.analyze(c, c, c, c, c, price, '3m');
  let s = r.activeSetup;
  if (!s) {
    console.log('  INFO — setup nahi bana, skip');
  } else {
    e.trackTick(s.entry);
    const live = e.activeByTF['3m'];
    if (live && live.status === 'ENTRY_TRIGGERED') {
      e.trackTick(s.target);
      const after = e.activeByTF['3m'];
      check('target ke baad setup khatam', !after || after.status === 'TARGET_HIT', after ? after.status : 'null');
      check('zone usedZones me gaya', Object.keys(e.usedZones).length === 1, 'used=' + Object.keys(e.usedZones).length);
      check('history me TARGET_HIT', e.history.some(h => h.status === 'TARGET_HIT'), '');
      r = e.analyze(c, c, c, c, c, s.target, '3m');
      console.log('  post-hit analyze: status=' + r.status + (r.activeSetup ? ' naya setup=' + r.activeSetup.direction : ' reason=' + (r.reason || '')));
      check('analyze chala (naya zone/koi na koi result)', !!r.status, '');
      // used zone dobara pick nahi hona chahiye
      const usedKey = Object.keys(e.usedZones)[0];
      check('used zone dobara pick nahi hua', !r.activeSetup || (r.activeSetup.zoneType + '|' + Math.round(r.activeSetup.proximal * 10) / 10 + '|' + Math.round(r.activeSetup.distal * 10) / 10 + '|' + r.activeSetup.zoneTime) !== usedKey, '');
    } else {
      console.log('  INFO — entry nahi trigger hua (status=' + (live ? live.status : 'null') + ')');
    }
  }
}

console.log('\n================================');
console.log('PASS: ' + pass + '  FAIL: ' + fail);
process.exit(fail ? 1 : 0);
