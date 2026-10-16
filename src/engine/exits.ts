import type { DB } from "../state/db.js";
import { listPositions, type Position } from "../state/portfolio-repo.js";
import type { RiskConfig } from "../config/schema.js";

export type ExitKind = "stop_loss" | "take_profit" | "trailing_stop" | "regime_idle" | "strategy";

export interface ExitDecision {
  mint: string;
  symbol: string;
  qty: number;
  priceUsd: number;
  kind: ExitKind;
  reason: string;
  portion: number; // 0..1
}

export interface ExitCtx {
  price: number;
  unrealizedPnlUsd: number;
  regime: string;
}

/**
 * Sorties à priorité absolue, par position ouverte:
 *  1) stop-loss dur ;
 *  2) take-profit ;
 *  3) trailing stop (activé si gain ≥ activation, puis retrace du peak) ;
 *  4) régime idle avec position en gain → on sécurise plutôt que d'attendre.
 */
export function checkExits(
  db: DB,
  marks: Map<string, number>,
  ctxByMint: Map<string, ExitCtx>,
  cfg: RiskConfig,
): ExitDecision[] {
  const out: ExitDecision[] = [];
  for (const p of listPositions(db, true)) {
    const price = marks.get(p.mint);
    if (price === undefined || !(price > 0)) {continue;}
    const dec = decideForPosition(p, price, cfg, ctxByMint.get(p.mint));
    if (dec) {out.push(dec);}
  }
  return out;
}

export function decideForPosition(
  p: Position,
  price: number,
  cfg: RiskConfig,
  ctx?: ExitCtx,
): ExitDecision | null {
  const entry = p.avgEntryUsd;
  if (!(entry > 0)) {return null;}

  // 1) stop-loss
  if (p.stopLossPrice !== null && price <= p.stopLossPrice) {
    return mk(p, price, "stop_loss", `SL touchée: prix ${price.toPrecision(6)} ≤ stop ${p.stopLossPrice.toPrecision(6)}`);
  }
  // 2) take-profit
  if (p.takeProfitPrice !== null && price >= p.takeProfitPrice) {
    return mk(p, price, "take_profit", `TP touchée: prix ${price.toPrecision(6)} ≥ tp ${p.takeProfitPrice.toPrecision(6)}`);
  }
  // 3) trailing: activation au gain, sortie au retrace du peak
  if (price >= entry * (1 + cfg.trailing_activation_pct / 100)) {
    const trailing = p.peakPriceUsd ? p.peakPriceUsd * (1 - cfg.trailing_retrace_pct / 100) : null;
    if (trailing !== null && price <= trailing) {
      return mk(
        p,
        price,
        "trailing_stop",
        `trailing: peak ${p.peakPriceUsd!.toPrecision(6)} retrace → stop ${trailing.toPrecision(6)}, prix ${price.toPrecision(6)}`,
      );
    }
  }
  // 4) régime idle : position gagnante → sécuriser
  if (ctx?.regime === "idle" && ctx.unrealizedPnlUsd > 0) {
    return mk(p, price, "regime_idle", `régime idle + position en gain (${ctx.unrealizedPnlUsd.toFixed(3)}$) → sortie de sécurisation`);
  }
  return null;
}

function mk(p: Position, price: number, kind: ExitKind, reason: string): ExitDecision {
  return {
    mint: p.mint,
    symbol: p.symbol,
    qty: p.qty,
    priceUsd: price,
    kind,
    reason,
    portion: 1,
  };
}
