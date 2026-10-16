import type { DB } from "../state/db.js";
import type { RpcClient } from "../solana/rpc.js";
import { addLot, reducePositionFifo, getPosition, listPositions } from "../state/portfolio-repo.js";
import { setStops } from "../state/portfolio-repo.js";
import { upsertTokenMeta, getTokenMeta } from "../state/market.js";
import { insertTrade } from "../state/trades.js";
import type { AppConfig } from "../config/schema.js";
import { SOL_MINT, USDC_MINT, LAMPORTS_PER_SOL } from "../constants.js";

export interface ReconciliationLine {
  mint: string;
  action: "adopt" | "close" | "none";
  line: string;
}

/**
 * Réconciliation on-chain au démarrage (modes dry_run/live) : les soldes RPC font foi.
 *  - token détenu on-chain sans position dans le carnet → adoption (lot au prix courant) ;
 *  - position dans le carnet avec solde on-chain nul → fermeture FIFO (PnL réalisé=0 coût) ;
 *  - sinon rien. SOL reste cash, USDC jamais adopté (base).
 */
export async function reconcileOnChain(
  db: DB,
  rpc: RpcClient,
  owner: string,
  market: { priceOf: (mint: string) => number | undefined; solPrice: number; decimalsOf: (mint: string) => number; symbolOf: (mint: string) => string },
  cfg: AppConfig,
  nowMs = Date.now(),
): Promise<ReconciliationLine[]> {
  const lamports = await rpc.getBalance(owner);
  void lamports;
  const accounts = await rpc.tokenAccounts(owner);
  const lines: ReconciliationLine[] = [];
  const ledger = new Map(listPositions(db, true).map((p) => [p.mint, p]));

  for (const t of accounts) {
    if (t.mint === USDC_MINT) {continue;}
    const price = market.priceOf(t.mint);
    if (price === undefined || !(price > 0)) {
      lines.push({ mint: t.mint, action: "none", line: `${market.symbolOf(t.mint)}: détenu on-chain mais pas de prix marché — adopté dans token_meta seulement` });
      upsertTokenMeta(db, { mint: t.mint, symbol: market.symbolOf(t.mint), decimals: t.decimals, isVerified: null, liquidityUsd: null, poolCreatedMs: null }, nowMs);
      continue;
    }
    const unitsQty = t.amount; // jsonParsed already scaled? No: raw units / 10^decimals
    const qty = t.amount / Math.pow(10, Math.max(0, t.decimals));
    void unitsQty;
    if (!(qty > 1e-9)) {continue;}
    const pos = getPosition(db, t.mint);
    if (!pos || pos.qty < qty - 1e-9) {
      const already = pos?.qty ?? 0;
      const delta = qty - already;
      if (delta <= 1e-9) {continue;}
      addLot(db, t.mint, market.symbolOf(t.mint), delta, price, nowMs);
      setStops(
        db,
        t.mint,
        price * (1 - cfg.risk.stop_loss_pct / 100),
        price * (1 + cfg.risk.take_profit_pct / 100),
      );
      lines.push({ mint: t.mint, action: "adopt", line: `${market.symbolOf(t.mint)}: adoption on-chain +${delta.toPrecision(6)} @ ${price.toPrecision(6)}$` });
      insertTrade(db, {
        tsMs: nowMs, mode: "live", strategy: "reconcile", mint: t.mint, symbol: market.symbolOf(t.mint),
        side: "buy", spendUsd: delta * price, qty: delta, priceUsd: price, expectedPriceUsd: price,
        status: "reconciled", reason: "adoption on-chain au démarrage",
      });
    }
  }
  for (const [mint, pos] of ledger) {
    if (mint === SOL_MINT) {continue;}
    const on = accounts.find((a) => a.mint === mint);
    const onQty = on ? on.amount / Math.pow(10, Math.max(0, on.decimals)) : 0;
    if (pos.qty > onQty + 1e-9) {
      const delta = pos.qty - onQty;
      const price = market.priceOf(mint);
      if (price === undefined || !(price > 0)) {
        lines.push({ mint, action: "none", line: `${market.symbolOf(mint)}: carnet ${pos.qty.toPrecision(6)} vs on-chain ${onQty.toPrecision(6)} — pas de prix, corriger manuellement` });
        continue;
      }
      const red = reducePositionFifo(db, mint, market.symbolOf(mint), delta, price, nowMs);
      insertTrade(db, {
        tsMs: nowMs, mode: "live", strategy: "reconcile", mint, symbol: market.symbolOf(mint),
        side: "sell", spendUsd: red.soldQty * price, qty: red.soldQty, priceUsd: price,
        expectedPriceUsd: price, realizedPnlUsd: red.realizedPnlUsd,
        status: "reconciled", reason: `fermeture FIFO au démarrage (on-chain fait foi, écart ${delta.toPrecision(6)})`,
      });
      lines.push({ mint, action: "close", line: `${market.symbolOf(mint)}: carnet ${pos.qty.toPrecision(6)} mais on-chain ${onQty.toPrecision(6)} → réduit de ${delta.toPrecision(6)} (PnL ${red.realizedPnlUsd.toFixed(4)}$)` });
    }
  }
  void getTokenMeta;
  return lines;
}

/** Enrichit l'objet price helpers depuis les ticks connus */
export function priceHelpersFrom(prices: Map<string, number>, solPrice: number, symbolOf: (mint: string) => string, decimalsOf: (mint: string) => number) {
  return {
    priceOf: (mint: string): number | undefined => (mint === USDC_MINT ? 1 : prices.get(mint)),
    solPrice,
    symbolOf,
    decimalsOf,
    solToUsd: (lamports: number) => (lamports / LAMPORTS_PER_SOL) * solPrice,
  };
}
