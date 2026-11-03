/* ─── DS ZONE — AI AGENT (SL REASON + SUGGEST + APPROVED FIX) ─────────
   Har auto EXIT (TARGET / STOP LOSS / ZONE OUT) observe karta hai aur
   SL ka ASLI reason identify karta hai (ATR Nahi — reason pehle):

   • SL detection → poora trade context + candles + zone save (journal)
   • Post-SL price action: WHIPSAW / SWEEP / CONTINUE / REVERSE / CONFIRMED
   • Real-market analysis: trend (HTF/ITF/LTF), structure (HH/HL/LH/LL,
     BOS/ChoC), zone quality, momentum, volatility, ATR — sirf LIVE data se
   • Strategy rule KABHI khud nahi badalta: SUGGEST karta hai, user
     "apply karo" bole tabhi lagta hai (manualFix = user approval)
   • ATR (slBufAtr) sirf tabhi suggest hota hai jab reason tight-SL ho,
     aur tab bhi sirf LIMITS.slBufAtr ke andar (SYSTEM RULE v1.1 = 10% locked)
   • Cooldown = safety (lagatar SL par 10 min entry pause — auto)

   Agent state: <storeDir>/ai-agent.json  (persist — restart ke baad bhi yaad)
   ─────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');
try { require('dotenv').config(); } catch (e) {}

// ── GEMINI (Google AI) — SL ka reason samajhke khud fix karta hai ──
// key .env me GEMINI_API_KEY (AQ. format = naya Gemini Authentication Key)
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
// fallback chain — jo pehle chale usko yaad rakho (404/503 par agla try)
const GEMINI_MODELS = [
  process.env.GEMINI_MODEL || '',
  'gemini-flash-lite-latest',
  'gemini-3.5-flash-lite',
  'gemini-flash-latest',
  'gemini-3.5-flash',
  'gemini-3.8-flash'
].filter(Boolean);
let gemModelOk = null;   // session me kaunsa model chal raha hai

// ── USER KI PDF KNOWLEDGE (gitignored — sirf localhost agent, GitHub par nahi).
//    Sirf ek PDF: Trading In The Zone — zone formation/methodology ──
function loadKnow(f) {
  try { return fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\s+/g, ' ').trim(); }
  catch (e) { return ''; }
}
const zoneKnow = loadKnow('zone-knowledge.txt');
const knowAll = zoneKnow ? '--- ZONE METHODOLOGY (user ki PDF: Trading In The Zone) ---\n' + zoneKnow : '';

async function askGeminiOnce(model, userText, opts) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const to = setTimeout(() => { try { ctl && ctl.abort(); } catch (e) {} }, opts.timeoutMs || 25000);
  try {
    const body = {
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: {
        temperature: opts.temp != null ? opts.temp : 0.25,
        maxOutputTokens: opts.maxTokens || 900
      }
    };
    if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };
    if (opts.json) body.generationConfig.responseMimeType = 'application/json';
    const r = await fetch(GEMINI_BASE + model + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
      body: JSON.stringify(body),
      signal: ctl && ctl.signal
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) return { err: 'HTTP ' + r.status };
    const txt = j && j.candidates && j.candidates[0] && j.candidates[0].content &&
      j.candidates[0].content.parts && j.candidates[0].content.parts[0]
      ? j.candidates[0].content.parts[0].text : null;
    if (!txt) return { err: 'empty' };
    return { txt };
  } catch (e) { return { err: e.name || e.message }; }
  finally { clearTimeout(to); }
}

async function askGemini(userText, opts) {
  if (!GEMINI_KEY) return null;
  opts = opts || {};
  const order = gemModelOk ? [gemModelOk].concat(GEMINI_MODELS.filter(m => m !== gemModelOk)) : GEMINI_MODELS;
  for (const m of order) {
    const r = await askGeminiOnce(m, userText, opts);
    if (r && r.txt) { gemModelOk = m; return r.txt; }
  }
  return null;
}

const DEFAULTS = {
  slBufAtr: 0.10,          // SYSTEM RULE (locked): SL = distal ∓ 0.10 × ATR(14)
  entryBufAtr: 0,          // SYSTEM RULE (locked): entry = proximal (first touch limit)
  tgtMult: 2,             // SYSTEM RULE (locked): PDF target = risk × 2 (2:1 — double of Entry−SL)
  minScore: 5,             // kam se kam trade score (agent tune kar sakta hai)
  minRR: 2,               // SYSTEM RULE (locked): PDF 2:1 target hi system me valid hai
  maxAtrDist: 7,           // zone kitna door ho sakta hai (ATR me)
  trendAlign: false,       // sirf trend-aligned zone lo
  freshOnly: true,         // SYSTEM RULE (locked): sirf FRESH zone — first touch
  allowStale: true,        // last-resort stale zone pass (engine ka pass D)
  maxZoneWidthAtr: 1.5     // zone width limit — 1.5 ATR se chaudi zone = bada SL/target, reject
};

// SYSTEM RULES — engine inhe hamesha enforce karta hai; agent inhe tune NAHI kar sakta
const SYSTEM_LOCKED = ['slBufAtr', 'entryBufAtr', 'tgtMult', 'minRR', 'freshOnly'];

// har param ki hadd — agent kabhi inke bahar nahi jayega
// (locked params ki range [x, x] = single point — koi bhi change clamp hokar wahi ban jayega)
const LIMITS = {
  slBufAtr: [0.10, 0.10],
  tgtMult: [2, 2],
  minScore: [5, 7],
  minRR: [2, 2],
  maxAtrDist: [4, 7],
  maxZoneWidthAtr: [1.2, 99]
};

function avg(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function ratio(list, fn) { const n = list.length; const hit = list.filter(fn).length; return { hit, n, r: n ? hit / n : 0 }; }

function createAiAgent(deps) {
  const storeDir = deps.storeDir, fetchCandles = deps.fetchCandles, symbol = deps.symbol;
  const file = path.join(storeDir, 'ai-agent.json');

  let st = null;
  try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  if (!st || typeof st !== 'object') st = {};
  st.params = Object.assign({}, DEFAULTS, st.params || {});
  // purane persisted params ko SYSTEM RULES par reset (PDF: 0.10 ATR SL,
  // target ×2 = 2:1, minRR 2, fresh-only, entry=proximal) + numeric LIMITS me clamp
  for (const k of Object.keys(LIMITS)) {
    const c = LIMITS[k], v = Number(st.params[k]);
    st.params[k] = isFinite(v) ? Math.min(c[1], Math.max(c[0], v)) : DEFAULTS[k];
  }
  st.params.freshOnly = true;
  st.params.entryBufAtr = 0;
  if (!Array.isArray(st.results)) st.results = [];
  if (!Array.isArray(st.log)) st.log = [];
  if (!st.stats) st.stats = {};
  st.stats.targets = st.stats.targets || 0;
  st.stats.sls = st.stats.sls || 0;
  st.stats.outs = st.stats.outs || 0;
  st.stats.whipsaw = st.stats.whipsaw || 0;
  st.stats.consecSL = st.stats.consecSL || 0;
  if (!st.stats.byDiag) st.stats.byDiag = {};
  if (typeof st.cooldownUntil !== 'number') st.cooldownUntil = 0;
  if (typeof st.lastReview !== 'number') st.lastReview = 0;
  if (st.aiDiag == null) st.aiDiag = null;           // last Gemini diagnosis {ts, reason, fix, note}
  if (typeof st.llmCalls !== 'number') st.llmCalls = 0;
  if (!Array.isArray(st.journal)) st.journal = [];   // DAILY LIVE LOG — entry/SL/target + prices (persist, delete nahi hota)
  if (!Array.isArray(st.slAnalysis)) st.slAnalysis = [];   // structured STOP LOSS ANALYSIS reports (cap 10)
  // same trade ki duplicate report hatao (tf+entry+sl identity) — purane bug se ek hi SL ki 2-3 copies ban gayi thin
  { const _seen = new Set(); st.slAnalysis = (st.slAnalysis || []).filter(x => {
    const _k = x.tf + '|' + Math.round(x.entry || 0) + '|' + Math.round(x.sl || 0);
    if (_seen.has(_k)) return false; _seen.add(_k); return true;
  }); }
  if (!Array.isArray(st.slEvents)) st.slEvents = [];       // rich SL events — poora trade context (cap 20)
  if (st.suggest == null) st.suggest = null;               // pending SUGGESTION — user approval ke liye (auto-apply NAHI)
  if (st.learn == null) st.learn = null;                   // learning stats — historical trades se pattern
  if (st.snap == null) st.snap = null;                     // last market snapshot (trend/structure/volatility)
  // ── strategy versioning + validation + root-cause DB (requirement #10-#15) ──
  if (typeof st.version !== 'string') st.version = 'v1.0';           // Strategy vX.Y — rollback capability
  if (!Array.isArray(st.versions)) st.versions = [];                  // har change ka version record
  if (!st.validation) st.validation = null;                           // last validation result
  if (st.caution == null) st.caution = null;                          // CAUTION MODE (3+ lagatar SL)
  if (!Array.isArray(st.rootCauses)) st.rootCauses = [];              // root-cause DB (cap 50)
  if (!st.rootCauseStats) st.rootCauseStats = {};                     // recurring pattern: code → count
  if (!Array.isArray(st.autoTrades)) st.autoTrades = [];              // 3m/5m AUTO-TRADE events (chain screen se bridge, cap 200)
  if (st.chainDay == null) st.chainDay = null;                        // aaj ka chain day summary {d, exits, wins, losses, sls, pnl}
  if (st.chainSync == null) st.chainSync = null;                      // chain screen wallet snapshot (cash/open/net — 60s sync)
  let engineAn = null;                                               // live engine context (persist nahi)
  let INTEL = null;                                                  // market-intel module (news/global/FII/calendar — persist nahi)
  st.journal.forEach(x => {                           // self-heal: ts = asli trade time (date+time), insert-time nahi
    if (x && x.date && x.time) { const d = new Date(x.date + 'T' + x.time); if (!isNaN(d)) x.ts = d.getTime(); }
  });
  let journalSeen = null, journalSeeded = false;     // dedup keys + pehli sync = baseline (purane entries diagnose nahi)

  let reviewing = false;
  let aiBusy = false, aiLast = 0, pendingDiag = null;   // rate-limit par SL diagnosis yahan queue hota hai
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(st)); } catch (e) {} };
  const log = (type, msg) => {
    st.log.unshift({ ts: Date.now(), type, msg });
    if (st.log.length > 40) st.log.length = 40;
  };
  const clamp = (k, v) => { const c = LIMITS[k]; return c ? Math.min(c[1], Math.max(c[0], v)) : v; };

  function tune(k, v, diagKey, why) {
    if (!(k in st.params)) return false;                  // HARD GUARD: sirf existing tuning keys — unrelated indicator logic kabhi nahi badalta
    const nv = typeof v === 'number' ? clamp(k, Math.round(v * 1000) / 1000) : v;
    if (nv === st.params[k]) return false;
    st.params[k] = nv;
    st.stats.byDiag[diagKey] = (st.stats.byDiag[diagKey] || 0) + 1;
    log('TUNE', why + ' → ' + k + '=' + nv);
    save();
    return true;
  }

  // ── har exit par call hota hai (auto-bot se) ──
  // SL par poora trade context save: entry zone (proximal/distal/pattern/entryType),
  // trend, market regime, zone strength (score/fresh), ATR, entry/exit time+price ──
  function observe(r) {
    const meta = r.meta || {};
    const rec = {
      ts: Date.now(),
      exitTs: r.exitTs || Date.now(),
      entryTs: r.entryTs || 0,
      kind: r.kind,
      tf: r.tf || meta.tf || '3m',
      dir: r.dir || meta.dir || '',
      score: r.score != null ? r.score : (meta.score != null ? meta.score : null),
      fresh: r.fresh || meta.fresh || '',
      trend: r.trend || meta.trend || '',
      regime: r.regime || meta.regime || '',
      atr: r.atr || meta.atr || 0,
      spotAtEntry: r.spotAtEntry || meta.spot || 0,
      spotAtExit: r.spotAtExit || 0,
      zone: r.zone || (meta.zoneTgt ? { entry: meta.zoneEntry, sl: meta.zoneSl, tgt: meta.zoneTgt } : null),
      pnl: Math.round(r.pnl || 0),
      post: r.kind === 'SL' ? null : 'SKIP',
      // entry-time zone + structure (PDF facts)
      pattern: r.pattern || meta.pattern || '',
      zoneType: r.zoneType || meta.zoneType || '',
      entryType: r.entryType || meta.entryType || '',
      proximal: r.proximal || meta.proximal || 0,
      distal: r.distal || meta.distal || 0,
      zoneTime: r.zoneTime || meta.zoneTime || 0,
      baseCount: r.baseCount || meta.baseCount || 0,
      zoneStrength: r.zoneStrength || meta.zoneStrength || '',
      entryRule: r.entryRule || meta.entryRule || '',
      marking: r.marking || meta.marking || 'NORMAL',
      authentic: r.authentic != null ? r.authentic : (meta.authentic != null ? meta.authentic : true),
      curve: r.curve || meta.curve || '',
      htfTrend: r.htfTrend || meta.htfTrend || '',
      sma50: r.sma50 || meta.sma50 || 0,
      zoneDist: r.zoneDist || meta.zoneDist || 0,
      riskReward: r.riskReward || meta.riskReward || 0
    };
    st.results.push(rec);
    if (st.results.length > 40) st.results.shift();

    if (r.kind === 'TARGET') { st.stats.targets++; st.stats.consecSL = 0; }
    else if (r.kind === 'SL') { st.stats.sls++; st.stats.consecSL++; }
    else st.stats.outs++;
    try { cautionFlow(); } catch (e) {}

    // rich SL EVENT — requirement #1: entry/SL/hit price, times, zone, trend, structure, ATR
    if (r.kind === 'SL') {
      // requirement #10 (news): SL ke ±30 min ki news save — technical vs news-driven decide ho
      let newsAtSl = [];
      try { newsAtSl = INTEL ? INTEL.newsAroundSync(rec.exitTs || Date.now(), 30 * 60000) : []; } catch (e) {}
      rec.newsCtx = newsAtSl;
      st.slEvents.push({
        ts: rec.ts, tf: rec.tf, dir: rec.dir,
        entry: (rec.zone && rec.zone.entry) || rec.spotAtEntry || 0,
        sl: (rec.zone && rec.zone.sl) || 0,
        slHit: rec.spotAtExit || 0,
        entryTs: rec.entryTs, slHitTs: rec.exitTs,
        zoneType: rec.zoneType, pattern: rec.pattern, entryType: rec.entryType,
        proximal: rec.proximal, distal: rec.distal, zoneTime: rec.zoneTime,
        zoneStrength: rec.score, fresh: rec.fresh, trend: rec.trend, regime: rec.regime,
        atr: rec.atr, pnl: rec.pnl, post: null, analysis: null,
        newsAtSl: newsAtSl
      });
      if (st.slEvents.length > 20) st.slEvents.shift();
      if (newsAtSl.length) log('NEWS-SL', 'SL ±30 min me ' + newsAtSl.length + ' news: ' +
        newsAtSl.slice(0, 2).map(n => '[' + n.impact + '] ' + String(n.title).slice(0, 55)).join(' | '));
    }

    log('EXIT', rec.tf + ' ' + rec.dir + ' ' + r.kind +
      (rec.score != null ? ' · score ' + rec.score : '') +
      (rec.fresh ? ' · ' + rec.fresh : '') +
      (rec.trend ? ' · trend ' + rec.trend : '') +
      (rec.regime ? ' · ' + rec.regime : ''));
    updLearn();
    save();
    // SL hua → Gemini se REAL-MARKET analysis (suggestion banata hai, khud apply NAHI)
    if (r.kind === 'SL') { aiDiagnose(rec).catch(() => {}); }
    return rec;
  }

  // ── LEARNING SYSTEM (requirement #7): har trade result se stats + pattern ──
  function updLearn() {
    const res = st.results;
    const sls = res.filter(r => r.kind === 'SL'), tg = res.filter(r => r.kind === 'TARGET');
    const mk = () => ({ n: 0, w: 0, l: 0 });
    const resolved = sls.length + tg.length;
    const L = {
      total: res.length, targets: tg.length, sls: sls.length,
      outs: res.filter(r => r.kind === 'OUT').length,
      consecSL: st.stats.consecSL,
      winRate: resolved ? Math.round(100 * tg.length / resolved) : 0,
      whipsaw: st.stats.whipsaw || 0,
      avgRR: 0, avgSLDist: 0, avgSLAtr: 0, avgTgtDist: 0,
      byZone: { fresh: mk(), tested: mk() },
      byTrend: { up: mk(), down: mk(), sideways: mk() },
      byEntryType: {},
      byHour: {},
      totalSL: 0, totalWin: 0
    };
    const rrs = [], sds = [], sas = [], tds = [];
    for (const r of res) {
      const win = r.kind === 'TARGET' ? 1 : 0;
      const loss = r.kind === 'SL' ? 1 : 0;
      if (r.fresh === 'fresh' || r.fresh === 'tested') {
        const b = L.byZone[r.fresh]; b.n++; b.w += win; b.l += loss;
      }
      if (r.trend) {
        const b = L.byTrend[r.trend] || (L.byTrend[r.trend] = mk());
        b.n++; b.w += win; b.l += loss;
      }
      if (r.entryType) {
        const b = L.byEntryType[r.entryType] || (L.byEntryType[r.entryType] = mk());
        b.n++; b.w += win; b.l += loss;
      }
      const h = new Date(r.entryTs || r.exitTs || r.ts).getHours();
      {
        const b = L.byHour[h] || (L.byHour[h] = mk());
        b.n++; b.w += win; b.l += loss;
      }
      if (r.zone && r.zone.entry != null && r.zone.sl != null) {
        const sd = Math.abs(r.zone.entry - r.zone.sl);
        sds.push(sd);
        if (r.atr > 0) sas.push(sd / r.atr);
        if (r.zone.tgt != null && sd > 0) rrs.push(Math.abs(r.zone.tgt - r.zone.entry) / sd);
        if (r.zone.tgt != null) tds.push(Math.abs(r.zone.tgt - r.zone.entry));
      }
      L.totalSL += loss; L.totalWin += win;
    }
    if (rrs.length) L.avgRR = Math.round(avg(rrs) * 100) / 100;
    if (sds.length) L.avgSLDist = Math.round(avg(sds) * 10) / 10;
    if (sas.length) L.avgSLAtr = Math.round(avg(sas) * 100) / 100;
    if (tds.length) L.avgTgtDist = Math.round(avg(tds) * 10) / 10;
    st.learn = L;
  }

  // pattern finding — requirement #7 ka example style: data dekh kar asli pattern
  function learnAnswer() {
    updLearn();                                              // restart ke baad bhi turant calculate
    if (!st.learn || !st.learn.total) return 'Abhi koi trade result nahi hai — naye trades aate hi learning stats banne lagenge (total, win rate, zone-wise, trend-wise, entry-type, time-of-day).';
    const L = st.learn;
    const bits = [];
    bits.push('Trades: ' + L.total + ' total — ' + L.targets + ' target, ' + L.sls + ' SL' +
      (L.outs ? ', ' + L.outs + ' zone-out' : '') + ', win rate ' + L.winRate + '%' +
      (L.consecSL ? ', abhi lagatar ' + L.consecSL + ' SL' : ''));
    if (L.avgRR) bits.push('Avg R:R ' + L.avgRR + ', avg SL distance ' + L.avgSLDist + ' pts (' + L.avgSLAtr + ' ATR), avg target ' + L.avgTgtDist + ' pts');
    // zone-wise
    for (const k of ['fresh', 'tested']) {
      const b = L.byZone[k];
      if (b && b.n) bits.push(k + ' zone: ' + b.n + ' trades → ' + b.w + ' win / ' + b.l + ' SL' +
        (b.n >= 3 && b.l > b.w ? ' (SL zyada — ' + k + ' zone par dhyan)' : ''));
    }
    // trend-wise
    for (const k of ['up', 'down', 'sideways']) {
      const b = L.byTrend[k];
      if (b && b.n >= 3) bits.push('trend ' + k + ': ' + b.n + ' trades → ' + b.w + 'W/' + b.l + 'SL' + (b.l >= b.w && k !== 'sideways' ? ' (trend ke against SL zyada — trendAlign ki suggestion banegi)' : ''));
    }
    // entry-type
    const ets = Object.keys(L.byEntryType);
    if (ets.length) bits.push('entry-type: ' + ets.map(k => k + ' ' + L.byEntryType[k].n + ' (' + L.byEntryType[k].w + 'W)').join(', '));
    // time-of-day — best/worst hour
    const hs = Object.keys(L.byHour).map(Number);
    if (hs.length >= 3) {
      const worst = hs.map(h => ({ h, b: L.byHour[h] })).filter(x => x.b.n >= 2).sort((a, b) => (b.b.l - b.b.w) - (a.b.l - a.b.w))[0];
      if (worst && worst.b.l >= 2) bits.push('worst hour: ' + worst.h + ':00 me ' + worst.b.n + ' trades, ' + worst.b.l + ' SL');
    }
    // requirement #7 example style: sabse bada pattern
    const te = L.byZone.tested;
    if (te && te.n >= 3 && te.l >= 2) {
      const share = Math.round(100 * te.l / (L.totalSL || 1));
      bits.push('Pattern: ' + L.sls + ' SL me se ' + te.l + ' (' + share + '%) tested zone se the — isliye ATR badhane ke bajaye tested-zone filter (freshOnly) improve karna sahi hai.');
    } else if (L.byTrend.down && L.byTrend.down.l >= 3) {
      bits.push('Pattern: SL me se ' + L.byTrend.down.l + ' down-trend me hue — trend filter ki suggestion banegi (ATR nahi).');
    }
    // requirement #12: recurring ROOT-CAUSE pattern (root-cause DB se)
    const rcs = st.rootCauseStats || {};
    const rks = Object.keys(rcs).sort((x, y) => rcs[y] - rcs[x]);
    if (rks.length && rcs[rks[0]] >= 2) {
      const nm = (CAUSE_MAP[rks[0]] && CAUSE_MAP[rks[0]].name) || rks[0];
      const act = st.suggest ? 'suggestion pending: ' + st.suggest.k + '=' + st.suggest.v
        : (st.versions.some(v => v.status === 'active' || v.status === 'confirmed') ? 'rule ' + (st.versions.some(v => v.status === 'confirmed') ? 'confirmed' : 'active (paper-validation pending)') + ' (' + st.version + ')' : 'rule check zaroori');
      bits.push('Recurring root cause: [' + rks[0] + '] ' + nm + ' (' + rcs[rks[0]] + ' SL) — ' + act + '.');
    }
    if (st.version && st.version !== 'v1.0') bits.push('Strategy Version ' + st.version + ' (' + st.versions.length + ' changes — rollback capability on).');
    return 'Learning stats (historical trades): ' + bits.join(' · ') + '.';
  }

  // ── SUGGESTION (requirement #6): strategy rule khud NAHI badalta —
  //    suggest karta hai, user "apply karo" bole tabhi lagta hai ──
  function suggest(k, v, why) {
    if (!(k in DEFAULTS)) return false;
    const nv = typeof v === 'number' ? clamp(k, Math.round(v * 1000) / 1000) : v;
    if (nv === st.params[k]) return false;
    if (st.suggest && st.suggest.k === k && st.suggest.v === nv) return false;
    st.suggest = { k, v: nv, why, ts: Date.now() };
    log('SUGGEST', why + ' → suggest ' + k + '=' + nv + ' (approval chahiye — khud apply nahi karunga)');
    save();
    return true;
  }

  function applySuggest() {
    const s = st.suggest;
    if (!s) return { ok: false, msg: 'Abhi koi pending suggestion nahi hai — agent data dekh kar suggest karega, aap bologe tabhi apply hoga.' };
    const before = st.params[s.k];
    if (tune(s.k, s.v, 'user', 'Suggestion APPLY (user approval): ' + s.why)) {
      st.suggest = null; save();
      return { ok: true, msg: 'Suggestion apply ki: ' + s.k + ' ' + before + ' → ' + st.params[s.k] + '. (' + s.why + ')', act: 'fix' };
    }
    st.suggest = null; save();
    return { ok: true, msg: 'Suggestion ka value pehle se lag chuka tha (' + s.k + '=' + st.params[s.k] + ').', act: '' };
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  PDF-BASED UPGRADE — root-cause → rule mapping → historical validation →
  //  AUTO-ACTIVATION (validation PASS) → versioning (v1.x) → auto-rollback →
  //  caution mode.  ATR rules kabhi auto nahi (offline replay possible nahi).
  // ════════════════════════════════════════════════════════════════════════════

  // live engine context (auto-bot ke analyze se) — panel + root-cause analysis
  function setEngine(a) { engineAn = a || null; }
  function setIntel(m) { INTEL = m || null; }
  function intelQuick() { try { return INTEL ? INTEL.quick() : null; } catch (e) { return null; } }

  // requirement #10: trade ke sab PDF facts — deterministic (recorded meta se,
  // engine se fallback). LLM ko facts diye jaate hain, wo invent NAHI karta.
  function tradeFacts(rec) {
    rec = rec || {};
    const z = rec.zone || {};
    const loc = engineAn && engineAn.location;
    return {
      dir: rec.dir || '', tf: rec.tf || '',
      entry: z.entry || rec.entry || 0, sl: z.sl || rec.sl || 0,
      slHit: rec.slHit || rec.spotAtExit || 0,
      zoneType: rec.zoneType || '', pattern: rec.pattern || '',
      zoneStrength: rec.zoneStrength || (rec.score != null && rec.score !== undefined ? 'score ' + rec.score : ''),
      fresh: rec.fresh || '', score: rec.score != null ? rec.score : null,
      entryType: rec.entryType || '', entryRule: rec.entryRule || '',
      baseCount: rec.baseCount || 0, marking: rec.marking || 'NORMAL',
      authentic: rec.authentic !== false,
      curve: rec.curve || (loc ? (loc.pos + (loc.pct != null ? ' ' + loc.pct + '%' : '')) : ''),
      trend: rec.trend || '',
      htfTrend: rec.htfTrend || (engineAn ? (((engineAn.t15 && engineAn.t15.trend) || '') + '/' + ((engineAn.t30 && engineAn.t30.trend) || '')) : ''),
      sma50: rec.sma50 || 0, regime: rec.regime || (engineAn && engineAn.regime) || '',
      atr: rec.atr || 0, pnl: rec.pnl || 0,
      post: rec.post || '', zoneInv: !!rec.zoneInv,
      entryTs: rec.entryTs || 0, exitTs: rec.exitTs || 0
    };
  }

  // resolved trades ka summary (offline replay ke liye)
  function met(list) {
    let wins = 0, losses = 0, profit = 0, consec = 0, maxC = 0;
    for (const r of list) {
      if (r.kind === 'TARGET') { wins++; consec = 0; }
      else if (r.kind === 'SL') { losses++; consec++; if (consec > maxC) maxC = consec; }
      profit += r.pnl || 0;
    }
    const n = wins + losses;
    return { n, wins, losses, winRate: n ? Math.round(100 * wins / n) : 0, profit: Math.round(profit * 10) / 10, maxConsec: maxC };
  }

  // kya ye historical trade is rule se block hota?
  function wouldBlock(r, k, v) {
    if (k === 'trendAlign' && v === true) return (r.dir === 'BUY' && r.trend === 'down') || (r.dir === 'SELL' && r.trend === 'up');
    if (k === 'freshOnly' && v === true) return r.fresh === 'tested';
    if (k === 'minScore' && typeof v === 'number') return r.score != null && r.score < v;
    if (k === 'maxZoneWidthAtr' && typeof v === 'number') return !!(r.zone && r.atr > 0 && Math.abs(r.zone.entry - r.zone.sl) / r.atr > v);
    return false;
  }

  // requirement #12: historical replay se validate — PASS sirf tab jab
  // ≥1 SL block ho, trades ka ≥40%+ bacha rahe, aur winRate/profit improve ho.
  function validateRule(k, v) {
    const trades = st.results.filter(r => r.kind === 'SL' || r.kind === 'TARGET');
    const old = met(trades);
    if (trades.length < 5) {
      return { status: 'INSUFFICIENT', old, neu: null, blocked: 0, filteredSL: 0,
        why: 'trades kam (' + trades.length + '/5) — historical validation ke liye data insufficient, suggestion ke roop me rahega' };
    }
    const bl = trades.filter(r => wouldBlock(r, k, v));
    const keep = trades.filter(r => !wouldBlock(r, k, v));
    const neu = met(keep);
    const fSL = bl.filter(r => r.kind === 'SL').length;
    if (!bl.length) return { status: 'NO_EFFECT', old, neu: old, blocked: 0, filteredSL: 0, why: 'isi rule se koi historical trade block nahi hota' };
    if (keep.length < Math.max(2, Math.floor(trades.length * 0.4))) {
      return { status: 'REJECTED', old, neu, blocked: bl.length, filteredSL: fSL,
        why: 'rule bahut strict — ' + keep.length + '/' + trades.length + ' trades hi bachte (<40%)' };
    }
    const pass = fSL >= 1 && neu.winRate >= old.winRate && neu.profit >= old.profit;
    return {
      status: pass ? 'PASS' : 'FAIL', old, neu, blocked: bl.length, filteredSL: fSL,
      filteredWins: bl.filter(r => r.kind === 'TARGET').length,
      why: pass
        ? fSL + ' SL block, ' + bl.length + ' trades filter (win ' + old.winRate + '%→' + neu.winRate + '%, profit ' + old.profit + '→' + neu.profit + ')'
        : 'winRate/profit improve nahi (win ' + old.winRate + '%→' + neu.winRate + '%, profit ' + old.profit + '→' + neu.profit + (fSL < 1 ? ', koi SL block nahi hua' : '') + ')'
    };
  }

  // requirement #11: root cause (A-P) → deterministic param rule
  const CAUSE_MAP = {
    A: { name: 'Zone galat (wrong zone marking)', fix: 'minScore' },
    B: { name: 'Weak zone (kam score)', fix: 'minScore' },
    C: { name: 'Previously tested zone', fix: 'freshOnly' },
    D: { name: 'Non-authentic zone', fix: 'minScore' },
    E: { name: 'Entry galat (wrong entry)', fix: 'minScore' },
    F: { name: 'Trend galat (counter-trend trade)', fix: 'trendAlign' },
    G: { name: 'HTF location galat', fix: 'minScore' },
    H: { name: 'ITF trend opposite tha', fix: 'trendAlign' },
    I: { name: 'LTF confirmation kamzor', fix: 'minScore' },
    J: { name: 'Curve location galat (high/low par trade)', fix: 'minScore' },
    K: { name: 'Market structure change (BOS/ChoC)', fix: 'trendAlign' },
    L: { name: 'Liquidity sweep', fix: 'slBufAtr' },
    M: { name: 'False breakout', fix: 'slBufAtr' },
    N: { name: 'Zone invalidate (zone toot gaya)', fix: 'minScore' },
    O: { name: 'SL placement galat (too tight)', fix: 'slBufAtr' },
    P: { name: 'Volatility abnormal', fix: 'slBufAtr' }
  };
  function mapCauseToRule(code) {
    const m = CAUSE_MAP[code];
    if (!m) return { k: null, v: null, why: 'root cause code match nahi hua — methodology review zaroori' };
    const p = st.params;
    if (m.fix === 'freshOnly') return p.freshOnly ? { k: null, v: null, why: 'freshOnly pehle se ON hai' } : { k: 'freshOnly', v: true, why: 'Root cause: ' + m.name + ' → sirf FRESH zone (tested zones skip, PDF rule)' };
    if (m.fix === 'trendAlign') return p.trendAlign ? { k: null, v: null, why: 'trendAlign pehle se ON hai' } : { k: 'trendAlign', v: true, why: 'Root cause: ' + m.name + ' → trend alignment requirement ON' };
    if (m.fix === 'minScore') return p.minScore >= LIMITS.minScore[1] ? { k: null, v: null, why: 'minScore cap (7) par hai — aur strict nahi hoga' } : { k: 'minScore', v: p.minScore + 1, why: 'Root cause: ' + m.name + ' → zone/entry quality filter strict (minScore ' + (p.minScore + 1) + ')' };
    if (m.fix === 'slBufAtr') return p.slBufAtr >= LIMITS.slBufAtr[1] ? { k: null, v: null, why: 'SL buffer SYSTEM RULE me locked hai (0.10 × ATR) — sweep/volatility ka fix minScore/trendAlign filter se karo' } : { k: 'slBufAtr', v: +(p.slBufAtr + 0.05).toFixed(3), why: 'Root cause: ' + m.name + ' → SL ko room (ATR buffer) — ATR kabhi auto-change NAHI, sirf approval se' };
    return { k: null, v: null, why: '' };
  }

  // sirf ye keys offline replay se validate ho sakti hain; ATR-family = manual
  const VALIDATABLE = { trendAlign: 1, freshOnly: 1, minScore: 1, maxZoneWidthAtr: 1 };

  // suggestion → (agar validatable) validate → PASS = AUTO-ACTIVATE + version, warna pending suggestion
  function proposeRule(k, v, cause, evidence) {
    const nv = typeof v === 'number' ? clamp(k, Math.round(v * 1000) / 1000) : v;
    const alreadyPending = !!(st.suggest && st.suggest.k === k && st.suggest.v === nv);
    const made = suggest(k, v, cause);
    if (!made && !alreadyPending) return { action: 'NONE', validation: null };   // apply ho chuka / invalid key
    if (!VALIDATABLE[k]) {
      st.validation = { ts: Date.now(), key: k, status: 'MANUAL_ONLY', why: 'offline replay possible nahi (ATR/geometry rule) — approval chahiye', cause: String(cause || '').slice(0, 120) };
      log('VALIDATE', k + ': MANUAL_ONLY — suggestion pending (user "apply karo" bolega tab apply)');
      save();
      return { action: 'SUGGEST', validation: st.validation };
    }
    const val = validateRule(k, nv);
    st.validation = { ts: Date.now(), key: k, status: val.status, why: val.why || '', cause: String(cause || '').slice(0, 120),
      old: val.old, neu: val.neu, blocked: val.blocked, filteredSL: val.filteredSL, evidence: evidence || null };
    log('VALIDATE', k + ': ' + val.status + ' — ' + (val.why || ''));
    if (val.status === 'PASS') {
      const ok = activateRule(k, nv, st.validation, cause);
      return { action: ok ? 'ACTIVATED' : 'SUGGEST', validation: st.validation };
    }
    save();
    return { action: 'SUGGEST', validation: st.validation };
  }

  function bumpVer(v) {
    const m = /^v(\d+)\.(\d+)$/.exec(String(v || 'v1.0'));
    if (!m) return 'v1.1';
    let maj = +m[1], min = +m[2] + 1;
    if (min > 9) { maj++; min = 0; }
    return 'v' + maj + '.' + min;
  }

  // requirement #14: validation PASS → rule apply + Strategy Version save (rollback ke liye)
  function activateRule(k, v, val, cause) {
    // SPEC (hard): AI ko SIRF ATR badha kar problem solve karne ki permission NAHI —
    // ATR-family (slBufAtr/entryBufAtr) kabhi auto-activate nahi hoti, sirf user approval se.
    if (k === 'slBufAtr' || k === 'entryBufAtr') {
      log('ATR-BLOCK', k + ' auto-activate MANA (spec) — ATR rule sirf user approval se, kabhi AI se auto nahi');
      return false;
    }
    const oldV = st.params[k];
    st.suggest = null;
    if (!tune(k, v, 'validated', 'VALIDATION PASS → auto-activate: ' + String(cause || '').slice(0, 140))) return false;
    const nv = st.params[k];
    const prev = st.versions.filter(x => x.status === 'active' || x.status === 'confirmed').pop();
    if (prev) prev.status = 'superseded';
    st.version = bumpVer(st.version);
    st.versions.push({
      v: st.version, ts: Date.now(), key: k, oldVal: oldV, newVal: nv,
      reason: 'root-cause auto-fix (validation PASS)', rootCause: String(cause || '').slice(0, 140),
      validation: { status: val.status, why: val.why, old: val.old, neu: val.neu, blocked: val.blocked, filteredSL: val.filteredSL },
      status: 'active'
    });
    if (st.versions.length > 30) st.versions.shift();
    log('VERSION', st.version + ' activate: ' + k + ' ' + oldV + ' → ' + nv +
      ' · root cause: ' + String(cause || '').slice(0, 80) +
      ' · validation PASS (old win ' + (val.old ? val.old.winRate + '%' : '?') + ' → new ' + (val.neu ? val.neu.winRate + '%' : '?') + ', ' + (val.filteredSL || 0) + ' SL filtered)');
    save();
    return true;
  }

  // requirement #15 + SPEC: activation ke baad PAPER-TRADING VALIDATION (auto-bot = paper engine):
  //   • better  → version CONFIRMED (result save)
  //   • worse   → AUTO-ROLLBACK purane rule par (result save)
  // Har version me: oldVal/newVal/reason/rootCause + validation (backtest) + result (paper) save.
  function rollbackCheck() {
    const act = [...st.versions].reverse().find(x => x.status === 'active');
    if (!act) return;
    const post = st.results.filter(r => r.exitTs > act.ts && (r.kind === 'SL' || r.kind === 'TARGET'));
    if (post.length < 5) return;
    const m = met(post);
    const base = act.validation && act.validation.old;      // backtest baseline: purana rule
    const exp = act.validation && act.validation.neu;       // backtest expectation: naya rule
    const result = {
      n: post.length, winRate: m.winRate, profit: m.profit, maxConsec: m.maxConsec,
      vsBase: base && base.winRate != null ? m.winRate - base.winRate : null, at: Date.now()
    };
    const worseThanBase = !!(base && base.winRate != null && post.length >= 8 && (base.winRate - m.winRate) >= 15);
    const bad = m.winRate < 40 || (m.maxConsec >= 3 && m.winRate < 60) || worseThanBase;
    if (bad) {
      st.suggest = null;
      tune(act.key, act.oldVal, 'rollback', 'AUTO-ROLLBACK ' + act.v + ': paper-validation me ' + post.length + ' trades me win ' + m.winRate + '% (<40 ya baseline se kharab) — purana rule wapas');
      act.status = 'rolledback';
      act.result = Object.assign({}, result, { verdict: 'ROLLBACK (worse)' });
      st.version = bumpVer(st.version);
      st.versions.push({
        v: st.version, ts: Date.now(), key: act.key, oldVal: act.newVal, newVal: act.oldVal,
        reason: 'auto-rollback: paper-trading validation WORSE (win ' + m.winRate + '%, ' + post.length + ' trades)', rootCause: act.rootCause,
        validation: act.validation, result: act.result, status: 'active', rollbackOf: act.v
      });
      if (st.versions.length > 30) st.versions.shift();
      log('ROLLBACK', act.v + ' → ' + st.version + ': ' + act.key + ' wapas ' + act.oldVal +
        ' (paper-validation: win ' + m.winRate + '%, consecSL ' + m.maxConsec + ', result save)');
      save();
      return;
    }
    // BETTER → confirm (paper-validation PASS), result save; mediocre → aur trades ka wait
    const good = m.winRate >= 50 || (exp && exp.winRate != null && m.winRate >= exp.winRate - 10) || !!(base && base.winRate != null && m.winRate > base.winRate);
    if (good || post.length >= 12) {
      act.status = good ? 'confirmed' : 'rolledback';
      if (good) {
        act.result = Object.assign({}, result, { verdict: 'CONFIRMED (better)' });
        log('PAPER-VALID', act.v + ' ' + act.key + ': CONFIRMED — paper trades ' + post.length + ', win ' + m.winRate +
          '%' + (base ? ' vs base ' + base.winRate + '%' : '') + ', profit ' + m.profit + ' (result save)');
      } else {
        // 12 trades ke baad bhi baseline se better nahi → rollback (spec: kharab ho to purana rule)
        st.suggest = null;
        tune(act.key, act.oldVal, 'rollback', 'AUTO-ROLLBACK ' + act.v + ': 12+ paper trades me baseline se better nahi (win ' + m.winRate + '%) — purana rule wapas');
        act.status = 'rolledback';
        act.result = Object.assign({}, result, { verdict: 'ROLLBACK (not better after 12)' });
        st.version = bumpVer(st.version);
        st.versions.push({
          v: st.version, ts: Date.now(), key: act.key, oldVal: act.newVal, newVal: act.oldVal,
          reason: 'auto-rollback: paper-validation me baseline se better nahi (win ' + m.winRate + '% vs base ' + (base ? base.winRate + '%' : '?') + ')', rootCause: act.rootCause,
          validation: act.validation, result: act.result, status: 'active', rollbackOf: act.v
        });
        if (st.versions.length > 30) st.versions.shift();
        log('ROLLBACK', act.v + ' → ' + st.version + ': ' + act.key + ' wapas ' + act.oldVal + ' (paper ' + post.length + ' trades, win ' + m.winRate + '% — better nahi)');
      }
      save();
    }
  }

  function topRootCause() {
    const ks = Object.keys(st.rootCauseStats || {}).sort((a, b) => st.rootCauseStats[b] - st.rootCauseStats[a]);
    if (!ks.length) return 'abhi root-cause data nahi';
    const nm = CAUSE_MAP[ks[0]] ? CAUSE_MAP[ks[0]].name : ks[0];
    return nm + ' (' + st.rootCauseStats[ks[0]] + ' baar)';
  }
  function investigationLine() {
    const bits = [];
    bits.push('top cause: ' + topRootCause());
    if (st.learn && st.learn.byZone) {
      if (st.learn.byZone.tested && st.learn.byZone.tested.l >= 1) bits.push('tested zones me loss zyada — freshOnly check');
      if (st.learn.byZone.fresh && st.learn.byZone.fresh.l >= 1) bits.push('fresh zones bhi fail — regime/location check');
    }
    if (engineAn && engineAn.regime) bits.push('regime ' + engineAn.regime);
    if (st.snap && st.snap.condition && st.snap.condition !== 'Unknown') bits.push('condition ' + st.snap.condition);
    if (st.snap && st.snap.trends && st.snap.trends['5m']) bits.push('5m trend ' + st.snap.trends['5m']);
    bits.push('entry rules/zone strength review');
    return bits.join(' · ');
  }

  // requirement #16: 2 lagatar SL = investigate log, 3+ = CAUTION MODE (auto-bot 10min pause)
  function cautionFlow() {
    const c = st.stats.consecSL;
    if (c >= 3 && !(st.caution && st.caution.on)) {
      st.caution = { on: true, since: Date.now(), consec: c, reason: c + ' lagatar SL', investigate: investigationLine() };
      log('CAUTION', 'CAUTION MODE ON — ' + c + ' lagatar SL. ' + st.caution.investigate);
      save();
    } else if (st.caution && st.caution.on && c === 0) {
      st.caution = null;
      log('CAUTION', 'Caution mode OFF — streak toota (target mila)');
      save();
    } else if (st.caution && st.caution.on) {
      st.caution.consec = c;
      st.caution.reason = c + ' lagatar SL';
    }
    if (c >= 2 && (!st.caution || !st.caution.on) && st.cautionInvMark !== st.stats.sls) {
      st.cautionInvMark = st.stats.sls;
      log('INVESTIGATE', c + ' lagatar SL — ' + investigationLine());
      save();
    }
  }

  // journal/SL-event rec → poora diagnosis rec: same trade ka st.results rec mila to
  // WO (usme PDF facts: pattern/score/fresh/curve/HTF saved hain), warna journal se build
  function diagRecFor(jrec) {
    if (!jrec) return null;
    if (Array.isArray(st.results)) {
      const m = st.results.filter(r => r.kind === 'SL' && (!jrec.tf || r.tf === jrec.tf) &&
        (!jrec.entry || Math.abs(((r.zone && r.zone.entry) || r.entry || 0) - jrec.entry) < 30) &&
        (!jrec.ts || Math.abs((r.exitTs || r.ts || 0) - jrec.ts) < 300000)).pop();
      if (m) return m;
    }
    const out = { kind: 'SL', tf: jrec.tf || '', dir: jrec.dir || '', ts: jrec.ts || Date.now(), exitTs: jrec.ts || Date.now() };
    if (jrec.entry != null) out.zone = { entry: jrec.entry, sl: jrec.sl, tgt: jrec.tgt };
    if (jrec.price != null) { out.slHit = jrec.price; out.spotAtEntry = jrec.price; }
    if (jrec.pattern) out.pattern = jrec.pattern;
    if (jrec.score != null) out.score = jrec.score;
    if (jrec.fresh) out.fresh = jrec.fresh;
    return out;
  }

  // ── MARKET DATA = SOURCE OF TRUTH (requirement #8): candles se hi trend,
  //    structure (HH/HL/LH/LL, BOS), ATR volatility, market condition ──
  async function marketSnapshot() {
    if (st.snap && Date.now() - st.snap.ts < 90000) return st.snap;
    const snap = { ts: Date.now(), dataOk: false, trends: {}, structure: {}, atrVol: {}, condition: 'Unknown', structureSummary: '' };
    let okN = 0;
    for (const tf of [1, 3, 5, 15, 30]) {
      let c = null;
      try { c = await fetchCandles(symbol, tf, 400); } catch (e) {}
      if (!c || c.length < 30) continue;
      okN++;
      const key = tf + 'm';
      const closes = c.map(x => x.close), highs = c.map(x => x.high), lows = c.map(x => x.low);
      // trend: SMA20 ka slope (last20 vs previous20)
      const sma20 = avg(closes.slice(-20)), smaPrev = avg(closes.slice(-40, -20));
      snap.trends[key] = sma20 > smaPrev + 1 ? 'up' : sma20 < smaPrev - 1 ? 'down' : 'sideways';
      // swings → HH/LH + HL/LL, aur close se BOS
      const pivHi = [], pivLo = [];
      for (let i = 3; i < highs.length - 3; i++) {
        if (highs[i] > highs[i - 1] && highs[i] > highs[i - 2] && highs[i] > highs[i + 1] && highs[i] > highs[i + 2]) pivHi.push(highs[i]);
        if (lows[i] < lows[i - 1] && lows[i] < lows[i - 2] && lows[i] < lows[i + 1] && lows[i] < lows[i + 2]) pivLo.push(lows[i]);
      }
      const h2 = pivHi.slice(-2), l2 = pivLo.slice(-2);
      const last = closes[closes.length - 1];
      const parts = [], bos = [];
      if (h2.length === 2) parts.push(h2[1] > h2[0] ? 'HH' : 'LH');
      if (l2.length === 2) parts.push(l2[1] > l2[0] ? 'HL' : 'LL');
      if (h2.length === 2 && last > h2[1]) bos.push('BOS-up');
      if (l2.length === 2 && last < l2[1]) bos.push('BOS-down');
      snap.structure[key] = (parts.join('/') || '—') + (bos.length ? ' · ' + bos.join('+') : '');
      // ATR (14) vs base (40) → volatility ratio
      const trs = [];
      for (let i = Math.max(1, c.length - 40); i < c.length; i++) {
        trs.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close)));
      }
      const atrBase = avg(trs), atr14 = avg(trs.slice(-14));
      snap.atrVol[key] = atrBase > 0 ? Math.round((atr14 / atrBase) * 100) / 100 : 1;
    }
    if (okN) snap.dataOk = true;
    const t5 = snap.trends['5m'] || '', t15 = snap.trends['15m'] || '';
    const volR = Math.max(snap.atrVol['5m'] || 1, snap.atrVol['3m'] || 1);
    if (!snap.dataOk) snap.condition = 'Unknown';
    else if (volR >= 1.6) snap.condition = 'Volatile';
    else if (t5 && t5 === t15 && t5 !== 'sideways') snap.condition = 'Trend';
    else if (/BOS/.test(snap.structure['5m'] || '') && t5 && t15 && t5 !== t15) snap.condition = 'Reversal';
    else snap.condition = 'Range';
    snap.structureSummary = (t5 ? '5m ' + t5 + ' (' + (snap.structure['5m'] || '') + ')' : '5m —') +
      (t15 ? ' · 15m ' + t15 + ' (' + (snap.structure['15m'] || '') + ')' : '') +
      ' · condition ' + snap.condition +
      (snap.atrVol['5m'] ? ' · ATR vol ×' + snap.atrVol['5m'] : '');
    st.snap = snap;
    save();
    return snap;
  }

  // ── GEMINI ROOT-CAUSE ANALYSIS: PDF methodology (demand/supply, curve, 50 SMA,
  //    HTF/ITF/LTF, trade score, entry type) se ASLI root cause (A-P) + post-SL
  //    evidence. Facts deterministic (meta se) — LLM sirf judgement deta hai.
  //    Rule fix → validate → PASS par AUTO-ACTIVATE (ATR sirf approval) — #10-#14 ──
  async function aiDiagnose(rec) {
    if (!GEMINI_KEY) return null;
    if (aiBusy || Date.now() - aiLast < 60000) { pendingDiag = rec || pendingDiag; return null; }   // queue: review() baad me chalayega
    if (pendingDiag === rec) pendingDiag = null;
    aiBusy = true; aiLast = Date.now();
    try {
      const ctx = await buildDiagContext(rec);
      const facts = tradeFacts(rec);
      const sys = 'Tum "DS Zone Engine" ke ROOT-CAUSE ANALYST ho. Ek auto-trade diya gaya hai jisme SL laga. ' +
        'Tumhara kaam ROOT CAUSE identify karna hai — sirf diye gaye LIVE DATA se. PRIMARY RULESET = neeche PDF strategy knowledge ' +
        '(demand-supply, exciting/base candle, leg-in/base/leg-out, DBR/RBR, proximal/distal, zone strength, fresh/tested, ' +
        'authentic, 50 SMA trend, HTF=location / ITF=trend / LTF=execution, curve/location, trade score, entry type, credibility).\n' +
        'DATA.facts me diye GAYE zone/pattern/score/entry-type/curve/HTF facts RECORD hue hain — unhe invent ya badal mat karo. ' +
        'Agar koi required data missing ho to dataOk:false likho aur explanation me shuru karo: ' +
        '"Insufficient market data for reliable root-cause analysis."\n' +
        'Jawab Hinglish me. Sirf JSON — koi aur text nahi.\n' +
        'JSON schema:\n' +
        '{"causeCode":"<A-P>", "primaryRootCause":"<root cause naam + 1 line>", "secondaryCause":"<agar ho>",' +
        '"marketCondition":"<Trend|Range|Reversal|Volatile>", "zoneAnalysis":"<Strong|Weak|Tested|Invalid>",' +
        '"entryAnalysis":"<Valid|Early|Late|Wrong>", "slAnalysis":"<Correct|Too Tight|Wrong Location>",' +
        '"htfLocation":"<price HTF me kahan hai — data se>", "itfTrend":"<50SMA based trend>", ' +
        '"ltfExecution":"<Valid|Weak|Missing>", "curve":"<Very High|High|Equilibrium|Low|Very Low>",' +
        '"slPlacement":"<Correct|Incorrect>", "atr":"<Relevant|Not Relevant>", "confidence":70,' +
        '"postSl":"<SL ke baad price kya gaya — sweep/continue/reverse/zone invalid, DATA se>",' +
        '"improvement":"<kya sudhaar — evidence based, 1 line>", "explanation":"<detailed Hinglish — kya galti hui>",' +
        '"newsJudgement":"<TECHNICAL|NEWS_DRIVEN|MIXED|NO_DATA>", "dataOk":true}\n' +
        'NEWS RULE: DATA.newsAtSl me SL ke ±30 min ki actual news items hain. Unhe dekh kar decide karo: clearly major negative/positive event ' +
        'jo price move se match karta ho to NEWS_DRIVEN (us case me causeCode strategy ka rakhna par explanation me likho "news-driven — ye strategy error nahi"), ' +
        'bilkul relevant news na ho to TECHNICAL, dono ho to MIXED, news list khali ho to NO_DATA. Guess mat karo.\n' +
        'ROOT CAUSE CODES: A zone galat (wrong marking), B weak zone (kam score), C previously tested zone, ' +
        'D non-authentic zone, E entry galat, F trend galat (counter-trend), G HTF location galat, ' +
        'H ITF trend opposite, I LTF confirmation kamzor, J curve location galat, K market structure change, ' +
        'L liquidity sweep, M false breakout, N zone invalidate, O SL placement galat (tight), P volatility abnormal.\n' +
        'ATR RULE (HARD): atr="Relevant" SIRF L/M/O/P (sweep / false-breakout / SL-placement / volatility) par. ' +
        'Baaki kisi bhi cause me "Not Relevant" likho — ATR kabhi default solution nahi. Confidence 30-95 ' +
        '(data kam ho to kam rakho, guess mat karo).\n\n' +
        'PDF STRATEGY KNOWLEDGE (primary ruleset):\n' + String(knowAll || '').slice(0, 9000);
      const txt = await askGemini(sys + '\n\nDATA:\n' + JSON.stringify(ctx), { json: true, temp: 0.15, maxTokens: 1000 });
      if (!txt) return null;
      let d = null;
      try { d = JSON.parse(txt.replace(/```json|```/g, '').trim()); } catch (e) { return null; }
      if (!d || typeof d !== 'object') return null;
      st.llmCalls++;

      // ── deterministic FACTS (recorded meta / engine se) — ye sach hai, LLM judgment nahi ──
      const causeCode = String(d.causeCode || '').toUpperCase().replace(/[^A-P]/g, '').slice(0, 1);
      const cm = CAUSE_MAP[causeCode] || null;
      const rep = {
        ts: Date.now(), tf: rec.tf || facts.tf || '', dir: rec.dir || facts.dir || '',
        entry: facts.entry, sl: facts.sl, slHit: facts.slHit,
        // PDF facts — deterministic
        zoneType: facts.zoneType, pattern: facts.pattern, zoneStrength: facts.zoneStrength,
        fresh: facts.fresh, tradeScore: facts.score, entryType: facts.entryType, entryRule: facts.entryRule,
        baseCount: facts.baseCount, marking: facts.marking, authentic: facts.authentic,
        curve: facts.curve, sma50: facts.sma50,
        // judgements (LLM)
        causeCode: causeCode || '?',
        primaryRootCause: String(d.primaryRootCause || '').slice(0, 240),
        secondaryCause: String(d.secondaryCause || '').slice(0, 160),
        marketCondition: String(d.marketCondition || '').slice(0, 40),
        htfLocation: String(d.htfLocation || facts.htfTrend || '').slice(0, 80),
        itfTrend: String(d.itfTrend || facts.trend || '').slice(0, 60),
        ltfExecution: String(d.ltfExecution || '').slice(0, 60),
        slPlacement: String(d.slPlacement || '').slice(0, 30),
        confidence: Math.max(0, Math.min(95, parseInt(d.confidence, 10) || 0)),
        postSl: String(d.postSl || facts.post || '').slice(0, 300),
        explanation: String(d.explanation || '').slice(0, 500),
        // requirement #10 (news): SL-time news se technical vs news-driven judgement (save hota hai)
        newsJudgement: (function () {
          const j = String(d.newsJudgement || '').toUpperCase();
          if (j === 'TECHNICAL' || j === 'NEWS_DRIVEN' || j === 'MIXED') return j;
          return (rec.newsCtx && rec.newsCtx.length) ? 'MIXED' : 'NO_DATA';
        })(),
        newsAtSl: (rec.newsCtx || []).slice(0, 5),
        dataOk: d.dataOk !== false
      };
      if (!rep.dataOk) rep.explanation = 'Insufficient market data for reliable root-cause analysis.' + (rep.explanation ? ' ' + rep.explanation : '');
      if (!cm && !causeCode) rep.explanation = (rep.explanation || '') + ' (root cause code map nahi hua — methodology review)';

      // ATR gate: atr Relevant sirf L/M/O/P par (schema instruction + code verify)
      const atrRelevant = /^(L|M|O|P)$/.test(causeCode) && /relevant/i.test(String(d.atr || '')) && !/not\s*relevant/i.test(String(d.atr || ''));

      // ── requirement #11: root cause → mapped rule → validate → AUTO-ACTIVATION ──
      // SPEC: rule modify SIRF tab jab root cause पर्याप्त evidence se confirm ho
      // (dataOk + confidence ≥60) — warna suggestion/report (approval chahiye).
      const mp = mapCauseToRule(causeCode);
      let action = 'NOTE', fixInfo = null, validation = null;
      const enoughEvidence = rep.dataOk && rep.confidence >= 60;
      if (mp.k && !enoughEvidence) {
        fixInfo = { k: mp.k, v: mp.v, why: mp.why };
        action = 'SUGGEST';
        suggest(mp.k, mp.v, mp.why + ' (evidence kam: confidence ' + rep.confidence + '<60 — auto-modify nahi)');
        validation = { ts: Date.now(), key: mp.k, status: 'EVIDENCE_LOW', why: 'confidence ' + rep.confidence + ' < 60 (पर्याप्त evidence nahi) — sirf suggestion, approval chahiye' };
        st.validation = validation;
        log('VALIDATE', mp.k + ': EVIDENCE_LOW (conf ' + rep.confidence + ') — auto-modify skip, suggestion only');
      } else if (mp.k) {
        const res = proposeRule(mp.k, mp.v, (cm ? cm.name : '') + (rep.primaryRootCause ? ' — ' + rep.primaryRootCause : ''), { source: 'root-cause ' + causeCode, post: facts.post, confidence: rep.confidence });
        action = res.action;
        validation = res.validation;
        if (action === 'ACTIVATED') fixInfo = { k: mp.k, v: st.params[mp.k], why: mp.why };
        else fixInfo = { k: mp.k, v: (st.suggest && st.suggest.v != null ? st.suggest.v : mp.v), why: mp.why };
      } else {
        fixInfo = null;
      }
      const fixNote = mp && !mp.k ? mp.why : (fixInfo ? '' : 'is root cause ke liye direct param rule nahi — methodology review zaroori');

      // legacy-compatible fields (purana panel/chat chalta rahe)
      const CATEGORY_BY_CODE = { A: 'ZONE', B: 'ZONE', C: 'ZONE', D: 'ZONE', N: 'ZONE', E: 'ENTRY', I: 'ENTRY', F: 'TREND', H: 'TREND', K: 'TREND', G: 'LOCATION', J: 'LOCATION', L: 'STOP_LOSS', M: 'STOP_LOSS', O: 'STOP_LOSS', P: 'MARKET CONDITION' };
      rep.category = CATEGORY_BY_CODE[causeCode] || String(d.category || '').slice(0, 40);
      rep.primaryReason = (cm ? cm.name : '') + (rep.primaryRootCause ? ': ' + rep.primaryRootCause : '');
      rep.zoneAnalysis = String(d.zoneAnalysis || (cm && /ZONE/.test(rep.category) ? cm.name : '') || '').slice(0, 40);
      rep.entryAnalysis = String(d.entryAnalysis || '').slice(0, 40);
      rep.slAnalysis = String(d.slAnalysis || rep.slPlacement || '').slice(0, 40);   // (rep object ka field — st.slAnalysis array se alag)
      rep.atrAnalysis = atrRelevant ? 'Relevant' : 'Not Relevant';
      rep.mistake = rep.explanation;
      rep.improvement = String(d.improvement || fixNote || (fixInfo ? fixInfo.why : '') || '').slice(0, 300);
      rep.afterSl = rep.postSl;
      rep.atrChange = {
        yes: !!(fixInfo && fixInfo.k === 'slBufAtr' && action === 'SUGGEST'),
        old: st.params.slBufAtr,
        new: (fixInfo && fixInfo.k === 'slBufAtr') ? st.params.slBufAtr : st.params.slBufAtr,
        why: atrRelevant ? (cm ? cm.name : causeCode) + ' (whipsaw/sweep/SL-placement/volatility) — approval par SL buffer' : 'reason ATR me nahi — ATR default solution nahi'
      };
      rep.fix = fixInfo;                 // {k, v, why} ya null
      rep.fixNote = fixNote;
      rep.validation = validation;       // {status, why, old, neu, blocked, filteredSL} ya null
      rep.action = action;               // ACTIVATED | SUGGEST | NOTE | NONE
      rep.version = st.version;

      st.slAnalysis.push(rep);
      if (st.slAnalysis.length > 10) st.slAnalysis.shift();
      st.rootCauses.push({
        ts: rep.ts, tf: rep.tf, dir: rep.dir, causeCode: rep.causeCode,
        name: rep.primaryRootCause || (cm ? cm.name : ''), secondary: rep.secondaryCause,
        postSl: rep.postSl, confidence: rep.confidence, action: rep.action,
        fix: fixInfo, version: rep.version, dataOk: rep.dataOk,
        newsJudgement: rep.newsJudgement
      });
      if (st.rootCauses.length > 50) st.rootCauses.shift();
      if (causeCode) st.rootCauseStats[causeCode] = (st.rootCauseStats[causeCode] || 0) + 1;

      st.aiDiag = {
        ts: rep.ts, tf: rep.tf, reason: (causeCode || '?') + ' ' + (rep.primaryRootCause || rep.primaryReason),
        fix: action === 'ACTIVATED' && fixInfo ? [fixInfo.k + '=' + fixInfo.v] : [],
        note: rep.improvement || rep.explanation, report: rep
      };
      // SL event se report link karo (journal/slEvents me dikhe)
      const ev = st.slEvents.slice(-3).reverse().find(e => !e.analysis && (!rep.tf || e.tf === rep.tf));
      if (ev) { ev.analysis = rep.primaryReason; ev.post = ev.post || rep.postSl || null; }
      log('ROOT-CAUSE', (causeCode || '?') + ' ' + String(rep.primaryRootCause || rep.primaryReason).slice(0, 90) +
        ' · ATR ' + (atrRelevant ? 'Relevant' : 'Not Relevant') +
        ' · fix: ' + (fixInfo ? fixInfo.k + '=' + fixInfo.v : (fixNote || 'note')) +
        ' · validation: ' + (validation ? validation.status : '—') +
        ' · ' + action + ' · ' + rep.version +
        (rep.dataOk === false ? ' · DATA INSUFFICIENT' : ''));
      save();
      return rep;
    } catch (e) {
      try { log('ERR', 'aiDiagnose: ' + e.message); } catch (e2) {}
      return null;
    } finally { aiBusy = false; }
  }

  async function buildDiagContext(rec) {
    const cnd = {};
    for (const tfMin of [1, 3, 5, 15]) {
      let c = null;
      try { c = await fetchCandles(symbol, tfMin, 240); } catch (e) {}
      if (c && c.length) {
        cnd[tfMin + 'm'] = c.slice(-45).map(x => [Math.round(x.time / 60000), x.open, x.high, x.low, x.close, x.volume || 0]);
      }
    }
    let snap = null;
    try { snap = await marketSnapshot(); } catch (e) {}
    return {
      now: new Date().toISOString(),
      trade: rec,
      facts: tradeFacts(rec),                     // deterministic PDF facts (LLM invent NAHI karega)
      currentSettings: Object.assign({}, st.params),
      stats: { targets: st.stats.targets, sls: st.stats.sls, whipsaw: st.stats.whipsaw, consecSL: st.stats.consecSL, byDiag: st.stats.byDiag },
      learn: st.learn,
      recent: st.results.slice(-10).map(r => ({ ts: r.exitTs, tf: r.tf, dir: r.dir, kind: r.kind, score: r.score, fresh: r.fresh, trend: r.trend, regime: r.regime, entryType: r.entryType, post: r.post, pnl: r.pnl })),
      slEvents: st.slEvents.slice(-5),
      engine: engineAn ? {                          // live engine (trends + 50SMA + curve/location + regime)
        price: engineAn.price, regime: engineAn.regime,
        trend1: engineAn.t1 && engineAn.t1.trend, trend3: engineAn.t3 && engineAn.t3.trend,
        trend5: engineAn.t5 && engineAn.t5.trend, trend15: engineAn.t15 && engineAn.t15.trend, trend30: engineAn.t30 && engineAn.t30.trend,
        sma50_3: engineAn.t3 && engineAn.t3.smaVal, sma50_5: engineAn.t5 && engineAn.t5.smaVal, sma50_15: engineAn.t15 && engineAn.t15.smaVal,
        curve: engineAn.location || null
      } : null,
      strategy: { version: st.version, validation: st.validation || null, caution: st.caution || null, rootCauseStats: st.rootCauseStats },
      // requirement #10: SL-time news (deterministic save) + live market intelligence
      newsAtSl: (rec && rec.newsCtx) || (function () {
        try { return INTEL && rec ? INTEL.newsAroundSync(rec.exitTs || rec.slHitTs || 0, 30 * 60000) : []; } catch (e) { return []; }
      })(),
      intel: (function () { try { return INTEL ? { quick: INTEL.quick(), news: INTEL.newsList('market', 5).today } : null; } catch (e) { return null; } })(),
      market: snap
        ? { condition: snap.condition, trends: snap.trends, structure: snap.structure, atrVol: snap.atrVol, summary: snap.structureSummary, dataOk: snap.dataOk }
        : { dataOk: false, note: 'market snapshot nahi mila' },
      candles: cnd,
      candleFormat: '[minuteTs, open, high, low, close, volume]'
    };
  }

  // ── SL ke baad price target tak gaya ya nahi (whipsaw check) ──
  async function whipsawCheck() {
    const pend = st.results.filter(r => r.kind === 'SL' && !r.post && r.zone && r.zone.tgt > 0);
    if (!pend.length) return;
    let changed = false;
    for (const r of pend.slice(0, 6)) {
      const age = Date.now() - r.exitTs;
      if (age < 60000) continue;                       // exit ke 1 min baad hi check
      const tfMin = r.tf === '5m' ? 5 : 3;
      const mins = Math.min(300, Math.ceil(age / 60000) + 5);
      let c = null;
      try { c = await fetchCandles(symbol, tfMin, mins); } catch (e) {}
      if (c && c.length) {
        // SL exit ke 1 ghante ke andar target mila → SL tight tha (whipsaw)
        const after = c.filter(x => x.time >= r.exitTs && x.time <= r.exitTs + 60 * 60000);
        if (after.length) {
          const hi = Math.max.apply(null, after.map(x => x.high));
          const lo = Math.min.apply(null, after.map(x => x.low));
          const hit = r.dir === 'SELL' ? lo <= r.zone.tgt : hi >= r.zone.tgt;
          if (hit) {
            r.post = 'WHIPSAW';
            st.stats.whipsaw++;
            log('WHIP', r.tf + ' ' + r.dir + ' SL laga lekin 1 ghante me target tak pahuncha — SL tight tha');
          } else {
            // requirement #4: SL ke baad price kya gaya — sweep / continue / reverse / confirmed
            r.post = postSlClassify(r, after);
            if (r.post === 'SWEEP') log('POST', r.tf + ' ' + r.dir + ' SL sirf liquidity sweep tha — SL ke thik baad price wapas aayi (SL tight/galat location)');
            else if (r.post === 'CONTINUE') log('POST', r.tf + ' ' + r.dir + ' SL ke baad price usi direction me chala gaya — entry/zone hi galat tha');
            else if (r.post === 'REVERSE') log('POST', r.tf + ' ' + r.dir + ' SL ke baad turant reverse — entry sahi par SL tight tha');
            else log('POST', r.tf + ' ' + r.dir + ' SL ke baad price stable — ' + r.post);
            // zone invalid: SL ke baad price distal ke paar chala gaya → zone khatam
            const atr = r.atr || 0;
            if (atr > 0 && r.zone) {
              const sl = r.zone.sl, entry = r.zone.entry;
              const beyond = r.dir === 'SELL' ? (hi - sl) : (sl - lo);
              r.zoneInv = beyond > 1.5 * atr;
              if (r.zoneInv) log('POST', r.tf + ' zone INVALID — SL ke baad price ' + Math.round(beyond) + ' pts (' + (beyond / atr).toFixed(1) + ' ATR) distal ke paar');
            }
          }
          changed = true;
          continue;
        }
      }
      if (age > 2 * 3600 * 1000) { r.post = 'CONFIRMED'; changed = true; }  // data nahi mila
    }
    if (changed) { updLearn(); save(); }
  }

  // SL ke baad price action classification (requirement #4)
  function postSlClassify(r, after) {
    const atr = r.atr || 0;
    if (!atr) return 'CONFIRMED';
    const sl = r.zone.sl, entry = r.zone.entry;
    const isBuy = r.dir !== 'SELL';
    const hi = Math.max.apply(null, after.map(x => x.high));
    const lo = Math.min.apply(null, after.map(x => x.low));
    // SL ke baad price SL ke kitna gaya (direction me) + wapas kitna aaya (opposite me)
    const beyond = isBuy ? (sl - lo) : (hi - sl);          // SL ke paar (adverse) depth
    const back = isBuy ? (hi - sl) : (sl - lo);            // SL touch ke baad wapas (favorable) move
    if (beyond <= 0) return 'CONFIRMED';                    // SL hi nahi gaya (data odd)
    if (beyond <= 0.6 * atr && back >= 0.7 * atr) return 'SWEEP';      // sirf sweep → wapas aaya
    if (beyond >= 1.2 * atr && back < 0.5 * atr) return 'CONTINUE';    // SL ke baad bhi usi direction me gaya
    if (back >= 1.0 * atr) return 'REVERSE';                            // turant reverse (target na bhi chhua ho)
    return 'CONFIRMED';
  }

  // ── SL reasons ka diagnosis → SUGGESTION (auto-apply BAND, requirement #6).
  //    Sirf cooldown khud chalta hai (safety — capital protect, strategy change nahi) ──
  function diagnose() {
    const p = st.params;
    const win = st.results.slice(-15);
    const sls = win.filter(r => r.kind === 'SL');
    const tgts = win.filter(r => r.kind === 'TARGET');

    if (sls.length >= 3) {
      // 1) SL tight tha — whipsaw → ATR sirf yahan, cap par kabhi nahi
      const known = sls.filter(r => r.post === 'WHIPSAW' || r.post === 'CONFIRMED');
      const w = ratio(known, r => r.post === 'WHIPSAW');
      // diagnose → proposeRule: validatable rule = historical validate → PASS par auto-activate,
      // ATR-family = MANUAL_ONLY (suggestion, approval ke bina apply nahi)
      if (w.n >= 3 && w.r >= 0.5 && p.slBufAtr < LIMITS.slBufAtr[1]) {
        return proposeRule('slBufAtr', p.slBufAtr + 0.05, 'SL tight tha (' + w.hit + '/' + w.n + ' SL ke baad target mila) — SL buffer badhane ki suggestion', { source: 'stats', whipsaw: w });
      }
      // 2) against trend me SL
      const at = ratio(sls, r => (r.dir === 'BUY' && r.trend === 'down') || (r.dir === 'SELL' && r.trend === 'up'));
      if (at.n >= 3 && at.r >= 0.5 && !p.trendAlign) {
        return proposeRule('trendAlign', true, 'SL against trend (' + at.hit + '/' + at.n + ') — trend filter ON', { source: 'stats', againstTrend: at });
      }
      // 3) chop / sideways me SL
      const ch = ratio(sls, r => r.regime === 'sideways');
      if (ch.n >= 3 && ch.r >= 0.6 && p.maxAtrDist > 4) {
        return proposeRule('maxAtrDist', 4, 'Sideways/chop me SL (' + ch.hit + '/' + ch.n + ') — door ke zone band', { source: 'stats', chop: ch });
      }
      // 4) tested zone par SL
      const ts = ratio(sls, r => r.fresh === 'tested');
      if (ts.n >= 3 && ts.r >= 0.6 && !p.freshOnly) {
        return proposeRule('freshOnly', true, 'Tested zone par SL (' + ts.hit + '/' + ts.n + ') — sirf fresh zone', { source: 'stats', tested: ts });
      }
      // 5) kam-score zone par SL
      const slScores = sls.map(r => r.score).filter(x => x != null);
      const tgScores = tgts.map(r => r.score).filter(x => x != null);
      if (slScores.length >= 3 && p.minScore < LIMITS.minScore[1]) {
        const a1 = avg(slScores), a2 = tgScores.length >= 2 ? avg(tgScores) : null;
        if ((a2 != null && a1 + 1 <= a2) || (a2 == null && a1 <= 5)) {
          return proposeRule('minScore', p.minScore + 1, 'Weak zone me SL (SL avg score ' + Math.round(a1) + (a2 != null ? ', target avg ' + Math.round(a2) : '') + ') — min score badhane', { source: 'stats', scores: { sl: a1, tgt: a2 } });
        }
      }
      // 6) bade SL-distance (wide zone) me SL
      const wd = ratio(sls, r => r.zone && r.atr > 0 && Math.abs(r.zone.entry - r.zone.sl) / r.atr > 1);
      if (wd.n >= 3 && wd.r >= 0.6 && p.maxZoneWidthAtr > 1.2) {
        return proposeRule('maxZoneWidthAtr', p.maxZoneWidthAtr > 90 ? 2.5 : p.maxZoneWidthAtr - 0.7, 'Bade SL-distance zone me SL (' + wd.hit + '/' + wd.n + ') — wide zone band', { source: 'stats', wide: wd });
      }
      // 7) lagatar SL → cooldown (SAFETY — auto chalta hai, strategy change nahi)
      if (st.stats.consecSL >= 3 && st.cooldownUntil < Date.now()) {
        st.cooldownUntil = Date.now() + 10 * 60000;
        st.stats.byDiag.cooldown = (st.stats.byDiag.cooldown || 0) + 1;
        log('TUNE', 'Lagatar ' + st.stats.consecSL + ' SL — 10 min entry pause (cooldown)');
        return;
      }
    }

    // 8) accha chal raha hai → relax ki SUGGESTION (khud nahi lagta)
    const last6 = st.results.slice(-6);
    if (last6.length >= 6 && st.stats.consecSL === 0) {
      const t6 = last6.filter(r => r.kind === 'TARGET').length;
      if (t6 >= 4) return relax(t6);
    }
  }

  function relax(t6) {
    const p = st.params;
    const cands = [];
    // freshOnly/trend ke saath SL-buffer/target = SYSTEM RULES — relax me kabhi nahi
    if (p.trendAlign) cands.push({ k: 'trendAlign', v: false, w: 'trend filter hataya' });
    if (p.allowStale === false) cands.push({ k: 'allowStale', v: true, w: 'stale pass wapas' });
    if (p.maxAtrDist < 7) cands.push({ k: 'maxAtrDist', v: Math.min(7, p.maxAtrDist + 1.5), w: 'zone distance khola' });
    if (p.minScore > 5) cands.push({ k: 'minScore', v: p.minScore - 1, w: 'min score kam' });
    if (p.maxZoneWidthAtr < 99) cands.push({ k: 'maxZoneWidthAtr', v: Math.min(99, p.maxZoneWidthAtr + 1.5), w: 'zone width khola' });
    if (!cands.length) return;
    // pehle boolean relax (sirf strong streak par), phir numeric
    const wantBool = t6 >= 5;
    const c = (wantBool && (cands[0].k === 'trendAlign' || cands[0].k === 'allowStale'))
      ? cands[0] : cands.find(x => !(x.k === 'trendAlign' || x.k === 'allowStale')) || cands[0];
    suggest(c.k, c.v, 'Win streak (' + t6 + '/6 target) — ' + c.w + ' ki suggestion');
  }

  // ── periodic review (auto-bot har minute call karta hai) ──
  async function review() {
    if (reviewing) return;
    reviewing = true;
    try {
      await whipsawCheck();
      // rate-limit me queue hua naye SL ka real-market analysis — abhi chala do
      if (pendingDiag && !aiBusy && Date.now() - aiLast >= 60000) {
        const rec = pendingDiag; pendingDiag = null;
        await aiDiagnose(rec);
      }
      // market snapshot (trend/structure/ATR) — panel + analysis ke liye, 90s throttle andar hi
      try { await marketSnapshot(); } catch (e) {}
      diagnose();
      rollbackCheck();                                   // #15: activate ke baad kharab → auto-rollback
      try { cautionFlow(); } catch (e) {}                // #16: 2 SL investigate / 3+ CAUTION MODE
      st.lastReview = Date.now();
      save();
    } catch (e) {
      log('ERR', 'review: ' + e.message);
    }
    reviewing = false;
  }

  // ── entry guard (cooldown) — engine tuning ka extra safety ──
  function canEnter(m) {
    if (st.cooldownUntil > Date.now()) {
      const s = Math.ceil((st.cooldownUntil - Date.now()) / 1000);
      return { ok: false, why: 'AI COOLDOWN · ' + s + 's baad' };
    }
    return { ok: true };
  }

  function params() { return Object.assign({}, st.params); }

  // ── AUTO-TRADE bridge — chain screen (3m/5m zones) ke auto ENTRY/EXIT events server par aate hain
  //    taaki AI agent + status panel dono dekh sakein ki 3m autotrade kya kar raha hai
  // EXIT ka tag: TARGET / SL / ZONE OUT / WIN / LOSS (reason text se, purane events ke liye fallback)
  function hitOf(reason, pnl) {
    return /TARGET/i.test(reason || '') ? 'TARGET' : /STOP/i.test(reason || '') ? 'SL'
      : /ZONE OUT/i.test(reason || '') ? 'OUT' : ((pnl || 0) >= 0 ? 'WIN' : 'LOSS');
  }
  // aaj ke exits LIVE events se ginne hote hain (counter miss ho to bhi sahi rahe)
  function chainDayLive(tfl) {
    const today = new Date().toDateString();
    const xs = (st.autoTrades || []).filter(e => e && e.kind === 'EXIT' && new Date(e.ts).toDateString() === today &&
      (!tfl || e.tf === tfl));
    const d = { exits: xs.length, wins: 0, losses: 0, sls: 0, pnl: 0 };
    for (const e of xs) {
      d.pnl += e.pnl || 0;
      if ((e.pnl || 0) >= 0) d.wins++; else d.losses++;
      if (hitOf(e.reason, e.pnl) === 'SL') d.sls++;
    }
    d.pnl = Math.round(d.pnl * 100) / 100;
    return d;
  }
  function logAutoTrade(rec) {
    rec = rec || {};
    if (rec.kind === 'SYNC') {
      // chain screen wallet snapshot — counts me nahi, detail answer me
      st.chainSync = {
        cash: Number(rec.cash) || 0, netPnl: Number(rec.netPnl) || 0, closedNet: Number(rec.closedNet) || 0,
        open: Number(rec.open) || 0, tradesN: Number(rec.tradesN) || 0, ts: Date.now()
      };
      save();
      return { kind: 'SYNC', cash: st.chainSync.cash };
    }
    const ev = {
      src: rec.src === 'chain' ? 'chain' : 'bot',
      kind: rec.kind === 'EXIT' ? 'EXIT' : 'ENTRY',
      tf: (/^[135]m$/.test(String(rec.tf || '')) ? String(rec.tf) : (String(rec.tf || '3m').replace(/[^0-9a-z]/gi, '').slice(0, 6) || '3m')),
      dir: String(rec.dir || '').toUpperCase().slice(0, 4) || '-',
      sym: String(rec.sym || '').slice(0, 12) || 'NIFTY',
      strike: Number(rec.strike) || 0,
      side: rec.side === 'PE' ? 'PE' : (rec.side === 'CE' ? 'CE' : '-'),
      entry: Number(rec.entry) || 0,
      exit: Number(rec.exit) || 0,
      pnl: Math.round((Number(rec.pnl) || 0) * 100) / 100,
      reason: String(rec.reason || '').slice(0, 40),
      ts: Date.now()
    };
    // EXIT ko classify karo — target mila? SL laga? zone out? (AI agent har trade dekhta hai)
    if (ev.kind === 'EXIT') {
      ev.hit = hitOf(ev.reason, ev.pnl);
      const d = new Date().toDateString();
      if (!st.chainDay || st.chainDay.d !== d) st.chainDay = { d: d, exits: 0, wins: 0, losses: 0, sls: 0, pnl: 0 };
      st.chainDay.exits++;
      st.chainDay.pnl = Math.round((st.chainDay.pnl + ev.pnl) * 100) / 100;
      if (ev.pnl >= 0) st.chainDay.wins++; else st.chainDay.losses++;
      if (ev.hit === 'SL') st.chainDay.sls++;
    }
    st.autoTrades.push(ev);
    if (st.autoTrades.length > 200) st.autoTrades.splice(0, st.autoTrades.length - 200);
    log('AUTO', 'Chain autotrade ' + ev.kind + ' · ' + ev.tf + ' · ' + ev.sym + ' ' + ev.strike + ' ' + ev.side +
      (ev.kind === 'EXIT' && ev.exit ? ' @₹' + ev.exit + ' (' + (ev.reason || 'auto') + ')' : ' @₹' + ev.entry));
    save();
    return ev;
  }

  // per-TF auto-trade stats (server auto-bot results + live engine setup) — status/chat dono me
  function autoTfStats() {
    const out = {};
    for (const tf of ['3m', '5m']) {
      const rs = st.results.filter(r => r && r.tf === tf && (r.kind === 'SL' || r.kind === 'TARGET'));
      const sl = rs.filter(r => r.kind === 'SL').length;
      const tg = rs.filter(r => r.kind === 'TARGET').length;
      const n = sl + tg;
      const atf = engineAn && engineAn.allTF ? engineAn.allTF[tf] : null;
      const s = atf && atf.activeSetup;
      out[tf] = {
        n, sl, target: tg, winRate: n ? Math.round(100 * tg / n) : 0,
        last: rs.length ? rs[rs.length - 1].exitTs : 0,
        live: s ? { status: s.status || '', dir: s.direction || '', entry: Math.round((s.entry || 0) * 100) / 100, zoneTF: s.zoneTF || tf } :
          (atf ? { status: atf.status || '' } : null)
      };
    }
    out.chain = (st.autoTrades || []).slice(-6);          // chain screen ke bridge events (browser se)
    out.chainDay = chainDayLive();                        // aaj ka chain summary (LIVE events se): exits/profit/loss/SL/net
    return out;
  }

  // "chain trade kyu loss hua" / "kyu stoploss hua" — har exit + root cause + auto-fix status
  function chainTradeReport() {
    const L = ['CHAIN TRADE REVIEW (20L demo · 1 lot auto · zone entry→target/SL)'];
    const day = chainDayLive();
    if (day && day.exits) {
      L.push('Aaj: ' + day.exits + ' exit — ' + day.wins + ' profit / ' + day.losses + ' loss (SL ' + day.sls +
        ') · Net ' + (day.pnl >= 0 ? '+' : '−') + '₹' + Math.abs(day.pnl));
    } else {
      L.push('Aaj abhi tak koi trade exit nahi (zone entry→target/SL ka wait hai)');
    }
    const ex = (st.autoTrades || []).filter(e => e && e.kind === 'EXIT').slice(-6).reverse();
    for (const e of ex) {
      // purane events me `hit` nahi — reason/pnl se derive
      const hit = e.hit || (/TARGET/i.test(e.reason || '') ? 'TARGET' : /STOP/i.test(e.reason || '') ? 'SL'
        : /ZONE OUT/i.test(e.reason || '') ? 'OUT' : (e.pnl >= 0 ? 'WIN' : 'LOSS'));
      const tag = hit === 'SL' ? 'STOP LOSS' : hit === 'TARGET' ? 'TARGET' : hit === 'OUT' ? 'ZONE OUT' : hit;
      L.push('· ' + new Date(e.ts).toLocaleTimeString('en-IN', { hour12: false }) + ' ' + e.tf + ' ' + e.sym + ' ' +
        e.strike + ' ' + e.side + ' ₹' + e.entry + '→₹' + e.exit + ' = ' + (e.pnl >= 0 ? '+' : '−') + '₹' +
        Math.abs(Math.round((e.pnl || 0) * 100) / 100) + ' [' + tag + ']');
    }
    const isHit = e => hitOf(e.reason, e.pnl);
    const sls = ex.filter(e => isHit(e) === 'SL');
    const outs = ex.filter(e => isHit(e) === 'OUT');
    if (sls.length || outs.length || (day && day.losses)) {
      L.push('', 'KYU LOSS / KYU STOP LOSS:');
      if (sls.length) L.push('· STOP LOSS = spot zone SL ke bahar ja kar touch — zone invalid/whipsaw ya trend reversal; premium 1:1 spot ke saath neeche aaya.');
      if (outs.length) L.push('· ZONE OUT = SL se pehle zone ke bahar close — position exit, premium time-decay ke saath kam hua.');
      const plainLoss = (day ? day.losses : 0) - sls.length;
      if (plainLoss > 0) L.push('· Bina SL wala loss = target hit hone se pehle premium neeche (intra-zone pullback).');
      L.push('· Exact root cause (zone/curve/score/HTF facts + post-SL): "SL kyu hua" bolo — full STOP LOSS ROOT CAUSE report milega.');
    } else if (day && day.exits && !day.losses) {
      L.push('', 'Aaj koi loss nahi — zone entry se target tak sab clean chala.');
    }
    // ── AUTO THEEK KARE: agent same zones ke SL par rules khud tune karta hai ──
    const F = ['AUTO-FIX status:'];
    if (st.suggest) F.push('· PENDING SUGGESTION: ' + st.suggest.k + ' → "apply karo" bolo (approval par lagegi)');
    else F.push('· Abhi koi pending fix nahi');
    F.push('· Auto pipeline: evidence gate (conf≥60) → historical backtest → auto-activate → paper validation → confirm/rollback (ATR-only fix kabhi auto nahi).');
    if (day && day.sls >= 3) F.push('· Aaj ' + day.sls + ' SL — "SL fix karo" bolo, validation PASS par khud activate ho jayegi.');
    if (st.caution && st.caution.on) F.push('· CAUTION MODE on: ' + (st.caution.reason || 'lagatar SL'));
    L.push('', F.join('\n'));
    return L.join('\n');
  }

  // "ऑप्शन चैन में कितने ट्रेड हुए आज" — dono wallet: chain screen (browser bridge) + server auto-bot
  function chainDetailAnswer(ctx) {
    const L = ['OPTION CHAIN DEMO — aaj kitne trade hue:'];
    const day = chainDayLive();
    const evs = st.autoTrades || [];
    const today = new Date().toDateString();
    const ent = evs.filter(e => e && e.kind === 'ENTRY' && new Date(e.ts).toDateString() === today).length;
    const sy = st.chainSync || null;
    L.push('CHAIN SCREEN (20L browser demo): aaj ' + ent + ' entry · ' + day.exits + ' exit' +
      (day.exits ? ' — ' + day.wins + ' profit / ' + day.losses + ' loss (SL ' + day.sls + ') · Net ' +
        (day.pnl >= 0 ? '+' : '−') + '₹' + Math.abs(day.pnl) : ''));
    if (sy) {
      L.push('· wallet: cash ₹' + Math.round(sy.cash).toLocaleString('en-IN') + ' · open ' + sy.open +
        ' · net P&L ' + (sy.netPnl >= 0 ? '+' : '−') + '₹' + Math.abs(Math.round(sy.netPnl)) +
        ' · total closed ' + sy.tradesN + ' trades' + (sy.ts ? ' (sync ' + new Date(sy.ts).toLocaleTimeString('en-IN', { hour12: false }) + ')' : ''));
    } else if (!ent && !day.exits) {
      L.push('· abhi tak koi trade bridge nahi — chain screen par trade karo, yahan live dikhega');
    } else {
      L.push('· wallet sync abhi stale — chain screen browser me kholo (60s auto-sync chalu)');
    }
    const rex = evs.filter(e => e && e.kind === 'EXIT').slice(-5).reverse();
    if (rex.length) L.push('· Recent: ' + rex.map(e => e.strike + ' ' + e.side + ' ' + (e.pnl >= 0 ? '+' : '−') + Math.abs(Math.round(e.pnl))).join(' | '));
    if (ctx && ctx.cash != null) {
      L.push('', 'SERVER AUTO-BOT (3m+5m zone auto · Groww CE/PE quotes · ALAG 20L wallet):');
      L.push('· open ' + ((ctx.pos || []).length) + ' · cash ₹' + Math.round(ctx.cash).toLocaleString('en-IN') +
        ' · net P&L ' + (ctx.netPnl >= 0 ? '+' : '−') + '₹' + Math.abs(Math.round(ctx.netPnl || 0)));
      const rt = (ctx.trades || []).slice(-5);
      if (rt.length) L.push('· Recent: ' + rt.map(x => x.strike + ' ' + x.side + ' ' + (x.pnl >= 0 ? '+' : '−') + Math.abs(Math.round(x.pnl))).join(' | '));
    }
    L.push('', '(kyu/loss: "chain trade kyu loss hua" · status: "auto bot kya kar raha hai")');
    return L.join('\n');
  }

  // "3m auto trade kaisa chal raha hai" — per-TF stats + live zone + chain events
  function autoTradeAnswer(wantTf) {
    const stt = autoTfStats();
    const tfs = (wantTf === '3m' || wantTf === '5m') ? [wantTf] : ['3m', '5m'];
    const L = ['AUTO TRADE STATUS (3m + 5m paper — real engine, koi real paisa nahi):'];
    for (const tf of tfs) {
      const s = stt[tf];
      let line = '· ' + tf + ': ' + s.n + ' trade';
      if (s.n) line += ' — ' + s.target + ' target / ' + s.sl + ' SL (win ' + s.winRate + '%)';
      else line += ' — abhi tak koi resolve nahi';
      if (s.last) line += ', last exit ' + new Date(s.last).toLocaleTimeString('en-IN', { hour12: false });
      if (s.live && s.live.status && s.live.status !== 'COMPLETED') {
        line += ' | LIVE: ' + s.live.status + (s.live.entry ? ' ' + s.live.dir + ' @' + s.live.entry : '');
      }
      L.push(line);
    }
    if (st.cooldownUntil > Date.now()) {
      L.push('Entry PAUSED — ' + Math.ceil((st.cooldownUntil - Date.now()) / 60000) + ' min baad chalu hogi (open position SL/Target par exit honge)');
    } else if (st.caution && st.caution.on) {
      L.push('CAUTION MODE on (' + (st.caution.reason || 'lagatar SL') + ')');
    }
    const ev = stt.chain || [];
    const day = stt.chainDay;
    if (day && day.exits) {
      L.push('', 'CHAIN aaj: ' + day.exits + ' exit — ' + day.wins + ' profit / ' + day.losses + ' loss (SL ' + day.sls +
        ') · Net ' + (day.pnl >= 0 ? '+' : '−') + '₹' + Math.abs(day.pnl) + (day.losses ? ' · detail: "chain trade kyu loss hua" poochho' : ''));
    }
    if (ev.length) {
      L.push('', 'CHAIN auto-trade (option-chain screen se, agent ko live dikh raha hai):');
      for (const e of ev.slice(-5)) {
        L.push('· ' + new Date(e.ts).toLocaleTimeString('en-IN', { hour12: false }) + ' ' + e.kind + ' · ' + e.tf + ' · ' +
          e.sym + ' ' + e.strike + ' ' + e.side + (e.kind === 'EXIT' && e.exit ? ' @₹' + e.exit + ' ' + (e.reason || '') : ' @₹' + e.entry));
      }
    } else {
      L.push('', 'CHAIN auto-trade events: abhi tak 0 (chain screen par 3m zone ENTRY trigger hote hi yahan dikhega)');
    }
    return L.join('\n');
  }

  function status() {
    const p = st.params;
    const resolved = st.stats.targets + st.stats.sls;
    return {
      params: {
        slBufAtr: p.slBufAtr, entryBufAtr: p.entryBufAtr, tgtMult: p.tgtMult,
        minScore: p.minScore, minRR: p.minRR, maxAtrDist: p.maxAtrDist,
        trendAlign: p.trendAlign, freshOnly: p.freshOnly, allowStale: p.allowStale,
        maxZoneWidthAtr: p.maxZoneWidthAtr
      },
      stats: {
        targets: st.stats.targets, sls: st.stats.sls, outs: st.stats.outs,
        whipsaw: st.stats.whipsaw, consecSL: st.stats.consecSL,
        byDiag: st.stats.byDiag,
        winRate: resolved ? Math.round(100 * st.stats.targets / resolved) : 0
      },
      log: st.log.slice(0, 8),
      recent: st.results.slice(-8).map(r => ({
        tf: r.tf, dir: r.dir, kind: r.kind, score: r.score, trend: r.trend,
        regime: r.regime, post: r.post, pnl: r.pnl, exitTs: r.exitTs
      })),
      journalCount: (st.journal || []).length,
      journal: (st.journal || []).slice(-15),
      suggest: st.suggest || null,                       // pending SUGGESTION (apply user karega)
      slAnalysis: (st.slAnalysis || []).slice(-3),       // structured STOP LOSS ANALYSIS reports
      slEvents: (st.slEvents || []).slice(-5),           // rich SL events (poora trade context)
      learn: st.learn || null,                           // learning stats (#7)
      snap: st.snap || null,                             // LIVE market snapshot (#9 panel)
      // ── versioning + validation + root-cause (requirement #10-#16) ──
      version: st.version,                               // Strategy Version v1.x
      versions: st.versions.slice(-4),                   // recent version records (rollback capability)
      validation: st.validation || null,                 // last validation (PASS/FAIL/INSUFFICIENT/MANUAL_ONLY)
      caution: st.caution || null,                       // CAUTION MODE (3+ lagatar SL)
      rootCause: (st.rootCauses || []).slice(-1)[0] || null,  // latest root-cause report
      rootCauseStats: st.rootCauseStats || {},           // recurring pattern: A-P code → count
      engine: engineAn ? {                               // live engine context (panel ke liye)
        price: engineAn.price || 0, regime: engineAn.regime || '',
        trends: {
          '1m': engineAn.t1 && engineAn.t1.trend, '3m': engineAn.t3 && engineAn.t3.trend,
          '5m': engineAn.t5 && engineAn.t5.trend, '15m': engineAn.t15 && engineAn.t15.trend,
          '30m': engineAn.t30 && engineAn.t30.trend
        },
        sma50: { '3m': engineAn.t3 && engineAn.t3.smaVal, '5m': engineAn.t5 && engineAn.t5.smaVal, '15m': engineAn.t15 && engineAn.t15.smaVal },
        curve: engineAn.location || null
      } : null,
      cooldownLeftMs: Math.max(0, st.cooldownUntil - Date.now()),
      lastReview: st.lastReview,
      intel: intelQuick(),                                      // market intelligence (global/news/FII — strip/panel)
      autoTf: autoTfStats(),                                    // 3m/5m AUTO-TRADE: stats + live zone + chain events
      autoTrades: (st.autoTrades || []).slice(-6),              // chain screen se bridge hue last events
      chainSync: st.chainSync || null,                          // chain screen wallet snapshot (cash/open/net P&L)
      ai: { enabled: !!GEMINI_KEY, calls: st.llmCalls || 0, last: st.aiDiag || null, know: knowAll.length, pdfs: zoneKnow ? 1 : 0 },
      serverTime: Date.now()
    };
  }

  // ── CHAT BRAIN: Hinglish me sawal ka jawab — sab real data se ──
  // mic se aaya text Devanagari bhi ho sakta hai (hi-IN) — dono script match hoti hai
  function norm(s) {
    // \p{M} = combining marks (ं, ॉ वगैरह) — inhe mat kaato, warna Devanagari words tut jayenge
    return String(s || '').toLowerCase()
      .replace(/(\d+)/g, ' $1 ')
      .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  const has = (t, ws) => {
    // chhote words (sl, hi, win) sirf poore word par match — 'network' me 'net' false-positive na ho
    const tk = ' ' + t + ' ';
    return ws.some(w => w.length <= 3 ? tk.includes(' ' + w) : t.includes(w));
  };

  function currentFixes() {
    const p = st.params, f = [];
    // freshOnly/SL-buffer/target× = SYSTEM RULES (v1.1) — ye "fixes" nahi, core rules hain
    if (p.freshOnly) f.push('sirf fresh zone (rule)');
    f.push('SL buffer ' + Math.round((p.slBufAtr || 0) * 100) + '% ATR (rule)');
    f.push('target ×' + p.tgtMult + ' (rule)');
    if (p.minScore > 5) f.push('min score ' + p.minScore);
    if (p.trendAlign) f.push('trend filter ON');
    if (p.allowStale === false) f.push('stale zone OFF');
    if (p.maxAtrDist < 7) f.push('door ke zone band (' + p.maxAtrDist + ' ATR)');
    if (p.maxZoneWidthAtr < 90) f.push('wide zone band');
    return f;
  }

  // ── requirement #10: STOP LOSS ROOT CAUSE — full analysis (PDF facts + root cause
  //    + post-SL + auto-fix + validation + Strategy Version). Purane reports purane
  //    format me hi render (back-compat) ──
  function slAnalysisAnswer(wantTf) {
    const list = st.slAnalysis || [];
    if (!list.length) return '';
    const tfl = wantTf || '';
    let a = tfl ? [...list].reverse().find(x => x.tf === tfl) : null;
    if (!a) a = list[list.length - 1];
    if (!a) return '';
    // label report ke banne se nahi — TRADE ke date/time se (kal ka SL "aaj"/"X min pehle" mat dikhao)
    const _td = new Date().toLocaleDateString('en-CA');
    const _yd = new Date(Date.now() - 86400000).toLocaleDateString('en-CA');
    const jr = (st.journal || []).find(x => x.kind === 'SL' && x.tf === a.tf &&
      Math.abs((x.entry || 0) - (a.entry || 0)) < 0.5 && Math.abs((x.sl || 0) - (a.sl || 0)) < 0.5);
    const ageM = Math.round((Date.now() - (jr ? (jr.ts || 0) : (a.ts || 0))) / 60000);
    const age = (jr && jr.date !== _td)
      ? (jr.date === _yd ? 'kal ' : jr.date + ' ') + (jr.time || '')
      : (ageM < 1 ? 'abhi' : ageM < 90 ? ageM + ' min pehle' : 'aaj');
    const at = a.atrChange || {};
    const L = [];
    // purana report (naye schema se pehle ka) → purana format
    if (!a.causeCode) {
      L.push('STOP LOSS ANALYSIS' + (a.tf ? ' (' + a.tf + ', ' + age + ')' : ''));
      L.push('Trade: ' + (a.dir || '?'));
      L.push('Entry: ' + Math.round(a.entry || 0));
      L.push('SL: ' + Math.round(a.sl || 0));
      L.push('SL Hit: ' + Math.round(a.slHit || 0));
      L.push('AI analysis (real market): ' + (a.primaryReason || '—') + (a.category ? ' [' + a.category + ']' : ''));
      L.push('Market Condition: ' + (a.marketCondition || '—'));
      L.push('Zone Analysis: ' + (a.zoneAnalysis || '—'));
      L.push('Entry Analysis: ' + (a.entryAnalysis || '—'));
      L.push('Stop Loss Analysis: ' + (a.slAnalysis || '—'));
      L.push('ATR Analysis: ' + (a.atrAnalysis || '—'));
      if (a.afterSl) L.push('SL ke baad price: ' + a.afterSl);
      L.push('क्या गलती हुई: ' + (a.mistake || '—'));
      L.push('क्या सुधारना चाहिए: ' + (a.improvement || '—'));
      L.push('क्या ATR बदलना चाहिए: ' + (at.yes
        ? 'YES — old ' + at.old + ' → new ' + at.new + ': ' + (at.why || 'tight SL')
        : 'NO — ' + (at.why || 'reason ATR me nahi hai (entry/zone/trend/structure/volatility me hai) — ATR badalne ki zaroorat nahi')));
      if (a.suggested && a.suggested.length) L.push('Suggestion: ' + a.suggested.join(', ') + ' — apply karne bolo "apply karo" (main khud nahi badalta).');
      if (a.dataOk === false) L.push('Note: poora market data nahi mila tha — ye conclusion limited data se hai.');
      return L.join('\n');
    }
    // ── naya format: STOP LOSS ROOT CAUSE (#10) ──
    const dash = v => (v === 0 || v ? String(v) : '—');
    L.push('STOP LOSS ROOT CAUSE' + (a.tf ? ' (' + a.tf + ', ' + age + ')' : ''));
    L.push('Trade: ' + (a.dir || '?'));
    L.push('Entry: ' + Math.round(a.entry || 0));
    L.push('SL: ' + Math.round(a.sl || 0));
    L.push('SL Hit: ' + Math.round(a.slHit || 0));
    L.push('Zone: ' + (a.zoneType || '—') + (a.marking && a.marking !== 'NORMAL' ? ' (' + a.marking + ')' : '') +
      (a.authentic === false ? ' · NON-AUTHENTIC' : ''));
    L.push('Pattern: ' + (a.pattern || '—') + (a.baseCount ? ' · base candles: ' + a.baseCount : ''));
    L.push('Zone Strength: ' + (a.zoneStrength || (a.tradeScore != null ? 'score ' + a.tradeScore : '—')));
    L.push('Fresh/Tested: ' + (a.fresh || '—'));
    L.push('Trade Score: ' + (a.tradeScore != null && a.tradeScore !== '' ? a.tradeScore + '/10' : '—'));
    L.push('Entry Type: ' + (a.entryType ? a.entryType + (a.entryRule ? ' (' + a.entryRule + ')' : '') : '—'));
    L.push('HTF Location: ' + (a.htfLocation || '—'));
    L.push('ITF Trend: ' + (a.itfTrend || '—') + (a.sma50 ? ' · 50SMA ' + Math.round(a.sma50) : ''));
    L.push('LTF Execution: ' + (a.ltfExecution || '—'));
    L.push('Curve: ' + (a.curve || '—'));
    L.push('AI analysis (real market): [' + a.causeCode + '] ' + (a.primaryRootCause || a.primaryReason || '—') +
      (a.secondaryCause ? ' · Secondary: ' + a.secondaryCause : '') + (a.category ? ' [' + a.category + ']' : ''));
    L.push('Post-SL Price Action: ' + (a.postSl || a.afterSl || '—') + (a.slPlacement ? ' · SL Placement: ' + a.slPlacement : ''));
    L.push('Market Condition: ' + (a.marketCondition || '—') + ' · ATR: ' + (a.atrAnalysis || (at.yes ? 'Relevant' : 'Not Relevant')));
    L.push('Confidence: ' + (a.confidence != null && a.confidence !== '' ? a.confidence + '%' : '—'));
    if (a.explanation || a.mistake) L.push('Detailed Explanation: ' + (a.explanation || a.mistake));
    if (a.dataOk === false) L.push('Insufficient market data for reliable root-cause analysis.');
    // auto-fix + validation + version (#11-#14)
    if (a.fix && a.fix.k != null) {
      L.push('AUTO FIX: ' + a.fix.k + ' = ' + a.fix.v + ' — ' + (a.fix.why || ''));
      if (a.validation) L.push('VALIDATION: ' + a.validation.status + (a.validation.why ? ' — ' + a.validation.why : ''));
      if (a.action === 'ACTIVATED') L.push('Validation PASS → new rule automatically activate (purana rule version history me save — rollback capability).');
      else L.push('Rule change pending approval — "apply karo" bolo (main khud nahi badalta).');
    } else {
      L.push('AUTO FIX: ' + (a.fixNote || 'is root cause ke liye param rule nahi — methodology review') +
        (a.validation ? ' · VALIDATION: ' + a.validation.status : ''));
    }
    if (a.atrChange && a.atrChange.yes) L.push('क्या ATR बदलना चाहिए: YES — ' + at.old + ' → ' + at.new + ' (' + (at.why || '') + ') — approval ke saath.');
    else L.push('क्या ATR बदलना चाहिए: NO — ' + (at.why || 'reason ATR me nahi — ATR default solution nahi'));
    L.push('STRATEGY VERSION: ' + (a.version || st.version) + (st.caution && st.caution.on ? ' · ⚠ CAUTION MODE: ' + st.caution.reason : ''));
    return L.join('\n');
  }

  function whySlAnswer(ctx, wantTf) {
    const tfl = wantTf || '';
    const S = st.stats, bd = S.byDiag || {}, causes = [];
    const d = st.aiDiag && st.aiDiag.reason ? st.aiDiag : null;
    const mine = tfl ? st.results.filter(r => r.tf === tfl) : st.results;
    const slN = mine.filter(r => r.kind === 'SL').length;
    const tgN = mine.filter(r => r.kind === 'TARGET').length;
    // LATEST SL — AJA ke SL ko prefer karo; purana (kal se pehle) dikha to uska SAHI date label
    const _today = new Date().toLocaleDateString('en-CA');
    const _yest = new Date(Date.now() - 86400000).toLocaleDateString('en-CA');
    const slJ = (st.journal || []).filter(x => x.kind === 'SL' && (!tfl || x.tf === tfl));
    const slToday = slJ.filter(x => x.date === _today);
    const anySl = (st.journal || []).filter(x => x.kind === 'SL');
    const recSl = slToday.length ? slToday[slToday.length - 1]
      : (slJ.length ? slJ[slJ.length - 1] : (anySl.length ? anySl[anySl.length - 1] : null));
    const noTodaySL = !slToday.length;   // aaj ka koi SL record hi nahi
    // AI real-market analysis — hamesha dikhao (tf/alag ho to bhi, age label ke saath)
    let aiLine = '';
    if (d) {
      const ageM = Math.round((Date.now() - (d.ts || 0)) / 60000);
      aiLine = 'AI analysis (real market, ' + (d.tf || '') + ', ' + (ageM < 1 ? 'abhi' : ageM < 90 ? ageM + ' min pehle' : 'aaj') + '): ' + d.reason +
        (d.fix && d.fix.length ? ' Fix: ' + d.fix.join(', ') + '.' : '') + ' ';
    }
    // naye SL ka structured analysis — sirf tab tak fire jab us SL ka report na ho
    let fireLine = '';
    if (GEMINI_KEY && recSl && st.results.length >= 1) {
      // report IS SAME TRADE ka hai ya nahi — tf+entry+sl identity (purana: sirf 1hr window → purana SL baar baar re-fire hota tha)
      const hasStruct = (st.slAnalysis || []).some(x => x.tf === recSl.tf &&
        Math.abs((x.entry || 0) - (recSl.entry || 0)) < 0.5 && Math.abs((x.sl || 0) - (recSl.sl || 0)) < 0.5);
      if (!hasStruct) {
        try {
          aiDiagnose(diagRecFor(recSl) || { tf: recSl.tf, dir: recSl.dir, kind: 'SL', zone: { entry: recSl.entry, sl: recSl.sl, tgt: recSl.tgt }, slHit: recSl.price, spotAtEntry: recSl.price, ts: recSl.ts }).catch(() => {});
          fireLine = 'Is SL ka ROOT-CAUSE analysis (candles + trend + structure + zone + post-SL) chal raha hai — 1 min me STOP LOSS ROOT CAUSE block milega. ';
        } catch (e) {}
      }
    }
    if (S.whipsaw) causes.push(S.whipsaw + ' baar SL tight tha (SL ke baad market target tak gaya)');
    if (tfl) {
      // — user jis TF ka poochh raha hai uski apni history —
      if (mine.length) causes.push(tfl + ' ke last ' + mine.length + ' auto-trade: ' + slN + ' SL, ' + tgN + ' Target');
      else causes.push(tfl + ' par abhi tak auto-trade hua hi nahi (auto bot sirf 3m/5m entry leta hai) — us TF ka trade-SL record abhi khali');
      const comp = (((ctx && ctx.completed) || {})[tfl]) || [];
      if (comp.length) {
        const csl = comp.filter(c => c.hitStatus === 'STOP_LOSS_HIT').length;
        const ctg = comp.filter(c => c.hitStatus === 'TARGET_HIT').length;
        causes.push('engine zone results (' + tfl + '): ' + comp.length + ' zone complete → ' + csl + ' zone SL, ' + ctg + ' zone target hit');
      }
      if (!mine.length && !comp.length && !d) causes.push('us TF par SL/zone data abhi nahi hai — agent naya data observe kar raha hai');
    } else {
      if (bd.trend) causes.push(bd.trend + ' baar against-trend me SL');
      if (bd.chop) causes.push(bd.chop + ' baar sideways/chop market me SL');
      if (bd.tested) causes.push(bd.tested + ' baar tested zone par SL');
      if (bd.score) causes.push(bd.score + ' baar kam-score (weak) zone par SL');
      if (bd.wide) causes.push(bd.wide + ' baar bahut bade SL wale zone par SL');
      if (bd.cooldown) causes.push(bd.cooldown + ' baar lagatar SL hue (isliye entry roki)');
      // recurring root cause (requirement #12) — code wise pattern
      const rcs = st.rootCauseStats || {};
      const rks = Object.keys(rcs).sort((x, y) => rcs[y] - rcs[x]).slice(0, 3);
      if (rks.length) {
        causes.push('Root-cause pattern: ' + rks.map(c => '[' + c + '] ' + ((CAUSE_MAP[c] && CAUSE_MAP[c].name) || c) + ' ×' + rcs[c]).join('; '));
      }
      if (!causes.length && !recSl) causes.push(S.sls ? S.sls + ' SL hue — reason ka data abhi kam hai, main observe kar raha hoon' : 'abhi tak koi SL nahi hua');
    }
    const fx = currentFixes();
    let recent = '';
    if (recSl) {
      const m = Math.round((Date.now() - (recSl.ts || 0)) / 60000);
      const rToday = recSl.date === _today;
      // purane record ko KABHI "Aaj/Abhi" mat bolo — date hamesha sach dikhao
      const when = !rToday
        ? (recSl.date === _yest ? 'Kal' : recSl.date ? 'Purana record (' + recSl.date + ')' : 'Purana record') + ' ' + (recSl.time || '')
        : (m < 1 ? 'Abhi abhi' : m < 90 ? 'Abhi ' + Math.max(1, m) + ' min pehle' : 'Aaj ' + (recSl.time || ''));
      recent = (!rToday ? 'Aaj abhi tak koi SL nahi hua. ' : '') + when + ' (' + recSl.tf + ') SL hua: zone entry ₹' + Math.round(recSl.entry || 0) +
        ', SL ₹' + Math.round(recSl.sl || 0) + ', price ₹' + Math.round(recSl.price || 0) +
        (recSl.pnl && recSl.pnl !== '0' ? ' (pnl ' + recSl.pnl + ')' : '') + '. ';
      // aaj SL nahi hua → aaj ke (non-SL) exits dikhao taki user 11:5x wali ghatna dekh sake
      if (!rToday) {
        const ex = (st.journal || []).filter(x => x.date === _today && (x.kind === 'OUT' || x.kind === 'SL') && (!tfl || x.tf === tfl)).slice(-4);
        if (ex.length) recent += 'Aaj ke exits (SL nahi — zone out/invalidation): ' +
          ex.map(x => x.time + ' (' + x.tf + ') ' + (x.status || x.kind) + ' exit ₹' + Math.round(x.price || 0) + ' pnl ' + x.pnl).join('; ') + '. ';
      }
    }
    // chain screen ke aaj ke auto-exits (browser se bridge hote hain) — SL/OUT/target sab dikhao
    const chEx = (st.autoTrades || []).filter(e => e && e.kind === 'EXIT' && e.ts && new Date(e.ts).toLocaleDateString('en-CA') === _today);
    if (chEx.length) {
      recent += 'Chain screen auto exits (aaj): ' + chEx.slice(-5).map(e =>
        new Date(e.ts).toLocaleTimeString('en-GB') + ' ' + (e.hit === 'SL' ? 'STOP LOSS' : e.hit === 'TARGET' ? 'TARGET' : (e.reason || e.hit || 'EXIT')) +
        ' ' + (e.strike || '') + (e.side || '') + ' pnl ' + Math.round(e.pnl || 0)).join('; ') + '. ';
    }
    const lastTuneTs = ((st.log.find(l => l.type === 'TUNE' || l.type === 'AI-DIAG' || l.type === 'ROOT-CAUSE' || l.type === 'SUGGEST' || l.type === 'VERSION' || l.type === 'VALIDATE') || {}).ts) || 0;
    const tuneAge = lastTuneTs ? Math.round((Date.now() - lastTuneTs) / 60000) : 999;
    const fxLabel = !fx.length ? '' : tuneAge <= 15 ? 'Abhi lage fixes: ' : 'Lage fixes (last ' + (tuneAge < 90 ? tuneAge + ' min' : 'aaj') + ' me): ';
    // structured report (#5) ho to wahi body — warna purana aiLine
    const struct = slAnalysisAnswer(wantTf);
    const sg = st.suggest
      ? ' Suggestion pending: ' + st.suggest.k + '=' + st.suggest.v + ' — ' + String(st.suggest.why || '').slice(0, 120) + ' (lagane bolo "apply karo", main khud nahi badalta).'
      : '';
    return recent + (struct ? '' : aiLine) + fireLine + (struct ? '\n' + struct + '\n' : '') +
      (causes.length ? 'SL ke reasons: ' + causes.join('; ') + '. ' : (recSl ? '' : 'Abhi tak koi SL record nahi. ')) +
      (fx.length ? fxLabel + fx.join(', ') + '.' : 'Filhaal default settings kaafi hain — naye data se suggestion dunga (apply aap karoge).') + sg;
  }

  function manualFix() {
    const p = st.params;
    const before = JSON.stringify(p);
    try { diagnose(); } catch (e) {}
    if (JSON.stringify(st.params) !== before) return { msg: st.log[0] ? st.log[0].msg : 'fix lagu', act: 'fix' };

    // REASON-FIRST (sirf user "SL fix karo" par): PDF rules PEHLE —
    // trend → fresh → score → chop → zone-width — ATR (slBufAtr) sirf LAST-RESORT
    // jab reason tight/whipsaw ho aur saare non-ATR filters ya to lage hue hain ya
    // applicable nahi. Cap 35% par kabhi nahi. Spec: AI ko SIRF ATR badha kar
    // solve karne ki permission NAHI hai.
    const sls = st.results.filter(r => r.kind === 'SL').slice(-8);
    const cnt = f => sls.filter(f).length;
    if (sls.length) {
      const trendN = cnt(r => (r.dir === 'BUY' && r.trend === 'down') || (r.dir === 'SELL' && r.trend === 'up'));
      const testedN = cnt(r => r.fresh === 'tested');
      const weakN = cnt(r => r.score != null && r.score <= 6);
      const chopN = cnt(r => r.regime === 'sideways');
      const wideN = cnt(r => r.zone && r.atr > 0 && Math.abs(r.zone.entry - r.zone.sl) / r.atr > 1);
      const tightN = cnt(r => r.post === 'WHIPSAW' || (r.zone && r.atr > 0 && Math.abs(r.zone.entry - r.zone.sl) / r.atr < 0.4));
      const n = sls.length;
      if (trendN >= 1 && !p.trendAlign) { tune('trendAlign', true, 'trend', 'Real reason: SL against trend (' + trendN + '/' + n + ') — trend filter ON'); return { msg: st.log[0].msg, act: 'fix' }; }
      if (testedN >= 1 && !p.freshOnly) { tune('freshOnly', true, 'tested', 'Real reason: tested zone par SL (' + testedN + '/' + n + ') — sirf fresh zone'); return { msg: st.log[0].msg, act: 'fix' }; }
      if (weakN >= 1 && p.minScore < LIMITS.minScore[1]) { tune('minScore', p.minScore + 1, 'score', 'Real reason: kam-score zone par SL (' + weakN + '/' + n + ') — min score badhaya'); return { msg: st.log[0].msg, act: 'fix' }; }
      if (chopN >= 1 && p.maxAtrDist > 4) { tune('maxAtrDist', 4, 'chop', 'Real reason: sideways/chop me SL (' + chopN + '/' + n + ') — door ke zone band'); return { msg: st.log[0].msg, act: 'fix' }; }
      if (wideN >= 1 && p.maxZoneWidthAtr > 1.2) { tune('maxZoneWidthAtr', p.maxZoneWidthAtr > 90 ? 2.5 : p.maxZoneWidthAtr - 0.7, 'wide', 'Real reason: wide zone me SL (' + wideN + '/' + n + ') — zone width kam'); return { msg: st.log[0].msg, act: 'fix' }; }
      if (tightN >= 1 && p.slBufAtr < LIMITS.slBufAtr[1]) {
        const nv = Math.min(LIMITS.slBufAtr[1], p.slBufAtr + 0.05);
        tune('slBufAtr', nv, 'tight', 'Real reason: SL tight/whipsaw (' + tightN + '/' + n + ') — SL buffer ' + Math.round(nv * 100) + '%');
        return { msg: st.log[0].msg, act: 'fix' };
      }
      if (tightN >= 1 && p.slBufAtr >= LIMITS.slBufAtr[1]) {
        return { msg: 'SL tight/whipsaw tha — lekin SL buffer 0.10 × ATR SYSTEM RULE hai (backtest-locked), isliye change nahi karunga. Trend/score/fresh filters se hi rokna hai.', act: '' };
      }
      return { msg: 'Recent SL data dekh kar saare relevant fix lage hue hain — abhi koi nayi badlav ki zaroorat nahi (SL buffer 10% ATR = system rule).', act: '' };
    }
    // SL data hi nahi — real market analysis (candles + data) AI se karwao, andha ATR bump nahi
    if (GEMINI_KEY && st.results.length >= 1) {
      try { aiDiagnose(st.results.filter(r => r.kind === 'SL').pop() || { kind: 'SL', tf: '3m' }).catch(() => {}); } catch (e) {}
      return { msg: 'Real market analysis chal raha hai (candles + purane SL data) — 1-2 min me reason ke hisaab se fix laga dunga. Bina wajah ke ATR nahi badhaunga.', act: 'fix' };
    }
    return { msg: 'Abhi SL data kam hai — naye SL aate hi real reason dekh kar khud fix karunga (bina wajah ke ATR nahi badhunga).', act: '' };
  }

  // ── REAL MARKET zones: jo TF user ne khol rakha hai (ya poocha hai) uske
  //    live engine zones — entry / stop loss / target ──
  // ── DAILY LIVE JOURNAL: engine ki ds_history se har zone result (entry/SL/target + price) ──
  //    ai-agent.json me persist — delete nahi hota. Pehli sync = poora din load (baseline),
  //    uske baad naye SL turant AI-diagnose (auto-fix) ──
  const jKey = x => (x.date || '') + '|' + (x.time || '') + '|' + (x.tf || '') + '|' + (x.status || '') + '|' + Math.round(x.entry || 0);
  const jKind = s => s === 'STOP_LOSS_HIT' ? 'SL' : s === 'TARGET_HIT' ? 'TARGET' : 'OUT';
  function syncHistory(hist) {
    if (!Array.isArray(hist) || !hist.length) return 0;
    if (!journalSeen) journalSeen = new Set((st.journal || []).map(jKey));
    let added = 0; const fresh = [];
    for (const h of hist) {
      const k = jKey(h);
      if (journalSeen.has(k)) continue;
      journalSeen.add(k);
      const rec = {
        ts: (() => { const d = new Date((h.date || '') + 'T' + (h.time || '')); return isNaN(d) ? Date.now() : d.getTime(); })(),
        date: h.date, time: h.time, tf: h.tf, dir: h.direction || '',
        kind: jKind(h.status), status: h.status, entry: h.entry, sl: h.stopLoss, tgt: h.target,
        price: h.price, pnl: h.pnl, pattern: h.pattern || ''
      };
      st.journal.push(rec); fresh.push(rec); added++;
    }
    if (!added) return 0;
    if (st.journal.length > 5000) st.journal.splice(0, st.journal.length - 5000);   // sirf cap — din ka data rehta hai
    save();
    if (journalSeeded) {
      for (const rec of fresh) {
        if (rec.kind !== 'SL') continue;
        log('JOURNAL', rec.tf + ' ' + (rec.dir || '') + ' zone SL @₹' + Math.round(rec.price || 0) + ' — AI diagnosis chalu');
        try { aiDiagnose(diagRecFor(rec)).catch(() => {}); } catch (e) {}
      }
    }
    journalSeeded = true;
    return added;
  }

  // ── Aaj ke saare ZONES save (3m + baaki TF) — roz ka zone diary (persist, delete nahi) ──
  let zoneSeen = null;
  const zKey = (tf, z) => tf + '|' + (z && z.zoneTime) + '|' + (z && z.type) + '|' + Math.round(((z && z.proximal) || 0) * 10) / 10;
  function syncZones(all) {
    if (!all || typeof all !== 'object') return 0;
    if (!zoneSeen) zoneSeen = new Set((st.journal || []).filter(x => x.kind === 'ZONE' && x.zkey).map(x => x.zkey));
    let added = 0;
    for (const tf of Object.keys(all)) {
      for (const z of (all[tf] || [])) {
        if (!z || z.proximal == null) continue;
        const k = zKey(tf, z);
        if (zoneSeen.has(k)) continue;
        zoneSeen.add(k);
        const zt = typeof z.zoneTime === 'number' ? z.zoneTime : (Date.parse(z.zoneTime) || Date.now());
        const d = new Date(zt);
        st.journal.push({
          ts: zt, zkey: k, date: d.toLocaleDateString('en-CA'),
          time: d.toLocaleTimeString('en-IN', { hour12: false }),
          tf, kind: 'ZONE', status: z.type || '',
          dir: z.type === 'demand' ? 'BUY-ZONE' : 'SELL-ZONE',
          entry: z.proximal, sl: z.distal, tgt: 0, price: 0,
          score: z.tradeScore ? z.tradeScore.score : null,
          fresh: z.fresh ? 'fresh' : 'tested', pattern: z.pattern || ''
        });
        added++;
      }
    }
    if (added) {
      if (st.journal.length > 5000) st.journal.splice(0, st.journal.length - 5000);
      save();
    }
    return added;
  }

  function journalAnswer() {
    const j = st.journal || [];
    if (!j.length) return 'Journal abhi khali hai — engine ke naye entry/SL/target aate hi yahan save hote rahenge (delete nahi hote).';
    const today = new Date().toLocaleDateString('en-CA');
    const t = j.filter(x => x.date === today);
    const pool0 = t.length ? t : j.slice(-10);
    const zt = pool0.filter(x => x.kind === 'ZONE');
    const pool = pool0.filter(x => x.kind !== 'ZONE');
    const sl = pool.filter(x => x.kind === 'SL').length, tg = pool.filter(x => x.kind === 'TARGET').length, ot = pool.filter(x => x.kind === 'OUT').length;
    const zLine = zt.length
      ? ' · zones saved: ' + zt.length + ' (' + ['3m', '5m', '1m', '15m', '30m'].map(tf => tf + ': ' + zt.filter(x => x.tf === tf).length).join(', ') + ')'
      : '';
    const last = pool.slice(-5).reverse().map(x =>
      (x.time || '') + ' · ' + x.tf + ' ' + (x.dir || '') + ' ' + x.kind +
      ' · zone ₹' + Math.round(x.entry || 0) + '→SL ₹' + Math.round(x.sl || 0) + '→TGT ₹' + Math.round(x.tgt || 0) +
      (x.price ? ' @price ₹' + Math.round(x.price) : '') + (x.pnl && x.pnl !== '0' ? ' · pnl ' + x.pnl : ''));
    return 'Aaj (' + today + ') live zone results: ' + pool.length + ' — ' + tg + ' target, ' + sl + ' SL, ' + ot + ' zone-out' + zLine + '.' +
      (last.length ? ' Recent: ' + last.join(' | ') + '.' : '') + ' Sab drive (file) me save hain — delete nahi hote.';
  }

  // ── ZONE COUNT — "kitne zone bane, kitne SL/target hue" (aaj ke COUNTS, maujooda zones nahi) ──
  function zoneCountAnswer(ctx, wantTf) {
    const today = new Date().toLocaleDateString('en-CA');
    const tfl = wantTf || '';
    const j = st.journal || [];
    const z = j.filter(x => x.kind === 'ZONE' && x.date === today && (!tfl || x.tf === tfl));
    let res = j.filter(x => x.kind !== 'ZONE' && x.date === today && (!tfl || x.tf === tfl));
    if (!res.length) {
      // journal history-sync khali hai to live engine ke completedByTF se (sirf us TF ka)
      const comp = (ctx && ctx.completed) || (engineAn && engineAn.completedByTF) || {};
      const ctfs = tfl ? [tfl] : Object.keys(comp);
      for (const tf of ctfs) {
        for (const h of (comp[tf] || [])) {
          if (h && (h.date === today || (!h.date && (h.hitTime || h.time)))) res.push({ kind: jKind(h.hitStatus || h.status), tf: tf });
        }
      }
    }
    const tg = res.filter(x => x.kind === 'TARGET').length;
    const sl = res.filter(x => x.kind === 'SL').length;
    const ot = res.filter(x => x.kind === 'OUT').length;
    const tfs = ['3m', '5m', '1m', '15m', '30m'];
    const lab = v => { const s = String(v == null ? '' : v); return /m$/.test(s) ? s : s + 'm'; };
    const L = ['ZONE COUNT (aaj ' + today + (tfl ? ' · ' + tfl : '') + ' · real market data):'];
    L.push('· Zones bane: ' + z.length + (!tfl && z.length
      ? ' (' + tfs.map(tf => { const n = z.filter(x => x.tf === tf).length; return n ? tf + '×' + n : ''; }).filter(Boolean).join(' · ') + ')'
      : ''));
    L.push('· Zone results: ' + tg + ' TARGET · ' + sl + ' STOP LOSS · ' + ot + ' zone-out' +
      (res.length ? ' (total ' + res.length + ' resolve hue)' : ' — abhi tak koi resolve nahi'));
    // abhi live active zones (entry/SL/target ke saath) — sirf poochha gaya TF
    let rows = ((ctx && ctx.actives) || []).filter(a => a && a.setup && a.setup.entry != null &&
      (!tfl || lab(a.setup.zoneTF || a.tf) === tfl));
    if (!rows.length && engineAn && engineAn.allTF) {
      for (const tf of (tfl ? [tfl] : tfs)) {
        const at = engineAn.allTF[tf];
        const s = at && at.activeSetup;
        if (s && s.entry != null) rows.push({ tf: tf, setup: s });
      }
    }
    if (rows.length) {
      L.push('· Abhi active: ' + rows.map(r => {
        const s = r.setup;
        return (s.zoneTF || r.tf) + ' ' + (s.direction || '') + ' Entry ₹' + Math.round(s.entry) +
          ' · SL ₹' + Math.round(s.stopLoss) + ' · Target ₹' + Math.round(s.target) + (s.status ? ' (' + s.status + ')' : '');
      }).join(' | '));
    } else {
      L.push('· Abhi ' + (tfl ? tfl + ' par ' : '') + 'koi active setup nahi — naye zone ka wait (real market scan chal raha hai)');
    }
    // lifetime — sawal ke TF ke trades (st.results = last 40 observe records)
    const rs = tfl ? st.results.filter(r => r.tf === tfl) : st.results;
    const wt = rs.filter(r => r.kind === 'TARGET').length;
    const ws = rs.filter(r => r.kind === 'SL').length;
    const w = wt + ws;
    L.push('· Agent lifetime' + (tfl ? ' (' + tfl + ')' : '') + ': ' + wt + ' target / ' + ws + ' SL' +
      (w ? ' (win ' + Math.round(100 * wt / w) + '%)' : ''));
    const cd = chainDayLive(tfl);
    if (cd.exits) L.push('· Chain demo' + (tfl ? ' (' + tfl + ')' : '') + ': ' + cd.exits + ' exit — ' + cd.wins + ' profit / ' + cd.losses + ' loss (SL ' + cd.sls + ')');
    L.push('(live zones: "zone kya hai" · full log: "aaj ka journal" · kyu: "SL kyu hua")');
    return L.join('\n');
  }

  function zonesAnswer(ctx, wantTf) {
    const acts = (ctx && ctx.actives) || (ctx && ctx.active ? [{ tf: ctx.active.zoneTF, setup: ctx.active }] : []);
    const rows = acts.filter(a => a && a.setup && a.setup.entry != null);
    // zoneTF engine se '3m'/'5m' aata hai — kabhi '3' bhi aaye to lag mat do (warna '3mm')
    const lab = v => { const s = String(v == null ? '' : v); return /m$/.test(s) ? s : s + 'm'; };
    const fmt1 = r => {
      const s = r.setup;
      return lab(s.zoneTF || r.tf) + ' ' + (s.direction || '') + ': Entry ₹' + Math.round(s.entry) +
        ' · SL ₹' + Math.round(s.stopLoss) + ' · Target ₹' + Math.round(s.target) +
        (s.status ? ' (' + s.status + ')' : '');
    };
    // us TF ki LIVE market analysis — engine har tick par 1m/3m/5m/15m/30m sab scan karta hai
    const live = tfv => {
      const bits = [];
      const an = (ctx && ctx.analysis) || {};
      const r = (an.tf && an.tf[tfv]) || null;
      if (an.trends && an.trends[tfv]) bits.push('trend ' + an.trends[tfv]);
      if (an.price) bits.push('price ₹' + Math.round(an.price));
      if (r) {
        if (r.status === 'NO_SETUP') bits.push(r.note || 'koi setup nahi');
        else bits.push('setup ' + r.status + (r.dir ? ' ' + r.dir : '') + (r.score != null ? ' (score ' + r.score + ')' : '') + (r.note ? ' · ' + r.note : ''));
      }
      const comp = (((ctx && ctx.completed) || {})[tfv]) || [];
      if (comp.length) {
        const sl = comp.filter(c => c.hitStatus === 'STOP_LOSS_HIT').length;
        const tg = comp.filter(c => c.hitStatus === 'TARGET_HIT').length;
        bits.push('zone results: ' + comp.length + ' complete → ' + sl + ' SL, ' + tg + ' target');
      }
      return bits.join(', ');
    };
    if (wantTf) {
      const pick = rows.filter(r => lab(r.setup.zoneTF || r.tf) === lab(wantTf));
      const lv = live(lab(wantTf));
      if (pick.length) return 'Real market ke ' + lab(wantTf) + ' zones: ' + pick.map(fmt1).join(' | ') + (lv ? ' | Live: ' + lv : '') + '.';
      if (!rows.length) return 'Abhi koi active zone nahi hai — real market scan chal raha hai, zone trigger hote hi entry/SL/target sahit bataunga.' + (lv ? ' ' + lab(wantTf) + ' live analysis: ' + lv + '.' : '');
      return 'Abhi ' + lab(wantTf) + ' par tradeable zone nahi' + (lv ? ' (' + lv + ')' : '') + '. Baaki TF zones: ' + rows.map(fmt1).join(' | ') + '.';
    }
    if (!rows.length) return 'Abhi koi active zone nahi hai — real market scan chal raha hai, zone trigger hote hi entry/SL/target sahit bataunga.';
    return 'Real market ke active zones: ' + rows.map(fmt1).join(' | ') + '.';
  }

  function reply(q, ctx) {
    ctx = ctx || {};
    const t = norm(q);
    const p = st.params, S = st.stats, bd = S.byDiag || {};
    // jo TF user poochh raha hai (sawal me — Latin ya Devanagari "3 मिनट") ya chart me khol rakha hai
    const tfM = t.match(/\b(1|3|5|15|30)\s*(?:m\b|min\b|mins\b|minute|minutes|मिनट|मिनीट|मिनिट)/);
    const wantTf = tfM ? tfM[1] + 'm' : (ctx.openTf || '');

    const WHY = ['kyu', 'kyo', 'kyon', 'kyun', 'kye hi', 'why', 'reason', 'karan', 'wajah', 'kaise', 'ho ra', 'ho re', 'क्यों', 'क्यूं', 'कारण', 'वजह', 'कैसे'];
    const SLW = ['sl', 'stop loss', 'stoploss', 'stop', 'loss', 'nuksan', 'nukasan', 'nuksaan', 'लॉस', 'स्टॉप', 'नुकसान', 'घाटा'];
    const isWhy = has(t, WHY), isSL = has(t, SLW);
    const isFix = has(t, ['fix', 'theek', 'thik', 'sudhar', 'improve', 'badhao', 'badha do', 'bada do', 'adjust', 'sahi karo', 'solve', 'सुधार', 'ठीक', 'सही', 'बढ़ा']);
    const isReset = has(t, ['reset', 'default', 'normal', 'wapas', 'purana', 'रीसेट', 'डिफॉल्ट', 'वापस', 'पुराना']);
    const isPause = has(t, ['pause', 'rok do', 'roko', 'ruko', 'ruk jao', 'band karo', 'entry band', 'stop entry', 'wait karo', 'रुको', 'रोको', 'बंद', 'पॉज']);
    const isResume = has(t, ['resume', 'chalu', 'chal do', 'start', 'continue', 'on karo', 'शुरू', 'चालू']);
    const isWhip = has(t, ['whipsaw', 'fake', 'false sl', 'wick', 'jhuka', 'फेक', 'फर्जी']);
    const isTune = has(t, ['tune', 'setting', 'config', 'kya badla', 'kya fix', 'kya tune', 'adjust kya', 'बदल', 'सेटिंग', 'ट्यून']);
    const isSlNow = has(t, ['kitna sl', 'sl kitna', 'buffer', 'abhi sl', 'current sl', 'stop loss kitna', 'sl kya', 'बफर', 'कितना स्टॉप']);
    const isStatus = has(t, ['status', 'report', 'performance', 'kaisa', 'kaisi', 'chal raha', 'chal ri', 'jeet', 'win', 'pnl', 'profit', 'kamaya', 'net', 'स्टेटस', 'रिपोर्ट', 'कैसा']);
    const isTrades = has(t, ['trade', 'position', 'open', 'entry', 'holding', 'paisa', 'cash', 'ट्रेड', 'पोजिशन', 'निवेश', 'पैसा', 'कैश']);
    const isHelp = has(t, ['help', 'kya kar', 'kya bata', 'kaam', 'feature', 'menu', 'madad', 'samjha', 'मदद', 'क्या कर', 'बता']);
    const isGreet = has(t, ['hi', 'hello', 'hey', 'namaste', 'namaskar', 'kaise ho']) && t.length <= 25;

    // 1) greeting
    if (isGreet) return { a: 'Namaste! Main AI SL agent hoon. Poochho — "SL kyu hua" (full STOP LOSS ROOT CAUSE: zone/curve/HTF facts + root cause + post-SL + validation + version), "root cause bolo", "1m me kya bana" / live zone analysis, "pattern batao" (learning + recurring root cause), "zone kaise bante hain" (aapki PDF se), status, "SL fix karo" (validation PASS par khud activate, warna suggestion → "apply karo"). Mic bhi chalega.', act: '' };

    // 2) reset
    if (isReset && !isWhy) {
      st.params = Object.assign({}, DEFAULTS);
      st.stats.byDiag = {}; st.stats.consecSL = 0; st.cooldownUntil = 0;
      log('TUNE', 'User ne reset kiya — default settings wapas');
      save();
      return { a: 'Settings default par reset: SL buffer 5% ATR, target ×2, min score 5, koi filter nahi. Naye data se agent phir khud adjust karega.', act: 'reset' };
    }

    // 3) resume / pause
    if (isResume && !isWhy) {
      st.cooldownUntil = 0; st.stats.consecSL = 0;
      log('TUNE', 'User ne bola — entry chalu');
      save();
      return { a: 'Theek hai — entry chalu. Abhi se naye 3m aur 5m zone par trade lungi.', act: 'resume' };
    }
    if (isPause && !isWhy) {
      const mRaw = t.match(/(\d+)\s*(min|mins|minute|minutes|mint|मिनट)/);
      const mins = Math.min(480, Math.max(1, parseInt(mRaw && mRaw[1], 10) || 30));
      st.cooldownUntil = Date.now() + mins * 60000;
      st.stats.byDiag.cooldown = (st.stats.byDiag.cooldown || 0) + 1;
      log('TUNE', 'User ne pause bola — ' + mins + ' min entry band');
      save();
      return { a: 'Theek hai — abhi se ' + mins + ' minute tak koi nayi entry nahi lungi. Open position SL/Target par apne aap exit hongi.', act: 'pause' };
    }

    // 3.5) suggestion APPLY (requirement #6: rule sirf user approval par badalta hai)
    const isApply = has(t, ['apply', 'suggestion lag', 'suggest lag', 'suggest apply', 'haan karo', 'karo ha', 'accept', 'manjoor', 'maan jao', 'लागू', 'स्वीकार', 'कर दो']);
    if (isApply && !isWhy) {
      if (!st.suggest) return { a: 'Abhi koi pending suggestion nahi hai. Agent SL data dekh kar suggest karega — "SL fix karo" bolo, phir "apply karo" se lagaoge.', act: '' };
      const r = applySuggest();
      return { a: r.msg, act: r.act || '' };
    }

    // 3.6) LEARNING / pattern (#7): historical trades se zone-wise, trend-wise, hour-wise pattern
    const isLearning = has(t, ['pattern', 'learning', 'zone wise', 'zone-wise', 'seekh', 'hour wise', 'kis tarah', 'kaise karte', 'historical']);
    if (isLearning && !isWhy && !isFix) return { a: learnAnswer(), act: '' };

    // 3.65) AUTO-TRADE status — "3m auto trade kaisa chal raha", "auto bot kya kar raha", "chain trade"
    const isAuto = has(t, ['auto trade', 'autotrade', 'auto-trade', 'auto trading', 'auto entry', 'auto entries', 'auto bot', 'bot kya kar', 'bot kaisa', 'bot chal', 'chain trade', 'chain se trade', 'ऑटो ट्रेड', 'ऑटोट्रेड']);
    const isChain = has(t, ['chain', 'चेन', 'चैन', 'डैमो']);    // option-chain screen wale trades (Hinglish + Devanagari dono)
    const isOiAsk = has(t, ['pcr', 'support', 'resistance', 'open interest', 'बैलेंस']);  // pure OI analytics → MI path
    // chain DETAIL: "chain me kitne trade hue", "डैमो में क्या लॉस प्रॉफिट" → counts + wallet + recent (donо wallet)
    if (isChain && !isWhy && !isOiAsk && (isTrades || isStatus || isSL) && !isFix && !isReset && !isPause && !isResume && !isApply) return { a: chainDetailAnswer(ctx), act: '' };
    // kyu/loss/stoploss sawal → har trade ka review + root cause + auto-fix status
    if ((isAuto || isChain) && (isWhy || isSL) && !isFix && !isReset && !isPause && !isResume && !isApply) return { a: chainTradeReport(), act: '' };
    if (isAuto && !isWhy && !isFix && !isReset && !isPause && !isResume && !isApply) return { a: autoTradeAnswer(wantTf), act: '' };

    // 4) fix karo (reason + auto-fix dono)
    if (isFix && (isSL || isWhy || !isStatus)) {
      const r = manualFix();
      const fx = currentFixes();
      const why = (isWhy && isSL) ? whySlAnswer(ctx, wantTf) + ' ' : '';
      return { a: why + r.msg + '.' + (fx.length ? ' Abhi lage fixes: ' + fx.join(', ') + '.' : ''), act: r.act || 'fix' };
    }

    // 4b) SL kam karo (tight — user chahe to) — SYSTEM RULE: 0.10 × ATR locked
    if (isSL && has(t, ['kam karo', 'kam kar', 'chhota', 'reduce', 'lower', 'tight'])) {
      if (p.slBufAtr > LIMITS.slBufAtr[0]) {
        tune('slBufAtr', p.slBufAtr - 0.05, 'manual', 'User ne bola — SL buffer kam kiya');
        return { a: 'SL buffer kam karke ' + Math.round(st.params.slBufAtr * 100) + '% ATR kar diya. Dhyan raho — bahut tight SL se whipsaw badh sakta hai.', act: 'fix' };
      }
      return { a: 'SL buffer SYSTEM RULE (0.10 × ATR14) par locked hai — backtest numbers isi se hain, aur kam nahi kar sakte.', act: '' };
    }

    // 8b) Aaj ka live journal — har entry/SL/target price ke saath (persist, delete nahi)
    const isJournal = has(t, ['aaj ka', 'aaj kya', 'aaj ke', 'daily report', 'daily log', 'journal', 'trade log', 'kitne trade', 'kitni trade', 'kitni entry', 'kya kya hua', 'log dikhao', 'आज का', 'आज क्या']);

    // 4c) REAL MARKET zones — entry / stop loss / target (wantTf = sawal ka TF ya open TF, top me parse hua)
    // zone KA FORMATION (theory) — user ki PDF knowledge se Gemini jawab dega
    if (isJournal && !isFix && !isWhy) return { a: journalAnswer(), act: '' };
    // 4.7) ZONE COUNT — "kitne zone bane / kitne target hue" (Devanagari + Hinglish) — counts chahiye, list nahi
    const isZoneCount = !isTrades && !isSlNow && !isTune && has(t, ['kitne', 'कितने', 'kitna', 'कितना']) &&
      has(t, ['zone', 'zones', 'ज़ोन', 'जोन', 'target', 'targets', 'टारगेट', 'stoploss', 'stop loss', 'स्टोपलो', 'स्टॉपलॉस', 'स्टोपलॉस', 'स्टोब्लॉस', 'स्टोव लॉस', 'स्टोप लॉस', 'स्टॉप लॉस', 'sl', 'sls', 'hit', 'bane', 'बने', 'hue', 'हुए']);
    if (isZoneCount && !isFix && !isWhy && !isJournal && !isReset && !isPause && !isResume) return { a: zoneCountAnswer(ctx, wantTf), act: '' };
    // 4.9) ROOT CAUSE report (#10) — explicit poochhne par seedha block (zone/live se pehle)
    const isRoot = has(t, ['root cause', 'rootcause', 'mool karan', 'asli karan', 'रूट कारण', 'मूल कारण']);
    if (isRoot && !isFix) {
      const struct = slAnalysisAnswer(wantTf);
      if (struct) return { a: struct, act: '' };
      return { a: 'Abhi tak koi root-cause report nahi hai — pehla SL aate hi PDF methodology (zone/pattern/score, curve, HTF/ITF/LTF, post-SL) se STOP LOSS ROOT CAUSE report milega. Agar data kam hua to wahi report me likha aayega: "Insufficient market data for reliable root-cause analysis."', act: '' };
    }
    const isZoneHow = has(t, ['kaise ban', 'kaise pehch', 'kaise identify', 'zone formation', 'formation', 'banne ka', 'methodology', 'pdf', 'कैसे बन', 'कैसे पहचान']);
    if (isZoneHow) return { a: 'Zone formation ki methodology (aapki PDF) se jawab aa raha hai...', fallback: true, know: true };
    const isZoneAsk = has(t, ['zone', 'level', 'entry', 'target', 'जोन', 'ज़ोन', 'एंट्री', 'टारगेट']);
    if (isZoneAsk && !(isWhy && isSL)) return { a: zonesAnswer(ctx, wantTf), act: '' };
    // live analysis maang raha: "kya bana", "1m me bna ha", "market analysis", "konsa zone"
    const isLiveNow = has(t, ['kya bana', 'bna hai', 'bna ha', 'bana hai', 'bana ha', 'kisme bana', 'konsa zone', 'kaun sa zone', 'live zone', 'market analysis', 'analysis karo', 'abhi kya chal', 'abhi kya hai']);
    if (isLiveNow && !isZoneHow && !(isWhy && isSL)) return { a: zonesAnswer(ctx, wantTf), act: '' };

    // 5) SL kyu ho raha (jo TF poocha/ khola hai uski history ke saath)
    if (isWhy && isSL) return { a: whySlAnswer(ctx, wantTf), act: '' };

    // 6) whipsaw
    if (isWhip) {
      return { a: 'Whipsaw matlab SL lagne ke baad market wapas target tak gaya — ' + (S.whipsaw || 0) + ' baar hua. SL buffer ab 10% ATR (SYSTEM RULE, locked) hai — fresh zone + trend filter se whipsaw rokna hai.', act: '' };
    }

    // 7) abhi SL/buffer kitna
    if (isSlNow) {
      return { a: 'Abhi SL buffer ' + Math.round(p.slBufAtr * 100) + '% ATR hai (SYSTEM RULE = 10%, locked), target ×' + p.tgtMult + ' (rule = ×0.5), min score ' + p.minScore +
        (p.trendAlign ? ', trend filter ON' : '') + (p.freshOnly ? ', fresh zone only (rule)' : '') + '.', act: '' };
    }

    // 8) tune kya hua
    if (isTune) {
      const fx = currentFixes();
      const last = (st.log.find(l => l.type === 'TUNE') || {}).msg;
      const sg = st.suggest ? ' Pending suggestion: ' + st.suggest.k + '=' + st.suggest.v + ' (' + String(st.suggest.why || '').slice(0, 100) + ') — apply karne bolo.' : '';
      return { a: (fx.length ? 'Lage fixes: ' + fx.join(', ') + '.' : 'Sab default par hai.') + (last ? ' Last: ' + last + '.' : '') + sg, act: '' };
    }

    // 9) open position / trades
    if (isTrades) {
      const pos = ctx.pos || [];
      let s = 'Abhi ' + pos.length + ' open position' + (pos.length === 1 ? '' : 's') + ', cash ₹' + Math.round(ctx.cash || 0) + ', net P&L ₹' + Math.round(ctx.netPnl || 0) + '.';
      const tr = (ctx.trades || []).slice(0, 3);
      if (tr.length) s += ' Recent: ' + tr.map(x => x.strike + ' ' + x.side + ' ' + (x.pnl >= 0 ? '+' : '') + Math.round(x.pnl)).join(', ') + '.';
      return { a: s, act: '' };
    }

    // 10) status / performance
    if (isStatus) {
      const res = S.targets + S.sls;
      const wr = res ? Math.round(100 * S.targets / res) : 0;
      let s = 'Performance: ' + S.targets + ' target, ' + S.sls + ' SL' + (S.outs ? ', ' + S.outs + ' zone-out' : '') + ', win ' + wr + '%.';
      if (ctx.netPnl != null) s += ' Net P&L ₹' + Math.round(ctx.netPnl) + '. Open ' + ((ctx.pos || []).length) + '.';
      if (st.cooldownUntil > Date.now()) s += ' Abhi ' + Math.ceil((st.cooldownUntil - Date.now()) / 60000) + ' min entry pause chalu hai.';
      else s += ' Entry chalu hai (3m + 5m zones).';
      const fx = currentFixes();
      if (fx.length) s += ' Fixes: ' + fx.join(', ') + '.';
      if (st.caution && st.caution.on) s += ' ⚠ CAUTION MODE: ' + st.caution.reason + ' — investigate: ' + st.caution.investigate + '.';
      s += ' Strategy Version ' + st.version + ' (' + st.versions.length + ' changes, rollback capability on)';
      if (st.validation) s += ' · last validation: ' + st.validation.key + ' = ' + st.validation.status;
      const rcs = st.rootCauseStats || {};
      const rks = Object.keys(rcs).sort((x, y) => rcs[y] - rcs[x]).slice(0, 2);
      if (rks.length) s += ' · root causes: ' + rks.map(c => '[' + c + ']×' + rcs[c]).join(', ');
      return { a: s, act: '' };
    }

    // 11) help / fallback — kuch samajh nahi aaya to (flag: replyAi isse Gemini ko dega)
    return { a: 'Ye pooch sakte ho: (1) SL kyu hua — full STOP LOSS ROOT CAUSE (PDF facts + root cause A-P + post-SL + validation + Strategy Version). (2) Status batao (version + caution bhi). (3) SL fix karo — validation PASS par khud activate, warna suggestion phir "apply karo". (4) Setting dikhao. (5) Jo TF kholo — "1m me kya bana" / live zone analysis. (6) Aaj ka trade log. (7) Pattern batao — learning stats + recurring root cause. (8) 30 minute ruk jao / chalu karo. (9) Reset karo. Mic dabao ya type karo.', act: '', fallback: true };
  }

  // ── replyAi: keyword na mile to Gemini se Hinglish jawab (data ke saath) ──
  async function replyAi(q, ctx) {
    // ── MARKET INTELLIGENCE intents (news/FII/calendar/why-market/stock) — real data se jawab,
    //    sync reply() se PEHLE taaki wo intents hijack na kare ──
    if (INTEL) {
      try {
        // chain-screen TRADE/wallet sawal MI (OI/PCR) ke liye HIJACK na ho — reply() chalaye
        const tlq = String(q || '').toLowerCase();
        const chainTradeQ = /(chain|चैन|चेन|डैमो|demo)/.test(tlq) &&
          /(trade|trades|kitne|कितने|cash|wallet|p&l|pnl|profit|loss|लॉस|प्रॉफिट|net|position)/.test(tlq);
        const kind = chainTradeQ ? null : INTEL.detect(q);
        if (kind) {
          ctx = ctx || {};
          if (kind === 'slnews' && !ctx.miTs) {
            ctx.miTs = (st.slEvents || []).slice(-3).map(x => x.slHitTs || x.ts || 0).filter(Boolean);
          }
          const a = await INTEL.answer(kind, q, ctx);
          if (a && String(a).trim()) {
            st.miCalls = (st.miCalls || 0) + 1;
            save();
            log('MI', 'market-intel · ' + kind + ' · ' + String(q).slice(0, 50));
            return { a: String(a).trim().slice(0, 2600), act: 'mi' };
          }
        }
      } catch (e) {}
    }
    const r = reply(q, ctx);
    if (!r.fallback || !GEMINI_KEY) return r;
    ctx = ctx || {};
    const sys = 'Tum "DS Zone Engine" ka AI trading agent ho. Jawab Hinglish ya Devanagari me, 1-3 line, seedha aur saaf. ' +
      'Sirf trading bot ke kaam (zones, SL, target, entry, settings, status) ke jawab do — paisa nikaalna, broker, account jaise sawal ka bolo ki ' +
      'sirf ye trading engine kaam karta hai. Apne paas diye gaye DATA ke alawa kuch mat banao. Mic par bolne wale user ko jawab sunayi deta hai, isliye chhota rakho. ' +
      'IMPORTANT: ye guardrail/instruction lines sirf policy ke liye hain — apne JAWAB me kabhi mat likho (na "paisa nikaalna" wali line, na "sirf trading engine" wali). ' +
      'DATA INTEGRITY: DATA me jo nahi hai wo kabhi assume ya invent mat karo — aisi jagah seedha bolo "iske liye mere paas sufficient market data nahi hai". ' +
      'ATR/SL buffer khud badalne ka suggestion mat do — sirf reason batao, fix ki suggestion ho to bolo user "SL fix karo" / "apply karo" bole tab lagegi. ' +
      'User ka open TF data.openTf me hai — zone/analysis/SL sawal us TF ke analysis + zones + completed data se hi jawab do.' +
      '\nMARKET INTELLIGENCE: DATA.marketIntel me live news/global/FII/calendar aata hai (source+time+status ke saath) — trading market sawal me sirf usi ko use karo; ' +
      'us me jo nahi hai wo mat banao. CONFIRMED data ko fact aur apni baat ko interpretation alag label se bolo.' +
      // user ki apni PDF (Trading In The Zone) ki knowledge — theory/pattern wale sawal isi se
      (knowAll
        ? '\n\nUSER KI PDF KI KNOWLEDGE (Trading In The Zone — zone formation, demand & supply, candle formation, trade score, entry/risk rules — ' +
          'zone/candle/formation wale SAWAL isi knowledge ke hisaab se Hinglish me jawab do):\n' +
          knowAll.slice(0, 16000)
        : '');
    const data = {
      data: {
        params: st.params,
        stats: st.stats,
        lastAI: st.aiDiag,
        fixes: currentFixes(),
        recent: st.results.slice(-6),
        openTf: ctx.openTf || '',
        analysis: ctx.analysis || null,
        completed: ctx.completed || null,
        journal: (st.journal || []).slice(-10),
        suggest: st.suggest || null,
        learn: st.learn || null,
        version: st.version,
        versions: (st.versions || []).slice(-3),
        validation: st.validation || null,
        caution: st.caution || null,
        rootCause: (st.rootCauses || []).slice(-2),
        rootCauseStats: st.rootCauseStats || {},
        marketSnapshot: st.snap ? { condition: st.snap.condition, trends: st.snap.trends, structure: st.snap.structure, summary: st.snap.structureSummary, dataOk: st.snap.dataOk } : null,
        slAnalysis: (st.slAnalysis || []).slice(-2),
        zones: (ctx.actives || []).filter(a => a && a.setup && a.setup.entry != null).map(a => ({
          tf: a.setup.zoneTF || a.tf, direction: a.setup.direction, entry: a.setup.entry,
          sl: a.setup.stopLoss, target: a.setup.target, status: a.setup.status
        })),
        openPos: (ctx.pos || []).length,
        cash: Math.round(ctx.cash || 0),
        netPnl: Math.round(ctx.netPnl || 0),
        marketIntel: (function () {
          try {
            if (!INTEL) return null;
            return { quick: INTEL.quick(), news: INTEL.newsList('market', 6).today };
          } catch (e) { return null; }
        })()
      }
    };
    const txt = await askGemini(sys + '\n\nDATA:\n' + JSON.stringify(data) + '\n\nSAWAL: ' + String(q || '').slice(0, 300),
      { temp: 0.45, maxTokens: 400, timeoutMs: 18000 });
    if (txt && txt.trim()) {
      st.llmCalls++;
      save();
      return { a: txt.trim().slice(0, 700), act: 'ai' };
    }
    return r;
  }

  try { updLearn(); } catch (e) {}   // load par hi learn stats ready (panel/chat ke liye)

  return { observe, review, canEnter, params, status, reply, replyAi, save, syncHistory, syncZones, suggest, applySuggest, updLearn, marketSnapshot, setEngine, setIntel, tune, logAutoTrade };
}

module.exports = createAiAgent;
