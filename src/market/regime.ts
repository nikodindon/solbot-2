import type { Bar } from "../strategy/indicators.js";
import { volBpsPerBar, ema } from "../strategy/indicators.js";
import { average, percentileRank } from "../utils/math.js";

export type Regime = "trending" | "ranging" | "high_volatility" | "idle";

export interface RegimeConfig {
  volLookback: number; // bars
  highVolPctl: number; // 0..1
  highVolFloorBps: number;
  idleVolBps: number;
  trendAtrRatio: number;
}

export interface RegimeResult {
  regime: Regime;
  volBps: number;
  volRank: number; // 0..1 vs trailing history
  slopeAtr: number; // |ema slope| in ATR units
  momentumAllowed: boolean;
  meanReversionAllowed: boolean;
  dcaAllowed: boolean;
  reason: string;
}

export function regimeDefaults(): RegimeConfig {
  return {
    volLookback: 96,
    highVolPctl: 0.95,
    highVolFloorBps: 25,
    idleVolBps: 4,
    trendAtrRatio: 0.75,
  };
}

/**
 * Per-asset regime classification (deterministic, unit-testable):
 *  - idle: pas assez d'historique, ou vol < idleVolBps -> "ne rien faire"
 *  - high_volatility: vol ≥ floor AND top highVolPctl du trailing -> on trade rien
 *  - trending: |EMA12 slope sur la fenêtre| en ATR ≥ trendAtrRatio -> momentum ON
 *  - ranging: sinon -> mean-reversion ON
 */
export function classifyRegime(bars: Bar[], cfg: RegimeConfig): RegimeResult {
  if (bars.length < 24) {
    return mk("idle", Number.NaN, Number.NaN, Number.NaN, cfg, `historique insuffisant (${bars.length}/24 barres)`);
  }
  const vol = volBpsPerBar(bars, cfg.volLookback);
  const vols: number[] = [];
  const w = Math.min(cfg.volLookback, 48);
  for (let end = w + 2; end <= bars.length; end++) {
    vols.push(volBpsPerBar(bars.slice(0, end), w));
  }
  const volsClean = vols.filter((v) => Number.isFinite(v));
  const rank = Number.isFinite(vol) && volsClean.length > 12 ? percentileRank(volsClean, vol) : Number.NaN;

  if (Number.isFinite(vol) && vol < cfg.idleVolBps) {
    return mk("idle", vol, rank, Number.NaN, cfg, `vol ${vol.toFixed(1)} bps/barre < idle ${cfg.idleVolBps}`);
  }
  if (Number.isFinite(vol) && Number.isFinite(rank) && vol >= cfg.highVolFloorBps && rank >= cfg.highVolPctl) {
    return mk(
      "high_volatility",
      vol,
      rank,
      Number.NaN,
      cfg,
      `vol ${vol.toFixed(1)} bps ≥ ${cfg.highVolFloorBps} et pctl ${Math.round(rank * 100)} ≥ ${Math.round(cfg.highVolPctl * 100)}`,
    );
  }
  const slopeAtr = slopeVsAtr(bars, 12, 8);
  if (Number.isFinite(slopeAtr) && Math.abs(slopeAtr) >= cfg.trendAtrRatio) {
    return mk(
      "trending",
      vol,
      rank,
      slopeAtr,
      cfg,
      `slope EMA12/ATR = ${slopeAtr.toFixed(2)} ≥ ${cfg.trendAtrRatio}`,
    );
  }
  return mk("ranging", vol, rank, slopeAtr, cfg, `slope ATR ${fmt(slopeAtr)} — range`);
}

function fmt(v: number): string {
  return Number.isFinite(v) ? v.toFixed(2) : "n/a";
}

function mk(
  regime: Regime,
  volBps: number,
  volRank: number,
  slopeAtr: number,
  cfg: RegimeConfig,
  reason: string,
): RegimeResult {
  const dormant = regime === "idle" || regime === "high_volatility";
  return {
    regime,
    volBps,
    volRank,
    slopeAtr,
    momentumAllowed: regime === "trending",
    meanReversionAllowed: regime === "ranging",
    dcaAllowed: !dormant,
    reason,
  };
}

/** |EMA(now) − EMA(delta ago)| / ATR — dimensionless trend strength. */
export function slopeVsAtr(bars: Bar[], period: number, delta: number): number {
  if (bars.length < period + delta + 1) {return Number.NaN;}
  const emaNow = ema(bars.map((b) => b.close), period);
  const emaPrev = ema(bars.slice(0, -delta).map((b) => b.close), period);
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!;
    const pc = bars[i - 1]!.close;
    trs.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)));
  }
  const avgTr = average(trs.slice(-period * 2));
  if (!Number.isFinite(emaNow as number) || !Number.isFinite(emaPrev as number) || !(avgTr > 0)) {
    return Number.NaN;
  }
  return Math.abs((emaNow as number) - (emaPrev as number)) / avgTr;
}
