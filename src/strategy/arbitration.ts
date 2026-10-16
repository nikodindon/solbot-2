import type { Signal } from "./types.js";

export interface Candidate {
  strategy: string;
  weight: number;
  signal: Signal;
}

export interface Scored {
  strategy: string;
  signal: Signal;
  score: number;
}

/**
 * score = confidence × weight × (1 + clamp(edge,0,200)/400).
 * edgeExempt (rotation) gets a flat neutral boost: it's a rebalance, not an alpha bet.
 */
export function scoreOf(c: Candidate): number {
  if (c.signal.edgeExempt) {return c.signal.confidence * c.weight * 1.02;}
  const edge = Math.max(0, Math.min(200, c.signal.edgeEstimateBps));
  return c.signal.confidence * c.weight * (1 + edge / 400);
}

/**
 * Arbitration: group by (side,mint), keep the best score per group, sort by score desc,
 * exits outrank buys on the same mint.
 */
export function arbitrate(candidates: Candidate[]): Scored[] {
  const best = new Map<string, Scored>();
  for (const c of candidates) {
    const key = `${c.signal.side}:${c.signal.mint}`;
    const s = scoreOf(c);
    const prev = best.get(key);
    if (!prev || s > prev.score) {
      best.set(key, { strategy: c.strategy, signal: c.signal, score: s });
    }
  }
  const list = [...best.values()];
  return list.sort((a, b) => {
    if (a.signal.side !== b.signal.side) {return a.signal.side === "sell" ? -1 : 1;}
    return b.score - a.score;
  });
}
