import type { DB } from "../state/db.js";
import { listPositions } from "../state/portfolio-repo.js";
import { kvGetJson, kvSetJson } from "../state/kv.js";
import { SOL_MINT, LAMPORTS_PER_SOL } from "../constants.js";
import type { RiskConfig } from "../config/schema.js";

export interface PortfolioSnapshot {
  navUsd: number;
  cashUsd: number; // USDC spendable
  positionsUsd: number;
  solBalanceSol: number;
  solBalanceUsd: number;
  usdcBalanceUsd: number;
  solAboveReserveSol: number;
  swapsRemaining: number;
  positions: {
    mint: string;
    symbol: string;
    qty: number;
    avgEntryUsd: number;
    valueUsd: number;
    unrealizedPnlUsd: number;
    peakPriceUsd: number | null;
    stopLossPrice: number | null;
    takeProfitPrice: number | null;
    trailingStopPrice: number | null;
    ageMs: number;
  }[];
  realizedTotalUsd: number;
  initialCapitalUsd: number;
  navPeakUsd: number;
  drawdownPct: number;
}

export interface SnapshotOpts {
  mode: string;
  /** paper cash (modes paper/dry_run) — in live, balances come from `balances` */
  paperCashUsdc: number;
  /** live/dry balances (USDC units, SOL lamports) — null in paper */
  balances?: { usdc: number; solLamports: number; tokens: { mint: string; amount: number }[] } | null;
  solPrice: number;
  usdcPrice: number;
  risk: RiskConfig;
  nowMs: number;
}

export function paperCashGet(db: DB, initialUsdc: number): number {
  const v = kvGetJson<number | null>(db, "paperCashUsdc", null);
  if (v === null) {
    kvSetJson(db, "paperCashUsdc", initialUsdc);
    return initialUsdc;
  }
  return v;
}

export function paperCashSet(db: DB, v: number): void {
  kvSetJson(db, "paperCashUsdc", v);
}

/** Mark-to-market snapshot for both virtual (paper) and on-chain (live) portfolios. */
export function buildSnapshot(db: DB, priceMap: Map<string, number>, opts: SnapshotOpts): PortfolioSnapshot {
  const risk = opts.risk;
  const positions = listPositions(db, true);
  const isLive = opts.mode === "live";
  let usdcCash = opts.paperCashUsdc;
  let solSol = 0;
  if (isLive && opts.balances) {
    usdcCash = opts.balances.usdc;
    solSol = opts.balances.solLamports / LAMPORTS_PER_SOL;
  } else {
    // in paper, SOL is a position in the book
    solSol = positions.find((p) => p.mint === SOL_MINT)?.qty ?? 0;
  }

  const solPrice = opts.solPrice;
  const usdcPrice = opts.usdcPrice || 1;
  let positionsUsd = 0;
  const out: PortfolioSnapshot["positions"] = [];
  for (const p of positions) {
    if (p.mint === SOL_MINT && !isLive) {
      // SOL position (paper) is counted as cash-equivalent below, not as "position" exposure
      continue;
    }
    const price = priceMap.get(p.mint) ?? 0;
    const value = p.qty * price;
    positionsUsd += value;
    out.push({
      mint: p.mint,
      symbol: p.symbol,
      qty: p.qty,
      avgEntryUsd: p.avgEntryUsd,
      valueUsd: value,
      unrealizedPnlUsd: value - p.investedUsd,
      peakPriceUsd: p.peakPriceUsd,
      stopLossPrice: p.stopLossPrice,
      takeProfitPrice: p.takeProfitPrice,
      trailingStopPrice: p.trailingStopPrice,
      ageMs: opts.nowMs - p.openedMs,
    });
  }
  const cashUsd = usdcCash * usdcPrice;
  const navUsd = cashUsd + positionsUsd + solSol * solPrice;
  const initialCapital = kvGetJson<number | null>(db, "initialCapitalUsd", null);
  const initial = initialCapital ?? navUsd;
  if (initialCapital === null && navUsd > 0) {kvSetJson(db, "initialCapitalUsd", navUsd);}
  const peak = kvGetJson<number | null>(db, "navPeakUsd", null);
  const navPeak = Math.max(peak ?? 0, navUsd);
  if (navPeak !== peak) {kvSetJson(db, "navPeakUsd", navPeak);}
  const drawdownPct = navPeak > 0 ? Math.max(0, ((navPeak - navUsd) / navPeak) * 100) : 0;
  const solAboveReserve = Math.max(0, solSol - risk.gas_reserve_sol);
  const perSwapSol = (5_000 + risk.priority_fee_sol * LAMPORTS_PER_SOL) / LAMPORTS_PER_SOL;
  return {
    navUsd,
    cashUsd,
    positionsUsd,
    solBalanceSol: solSol,
    solBalanceUsd: solSol * solPrice,
    usdcBalanceUsd: usdcCash * usdcPrice,
    solAboveReserveSol: solAboveReserve,
    swapsRemaining: Math.floor(solAboveReserve / Math.max(1e-9, perSwapSol)),
    positions: out,
    realizedTotalUsd: positions.reduce((a, _p) => a + 0, 0), // filled by caller from trades ledger
    initialCapitalUsd: initial,
    navPeakUsd: navPeak,
    drawdownPct,
  };
}

/** B&H SOL benchmark: initial NAV valued with SOL's price move since the first tick. */
export function benchmarkBuyHold(initialNav: number, solPriceNow: number, solPrice0: number | null): number {
  if (!solPrice0 || !(solPrice0 > 0)) {return initialNav;}
  return initialNav * (solPriceNow / solPrice0);
}
