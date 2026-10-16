/** Pure candle math shared by strategies, regime detection and the cost model. */
export interface Bar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Exponential moving average over closes (seeds with SMA of first window then recurses). */
export function ema(values: number[], period: number): number | null {
  if (values.length < period || period < 1) {return null;}
  const alpha = 2 / (period + 1);
  let acc = 0;
  // seed: SMA of the first `period` values
  for (let i = 0; i < period; i++) {acc += values[i]!;}
  let out = acc / period;
  for (let i = period; i < values.length; i++) {
    out = alpha * values[i]! + (1 - alpha) * out;
  }
  return out;
}

/** Wilder's RSI over closes. */
export function rsi(closes: number[], period: number): number | null {
  if (closes.length < period + 1) {return null;}
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) {gains += d;}
    else {losses -= d;}
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
  }
  if (avgLoss < 1e-12) {return 100;}
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** True Range series then ATR (Wilder). */
export function atr(bars: Bar[], period: number): number | null {
  if (bars.length < period + 1) {return null;}
  const tr: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!;
    const pc = bars[i - 1]!.close;
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)));
  }
  let acc = 0;
  for (let i = 0; i < period; i++) {acc += tr[i]!;}
  let out = acc / Math.abs(period);
  for (let i = period; i < tr.length; i++) {out = (out * (period - 1) + tr[i]!) / period;}
  return out;
}

/** Population stdev of close-to-close returns in bps per bar. */
export function volBpsPerBar(bars: Bar[], lookback: number): number {
  if (bars.length < 3) {return Number.NaN;}
  const slice = bars.slice(-lookback);
  const rets: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    if (slice[i - 1]!.close <= 0) {continue;}
    rets.push(Math.log(slice[i]!.close / slice[i - 1]!.close) * 10_000);
  }
  if (rets.length < 2) {return Number.NaN;}
  const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
  return Math.sqrt(rets.reduce((a, b) => a + (b - mu) ** 2, 0) / rets.length);
}

/** Highest high of the last `lookback` bars (excluding the current one — classic breakout is vs the prior window). */
export function highestHigh(bars: Bar[], lookback: number): number | null {
  const slice = bars.slice(0, -1).slice(-lookback);
  if (slice.length === 0) {return null;}
  return Math.max(...slice.map((b) => b.high));
}

export function lowestLow(bars: Bar[], lookback: number): number | null {
  const slice = bars.slice(0, -1).slice(-lookback);
  if (slice.length === 0) {return null;}
  return Math.min(...slice.map((b) => b.low));
}

export function median(values: number[]): number | null {
  if (values.length === 0) {return null;}
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** EMA slope expressed in bps of price slope per bar. */
export function emaSlopeBps(bars: Bar[], period: number, delta: number): number | null {
  if (bars.length < period + delta) {return null;}
  const emaNow = ema(bars.map((b) => b.close), period);
  const emaPrev = ema(bars.slice(0, -delta).map((b) => b.close), period);
  if (emaNow === null || emaPrev === null || emaPrev <= 0 || emaNow <= 0) {return null;}
  return ((emaNow - emaPrev) / emaPrev) * 10_000;
}

/** z-score of the last close vs a rolling window mean/stdev (mean-reversion). */
export function zScore(bars: Bar[], window: number): number | null {
  const slice = bars.slice(-window);
  if (slice.length < window) {return null;}
  const closes = slice.map((b) => b.close);
  const mu = closes.reduce((a, b) => a + b, 0) / closes.length;
  const sd = Math.sqrt(closes.reduce((a, b) => a + (b - mu) ** 2, 0) / closes.length);
  if (sd < 1e-12) {return 0;}
  return ((closes[closes.length - 1] as number) - mu) / sd;
}
