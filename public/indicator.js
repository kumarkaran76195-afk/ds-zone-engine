/* ============================================================
   DS ZONE ENGINE v1.0 — Core Trading Engine
   Demand & Supply Zone Detection + Auto Trade Setup
   ============================================================ */

const CandleEngine = {
  classify(c) {
    const h = c.high, l = c.low, o = c.open, cl = c.close;
    const rng = h - l;
    if (rng <= 0) return { ...c, color: 'neutral', bodyRatio: 0, isExciting: false, isBase: true, body: 0, range: 0 };
    const body = Math.abs(cl - o);
    const br = body / rng;
    const color = cl > o ? 'green' : cl < o ? 'red' : 'neutral';
    // PDF: Exciting/Explosive candle = body > 50% of range, Base candle = body < 50% of range
    return { ...c, color, bodyRatio: br, isExciting: br > 0.5, isBase: br < 0.5, body, range: rng };
  },
  classifyAll(arr) {
    const out = arr.map(c => this.classify(c));
    const avg = out.length ? out.reduce((s, c) => s + (c.body || 0), 0) / out.length : 0;
    // PDF page 4: Explosive candle = body > 50% range aur body average body se 1.5x
    for (const c of out) c.isExplosive = !!(c.isExciting && avg > 0 && c.body >= avg * 1.5);
    return out;
  }
};

const ATREngine = {
  calculate(candles, period = 14) {
    const n = candles.length, atr = Array(n).fill(null);
    if (n < period + 1) return atr;
    const tr = [0];
    for (let i = 1; i < n; i++) {
      tr.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close)));
    }
    let sum = 0; for (let i = 0; i < period; i++) sum += tr[i];
    atr[period - 1] = sum / period;
    for (let i = period; i < n; i++) atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
    return atr;
  }
};

const TrendEngine = {
  sma(closes, p = 50) {
    const n = closes.length, out = Array(n).fill(null);
    for (let i = p - 1; i < n; i++) {
      let s = 0; for (let j = i - p + 1; j <= i; j++) s += closes[j];
      out[i] = s / p;
    }
    return out;
  },
  analyze(closes, sma50, atrArr) {
    // PDF (How to look at trend): 50 SMA par current se 7 candle peeche intersection,
    // clock 12-3 = up, 3-6 = down, 3 ke paas = sideways
    const n = closes.length;
    if (n < 15) return { trend: 'sideways', smaVal: null, clock: '3' };
    let s = sma50;
    if (!s || s[n - 1] == null) {
      const p = Math.max(10, Math.min(50, Math.floor(n / 2)));
      s = this.sma(closes, p);
    }
    if (!s || s[n - 1] == null) return { trend: 'sideways', smaVal: null, clock: '3' };
    const sv = s[n - 1];
    let first = -1;
    for (let i = 0; i < n; i++) if (s[i] != null) { first = i; break; }
    if (first < 0) return { trend: 'sideways', smaVal: null, clock: '3' };
    const look = Math.min(7, n - 1 - first);
    if (look < 3) return { trend: 'sideways', smaVal: sv, clock: '3' };
    const ref = s[n - 1 - look];
    const slope = (sv - ref) / look;
    const atr = atrArr ? atrArr[n - 1] : null;
    const thr = (atr && atr > 0) ? atr * 0.05 : Math.abs(sv) * 0.0001;
    const rising = slope > thr, falling = slope < -thr;
    const above = closes[n - 1] > sv, below = closes[n - 1] < sv;
    let trend = 'sideways', clock = '3';
    if (rising) { trend = 'up'; clock = '12-3'; }
    else if (falling) { trend = 'down'; clock = '3-6'; }
    return { trend, clock, smaVal: sv, refSma: ref, slope, rising, falling, above, below };
  }
};

const ZoneEngine = {
  getBase(candles, legoutIdx) {
    const bases = [];
    let i = legoutIdx - 1;
    while (i >= 0 && bases.length < 5) {
      if (candles[i].isBase) { bases.unshift(i); i--; }
      else break;
    }
    return bases;
  },

  detectPattern(candles, base) {
    if (!base.length) return null;
    const leginIdx = base[0] - 1;
    const legoutIdx = base[base.length - 1] + 1;
    if (leginIdx < 0 || legoutIdx >= candles.length) return null;
    const legin = candles[leginIdx], legout = candles[legoutIdx];
    const demand = legout.color === 'green';
    const supply = legout.color === 'red';
    if (!demand && !supply) return null;
    // PDF: legout explosive hona chahiye (exciting candle ya base ke paar gap)
    const baseHigh = Math.max(...base.map(i => candles[i].high));
    const baseLow = Math.min(...base.map(i => candles[i].low));
    const explosive = legout.isExciting || (demand ? legout.open >= baseHigh : legout.open <= baseLow);
    if (!explosive) return null;
    // PDF: closing concept — demand me legout legin ke upar close, supply me neeche
    if (demand && legout.close <= legin.close) return null;
    if (supply && legout.close >= legin.close) return null;
    if (demand && legin.color === 'red') return 'DBR';
    if (demand && legin.color === 'green') return 'RBR';
    if (supply && legin.color === 'green') return 'RBD';
    if (supply && legin.color === 'red') return 'DBD';
    return null;
  },

  createDemand(candles, base, pattern) {
    if (!base.length) return null;
    const legoutIdx = base[base.length - 1] + 1;
    if (legoutIdx >= candles.length) return null;
    const lo = candles[legoutIdx];
    const leginIdx = base[0] - 1;
    const legin = leginIdx >= 0 ? candles[leginIdx] : null;
    const proximal = Math.max(...base.map(i => Math.max(candles[i].open, candles[i].close)));
    let distal = Math.min(...base.map(i => candles[i].low));
    // PDF page 18-19: exceptional marking — reversal (DBR) me legin ka lowest wick,
    // continuous (RBR) me legout ka lowest wick (sirf tab lagao jab zone wider bane)
    const reversal = pattern === 'DBR';
    const exVal = reversal ? (legin ? legin.low : distal) : lo.low;
    let marking = 'NORMAL';
    if (exVal < distal) { distal = exVal; marking = 'EXCEPTIONAL'; }
    if (proximal <= distal) return null;
    const baseHigh = Math.max(...base.map(i => candles[i].high));
    const avgRange = base.reduce((s, i) => s + candles[i].range, 0) / base.length;
    return { type: 'demand', pattern, baseCount: base.length, proximal, distal, legoutIdx, legout: lo,
      legin, leginIdx, gapOut: lo.open >= baseHigh, marking, authentic: true,
      avgBaseRange: avgRange, zoneTime: candles[base[0]].time };
  },

  createSupply(candles, base, pattern) {
    if (!base.length) return null;
    const legoutIdx = base[base.length - 1] + 1;
    if (legoutIdx >= candles.length) return null;
    const lo = candles[legoutIdx];
    const leginIdx = base[0] - 1;
    const legin = leginIdx >= 0 ? candles[leginIdx] : null;
    const proximal = Math.min(...base.map(i => Math.min(candles[i].open, candles[i].close)));
    let distal = Math.max(...base.map(i => candles[i].high));
    // PDF page 20-21: exceptional marking — reversal (RBD) me legin ka highest wick,
    // continuous (DBD) me legout ka highest wick
    const reversal = pattern === 'RBD';
    const exVal = reversal ? (legin ? legin.high : distal) : lo.high;
    let marking = 'NORMAL';
    if (exVal > distal) { distal = exVal; marking = 'EXCEPTIONAL'; }
    if (distal <= proximal) return null;
    const baseLow = Math.min(...base.map(i => candles[i].low));
    const avgRange = base.reduce((s, i) => s + candles[i].range, 0) / base.length;
    return { type: 'supply', pattern, baseCount: base.length, proximal, distal, legoutIdx, legout: lo,
      legin, leginIdx, gapOut: lo.open <= baseLow, marking, authentic: true,
      avgBaseRange: avgRange, zoneTime: candles[base[0]].time };
  },

  detect(candles, trendDir) {
    const zones = [];
    // TREND FILTER: UP me sirf BUY (demand) zone, DOWN me sirf SELL (supply) zone, sideways me dono
    const wantDemand = trendDir !== 'down';
    const wantSupply = trendDir !== 'up';
    // last candle = live legout — zone turant bane, 1 candle wait nahi
    for (let i = 2; i < candles.length; i++) {
      const base = this.getBase(candles, i);
      if (!base.length) continue;
      const pattern = this.detectPattern(candles, base);
      if (!pattern) continue;
      let z = null;
      if (['DBR', 'RBR'].includes(pattern)) z = this.createDemand(candles, base, pattern);
      else z = this.createSupply(candles, base, pattern);
      if (!z) continue;
      if (z.type === 'demand' && !wantDemand) continue;   // downtrend me buy zone NA bane
      if (z.type === 'supply' && !wantSupply) continue;   // uptrend me sell zone NA bane
      z.index = i; zones.push(z);
    }
    this.markAuthenticity(zones, candles);
    return zones;
  },

  markAuthenticity(zones, candles) {
    // PDF page 35 (Credibility):
    // Case 1 — zone agar pehle ke zone ka reaction ho to Non-Authentic (non-tradeable)
    // Case 4 — non-authentic ho lekin closing bahut strong ho to phir bhi tradable
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      z.authentic = true;
      const legin = z.leginIdx >= 0 ? candles[z.leginIdx] : null;
      if (!legin) continue;
      for (let j = 0; j < i; j++) {
        const p = zones[j];
        if (p.legoutIdx > z.leginIdx) continue;
        if (z.leginIdx - p.legoutIdx > 5) continue;          // reaction turant hona chahiye
        const pLo = Math.min(p.proximal, p.distal), pHi = Math.max(p.proximal, p.distal);
        if (legin.low <= pHi && legin.high >= pLo) {
          z.authentic = false;
          z.authenticReason = 'previous zone ka reaction (non-authentic)';
          break;
        }
      }
      if (!z.authentic && (z.gapOut || (z.legout && z.legout.isExplosive))) {
        z.authentic = true;                                   // Case 4: good closing
        z.authenticNote = 'non-authentic lekin strong closing (case 4)';
      }
    }
  },

  markFreshness(zones, candles) {
    for (const z of zones) {
      let touchCount = 0;
      for (let i = z.legoutIdx + 1; i < candles.length; i++) {
        if (z.type === 'demand' && candles[i].low <= z.proximal) touchCount++;
        if (z.type === 'supply' && candles[i].high >= z.proximal) touchCount++;
      }
      z.fresh = touchCount === 0;
      z.tested = touchCount;
      // PDF: strength = base candles ki sankhya + legout ki power (page 22)
      const bc = z.baseCount || 1;
      const legoutPower = z.legout ? z.legout.body / (z.avgBaseRange || 1) : 0;
      if (bc <= 3 && (z.gapOut || legoutPower >= 1.5)) z.strength = 'VERY_STRONG';
      else if (bc <= 3) z.strength = 'STRONG';
      else if (bc <= 5 && (z.gapOut || legoutPower >= 1.5)) z.strength = 'STRONG';
      else if (bc <= 5) z.strength = 'NORMAL';
      else z.strength = 'WEAK';
      if (!z.fresh && touchCount >= 2 && z.strength === 'VERY_STRONG') z.strength = 'STRONG';
    }
  }
};

const TradeScorer = {
  MIN_SCORE: 5,
  MAX_SCORE: 11,
  // PDF (Trade Score page): level chhodne ki power + freshness + base candles + trend + CMP proximity
  score(z, trend, price, currentAtr, loc) {
    let s = 0;
    if (z.gapOut) s += 3;                                   // price level chhoda gap ke saath
    else if (z.legout && z.legout.isExciting) s += 2;       // 2/1 exciting candle leave
    else s += 1;
    if (z.fresh) s += 2; else if (z.tested <= 1) s += 1;    // fresh / tested once / twice+
    const bc = z.baseCount || 1;
    s += bc <= 3 ? 3 : bc <= 5 ? 2 : 1;                     // 1-3 base = best
    // PDF: trend/curve se aligned +, against − (block nahi, sirf score)
    if (trend) {
      if (z.type === 'demand' && trend.trend === 'up') s += 1;
      else if (z.type === 'supply' && trend.trend === 'down') s += 1;
      else if (trend.trend === 'sideways') s -= 1;
      else s -= 2;
    }
    if (loc && ((loc.action === 'BUY' && z.type === 'supply') || (loc.action === 'SELL' && z.type === 'demand'))) s -= 2;
    if (price && currentAtr > 0) {
      const r = Math.abs(z.proximal - price) / currentAtr;
      if (r < 0.5) s += 2; else if (r < 1) s += 1;
    }
    // PDF note: score 7 -> entry type 1, 5-6 -> type 2/3, <5 -> no trade
    const entryType = s >= 7 ? 1 : s >= 6 ? 2 : 3;
    return { score: s, entryType, maxScore: this.MAX_SCORE, tradeable: s >= this.MIN_SCORE };
  },
  entryRule(t) {
    if (t === 1) return 'Type 1 — entry bas proximal line ke just upar/neeche (score 7)';
    if (t === 2) return 'Type 2 — 1st candle zone me close + 2nd candle zone me open (score 5-6)';
    return 'Type 3 — 1st candle zone me close + 2nd candle zone chhode (confirmation)';
  }
};

const RiskManager = {
  target(entry, sl, isBuy) { const r = Math.abs(entry - sl); return isBuy ? entry + r * 2 : entry - r * 2; },
  rr(entry, sl, tgt) { const r = Math.abs(entry - sl), w = Math.abs(tgt - entry); return r > 0 ? w / r : 0; },
  calc(capital, pct, entry, sl) {
    const rpu = Math.abs(entry - sl); if (rpu <= 0) return null;
    const ra = capital * (pct / 100), qty = Math.floor(ra / rpu);
    return { riskPerUnit: rpu, riskAmount: ra, quantity: qty, riskPercent: pct, capital };
  }
};

// PDF: Curve / Location analysis — nearest fresh supply & demand ke beech price ki position
const CurveEngine = {
  analyze(cls, price, trendDir) {
    if (!cls || cls.length < 5 || !price) return null;
    const zones = ZoneEngine.detect(cls, trendDir);
    ZoneEngine.markFreshness(zones, cls);
    const fresh = zones.filter(z => z.fresh);
    const sup = fresh.filter(z => z.type === 'supply' && z.proximal >= price)
      .sort((a, b) => a.proximal - b.proximal)[0];
    const dem = fresh.filter(z => z.type === 'demand' && z.proximal <= price)
      .sort((a, b) => b.proximal - a.proximal)[0];
    if (!sup || !dem) return { pos: 'N/A', pct: null, action: 'WAIT', supply: sup || null, demand: dem || null };
    const span = sup.proximal - dem.proximal;
    if (span <= 0) return { pos: 'N/A', pct: null, action: 'WAIT', supply: sup, demand: dem };
    const pct = Math.max(0, Math.min(1, (price - dem.proximal) / span));
    let pos, action;
    if (pct >= 2 / 3) { pos = 'HIGH ON CURVE'; action = 'SELL'; }
    else if (pct <= 1 / 3) { pos = 'LOW ON CURVE'; action = 'BUY'; }
    else { pos = 'EQUILIBRIUM'; action = 'TREND'; }
    return { pos, pct: Math.round(pct * 100), action, supply: sup, demand: dem };
  }
};

class DSEngine {
  constructor() {
    this.activeByTF = {};
    this.zonesByTF = {};
    this.allZonesByTF = {};
    this.completedByTF = {};
    this.capital = 100000;
    this.riskPct = 1;
    this.maxTradesPerMonth = 10;
    this.history = this._loadHistory();
    this.usedZones = this._loadUsedZones();
    this._nearbyNote = null;
  }
  setAccount(c, p) { this.capital = c; this.riskPct = p; }

  _effTrend(trend, regime) {
    if (trend && trend.trend && trend.trend !== 'sideways') return trend;
    if (regime && regime !== 'sideways') return { trend: regime, smaVal: trend ? trend.smaVal : null, viaRegime: true };
    return trend || { trend: 'sideways', smaVal: null };
  }

  _loadUsedZones() {
    try {
      const raw = JSON.parse(localStorage.getItem('ds_used_zones') || '{}');
      const now = Date.now(), out = {};
      for (const k of Object.keys(raw)) {
        if (now - (raw[k] || 0) < 7 * 86400000) out[k] = raw[k];
      }
      const keys = Object.keys(out);
      if (keys.length > 300) {
        keys.sort((a, b) => out[b] - out[a]);
        const trimmed = {};
        for (const k of keys.slice(0, 300)) trimmed[k] = out[k];
        return trimmed;
      }
      return out;
    } catch { return {}; }
  }
  _saveUsedZones() {
    try {
      const now = Date.now();
      const keys = Object.keys(this.usedZones);
      if (keys.length > 300) {
        keys.sort((a, b) => this.usedZones[b] - this.usedZones[a]);
        const t = {};
        for (const k of keys.slice(0, 300)) t[k] = this.usedZones[k];
        this.usedZones = t;
      }
      for (const k of Object.keys(this.usedZones)) {
        if (now - (this.usedZones[k] || 0) >= 7 * 86400000) delete this.usedZones[k];
      }
      localStorage.setItem('ds_used_zones', JSON.stringify(this.usedZones));
    } catch {}
  }
  _zoneKey(z) {
    return (z.type || z.zoneType) + '|' + Math.round(z.proximal * 10) / 10 + '|' + Math.round(z.distal * 10) / 10 + '|' + z.zoneTime;
  }
  _markZoneUsed(z) {
    const k = this._zoneKey(z);
    if (this.usedZones[k]) return false;
    this.usedZones[k] = Date.now();
    return true;
  }

  _loadHistory() {
    try { return JSON.parse(localStorage.getItem('ds_history') || '[]'); } catch { return []; }
  }
  _saveHistory() { try { localStorage.setItem('ds_history', JSON.stringify(this.history)); } catch {} }

  _recordHit(tf, setup, status) {
    if (setup.zoneType && setup.zoneTime != null) {
      this._markZoneUsed({ zoneType: setup.zoneType, proximal: setup.proximal, distal: setup.distal, zoneTime: setup.zoneTime });
      this._saveUsedZones();
    }
    const now = new Date();
    const dateKey = now.toISOString().slice(0, 10);
    const timeStr = now.toLocaleTimeString('en-IN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    this.history.push({
      date: dateKey, time: timeStr, tf, direction: setup.direction,
      pattern: setup.pattern, entry: setup.entry, stopLoss: setup.stopLoss,
      target: setup.target, status, price: setup.price,
      pnl: setup.pnl ? setup.pnl.toFixed(1) : '0'
    });
    this._saveHistory();
    if (!this.completedByTF[tf]) this.completedByTF[tf] = [];
    this.completedByTF[tf].push({ ...setup, hitStatus: status, hitTime: timeStr });
    if (this.completedByTF[tf].length > 20) this.completedByTF[tf].shift();
  }

  getDailyHistory() {
    const daily = {};
    for (const h of this.history) {
      if (!daily[h.date]) daily[h.date] = { targets: 0, sls: 0, invalids: 0, total: 0, trades: [] };
      daily[h.date].trades.push(h);
      daily[h.date].total++;
      if (h.status === 'TARGET_HIT') daily[h.date].targets++;
      else if (h.status === 'STOP_LOSS_HIT') daily[h.date].sls++;
      else if (h.status === 'INVALIDATED') daily[h.date].invalids++;
    }
    return daily;
  }

  _findNearbyZones(tf, cls, price, currentAtr, trend, maxAtrDist, ignoreTrend) {
    this._nearbyNote = null;
    const trendDir = trend ? trend.trend : 'sideways';
    const zones = ZoneEngine.detect(cls, trendDir);
    ZoneEngine.markFreshness(zones, cls);
    let testedCount = 0, nonAuthCount = 0, usedCount = 0;
    const valid = [];
    for (const z of zones) {
      if (this.usedZones[this._zoneKey(z)]) { usedCount++; continue; }
      if (z.authentic === false) { nonAuthCount++; continue; }   // PDF: non-authentic = non-tradeable
      if (z.tested > 2) { testedCount++; continue; }             // PDF: 2 se zyada test = weak, skip
      valid.push(z);                                             // fresh + tested once/twice chalte hain (score me fark)
    }

    // chart/panel ke liye: saare usable zones (fresh + tested <=2), koi aur filter nahi
    const allUsable = zones.filter(z => z.tested <= 2)
      .sort((a, b) => b.zoneTime - a.zoneTime).slice(0, 40);
    this.allZonesByTF[tf] = allUsable;

    // TREND FILTER: UP me sirf BUY zone, DOWN me sirf SELL zone banega, sideways me dono
    if (trendDir === 'up') this._nearbyNote = 'Uptrend — sirf BUY (demand) zone banega';
    else if (trendDir === 'down') this._nearbyNote = 'Downtrend — sirf SELL (supply) zone banega';
    else if (trendDir === 'sideways') this._nearbyNote = 'Sideways — score me penalty lagega';
    if (!valid.length) {
      if (nonAuthCount && !usedCount && !testedCount) this._nearbyNote = 'WAIT — Non-authentic zone mile, non-tradeable (PDF)';
      else if (testedCount && !usedCount) this._nearbyNote = 'WAIT — Zone 2 se zyada test ho chuka hai';
      else if (usedCount) this._nearbyNote = 'WAIT — Zone pehle use ho chuka hai, naye zone ka wait';
      else if (trendDir === 'up') this._nearbyNote = 'WAIT — Uptrend: koi BUY zone nahi bana';
      else if (trendDir === 'down') this._nearbyNote = 'WAIT — Downtrend: koi SELL zone nahi bana';
      else this._nearbyNote = 'WAIT — Koi zone nahi mila';
      return [];
    }

    const trendFiltered = valid;
    trendFiltered.forEach(z => { z.tradeScore = TradeScorer.score(z, ignoreTrend ? null : trend, price, currentAtr, ignoreTrend ? null : this._location); });
    // sort: score desc, tabhi fresh zone ko pehle mauka (PDF: fresh zone hi lena hai)
    trendFiltered.sort((a, b) => (b.tradeScore.score - a.tradeScore.score) || ((b.fresh ? 1 : 0) - (a.fresh ? 1 : 0)));
    const nearby = [];
    let farCount = 0;
    for (const z of trendFiltered) {
      const dist = Math.abs(z.proximal - price);
      if (maxAtrDist > 0 && dist > currentAtr * maxAtrDist) { farCount++; continue; }
      nearby.push(z);
      if (nearby.length >= 10) break;
    }
    if (!nearby.length && farCount) this._nearbyNote = 'WAIT — Zone ' + maxAtrDist + ' ATR se door, market aage nikal chuki';
    return nearby;
  }

  analyze(ltf1, ltf3, ltf5, itf15, itf30, price, selectedTF) {
    if (ltf3.length < 5) {
      return { status: 'NO_SETUP', reason: `Need ${5 - ltf3.length} more 3m candles`, price };
    }

    const c1 = CandleEngine.classifyAll(ltf1), c3 = CandleEngine.classifyAll(ltf3);
    const c5 = CandleEngine.classifyAll(ltf5), c15 = CandleEngine.classifyAll(itf15);
    const c30 = CandleEngine.classifyAll(itf30);

    const cl1 = c1.map(c => c.close), cl3 = c3.map(c => c.close);
    const cl5 = c5.map(c => c.close), cl15 = c15.map(c => c.close), cl30 = c30.map(c => c.close);

    const s1 = TrendEngine.sma(cl1), s3 = TrendEngine.sma(cl3);
    const s5 = TrendEngine.sma(cl5), s15 = TrendEngine.sma(cl15), s30 = TrendEngine.sma(cl30);

    const atrMap = {
      '1m': ATREngine.calculate(c1), '3m': ATREngine.calculate(c3),
      '5m': ATREngine.calculate(c5), '15m': ATREngine.calculate(c15),
      '30m': ATREngine.calculate(c30)
    };

    const t1 = TrendEngine.analyze(cl1, s1, atrMap['1m']), t3 = TrendEngine.analyze(cl3, s3, atrMap['3m']);
    const t5 = TrendEngine.analyze(cl5, s5, atrMap['5m']), t15 = TrendEngine.analyze(cl15, s15, atrMap['15m']);
    const t30 = TrendEngine.analyze(cl30, s30, atrMap['30m']);

    let regime = 'sideways';
    if (t30.trend !== 'sideways') regime = t30.trend;
    else if (t15.trend !== 'sideways') regime = t15.trend;

    const tfList = [
      { cls: c1, raw: ltf1, tf: '1m', trend: t1, atr: atrMap['1m'] },
      { cls: c3, raw: ltf3, tf: '3m', trend: t3, atr: atrMap['3m'] },
      { cls: c5, raw: ltf5, tf: '5m', trend: t5, atr: atrMap['5m'] },
      { cls: c15, raw: itf15, tf: '15m', trend: t15, atr: atrMap['15m'] },
      { cls: c30, raw: itf30, tf: '30m', trend: t30, atr: atrMap['30m'] }
    ];

    const locs = [CurveEngine.analyze(c30, price, t30.trend), CurveEngine.analyze(c15, price, t15.trend), CurveEngine.analyze(c5, price, t5.trend)];
    this._location = locs.find(l => l && l.pos !== 'N/A') || locs[0] || null;

    const allResults = {};

    for (const { cls, raw, tf, trend, atr } of tfList) {
      if (cls.length < 3) continue;

      const eff = this._effTrend(trend, regime);
      this._findNearbyZones(tf, cls, price, atr[atr.length - 1] || 1, eff, 10);
      const existing = this.activeByTF[tf];
      if (existing && this._isActive(existing)) {
        // UP me SELL bhi chalega (neeche aa sakti hai), DOWN me BUY bhi (upar ja sakti hai) — PDF pullback
        this._track(existing, price);
        if (!this._isActive(existing)) {
          this._recordHit(tf, existing, existing.status);
          this.activeByTF[tf] = null;
          this._findNextZone(tf, cls, price, atr, eff, allResults);
          continue;
        } else {
          allResults[tf] = this._buildResult(existing, price, eff, atr);
          continue;
        }
      }
      if (existing && !this._isActive(existing)) this.activeByTF[tf] = null;
      this._findNextZone(tf, cls, price, atr, eff, allResults);
    }

    const sel = selectedTF || '5m';
    const result = allResults[sel] || this._noResult(sel, 'No data', price, t1, atrMap['1m']);
    result.allTF = allResults;
    result.regime = regime;
    result.zonesByTF = this.zonesByTF;
    result.allZonesByTF = this.allZonesByTF;
    result.t1 = t1; result.t3 = t3; result.t5 = t5; result.t15 = t15; result.t30 = t30;
    result.location = this._location;
    result.dailyHistory = this.getDailyHistory();
    result.completedByTF = this.completedByTF;
    return result;
  }

  // candidate me se best tradeable advance zone chuno (PDF: fresh > tested, score >=5, R:R ok)
  _pickZone(zones, price, currentAtr, opts) {
    opts = opts || {};
    const minScore = opts.minScore || 5;
    const allowStale = !!opts.allowStale;
    const entryBuffer = currentAtr * 0.02, slBuffer = currentAtr * 0.05;
    const entryNear = currentAtr * 0.1;
    const out = { best: null, entry: 0, sl: 0, tgt: 0, rr: 0, entryNear, lowScore: 0, staleCount: 0, behindCount: 0 };
    for (const z of zones) {
      if (!z.tradeScore) continue;
      if (z.tradeScore.score < minScore) { out.lowScore = Math.max(out.lowScore, z.tradeScore.score); continue; }
      const isBuyZ = z.type === 'demand';
      const e = isBuyZ ? z.proximal + entryBuffer : z.proximal - entryBuffer;
      const l = isBuyZ ? z.distal - slBuffer : z.distal + slBuffer;
      const t = RiskManager.target(e, l, isBuyZ);
      const r = RiskManager.rr(e, l, t);
      if (r < 1) continue;
      if (!allowStale && (isBuyZ ? price >= t : price <= t)) { out.staleCount++; continue; }   // market already target paar
      // ADVANCE zone: entry market ke AAGE — BUY me entry LTP se neeche (retest pending), SELL me upar
      if (isBuyZ ? price < e : price > e) { out.behindCount++; continue; }
      out.best = z; out.entry = e; out.sl = l; out.tgt = t; out.rr = r;
      out.stale = allowStale && (isBuyZ ? price >= t : price <= t);
      break;
    }
    return out;
  }

  _findNextZone(tf, cls, price, atr, trend, allResults) {
    const currentAtr = atr[atr.length - 1] || 1;
    // PDF page 37: max 10 trades/month — limit par setup/BUY-SELL dikhate hain, sirf warning flag
    const monthLimitReached = this._monthTrades() >= this.maxTradesPerMonth;

    // pass A: 3 ATR + poora score; B: 7 ATR; C: 7 ATR trend/curve penalty ke bina; D: last-resort (stale zone bhi chalega)
    let pick = { best: null }, lastZones = [], lastNote = null;
    const passes = [
      { d: 3, ignore: false, opts: {} },
      { d: 7, ignore: false, opts: {} },
      { d: 7, ignore: true, opts: {} },
      { d: 7, ignore: true, opts: { allowStale: true } }
    ];
    for (const p of passes) {
      const zs = this._findNearbyZones(tf, cls, price, currentAtr, trend, p.d, p.ignore);
      // TREND RULE: UP me sirf BUY (demand) zone, DOWN me sirf SELL (supply) zone
      lastZones = zs; lastNote = this._nearbyNote;
      if (!zs.length) continue;
      const pk = this._pickZone(zs, price, currentAtr, p.opts);
      if (pk.best) { pick = pk; this.zonesByTF[tf] = zs; break; }
      if (!pick.best && (pk.staleCount > (pick.staleCount || 0) || pk.lowScore > (pick.lowScore || 0))) pick = pk;
    }
    this.zonesByTF[tf] = this.zonesByTF[tf] && this.zonesByTF[tf].length ? this.zonesByTF[tf] : lastZones;

    if (!pick.best) {
      const reason = !lastZones.length && lastNote
        ? (/^WAIT/.test(lastNote) ? lastNote : 'WAIT — ' + lastNote)
        : pick.staleCount
        ? 'Market target paar kar chuki — advance zone ka wait'
        : pick.behindCount
        ? 'Zone entry cross kar chuka — advance zone ka wait'
        : 'Trade Score ' + (pick.lowScore || 0) + ' < 5 — naya fresh zone ka wait';
      allResults[tf] = this._noResult(tf, reason, price, trend, atr);
      return;
    }
    const { best, entry, sl, tgt, rr, entryNear } = pick;
    const isBuy = best.type === 'demand';
    const risk = RiskManager.calc(this.capital, this.riskPct, entry, sl);

    const setup = {
      direction: isBuy ? 'BUY' : 'SELL', zoneType: best.type, pattern: best.pattern,
      entry, stopLoss: sl, target: tgt, riskReward: rr, risk,
      proximal: best.proximal, distal: best.distal,
      zoneTF: tf, zoneScore: best.tradeScore.score, maxScore: best.tradeScore.maxScore,
      entryType: best.tradeScore.entryType, entryRule: TradeScorer.entryRule(best.tradeScore.entryType),
      zoneStrength: best.strength, zoneFreshness: best.fresh ? 'fresh' : 'tested',
      marking: best.marking || 'NORMAL', authentic: best.authentic !== false,
      baseCount: best.baseCount, status: 'WAITING', armed: false, price,
      monthLimit: monthLimitReached, staleTarget: !!pick.stale,
      entryNear, zoneDist: Math.abs(price - best.proximal), pnl: 0, createdAt: Date.now(),
      zoneTime: best.zoneTime
    };
    this.activeByTF[tf] = setup;
    allResults[tf] = this._buildResult(setup, price, trend, atr);
  }

  _track(s, p) {
    const isBuy = s.direction === 'BUY';
    // PDF (Trade Setup/Entry types): entry tab tak arm nahi jab tak price khud zone ke andar na aa jaye
    if (!s.armed && (isBuy ? p <= s.proximal : p >= s.proximal)) {
      s.armed = true;
      if (s.status === 'WAITING') s.status = 'ARMED';
    }
    // market entry ke pass aaya → ENTRY likh do (0.1 ATR andar): BUY me neeche se, SELL me upar se
    const near = s.entryNear != null ? s.entryNear : Math.abs(s.entry - s.stopLoss) * 0.08;
    const nearEntry = isBuy ? p <= s.entry + near : p >= s.entry - near;
    if (nearEntry && (s.status === 'WAITING' || s.status === 'ARMED')) s.status = 'ENTRY_TRIGGERED';
    if (isBuy) {
      if (p >= s.target) s.status = 'TARGET_HIT';
      else if (p <= s.stopLoss) s.status = 'STOP_LOSS_HIT';
      else if (p <= s.distal) s.status = 'INVALIDATED';
      else if (s.armed && p >= s.entry && (s.status === 'WAITING' || s.status === 'ARMED')) s.status = 'ENTRY_TRIGGERED';
    } else {
      if (p <= s.target) s.status = 'TARGET_HIT';
      else if (p >= s.stopLoss) s.status = 'STOP_LOSS_HIT';
      else if (p >= s.distal) s.status = 'INVALIDATED';
      else if (s.armed && p <= s.entry && (s.status === 'WAITING' || s.status === 'ARMED')) s.status = 'ENTRY_TRIGGERED';
    }
    s.price = p; s.zoneDist = Math.abs(p - s.proximal);
    s.pnl = isBuy ? p - s.entry : s.entry - p;
  }

  _monthTrades() {
    const key = new Date().toISOString().slice(0, 7);
    let c = 0;
    for (const h of this.history) {
      if (h.date && h.date.slice(0, 7) === key && (h.status === 'TARGET_HIT' || h.status === 'STOP_LOSS_HIT')) c++;
    }
    return c;
  }

  trackTick(ltp) {
    if (!ltp || ltp <= 0) return false;
    let zoneChanged = false;
    for (const tf of Object.keys(this.activeByTF)) {
      const existing = this.activeByTF[tf];
      if (!existing || !this._isActive(existing)) continue;
      this._track(existing, ltp);
      if (!this._isActive(existing)) {
        this._recordHit(tf, existing, existing.status);
        this.activeByTF[tf] = null;
        zoneChanged = true;
      }
    }
    return zoneChanged;
  }

  _isActive(s) { return s && s.status !== 'TARGET_HIT' && s.status !== 'STOP_LOSS_HIT' && s.status !== 'INVALIDATED'; }

  _zoneStats(tf) {
    const zs = this.allZonesByTF[tf] || [];
    return { count: zs.length, fresh: zs.filter(z => z.fresh).length, list: zs };
  }

  _noResult(tf, reason, price, trend, atr) {
    const st = this._zoneStats(tf);
    return { status: 'NO_SETUP', reason, price, trend, sma50: trend ? trend.smaVal : null,
      atr: atr ? atr[atr.length - 1] : null, activeSetup: null, tf, nearbyZones: [],
      allFreshZones: st.count, freshCount: st.fresh, freshZones: st.list };
  }

  _buildResult(s, price, trend, atr) {
    const st = this._zoneStats(s.zoneTF);
    return { status: s.status, price, trend, sma50: trend ? trend.smaVal : null,
      atr: atr ? atr[atr.length - 1] : null, activeSetup: s, tf: s.zoneTF,
      nearbyZones: this.zonesByTF[s.zoneTF] || [],
      allFreshZones: st.count, freshCount: st.fresh, freshZones: st.list };
  }
}
