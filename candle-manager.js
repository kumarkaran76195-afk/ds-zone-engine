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
      this.current = { time: s, open: price, high: price, low: price, close: price, volume: 1 };
    } else {
      if (price > this.current.high) this.current.high = price;
      if (price < this.current.low) this.current.low = price;
      this.current.close = price;
      this.current.volume++;
    }
    return { candle: this.current ? { ...this.current } : null };
  }

  get() {
    const all = this.candles.slice();
    if (this.current) all.push({ ...this.current });
    return all;
  }

  setHistory(candles) {
    if (!candles || !candles.length) return;
    this.candles = candles.map(c => ({
      time: c.time, open: c.open, high: c.high,
      low: c.low, close: c.close, volume: c.volume || 0
    }));
    if (this.candles.length) {
      const last = this.candles[this.candles.length - 1];
      const now = Date.now();
      const s = this.start(now);
      if (last.time >= s) {
        this.current = { ...last };
        this.candles.pop();
      } else {
        this.current = null;
      }
    }
  }
}

module.exports = CandleManager;
