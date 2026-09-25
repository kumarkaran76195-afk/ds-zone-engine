require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const fetch = require('node-fetch');
const nodemailer = require('nodemailer');
const CandleManager = require('./candle-manager');

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

// ── Email OTP Login (APK/Railway only) ──
const otpStore = new Map();   // email -> { code, exp }
const sessions = new Map();   // token -> { email, exp }
const devices = new Map();    // deviceId -> { email, exp }  (1 phone = 1 email)
const OTP_TTL = 5 * 60 * 1000;
const SESSION_TTL = 24 * 60 * 60 * 1000;
const GMAIL_RE = /^[a-z0-9._-]{1,64}@gmail\.com$/;

// persistent store dir: Railway volume (/data) ya local dir
const STORE_DIR = (() => {
  const dir = process.env.STORE_DIR || (fs.existsSync('/data') ? '/data' : __dirname);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  return dir;
})();
console.log('[store dir]', STORE_DIR);

// sessions + devices persist (deploy ke baad bhi login rahe)
function loadJson(name) {
  try {
    const f = path.join(STORE_DIR, name);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) { console.log('[' + name + ' load fail]', e.message); }
  return {};
}
function saveJson(name, obj) {
  try { fs.writeFileSync(path.join(STORE_DIR, name), JSON.stringify(obj)); }
  catch (e) { console.log('[' + name + ' save fail]', e.message); }
}
{
  const now = Date.now();
  for (const [t, s] of Object.entries(loadJson('sessions.json'))) if (s && s.exp > now) sessions.set(t, s);
  for (const [d, v] of Object.entries(loadJson('devices.json'))) if (v && v.exp > now) devices.set(d, v);
}
function saveSessions() {
  const o = {};
  for (const [t, s] of sessions) if (s.exp > Date.now()) o[t] = s;
  saveJson('sessions.json', o);
}
function saveDevices() {
  const o = {};
  for (const [d, v] of devices) if (v.exp > Date.now()) o[d] = v;
  saveJson('devices.json', o);
}

// ── 7-day free trial (per email) ──
const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || '7', 10);
const TRIALS_FILE = path.join(STORE_DIR, 'trials.json');
let trials = new Map();   // email -> { first, last }  (legacy: number = first)
try {
  if (fs.existsSync(TRIALS_FILE)) {
    trials = new Map(Object.entries(JSON.parse(fs.readFileSync(TRIALS_FILE, 'utf8'))));
  }
} catch (e) { console.log('[trials load fail]', e.message); }

function saveTrials() {
  try { fs.writeFileSync(TRIALS_FILE, JSON.stringify(Object.fromEntries(trials))); }
  catch (e) { console.log('[trials save fail]', e.message); }
}

function trialFirst(v) { return typeof v === 'number' ? v : (v && v.first) || Date.now(); }
function trialLast(v) { return typeof v === 'number' ? v : (v && v.last) || trialFirst(v); }

function trialInfo(email) {
  if (paidUsers.has(email)) return { daysLeft: TRIAL_DAYS, expired: false, paid: true };
  const start = trials.get(email);
  if (!start) return { daysLeft: TRIAL_DAYS, expired: false };
  const used = Math.max(0, Date.now() - trialFirst(start));
  const daysLeft = Math.max(0, Math.min(TRIAL_DAYS, TRIAL_DAYS - Math.floor(used / 86400000)));
  return { daysLeft, expired: daysLeft <= 0 };
}

function recordLogin(email) {
  const now = Date.now();
  const prev = trials.get(email);
  if (prev === undefined) trials.set(email, { first: now, last: now });
  else if (typeof prev === 'number') trials.set(email, { first: prev, last: now });
  else prev.last = now;
  saveTrials();
}

// ── Paid (verified tick) users ──
const PAID_FILE = path.join(STORE_DIR, 'paid.json');
let paidUsers = new Map();   // email -> paidAt ts
try {
  if (fs.existsSync(PAID_FILE)) {
    paidUsers = new Map(Object.entries(JSON.parse(fs.readFileSync(PAID_FILE, 'utf8'))));
  }
} catch (e) { console.log('[paid load fail]', e.message); }

function savePaid() {
  try { fs.writeFileSync(PAID_FILE, JSON.stringify(Object.fromEntries(paidUsers))); }
  catch (e) { console.log('[paid save fail]', e.message); }
}

// ── Admin APIs (Karan) ──
const ADMIN_PASS = process.env.ADMIN_PASS || 'karan@123';
function adminAuth(req, res, next) {
  const pass = String(req.headers['x-admin-pass'] || '');
  if (pass !== ADMIN_PASS) return res.status(401).json({ ok: false, error: 'Galat password' });
  next();
}

app.post('/api/admin/login', (req, res) => {
  const pass = String(req.body.pass || '');
  if (pass !== ADMIN_PASS) return res.status(401).json({ ok: false, error: 'Galat password' });
  res.json({ ok: true });
});

app.get('/api/admin/stats', adminAuth, (req, res) => {
  const now = Date.now();
  const active = new Set();
  for (const [, s] of sessions) if (s.exp > now) active.add(s.email);
  res.json({ ok: true, total: trials.size, paid: paidUsers.size, active: active.size });
});

app.get('/api/admin/users', adminAuth, (req, res) => {
  const now = Date.now();
  const activeEmails = new Set();
  for (const [, s] of sessions) if (s.exp > now) activeEmails.add(s.email);
  const list = [];
  for (const [email, start] of trials) {
    const ti = trialInfo(email);
    list.push({ email, since: trialFirst(start), last: trialLast(start), daysLeft: ti.daysLeft, expired: ti.expired, paid: paidUsers.has(email), active: activeEmails.has(email) });
  }
  for (const [email] of paidUsers) {
    if (!trials.has(email)) list.push({ email, since: null, last: null, daysLeft: null, expired: false, paid: true, active: activeEmails.has(email) });
  }
  list.sort((a, b) => (b.last || b.since || 0) - (a.last || a.since || 0));
  res.json({ ok: true, users: list });
});

app.post('/api/admin/paid', adminAuth, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const paid = !!req.body.paid;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'Invalid email' });
  }
  if (paid) paidUsers.set(email, Date.now());
  else paidUsers.delete(email);
  savePaid();
  console.log(`[admin] ${email} paid=${paid}`);
  res.json({ ok: true });
});

async function sendOtpMail(to, code) {
  const brevoKey = process.env.BREVO_API_KEY;
  if (!brevoKey) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': brevoKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: 'DS Zone Engine', email: process.env.BREVO_SENDER || 'karanahuja623988@gmail.com' },
        to: [{ email: to }],
        subject: 'Your DS Zone Engine Login OTP',
        textContent: `Your OTP is: ${code}\nValid for 5 minutes. Do not share it.`,
        htmlContent: `<p>Your OTP is:</p><h2 style="letter-spacing:6px">${code}</h2><p>Valid for 5 minutes. Do not share it.</p>`
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (r.ok) {
      console.log(`[OTP] Brevo sent to ${to}`);
      return true;
    }
    const errText = await r.text();
    console.log(`[OTP Brevo fail] HTTP ${r.status}: ${errText}`);
  } catch (e) {
    console.log('[OTP Brevo fail]', e.message);
  }
  return false;
}

app.post('/api/otp/send', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Invalid email' });
    }
    if (!GMAIL_RE.test(email)) {
      return res.status(400).json({ ok: false, error: 'Sirf Gmail ID se login ho sakta hai' });
    }
    const code = String(crypto.randomInt(100000, 1000000));
    otpStore.set(email, { code, exp: Date.now() + OTP_TTL });
    if (process.env.OTP_DEBUG === '1') console.log('[OTP-DEBUG]', email, code);
    const sent = await sendOtpMail(email, code);
    if (sent) return res.json({ ok: true });
    console.log(`[OTP send fail] ${email}`);
    return res.json({ ok: false, error: 'OTP send failed, try again' });
  } catch (e) {
    console.log('[OTP send error]', e.message);
    return res.status(500).json({ ok: false, error: 'Failed to send OTP' });
  }
});

app.post('/api/otp/verify', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.otp || '').trim();
  const deviceId = String(req.body.deviceId || '').slice(0, 64);
  if (!GMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, error: 'Sirf Gmail ID se login ho sakta hai' });
  }
  const rec = otpStore.get(email);
  if (!rec || rec.exp < Date.now()) {
    otpStore.delete(email);
    return res.status(400).json({ ok: false, error: 'OTP expired, request a new one' });
  }
  if (rec.code !== code) {
    return res.status(400).json({ ok: false, error: 'Wrong OTP' });
  }
  if (deviceId) {
    const dev = devices.get(deviceId);
    if (dev && dev.exp > Date.now() && dev.email !== email) {
      otpStore.delete(email);
      return res.status(403).json({ ok: false, error: 'Is phone par pehle se ek account login hai. Ek phone par ek hi email se login ho sakta hai.' });
    }
  }
  otpStore.delete(email);
  recordLogin(email);
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { email, exp: Date.now() + SESSION_TTL });
  if (deviceId) devices.set(deviceId, { email, exp: Date.now() + SESSION_TTL });
  saveSessions();
  saveDevices();
  res.json({ ok: true, token, trial: trialInfo(email) });
});

app.post('/api/otp/session', (req, res) => {
  const token = String(req.body.token || '');
  const s = sessions.get(token);
  if (!s || s.exp < Date.now()) {
    sessions.delete(token);
    return res.json({ ok: false });
  }
  res.json({ ok: true, email: s.email, trial: trialInfo(s.email) });
});

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

app.get('/download', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'download.html'));
});
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: Date.now() }));

app.post('/api/crash', (req, res) => {
  try {
    console.log('[CRASH]', JSON.stringify(req.body));
  } catch (e) { console.log('[CRASH] log fail]', e.message); }
  res.json({ ok: true });
});
app.get('/api/instruments', (req, res) => res.json(INSTRUMENTS));

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
