class CandleManager {
  constructor(intervalMinutes) {
    this.intervalMs = (intervalMinutes || 1) * 60 * 1000;
    this.candles = [];
    this.current = null;
  }

  start(time) {
    return Math.floor(time / this.intervalMs) * this.intervalMs;
  }

  update(price, time) {
    if (!price || price <= 0) return null;
    if (!time) time = Date.now();
    const s = this.start(time);
    if (!this.current || s > this.current.time) {
      if (this.current) this.candles.push({ ...this.current });
      this.current = { time: s, open: price, high: price, low: price, close: price, volume: 1, updAt: Date.now() };
    } else if (s < this.current.time) {
      // stale tick (purane bucket ka) — live candle ko spoil mat karo
      return { candle: { ...this.current } };
    } else {
      if (price > this.current.high) this.current.high = price;
      if (price < this.current.low) this.current.low = price;
      this.current.close = price;
      this.current.volume++;
      this.current.updAt = Date.now();
    }
    return { candle: this.current ? { ...this.current } : null };
  }

  get() {
    const all = this.candles.slice();
    if (this.current) all.push({ ...this.current });
    return all;
  }

  // srcAt = source data kab fetch hua tha (ms). Agar live tick uske BAAD ka hai
  // to close live hi rakho — warna stale cached close live candle ko rollback
  // kar deta tha (chart + SL/entry dono galat fire hote the).
  setHistory(candles, srcAt) {
    if (!candles || !candles.length) return;
    const incoming = candles.map(c => ({
      time: c.time, open: c.open, high: c.high,
      low: c.low, close: c.close, volume: c.volume || 0
    }));
    const now = Date.now();
    const s = this.start(now);
    const lastIn = incoming[incoming.length - 1];

    // LIVE current candle hai jo incoming se AAGE (ya abhi ka bucket hai) —
    // usko mat giraao. Purana fetch (yahoo/offline data) live state wipe na kare:
    // history ko current se pehle tak rakho, current ko high/low/low se merge karo.
    if (this.current && this.current.time >= s && lastIn.time < this.current.time) {
      this.candles = incoming.filter(c => c.time < this.current.time);
      return;
    }
    // incoming me bhi wahi live bucket hai (aakhri candle abhi ka) — merge karo
    if (this.current && this.current.time === lastIn.time) {
      const cur = this.current;
      const liveNewer = !!(cur.updAt && srcAt && cur.updAt >= srcAt);
      this.candles = incoming.slice(0, -1);
      this.current = {
        time: cur.time,
        open: lastIn.open,                                   // source ka open (zyada accurate)
        high: Math.max(cur.high, lastIn.high),
        low: Math.min(cur.low, lastIn.low),
        close: liveNewer ? cur.close : lastIn.close,         // fresher close hi rakho
        volume: Math.max(cur.volume, lastIn.volume),
        updAt: cur.updAt
      };
      return;
    }

    this.candles = incoming;
    if (this.candles.length) {
      const last = this.candles[this.candles.length - 1];
      if (last.time >= s) {
        this.current = { ...last, updAt: srcAt || now };
        this.candles.pop();
      } else {
        this.current = null;
      }
    }
  }
}

module.exports = CandleManager;
