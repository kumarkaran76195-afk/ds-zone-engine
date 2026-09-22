require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const CandleManager = require('./candle-manager');

const TRIAL_DAYS = 7;
const TRIAL_FILE = path.join(__dirname, 'trial-users.json');
function loadTrialUsers() { try { return JSON.parse(fs.readFileSync(TRIAL_FILE, 'utf8')); } catch (e) { return {}; } }
function saveTrialUsers(d) { fs.writeFileSync(TRIAL_FILE, JSON.stringify(d, null, 2)); }

const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.API_KEY || 'YOUR_API_KEY_HERE';
const GROWW = process.env.API_BASE_URL || 'https://groww.in/v1/api';

const INSTRUMENTS = {
  'NIFTY':     { exchange: 'NSE', segment: 'CASH', symbol: 'NIFTY', isIndex: true, yahoo: '%5ENSEI' },
  'BANKNIFTY': { exchange: 'NSE', segment: 'CASH', symbol: 'BANKNIFTY', isIndex: true, yahoo: '%5ENSEBANK' },
  'SENSEX':    { exchange: 'BSE', segment: 'CASH', symbol: 'SENSEX', isIndex: true, yahoo: '%5EBSESN' },
  'FINNIFTY':  { exchange: 'NSE', segment: 'CASH', symbol: 'FINNIFTY', isIndex: true, yahoo: 'NIFTYFIN%2ENS' },
  'RELIANCE':  { exchange: 'NSE', segment: 'CASH', symbol: 'RELIANCE', isIndex: false, yahoo: 'RELIANCE%2ENS' },
  'TCS':       { exchange: 'NSE', segment: 'CASH', symbol: 'TCS', isIndex: false, yahoo: 'TCS%2ENS' },
  'INFY':      { exchange: 'NSE', segment: 'CASH', symbol: 'INFY', isIndex: false, yahoo: 'INFY%2ENS' },
  'HDFCBANK':  { exchange: 'NSE', segment: 'CASH', symbol: 'HDFCBANK', isIndex: false, yahoo: 'HDFCBANK%2ENS' },
  'SBIN':      { exchange: 'NSE', segment: 'CASH', symbol: 'SBIN', isIndex: false, yahoo: 'SBIN%2ENS' },
  'ICICIBANK': { exchange: 'NSE', segment: 'CASH', symbol: 'ICICIBANK', isIndex: false, yahoo: 'ICICIBANK%2ENS' },
  'ADANIENT':  { exchange: 'NSE', segment: 'CASH', symbol: 'ADANIENT', isIndex: false, yahoo: 'ADANIENT%2ENS' },
  'BAJFINANCE':{ exchange: 'NSE', segment: 'CASH', symbol: 'BAJFINANCE', isIndex: false, yahoo: 'BAJFINANCE%2ENS' },
  'ITC':       { exchange: 'NSE', segment: 'CASH', symbol: 'ITC', isIndex: false, yahoo: 'ITC%2ENS' },
  'WIPRO':     { exchange: 'NSE', segment: 'CASH', symbol: 'WIPRO', isIndex: false, yahoo: 'WIPRO%2ENS' },
  'TATAMOTORS':{ exchange: 'NSE', segment: 'CASH', symbol: 'TATAMOTORS', isIndex: false, yahoo: 'TATAMOTORS%2ENS' }
};

const mgrs = {};
const pollers = {};
const prices = {};
const clients = new Set();

function getIST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
}

function isMarketOpen() {
  const ist = getIST();
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return mins >= 555 && mins <= 930;
}

function isMarketDay() {
  return getIST().getDay() !== 0 && getIST().getDay() !== 6;
}

function getMgr(sym, tf) {
  const k = sym + '_' + tf;
  if (!mgrs[k]) mgrs[k] = new CandleManager(tf);
  return mgrs[k];
}

async function fetchCandlesYahoo(inst, tfMin, range) {
  try {
    const interval = tfMin <= 1 ? '1m' : tfMin <= 5 ? '5m' : tfMin <= 15 ? '15m' : '1d';
    const rangeMap = { '1m': '1d', '5m': '5d', '15m': '1mo', '1d': '1mo' };
    const r = rangeMap[interval] || '5d';
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${inst.yahoo}?interval=${interval}&range=${r}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) return [];
    const d = await resp.json();
    const result = d.chart && d.chart.result && d.chart.result[0];
    if (!result) return [];
    const ts = result.timestamp || [];
    const q = result.indicators && result.indicators.quote && result.indicators.quote[0];
    if (!q || !ts.length) return [];
    const candles = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.open[i] != null && q.close[i] != null) {
        candles.push({
          time: ts[i] * 1000,
          open: q.open[i], high: q.high[i], low: q.low[i],
          close: q.close[i], volume: (q.volume && q.volume[i]) || 0
        });
      }
    }
    return candles;
  } catch (e) { console.log(`[YAHOO] ${inst.symbol} ERR: ${e.message}`); return []; }
}

async function fetchCandles(inst, tfMin, minsBack) {
  try {
    const now = Date.now(), start = now - minsBack * 60000;
    const url = `${GROWW}/charting_service/v2/chart/exchange/${inst.exchange}/segment/${inst.segment}/${inst.symbol}?startTimeInMillis=${start}&endTimeInMillis=${now}&intervalInMinutes=${tfMin}`;
    const headers = {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://groww.in/',
      'Origin': 'https://groww.in',
      'Accept-Language': 'en-US,en;q=0.9'
    };
    if (API_KEY && API_KEY !== 'YOUR_API_KEY_HERE') {
      headers['Authorization'] = 'Bearer ' + API_KEY;
      headers['X-API-KEY'] = API_KEY;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const r = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);
    if (!r.ok) { console.log(`[GROWW] ${inst.symbol} ${tfMin}m HTTP ${r.status}, falling back to Yahoo`); return await fetchCandlesYahoo(inst, tfMin, minsBack); }
    const d = await r.json();
    const raw = d.candles || [];
    if (!raw.length) { console.log(`[GROWW] ${inst.symbol} no candles, falling back to Yahoo`); return await fetchCandlesYahoo(inst, tfMin, minsBack); }
    return raw.map(c => ({
      time: c[0] * 1000, open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] || 0
    }));
  } catch (e) { console.log(`[GROWW] ${inst.symbol} ERR: ${e.message}, falling back to Yahoo`); return await fetchCandlesYahoo(inst, tfMin, minsBack); }
}

function tick(sym, ltp, ts) {
  if (!ltp || ltp <= 0) return;
  prices[sym] = { ltp, ts };
  Object.keys(mgrs).forEach(k => {
    if (k.startsWith(sym + '_')) {
      const tf = parseInt(k.split('_')[1]);
      const r = mgrs[k].update(ltp, ts);
      if (r && r.candle) broadcast({ type: 'candle', sym, tf, ltp, ts, candle: r.candle });
    }
  });
  broadcast({ type: 'tick', sym, ltp, ts });
}

function startPolling(sym) {
  if (pollers[sym]) return;
  const inst = INSTRUMENTS[sym];
  if (!inst) return;
  const poll = async () => {
    if (!isMarketOpen()) {
      broadcast({ type: 'marketStatus', open: false, day: isMarketDay() });
      pollers[sym] = setTimeout(poll, 30000);
      return;
    }
    try {
      const c = await fetchCandles(inst, 3, 1440);
      if (c.length) tick(sym, c[c.length - 1].close, c[c.length - 1].time);
    } catch (e) {}
    pollers[sym] = setTimeout(poll, 2000);
  };
  pollers[sym] = setTimeout(poll, 0);
}

app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: false }));
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: Date.now() }));
app.get('/api/instruments', (req, res) => res.json(INSTRUMENTS));

app.post('/api/register', (req, res) => {
  const { phone, deviceId } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  const cleanPhone = (phone || '').replace(/\D/g, '');
  if (cleanPhone.length !== 10 || /^[0-9]{10}$/.test(cleanPhone) === false) {
    return res.json({ ok: false, msg: 'Sahi 10 digit phone number daalo' });
  }
  const db = loadTrialUsers();
  for (const k of Object.keys(db)) {
    if (db[k].phone === cleanPhone) {
      return res.json({ ok: true, msg: 'Already registered', key: k });
    }
    if (db[k].deviceId === deviceId && !db[k].activated) {
      return res.json({ ok: true, msg: 'Already registered', key: k });
    }
    if (db[k].ip === ip && !db[k].activated) {
      return res.json({ ok: true, msg: 'Already registered', key: k });
    }
  }
  const key = 'U' + Date.now().toString(36).toUpperCase();
  db[key] = { phone: cleanPhone, deviceId, ip, start: Date.now(), activated: false };
  saveTrialUsers(db);
  res.json({ ok: true, key, msg: 'Registered' });
});

app.get('/api/trial', (req, res) => {
  const deviceId = req.query.deviceId || '';
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  const db = loadTrialUsers();
  for (const k of Object.keys(db)) {
    const u = db[k];
    if (u.activated) continue;
    if (u.deviceId === deviceId || u.ip === ip) {
      const elapsed = (Date.now() - u.start) / (1000 * 60 * 60 * 24);
      if (elapsed >= TRIAL_DAYS) return res.json({ active: false, daysLeft: 0, key: k });
      return res.json({ active: true, daysLeft: Math.ceil(TRIAL_DAYS - elapsed), key: k });
    }
  }
  res.json({ active: true, daysLeft: TRIAL_DAYS, new: true });
});

app.get('/api/admin/users', (req, res) => {
  const pass = req.query.pass;
  if (pass !== 'dszone2026') return res.json({ error: 'Wrong password' });
  const db = loadTrialUsers();
  const users = Object.entries(db).map(([k, v]) => {
    const elapsed = (Date.now() - v.start) / (1000 * 60 * 60 * 24);
    return { key: k, phone: v.phone, start: new Date(v.start).toLocaleDateString('en-IN'), daysUsed: Math.floor(elapsed), activated: v.activated };
  });
  res.json({ total: users.length, users });
});

app.get('/api/admin/activate', (req, res) => {
  const { key, pass } = req.query;
  if (pass !== 'dszone2026') return res.json({ error: 'Wrong password' });
  const db = loadTrialUsers();
  if (!db[key]) return res.json({ error: 'User not found' });
  db[key].activated = true;
  db[key].activatedAt = Date.now();
  saveTrialUsers(db);
  res.json({ ok: true, msg: key + ' activated!' });
});

app.get('/api/admin/reset', (req, res) => {
  const { pass } = req.query;
  if (pass !== 'dszone2026') return res.json({ error: 'Wrong password' });
  saveTrialUsers({});
  res.json({ ok: true, msg: 'All users cleared!' });
});

app.get('/api/candles/:sym/:tf', async (req, res) => {
  console.log(`[HTTP] Request: ${req.params.sym} ${req.params.tf}m`);
  try {
    const inst = INSTRUMENTS[req.params.sym];
    if (!inst) return res.json({ candles: [] });
    const tf = parseInt(req.params.tf) || 3;
    const mktOpen = isMarketOpen();
    const mins = mktOpen
      ? (tf <= 1 ? 200 : tf <= 3 ? 1440 : tf <= 5 ? 1440 : tf <= 15 ? 2880 : 4320)
      : 4320;
    const c = await fetchCandles(inst, tf, mins);
    if (c.length) getMgr(req.params.sym, tf).setHistory(c);
    const mgrCandles = getMgr(req.params.sym, tf).get();
    res.json({ candles: mgrCandles, mktOpen });
  } catch (e) { res.json({ candles: [], error: e.message }); }
});

wss.on('connection', ws => {
  clients.add(ws);
  ws.on('message', msg => { try { handleMsg(ws, JSON.parse(msg.toString())); } catch (e) {} });
  ws.on('close', () => clients.delete(ws));
  ws.send(JSON.stringify({ type: 'connected' }));
  ws.send(JSON.stringify({ type: 'marketStatus', open: isMarketOpen(), day: isMarketDay() }));
});

function handleMsg(ws, data) {
  if (data.action === 'subscribe') {
    const inst = INSTRUMENTS[data.symbol];
    if (!inst) return;
    (async () => {
      const reqTf = parseInt(data.interval) || 5;
      const mktOpen = isMarketOpen();
      const mins = mktOpen
        ? (reqTf <= 1 ? 200 : reqTf <= 3 ? 1440 : reqTf <= 5 ? 1440 : reqTf <= 15 ? 2880 : 4320)
        : 4320;
      const c = await fetchCandles(inst, reqTf, mins);
      if (c.length) getMgr(data.symbol, reqTf).setHistory(c);
      const mgrCandles = getMgr(data.symbol, reqTf).get();
      console.log(`[WS] ${data.symbol} ${reqTf}m: ${mgrCandles.length} candles`);
      ws.send(JSON.stringify({ type: 'candles', sym: data.symbol, tf: reqTf, candles: mgrCandles }));

      const bgTfs = [1,3,5,15,30].filter(t => t !== reqTf);
      for (const tf of bgTfs) {
        const bgMins = mktOpen
          ? (tf <= 1 ? 200 : tf <= 3 ? 1440 : tf <= 5 ? 1440 : tf <= 15 ? 2880 : 4320)
          : 4320;
        const bc = await fetchCandles(inst, tf, bgMins);
        if (bc.length) getMgr(data.symbol, tf).setHistory(bc);
        const bgCandles = getMgr(data.symbol, tf).get();
        ws.send(JSON.stringify({ type: 'candles', sym: data.symbol, tf, candles: bgCandles }));
      }

      if (isMarketOpen()) startPolling(data.symbol);
      else {
        const l1 = getMgr(data.symbol, 3).get();
        if (l1.length) tick(data.symbol, l1[l1.length - 1].close, l1[l1.length - 1].time);
      }
    })();
  }
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('=========================================');
  console.log('  DS Zone Engine v1.0');
  console.log('  http://localhost:' + PORT);
  console.log('  API Key: ' + (API_KEY !== 'YOUR_API_KEY_HERE' ? 'SET' : 'NOT SET'));
  console.log('=========================================');
  console.log('');
});
