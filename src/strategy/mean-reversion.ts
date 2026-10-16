import type { AssetCtx, StrategyPortfolio, Strategy, StrategyEval } from "./types.js";
import { zScore } from "./indicators.js";

export interface MeanReversionCfg {
  window: number;
  zEntry: number;
  zExit: number;
}

export const DEFAULT_MEAN_REVERSION: MeanReversionCfg = {
  window: 96,
  zEntry: 2,
  zExit: 0.5,
};

const TTL_MS = 45_000;

/**
 * Mean-reversion (long only): achat en survente (z ≤ −ziempre) sur une fenêtre glissante,
 * sortie au retour vers la moyenne (z ≥ −z_exit). Edge estimé = distance à la moyenne.
 */
export class MeanReversionStrategy implements Strategy {
  readonly name = "mean_reversion";
  readonly requiresCandlesTf = "15m";
  readonly weight: number;

  constructor(private readonly cfg: MeanReversionCfg = DEFAULT_MEAN_REVERSION, weight = 1) {
    this.weight = weight;
  }

  requiredBars(): number {
    return this.cfg.window;
  }

  evaluate(asset: AssetCtx, portfolio: StrategyPortfolio): StrategyEval {
    const notes: string[] = [];
    const bars = asset.candles;
    if (bars.length < this.requiredBars()) {
      notes.push(
        `${asset.symbol}: mean-reversion — pas assez de barres (${bars.length}/${this.requiredBars()}) — pas d'avis`,
      );
      return { signals: [], notes };
    }
    const z = zScore(bars, this.cfg.window);
    if (z === null || !Number.isFinite(z)) {
      return { signals: [], notes };
    }
    const closes = bars.map((b) => b.close);
    const mu = closes.reduce((a, b) => a + b, 0) / closes.length;
    const distanceBps = ((mu - asset.price) / asset.price) * 10_000; // synthetica: >0 = sous la moyenne
    const holding = portfolio.positioned.find((x) => x.mint === asset.mint) ?? null;

    if (holding) {
      if (z >= -this.cfg.zExit) {
        notes.push(
          `${asset.symbol}: mean-reversion — SORTIE: z(${z.toFixed(2)}) ≥ −z_exit(${this.cfg.zExit})`,
        );
        return {
          signals: [
            {
              mint: asset.mint,
              symbol: asset.symbol,
              side: "sell",
              edgeEstimateBps: 0,
              confidence: 0.65,
              reason: `retour vers la moyenne (z=${z.toFixed(2)})`,
              ttlMs: TTL_MS,
            },
          ],
          notes,
        };
      }
      notes.push(
        `${asset.symbol}: mean-reversion — tenue (z=${z.toFixed(2)} toujours < −${this.cfg.zExit})`,
      );
      return { signals: [], notes };
    }

    if (z <= -this.cfg.zEntry) {
      const conf = Math.min(0.85, 0.4 + 0.12 * Math.min(3, Math.abs(z) - this.cfg.zEntry));
      notes.push(
        `${asset.symbol}: mean-reversion — signal ACHAT: z(${z.toFixed(2)}) ≤ −z_entry(${this.cfg.zEntry}) | marge à la moyenne ${distanceBps.toFixed(0)} bps, score ${(conf * this.weight).toFixed(2)}`,
      );
      return {
        signals: [
          {
            mint: asset.mint,
            symbol: asset.symbol,
            side: "buy",
            edgeEstimateBps: Math.max(0, distanceBps),
            confidence: conf,
            reason: `survente z=${z.toFixed(2)}`,
            ttlMs: TTL_MS,
          },
        ],
        notes,
      };
    }
    notes.push(
      `${asset.symbol}: mean-reversion — z=${z.toFixed(2)} (entrée à −${this.cfg.zEntry}) → pas d'entrée`,
    );
    return { signals: [], notes };
  }
}
