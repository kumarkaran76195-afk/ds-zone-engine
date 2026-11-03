// syncFreshZones runtime test — mock chart/DOM se verify:
// har zone ke liye box + E/SL/T lines + labels bante hain, active zone skip hota hai,
// clearZoneBoxes sab karta hai (labels bhi)
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(__dirname + '/../public/app.js', 'utf8');

// ── extract functions we need (freshZoneKey, clearZoneBoxes, syncFreshZones, addZoneLbl, addLbl) ──
function extract(name) {
  const i = src.indexOf('function ' + name);
  if (i < 0) throw new Error(name + ' not found');
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error(name + ' unclosed');
}

const code = ['tfKey', 'freshZoneKey', 'clearZoneBoxes', 'syncFreshZones', 'addZoneLbl', 'addLbl'].map(extract).join('\n');

// ── mocks ──
const removedSeries = [], removedEls = [];
let seriesCount = 0;
const chart = {
  addBaselineSeries(opts) { seriesCount++; const o = { _type: 'baseline', opts, data: null, setData(d) { this.data = d; } }; return o; },
  addLineSeries(opts) { seriesCount++; const o = { _type: 'line', opts, data: null, setData(d) { this.data = d; } }; return o; },
  removeSeries(s) { removedSeries.push(s); }
};
const labelsEl = { appendChild(el) { el._parent = this; } };
const ctx = {
  console,
  chart,
  chartInitDone: true,
  zoneBoxLines: [], zoneLbls: [], labels: [], zoneLines: [], lastZoneKey: '',
  simpleAtr: () => 20,   // ATR = 20 points
  document: { createElement: () => ({ className: '', innerHTML: '', style: {}, remove() { removedEls.push(this); } }), getElementById: () => labelsEl },
  candleS: { priceScale: () => ({ priceToCoordinate: p => p / 10 }) },
  Math, Number, isFinite,
  debugLog: () => {}
};
vm.createContext(ctx);
vm.runInContext(code + '\nthis.syncFreshZones = syncFreshZones; this.clearZoneBoxes = clearZoneBoxes;', ctx);

// ── data: 2 fresh zones (1 demand + 1 supply) ──
const now = Math.floor(Date.now() / 1000);
ctx.allC = { NIFTY_5: [
  { time: (now - 3600) * 1000, open: 1, high: 1, low: 1, close: 1 },
  { time: now * 1000, open: 1, high: 1, low: 1, close: 1 }
]};
ctx.sym = 'NIFTY'; ctx.tf = 5;
ctx.lastA = {
  price: 23100, atr: 20,
  activeSetup: { proximal: 23120, distal: 23100, direction: 'BUY' },   // active zone
  allZonesByTF: { '5m': [
    // zone 1: active setup wala (skip E/SL/T, sirf box)
    { type: 'demand', proximal: 23120, distal: 23100, zoneTime: (now - 3000) * 1000, fresh: true, authentic: true },
    // zone 2: naya zone — E/SL/T + label chahiye
    { type: 'supply', proximal: 23160, distal: 23180, zoneTime: (now - 2000) * 1000, fresh: true, authentic: true },
    // zone 3: tested zone — dashed lines + label chahiye
    { type: 'demand', proximal: 23050, distal: 23030, zoneTime: (now - 1000) * 1000, fresh: false, authentic: true }
  ]}
};

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  PASS — ' + n); } else { fail++; console.log('  FAIL — ' + n + (x ? ' | ' + x : '')); } };

console.log('[1] syncFreshZones — boxes + E/SL/T + labels');
ctx.syncFreshZones();
const boxes = ctx.zoneBoxLines.filter(s => s._type === 'baseline');
const lines = ctx.zoneBoxLines.filter(s => s._type === 'line');
check('3 zone boxes bane', boxes.length === 3, 'boxes=' + boxes.length);
check('active zone ke E/SL/T skip (sirf 2 zones × 3 lines = 6)', lines.length === 6, 'lines=' + lines.length);
check('labels = 2 zones × 3 = 6', ctx.zoneLbls.length === 6, 'lbls=' + ctx.zoneLbls.length);
check('labels labels array me bhi hain', ctx.zoneLbls.every(l => ctx.labels.includes(l)), '');
check('labels DOM me attached', ctx.zoneLbls.every(l => l._parent), '');

// E/SL/T values verify (zone 2 supply: E=23160, SL=23180+2=23182, T=23160-2*22=23116)
const zone2Lines = lines.filter(s => Math.abs(s.data[0].value - 23160) < 5 || Math.abs(s.data[0].value - 23182) < 5 || Math.abs(s.data[0].value - 23116) < 5);
check('supply zone SL = distal + 0.1×ATR = 23182', lines.some(s => Math.abs(s.data[0].value - 23182) < 0.001), 'vals=' + lines.map(s => s.data[0].value).join(','));
check('supply zone T = E - 2×risk = 23116', lines.some(s => Math.abs(s.data[0].value - 23116) < 0.001), '');
const lblTexts = ctx.zoneLbls.map(l => l.innerHTML).join(' | ');
check('labels me E/SL/T prices hain', lblTexts.includes('E 23160') && lblTexts.includes('SL 23182') && lblTexts.includes('T 23116'), lblTexts);
check('tested zone dashed (lineStyle=2)', lines.some(s => s.opts.lineStyle === 2), '');
check('fresh zone solid (lineStyle=0)', lines.some(s => s.opts.lineStyle === 0), '');

console.log('\n[2] dobara call — same key par redraw NAHI (no flicker)');
seriesCount = 0; removedSeries.length = 0;
ctx.syncFreshZones();
check('koi naya series nahi bana', seriesCount === 0, 'new=' + seriesCount);
check('koi remove nahi hua', removedSeries.length === 0, 'rm=' + removedSeries.length);

console.log('\n[3] zone badalne par purana clear + naya draw');
ctx.lastA.allZonesByTF['5m'] = [
  { type: 'demand', proximal: 23200, distal: 23180, zoneTime: (now - 500) * 1000, fresh: true, authentic: true }
];
const oldLblCount = ctx.labels.length;
ctx.syncFreshZones();
check('purane zone series remove hue', removedSeries.length >= 9, 'rm=' + removedSeries.length);
check('purane zone labels remove hue', removedEls.length === 6, 'elrm=' + removedEls.length);
check('labels array me purane zone label nahi', ctx.labels.length === 3, 'labels=' + ctx.labels.length);
check('zoneLbls me naye 3 hain', ctx.zoneLbls.length === 3, 'zoneLbls=' + ctx.zoneLbls.length);
check('naya box bana', ctx.zoneBoxLines.filter(s => s._type === 'baseline').length === 1, '');

console.log('\n[4] clearZoneBoxes — sab clear (series + labels)');
ctx.clearZoneBoxes();
check('zoneBoxLines empty', ctx.zoneBoxLines.length === 0, '');
check('zoneLbls empty', ctx.zoneLbls.length === 0, '');
check('labels array se bhi gaye', ctx.labels.length === 0, 'labels=' + ctx.labels.length);

console.log('\n================================');
console.log('PASS: ' + pass + '  FAIL: ' + fail);
process.exit(fail ? 1 : 0);
