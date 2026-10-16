import type { DB } from "./db.js";

export interface EquityPoint {
  tsMs: number;
  tickId: number;
  navUsd: number;
  cashUsd: number;
  positionsUsd: number;
  realizedTotalUsd: number;
  drawdownPct: number;
  benchmarkCashUsd?: number | null;
  benchmarkBhUsd?: number | null;
}

export function insertEquity(db: DB, p: EquityPoint): void {
  db.prepare(
    `INSERT INTO equity (ts_ms, tick_id, nav_usd, cash_usd, positions_usd, realized_total_usd, drawdown_pct,
       benchmark_cash_usd, benchmark_bh_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    p.tsMs,
    p.tickId,
    p.navUsd,
    p.cashUsd,
    p.positionsUsd,
    p.realizedTotalUsd,
    p.drawdownPct,
    p.benchmarkCashUsd ?? null,
    p.benchmarkBhUsd ?? null,
  );
}

export function listEquity(db: DB, sinceTs = 0): EquityPoint[] {
  const rows = db
    .prepare("SELECT * FROM equity WHERE ts_ms >= ? ORDER BY ts_ms ASC")
    .all(sinceTs) as {
    ts_ms: number;
    tick_id: number;
    nav_usd: number;
    cash_usd: number;
    positions_usd: number;
    realized_total_usd: number;
    drawdown_pct: number;
    benchmark_cash_usd: number | null;
    benchmark_bh_usd: number | null;
  }[];
  return rows.map((r) => ({
    tsMs: r.ts_ms,
    tickId: r.tick_id,
    navUsd: r.nav_usd,
    cashUsd: r.cash_usd,
    positionsUsd: r.positions_usd,
    realizedTotalUsd: r.realized_total_usd,
    drawdownPct: r.drawdown_pct,
    benchmarkCashUsd: r.benchmark_cash_usd,
    benchmarkBhUsd: r.benchmark_bh_usd,
  }));
}

export function equityCount(db: DB): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM equity").get() as { c: number };
  return row.c;
}

/* ------------------------------ shadows ------------------------------ */

export interface ShadowTrade {
  id?: number;
  shadow: string;
  tsMs: number;
  mint: string;
  side: "buy" | "sell";
  qty: number;
  priceUsd: number;
  spendUsd: number;
  feeTotalUsd: number;
  note?: string | null;
}

export function insertShadowTrade(db: DB, t: ShadowTrade): void {
  db.prepare(
    "INSERT INTO shadow_trades (shadow, ts_ms, mint, side, qty, price_usd, spend_usd, fee_total_usd, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    t.shadow,
    t.tsMs,
    t.mint,
    t.side,
    t.qty,
    t.priceUsd,
    t.spendUsd,
    t.feeTotalUsd,
    t.note ?? null,
  );
}

export function insertShadowNav(db: DB, shadow: string, tsMs: number, navUsd: number): void {
  db.prepare(
    "INSERT INTO shadow_nav (shadow, ts_ms, nav_usd) VALUES (?, ?, ?) ON CONFLICT(shadow, ts_ms) DO UPDATE SET nav_usd = excluded.nav_usd",
  ).run(shadow, tsMs, navUsd);
}

export interface ShadowState {
  shadow: string;
  cashUsd: number;
  holdings: { mint: string; qty: number; avgEntryUsd: number }[];
  realizedPnlUsd: number;
}

/**
 * Rebuild a shadow state from its trade history (FIFO over all history — a few kB, computed on
 * allocation evaluation or restart).
 */
export function loadShadowState(db: DB, shadow: string, initialCashUsd: number): ShadowState {
  const rows = db
    .prepare(
      `SELECT ts_ms, mint, side, qty, price_usd, spend_usd
       FROM shadow_trades WHERE shadow = ? ORDER BY ts_ms, id`,
    )
    .all(shadow) as {
    ts_ms: number;
    mint: string;
    side: string;
    qty: number;
    price_usd: number;
    spend_usd: number;
  }[];
  const open: { mint: string; ts: number; qty: number; price: number; remaining: number }[] = [];
  let cash = initialCashUsd;
  let realized = 0;
  for (const r of rows) {
    if (r.side === "buy") {
      cash -= r.spend_usd;
      open.push({ mint: r.mint, ts: r.ts_ms, qty: r.qty, price: r.price_usd, remaining: r.qty });
    } else {
      cash += r.spend_usd;
      let remaining = r.qty;
      for (const lot of open) {
        if (remaining <= 1e-9) {break;}
        if (lot.mint !== r.mint) {continue;}
        const take = Math.min(lot.remaining, remaining);
        realized += take * (r.price_usd - lot.price);
        lot.remaining -= take;
        remaining -= take;
      }
    }
  }
  const agg = new Map<string, { qty: number; cost: number }>();
  for (const lot of open) {
    if (lot.remaining <= 1e-9) {continue;}
    const cur = agg.get(lot.mint) ?? { qty: 0, cost: 0 };
    cur.qty += lot.remaining;
    cur.cost += lot.remaining * lot.price;
    agg.set(lot.mint, cur);
  }
  const holdings = [...agg.entries()]
    .filter(([, v]) => v.qty > 1e-9)
    .map(([mint, v]) => ({ mint, qty: v.qty, avgEntryUsd: v.qty > 0 ? v.cost / v.qty : 0 }));
  return { shadow, cashUsd: cash, holdings, realizedPnlUsd: realized };
}

export function realizedShadowPnlWindow(db: DB, shadow: string, sinceTs: number): number {
  const rows = db
    .prepare(
      `SELECT ts_ms, mint, side, qty, price_usd, spend_usd
       FROM shadow_trades WHERE shadow = ? AND ts_ms >= ? ORDER BY ts_ms`,
    )
    .all(shadow, sinceTs) as {
    ts_ms: number;
    mint: string;
    side: string;
    qty: number;
    price_usd: number;
    spend_usd: number;
  }[];
  // FIFO within window across all mints
  const open: { ts: number; mint: string; qty: number; price: number; remaining: number }[] = [];
  let realized = 0;
  for (const r of rows) {
    if (r.side === "buy") {
      open.push({ ts: r.ts_ms, mint: r.mint, qty: r.qty, price: r.price_usd, remaining: r.qty });
    } else {
      let remaining = r.qty;
      for (const lot of open) {
        if (remaining <= 1e-9) {break;}
        if (lot.mint !== r.mint) {continue;}
        const take = Math.min(lot.remaining, remaining);
        realized += take * (r.price_usd - lot.price);
        lot.remaining -= take;
        remaining -= take;
      }
    }
  }
  return realized;
}

export function shadowTradeCountWindow(db: DB, shadow: string, sinceTs: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM shadow_trades WHERE shadow = ? AND ts_ms >= ?")
    .get(shadow, sinceTs) as { c: number };
  return row.c;
}

export function shutdownCleanupShadow(db: DB, shadow: string): void {
  db.prepare("DELETE FROM shadow_trades WHERE shadow = ?").run(shadow);
  db.prepare("DELETE FROM shadow_nav WHERE shadow = ?").run(shadow);
}
