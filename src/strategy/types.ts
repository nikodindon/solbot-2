import type { Bar } from "./indicators.js";
import type { RegimeResult } from "../market/regime.js";

export type Side = "buy" | "sell";

export interface Signal {
  mint: string;
  symbol: string;
  side: Side;
  /** gross estimated edge vs current price, in bps (before costs) */
  edgeEstimateBps: number;
  /** 0..1 — used by arbitration (weight × confidence) */
  confidence: number;
  /** human readable why (goes to the decision journal verbatim) */
  reason: string;
  ttlMs: number;
  suggestedStopLossPct?: number;
  suggestedTakeProfitPct?: number;
  sellPortion?: number; // 0..1 — partial exit
  allowAdd?: boolean;
  /** true = signal de rééquilibrage (dca_rotation) : le filtre edge-net ne s'applique pas */
  edgeExempt?: boolean;
}

export interface AssetCtx {
  mint: string;
  symbol: string;
  decimals: number;
  price: number;
  liquidityUsd: number | null;
  candles: Bar[]; // strategy timeframe, closed candles only
  regime: RegimeResult;
  volumeRatio: number | null; // last bar volume vs median of previous N (null when unknown)
  ataOpen: boolean | null; // do we already hold this token / have its account? (null when unknown)
}

export interface StrategyPortfolio {
  navUsd: number;
  cashUsd: number; // spendable USDC
  positioned: { mint: string; symbol: string; qty: number; avgEntryUsd: number; valueUsd: number }[];
  solPrice: number;
}

export interface StrategyEval {
  signals: Signal[];
  /** per-asset human decision lines (always produced — journal's raw material) */
  notes: string[];
}

export interface Strategy {
  readonly name: string;
  readonly requiresCandlesTf: string | null;
  /** Evaluate one asset (called per asset per tick). */
  evaluate(asset: AssetCtx, portfolio: StrategyPortfolio): StrategyEval;
}
