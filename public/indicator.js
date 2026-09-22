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
    return { ...c, color, bodyRatio: br, isExciting: br > 0.12, isBase: br < 0.6, body, range: rng };
  },
  classifyAll(arr) { return arr.map(c => this.classify(c)); }
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
  analyze(closes, sma50) {
    const n = closes.length;
    if (n < 20) return { trend: 'sideways', smaVal: null };
    const sv = sma50[n - 1], pv = sma50[Math.max(0, n - 8)];
    if (sv === null || pv === null) return { trend: 'sideways', smaVal: sv };
    const rising = sv > pv, falling = sv < pv;
    const above = closes[n - 1] > sv, below = closes[n - 1] < sv;
    let trend = 'sideways';
    if (above && rising) trend = 'up';
    else if (below && falling) trend = 'down';
    return { trend, smaVal: sv, rising, falling };
  }
};

const ZoneEngine = {
  getBase(candles, legoutIdx) {
    const bases = [];
    let i = legoutIdx - 1;
    while (i >= 0 && bases.length < 5) {
      if (candles[i].isBase || Math.abs(candles[i].body) < (candles[i].range * 0.4)) {
        bases.unshift(i); i--;
      } else break;
    }
    return bases;
  },

  detectPattern(candles, base) {
    if (!base.length) return null;
    const leginIdx = base[0] - 1;
    const legoutIdx = base[base.length - 1] + 1;
    if (leginIdx < 0 || legoutIdx >= candles.length) return null;
    const legin = candles[leginIdx], legout = candles[legoutIdx];
    if (legout.color === 'green' && legin.color === 'red') return 'DBR';
    if (legout.color === 'green' && legin.color === 'green') return 'RBR';
    if (legout.color === 'red' && legin.color === 'green') return 'RBD';
    if (legout.color === 'red' && legin.color === 'red') return 'DBD';
    return null;
  },

  createDemand(candles, base, pattern) {
    if (!base.length) return null;
    const legoutIdx = base[base.length - 1] + 1;
    if (legoutIdx >= candles.length) return null;
    const lo = candles[legoutIdx];
    const proximal = Math.max(...base.map(i => Math.max(candles[i].open, candles[i].close)));
    const distal = Math.min(...base.map(i => candles[i].low));
    if (proximal <= distal) return null;
    return { type: 'demand', pattern, baseCount: base.length, proximal, distal, legoutIdx, legout: lo, zoneTime: candles[base[0]].time };
  },

  createSupply(candles, base, pattern) {
    if (!base.length) return null;
    const legoutIdx = base[base.length - 1] + 1;
    if (legoutIdx >= candles.length) return null;
    const lo = candles[legoutIdx];
    const proximal = Math.min(...base.map(i => Math.min(candles[i].open, candles[i].close)));
    const distal = Math.max(...base.map(i => candles[i].high));
    if (distal <= proximal) return null;
    return { type: 'supply', pattern, baseCount: base.length, proximal, distal, legoutIdx, legout: lo, zoneTime: candles[base[0]].time };
  },

  detect(candles) {
    const zones = [];
    for (let i = 2; i < candles.length - 1; i++) {
      const base = this.getBase(candles, i);
      if (!base.length) continue;
      const pattern = this.detectPattern(candles, base);
      if (!pattern) continue;
      let z = null;
      if (['DBR', 'RBR'].includes(pattern)) z = this.createDemand(candles, base, pattern);
      else z = this.createSupply(candles, base, pattern);
      if (z) { z.index = i; zones.push(z); }
    }
    return zones;
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
      z.strength = touchCount === 0 ? 'STRONG' : touchCount <= 1 ? 'NORMAL' : 'WEAK';
    }
  }
};

const TradeScorer = {
  score(z, trend, price, currentAtr) {
    let s = 0;
    if (z.legout && z.legout.isExciting) s += 3;
    const bc = z.baseCount || 1;
    if (bc <= 2) s += 2; else if (bc <= 4) s += 1;
    if (trend) {
      if (z.type === 'demand' && trend.trend === 'up') s += 2;
      else if (z.type === 'supply' && trend.trend === 'down') s += 2;
      else if (trend.trend === 'sideways') s += 1;
    }
    if (price && currentAtr > 0) {
      const dist = Math.abs(z.proximal - price);
      const atrRatio = dist / currentAtr;
      if (atrRatio < 0.3) s += 4;
      else if (atrRatio < 0.6) s += 3;
      else if (atrRatio < 1) s += 2;
      else if (atrRatio < 1.5) s += 1;
    }
    if (z.fresh) s += 2; else if (z.tested <= 1) s += 1;
    s += 1;
    return { score: s, entryType: s >= 9 ? 1 : s >= 7 ? 2 : 3, maxScore: 14 };
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

class DSEngine {
  constructor() {
    this.activeByTF = {};
    this.zonesByTF = {};
    this.completedByTF = {};
    this.capital = 100000;
    this.riskPct = 1;
    this.history = this._loadHistory();
  }
  setAccount(c, p) { this.capital = c; this.riskPct = p; }

  _loadHistory() {
    try { return JSON.parse(localStorage.getItem('ds_history') || '[]'); } catch { return []; }
  }
  _saveHistory() { try { localStorage.setItem('ds_history', JSON.stringify(this.history)); } catch {} }

  _recordHit(tf, setup, status) {
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

  _findNearbyZones(cls, price, currentAtr, trend, maxAtrDist) {
    const zones = ZoneEngine.detect(cls);
    ZoneEngine.markFreshness(zones, cls);
    const valid = zones.filter(z => z.fresh || z.tested <= 2);
    if (!valid.length) return [];

    const trendDir = trend ? trend.trend : 'sideways';
    const trendFiltered = valid.filter(z => {
      if (trendDir === 'down' && z.type === 'demand') return false;
      if (trendDir === 'up' && z.type === 'supply') return false;
      return true;
    });

    if (!trendFiltered.length) return [];

    trendFiltered.forEach(z => { z.tradeScore = TradeScorer.score(z, trend, price, currentAtr); });
    trendFiltered.sort((a, b) => b.tradeScore.score - a.tradeScore.score);
    const nearby = [];
    for (const z of trendFiltered) {
      const dist = Math.abs(z.proximal - price);
      if (maxAtrDist > 0 && dist > currentAtr * maxAtrDist) continue;
      nearby.push(z);
      if (nearby.length >= 5) break;
    }
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

    const t1 = TrendEngine.analyze(cl1, s1), t3 = TrendEngine.analyze(cl3, s3);
    const t5 = TrendEngine.analyze(cl5, s5), t15 = TrendEngine.analyze(cl15, s15);
    const t30 = TrendEngine.analyze(cl30, s30);

    const atrMap = {
      '1m': ATREngine.calculate(c1), '3m': ATREngine.calculate(c3),
      '5m': ATREngine.calculate(c5), '15m': ATREngine.calculate(c15),
      '30m': ATREngine.calculate(c30)
    };

    const tfList = [
      { cls: c1, raw: ltf1, tf: '1m', trend: t1, atr: atrMap['1m'] },
      { cls: c3, raw: ltf3, tf: '3m', trend: t3, atr: atrMap['3m'] },
      { cls: c5, raw: ltf5, tf: '5m', trend: t5, atr: atrMap['5m'] },
      { cls: c15, raw: itf15, tf: '15m', trend: t15, atr: atrMap['15m'] },
      { cls: c30, raw: itf30, tf: '30m', trend: t30, atr: atrMap['30m'] }
    ];

    const allResults = {};

    for (const { cls, raw, tf, trend, atr } of tfList) {
      if (cls.length < 3) continue;

      const existing = this.activeByTF[tf];
      if (existing && this._isActive(existing)) {
        this._track(existing, price);
        if (!this._isActive(existing)) {
          this._recordHit(tf, existing, existing.status);
          this.activeByTF[tf] = null;
          this._findNextZone(tf, cls, price, atr, trend, allResults);
          continue;
        } else {
          allResults[tf] = this._buildResult(existing, price, trend, atr);
          continue;
        }
      }
      if (existing && !this._isActive(existing)) this.activeByTF[tf] = null;
      this._findNextZone(tf, cls, price, atr, trend, allResults);
    }

    const sel = selectedTF || '5m';
    const result = allResults[sel] || this._noResult(sel, 'No data', price, t1, atrMap['1m']);
    result.allTF = allResults;
    result.zonesByTF = this.zonesByTF;
    result.t1 = t1; result.t3 = t3; result.t5 = t5; result.t15 = t15; result.t30 = t30;
    result.dailyHistory = this.getDailyHistory();
    result.completedByTF = this.completedByTF;
    return result;
  }

  _findNextZone(tf, cls, price, atr, trend, allResults) {
    const currentAtr = atr[atr.length - 1] || 1;
    const nearbyZones = this._findNearbyZones(cls, price, currentAtr, trend, 5);
    this.zonesByTF[tf] = nearbyZones;

    if (!nearbyZones.length) {
      const trendDir = trend ? trend.trend : 'sideways';
      let reason = 'WAIT';
      if (trendDir === 'down') reason = 'WAIT — Trend DOWN hai, BUY zone allowed nahi';
      else if (trendDir === 'up') reason = 'WAIT — Trend UP hai, SELL zone allowed nahi';
      else reason = 'WAIT — Trend aligned zone nahi mila';
      allResults[tf] = this._noResult(tf, reason, price, trend, atr);
      return;
    }

    const best = nearbyZones[0];
    const isBuy = best.type === 'demand';
    const entry = best.proximal;
    const slBuffer = currentAtr * 0.05;
    const sl = isBuy ? best.distal - slBuffer : best.distal + slBuffer;
    const tgt = RiskManager.target(entry, sl, isBuy);
    const rr = RiskManager.rr(entry, sl, tgt);
    if (rr < 1) { allResults[tf] = this._noResult(tf, 'R:R < 1', price, trend, atr); return; }
    const risk = RiskManager.calc(this.capital, this.riskPct, entry, sl);

    const setup = {
      direction: isBuy ? 'BUY' : 'SELL', zoneType: best.type, pattern: best.pattern,
      entry, stopLoss: sl, target: tgt, riskReward: rr, risk,
      proximal: best.proximal, distal: best.distal,
      zoneTF: tf, zoneScore: best.tradeScore.score, entryType: best.tradeScore.entryType,
      zoneStrength: best.strength, zoneFreshness: best.fresh ? 'fresh' : 'tested',
      baseCount: best.baseCount, status: 'WAITING', price,
      zoneDist: Math.abs(price - best.proximal), pnl: 0, createdAt: Date.now(),
      zoneTime: best.zoneTime
    };
    this.activeByTF[tf] = setup;
    allResults[tf] = this._buildResult(setup, price, trend, atr);
  }

  _track(s, p) {
    const isBuy = s.direction === 'BUY';
    if (isBuy) {
      if (p >= s.target) s.status = 'TARGET_HIT';
      else if (p <= s.stopLoss) s.status = 'STOP_LOSS_HIT';
      else if (p <= s.distal) s.status = 'INVALIDATED';
      else if (p >= s.entry && s.status === 'WAITING') s.status = 'ENTRY_TRIGGERED';
    } else {
      if (p <= s.target) s.status = 'TARGET_HIT';
      else if (p >= s.stopLoss) s.status = 'STOP_LOSS_HIT';
      else if (p >= s.distal) s.status = 'INVALIDATED';
      else if (p <= s.entry && s.status === 'WAITING') s.status = 'ENTRY_TRIGGERED';
    }
    s.price = p; s.zoneDist = Math.abs(p - s.proximal);
    s.pnl = isBuy ? p - s.entry : s.entry - p;
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

  _noResult(tf, reason, price, trend, atr) {
    return { status: 'NO_SETUP', reason, price, trend, sma50: trend ? trend.smaVal : null,
      atr: atr ? atr[atr.length - 1] : null, activeSetup: null, tf, nearbyZones: [] };
  }

  _buildResult(s, price, trend, atr) {
    return { status: s.status, price, trend, sma50: trend ? trend.smaVal : null,
      atr: atr ? atr[atr.length - 1] : null, activeSetup: s, tf: s.zoneTF,
      nearbyZones: this.zonesByTF[s.zoneTF] || [] };
  }
}
