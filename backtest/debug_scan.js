// attrition funnel: scanner kahan zero de raha hai
const IND = require('../public/indicator.js');
const GROWW = 'https://groww.in/v1/api';

async function groww(inst, tfMin, minsBack) {
  const now = Date.now(), start = now - minsBack * 60000;
  const url = `${GROWW}/charting_service/v2/chart/exchange/${inst.exchange}/segment/${inst.segment}/${inst.symbol}?startTimeInMillis=${start}&endTimeInMillis=${now}&intervalInMinutes=${tfMin}`;
  try {
    const r = await fetch(url, { headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://groww.in/', 'Origin': 'https://groww.in' } , signal: AbortSignal.timeout(12000) });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.candles || []).map(c => ({ time: c[0] * 1000, open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] || 0 }));
  } catch (e) { return []; }
}

async function yahoo(inst, tfMin) {
  const yInt = tfMin >= 43200 ? '1mo' : tfMin >= 10080 ? '1wk' : '1d';
  const r = tfMin >= 43200 ? '10y' : tfMin >= 10080 ? '10y' : '5y';
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${inst.yahoo}?interval=${yInt}&range=${r}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return [];
    const j = await res.json();
    const rs = j.chart && j.chart.result && j.chart.result[0];
    if (!rs || !rs.timestamp) return [];
    const q = rs.indicators.quote[0];
    return rs.timestamp.map((t, i) => ({ time: t * 1000, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: (q.volume && q.volume[i]) || 0 }))
      .filter(c => c.open != null && c.close != null);
  } catch (e) { return []; }
}

const SYMS = ['SBIN', 'RELIANCE', 'TATAMOTORS', 'HDFCBANK', 'ITC', 'COALINDIA', 'TATASTEEL', 'SUNPHARMA', 'MARUTI', 'LT', 'BHARTIARTL', 'ASIANPAINT', 'ULTRACEMCO', 'NTPC', 'INFY'];
const TFS = [{ k: '1D', tf: 1440, mins: 1440 * 1400 }, { k: '1W', tf: 10080, mins: 10080 * 530 }, { k: '1M', tf: 43200, mins: 43200 * 130 }];

(async () => {
  const F = { fail: 0, demand: 0, strat: 0, wide: 0, score: 0, inZoneHits: 0, touchHits: 0, band: 0, hit: 0 };
  for (const sym of SYMS) {
    const inst = { exchange: 'NSE', segment: 'CASH', symbol: sym, isIndex: false, yahoo: encodeURIComponent(sym) + '.NS' };
    for (const t of TFS) {
      let list = await groww(inst, t.tf, t.mins);
      if (list.length < 30) list = await yahoo(inst, t.tf);
      if (list.length < 30) { F.fail++; continue; }
      const price = list[list.length - 1].close;
      let ath = 0, atl = Infinity;
      for (const c of list) { if (c.high > ath) ath = c.high; if (c.low < atl) atl = c.low; }
      const cc = IND.CandleEngine.classifyAll(list);
      const cl = cc.map(c => c.close);
      const atrArr = IND.ATREngine.calculate(cc);
      const tr = IND.TrendEngine.analyze(cl, IND.TrendEngine.sma(cl), atrArr);
      const atrv = atrArr[atrArr.length - 1] || 1;
      const det = IND.ZoneEngine.detect(cc, tr.trend);
      IND.ZoneEngine.markFreshness(det, cc);
      let nD = 0, nStrat = 0, nWide = 0, nScore = 0, nIn = 0, nBand = 0;
      for (const z of det) {
        if (z.type !== 'demand') continue;
        nD++;
        if (z.tested > 2 || z.authentic === false) continue;
        nStrat++;
        if (atrv > 0 && Math.abs(z.proximal - z.distal) / atrv > 1.5) continue;
        nWide++;
        const sc = IND.TradeScorer.score(z, tr, price, atrv, null);
        if (!sc.tradeable) continue;
        nScore++;
        const inZ = price <= z.proximal && price >= z.distal;
        const tch = !inZ && price > z.proximal && price <= z.proximal + atrv * 0.25;
        if (!inZ && !tch) continue;
        if (atl > 0 && ath > 0 && (z.distal < atl * 0.95 || z.proximal > ath)) continue;
        nBand++;
        if (inZ) { nIn++; F.inZoneHits++; } else { F.touchHits++; }
        console.log(`${inZ ? 'ENTER' : 'TOUCH'} ${sym} ${t.k} LTP ${price} zone E${z.proximal} D${z.distal} s${sc.score}`);
      }
      F.demand += nD; F.strat += nStrat; F.wide += nWide; F.score += nScore; F.inZone += nIn; F.band += nBand;
      if (nBand) F.hit++;
      console.log(`${sym.padEnd(12)} ${t.k} n=${list.length} LTP=${price} demand=${nD} strat=${nStrat} wideOK=${nWide} scoreOK=${nScore} inZone=${nIn} band=${nBand}`);
    }
  }
  console.log('\nFUNNEL:', JSON.stringify(F));
})();
