import type { AssetCtx, StrategyPortfolio, Strategy, StrategyEval } from "./types.js";
import {
  ema,
  rsi,
  atr,
  highestHigh,
  median,
} from "./indicators.js";

export interface MomentumCfg {
  emaFast: number;
  emaSlow: number;
  rsiPeriod: number;
  rsiEntry: number;
  breakoutLookback: number;
  volumeLookback: number;
  volumeMult: number;
  atrStopMult: number;
}

export const DEFAULT_MOMENTUM: MomentumCfg = {
  emaFast: 9,
  emaSlow: 21,
  rsiPeriod: 14,
  rsiEntry: 68,
  breakoutLookback: 20,
  volumeLookback: 20,
  volumeMult: 1.5,
  atrStopMult: 2,
};

const TTL_MS = 45_000;

/**
 * Momentum (long only — spot): breakout du plus haut récent + EMA fast > slow + RSI de force
 * + confirmation volume. Sortie quand la Croisement Se renverse (fast < slow).
 */
export class MomentumStrategy implements Strategy {
  readonly name = "momentum";
  readonly requiresCandlesTf = "15m";
  readonly weight: number;

  constructor(private readonly cfg: MomentumCfg = DEFAULT_MOMENTUM, weight = 1) {
    this.weight = weight;
  }

  requiredBars(): number {
    return Math.max(this.cfg.emaSlow + 5, this.cfg.breakoutLookback + 2, this.cfg.volumeLookback + 2, this.cfg.rsiPeriod + 2);
  }

  evaluate(asset: AssetCtx, _portfolio: StrategyPortfolio): StrategyEval {
    const notes: string[] = [];
    const bars = asset.candles;
    if (bars.length < this.requiredBars()) {
      notes.push(
        `${asset.symbol}: momentum — pas assez de barres (${bars.length}/${this.requiredBars()}) — pas d'avis`,
      );
      return { signals: [], notes };
    }
    const closes = bars.map((b) => b.close);
    const price = asset.price;
    const emaFast = ema(closes, this.cfg.emaFast);
    const emaSlow = ema(closes, this.cfg.emaSlow);
    const r = rsi(closes, this.cfg.rsiPeriod);
    const hi = highestHigh(bars, this.cfg.breakoutLookback);
    const atrNow = atr(bars, 14);
    const vols = bars.map((b) => b.volume);
    const lastVol = vols[vols.length - 1] ?? 0;
    const prevVols = vols.slice(Math.max(1, vols.length - this.cfg.volumeLookback - 1), -1);
    const volMed = median(prevVols);
    const volumeRatio = volMed && volMed > 0 ? lastVol / volMed : null;

    if (emaFast === null || emaSlow === null || hi === null) {
      return { signals: [], notes };
    }
    const broken = price > hi;
    const stacked = emaFast > emaSlow;
    const rsiStrong = r !== null && r >= this.cfg.rsiEntry;
    const volOk = volumeRatio === null || volumeRatio >= this.cfg.volumeMult;
    const holding = _positionOf(_portfolio, asset.mint);

    if (holding) {
      if (!stacked && price < emaSlow) {
        notes.push(
          `${asset.symbol}: momentum — sortie (EMA fast ${emaFast.toFixed(3)} < slow ${emaSlow.toFixed(3)})`,
        );
        return {
          signals: [
            {
              mint: asset.mint,
              symbol: asset.symbol,
              side: "sell",
              edgeEstimateBps: 0,
              confidence: 0.6,
              reason: `tendance renversée (emaFast<emaSlow, RSI ${r?.toFixed(0) ?? "n/a"})`,
              ttlMs: TTL_MS,
            },
          ],
          notes,
        };
      }
      const run = ((price - holding.avgEntryUsd) / holding.avgEntryUsd) * 10_000;
      notes.push(
        `${asset.symbol}: momentum — tenu (EMA fast>slow à ${(run / 100).toFixed(2)}%), stop/TP gérés par le risque`,
      );
      return { signals: [], notes };
    }

    const edge = emaSlow > 0 ? ((price - emaSlow) / emaSlow) * 10_000 : 0;
    if (broken && stacked && rsiStrong && volOk) {
      let conf = 0.4;
      if (r !== null && r >= 76) {conf += 0.2;}
      if (volumeRatio !== null && volumeRatio >= this.cfg.volumeMult * 2) {conf += 0.15;}
      if ((price - hi) / price > 0.002) {conf += 0.1;}
      conf = Math.min(0.9, conf);
      const stopPct =
        atrNow !== null
          ? Math.min(50, Math.max(1, ((this.cfg.atrStopMult * atrNow * 100) / price) as number))
          : 6;
      notes.push(
        `${asset.symbol}: momentum — signal ACHAT: cassure>${hi.toFixed(3)} + EMA fast>slow + RSI ${(r ?? 0).toFixed(0)}≥${this.cfg.rsiEntry} + vol ×${(volumeRatio ?? 0).toFixed(1)} | edge brut estimé ${edge.toFixed(0)} bps, score ${(conf * this.weight).toFixed(2)}`,
      );
      return {
        signals: [
          {
            mint: asset.mint,
            symbol: asset.symbol,
            side: "buy",
            edgeEstimateBps: Math.max(0, edge),
            confidence: conf,
            reason: `breakout + tendance + RSI + volume`,
            ttlMs: TTL_MS,
            suggestedStopLossPct: stopPct,
          },
        ],
        notes,
      };
    }
    const why: string[] = [];
    if (!broken) {why.push(`pas de cassure (≤ plus haut ${hi.toFixed(3)})`);}
    if (!stacked) {why.push("EMA fast<slow");}
    if (!rsiStrong) {why.push(`RSI ${(r ?? 0).toFixed(0)}<entrée`);}
    if (!volOk) {why.push(`volume ×${(volumeRatio ?? 0).toFixed(1)}<×${this.cfg.volumeMult}`);}
    notes.push(
      `${asset.symbol}: momentum — conf ${(0.4 * this.weight).toFixed(2)}, conditions manquantes: ${why.join(", ")} → pas d'entrée`,
    );
    return { signals: [], notes };
  }
}

function _positionOf(p: StrategyPortfolio, mint: string) {
  return p.positioned.find((x) => x.mint === mint) ?? null;
}
