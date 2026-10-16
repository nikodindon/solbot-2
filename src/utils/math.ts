export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function sum(xs: number[]): number {
  let s = 0;
  for (const x of xs) {s += x;}
  return s;
}

export function average(xs: number[]): number {
  return xs.length === 0 ? Number.NaN : sum(xs) / xs.length;
}

export function median(xs: number[]): number {
  if (xs.length === 0) {return Number.NaN;}
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) {return Number.NaN;}
  const mu = average(xs);
  const sq = xs.map((x) => (x - mu) * (x - mu));
  return Math.sqrt(sum(sq) / (xs.length - 1));
}

/**
 * Simple population percentile in [0, 1] (fraction of xs strictly below v).
 * 0 when v is the smallest, 1 when strictly greater than all.
 */
export function percentileRank(xs: number[], v: number): number {
  const n = xs.filter((x) => x < v).length;
  return xs.length === 0 ? Number.NaN : n / xs.length;
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {out.push(arr.slice(i, i + size));}
  return out;
}

export function roundToStep(v: number, step: number): number {
  if (step <= 0) {return v;}
  return Math.floor(v / step) * step;
}

export function safeDiv(a: number, b: number): number {
  return b === 0 ? Number.NaN : a / b;
}
