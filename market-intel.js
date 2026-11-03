/* ──────────────────────────────────────────────────────────────────
   market-intel.js — REAL-TIME TRADING INTELLIGENCE LAYER
   Sources (keyless + 3 API keys): Groww, Yahoo, NSE, NewsAPI,
   Finnhub, Twelve Data, RSS (ET/MC/Livemint/BS/NDTV/CNBC/Fed/FXStreet),
   ForexFactory calendar.
   Rules:
     • har fetch → { src, fetchedAt, status } (LIVE|DELAYED|UNVERIFIED|UNAVAILABLE)
     • NO FABRICATION — data na ho to exact UNAVAIL text
     • news = facts + verification; interpretation alag label
     • polling explicit (startPolling) — require karne se kuch chalta nahi
   ────────────────────────────────────────────────────────────────── */
'use strict';
require('dotenv').config();

const fs = require('fs');
const path = require('path');

const KEYS = {
  newsapi: process.env.NEWSAPI_KEY || '',
  finnhub: process.env.FINNHUB_KEY || '',
  twelve: process.env.TWELVE_DATA_KEY || ''
};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const STORE = process.env.MI_STORE_DIR || process.env.STORE_DIR || (fs.existsSync('/data') ? '/data' : __dirname);
const UNAVAIL = 'Is information ko verify karne ke liye current data available nahi hai.';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ── HINDI TRANSLATION (Gemini, optional) — headlines Hindi me; key fail ho to original title ── */
const GEM_KEY = process.env.GEMINI_API_KEY || '';
const GEM_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const GEM_MODELS = [process.env.GEMINI_MODEL || '', 'gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-3.5-flash'].filter(Boolean);
const hiCache = new Map();
async function geminiText(model, prompt) {
  try {
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 9000);
    const r = await fetch(GEM_BASE + model + ':generateContent', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEM_KEY },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 1000 } })
    });
    clearTimeout(to);
    if (!r.ok) return null;
    const j = await r.json();
    const t = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text;
    return t || null;
  } catch (e) { return null; }
}
async function hiTrans(arr) {
  if (!GEM_KEY || !Array.isArray(arr) || !arr.length) return arr;
  const need = [];
  for (const t of arr) { const s = String(t || ''); if (s && !hiCache.has(s) && /[A-Za-z]{4,}/.test(s) && !need.includes(s)) need.push(s); }
  let bi = 0;
  while (bi < need.length) {          // saare uncached titles — sirf pehle 10 tak simit nahi
    const batch = need.slice(bi, bi + 20);
    let any = false;
    const prompt = 'Translate these English news headlines into natural Hindi. Keep company/stock/ticker names recognisable (Devanagari ya original). Return ONLY a JSON array of translated strings in the same order, no explanations — do NOT repeat or keep the original English headline text in any translation:\n' + JSON.stringify(batch);
    for (const m of GEM_MODELS) {
      const out = await geminiText(m, prompt);
      if (out) {
        try {
          const s = out.replace(/```[a-z]*/gi, '').trim();
          const j = JSON.parse(s.slice(s.indexOf('['), s.lastIndexOf(']') + 1));
          if (Array.isArray(j)) {
            batch.forEach((t, i) => {
              if (j[i]) {
                let v = String(j[i]).slice(0, 260);
                // model kabhi original English prefix chipka de ("English: Hindi") — use hatao, sirf Hindi dikhao
                const ot = String(t);
                if (v.indexOf(ot) === 0) v = v.slice(ot.length).replace(/^[\s:;,\-–—]+/, '');
                hiCache.set(t, v || ot);
              }
            });
            if (batch.some(t => hiCache.has(t))) { any = true; break; }
          }
        } catch (e) {}
      }
    }
    if (!any) break;                  // model fail — cached wale rehne do, aage mat kodo
    bi += batch.length;
  }
  return arr.map(t => hiCache.get(String(t)) || t);
}
function hTitle(n) { return n.titleHi || n.title; }

/* ── time helpers (IST) ── */
function pad(n) { return n < 10 ? '0' + n : '' + n; }
function istNow(ts) {
  const d = new Date((ts == null ? Date.now() : ts) + 5.5 * 3600 * 1000);
  return {
    y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
    hh: d.getUTCHours(), mm: d.getUTCMinutes(), dow: d.getUTCDay(),
    date: d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()),
    clock: pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()),
    tzh: d.getUTCHours() * 60 + d.getUTCMinutes()
  };
}
function istDate(ts) { return istNow(ts).date; }
function fmtIst(ts) {
  const p = istNow(ts);
  const ampm = p.hh < 12 ? 'AM' : 'PM';
  const h12 = p.hh % 12 === 0 ? 12 : p.hh % 12;
  return p.d + ' ' + MON[p.m - 1] + ' ' + h12 + ':' + pad(p.mm) + ' ' + ampm;
}
function isMkt(ts) { const p = istNow(ts); return p.dow >= 1 && p.dow <= 5 && p.tzh >= 555 && p.tzh <= 930; }
function fmtPct(v) { return v == null ? '--' : (v > 0 ? '+' : '') + (+v).toFixed(2) + '%'; }

/* ── fetch with timeout ── */
async function fetchT(url, opts, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 12000);
  try {
    const r = await fetch(url, Object.assign({ signal: ctl.signal, headers: Object.assign({ 'User-Agent': UA }, (opts && opts.headers) || {}) }, opts || {}));
    if (!r.ok) { const e = new Error('http ' + r.status); e.http = r.status; throw e; }
    return r;
  } finally { clearTimeout(t); }
}
async function fetchJson(url, opts, ms) { const r = await fetchT(url, opts, ms); return r.json(); }

/* ── cache ── */
const cache = new Map();
function cGet(k, ttl) { const h = cache.get(k); if (h && Date.now() - h.at < ttl) return h.v; return null; }
function cSet(k, v) { cache.set(k, { at: Date.now(), v }); if (cache.size > 300) { const first = cache.keys().next().value; cache.delete(first); } }
function wrap(src, status, data) { return { src, status, fetchedAt: Date.now(), data: data == null ? null : data }; }

/* ══════════════ 1. QUOTES (Yahoo / Groww / Twelve Data) ══════════════ */
function yahooParse(j, symbol) {
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res) return null;
  const meta = res.meta || {};
  const qi = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
  const closes = (qi.close || []).filter(x => x != null);
  const vols = (qi.volume || []).filter(x => x != null);
  const price = meta.regularMarketPrice != null ? meta.regularMarketPrice : (closes.length ? closes[closes.length - 1] : null);
  let prev = meta.chartPreviousClose != null ? meta.chartPreviousClose : (meta.previousClose != null ? meta.previousClose : null);
  if (prev == null && closes.length > 1) prev = closes[closes.length - 2];
  if (price == null) return null;
  return {
    symbol, price, prevClose: prev,
    change: prev != null ? +(price - prev).toFixed(2) : null,
    changePct: prev != null ? +((price - prev) / prev * 100).toFixed(2) : null,
    volume: vols.length ? vols[vols.length - 1] : null,
    exchangeTime: meta.regularMarketTime ? meta.regularMarketTime * 1000 : null,
    marketState: meta.marketState || '',
    src: 'Yahoo Finance', status: 'DELAYED'
  };
}
async function yahooQuote(symbol) {
  const cKey = 'yq:' + symbol;
  const hit = cGet(cKey, 60000);
  if (hit !== null && hit !== undefined) return hit;
  const j = await fetchJson('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?interval=1d&range=2d', {}, 9000);
  const p = yahooParse(j, symbol);
  if (!p) throw new Error('yahoo empty');
  cSet(cKey, p);
  return p;
}
async function yahooSeries(symbol) {
  const cKey = 'ys:' + symbol;
  const hit = cGet(cKey, 300000);
  if (hit) return hit;
  const j = await fetchJson('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?interval=1d&range=6d', {}, 9000);
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error('series empty');
  const qi = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
  const out = (qi.close || []).map((c, i) => ({ c, v: (qi.volume || [])[i] })).filter(x => x.c != null);
  cSet(cKey, out);
  return out;
}
async function growwIndex(sym) {
  const cKey = 'gw:' + sym;
  const hit = cGet(cKey, 30000);
  if (hit) return hit;
  const j = await fetchJson('https://groww.in/v1/api/stocks_data/v1/accord_points/exchange/NSE/segment/CASH/latest_indices_ohlc/' + sym,
    { headers: { Referer: 'https://groww.in/', Origin: 'https://groww.in' } }, 8000);
  if (!j || !j.value) throw new Error('groww empty');
  cSet(cKey, j);
  return j;
}
async function twelveQuote(symbol, exchange) {
  if (!KEYS.twelve) throw new Error('no key');
  const cKey = 'td:' + symbol;
  const hit = cGet(cKey, 300000);
  if (hit) return hit;
  const u = 'https://api.twelvedata.com/quote?symbol=' + encodeURIComponent(symbol) + (exchange ? '&exchange=' + exchange : '') + '&apikey=' + KEYS.twelve;
  const j = await fetchJson(u, {}, 9000);
  if (!j || j.status === 'error' || !j.close) throw new Error((j && j.message) || 'twelve empty');
  const price = parseFloat(j.close), prev = parseFloat(j.previous_close);
  const out = {
    symbol, price, prevClose: isNaN(prev) ? null : prev,
    change: isNaN(prev) ? null : +(price - prev).toFixed(2),
    changePct: isNaN(prev) || !prev ? null : +((price - prev) / prev * 100).toFixed(2),
    src: 'Twelve Data', status: 'DELAYED'
  };
  cSet(cKey, out);
  return out;
}
/* quote() — yahoo pehle, fail ho to twelve; status hamesha batao */
async function quote(symbol, tdSymbol, tdEx) {
  try { return await yahooQuote(symbol); }
  catch (e) {
    try { return await twelveQuote(tdSymbol || symbol, tdEx); }
    catch (e2) { return null; }
  }
}

const INDIA = [
  { key: 'NIFTY', name: 'NIFTY 50', yahoo: '^NSEI', groww: 'NIFTY' },
  { key: 'BANKNIFTY', name: 'BANK NIFTY', yahoo: '^NSEBANK', groww: 'BANKNIFTY' },
  { key: 'FINNIFTY', name: 'FINNIFTY', yahoo: 'NIFTYFIN.NS', groww: 'FINNIFTY' },
  { key: 'SENSEX', name: 'SENSEX', yahoo: '^BSESN', groww: 'SENSEX' },
  { key: 'INDIAVIX', name: 'INDIA VIX', yahoo: '^INDIAVIX', groww: '' }
];
const GLOBAL = [
  { key: 'SP500', name: 'S&P 500', y: '^GSPC' }, { key: 'DOW', name: 'Dow Jones', y: '^DJI' },
  { key: 'NASDAQ', name: 'Nasdaq', y: '^IXIC' }, { key: 'FTSE', name: 'FTSE 100', y: '^FTSE' },
  { key: 'DAX', name: 'DAX', y: '^GDAXI' }, { key: 'NIKKEI', name: 'Nikkei', y: '^N225' },
  { key: 'HSI', name: 'Hang Seng', y: '^HSI' }
];
const COMMFX = [
  { key: 'CRUDE', name: 'Crude Oil', y: 'CL=F', td: 'WTI/USD', tde: 'Forex' },
  { key: 'GOLD', name: 'Gold', y: 'GC=F', td: 'XAU/USD', tde: 'Forex' },
  { key: 'SILVER', name: 'Silver', y: 'SI=F', td: 'XAG/USD', tde: 'Forex' },
  { key: 'USDINR', name: 'USD/INR', y: 'USDINR=X', td: 'USD/INR', tde: 'Forex' },
  { key: 'US10Y', name: 'US 10Y Yield', y: '^TNX', td: '', tde: '' },
  { key: 'BTC', name: 'Bitcoin', y: 'BTC-USD', td: 'BTC/USD', tde: 'Crypto' }
];
const BASKET = [
  { s: 'RELIANCE', sec: 'ENERGY' }, { s: 'TCS', sec: 'IT' }, { s: 'INFY', sec: 'IT' }, { s: 'WIPRO', sec: 'IT' },
  { s: 'HDFCBANK', sec: 'BANKING' }, { s: 'ICICIBANK', sec: 'BANKING' }, { s: 'SBIN', sec: 'BANKING' },
  { s: 'ITC', sec: 'FMCG' }, { s: 'TATAMOTORS', sec: 'AUTO' }, { s: 'BAJFINANCE', sec: 'FINANCE' }, { s: 'ADANIENT', sec: 'INFRA' }
];
async function mapLimit(arr, n, fn) {
  const out = new Array(arr.length); let i = 0;
  async function w() { while (i < arr.length) { const k = i++; try { out[k] = await fn(arr[k], k); } catch (e) { out[k] = null; } } }
  await Promise.all(Array.from({ length: Math.min(n, arr.length) }, w));
  return out;
}
async function rowQuote(def) {
  const q = await quote(def.y, def.td, def.tde);
  if (!q) return null;
  return { key: def.key, name: def.name, price: q.price, changePct: q.changePct, src: q.src, status: q.status, at: Date.now() };
}
async function indiaRows() {
  const rows = [];
  for (const def of INDIA) {
    // Groww (NSE feed): LIVE price + LIVE dayChangePerc — Yahoo sirf fallback
    let g = null;
    if (def.groww) { try { g = await growwIndex(def.groww); } catch (e) {} }
    const q = await rowQuote({ key: def.key, name: def.name, y: def.yahoo });
    if (g) {
      rows.push({
        key: def.key, name: def.name, price: g.value, ltpSrc: 'Groww (NSE)', ltpStatus: 'LIVE',
        changePct: g.dayChangePerc != null ? +(+g.dayChangePerc).toFixed(2) : (q ? q.changePct : null),
        chgSrc: g.dayChangePerc != null ? 'Groww (NSE)' : (q ? q.src : ''),
        chgStatus: g.dayChangePerc != null ? 'LIVE' : (q ? q.status : 'UNAVAILABLE'),
        at: Date.now()
      });
    } else if (q) {
      rows.push({ key: def.key, name: def.name, price: q.price, ltpSrc: q.src, ltpStatus: q.status, changePct: q.changePct, chgSrc: q.src, chgStatus: q.status, at: Date.now() });
    } else {
      rows.push({ key: def.key, name: def.name, price: null, ltpSrc: '', ltpStatus: 'UNAVAILABLE', changePct: null, chgSrc: '', chgStatus: 'UNAVAILABLE', at: Date.now() });
    }
  }
  return rows;
}
async function globalRows() { const r = await mapLimit(GLOBAL, 4, rowQuote); return r.filter(Boolean); }
async function commFxRows() { const r = await mapLimit(COMMFX, 4, rowQuote); return r.filter(Boolean); }
async function sectorRows() {
  const qs = await mapLimit(BASKET, 5, async b => ({ s: b.s, sec: b.sec, q: await quote(b.s + '.NS', b.s, 'NSE').catch(() => null) }));
  const groups = {};
  for (const x of qs.filter(x => x && x.q && x.q.changePct != null)) {
    (groups[x.sec] = groups[x.sec] || { name: x.sec, sum: 0, n: 0, top: [] });
    groups[x.sec].sum += x.q.changePct; groups[x.sec].n++;
    groups[x.sec].top.push({ s: x.s, chg: x.q.changePct });
  }
  return Object.values(groups).map(g => ({ name: g.name, changePct: +(g.sum / g.n).toFixed(2), n: g.n, stocks: g.top.sort((a, b) => b.chg - a.chg).slice(0, 3), src: 'Yahoo (stock basket proxy)', status: 'DELAYED' }));
}
async function majorStocks() {
  const qs = await mapLimit(BASKET, 5, async b => ({ s: b.s, q: await quote(b.s + '.NS', b.s, 'NSE').catch(() => null) }));
  return qs.filter(x => x && x.q && x.q.changePct != null).map(x => ({ s: x.s, chg: x.q.changePct, price: x.q.price, src: x.q.src, status: x.q.status }))
    .sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg));
}

/* ══════════════ 2. NSE (cookie warmup) — FII/DII + OPTION CHAIN ══════════════ */
let nseCookie = { at: 0, v: '' };
async function nseFetch(url) {
  if (!nseCookie.v || Date.now() - nseCookie.at > 15 * 60000) {
    const r = await fetchT('https://www.nseindia.com/', { headers: { Accept: 'text/html' } }, 8000);
    const sc = r.headers.get('set-cookie') || '';
    const pairs = sc.split(';').map(s => s.trim()).filter(s => s && !/^(path|expires|domain|max-age|httponly|samesite|secure)\s*=/i.test(s));
    nseCookie.v = pairs.join('; ');
    nseCookie.at = Date.now();
    await r.text().catch(() => {});
  }
  const r2 = await fetchT(url, { headers: { Accept: 'application/json', Referer: 'https://www.nseindia.com/', Cookie: nseCookie.v } }, 9000);
  return r2.json();
}
async function fiidii() {
  const hit = cGet('fiidii', 15 * 60000);
  if (hit) return hit;
  try {
    const j = await nseFetch('https://www.nseindia.com/api/fiidiiTradeReact');
    const arr = Array.isArray(j) ? j : (j && j.data) || [];
    const pick = id => arr.find(x => (x.id || x.category || '').toUpperCase().includes(id)) || null;
    const num = (o, keys) => { for (const k of keys) { if (o && o[k] != null) { const v = parseFloat(String(o[k]).replace(/,/g, '')); if (!isNaN(v)) return v; } } return null; };
    const f = pick('FII'), d = pick('DII');
    if (!f && !d) throw new Error('empty fiidii');
    const out = {
      ok: true, date: (f && f.date) || (d && d.date) || istDate(Date.now()),
      fii: { buy: num(f, ['buyCash', 'buyValue']), sell: num(f, ['sellCash', 'sellValue']), net: num(f, ['netCash', 'netValue']) },
      dii: { buy: num(d, ['buyCash', 'buyValue']), sell: num(d, ['sellCash', 'sellValue']), net: num(d, ['netCash', 'netValue']) },
      src: 'NSE (nseindia.com)', status: 'CONFIRMED DATA', fetchedAt: Date.now()
    };
    if (out.fii.net == null && out.dii.net == null) throw new Error('no numbers');
    cSet('fiidii', out);
    return out;
  } catch (e) {
    const out = { ok: false, status: 'UNAVAILABLE', src: 'NSE (nseindia.com)', fetchedAt: Date.now(), error: e.message };
    cSet('fiidii', out);
    return out;
  }
}
async function chainOI(sym) {
  sym = sym === 'BANKNIFTY' ? 'BANKNIFTY' : 'NIFTY';
  const hit = cGet('oi:' + sym, 120000);
  if (hit) return hit;
  let out;
  try {
    const j = await nseFetch('https://www.nseindia.com/api/option-chain-indices?symbol=' + encodeURIComponent(sym));
    const recs = (j.records && j.records.data) || [];
    const exp = (j.records && j.records.expiryDates && j.records.expiryDates[0]) || '';
    const rows = exp ? recs.filter(r => r.expiryDate === exp) : recs;
    if (!rows.length) throw new Error('no rows');
    let ce = 0, pe = 0, maxCE = null, maxPE = null;
    for (const r of rows) {
      const c = (r.CE && r.CE.openInterest) || 0, p = (r.PE && r.PE.openInterest) || 0;
      ce += c; pe += p;
      if (!maxCE || c > maxCE.oi) maxCE = { strike: r.strikePrice, oi: c };
      if (!maxPE || p > maxPE.oi) maxPE = { strike: r.strikePrice, oi: p };
    }
    out = {
      ok: true, sym, expiry: exp, underlying: j.records && j.records.underlyingValue,
      totalCE: ce, totalPE: pe, pcr: ce ? +(pe / ce).toFixed(2) : null,
      support: maxPE, resistance: maxCE, src: 'NSE option-chain (nseindia.com)', status: 'NEAR-REALTIME', fetchedAt: Date.now()
    };
  } catch (e) {
    out = { ok: false, sym, status: 'UNAVAILABLE', src: 'NSE option-chain (nseindia.com)', fetchedAt: Date.now(), error: e.message };
  }
  cSet('oi:' + sym, out);
  return out;
}

/* ══════════════ 3. NEWS — RSS + NewsAPI + Finnhub ══════════════ */
const FEEDS = [
  { url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', source: 'Economic Times', cat: 'market' },
  { url: 'https://economictimes.indiatimes.com/rssfeedstopstories.cms', source: 'Economic Times', cat: 'india' },
  { url: 'https://economictimes.indiatimes.com/rssfeed/1977021501.cms', source: 'Economic Times', cat: 'market' },
  { url: 'https://www.moneycontrol.com/rss/marketreports.xml', source: 'Moneycontrol', cat: 'market' },
  { url: 'https://www.moneycontrol.com/rss/market.xml', source: 'Moneycontrol', cat: 'market' },
  { url: 'https://www.livemint.com/rss/markets', source: 'Livemint', cat: 'market' },
  { url: 'https://www.business-standard.com/rss/markets-106.rss', source: 'Business Standard', cat: 'market' },
  { url: 'https://www.business-standard.com/rss/news-166.rss', source: 'Business Standard', cat: 'india' },
  { url: 'https://profit.ndtv.com/rss/news', source: 'NDTV Profit', cat: 'market' },
  { url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', source: 'CNBC', cat: 'global' },
  { url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html', source: 'CNBC World', cat: 'global' },
  { url: 'https://www.cnbc.com/id/10000147/device/rss/rss.html', source: 'CNBC Business', cat: 'global' },
  { url: 'https://www.federalreserve.gov/feeds/press_all.xml', source: 'Federal Reserve', cat: 'global' },
  { url: 'https://www.fxstreet.com/rss/news', source: 'FXStreet', cat: 'global' },
  { url: 'https://www.rbi.org.in/PressReleasesRSS.aspx', source: 'RBI', cat: 'india' }
];
function decodeEnt(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => { try { return String.fromCharCode(+d); } catch (e) { return m; } })
    .replace(/&nbsp;/g, ' ');
}
function stripHtml(s) {
  let x = String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  x = x.replace(/<[^>]*>/g, ' ');
  return decodeEnt(x).replace(/\s+/g, ' ').trim();
}
function parseRSS(xml, source, cat) {
  const out = [];
  const blocks = String(xml || '').match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks) {
    const grab = n => { const m = b.match(new RegExp('<' + n + '[^>]*>([\\s\\S]*?)</' + n + '>', 'i')); return m ? m[1].trim() : ''; };
    let title = stripHtml(grab('title')).slice(0, 220);
    let link = decodeEnt(grab('link')).trim();
    if (!link) { const m = b.match(/<link[^>]+href="([^"]+)"/i); if (m) link = m[1]; }
    const ds = grab('pubDate') || grab('published') || grab('updated') || grab('dc:date');
    const ts = ds ? Date.parse(ds) : NaN;
    const desc = stripHtml(grab('description') || grab('summary') || grab('content')).slice(0, 350);
    if (title) out.push({ title, link, source, cat, pubTs: isNaN(ts) ? 0 : ts, desc });
  }
  return out;
}
function normTitle(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9\u0900-\u097F]+/g, ' ').trim(); }
function tokSet(t) { return new Set(normTitle(t).split(' ').filter(w => w.length > 2)); }
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
const BULL = ['rate cut', 'cut rates', 'cuts rate', 'cuts repo', 'cut repo', 'repo rate cut', 'lowers rate', 'slash', 'dovish', 'stimulus', 'record high', 'all-time high', 'blockbuster', 'huge order', 'order win', 'special dividend', 'strong guidance', 'beat estimate', 'upgrade', 'promoter buy', 'promoter buying', 'fii buy', 'buys stake', 'acquires', 'buyback', 'profit jump', 'profit rise', 'surge', 'rally', 'jumps', 'gains', 'soars', 'gst cut', 'tax cut', 'bonus issue'];
const BULL2 = ['dividend', 'buyback', 'stake buy', 'wins order', 'breakthrough', 'record profit', 'strong results', 'bullish'];
const BEAR = ['rate hike', 'hikes rate', 'raises rate', 'raises rates', 'hawkish', 'cuts guidance', 'misses estimate', 'profit fall', 'profit dip', 'downgrade', 'promoter sell', 'promoter selling', 'sells stake', 'penalty', 'fine ', 'probe', 'investigation', 'default', 'recall', 'weak results', 'slips', 'drops', 'falls', 'declines', 'slides', 'tumbles', 'extends fall', 'sales decline'];
const BEAR2 = ['sell-off', 'selloff', 'outflow', 'discount', 'pressure'];
const VBEAR = ['war', 'conflict', 'attack', 'invasion', 'recession', 'crash', 'circuit', 'pandemic', 'terror', 'downgrade india', 'sovereign downgrade', 'halted trading', 'plunge'];
function classifyImpact(text) {
  const t = ' ' + String(text || '').toLowerCase() + ' ';
  let bull = 0, bear = 0, vbull = 0, vbear = 0;
  for (const k of BULL) if (t.includes(k)) bull++;
  for (const k of BULL2) if (t.includes(k)) bull++;
  for (const k of BEAR) if (t.includes(k)) bear++;
  for (const k of BEAR2) if (t.includes(k)) bear++;
  for (const k of VBEAR) if (t.includes(k)) vbear++;
  if (bull >= 2 && /record|all-time|blockbuster|soar|surge|rally/.test(t)) vbull = 1;
  let impact = 'NEUTRAL', conf = 'LOW';
  if (vbear >= 1 && vbear >= bull) { impact = 'VERY BEARISH'; conf = 'HIGH'; }
  else if (vbull >= 1 && vbull >= bear) { impact = 'VERY BULLISH'; conf = 'HIGH'; }
  else if (bear >= 2 || (bear >= 1 && bull === 0)) { impact = bear >= 2 ? 'BEARISH' : 'BEARISH'; conf = bear >= 2 ? 'HIGH' : 'MEDIUM'; }
  else if (bull >= 2 || (bull >= 1 && bear === 0)) { impact = bull >= 2 ? 'BULLISH' : 'BULLISH'; conf = bull >= 2 ? 'HIGH' : 'MEDIUM'; }
  else if (bull === 1 && bear === 1) { impact = 'NEUTRAL'; conf = 'MEDIUM'; }
  const TAGS = [
    [['rbi', 'repo', 'monetary policy', 'mpc', 'repo rate'], 'RBI'], [['sebi'], 'SEBI'], [['fed ', 'federal reserve', 'fomc', 'powell'], 'FED'],
    [['crude', 'oil price', 'opec'], 'CRUDE'], [['gold price', 'gold '], 'GOLD'], [['ipo', 'fpo'], 'IPO'], [['dividend'], 'DIVIDEND'],
    [['earnings', 'quarterly result', 'profit', 'revenue'], 'EARNINGS'], [['fii'], 'FII'], [['dii', 'mutual fund'], 'DII'],
    [['buyback'], 'BUYBACK'], [['merger', 'acquisition', 'acquires'], 'M&A'], [['budget', 'gst', 'tax'], 'POLICY'],
    [['inflation', 'cpi', 'wpi'], 'INFLATION'], [['gdp', 'pmi', 'iip'], 'MACRO'], [['promoter'], 'PROMOTER'],
    [['block deal', 'bulk deal'], 'DEALS'], [['rupee', 'usdinr', 'dollar'], 'RUPEE'], [['bank nifty', 'banking', 'banks'], 'BANKING'],
    [['rate cut', 'rate hike', 'interest rate'], 'RATES'], [['war', 'conflict', 'geopolitical'], 'GEOPOLITICAL'], [['fed', 'us market', 'dow', 's&p'], 'GLOBAL']
  ];
  const tags = [];
  for (const [keys, tag] of TAGS) { if (keys.some(k => t.includes(k)) && !tags.includes(tag)) tags.push(tag); }
  return { impact, conf, tags };
}
const STOCK_ALIAS = {
  RELIANCE: ['reliance', 'रिलायंस'], TCS: ['tcs', 'tata consult', 'टीसीएस'], ICICIBANK: ['icici', 'आईसीआईसीआई'],
  HDFCBANK: ['hdfc bank', 'hdfc', 'एचडीएफसी बैंक', 'एचडीएफसी'],
  SBIN: ['sbin', 'state bank', 'एसबीआई', 'स्टेट बैंक'], INFY: ['infosys', 'infy', 'इंफोसिस'],
  ITC: ['itc', 'आईटीसी'], TATAMOTORS: ['tata motors', 'tatamotors', 'tata motor', 'टाटा मोटर्स'],
  WIPRO: ['wipro', 'विप्रो'], BAJFINANCE: ['bajaj finance', 'baj finance', 'बजाज फाइनेंस'], ADANIENT: ['adani', 'अडानी'],
  REC: ['rec', 'recltd', 'आरईसी'], NTPC: ['ntpc', 'एनटीपीसी'], POWERGRID: ['powergrid', 'power grid', 'पावर ग्रिड'],
  TATASTEEL: ['tata steel', 'tatasteel', 'टाटा स्टील'], SUNPHARMA: ['sun pharma', 'sunpharma', 'सन फार्मा'],
  MARUTI: ['maruti', 'मारुति'], AXISBANK: ['axis bank', 'axisbank', 'एक्सिस बैंक'], KOTAKBANK: ['kotak', 'कोटक'],
  HINDUNILVR: ['hindustan unilever', 'hindunilvr', 'हिंदुस्तान यूनिलिवर']
};
function normSpace(text) { return ' ' + String(text || '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim() + ' '; }
function stockOf(text) {
  const t = normSpace(text);
  for (const [sym, als] of Object.entries(STOCK_ALIAS)) if (als.some(a => t.includes(' ' + a + ' '))) return sym;
  return '';
}
let newsArr = [];   // newest first, cap 400
const newsErrs = {};
function mergeItems(items) {
  let added = 0;
  for (const it of items) {
    if (!it || !it.title || !it.pubTs) continue;
    if (Date.now() - it.pubTs > 7 * 86400000) continue;      // 7 din purani drop
    const nt = normTitle(it.title);
    if (newsArr.some(x => x.nt === nt)) continue;
    it.nt = nt; it.toks = tokSet(it.title); it.impactInfo = classifyImpact(it.title + ' ' + (it.desc || ''));
    it.impact = it.impactInfo.impact; it.impactConf = it.impactInfo.conf; it.tags = it.impactInfo.tags;
    it.stock = stockOf(it.title + ' ' + (it.desc || ''));
    it.verified = 'SINGLE-SOURCE';
    newsArr.push(it); added++;
  }
  newsArr.sort((a, b) => b.pubTs - a.pubTs);
  if (newsArr.length > 400) newsArr.length = 400;
  verifyAll();
  return added;
}
function verifyAll() {
  const seen = new Set();
  for (const it of newsArr) {
    if (seen.has(it.nt)) continue;
    const srcs = new Set([it.source]);
    for (const o of newsArr) {
      if (o.nt === it.nt) { srcs.add(o.source); continue; }
      if (Math.abs(o.pubTs - it.pubTs) < 6 * 3600000 && jaccard(it.toks, o.toks) >= 0.6) srcs.add(o.source);
    }
    const v = srcs.size >= 2 ? 'VERIFIED (2+ sources)' : 'SINGLE-SOURCE';
    for (const o of newsArr) if (o.nt === it.nt || jaccard(it.toks, o.toks) >= 0.6) { if (v === 'VERIFIED (2+ sources)') o.verified = v; else if (o.source === it.source) o.verified = v; }
    seen.add(it.nt);
  }
}
async function pollFeeds() {
  const results = await mapLimit(FEEDS, 5, async f => {
    try {
      const r = await fetchT(f.url, { headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' } }, 9000);
      const xml = await r.text();
      newsErrs[f.source + f.url.slice(0, 30)] = 0;
      return parseRSS(xml, f.source, f.cat);
    } catch (e) {
      newsErrs[f.source + f.url.slice(0, 30)] = e.message;
      return [];
    }
  });
  let n = 0;
  for (const arr of results) n += mergeItems(arr);
  return n;
}
async function newsApiFetch() {
  if (!KEYS.newsapi) return [];
  // free dev plan: top-headlines country=in khali aata hai — everything + trading query use karo
  const q = encodeURIComponent('(nifty OR sensex OR "bank nifty" OR rbi OR sebi OR "fii" OR "dii" OR "fed" OR crude)');
  const u = 'https://newsapi.org/v2/everything?q=' + q + '&sortBy=publishedAt&pageSize=40&language=en&apiKey=' + KEYS.newsapi;
  const j = await fetchJson(u, {}, 12000);
  if (j.status !== 'ok') throw new Error(j.message || 'newsapi fail');
  return (j.articles || []).filter(a => a.title && a.title !== '[Removed]').map(a => ({
    title: String(a.title).slice(0, 220), link: a.url || '', source: (a.source && a.source.name) || 'NewsAPI',
    cat: 'market', pubTs: a.publishedAt ? (Date.parse(a.publishedAt) || 0) : 0, desc: (a.description || '').slice(0, 300), via: 'NewsAPI'
  }));
}
async function finnhubFetch() {
  if (!KEYS.finnhub) return [];
  const u = 'https://finnhub.io/api/v1/news?category=general&token=' + KEYS.finnhub;
  const j = await fetchJson(u, {}, 10000);
  if (!Array.isArray(j)) throw new Error('finnhub fail');
  return j.slice(0, 40).map(x => ({
    title: String(x.headline || '').slice(0, 220), link: x.url || '', source: x.source || 'Finnhub',
    cat: 'global', pubTs: x.datetime ? x.datetime * 1000 : 0, desc: String(x.summary || '').slice(0, 300), via: 'Finnhub'
  }));
}
async function finnhubCompany(sym) {
  if (!KEYS.finnhub) return [];
  const fsym = (sym + '.NS');
  const to = istDate(Date.now()), from = istDate(Date.now() - 3 * 86400000);
  const u = 'https://finnhub.io/api/v1/company-news?symbol=' + encodeURIComponent(fsym) + '&from=' + from + '&to=' + to + '&token=' + KEYS.finnhub;
  const j = await fetchJson(u, {}, 10000);
  if (!Array.isArray(j)) return [];
  return j.slice(0, 20).map(x => ({
    title: String(x.headline || '').slice(0, 220), link: x.url || '', source: x.source || 'Finnhub',
    cat: 'corp', pubTs: x.datetime ? x.datetime * 1000 : 0, desc: String(x.summary || '').slice(0, 300), via: 'Finnhub', stock: sym
  }));
}
function annotate(it) {
  const fresh = it.pubTs ? istDate(it.pubTs) === istDate(Date.now()) : false;
  return {
    title: it.title, source: it.source, link: it.link || '', pubTs: it.pubTs,
    time: it.pubTs ? fmtIst(it.pubTs) : '', date: it.pubTs ? istDate(it.pubTs) : '',
    fresh, impact: it.impact, impactConf: it.impactConf, verification: it.verified,
    tags: (it.tags || []).slice(0, 5), stock: it.stock || '', cat: it.cat, status: it.verified, via: it.via || 'RSS'
  };
}
function newsList(cat, limit) {
  limit = limit || 20;
  const today = istDate(Date.now());
  let arr = newsArr.slice();
  if (cat && cat !== 'all') {
    if (cat === 'india') arr = arr.filter(x => x.cat === 'india' || (x.tags || []).some(t => ['RBI', 'SEBI', 'POLICY', 'IPO', 'DEALS', 'PROMOTER'].includes(t)));
    else if (cat === 'global') arr = arr.filter(x => x.cat === 'global' || (x.tags || []).some(t => ['FED', 'GEOPOLITICAL', 'GLOBAL', 'CRUDE', 'GOLD'].includes(t)));
    else if (cat === 'market') arr = arr.filter(x => x.cat === 'market');
    else if (cat === 'corp') arr = arr.filter(x => x.cat === 'corp' || (x.tags || []).some(t => ['EARNINGS', 'IPO', 'DIVIDEND', 'BUYBACK', 'M&A', 'DEALS', 'PROMOTER'].includes(t)));
    else if (cat === 'today') arr = arr.filter(x => istDate(x.pubTs) === today);
  }
  const todayArr = arr.filter(x => istDate(x.pubTs) === today);
  const oldArr = arr.filter(x => istDate(x.pubTs) !== today);
  return {
    today: todayArr.slice(0, limit).map(annotate),
    old: oldArr.filter(x => (x.tags || []).length || x.stock).slice(0, 5).map(annotate),
    total: arr.length,
    coverage: {
      feeds: FEEDS.length, newsApi: !!KEYS.newsapi, finnhub: !!KEYS.finnhub,
      errors: Object.values(newsErrs).filter(Boolean).length,
      errNames: Object.entries(newsErrs).filter(([, v]) => v).map(([k]) => String(k).slice(0, 22)).slice(0, 6),
      via: (function () { const c = {}; for (const x of newsArr) { const v = x.via || 'RSS'; c[v] = (c[v] || 0) + 1; } return c; })()
    }
  };
}
function newsAroundSync(ts, winMs) {
  winMs = winMs || 30 * 60000;
  return newsArr.filter(x => Math.abs(x.pubTs - ts) <= winMs).slice(0, 10).map(annotate);
}

/* ══════════════ 4. ECONOMIC CALENDAR (ForexFactory) ══════════════ */
function ffParse(arr) {
  const keep = new Set(['IN', 'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'CNY']);
  return (Array.isArray(arr) ? arr : [])
    .filter(x => x && x.date && x.title && (x.impact === 'High' || x.country === 'IN') && keep.has(x.country))
    .map(x => ({
      title: String(x.title).slice(0, 140), country: x.country, impact: x.impact,
      ts: Date.parse(x.date) || 0, atIst: x.date ? fmtIst(Date.parse(x.date)) : '',
      dateIst: x.date ? istDate(Date.parse(x.date)) : '', forecast: x.forecast || '', previous: x.previous || '', actual: x.actual || ''
    }))
    .filter(x => x.ts)
    .sort((a, b) => a.ts - b.ts);
}
async function calendar() {
  const hit = cGet('cal', 6 * 3600000);
  if (hit) return hit;
  let out, ttl = 6 * 3600000;
  try {
    const j = await fetchJson('https://nfs.faireconomy.media/ff_calendar_thisweek.json', {}, 10000);
    const rows = ffParse(j);
    if (!rows.length) throw new Error('empty');
    out = { ok: true, rows, src: 'ForexFactory (faireconomy.media)', status: 'SCHEDULED (official release times)', fetchedAt: Date.now() };
    cSet('cal:good', out, 7 * 86400000);
  } catch (e) {
    // 429/fail → pichhla achha snapshot future events ke saath (STALE label ke, kabhi UNAVAILABLE nahi chhupao)
    const good = cGet('cal:good', 7 * 86400000);
    const fut = good ? good.rows.filter(r => r.ts > Date.now() - 3600000) : [];
    if (fut.length) {
      out = { ok: true, rows: fut, src: good.src, stale: true, status: 'SCHEDULED (STALE cache — live refresh fail: ' + e.message + ')', fetchedAt: good.fetchedAt };
      ttl = 30 * 60000;
    } else {
      out = { ok: false, rows: [], src: 'ForexFactory (faireconomy.media)', status: 'UNAVAILABLE', fetchedAt: Date.now(), error: e.message };
      ttl = 15 * 60000; // jaldi retry (429 mostly transient)
    }
  }
  cSet('cal', out, ttl);
  return out;
}

/* ══════════════ 5. TIMELINE + JOURNAL ══════════════ */
const samples = [];   // {ts, p} — NIFTY 3-min ring (market hours)
function sampleTick(price) {
  if (price == null) return;
  samples.push({ ts: Date.now(), p: price });
  if (samples.length > 400) samples.shift();
}
function timelineEvents() {
  const today = istDate(Date.now());
  const ev = [];
  const dayS = samples.filter(s => istDate(s.ts) === today);
  if (dayS.length >= 2) {
    ev.push({ ts: dayS[0].ts, kind: 'OPEN', text: 'Market open — NIFTY ' + dayS[0].p });
    for (let i = 1; i < dayS.length; i++) {
      const dMs = dayS[i].ts - dayS[i - 1].ts;
      if (dMs > 20 * 60000) continue;
      const chg = (dayS[i].p - dayS[i - 1].p) / dayS[i - 1].p * 100;
      if (Math.abs(chg) >= 0.25) ev.push({ ts: dayS[i].ts, kind: 'MOVE', text: 'NIFTY ' + (chg > 0 ? '+' : '') + chg.toFixed(2) + '% move → ' + dayS[i].p + ' (3-min samples)' });
    }
    const last = dayS[dayS.length - 1];
    ev.push({ ts: last.ts, kind: 'LTP', text: 'Latest sample — NIFTY ' + last.p });
  }
  for (const n of newsArr.filter(x => istDate(x.pubTs) === today && x.cat === 'market')) {
    ev.push({ ts: n.pubTs, kind: 'NEWS', text: '[' + n.impact + '] ' + n.title + ' — ' + n.source + ' ' + fmtIst(n.pubTs) });
  }
  ev.sort((a, b) => a.ts - b.ts);
  return ev;
}
function timeline() {
  const ev = timelineEvents();
  const moves = ev.filter(x => x.kind === 'MOVE');
  const lastMove = moves.length ? moves[moves.length - 1] : null;
  let anchor = '';
  if (lastMove) {
    const near = newsArr.filter(x => Math.abs(x.pubTs - lastMove.ts) <= 25 * 60000).slice(0, 3);
    anchor = near.length
      ? 'Move aas-paas ki news: ' + near.map(n => n.title + ' (' + fmtIst(n.pubTs) + ', ' + n.source + ')').join(' | ')
      : 'Move ke aas-paas (±25 min) koi verified news nahi mili.';
  }
  return {
    events: ev.slice(-40), anchor,
    status: samples.length ? 'SAMPLED (3-min, in-memory)' : (ev.length ? 'NEWS-EVENTS ONLY (price sampling market hours me chalta hai)' : 'UNAVAILABLE'),
    src: 'DS engine samples + RSS news', fetchedAt: Date.now()
  };
}
const JPATH = path.join(STORE, 'news-journal.json');
function loadJ() { try { return JSON.parse(fs.readFileSync(JPATH, 'utf8')); } catch (e) { return {}; } }
function saveJ(j) { try { fs.writeFileSync(JPATH, JSON.stringify(j, null, 1)); } catch (e) {} }
async function ensureJournal(date) {
  date = date || istDate(Date.now());
  const all = loadJ();
  if (all[date]) {
    // self-heal: pehli baar news khali me ban gaya tha to ab news aane par rebuild
    const hasNews = newsArr.some(x => istDate(x.pubTs) === date);
    if (!(hasNews && /^NO NEWS CACHED/.test(all[date].status || ''))) return all[date];
  }
  const ev = (await calendar()).rows.filter(x => x.dateIst === date);
  const top = newsArr.filter(x => istDate(x.pubTs) === date).slice(0, 8).map(annotate);
  const f = await fiidii();
  const dayS = samples.filter(s => istDate(s.ts) === date);
  const secs = await sectorRows().catch(() => []);
  const jr = {
    date,
    majorNews: top,
    sectorMoves: secs.sort((a, b) => b.changePct - a.changePct),
    fiiDii: f.ok ? f : { status: 'UNAVAILABLE' },
    events: ev,
    marketReaction: dayS.length >= 2
      ? { open: dayS[0].p, last: dayS[dayS.length - 1].p, chgPct: +((dayS[dayS.length - 1].p - dayS[0].p) / dayS[0].p * 100).toFixed(2) }
      : null,
    endOfDay: '',
    builtAt: Date.now(), src: 'Market Intelligence (RSS+NSE+samples)', status: top.length ? 'COMPILED' : 'NO NEWS CACHED (server restart ho sakta hai)'
  };
  all[date] = jr; saveJ(all);
  return jr;
}
let eodDone = '';
function eodCheck() {
  const p = istNow();
  // 15:40 IST ke baad kisi bhi time (upper cap nahi — server raat ko bhi boot ho to aaj ka journal banega), eodDone se repeat nahi
  if (p.dow >= 1 && p.dow <= 5 && p.tzh >= 940 && eodDone !== p.date) {
    eodDone = p.date;
    ensureJournal(p.date).then(j => {
      const all = loadJ();
      if (all[p.date] && !all[p.date].endOfDay) {
        all[p.date].endOfDay = 'Day compiled — news ' + ((j.majorNews || []).length) + ' items, events ' + ((j.events || []).length) + '.';
        saveJ(all);
      }
    }).catch(() => {});
  }
}

/* ══════════════ 6. WHY-MARKET ANALYSIS (§3 factor ranker) ══════════════ */
function fmtCr(v) { return v == null ? '--' : (v > 0 ? '+' : '-') + '₹' + Math.abs(Math.round(v)).toLocaleString('en-IN') + ' Cr'; }
function factorList(D) {
  const F = [];
  const confRank = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  const us = (D.global || []).filter(r => ['SP500', 'DOW', 'NASDAQ'].includes(r.key));
  if (us.length) {
    const vals = us.map(r => r.changePct).filter(v => v != null);
    if (vals.length) {
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      if (Math.abs(avg) >= 0.35) F.push({ k: 'Global markets (US overnight)', conf: Math.abs(avg) >= 0.7 ? 'HIGH' : 'MEDIUM', mag: Math.abs(avg), ev: us.map(r => r.name + ' ' + fmtPct(r.changePct)).join(', ') + ' — ' + us[0].src + ', ' + us[0].status });
    }
  }
  const asia = (D.global || []).filter(r => ['NIKKEI', 'HSI'].includes(r.key));
  if (asia.length && asia.every(r => r.changePct != null)) {
    const avg = asia.reduce((a, r) => a + r.changePct, 0) / asia.length;
    if (Math.abs(avg) >= 0.5) F.push({ k: 'Asia markets', conf: 'MEDIUM', mag: Math.abs(avg), ev: asia.map(r => r.name + ' ' + fmtPct(r.changePct)).join(', ') + ' — ' + asia[0].src + ', ' + asia[0].status });
  }
  if (D.fii && D.fii.ok) {
    F.push({
      k: 'FII/DII flows', conf: 'HIGH', mag: Math.abs((D.fii.fii.net || 0)) / 1000,
      ev: 'FII net ' + fmtCr(D.fii.fii.net) + ' · DII net ' + fmtCr(D.fii.dii.net) + ' — CONFIRMED DATA (NSE, ' + D.fii.date + ')'
    });
  }
  if (D.vix && D.vix.changePct != null && Math.abs(D.vix.changePct) >= 4) {
    F.push({ k: 'Volatility (VIX)', conf: 'MEDIUM', mag: Math.abs(D.vix.changePct) / 10, ev: 'India VIX ' + D.vix.price + ' (' + fmtPct(D.vix.changePct) + ') — ' + D.vix.src + ', ' + D.vix.status });
  }
  const nc = D.newsCounts;
  if (nc && (nc.bear >= 2 || nc.bull >= 2)) {
    const side = nc.bear >= nc.bull ? 'BEARISH' : 'BULLISH';
    const tops = (side === 'BEARISH' ? nc.bearTop : nc.bullTop).slice(0, 2);
    F.push({ k: 'News flow (' + side.toLowerCase() + ')', conf: nc.bull + nc.bear >= 4 ? 'HIGH' : 'MEDIUM', mag: Math.abs(nc.bull - nc.bear) / 4, ev: tops.map(t => '"' + t.title.slice(0, 70) + '" (' + t.source + ', ' + t.time + ')').join(' | ') });
  }
  const sect = (D.sectors || []).filter(s => s.changePct != null && s.n >= 2).sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))[0];
  if (sect && Math.abs(sect.changePct) >= 0.6) {
    F.push({ k: 'Sector move', conf: 'MEDIUM', mag: Math.abs(sect.changePct), ev: sect.name + ' avg ' + fmtPct(sect.changePct) + ' (n=' + sect.n + ', stock-basket proxy — ' + sect.status + ')' });
  }
  if (D.volume && D.volume.ratio && D.volume.ratio >= 1.5) {
    F.push({ k: 'Volume surge', conf: 'MEDIUM', mag: D.volume.ratio / 3, ev: 'Volume ' + D.volume.ratio.toFixed(1) + 'x 5-day avg (Yahoo, DELAYED)' });
  }
  if (D.crude && D.crude.changePct != null && Math.abs(D.crude.changePct) >= 2) {
    F.push({ k: 'Crude oil', conf: 'MEDIUM', mag: Math.abs(D.crude.changePct) / 10, ev: 'Crude $' + D.crude.price + ' (' + fmtPct(D.crude.changePct) + ') — ' + D.crude.src + ', ' + D.crude.status });
  }
  if (D.usdinr && D.usdinr.changePct != null && Math.abs(D.usdinr.changePct) >= 0.4) {
    F.push({ k: 'Currency (USD/INR)', conf: 'LOW', mag: Math.abs(D.usdinr.changePct), ev: 'USD/INR ' + D.usdinr.price + ' (' + fmtPct(D.usdinr.changePct) + ') — ' + D.usdinr.src + ', ' + D.usdinr.status });
  }
  if (D.oi && D.oi.ok && D.oi.pcr != null) {
    F.push({ k: 'Options/OI', conf: 'LOW', mag: 0.1, ev: 'PCR ' + D.oi.pcr + ' · Support ' + (D.oi.support && D.oi.support.strike) + ' (max PE OI) · Resistance ' + (D.oi.resistance && D.oi.resistance.strike) + ' (max CE OI) — ' + D.oi.src + ', ' + D.oi.status });
  }
  const evUp = (D.events || []).find(e => e.ts > Date.now() && e.ts - Date.now() < 14 * 3600000);
  if (evUp) F.push({ k: 'Upcoming economic event', conf: 'LOW', mag: 0.05, ev: evUp.title + ' — ' + evUp.atIst + ' IST (' + evUp.country + ', ' + evUp.impact + ' impact, ' + (D.eventsSrc || 'ForexFactory') + ')' });
  F.sort((a, b) => (confRank[b.conf] - confRank[a.conf]) || ((b.mag || 0) - (a.mag || 0)));
  return F;
}
function confSummary(F) {
  let pct = 30;
  for (const f of F) pct += f.conf === 'HIGH' ? 15 : f.conf === 'MEDIUM' ? 8 : 3;
  pct = Math.min(95, pct);
  return { pct, grade: pct >= 70 ? 'HIGH' : pct >= 50 ? 'MEDIUM' : 'LOW' };
}
const IMPM = { NEUTRAL: 'तटस्थ', BULLISH: 'तेजी', BEARISH: 'मंदी', 'VERY BULLISH': 'तीव्र तेजी', 'VERY BEARISH': 'तीव्र मंदी' };
const STM = { LIVE: 'लाइव', DELAYED: 'विलंबित', SCHEDULED: 'निर्धारित', UNAVAILABLE: 'अनुपलब्ध', CONFIRMED: 'पुष्ट', 'CONFIRMED DATA': 'पुष्ट डेटा', STALE: 'पुराना' };
const hImp = (v, hi) => '[' + (hi && IMPM[v] ? IMPM[v] : v) + ']';
const hSt = (v, hi) => {
  if (!hi || v == null) return v;
  const s = String(v);
  if (STM[s]) return STM[s];
  return s.replace(/CONFIRMED DATA/g, 'पुष्ट डेटा').replace(/\bCONFIRMED\b/g, 'पुष्ट').replace(/\bSCHEDULED\b/g, 'निर्धारित').replace(/\bDELAYED\b/g, 'विलंबित').replace(/\bUNAVAILABLE\b/g, 'अनुपलब्ध').replace(/\bSTALE\b/g, 'पुराना').replace(/\bLIVE\b/g, 'लाइव');
};
const hVer = (v, hi) => { let s = v == null ? '' : String(v); if (hi) s = s.replace(/SINGLE-SOURCE/g, 'एकल-स्रोत').replace(/MULTI-SOURCE/g, 'बहु-स्रोत').replace(/UNVERIFIED/g, 'असत्यापित').replace(/\bVERIFIED\b/g, 'सत्यापित'); return s; };
const hInp = (v, hi) => hi ? ({ High: 'उच्च', Medium: 'मध्यम', Low: 'निम्न' }[v] || v) : v;
const hConf = (v, hi) => hi ? ({ HIGH: 'उच्च', MEDIUM: 'मध्यम', LOW: 'निम्न' }[v] || v) : v;
function composeWhy(symName, D, hi) {
  if (!D || !D.move || D.move.changePct == null) return UNAVAIL;
  const F = factorList(D);
  const cs = confSummary(F);
  const L = [];
  L.push(hi ? 'बाज़ार चाल विश्लेषण' : 'MARKET MOVE ANALYSIS', '');
  L.push((hi ? 'बाज़ार: ' : 'Market: ') + symName);
  L.push(hi
    ? 'चाल: ' + fmtPct(D.move.changePct) + ' (LTP ' + D.move.price + ') — स्रोत: ' + D.moveSrc + ' · समय: ' + fmtIst(D.moveAt || Date.now()) + ' · स्थिति: ' + hSt(D.moveStatus, hi)
    : 'Move: ' + fmtPct(D.move.changePct) + ' (LTP ' + D.move.price + ') — Source: ' + D.moveSrc + ' · Time: ' + fmtIst(D.moveAt || Date.now()) + ' · Status: ' + D.moveStatus);
  L.push('');
  if (F.length) {
    L.push((hi ? 'मुख्य कारण: ' : 'Primary Reason: ') + F[0].k + (hi ? ' — आत्मविश्वास: ' : ' — Confidence: ') + hConf(F[0].conf, hi));
    L.push((hi ? 'सहायक प्रमाण: ' : 'Supporting Evidence: ') + F[0].ev);
    if (F.length > 1) {
      L.push('', hi ? 'द्वितीयक कारण:' : 'Secondary Reasons:');
      F.slice(1, 6).forEach((f, i) => L.push((i + 1) + '. ' + f.k + (hi ? ' — ' + hConf(f.conf, hi) + ' आत्मविश्वास — ' : ' — ' + f.conf + ' confidence — ') + f.ev));
    }
  } else {
    L.push(hi
      ? 'मुख्य कारण: वो सीधा डेटा उपलब्ध नहीं जो चाल को समझा सके — कम-आत्मविश्वास वाली चाल लग रही है.'
      : 'Primary Reason: Direct data available nahi hai jo movement explain kare — low-confidence move lag rahi hai.',
      hi ? 'सहायक प्रमाण: कोई सत्यापित कारक नहीं मिला (global/FII/news/calendar sab se weak correlation).'
         : 'Supporting Evidence: koi verified factor nahi mila (global/FII/news/calendar sab se weak correlation).');
  }
  L.push('');
  L.push((hi ? 'वैश्विक असर: ' : 'Global Impact: ') + ((D.global || []).length
    ? D.global.map(r => r.name + ' ' + fmtPct(r.changePct)).join(' · ') + ' — ' + D.globalSrc + ', ' + hSt(D.globalStatus, hi)
    : hi ? 'अनुपलब्ध' : 'UNAVAILABLE'));
  L.push((hi ? 'FII/DII असर: ' : 'FII/DII Impact: ') + (D.fii && D.fii.ok
    ? (hi
      ? 'FII ' + fmtCr(D.fii.fii.net) + ' · DII ' + fmtCr(D.fii.dii.net) + ' (पुष्ट डेटा — NSE, ' + D.fii.date + '). व्याख्या: इन प्रवाहों का बाज़ार पर असर — यह सिर्फ विश्लेषण है, पुष्ट तथ्य नहीं.'
      : 'FII ' + fmtCr(D.fii.fii.net) + ' · DII ' + fmtCr(D.fii.dii.net) + ' (CONFIRMED DATA — NSE, ' + D.fii.date + '). Interpretation: in flows ka market par asar — ye sirf analysis hai, confirmed fact nahi.')
    : hi ? 'अनुपलब्ध (NSE से आज का डेटा नहीं मिला — अनुमान नहीं लगाऊंगा)'
         : 'UNAVAILABLE (NSE se aaj ka data nahi mila — guess nahi karunga)'));
  L.push((hi ? 'सेक्टर असर: ' : 'Sector Impact: ') + ((D.sectors || []).length
    ? D.sectors.slice().sort((a, b) => b.changePct - a.changePct).map(s => s.name + ' ' + fmtPct(s.changePct)).join(' · ') + (hi ? ' (स्टॉक-बास्केट प्रॉक्सी, ' : ' (stock-basket proxy, ') + hSt(D.sectors[0].status, hi) + ')'
    : hi ? 'अनुपलब्ध' : 'UNAVAILABLE'));
  L.push((hi ? 'विकल्प/OI: ' : 'Options/OI: ') + (D.oi && D.oi.ok
    ? (hi
      ? 'PCR ' + D.oi.pcr + ' · समर्थन ' + (D.oi.support && D.oi.support.strike) + ' · प्रतिरोध ' + (D.oi.resistance && D.oi.resistance.strike) + ' (समाप्ति ' + D.oi.expiry + ') — ' + D.oi.src + ', ' + hSt(D.oi.status, hi)
      : 'PCR ' + D.oi.pcr + ' · Support ' + (D.oi.support && D.oi.support.strike) + ' · Resistance ' + (D.oi.resistance && D.oi.resistance.strike) + ' (expiry ' + D.oi.expiry + ') — ' + D.oi.src + ', ' + D.oi.status)
    : hi ? 'अनुपलब्ध' : 'UNAVAILABLE'));
  if ((D.majors || []).length) L.push((hi ? 'प्रमुख शेयर: ' : 'Major Stocks: ') + D.majors.slice(0, 5).map(m => m.s + ' ' + fmtPct(m.chg)).join(' · ') + ' (' + hSt(D.majors[0].status, hi) + ')');
  L.push('');
  L.push((hi ? 'आत्मविश्वास: ' : 'Confidence: ') + cs.pct + '% (' + hConf(cs.grade, hi) + ') — ' + F.filter(f => f.conf === 'HIGH').length + ' ' + hConf('HIGH', hi) + ' / ' + F.filter(f => f.conf === 'MEDIUM').length + ' ' + hConf('MEDIUM', hi) + (hi ? ' कारक समर्थन' : ' factors supporting'));
  const srcs = new Set();
  srcs.add(D.moveSrc + ' @ ' + fmtIst(D.moveAt || Date.now()) + ' (' + hSt(D.moveStatus, hi) + ')');
  if ((D.global || []).length) srcs.add(D.globalSrc + ' (' + hSt(D.globalStatus, hi) + ')');
  if (D.fii && D.fii.ok) srcs.add(hi ? 'NSE FII/DII (पुष्ट, ' + D.fii.date + ')' : 'NSE FII/DII (CONFIRMED, ' + D.fii.date + ')');
  if (D.oi && D.oi.ok) srcs.add(hi ? 'NSE ऑप्शन-चेन (' + hSt(D.oi.status, hi) + ')' : 'NSE option-chain (' + D.oi.status + ')');
  if (D.events && D.events.length) srcs.add(hi ? 'ForexFactory कैलेंडर (निर्धारित)' : 'ForexFactory calendar (SCHEDULED)');
  if (D.newsCount) srcs.add((hi ? 'RSS न्यूज़ फ़ीड ×' : 'RSS news feed ×') + ((D.coverage && D.coverage.feeds) || 15) + (hi ? ' (बहु-स्रोत)' : ' (multi-source)'));
  L.push((hi ? 'स्रोत: ' : 'Sources: ') + Array.from(srcs).join(' | '));
  return L.join('\n');
}
async function gatherWhy(sym) {
  const map = { NIFTY: { y: '^NSEI', td: 'NIFTY', ex: 'NSE', name: 'NIFTY 50' }, BANKNIFTY: { y: '^NSEBANK', td: 'NIFTY_BANK', ex: 'NSE', name: 'BANK NIFTY' }, SENSEX: { y: '^BSESN', td: '', ex: '', name: 'SENSEX' }, FINNIFTY: { y: 'NIFTYFIN.NS', td: '', ex: '', name: 'FINNIFTY' } };
  const m = map[sym] || map.NIFTY;
  const q = await quote(m.y, m.td, m.ex);
  if (!q) return { move: null };
  let moveSrc = q.src, moveStatus = q.status, movePrice = q.price, moveChg = q.changePct;
  try {
    const g = await growwIndex(sym); // LIVE LTP + LIVE dayChangePerc (Groww=NSE feed)
    if (g && g.value) {
      movePrice = g.value; moveSrc = 'Groww (NSE)'; moveStatus = 'LIVE';
      if (g.dayChangePerc != null) moveChg = +( +g.dayChangePerc).toFixed(2);
      if (g.tsInMillis) q.exchangeTime = g.tsInMillis < 1e12 ? g.tsInMillis * 1000 : g.tsInMillis; // groww ts = epoch SECONDS
    }
  } catch (e) {}
  const [global, fii, oi, vix, cal, secs, majors, ser] = await Promise.all([
    globalRows().catch(() => []),
    fiidii().catch(() => ({ ok: false })),
    chainOI(sym).catch(() => ({ ok: false })),
    quote('^INDIAVIX').catch(() => null),
    calendar().catch(() => ({ ok: false, rows: [] })),
    sectorRows().catch(() => []),
    majorStocks().catch(() => []),
    yahooSeries(m.y).catch(() => null)
  ]);
  const newsToday = newsList('today', 40).today;
  const nc = {
    bull: newsToday.filter(n => /BULL/.test(n.impact)).length,
    bear: newsToday.filter(n => /BEAR/.test(n.impact)).length,
    bullTop: newsToday.filter(n => /BULL/.test(n.impact)),
    bearTop: newsToday.filter(n => /BEAR/.test(n.impact))
  };
  let volume = null;
  if (ser && ser.length >= 3) {
    const last = ser[ser.length - 1];
    const prev = ser.slice(-6, -1).filter(x => x.v);
    if (last && last.v && prev.length) {
      const avg = prev.reduce((a, x) => a + x.v, 0) / prev.length;
      if (avg) volume = { cur: last.v, avg5: Math.round(avg), ratio: +(last.v / avg).toFixed(2) };
    }
  }
  return {
    move: Object.assign({}, q, { price: movePrice, changePct: moveChg }), movePrice, moveSrc, moveStatus, moveAt: q.exchangeTime || Date.now(),
    global, globalSrc: global.length ? global[0].src : 'Yahoo Finance', globalStatus: global.length ? global[0].status : 'UNAVAILABLE',
    fii, oi, vix, events: cal.ok ? cal.rows : [], eventsSrc: 'ForexFactory',
    sectors: secs, majors, volume, crude: (await commFxRows().catch(() => [])).find(x => x.key === 'CRUDE') || null,
    usdinr: (await (async () => { try { return await quote('USDINR=X', 'USD/INR', 'Forex'); } catch (e) { return null; } })()),
    newsCounts: nc, newsCount: newsToday.length, coverage: newsList('all', 1).coverage
  };
}
async function whyMarket(sym, hi) {
  sym = (sym || 'NIFTY').toUpperCase().replace(/[^A-Z]/g, '');
  if (sym === 'BANKNIFTY') sym = 'BANKNIFTY';
  const D = await gatherWhy(sym);
  const name = ({ NIFTY: 'NIFTY 50', BANKNIFTY: 'BANK NIFTY', SENSEX: 'SENSEX', FINNIFTY: 'FINNIFTY' })[sym] || sym;
  return { sym, text: composeWhy(name, D, hi), facts: D };
}

/* ══════════════ 7. COMPOSERS (pure, Hinglish) ══════════════ */
function srcFoot(items) {
  const s = new Set();
  for (const i of items.slice(0, 8)) s.add(i.source + ' @ ' + i.time);
  return Array.from(s).slice(0, 6).join(' | ');
}
function composeNews(nl, label, hi) {
  if (!nl.today.length && !nl.old.length) return UNAVAIL;
  const CATL = { market: 'बाज़ार', india: 'भारत', global: 'वैश्विक', corp: 'कंपनी' };
  const L = [];
  L.push((hi ? 'ट्रेडिंग खबरें — ' : 'TRADING NEWS — ') + istDate(Date.now()) + ' (' + (hi ? (CATL[label] || 'सभी स्रोत') : (label || 'all sources')) + ')', '');
  nl.today.forEach((n, i) => {
    L.push((i + 1) + '. ' + hImp(n.impact, hi) + ' ' + hTitle(n));
    L.push(hi
      ? '   स्रोत: ' + n.source + ' · समय: ' + (n.time || '--') + ' · सत्यापन: ' + hVer(n.verification, hi) + (n.via !== 'RSS' ? ' · द्वारा ' + n.via : '')
      : '   Source: ' + n.source + ' · Time: ' + (n.time || '--') + ' · Verification: ' + n.verification + (n.via !== 'RSS' ? ' · via ' + n.via : ''));
  });
  if (!nl.today.length) L.push(hi ? '(आज की कोई ताज़ा खबर अभी कैश नहीं है — पोल 2 मिनट में चलता है)' : '(aaj ki koi fresh news abhi cached nahi hai — poll 2 min me chalta hai)');
  if (nl.old.length) {
    L.push('', hi ? 'पुरानी खबरें (आज की तरह मत दिखाओ):' : 'PURANI NEWS (aaj ki tarah mat dikhao):');
    nl.old.forEach(n => L.push('• ' + hTitle(n) + (hi ? ' — मूल खबर तिथि: ' : ' — Original News Date: ') + n.date + ' (' + n.source + ') · ' + (hi ? 'सत्यापन: ' : 'Verification: ') + hVer(n.verification, hi)));
  }
  const anyHi = nl.today.concat(nl.old).some(n => n.titleHi);
  L.push('', (hi ? 'स्रोत: ' : 'Sources: ') + (srcFoot(nl.today) || (hi ? 'कोई नहीं' : 'none')) +
    (hi ? ' · कवरेज: फ़ीड ' : ' · Coverage: feeds ') + nl.coverage.feeds + (nl.coverage.newsApi ? ' + NewsAPI' : '') + (nl.coverage.finnhub ? ' + Finnhub' : '') +
    (anyHi ? (hi ? ' · शीर्षक AI से हिंदी में अनूदित (मूल स्टोर में)' : ' · Headlines AI se Hindi me translate (original store me)') : ''));
  return L.join('\n');
}
function composeFiiDii(f, hi) {
  if (!f || !f.ok) return UNAVAIL;
  const L = [hi ? 'FII / DII गतिविधि' : 'FII / DII ACTIVITY', ''];
  L.push(hi
    ? 'पुष्ट डेटा (स्रोत: ' + f.src + ' · तिथि: ' + f.date + ' · स्थिति: ' + hSt(f.status, hi) + ')'
    : 'CONFIRMED DATA (Source: ' + f.src + ' · Date: ' + f.date + ' · Status: ' + f.status + ')');
  L.push(hi
    ? 'FII: खरीद ₹' + (f.fii.buy != null ? Math.round(f.fii.buy).toLocaleString('en-IN') : '--') + ' Cr · बिक्री ₹' + (f.fii.sell != null ? Math.round(f.fii.sell).toLocaleString('en-IN') : '--') + ' Cr · शुद्ध ' + fmtCr(f.fii.net)
    : 'FII: buy ₹' + (f.fii.buy != null ? Math.round(f.fii.buy).toLocaleString('en-IN') : '--') + ' Cr · sell ₹' + (f.fii.sell != null ? Math.round(f.fii.sell).toLocaleString('en-IN') : '--') + ' Cr · NET ' + fmtCr(f.fii.net));
  L.push(hi
    ? 'DII: खरीद ₹' + (f.dii.buy != null ? Math.round(f.dii.buy).toLocaleString('en-IN') : '--') + ' Cr · बिक्री ₹' + (f.dii.sell != null ? Math.round(f.dii.sell).toLocaleString('en-IN') : '--') + ' Cr · शुद्ध ' + fmtCr(f.dii.net)
    : 'DII: buy ₹' + (f.dii.buy != null ? Math.round(f.dii.buy).toLocaleString('en-IN') : '--') + ' Cr · sell ₹' + (f.dii.sell != null ? Math.round(f.dii.sell).toLocaleString('en-IN') : '--') + ' Cr · NET ' + fmtCr(f.dii.net));
  L.push('', hi ? 'बाज़ार व्याख्या (यह तथ्य नहीं — विश्लेषण है):' : 'MARKET INTERPRETATION (ye fact nahi — analysis hai):');
  if (f.fii.net != null && f.dii.net != null) {
    if (f.fii.net < 0 && f.dii.net > 0) L.push(hi
      ? 'FII बिक्री + DII खरीद = विदेशी दबाव अवशोषित हो रहा है; अल्पकाल में रेंज/समेकन झुकाव बन सकता है.'
      : 'FII selling + DII buying = foreign pressure absorb ho rahi hai; short-term me range/consolidation bias ban sakta hai.');
    else if (f.fii.net < 0 && f.dii.net < 0) L.push(hi
      ? 'दोनों शुद्ध विक्रेता हैं — बाज़ार पर व्यापक बिक्री दबाव, जोखिम-दूर संकेत.'
      : 'Dono net seller hain — market par broad selling pressure hai, risk-off signal.');
    else if (f.fii.net > 0 && f.dii.net > 0) L.push(hi
      ? 'दोनों शुद्ध क्रेता हैं — व्यापक संस्थागत समर्थन, सकारात्मक झुकाव.'
      : 'Dono net buyer hain — broad institutional support, positive bias.');
    else L.push(hi
      ? 'FII क्रेता / DII विक्रेता — घरेलू मुनाफावसूली हो सकती है; विदेशी प्रवाह सकारात्मक है.'
      : 'FII buyer / DII seller — domestic profit booking ho sakti hai; foreign flow positive hai.');
  }
  L.push('', hi
    ? 'समय: ' + fmtIst(f.fetchedAt) + ' · NSE आधिकारिक दैनिक डेटा (निपटान में थोड़ी देरी होती है)'
    : 'Time: ' + fmtIst(f.fetchedAt) + ' · NSE official daily data (settle hone me thoda delay hota hai)');
  return L.join('\n');
}
function composeCalendar(cal, hi) {
  if (!cal.ok || !cal.rows.length) return UNAVAIL;
  const now = Date.now();
  const up = cal.rows.filter(x => x.ts >= now - 12 * 3600000).slice(0, 10);
  const L = [hi ? 'आर्थिक / इवेंट कैलेंडर — आने वाले इवेंट' : 'ECONOMIC / EVENT CALENDAR — aane wale events', ''];
  if (!up.length) return UNAVAIL;
  up.forEach((e, i) => {
    L.push((i + 1) + '. [' + hInp(e.impact, hi) + '] ' + e.title);
    L.push(hi
      ? '   ' + e.dateIst + ' ' + e.atIst + ' IST · देश ' + e.country + (e.forecast ? ' · अनुमान ' + e.forecast : '') + (e.previous ? ' · पिछला ' + e.previous : '')
      : '   ' + e.dateIst + ' ' + e.atIst + ' IST · country ' + e.country + (e.forecast ? ' · forecast ' + e.forecast : '') + (e.previous ? ' · previous ' + e.previous : ''));
  });
  L.push('', hi
    ? 'स्रोत: ' + cal.src + ' · स्थिति: ' + hSt(cal.status, hi) + ' · प्राप्त ' + fmtIst(cal.fetchedAt)
    : 'Source: ' + cal.src + ' · Status: ' + cal.status + ' · fetched ' + fmtIst(cal.fetchedAt));
  return L.join('\n');
}
function composeOi(oi, hi) {
  if (!oi || !oi.ok) return UNAVAIL;
  const L = [hi ? 'ऑप्शन चेन / OI — ' + oi.sym : 'OPTION CHAIN / OI — ' + oi.sym, ''];
  L.push((hi ? 'PCR (put/call OI): ' : 'PCR (put/call OI): ') + oi.pcr);
  L.push(hi
    ? 'कुल CE OI: ' + oi.totalCE.toLocaleString('en-IN') + ' · कुल PE OI: ' + oi.totalPE.toLocaleString('en-IN') + ' (समाप्ति ' + oi.expiry + ')'
    : 'Total CE OI: ' + oi.totalCE.toLocaleString('en-IN') + ' · Total PE OI: ' + oi.totalPE.toLocaleString('en-IN') + ' (expiry ' + oi.expiry + ')');
  L.push(hi
    ? 'समर्थन (अधिकतम PE OI): ' + (oi.support && oi.support.strike) + ' · प्रतिरोध (अधिकतम CE OI): ' + (oi.resistance && oi.resistance.strike)
    : 'Support (max PE OI): ' + (oi.support && oi.support.strike) + ' · Resistance (max CE OI): ' + (oi.resistance && oi.resistance.strike));
  L.push((hi ? 'स्पॉट: ' : 'Spot: ') + oi.underlying);
  L.push('', hi
    ? 'स्रोत: ' + oi.src + ' · समय: ' + fmtIst(oi.fetchedAt) + ' · स्थिति: ' + hSt(oi.status, hi)
    : 'Source: ' + oi.src + ' · Time: ' + fmtIst(oi.fetchedAt) + ' · Status: ' + oi.status);
  return L.join('\n');
}
function composeSlNews(ts, items, hi) {
  const L = [hi ? 'SL समय न्यूज़ जांच' : 'SL TIME NEWS CHECK', ''];
  L.push(hi ? 'SL/ट्रेड समय: ' + fmtIst(ts) + ' (' + istDate(ts) + ')' : 'SL/Trade time: ' + fmtIst(ts) + ' (' + istDate(ts) + ')');
  if (!items.length) {
    L.push(hi ? '±30 मिनट में खबर: इस विंडो में कोई सत्यापित न्यूज़ आइटम नहीं मिला.' : 'News in ±30 min: koi bhi verified news item is window me nahi mili.');
    L.push(hi ? 'निष्कर्ष: न्यूज़-संचालित प्रमाण नहीं — SL को तकनीकी रणनीति विफलता की तरह मानो (रूट काज़ इंजन वैसा ही करेगा).'
              : 'Verdict: news-driven evidence NAHI — SL ko technical strategy failure ki tarah treat karo (root cause engine waisa hi karega).');
  } else {
    L.push(hi ? '±30 मिनट में खबरें:' : 'News in ±30 min:');
    items.forEach((n, i) => L.push((i + 1) + '. ' + hImp(n.impact, hi) + ' ' + hTitle(n) + ' — ' + n.source + ' · ' + n.time + ' · ' + hVer(n.verification, hi)));
    L.push(hi ? 'निष्कर्ष: इस विंडो में खबर मिली — तकनीकी विफलता या न्यूज़-संचालित, दोनों का विश्लेषण करो. रूट काज़ रिपोर्ट का newsJudgement देखो; न्यूज़-संचालित हो तो रणनीति त्रुटि मत मानो.'
              : 'Verdict: is window me news mili — technical failure ya news-driven, dono ka analysis karo. Root Cause report ka newsJudgement dekho; news-driven ho to strategy error mat maano.');
  }
  return L.join('\n');
}
function composeStock(d) {
  if (!d || (!d.quote && !d.news.length)) return UNAVAIL;
  const hi = !!d.hi;
  // labels/sentences Hindi mode (sawal Devanagari ya "hindi me" par) — data/numbers waise hi, koi fabrication nahi
const IMPM = { NEUTRAL: 'तटस्थ', BULLISH: 'तेजी', BEARISH: 'मंदी', BULL: 'तेजी', BEAR: 'मंदी', 'VERY BULLISH': 'तीव्र तेजी', 'VERY BEARISH': 'तीव्र मंदी' };
const STM = { LIVE: 'लाइव', DELAYED: 'विलंबित', SCHEDULED: 'निर्धारित', UNAVAILABLE: 'अनुपलब्ध', CONFIRMED: 'पुष्ट', 'CONFIRMED DATA': 'पुष्ट डेटा', STALE: 'पुराना' };
  const imp = v => '[' + (hi && IMPM[v] ? IMPM[v] : v) + ']';
  const ver = v => { let s = v == null ? '' : String(v); if (hi) s = s.replace(/SINGLE-SOURCE/g, 'एकल-स्रोत').replace(/MULTI-SOURCE/g, 'बहु-स्रोत').replace(/UNVERIFIED/g, 'असत्यापित').replace(/\bVERIFIED\b/g, 'सत्यापित'); return s; };
  const stt = v => (hi && STM[v] ? STM[v] : v);
  const L = [hi ? 'शेयर जानकारी — ' + d.sym : 'STOCK INTELLIGENCE — ' + d.sym, ''];
  if (d.quote) L.push(hi
    ? 'मूल्य: ' + d.quote.price + ' (' + fmtPct(d.quote.changePct) + ' पिछले बंद के मुकाबले) — स्रोत: ' + d.quote.src + ' · समय: ' + fmtIst(Date.now()) + ' · स्थिति: ' + stt(d.quote.status)
    : 'Price: ' + d.quote.price + ' (' + fmtPct(d.quote.changePct) + ' vs prev close) — Source: ' + d.quote.src + ' · Time: ' + fmtIst(Date.now()) + ' · Status: ' + d.quote.status);
  if (d.finnhub && d.finnhub.note) L.push('Finnhub: ' + d.finnhub.note);
  L.push('');
  if (d.news.length) {
    L.push(hi ? 'खबरें (मिली):' : 'NEWS (matched):');
    d.news.forEach((n, i) => L.push((i + 1) + '. ' + imp(n.impact) + ' ' + hTitle(n) + ' — ' + n.source + ' · ' + n.time + ' · ' + ver(n.verification)));
    const bear = d.news.filter(n => /BEAR/.test(n.impact)).length, bull = d.news.filter(n => /BULL/.test(n.impact)).length;
    L.push('');
    L.push(hi ? 'कुल असर (खबर + बाज़ार डेटा):' : 'Combined Effect (NEWS + MARKET DATA):');
    if (d.quote && d.quote.changePct != null) {
      const pc = fmtPct(d.quote.changePct);
      if (bull > bear && d.quote.changePct < -0.3) L.push(hi
        ? 'खबर सकारात्मक है लेकिन कीमत की प्रतिक्रिया नकारात्मक (' + pc + ') — बाज़ार ने खबर को अलग तरह से प्राइस किया हो सकता है (सकारात्मक खबर vs नकारात्मक कीमत का विचलन).'
        : 'News positive hai lekin price reaction negative (' + pc + ') — market ne news ko differently price kiya ho sakta hai (news-positive vs price-negative divergence).');
      else if (bear > bull && d.quote.changePct > 0.3) L.push(hi
        ? 'खबर नकारात्मक है लेकिन कीमत ऊपर (' + pc + ') — बिकवाली पहले ही कीमत में शामिल हो चुकी है या डिप पर खरीदारी आ रही है (विचलन).'
        : 'News negative hai lekin price upar (' + pc + ') — selling already price-in ho chuki hai ya buying dip par aa rahi hai (divergence).');
      else if (bear > bull && d.quote.changePct < -0.3) L.push(hi
        ? 'खबर और कीमत दोनों नकारात्मक — मंदी की तस्वीर मेल खा रही है (आत्मविश्वास मध्यम, पुष्टि ट्रेंड संरचना से करें).'
        : 'News aur price dono negative — aligned bearish picture (confidence MEDIUM, confirm trend structure se).');
      else if (bull > bear && d.quote.changePct > 0.3) L.push(hi
        ? 'खबर और कीमत दोनों सकारात्मक — तस्वीर मेल खा रही है (आत्मविश्वास मध्यम).'
        : 'News aur price dono positive — aligned bullish picture (confidence MEDIUM).');
      else L.push(hi
        ? 'खबर और कीमत की प्रतिक्रिया अलग दिशा में नहीं — कोई बड़ा विचलन नहीं। तकनीकी संरचना ही हावी है।'
        : 'News aur price reaction alag disha me nahi — koi strong divergence nahi. Technical structure hi dominant.');
    } else L.push(hi ? 'कीमत का डेटा अनुपलब्ध — सिर्फ खबर से निष्कर्ष मत बनाओ।' : 'Price data UNAVAILABLE — sirf news se conclusion mat banao.');
  } else {
    L.push(hi
      ? 'खबर: इस शेयर पर अभी मेरे पास सत्यापित/वर्तमान खबर उपलब्ध नहीं है — ' + UNAVAIL
      : 'News: is stock par abhi mere paas verified/current news available nahi hai — ' + UNAVAIL);
  }
  L.push('', hi
    ? 'ध्यान दें: सिर्फ सार्वजनिक रूप से सत्यापित खबर/फाइलिंग ही इस्तेमाल हुई हैं — जब तक घोषित डेटा न हो, कोई पोजीशन/होल्डिंग का दावा नहीं।' +
      (d.news.some(n => n.titleHi) ? ' शीर्षक AI से हिंदी में अनूदित हैं (मूल शीर्षक स्टोर में).' : '')
    : 'Note: sirf publicly verified news/filings use hui hain — koi bhi position/holding ka claim nahi jab tak disclosed data na ho.' +
      (d.news.some(n => n.titleHi) ? ' Headlines AI se Hindi me translate (original title store me).' : ''));
  return L.join('\n');
}
function composeBigInvestor(d, hi) {
  const L = [hi ? 'बड़े निवेशक / संस्थागत गतिविधि' : 'BIG INVESTOR / INSTITUTIONAL ACTIVITY', ''];
  L.push(hi ? 'पुष्ट डेटा:' : 'CONFIRMED DATA:');
  if (d.fii && d.fii.ok) {
    L.push(hi
      ? '• FII शुद्ध ' + fmtCr(d.fii.fii.net) + ' · DII शुद्ध ' + fmtCr(d.fii.dii.net) + ' — स्रोत: ' + d.fii.src + ' · तिथि: ' + d.fii.date + ' · स्थिति: ' + hSt(d.fii.status, hi)
      : '• FII net ' + fmtCr(d.fii.fii.net) + ' · DII net ' + fmtCr(d.fii.dii.net) + ' — Source: ' + d.fii.src + ' · Date: ' + d.fii.date + ' · Status: ' + d.fii.status);
  } else L.push(hi ? '• NSE FII/DII: अनुपलब्ध (आज का आधिकारिक डेटा नहीं मिला — अनुमान नहीं लगाऊंगा)'
                   : '• NSE FII/DII: UNAVAILABLE (aaj ka official data nahi mila — guess nahi karunga)');
  if (d.deals.length) {
    L.push('', hi ? 'सार्वजनिक रूप से घोषित गतिविधि (खबरों से, तिथियों के साथ):' : 'PUBLICLY DISCLOSED activity (news se, dates ke saath):');
    d.deals.forEach((n, i) => L.push((i + 1) + '. ' + hImp(n.impact, hi) + ' ' + hTitle(n) + ' — ' + n.source + ' · ' + n.time + ' · ' + n.date + ' · ' + hVer(n.verification, hi)));
  }
  if (d.alloc.length) {
    L.push('', hi ? 'सेक्टर आवंटन संकेत (घोषित खबर आधारित):' : 'Sector allocation signals (disclosed news basis):');
    d.alloc.forEach(a => L.push('• ' + a.name + ': ' + fmtPct(a.changePct) + (hi ? ' संस्थागत-प्रवाह खबर टैग — प्रॉक्सी, पुष्ट आवंटन नहीं'
                                                                              : ' institutional-flow news tags — proxy, confirmed allocation NAHI')));
  }
  L.push('', hi
    ? 'महत्वपूर्ण: यह सिर्फ सार्वजनिक रूप से उपलब्ध/सत्यापित डेटा है. किसी निवेशक ने कौन सी पोजीशन ली — जब तक आधिकारिक फाइलिंग/घोषित सौदा न हो, वह दावा नहीं करूंगा. पुरानी जानकारी की तिथियां ऊपर दी गई हैं.'
    : 'IMPORTANT: ye sirf publicly available/verified data hai. Kisi investor ne kya position liya — jab tak official filing/disclosed deal na ho, wo claim NAHI karunga. Purani info ki dates upar di gayi hain.');
  if (!d.fii.ok && !d.deals.length) return UNAVAIL;
  L.push(hi ? 'समय: ' + fmtIst(Date.now()) + ' · स्रोत: NSE + RSS फ़ीड' : 'Time: ' + fmtIst(Date.now()) + ' · Sources: NSE + RSS feeds');
  return L.join('\n');
}

/* ══════════════ 8. INTENT DETECT + ANSWER DISPATCH ══════════════ */
const WHYW = ['kyu', 'kyo', 'kyon', 'kyun', 'why', 'wajah', 'vajah', 'karan', 'kya hua', 'kya ho', 'क्यों', 'क्यूं', 'कारण', 'वजह'];
const MKTW = ['market', 'nifty', 'banknifty', 'bank nifty', 'sensex', 'बाजार', 'बाज़ार', 'निफ्टी', 'शेयर बाजार'];
const NEWSW = ['news', 'khabar', 'khabre', 'khabrain', 'headline', 'headlines', 'खबर', 'खबरें', 'समाचार', 'न्यूज'];
function detect(q) {
  const t = ' ' + String(q || '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim() + ' ';
  const W = s => t.includes(s);
  const why = WHYW.some(W), newsW = NEWSW.some(W);
  const stockish = W('stock') || W('share') || W('शेयर') || W('स्टॉक') || W('price') || W('kaisa ') || W('kya ') || W('कैसा') || W('क्या') || W('kamjor') || W('mazboot') || W('chal raha') || W('chal ') ||
    W('bare me') || W(' ke bare') || W('batao') || W('bata ') || W('hindi') || W('jaankari') || W('detail') ||
    W('के बारे में') || W('जानकारी') || W('हिंदी') || W('हिन्दी') || W('बताओ') || W('बता');
  const slW = W(' sl ') || W(' stop loss') || W(' stoploss') || W('stopp') || W('ट्रेड') && newsW;
  if ((W(' sl ') || W('stop loss') || W('stoploss')) && newsW) return 'slnews';
  for (const [sym, als] of Object.entries(STOCK_ALIAS)) {
    if (als.some(a => W(' ' + a + ' ')) && (why || newsW || stockish || W(' gir') || W('gira') || W('gir r') || W('badh') || W('upar') || W('neeche') || W('fall') || W('rise') || W('गिर') || W('बढ़') || W('बढ़ रहा') || W('नीचे') || W('ऊपर'))) return 'stock:' + sym;
  }
  if (W('fii') || W('dii') || W('fiis') || W('diis') || W('institutional') || W('institution money') || W('foreign institutional')) return 'fiidii';
  if (W('bade investor') || W('big investor') || W('bada investor') || W('bade log') || W('kahan invest') || W('paisa kahan') || W('holding') || W('holdings') || W('kahan laga') || W('बड़े निवेशक') || W('kis sector me paisa') || W('बड़े लोग') || W('बड़ा निवेशक') || W('कौन से स्टॉक') || W('किस स्टॉक') || W('इन्वेस्ट कर रहे') || W('निवेश कर रहे') || W('पैसा लगा') || W('kis stock me') || W('konsa stock') || W('kaun se stock') || W('invest kar rahe') || W('smart money') || W('big money') || W('kahan laga rahe')) return 'biginvestor';
  if (W('calendar') || W('agenda') || W('economic event') || W('events') || W('event ') || W('upcoming') || W('rbi policy') || W('rbi meet') || W('fed meet') || W('fed meeting') || W('rate decision') || W('kal ke event') || W('kal kya') || W('aane wale') || W('कार्यक्रम') || W('बैठक') || W('इवेंट') || W('कैलेंडर') || W('आर्थिक इवेंट') || W('इकोनॉमिक इवेंट')) return 'calendar';
  if (W('pcr') || W('open interest') || W(' put call') || W('ऑप्शन चेन') || W('विकल्प श्रृंखला') || /(^| )oi( |$)/.test(t) || (W('option chain') && (why || W('kaisa') || W('kya') || W('status') || W('bata')))) return 'oi';
  if (newsW) return 'news';
  if (MKTW.some(W) && why && !slW) return 'why';
  if (MKTW.some(W) && (W('kaisa rahega') || W('kya rahega')) && !slW) return 'calendar';
  return null;
}
async function answer(kind, q, ctx) {
  try {
    ctx = ctx || {};
    // Hindi mode: sawal Devanagari me ho ya user explicitly "hindi me" bole — report ke labels Hindi (Devanagari)
    const qStr = String(q || '');
    const hi = /[\u0900-\u097F]/.test(qStr) || /\bhindi\b/i.test(qStr);
    if (kind === 'why') {
      const t = ' ' + String(q || '').toLowerCase() + ' ';
      const sym = (t.includes('bank') || t.includes('बैंक')) ? 'BANKNIFTY' : (t.includes('sensex') || t.includes('सेंसेक्स')) ? 'SENSEX' : t.includes('finnifty') ? 'FINNIFTY' : 'NIFTY';
      return (await whyMarket(sym, hi)).text;
    }
    if (kind === 'news') {
      const t = String(q || '').toLowerCase();
      const cat = /global|us |usa|america|world|fed|international|दुनिया/.test(t) ? 'global' : /stock|company|earnings|dividend|ipo/.test(t) ? 'corp' : /fii|dii|institution/.test(t) ? 'india' : 'market';
      const nl = newsList(cat, 10);
      const titles = nl.today.concat(nl.old).map(x => x.title);
      const hs = await hiTrans(titles);
      let i = 0; nl.today.forEach(x => { x.titleHi = hs[i++]; }); nl.old.forEach(x => { x.titleHi = hs[i++]; });
      return composeNews(nl, cat, hi);
    }
    if (kind === 'fiidii') return composeFiiDii(await fiidii(), hi);
    if (kind === 'calendar') return composeCalendar(await calendar(), hi);
    if (kind === 'oi') return composeOi(await chainOI(String(q || '').toLowerCase().includes('bank') ? 'BANKNIFTY' : 'NIFTY'), hi);
    if (kind === 'biginvestor') {
      const f = await fiidii();
      const nl = newsList('all', 60);
      const all = nl.today.concat(nl.old);
      const deals = all.filter(n => (n.tags || []).some(t => ['DEALS', 'PROMOTER', 'FII', 'DII', 'BUYBACK'].includes(t))).slice(0, 8);
      const dhs = await hiTrans(deals.map(x => x.title)); deals.forEach((x, i) => { x.titleHi = dhs[i]; });
      return composeBigInvestor({ fii: f, deals, alloc: (await sectorRows().catch(() => [])).slice(0, 4) }, hi);
    }
    if (kind && kind.startsWith('stock:')) {
      const YSYM = { REC: 'RECLTD' };  // Yahoo ka symbol NSE se alag ho sakta hai
      const sym = kind.slice(6);
      let quoteQ = null;
      try { quoteQ = await quote((YSYM[sym] || sym) + '.NS', sym, 'NSE'); } catch (e) { quoteQ = null; }
      let comp = newsArr.filter(x => x.stock === sym).slice(0, 8).map(annotate);
      let finnhubNote = '';
      try {
        const fh = await finnhubCompany(sym);
        if (fh.length) { mergeItems(fh); comp = newsArr.filter(x => x.stock === sym).slice(0, 8).map(annotate); finnhubNote = hi ? fh.length + ' आइटम (कंपनी-न्यूज़ API, स्रोत Finnhub)' : fh.length + ' items (company-news API, source Finnhub)'; }
        else if (KEYS.finnhub) finnhubNote = hi ? 'कंपनी-न्यूज़ में कुछ नहीं मिला (आज के दिन)' : 'company-news me kuch nahi mila (aaj ke din)';
      } catch (e) {
        if (KEYS.finnhub) {
          // 403 = key sahi hai, par is plan par NSE symbols (.NS) allowed nahi — sach wala saaf note
          finnhubNote = /403/.test(String(e.message || ''))
            ? (hi ? 'यह FINNHUB_KEY प्लान NSE सिंबल (.NS) के लिए अनुमत नहीं (HTTP 403) — कंपनी खबरें RSS/NewsAPI से मिल रही हैं'
                  : 'is FINNHUB_KEY plan par NSE symbols (.NS) allowed nahi (HTTP 403) — company news RSS/NewsAPI se mil rahi hai')
            : (hi ? 'API विफल: ' + e.message : 'API fail: ' + e.message);
        }
      }
      const chs = await hiTrans(comp.map(x => x.title)); comp.forEach((x, i) => { x.titleHi = chs[i]; });
      return composeStock({ sym, quote: quoteQ, news: comp, finnhub: { note: finnhubNote }, hi });
    }
    if (kind === 'slnews') {
      const tsList = (ctx.miTs && ctx.miTs.length ? ctx.miTs : []).slice(-3).reverse();
      if (!tsList.length) return hi
        ? 'मेरे पास अभी कोई SL/ट्रेड रिकॉर्ड नहीं है इस वक्त — न्यूज़ जांचने के लिए ट्रेड इतिहास चाहिए. (सर्वर आज शुरू हुआ हो तो पुराने रिकॉर्ड रीस्टार्ट में कैश नहीं होते.)'
        : 'Mere paas abhi koi SL/trade record nahi hai is waqt — news check karne ke liye trade history chahiye. (Server aaj start hua ho to purani records restart me cached nahi hoti.)';
      const blocks = [];
      for (const ts of tsList) {
        const items = newsAroundSync(ts, 30 * 60000);
        const ihs = await hiTrans(items.map(x => x.title)); items.forEach((x, i) => { x.titleHi = ihs[i]; });
        blocks.push(composeSlNews(ts, items, hi));
      }
      return blocks.join('\n\n─────\n\n');
    }
    return UNAVAIL;
  } catch (e) {
    return UNAVAIL;
  }
}

/* ══════════════ 9. OVERVIEW / QUICK / POLLING ══════════════ */
async function overview() {
  const hit = cGet('ov', isMkt() ? 60000 : 300000);
  if (hit) return hit;
  const [india, global, comm, fii, oi, cal, secs] = await Promise.all([
    indiaRows().catch(() => []),
    globalRows().catch(() => []),
    commFxRows().catch(() => []),
    fiidii().catch(() => ({ ok: false })),
    chainOI('NIFTY').catch(() => ({ ok: false })),
    calendar().catch(() => ({ ok: false, rows: [] })),
    sectorRows().catch(() => [])
  ]);
  const out = {
    india, global, comm, fiidii: fii, chain: oi,
    calendarNext: cal.ok ? cal.rows.filter(x => x.ts >= Date.now()).slice(0, 5) : [],
    sectors: secs,
    newsTop: newsList('market', 5).today.slice(0, 5),
    fetchedAt: Date.now(),
    note: 'Status tags: LIVE=exchange feed (Groww/NSE), DELAYED=free delayed feed (Yahoo/Twelve), CONFIRMED=official daily data, UNAVAILABLE=fail (no fabrication)'
  };
  cSet('ov', out);
  return out;
}
function quick() {
  const ov = cGet('ov', 3600000);
  const g = (ov && ov.global || []).filter(r => ['SP500', 'DOW', 'NIKKEI', 'CRUDE'].includes(r.key));
  const comm = (ov && ov.comm || []).filter(r => ['CRUDE', 'GOLD', 'USDINR', 'BTC'].includes(r.key));
  const vix = (ov && ov.india || []).find(r => r.key === 'INDIAVIX');
  const parts = [];
  if (g.length) parts.push(g.map(r => r.key + ' ' + fmtPct(r.changePct)).join(' · '));
  if (comm.length) parts.push(comm.map(r => r.key + (r.key === 'CRUDE' || r.key === 'GOLD' || r.key === 'BTC' ? ' $' : ' ') + (r.key === 'USDINR' ? r.price : typeof r.price === 'number' ? (r.key === 'BTC' ? Math.round(r.price / 1000) + 'k' : r.price.toFixed(2)) : r.price)).join(' · '));
  if (vix) parts.push('VIX ' + vix.price);
  const head = newsList('market', 3).today[0];
  const fii = cGet('fiidii', 24 * 3600000);
  const cal = cGet('cal', 24 * 3600000);
  const nextEv = cal && cal.ok ? cal.rows.filter(x => x.ts >= Date.now())[0] : null;
  return {
    globalLine: parts.join(' | '),
    headline: head ? { t: head.title.slice(0, 90), impact: head.impact, src: head.source, time: head.time, v: head.verification } : null,
    fii: fii && fii.ok ? { net: fii.fii.net, date: fii.date, status: fii.status } : { status: 'UNAVAILABLE' },
    nextEvent: nextEv ? { t: nextEv.title.slice(0, 70), at: nextEv.atIst + ' IST', impact: nextEv.impact, src: 'ForexFactory' } : null,
    fetchedAt: Date.now()
  };
}
const lastAt = {};
function due(k, ttl) { if (Date.now() - (lastAt[k] || 0) >= ttl) { lastAt[k] = Date.now(); return true; } return false; }
async function tick() {
  try {
    const mkt = isMkt();
    if (due('news', mkt ? 120000 : 600000)) pollFeeds().catch(() => {});
    if (due('newsapi', 1800000)) newsApiFetch().then(mergeItems).catch(e => { newsErrs.NewsAPI = e.message; });
    if (due('finnhub', 600000)) finnhubFetch().then(mergeItems).catch(e => { newsErrs.Finnhub = e.message; });
    if (due('fiidii', 900000)) fiidii().catch(() => {});
    if (due('cal', 15 * 60000)) calendar().catch(() => {});
    if (due('oi', 120000)) chainOI('NIFTY').catch(() => {});
    if (due('ov', mkt ? 60000 : 300000)) overview().catch(() => {});
    if (mkt && due('sample', 180000)) {
      const nifty = (cGet('ov', 600000) || {}).india || [];
      const row = nifty.find(r => r.key === 'NIFTY');
      if (row && row.price) sampleTick(row.price);
    }
    eodCheck();
  } catch (e) {}
}
let timer = null;
function startPolling() {
  if (timer) return;
  pollFeeds().then(() => { try { eodCheck(); } catch (e) {} }).catch(() => {});
  calendar().catch(() => {});
  overview().catch(() => {});
  timer = setInterval(tick, 60000);
  if (timer.unref) timer.unref();
}
function stopPolling() { if (timer) clearInterval(timer); timer = null; }

/* ── exports ── */
module.exports = {
  startPolling, stopPolling, tick,
  overview, quick, whyMarket, newsList, newsAroundSync, fiidii, chainOI, calendar,
  journal: ensureJournal, timeline, answer, detect,
  newsApiFetch, finnhubFetch, pollFeeds, mergeItems,
  parseRSS, classifyImpact, normTitle, jaccard, ffParse, yahooParse, composeWhy, composeNews,
  composeFiiDii, composeCalendar, composeSlNews, detectFn: detect,
  get store() { return newsArr; },
  _test: {
    parseRSS, classifyImpact, mergeItems, normTitle, jaccard, ffParse, yahooParse, stripHtml, istDate, fmtIst,
    composeWhy, composeNews, composeFiiDii, composeCalendar, composeOi, composeSlNews, composeStock, composeBigInvestor,
    detect, answer, factorList, confSummary, newsAroundSync, verifyAll, annotate, istNow, isMkt,
    setNews(arr) { newsArr = arr; }, getNews() { return newsArr; },
    KEYS
  }
};
