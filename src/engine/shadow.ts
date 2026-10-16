import type { DB } from "../state/db.js";
import { loadShadowState, insertShadowTrade, insertShadowNav } from "../state/equity.js";
import { simulateBuy, simulateSell } from "../execution/paper-broker.js";
import { modeledPairFeeBps } from "../jupiter/swap.js";
import { USDC_MINT } from "../constants.js";
import type { AppConfig } from "../config/schema.js";
import type { Signal, Strategy } from "../strategy/types.js";
import { kvGetJson, kvSetJson } from "../state/kv.js";

export interface ShadowTickResult {
  allocation: string; // strategy allocated (may be unchanged)
  allocationChanged: boolean;
  lines: string[];
}

const WINDOW_MS = 24 * 3_600_000;

/**
 * Portefeuilles fantômes: chaque stratégie trade un capital virtuel, aux mêmes coûts que le
 * paper broker (frais Jupiter + slippage + fees SOL). Le capital réel suit la meilleure
 * performance glissante 24 h nette de coûts (samples min + marge hystérésis).
 */
export function runShadows(
  db: DB,
  cfg: AppConfig,
  strategies: { strategy: Strategy; weight: number; signals: Signal[] }[],
  markOf: (mint: string) => number | undefined,
  symbols: Map<string, string>,
  nowMs: number,
): ShadowTickResult {
  const sc = cfg.shadow;
  const fillBase = {
    slippageBps: cfg.costs.paper_fill_slippage_bps,
    solPrice: 150,
    priorityFeeSol: cfg.risk.priority_fee_sol,
    liquidityUsd: 2_000_000,
  };
  const lines: string[] = [];
  const scores: { strategy: string; scoreUsd: number; eligible: boolean }[] = [];

  for (const s of strategies) {
    const name = s.strategy.name;
    const st = loadShadowState(db, name, sc.cash_usd);
    const holdings = new Map(st.holdings.map((h) => [h.mint, { qty: h.qty, avgEntryUsd: h.avgEntryUsd }]));
    let cash = st.cashUsd;
    let positionsUsd = 0;
    for (const [mint, h] of holdings) {
      positionsUsd += h.qty * (markOf(mint) ?? h.avgEntryUsd);
    }

    const sellSignals = s.signals.filter((x) => x.side === "sell");
    for (const sig of sellSignals) {
      const hold = holdings.get(sig.mint);
      const price = markOf(sig.mint);
      if (!hold || price === undefined || !(price > 0)) {continue;}
      const qty = hold.qty * Math.min(1, Math.max(0.1, sig.sellPortion ?? 1));
      const feeBps = modeledPairFeeBps(sig.mint, USDC_MINT);
      const f = simulateSell(qty, price, { ...fillBase, feeBps });
      holdings.set(sig.mint, { ...hold, qty: hold.qty - qty });
      if (holdings.get(sig.mint)!.qty <= 1e-9) {holdings.delete(sig.mint);}
      cash += f.proceedsUsd;
      insertShadowTrade(db, {
        shadow: name,
        tsMs: nowMs,
        mint: sig.mint,
        side: "sell",
        qty,
        priceUsd: f.proceedsUsd / qty,
        spendUsd: f.proceedsUsd,
        feeTotalUsd: f.jupFeeUsd + f.solFee * fillBase.solPrice,
        note: sig.reason,
      });
      lines.push(
        `${name}|shadow: vente ${qty.toFixed(6)} ${symbols.get(sig.mint) ?? sig.mint} → ${f.proceedsUsd.toFixed(3)}$ (frais ${(f.jupFeeUsd + f.solFee * fillBase.solPrice).toFixed(4)}$)`,
      );
    }

    // positions USDC ne sont pas tradées par les stratégies hors SOL
    if (holdings.size < sc.max_positions) {
      const buySignals = s.signals.filter(
        (x) => x.side === "buy" && !holdings.has(x.mint),
      );
      const price = buySignals.length > 0 ? markOf(buySignals[0]!.mint) : undefined;
      const first = buySignals[0];
      if (first && price !== undefined && price > 0 && cash >= sc.trade_usd) {
        const feeBps = modeledPairFeeBps(USDC_MINT, first.mint);
        const f = simulateBuy(sc.trade_usd, price, { ...fillBase, feeBps });
        holdings.set(first.mint, { qty: f.qty, avgEntryUsd: f.priceEffective });
        cash -= f.spendUsd;
        insertShadowTrade(db, {
          shadow: name,
          tsMs: nowMs,
          mint: first.mint,
          side: "buy",
          qty: f.qty,
          priceUsd: f.priceEffective,
          spendUsd: f.spendUsd,
          feeTotalUsd: f.jupFeeUsd + f.solFee * fillBase.solPrice,
          note: first.reason,
        });
        lines.push(
          `${name}|shadow: achat ${sc.trade_usd.toFixed(2)}$ → ${f.qty.toFixed(6)} ${symbols.get(first.mint) ?? first.mint} (frais ${(f.jupFeeUsd + f.solFee * fillBase.solPrice).toFixed(4)}$)`,
        );
      }
    }

    positionsUsd = 0;
    for (const [mint, h] of holdings) {
      positionsUsd += h.qty * (markOf(mint) ?? h.avgEntryUsd);
    }
    const navUsd = cash + positionsUsd;
    insertShadowNav(db, name, nowMs, navUsd);

    // score glissant 24h (net, de la NAV enregistrée il y a ~24h)
    const navThen = navAtOrBefore(db, name, nowMs - WINDOW_MS);
    const trades = shadowTradeCountWindow(db, name, nowMs - WINDOW_MS);
    if (navThen !== null) {
      scores.push({
        strategy: name,
        scoreUsd: navUsd - navThen,
        eligible: trades >= sc.min_samples,
      });
    }
    lines.push(`${name}|shadow: NAV ${navUsd.toFixed(3)}$ (cash ${cash.toFixed(3)}$, ${holdings.size} pos, ${trades} trades/24h)`);
  }

  // allocation: meilleure perf glissante, hystérésis marge + samples min
  const eligible = scores.filter((x) => x.eligible);
  const current = kvGetJson<string | null>(db, "allocatedStrategy", null);
  let allocation = current;
  let changed = false;
  if (eligible.length > 0) {
    const best = eligible.reduce((a, b) => (b.scoreUsd > a.scoreUsd ? b : a));
    if (!current) {
      allocation = best.strategy;
      changed = true;
      lines.push(`allocation: aucun titulaire → ${best.strategy} (${best.scoreUsd.toFixed(3)}$/24h)`);
    } else if (current !== best.strategy) {
      const curScore = eligible.find((x) => x.strategy === current)?.scoreUsd ?? null;
      if (curScore === null) {
        allocation = best.strategy;
        changed = true;
        lines.push(`allocation: ${current} perd ses échantillons → ${best.strategy}`);
      } else if (best.scoreUsd > curScore + sc.amd_margin_usd) {
        allocation = best.strategy;
        changed = true;
        lines.push(
          `allocation: ${best.strategy} (${best.scoreUsd.toFixed(3)}$/24h) > ${current} (${curScore.toFixed(3)}$) + marge ${sc.amd_margin_usd}$ → bascule`,
        );
      } else {
        lines.push(`allocation: ${current} garde la main (écart < marge ${sc.amd_margin_usd}$)`);
      }
    } else {
      lines.push(`allocation: ${current} confirmé`);
    }
  }
  if (allocation !== current) {
    kvSetJson(db, "allocatedStrategy", allocation);
  }
  return { allocation: allocation ?? "", allocationChanged: changed, lines };
}

function shadowTradeCountWindow(db: DB, shadow: string, sinceTs: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM shadow_trades WHERE shadow = ? AND ts_ms >= ?")
    .get(shadow, sinceTs) as { c: number };
  return row.c;
}

function navAtOrBefore(db: DB, shadow: string, tsMs: number): number | null {
  const row = db
    .prepare(
      "SELECT nav_usd FROM shadow_nav WHERE shadow = ? AND ts_ms <= ? ORDER BY ts_ms DESC LIMIT 1",
    )
    .get(shadow, tsMs) as { nav_usd: number } | undefined;
  if (row) {return row.nav_usd;}
  // fenêtre plus jeune que 24h: base sur le tout premier point d'historique
  const first = db
    .prepare(
      "SELECT nav_usd FROM shadow_nav WHERE shadow = ? ORDER BY ts_ms ASC LIMIT 1",
    )
    .get(shadow) as { nav_usd: number } | undefined;
  return first ? first.nav_usd : null;
}
