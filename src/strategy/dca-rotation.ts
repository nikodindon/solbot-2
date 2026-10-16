import type { AssetCtx, StrategyPortfolio, Strategy, StrategyEval } from "./types.js";
import { SOL_MINT } from "../constants.js";

export interface DcaRotationCfg {
  targetSol: number; // 0..1 share of NAV held in SOL
  rebalanceBps: number; // act when |drift| ≥ this
}

export const DEFAULT_DCA_ROTATION: DcaRotationCfg = {
  targetSol: 0.35,
  rebalanceBps: 250,
};

const TTL_MS = 60_000;

/**
 * DCA/rotation SOL↔USDC : rééquilibre l'allocation SOL vs USDC autour d'une cible quand la
 * dérive dépasse rebalanceBps. Les signaux sont "edgeExempt" (pas un pari directionnel) mais
 * subissent tous les autres contrôles du risque (réserve de gaz, sizing, cooldown).
 */
export class DcaRotationStrategy implements Strategy {
  readonly name = "dca_rotation";
  readonly requiresCandlesTf = null;
  readonly weight: number;

  constructor(private readonly cfg: DcaRotationCfg = DEFAULT_DCA_ROTATION, weight = 0.7) {
    this.weight = weight;
  }

  evaluate(asset: AssetCtx, portfolio: StrategyPortfolio): StrategyEval {
    const notes: string[] = [];
    if (asset.mint !== SOL_MINT) {
      return { signals: [], notes };
    }
    const solPos = portfolio.positioned.find((x) => x.mint === SOL_MINT) ?? null;
    const solValue = solPos?.valueUsd ?? 0;
    const nav = portfolio.navUsd;
    if (!(nav > 0)) {
      notes.push("dca_rotation — NAV nul/inconnu, rien à faire");
      return { signals: [], notes };
    }
    const solShare = solValue / nav;
    const target = this.cfg.targetSol;
    const drift = (solShare - target) * 10_000;
    if (Math.abs(drift) < this.cfg.rebalanceBps) {
      notes.push(
        `SOL: dca_rotation — SOL ${(solShare * 100).toFixed(1)}% (cible ${(target * 100).toFixed(0)}%), dérive ${drift.toFixed(0)} bps < ${this.cfg.rebalanceBps} → pas d'action`,
      );
      return { signals: [], notes };
    }
    const conf = 0.5;
    if (drift < 0) {
      const desiredUsd = Math.min(
        portfolio.cashUsd * 0.8,
        Math.max(0, nav * (target - solShare)),
      );
      if (desiredUsd < 0.2) {
        notes.push(
          `SOL: dca_rotation — sous-alloué (${(solShare * 100).toFixed(1)}% vs ${(target * 100).toFixed(0)}%) mais ${desiredUsd.toFixed(2)}$ à investir < plancher → pas d'action`,
        );
        return { signals: [], notes };
      }
      notes.push(
        `SOL: dca_rotation — sous-alloué: SOL ${(solShare * 100).toFixed(1)}% vs cible ${(target * 100).toFixed(0)}% → achat ≈ ${desiredUsd.toFixed(2)}$`,
      );
      return {
        signals: [
          {
            mint: SOL_MINT,
            symbol: "SOL",
            side: "buy",
            edgeEstimateBps: 0,
            edgeExempt: true,
            confidence: conf,
            reason: `rééquilibrage vers cible SOL ${(target * 100).toFixed(0)}%`,
            ttlMs: TTL_MS,
          },
        ],
        notes,
      };
    }
    const desiredUsd = Math.max(0, nav * (solShare - target));
    if (desiredUsd < 0.2 || !solPos) {
      notes.push(
        `SOL: dca_rotation — sur-alloué (${(solShare * 100).toFixed(1)}% vs ${(target * 100).toFixed(0)}%) mais reste à vendre trop petit (+réserve de gaz à respecter) → pas d'action`,
      );
      return { signals: [], notes };
    }
    const portion = Math.min(1, desiredUsd / Math.max(1e-9, solPos.valueUsd));
    notes.push(
      `SOL: dca_rotation — sur-alloué: SOL ${(solShare * 100).toFixed(1)}% vs cible ${(target * 100).toFixed(0)}% → vente ≈ ${desiredUsd.toFixed(2)}$`,
    );
    return {
      signals: [
        {
          mint: SOL_MINT,
          symbol: "SOL",
          side: "sell",
          edgeEstimateBps: 0,
          edgeExempt: true,
          confidence: conf,
          reason: `rééquilibrage vers cible SOL ${(target * 100).toFixed(0)}%`,
          ttlMs: TTL_MS,
          sellPortion: Math.max(0.1, Math.min(1, portion)),
        },
      ],
      notes,
    };
  }
}
