/* ─── DS ZONE BACKTEST — 1 YEAR HISTORICAL DATA FETCH (Groww, chunked) ───
   Groww chart API per request ~1500-3000 candles tak hi deta hai,
   isliye data chhote chunks (month/week) me fetch karke merge kiya jata hai.
   Output: backtest/data/{tf}.json  — [{time,open,high,low,close,volume}, ...]
   ─────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const GROWW = 'https://groww.in/v1/api';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://groww.in/',
  'Origin': 'https://groww.in',
  'Accept': 'application/json'
};

const END = Date.now();
const START = END - 366 * 86400000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchChunk(iv, start, end, tries) {
  const url = `${GROWW}/charting_service/v2/chart/exchange/NSE/segment/CASH/NIFTY?startTimeInMillis=${start}&endTimeInMillis=${end}&intervalInMinutes=${iv}`;
  for (let a = 0; a < (tries || 4); a++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
      clearTimeout(timer);
      if (r.status === 429 || r.status >= 500) { await sleep(1500 * (a + 1)); continue; }
      if (!r.ok) { await sleep(800); continue; }
      const d = await r.json();
      const c = d.candles || [];
      if (!c.length && a < 2) { await sleep(600); continue; }
      return c.map(x => ({ time: x[0] * 1000, open: x[1], high: x[2], low: x[3], close: x[4], volume: x[5] || 0 }));
    } catch (e) { await sleep(1000 * (a + 1)); }
  }
  return null;
}

// chunk size (calendar days) per timeframe — cap se neeche rehna chahiye
const CHUNK_DAYS = { 1: 5, 3: 30, 5: 30, 15: 90, 30: 180 };

async function fetchTf(iv) {
  const file = path.join(DATA_DIR, iv + 'm.json');
  if (fs.existsSync(file)) {
    try {
      const old = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (old.length && END - old[old.length - 1].time < 2 * 86400000) {
        console.log(`[${iv}m] cached: ${old.length} candles (fresh)`);
        return old;
      }
    } catch (e) {}
  }
  const all = new Map();
  let t = START;
  let chunkN = 0, emptyN = 0;
  while (t < END) {
    const end = Math.min(t + CHUNK_DAYS[iv] * 86400000, END);
    const c = await fetchChunk(iv, t, end);
    chunkN++;
    if (c === null) { console.log(`[${iv}m] chunk FAIL ${new Date(t).toISOString().slice(0, 10)}`); emptyN++; }
    else {
      for (const x of c) if (x.time >= START && x.time <= END) all.set(x.time, x);
      if (chunkN % 10 === 0 || CHUNK_DAYS[iv] >= 30) console.log(`[${iv}m] ${new Date(t).toISOString().slice(0, 10)} -> ${all.size} candles`);
      if (!c.length) emptyN++;
    }
    t = end;
    await sleep(350);
  }
  const out = Array.from(all.values()).sort((a, b) => a.time - b.time);
  // session filter: Mon-Fri 09:15-15:30 IST bas
  const sess = out.filter(x => {
    const d = new Date(x.time + 19800000);
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6) return false;
    const m = d.getUTCHours() * 60 + d.getUTCMinutes();
    return m >= 555 && m <= 930;
  });
  fs.writeFileSync(file, JSON.stringify(sess));
  const first = sess.length ? new Date(sess[0].time).toISOString().slice(0, 10) : '-';
  const last = sess.length ? new Date(sess[sess.length - 1].time).toISOString().slice(0, 10) : '-';
  console.log(`[${iv}m] DONE: ${sess.length} candles  ${first} .. ${last}  (chunks:${chunkN} empty:${emptyN})`);
  return sess;
}

(async () => {
  for (const iv of [30, 15, 5, 3, 1]) await fetchTf(iv);
  console.log('ALL DONE');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
