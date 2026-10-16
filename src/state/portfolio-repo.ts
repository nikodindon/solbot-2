import type { DB } from "./db.js";
import { tx } from "./sql.js";

export interface Position {
  mint: string;
  symbol: string;
  qty: number;
  investedUsd: number;
  avgEntryUsd: number;
  realizedPnlUsd: number;
  peakPriceUsd: number | null;
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
  trailingStopPrice: number | null;
  openedMs: number;
  updatedMs: number;
}

function rowToPosition(r: {
  mint: string;
  symbol: string;
  qty: number;
  invested_usd: number;
  avg_entry_usd: number;
  realized_pnl_usd: number;
  peak_price_usd: number | null;
  stop_loss_price: number | null;
  take_profit_price: number | null;
  trailing_stop_price: number | null;
  opened_ms: number;
  updated_ms: number;
}): Position {
  return {
    mint: r.mint,
    symbol: r.symbol,
    qty: r.qty,
    investedUsd: r.invested_usd,
    avgEntryUsd: r.avg_entry_usd,
    realizedPnlUsd: r.realized_pnl_usd,
    peakPriceUsd: r.peak_price_usd,
    stopLossPrice: r.stop_loss_price,
    takeProfitPrice: r.take_profit_price,
    trailingStopPrice: r.trailing_stop_price,
    openedMs: r.opened_ms,
    updatedMs: r.updated_ms,
  };
}

export function listPositions(db: DB, nonZeroOnly = true): Position[] {
  const rows = db
    .prepare(`SELECT * FROM positions WHERE (? = 0 OR qty > 1e-9) ORDER BY opened_ms, mint`)
    .all(nonZeroOnly ? 1 : 0) as Parameters<typeof rowToPosition>[0][];
  return rows.map(rowToPosition);
}

export function getPosition(db: DB, mint: string): Position | null {
  const row = db.prepare("SELECT * FROM positions WHERE mint = ?").get(mint) as
    Parameters<typeof rowToPosition>[0] | undefined;
  return row ? rowToPosition(row) : null;
}

export interface OpenLotResult {
  position: Position;
  created: boolean;
}

/** Buy: add a lot (FIFO), recompute avg entry = invested/qty. Fees are included in `priceUsd` by the caller. */
export function addLot(
  db: DB,
  mint: string,
  symbol: string,
  qty: number,
  priceUsd: number,
  ts: number,
): OpenLotResult {
  if (!(qty > 0) || !(priceUsd > 0))
    {throw new Error(`addLot: entrées invalides qty=${qty} p=${priceUsd}`);}
  return tx(db, (): OpenLotResult => {
    db.prepare(
      "INSERT INTO position_lots (mint, ts_ms, qty, remaining, price_usd) VALUES (?, ?, ?, ?, ?)",
    ).run(mint, ts, qty, qty, priceUsd);
    const existing = getPosition(db, mint);
    if (!existing) {
      db.prepare(
        `INSERT INTO positions (mint, symbol, qty, invested_usd, avg_entry_usd, opened_ms, updated_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(mint, symbol, qty, qty * priceUsd, priceUsd, ts, ts);
    } else {
      db.prepare(
        `UPDATE positions SET qty = qty + ?, invested_usd = invested_usd + ?, symbol = ?, updated_ms = ?
         WHERE mint = ?`,
      ).run(qty, qty * priceUsd, symbol || existing.symbol, ts, mint);
      db.prepare("UPDATE positions SET avg_entry_usd = invested_usd / qty WHERE mint = ?").run(
        mint,
      );
    }
    return { position: getPosition(db, mint) as Position, created: !existing };
  });
}

export interface ReduceResult {
  position: Position | null; // null when fully closed
  realizedPnlUsd: number;
  soldQty: number;
  proceedsUsd: number; // net proceeds actually credited (after fees), qty × priceNet
}

/**
 * Sell: consume oldest open lots first. `priceUsd` is the realized sell price (fees already netted
 * by the caller into the credited proceeds: proceeds = qty × priceUsd).
 */
export function reducePositionFifo(
  db: DB,
  mint: string,
  symbol: string,
  qty: number,
  priceUsd: number,
  ts: number,
): ReduceResult {
  if (!(qty > 0) || !(priceUsd > 0))
    {throw new Error(`reduce: entrées invalides qty=${qty} p=${priceUsd}`);}
  return tx(db, (): ReduceResult => {
    let remaining = qty;
    let realized = 0;
    let sold = 0;
    const lots = db
      .prepare(
        "SELECT seq, remaining, price_usd FROM position_lots WHERE mint = ? AND remaining > 1e-9 ORDER BY seq",
      )
      .all(mint) as { seq: number; remaining: number; price_usd: number }[];
    for (const lot of lots) {
      if (remaining <= 1e-9) {break;}
      const take = Math.min(lot.remaining, remaining);
      if (!(take > 0)) {continue;}
      realized += take * (priceUsd - lot.price_usd);
      db.prepare(
        "UPDATE position_lots SET remaining = remaining - ?, closed_ms = ? WHERE seq = ?",
      ).run(take, lot.remaining - take < 1e-9 ? ts : null, lot.seq);
      remaining -= take;
      sold += take;
    }
    if (remaining > 1e-6) {
      // selling more than we track: clamp (reconciliation should prevent this)
      throw new Error(
        `reduce: pas assez de position ${mint} (demandé ${qty}, dispo ≈ ${sold.toFixed(9)})`,
      );
    }
    const pos = getPosition(db, mint);
    if (!pos) {throw new Error(`reduce: position inexistante ${mint}`);}
    // recompute invested from remaining lots to avoid float drift — single source of truth
    const rows = db
      .prepare("SELECT remaining, price_usd FROM position_lots WHERE mint = ? AND remaining > 1e-9")
      .all(mint) as { remaining: number; price_usd: number }[];
    let invested = 0;
    for (const l of rows) {invested += l.remaining * l.price_usd;}
    const newQty = Math.max(0, pos.qty - sold);
    const avg = newQty > 1e-9 ? invested / newQty : 0;
    if (newQty <= 1e-9) {
      db.prepare(
        `UPDATE positions SET qty = 0, invested_usd = 0, avg_entry_usd = 0, realized_pnl_usd = realized_pnl_usd + ?,
         symbol = ?, updated_ms = ? WHERE mint = ?`,
      ).run(realized, symbol, ts, mint);
      db.prepare("DELETE FROM positions WHERE mint = ?").run(mint);
      return {
        position: null,
        realizedPnlUsd: realized,
        soldQty: sold,
        proceedsUsd: sold * priceUsd,
      };
    }
    db.prepare(
      `UPDATE positions SET qty = ?, invested_usd = ?, avg_entry_usd = ?, realized_pnl_usd = realized_pnl_usd + ?,
       symbol = ?, updated_ms = ? WHERE mint = ?`,
    ).run(newQty, invested, avg, realized, symbol, ts, mint);
    return {
      position: getPosition(db, mint),
      realizedPnlUsd: realized,
      soldQty: sold,
      proceedsUsd: sold * priceUsd,
    };
  });
}

export function positionMark(db: DB, mint: string, priceUsd: number): void {
  const pos = getPosition(db, mint);
  if (!pos) {return;}
  const peak = pos.peakPriceUsd === null ? priceUsd : Math.max(pos.peakPriceUsd, priceUsd);
  if (peak !== pos.peakPriceUsd) {
    db.prepare("UPDATE positions SET peak_price_usd = ?, updated_ms = ? WHERE mint = ?").run(
      peak,
      Date.now(),
      mint,
    );
  }
}

export function setStops(
  db: DB,
  mint: string,
  stopLossPrice: number | null,
  takeProfitPrice: number | null,
): void {
  db.prepare(
    "UPDATE positions SET stop_loss_price = ?, take_profit_price = ?, updated_ms = ? WHERE mint = ?",
  ).run(stopLossPrice, takeProfitPrice, Date.now(), mint);
}

export function realizedPnlTotal(db: DB): number {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(realized_pnl_usd), 0) AS r FROM trades WHERE status IN ('filled','simulated')",
    )
    .get() as { r: number | null } | undefined;
  const posRow = db
    .prepare("SELECT COALESCE(SUM(realized_pnl_usd), 0) AS r FROM positions")
    .get() as { r: number | null } | undefined;
  // trades carry per-trade realized PnL (FIFO computed at reduce time); positions aggregate per mint.
  // Use the trades ledger when it has data, else fall back to positions.
  const t = row?.r ?? 0;
  if (t !== 0) {return t;}
  return posRow?.r ?? 0;
}
