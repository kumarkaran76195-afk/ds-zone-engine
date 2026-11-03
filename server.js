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
const mi = require('./market-intel');

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

// Koi bhi NSE stock (Nifty500/Nifty50 search) — list me na ho to dynamically bana do.
// Groww cash chart + Yahoo (.NS) dono isi se chalte hain.
function getInstrument(sym) {
  const k = String(sym || '').toUpperCase().replace(/[^A-Z0-9&-]/g, '');
  if (!k) return null;
  if (INSTRUMENTS[k]) return INSTRUMENTS[k];
  if (!/^[A-Z][A-Z0-9&-]{0,19}$/.test(k)) return null;
  return { exchange: 'NSE', segment: 'CASH', symbol: k, isIndex: false, yahoo: encodeURIComponent(k) + '.NS' };
}

// D/W/M ke liye poora itihaas chahiye (zones ke liye ~3-10 saal), intraday pehle jaisa
function minsForTf(tf, mktOpen) {
  if (tf >= 43200) return 43200 * 130;    // ~10 saal monthly
  if (tf >= 10080) return 10080 * 530;    // ~10 saal weekly
  if (tf >= 1440) return 1440 * 1400;     // ~1400 din daily
  return mktOpen
    ? (tf <= 1 ? 200 : tf <= 3 ? 1440 : tf <= 5 ? 1440 : tf <= 15 ? 2880 : 4320)
    : 4320;
}

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
    // 3m ka koi Yahoo interval nahi — 1m lao aur 3m me AGGREGATE karo
    // (pehle 3m→'5m' map hota tha → 5m candles 3m manager me setHistory hote
    // the aur bucket mismatch se live candle wipe ho jate the)
    // D/W/M = seedha Yahoo ke apne interval (1d/1wk/1mo), koi aggregation nahi
    const yInt = tfMin >= 43200 ? '1mo' : tfMin >= 10080 ? '1wk' : tfMin >= 1440 ? '1d'
      : tfMin <= 1 ? '1m' : tfMin <= 3 ? '1m' : tfMin <= 5 ? '5m' : tfMin <= 15 ? '15m' : '30m';
    const rangeMap = { '1m': '1d', '5m': '5d', '15m': '1mo', '30m': '1mo', '1d': '5y', '1wk': '10y', '1mo': '10y' };
    const r = rangeMap[yInt] || '5d';
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${inst.yahoo}?interval=${yInt}&range=${r}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) return [];
    const d = await resp.json();
    const result = d.chart && d.chart.result && d.chart.result[0];
    if (!result) return [];
    const ts = result.timestamp || [];
    const q = result.indicators && result.indicators.quote && result.indicators.quote[0];
    if (!q || !ts.length) return [];
    let candles = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.open[i] != null && q.close[i] != null) {
        candles.push({
          time: ts[i] * 1000,
          open: q.open[i], high: q.high[i], low: q.low[i],
          close: q.close[i], volume: (q.volume && q.volume[i]) || 0
        });
      }
    }
    // 1m → requested TF aggregation (3m/2m/4m... whatever)
    if (yInt === '1m' && tfMin > 1) {
      const bucketMs = tfMin * 60000;
      const byBucket = {};
      for (const c of candles) {
        const k = Math.floor(c.time / bucketMs) * bucketMs;
        const b = byBucket[k];
        if (!b) byBucket[k] = { time: k, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
        else {
          b.high = Math.max(b.high, c.high); b.low = Math.min(b.low, c.low);
          b.close = c.close; b.volume += c.volume || 0;
        }
      }
      candles = Object.keys(byBucket).map(k => byBucket[k]).sort((a, b) => a.time - b.time);
    }
    return candles;
  } catch (e) { console.log(`[YAHOO] ${inst.symbol} ERR: ${e.message}`); return []; }
}

// ── Candle fetch cache + in-flight dedup ──
// Har 2s polling + WS + HTTP sab ek hi source ko hit karte the → parallel
// requests stack → timeout/abort flood. Ab: ek symbol+tf par ek hi request
// chalti hai (in-flight), aur result thodi der cache hota hai.
const _candleCache = {};    // key -> { at, data }
const _candleInflight = {}; // key -> Promise
function _cacheTtl(tfMin) {
  // chhota TF = fresh chahiye, bada TF = thodi der purana bhi chalega
  if (tfMin >= 1440) return 60000;        // D/W/M — din me ek baar badalta hai
  if (tfMin <= 1) return 2500;
  if (tfMin <= 3) return 4000;
  if (tfMin <= 5) return 6000;
  return 12000;
}

// fetchCandles ke saath data ka "fetched-at" timestamp — CandleManager isse
// decide karta hai ki live tick fresh hai ya source close (rollback na ho)
async function fetchCandlesWithAt(inst, tfMin, minsBack, allowDemo) {
  const list = await fetchCandles(inst, tfMin, minsBack, allowDemo);
  const key = inst.symbol + '|' + tfMin + '|' + minsBack;
  const hit = _candleCache[key];
  return { list, at: (hit && hit.at) || 0 };
}

// ── Offline demo candles (Groww+Yahoo dono down ho tab chart blank na dikhe) ──
const DEMO_BASE = { NIFTY: 22750, BANKNIFTY: 48500, SENSEX: 75200, FINNIFTY: 21500,
  RELIANCE: 2850, TCS: 3400, INFY: 1550, HDFCBANK: 1650, SBIN: 820, ICICIBANK: 1200,
  ADANIENT: 2400, BAJFINANCE: 6800, ITC: 420, WIPRO: 290, TATAMOTORS: 720 };
function genDemoCandles(sym, tfMin, minsBack) {
  const base = DEMO_BASE[sym] || (INSTRUMENTS[sym] && INSTRUMENTS[sym].isIndex ? 22750 : 1000);
  const n = Math.min(500, Math.max(30, Math.floor(minsBack / tfMin)));
  const bucketMs = tfMin * 60000;
  const now = Date.now();
  const start = Math.floor((now - minsBack * 60000) / bucketMs) * bucketMs;
  let price = base;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = start + i * bucketMs;
    if (t > now) break;
    // simple random walk around base
    const drift = (Math.random() - 0.5) * base * 0.0015;
    const open = price;
    price = Math.max(1, price + drift);
    const close = price;
    const high = Math.max(open, close) * (1 + Math.random() * 0.0008);
    const low = Math.min(open, close) * (1 - Math.random() * 0.0008);
    out.push({ time: t, open: +open.toFixed(2), high: +high.toFixed(2), low: +low.toFixed(2), close: +close.toFixed(2), volume: Math.floor(50000 + Math.random() * 200000) });
  }
  return out;
}

async function fetchCandles(inst, tfMin, minsBack, allowDemo) {
  const key = inst.symbol + '|' + tfMin + '|' + minsBack;
  const ttl = _cacheTtl(tfMin);
  const hit = _candleCache[key];
  // cache fresh ho to seedha wapas (request mat bhejo)
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  // koi aur isi key par request chala raha hai to usi ka result wait karo
  if (_candleInflight[key]) return await _candleInflight[key];

  _candleInflight[key] = (async () => {
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
      const timer = setTimeout(() => controller.abort(), 12000);
      let raw = [];
      try {
        const r = await fetch(url, { headers, signal: controller.signal });
        clearTimeout(timer);
        if (r.ok) {
          const d = await r.json();
          raw = d.candles || [];
        } else {
          console.log(`[GROWW] ${inst.symbol} ${tfMin}m HTTP ${r.status}, falling back to Yahoo`);
        }
      } catch (e) {
        clearTimeout(timer);
        // timeout/abort = expected jab Groww bina key ke hang kare — Yahoo par jao
        console.log(`[GROWW] ${inst.symbol} ${tfMin}m ${e.message}, falling back to Yahoo`);
      }
      if (!raw.length) {
        // Yahoo already returns {time,open,high,low,close,volume} objects — don't re-map as arrays
        const yc = await fetchCandlesYahoo(inst, tfMin, minsBack);
        if (yc.length) {
          _candleCache[key] = { at: Date.now(), data: yc };
          return yc;
        }
        // both sources failed → synthetic demo candles so chart never stays blank
        // (auto-bot/agent ke liye allowDemo=false — fake candles par trade mat karo)
        if (allowDemo !== false) {
          const demo = genDemoCandles(inst.symbol, tfMin, minsBack);
          if (demo.length) {
            console.log(`[DEMO] ${inst.symbol} ${tfMin}m: using synthetic candles (offline)`);
            _candleCache[key] = { at: Date.now(), data: demo };
            return demo;
          }
        }
        raw = [];
      }
      const candles = raw.map(c => ({
        time: c[0] * 1000, open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] || 0
      }));
      // empty result ko zyada der cache mat karo (agle poll me retry)
      _candleCache[key] = { at: Date.now(), data: candles };
      if (!candles.length) delete _candleCache[key];
      return candles;
    } finally {
      delete _candleInflight[key];
    }
  })();
  return await _candleInflight[key];
}

function tick(sym, ltp, ts) {
  if (!ltp || ltp <= 0) return;
  prices[sym] = { ltp, ts };
  Object.keys(mgrs).forEach(k => {
    if (k.startsWith(sym + '_')) {
      const tf = parseInt(k.split('_')[1]);
      // D/W/M bucket exchange-calendar se match nahi karta (epoch floor) — tick se
      // live candle spoil/duplicate hoti hai. Wo sirf periodic source re-sync se chalti hai.
      if (tf >= 1440) return;
      const r = mgrs[k].update(ltp, ts);
      if (r && r.candle) broadcast({ type: 'candle', sym, tf, ltp, ts, candle: r.candle });
    }
  });
  broadcast({ type: 'tick', sym, ltp, ts });
}

// ── FAST LIVE LTP (Groww real-time index quote) ──
// Purane system me LTP = 3m candle close (chart API) — wo 10-60s delayed
// hota tha, isliye candle/entry/SL sab late update hote the (loss ka main
// reason). Ye endpoint Groww ka live LTP deta hai — 1s me tick aata hai.
const _ltpCache = {}; // sym -> { at, v }
async function fetchLiveLTP(inst) {
  if (!inst.isIndex) return 0;   // stocks ke liye chart close hi fallback
  const hit = _ltpCache[inst.symbol];
  if (hit && Date.now() - hit.at < 1000) return hit.v;
  try {
    const url = `${GROWW}/stocks_data/v1/accord_points/exchange/${inst.exchange}/segment/CASH/latest_indices_ohlc/${inst.symbol}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://groww.in/', 'Origin': 'https://groww.in'
      },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!r.ok) return 0;
    const j = await r.json();
    const v = j.value || j.indexIndicativePrice || j.ltp || 0;
    if (v > 0) { _ltpCache[inst.symbol] = { at: Date.now(), v }; return v; }
  } catch (e) {}
  return 0;
}

function startPolling(sym) {
  if (pollers[sym]) return;
  const inst = getInstrument(sym);
  if (!inst) return;
  let lastHistSync = 0, lastHtfSync = 0;
  const poll = async () => {
    if (!isMarketOpen()) {
      broadcast({ type: 'marketStatus', open: false, day: isMarketDay() });
      pollers[sym] = setTimeout(poll, 30000);
      return;
    }
    try {
      // 1) FAST path: real-time LTP se live candle tick karo (1s me fresh)
      let ltp = await fetchLiveLTP(inst);
      // 2) fallback: 3m chart close (pehle ye hi single source tha)
      if (!ltp) {
        const c = await fetchCandles(inst, 3, 1440);
        if (c.length) ltp = c[c.length - 1].close;
      }
      if (ltp) tick(sym, ltp, Date.now());

      // 3) Har 8s: 3m history sync (completed candles correct rahen, live
      //    candle ka close fresher ho to rollback nahi hoga — srcAt se)
      if (Date.now() - lastHistSync > 8000) {
        lastHistSync = Date.now();
        const { list, at } = await fetchCandlesWithAt(inst, 3, 1440);
        if (list.length) getMgr(sym, 3).setHistory(list, at);
      }
      // 4) Har 60s: D/W/M source re-sync (tick manager ko skip karta hai —
      //    exchange-calendar mismatch se bucket spoil na ho; cache TTL bhi 60s)
      if (Date.now() - lastHtfSync > 60000) {
        lastHtfSync = Date.now();
        await Promise.all([1440, 10080, 43200].map(async tf => {
          try {
            const { list, at } = await fetchCandlesWithAt(inst, tf, minsForTf(tf, true));
            if (!list.length) return;
            getMgr(sym, tf).setHistory(list, at);
            broadcast({ type: 'candles', sym, tf, candles: getMgr(sym, tf).get() });
          } catch (e) {}
        }));
      }
    } catch (e) {}
    pollers[sym] = setTimeout(poll, 1000);
  };
  pollers[sym] = setTimeout(poll, 0);
}

// ── LIVE ENTRY SCANNER (Nifty500/50): D/W/M alag-alag tabs · sirf wahi stock jiski
//    LIVE LTP demand zone ke andar ho (entry zaroori nahi ATL par — beech ka best zone) ·
//    row me all-time high + all-time low + beech ka best demand zone E/SL/T ·
//    SECTOR GATE: sector achha perform kare tabhi milega (avg %chg ≥ 0 us TF par).
//    Har 30s me 10 stock batch (D+W+M candles) → poora list ~7 min me ek baar.
const DS_LIST = require(path.join(__dirname, 'public', 'symbols.js'));
const DS_SEC = require(path.join(__dirname, 'public', 'sectors.js'));
const IND = require(path.join(__dirname, 'public', 'indicator.js'));
const _scanSyms = DS_LIST.filter(x => x && x.s && !/NIFTY|SENSEX/.test(x.s));
let _scanIdx = 0, _scanBusy = false;
const _stockScan = {};   // sym -> { sec, ltp, ath, atl, at, zones{1D/1W/1M}, perf{1D/1W/1M} }
const SCAN_TTL = 25 * 60 * 1000;
const BB_TFS = [{ k: '1D', tf: 1440 }, { k: '1W', tf: 10080 }, { k: '1M', tf: 43200 }];

// 1-candle % change (daily = din ka, weekly = hafte ka, monthly = mahine ka)
function _pctChg(list) {
  if (!list || list.length < 2) return 0;
  const last = list[list.length - 1].close, prev = list[list.length - 2].close;
  return prev > 0 ? ((last - prev) / prev) * 100 : 0;
}

// sector performance per TF — scanned stocks ke avg %chg se
function _sectorPerf(tf) {
  const now = Date.now(), sums = {}, cnts = {};
  for (const s of Object.values(_stockScan)) {
    if (now - s.at > SCAN_TTL) continue;
    const p = s.perf ? s.perf[tf] : null;
    if (p == null || !s.sec) continue;
    sums[s.sec] = (sums[s.sec] || 0) + p;
    cnts[s.sec] = (cnts[s.sec] || 0) + 1;
  }
  const out = {};
  for (const k in sums) out[k] = Math.round((sums[k] / cnts[k]) * 100) / 100;
  return out;
}

async function _scanOne(ent) {
  const inst = getInstrument(ent.s);
  if (!inst || inst.isIndex) return;
  const sec = DS_SEC[ent.s] || 'Others';
  const zones = {}, perf = {};
  let ltp = 0, ath = 0, atl = Infinity;
  await Promise.all(BB_TFS.map(async ({ k, tf }) => {
    try {
      // allowDemo=false: fake demo candles (base ~1000) scanner me nahi — fail ho to skip
      const { list } = await fetchCandlesWithAt(inst, tf, minsForTf(tf, true), false);
      if (!list || list.length < 30) return;
      const price = list[list.length - 1].close;
      const lastLow = list[list.length - 1].low || price;   // candle ka low (touch check)
      if (!(price > 0)) return;
      ltp = price;
      // ATH/ATL — har branch apni history se accumulate kare (W/M = lambi history);
      // pehle khatam hone wale branch Infinity ko 0 na kare (race tha — L 0 aa raha tha)
      for (const c of list) { if (c.high > ath) ath = c.high; if (c.low < atl) atl = c.low; }
      perf[k] = _pctChg(list);
      const cc = IND.CandleEngine.classifyAll(list);
      const cl = cc.map(c => c.close);
      const atrArr = IND.ATREngine.calculate(cc);
      const t = IND.TrendEngine.analyze(cl, IND.TrendEngine.sma(cl), atrArr);
      const atrv = atrArr[atrArr.length - 1] || 1;
      const zl = [];
      const det = IND.ZoneEngine.detect(cc, t.trend);   // trend filter: DOWN me demand nahi
      IND.ZoneEngine.markFreshness(det, cc);
      for (const z of det) {
        if (z.type !== 'demand') continue;                        // sirf BUY (demand) zone
        if (z.tested > 2 || z.authentic === false) continue;      // weak/non-auth skip
        if (atrv > 0 && Math.abs(z.proximal - z.distal) / atrv > 1.5) continue;  // wide skip
        const sc = IND.TradeScorer.score(z, t, price, atrv, null);
        if (!sc.tradeable) continue;                              // score ≥ 5
        const entry = z.proximal;
        const sl = z.distal - atrv * 0.10;
        const risk = Math.abs(entry - sl);
        // TOUCH: live/candle price ENTRY (proximal) tak neeche aayi — ya LTP zone ke andar.
        // `lastLow <= E` = is candle ne E tak fall kiya (price upar ho to high/E check galat tha).
        // Zone ke neeche chala gaya = broken, skip. Zaroori nahi ATL par ho.
        const inZone = price <= z.proximal && price >= z.distal;
        const broken = price < z.distal;            // LTP zone ke neeche = toot gaya
        const touched = !broken && (inZone || lastLow <= z.proximal);
        if (!touched) continue;
        const dist = (price - z.proximal) / atrv;   // ATR me doori (neg = zone ke andar)
        // zone all-time high/low ke beech hi hona chahiye (ATL ≤ zone ≤ ATH);
        // atl abhi accumulate hi hua ho to skip mat karo (race guard)
        if (atl !== Infinity && ath > 0 && (z.distal < atl * 0.95 || z.proximal > ath)) continue;
        // SL/TP already hit ho chuka = setup khatam — aisi entry kabhi add mat karo (fake nahi)
        if (price <= sl || price >= entry + risk * 2) continue;
        zl.push({ tf: k, proximal: z.proximal, distal: z.distal, fresh: !!z.fresh, tested: z.tested || 0,
          score: sc.score, entry, sl, tgt: entry + risk * 2, zoneTime: z.zoneTime,
          enter: inZone, touched, dist: Math.round(dist * 100) / 100 });
      }
      zl.sort((a, b) => ((b.enter ? 1 : 0) - (a.enter ? 1 : 0)) ||
        (a.dist - b.dist) || (b.score - a.score));
      zones[k] = zl.slice(0, 3);
    } catch (e) {}
  }));
  if (atl === Infinity) atl = 0;
  const has = ['1D', '1W', '1M'].some(k => zones[k] && zones[k].length);
  if (ltp > 0) {
    const prev = _stockScan[ent.s];
    if (prev) {
      // STICKY OLD ENTRY: purane zones sirf SL/TP hit (sweep) tak zinda hain — rescan par
      // kabhi delete mat karo. Naye touch-zone sirf ADD hote hain (dedupe).
      prev.ltp = ltp;
      if (ath > 0) prev.ath = Math.max(prev.ath || 0, ath);
      if (atl > 0) prev.atl = prev.atl > 0 ? Math.min(prev.atl, atl) : atl;
      prev.at = Date.now();
      prev.perf = Object.assign({}, prev.perf, perf);
      for (const k of ['1D', '1W', '1M']) {
        const old = prev.zones[k] || [];
        const add = (zones[k] || []).filter(nz => !old.some(pz =>
          pz.proximal === nz.proximal && pz.distal === nz.distal));
        if (add.length) {
          prev.zones[k] = old.concat(add).sort((a, b) =>
            ((b.enter ? 1 : 0) - (a.enter ? 1 : 0)) ||
            ((a.dist || 99) - (b.dist || 99)) || (b.score - a.score)).slice(0, 5);
        }
      }
    } else if (has) {
      _stockScan[ent.s] = { sym: ent.s, name: ent.n, sec, ltp, ath, atl, at: Date.now(), zones, perf };
    }
    // NOTE: "zone chhod diya" wale purane delete ko hata diya — hatana sirf SL/TP hit se
  }
}

async function _scanBatch() {
  if (_scanBusy) return;
  _scanBusy = true;
  try {
    for (let i = 0; i < 10 && _scanIdx < _scanSyms.length; i++, _scanIdx++) {
      try { await _scanOne(_scanSyms[_scanIdx]); } catch (e) {}
    }
    if (_scanIdx >= _scanSyms.length) _scanIdx = 0;
  } finally { _scanBusy = false; }
}
setInterval(() => { _scanBatch().catch(() => {}); }, 30000);
_scanBatch().catch(() => {});

// ── SL/TP AUTO-REMOVE: list me jo stock pada hai, uska LTP zone ka SL ya target
//    cross kare to usi zone ko hata do (stock ke saare zone khatam → stock hatao).
//    Uski jagah doosra real stock apne aap top-8 me aa jayega — fake entry kabhi nahi.
//    Har 15s me 10 stock ki rotation (3m close = cached, halka sweep).
let _hitIdx = 0;
async function _hitSweep() {
  const syms = Object.keys(_stockScan);
  if (!syms.length) return;
  const n = syms.length;
  const batch = [];
  for (let i = 0; i < 10 && i < n; i++) batch.push(syms[(_hitIdx + i) % n]);
  _hitIdx = (_hitIdx + 10) % n;
  for (const sym of batch) {
    try {
      const e = _stockScan[sym];
      if (!e) continue;
      const inst = getInstrument(sym);
      if (!inst) continue;
      const c = await fetchCandles(inst, 3, 1440);
      const ltp = c.length ? c[c.length - 1].close : 0;
      if (!(ltp > 0)) continue;
      e.ltp = ltp;                       // LTP bhi fresh karte jao
      let zoneRemoved = false;
      for (const tf of ['1D', '1W', '1M']) {
        const zs = e.zones[tf];
        if (!zs || !zs.length) continue;
        const keep = zs.filter(z => ltp > z.sl && ltp < z.tgt);   // hit → zone out
        if (keep.length !== zs.length) { zoneRemoved = true; e.zones[tf] = keep; }
      }
      const hasAny = ['1D', '1W', '1M'].some(tf => (e.zones[tf] || []).length);
      if (!hasAny) delete _stockScan[sym];       // saare hit = stock list se bahar
      else if (zoneRemoved) e.at = Date.now();   // partial removal — list fresh
    } catch (e) {}
  }
}
setInterval(() => { if (isMarketOpen()) _hitSweep().catch(() => {}); }, 15000);

// response: D/W/M alag-alag tabs + sector summary (gate: sector avg %chg ≥ 0).
// STICKY TOP-8: jo stock ek baar list me aa gaya wo tab tak rahe jab tak uska SL/TP
// hit na ho (sweep usi ko hatata hai). Slot khali hote hi naya best auto add — cap 8.
const _shown = { '1D': [], '1W': [], '1M': [] };
app.get('/api/scan/bestbuy', (req, res) => {
  const now = Date.now();
  const sectors = { '1D': _sectorPerf('1D'), '1W': _sectorPerf('1W'), '1M': _sectorPerf('1M') };
  const tabs = { '1D': [], '1W': [], '1M': [] };
  const rank = (a, b) => ((b.enter ? 1 : 0) - (a.enter ? 1 : 0)) ||
    ((a.zone.dist || 99) - (b.zone.dist || 99)) ||
    (b.zone.score - a.zone.score) ||
    ((b.zone.fresh ? 1 : 0) - (a.zone.fresh ? 1 : 0)) ||
    ((b.secPct == null ? -99 : b.secPct) - (a.secPct == null ? -99 : a.secPct));
  for (const s of Object.values(_stockScan)) {
    if (now - s.at > SCAN_TTL) continue;
    for (const k of ['1D', '1W', '1M']) {
      const zs = (s.zones && s.zones[k]) || [];
      if (!zs.length) continue;
      const sp = sectors[k][s.sec];
      if (sp != null && sp < 0) continue;   // SECTOR GATE: achha perform nahi → mat do
      tabs[k].push({
        sym: s.sym, name: s.name, sec: s.sec, secPct: sp == null ? null : sp,
        ltp: s.ltp, ath: s.ath, atl: s.atl, at: s.at,
        enter: zs.some(z => z.enter), touched: zs.some(z => z.touched),
        zone: zs[0], zones: zs
      });
    }
  }
  for (const k of ['1D', '1W', '1M']) {
    const all = tabs[k].sort(rank);
    const pool = new Map(all.map(x => [x.sym, x]));
    const pinned = _shown[k].filter(s => pool.has(s)).map(s => pool.get(s));  // purane (hit nahi hue)
    const rest = all.filter(x => !_shown[k].includes(x.sym));                  // naye best
    const chosen = pinned.concat(rest).slice(0, 8).sort(rank);                 // cap 8, order = rank
    _shown[k] = chosen.map(x => x.sym);                                        // hit = pool se gaya → agli baar nahi
    tabs[k] = chosen;
  }
  res.json({ ok: true, tabs, sectors, symbols: _scanSyms.length, pos: _scanIdx, at: now });
});

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

// ── Live Option Chain (source: Groww public web) ──
const CHAIN_PAGES = { NIFTY: 'nifty', BANKNIFTY: 'nifty-bank' };
const CHAIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const chainStruct = {};    // sym|expiry -> { at, data }
const chainPriceCache = {}; // ids-signature -> { at, data }
const chainSpotCache = {};  // sym -> { at, v }
const chainInflight = {};

function parseNextData(html) {
  const s = html.indexOf('<script id="__NEXT_DATA__"');
  if (s < 0) return null;
  const a = html.indexOf('>', s) + 1, b = html.indexOf('</script>', a);
  if (a < 1 || b < 0) return null;
  try { return JSON.parse(html.slice(a, b)); } catch (e) { return null; }
}

async function chainStructure(sym, expiry) {
  const page = CHAIN_PAGES[sym];
  if (!page) throw new Error('unsupported symbol');
  const key = sym + '|' + expiry;
  const hit = chainStruct[key];
  if (hit && Date.now() - hit.at < 600000) return hit.data;
  if (chainInflight[key]) return await chainInflight[key];
  chainInflight[key] = (async () => {
    const url = 'https://groww.in/options/' + page + (expiry ? '?expiry=' + encodeURIComponent(expiry) : '');
    const r = await fetch(url, { headers: { 'User-Agent': CHAIN_UA, 'Accept': 'text/html' }, timeout: 15000 });
    if (!r.ok) throw new Error('groww http ' + r.status);
    const j = parseNextData(await r.text());
    const d = j && j.props && j.props.pageProps && j.props.pageProps.data;
    const oc = d && d.optionChain;
    const list = oc && oc.optionContracts;
    if (!list || !list.length) throw new Error('empty chain');
    const ad = oc.aggregatedDetails || {};
    const data = {
      lot: ad.lotSize || (list[0].ce && list[0].ce.marketLot) || 0,
      expiries: ad.expiryDates || [],
      expiry: expiry || ad.currentExpiry || '',
      rows: list.map(x => ({ strike: x.strikePrice / 100, ceId: x.ce && x.ce.growwContractId, peId: x.pe && x.pe.growwContractId }))
    };
    chainStruct[key] = { at: Date.now(), data };
    return data;
  })();
  try { return await chainInflight[key]; } finally { delete chainInflight[key]; }
}

async function chainGetSpot(sym) {
  const hit = chainSpotCache[sym];
  if (hit && Date.now() - hit.at < 5000) return hit.v;
  const r = await fetch(`${GROWW}/stocks_data/v1/accord_points/exchange/NSE/segment/CASH/latest_indices_ohlc/${sym}`,
    { headers: { 'User-Agent': CHAIN_UA, 'Referer': 'https://groww.in/', 'Origin': 'https://groww.in' }, timeout: 8000 });
  if (!r.ok) throw new Error('spot http ' + r.status);
  const j = await r.json();
  const v = j.value || j.indexIndicativePrice || 0;
  chainSpotCache[sym] = { at: Date.now(), v };
  return v;
}

async function chainBatchPrices(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    try {
      const r = await fetch(GROWW + '/stocks_fo_data/v1/tr_live_prices/exchange/NSE/segment/FNO/latest_prices_batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': CHAIN_UA, 'Referer': 'https://groww.in/', 'Origin': 'https://groww.in' },
        body: JSON.stringify(chunk),
        timeout: 8000
      });
      if (r.ok) Object.assign(out, await r.json());
    } catch (e) { console.log('[CHAIN] batch chunk fail:', e.message); }
  }
  return out;
}

app.get('/api/chain/:sym', async (req, res) => {
  try {
    const sym = String(req.params.sym || '').toUpperCase();
    if (!CHAIN_PAGES[sym]) return res.json({ error: 'unsupported symbol' });
    const expiry = String(req.query.expiry || '').replace(/[^0-9-]/g, '');
    const extra = String(req.query.strike || '').split(',').map(x => parseFloat(x)).filter(x => isFinite(x)).slice(0, 20);
    const st = await chainStructure(sym, expiry);
    const spot = await chainGetSpot(sym).catch(() => 0);
    let use = st.rows.filter(r => Math.abs(r.strike - spot) <= 1200 || extra.indexOf(r.strike) >= 0);
    if (use.length < 6) use = st.rows.slice(0, 60);
    const ids = [];
    use.forEach(r => { if (r.ceId) ids.push(r.ceId); if (r.peId) ids.push(r.peId); });
    const sig = ids.join(',');
    let prices = null;
    const pc = chainPriceCache[sig];
    if (pc && Date.now() - pc.at < 4000) prices = pc.data;
    else {
      prices = await chainBatchPrices(ids);
      chainPriceCache[sig] = { at: Date.now(), data: prices };
      const ks = Object.keys(chainPriceCache);
      if (ks.length > 30) delete chainPriceCache[ks[0]];
    }
    const pack = p => p ? {
      ltp: p.ltp || 0, oi: p.openInterest || 0, vol: p.volume || 0,
      chg: p.dayChange || 0, chgP: p.dayChangePerc || 0
    } : { ltp: 0, oi: 0, vol: 0, chg: 0, chgP: 0 };
    const rows = use.map(r => ({ strike: r.strike, ce: pack(prices[r.ceId]), pe: pack(prices[r.peId]) }))
      .sort((a, b) => a.strike - b.strike);
    res.json({ sym, spot, lot: st.lot, expiry: st.expiry, expiries: st.expiries, rows, mktOpen: isMarketOpen(), ts: Date.now() });
  } catch (e) {
    console.log('[CHAIN]', e.message);
    res.status(502).json({ error: e.message });
  }
});


app.get('/api/candles/:sym/:tf', async (req, res) => {
  console.log(`[HTTP] Request: ${req.params.sym} ${req.params.tf}m`);
  try {
    const inst = getInstrument(req.params.sym);
    if (!inst) return res.json({ candles: [] });
    const tf = parseInt(req.params.tf) || 3;
    const mktOpen = isMarketOpen();
    const mins = minsForTf(tf, mktOpen);
    const c = await fetchCandlesWithAt(inst, tf, mins);
    if (c.list.length) getMgr(req.params.sym, tf).setHistory(c.list, c.at);
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
    const inst = getInstrument(data.symbol);
    if (!inst) return;
    (async () => {
      try {
      const reqTf = parseInt(data.interval) || 5;
      const mktOpen = isMarketOpen();
      const mins = minsForTf(reqTf, mktOpen);
      const c = await fetchCandlesWithAt(inst, reqTf, mins);
      if (c.list.length) getMgr(data.symbol, reqTf).setHistory(c.list, c.at);
      const mgrCandles = getMgr(data.symbol, reqTf).get();
      console.log(`[WS] ${data.symbol} ${reqTf}m: ${mgrCandles.length} candles`);
      ws.send(JSON.stringify({ type: 'candles', sym: data.symbol, tf: reqTf, candles: mgrCandles }));

      // bg TFs PARALLEL — pehle sequential the, ek slow/hung fetch baaki sab
      // block karta tha (12s timeout × 4 = 48s tak candles nahi milte the)
      // D/W/M bhi yahan se — panel ke HTF demand zones ko candles chahiye
      const bgTfs = [1,3,5,15,30,1440,10080,43200].filter(t => t !== reqTf);
      await Promise.all(bgTfs.map(async tf => {
        try {
          const bgMins = minsForTf(tf, mktOpen);
          const bc = await fetchCandlesWithAt(inst, tf, bgMins);
          if (bc.list.length) getMgr(data.symbol, tf).setHistory(bc.list, bc.at);
          const bgCandles = getMgr(data.symbol, tf).get();
          ws.send(JSON.stringify({ type: 'candles', sym: data.symbol, tf, candles: bgCandles }));
        } catch (e) { console.log('[WS] bg tf ' + tf + ' fail: ' + e.message); }
      }));

      if (isMarketOpen()) {
        startPolling(data.symbol);
        // turant cached LTP tick bhejo — pehla live tick 1s wait mat karo
        const pr = prices[data.symbol];
        if (pr && pr.ltp) tick(data.symbol, pr.ltp, pr.ts || Date.now());
      }
      else {
        const l1 = getMgr(data.symbol, 3).get();
        if (l1.length) tick(data.symbol, l1[l1.length - 1].close, l1[l1.length - 1].time);
      }
      } catch (e) { console.log('[WS] subscribe fail: ' + e.message); }
    })();
  }
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// ── AUTO BOT: server pe 24/7 auto paper trading (3m+5m zone, 1 lot) — laptop band ho tab bhi chalta hai ──
const createAutoBot = require('./auto-bot');
const autoBot = createAutoBot({
  storeDir: STORE_DIR,
  symbol: 'NIFTY',
  // auto-bot symbol string deta hai — yahan instrument object me badal ke bhejo
  // allowDemo=false: API down ho to bot khali result le (fake candles par trade nahi)
  fetchCandles: (sym, tfMin, minsBack) => fetchCandles(getInstrument(sym) || INSTRUMENTS.NIFTY, tfMin, minsBack, false),
  getMgr, startPolling, isMarketOpen,
  getPrices: () => prices,
  chainQuote: async (symKey, strike, side) => {
    const st = await chainStructure(symKey, '');
    const row = st.rows.find(r => r.strike === strike);
    if (!row) return null;
    const ids = [row.ceId, row.peId].filter(Boolean);
    const pr = await chainBatchPrices(ids);
    const p = side === 'CE' ? pr[row.ceId] : pr[row.peId];
    return { ltp: (p && p.ltp) || 0, lot: st.lot, expiry: st.expiry };
  }
});
autoBot.start();
app.get('/api/autopaper', (req, res) => res.json(autoBot.status()));

// ── MARKET INTELLIGENCE (news + global + FII/DII + calendar + OI) ──
try { if (autoBot.agent && autoBot.agent.setIntel) autoBot.agent.setIntel(mi); } catch (e) {}
try { mi.startPolling(); } catch (e) {}
const miRoute = fn => async (req, res) => { try { res.json(Object.assign({ ok: true }, await fn(req))); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } };
app.get('/api/mi/overview', miRoute(() => mi.overview()));
app.get('/api/mi/news', miRoute(req => mi.newsList(String(req.query.cat || 'market'), Math.min(30, parseInt(req.query.limit, 10) || 15))));
app.get('/api/mi/calendar', miRoute(() => mi.calendar()));
app.get('/api/mi/fiidii', miRoute(() => mi.fiidii()));
app.get('/api/mi/why/:sym', miRoute(req => mi.whyMarket(req.params.sym)));
app.get('/api/mi/oi/:sym', miRoute(req => mi.chainOI(String(req.params.sym).toUpperCase() === 'BANKNIFTY' ? 'BANKNIFTY' : 'NIFTY')));
app.get('/api/mi/stock/:sym', miRoute(async req => ({ sym: req.params.sym, text: await mi.answer('stock:' + String(req.params.sym).toUpperCase().replace(/[^A-Z]/g, ''), '', {}) })));
app.get('/api/mi/journal', miRoute(req => mi.journal(req.query.date || undefined).then(j => ({ journal: j }))));
app.get('/api/mi/timeline', miRoute(async () => mi.timeline()));
app.get('/api/mi/answer', miRoute(async req => { const q = String(req.query.q || '').slice(0, 300); const kind = mi.detect(q); return { kind, text: kind ? await mi.answer(kind, q, {}) : '' }; }));

// ── AI AGENT: chat API (mic/text — app + localhost dono se) ──
app.get('/api/agent', (req, res) => {
  try {
    const s = autoBot.status();
    res.json({ ok: true, agent: autoBot.agent.status(), bot: { tf: s.tf, cash: s.cash, netPnl: s.netPnl, pos: s.pos.length, wins: s.wins, losses: s.losses, mktOpen: s.mktOpen, zones: s.actives || [] } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/agent/chat', async (req, res) => {
  try {
    const q = String((req.body && req.body.q) || '').slice(0, 300);
    if (!q.trim()) return res.json({ ok: false, error: 'sawal khali hai' });
    // user jo timeframe khol rakha hai (3m/5m/15m...) uske live zones ke saath bhejo
    const ctx = autoBot.status();
    const tfRaw = String((req.body && req.body.tf) || '').trim();
    ctx.openTf = /^\d{1,2}$/.test(tfRaw) ? parseInt(tfRaw, 10) + 'm' : (/^\d{1,2}m$/.test(tfRaw) ? tfRaw : '');
    const r = await autoBot.agent.replyAi(q, ctx);
    res.json({ ok: true, q, a: r.a, act: r.act || '', tf: ctx.openTf || '', ts: Date.now() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// ── chain screen (3m/5m zone auto-trade) ke ENTRY/EXIT events → AI agent ko dikhne ke liye ──
app.post('/api/agent/autotrade', (req, res) => {
  try {
    const ev = autoBot.agent.logAutoTrade(req.body || {});
    res.json({ ok: true, ev });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('=========================================');
  console.log('  DS Zone Engine v1.0');
  console.log('  http://localhost:' + PORT);
  console.log('  API Key: ' + (API_KEY !== 'YOUR_API_KEY_HERE' ? 'SET' : 'NOT SET'));
  console.log('=========================================');
  console.log('');
});
