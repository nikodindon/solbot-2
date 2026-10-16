import type { DB } from "./db.js";

import { queryAll } from "./sql.js";
export interface TradeRecord {
  id?: number;
  tsMs: number;
  mode: string;
  strategy: string;
  mint: string;
  symbol: string;
  side: "buy" | "sell";
  spendUsd: number; // input notional incl. fees for; for sells = qty×net price and fees broken out
  qty: number;
  priceUsd: number;
  expectedPriceUsd?: number | null;
  slippageBps?: number | null;
  jupFeeUsd?: number | null;
  feeBps?: number | null;
  solFee?: number | null;
  solFeeUsd?: number | null;
  ataRentSol?: number | null;
  ataRentUsd?: number | null;
  signature?: string | null;
  realizedPnlUsd?: number | null;
  status:
    "filled" | "simulated" | "failed" | "simulated_no_rpc" | "failed_order" | "reconciled" | "open";
  reason?: string | null;
  note?: string | null;
}

interface TradeRow {
  id: number;
  ts_ms: number;
  mode: string;
  strategy: string;
  mint: string;
  symbol: string;
  side: string;
  spend_usd: number;
  qty: number;
  price_usd: number;
  expected_price_usd: number | null;
  slippage_bps: number | null;
  jup_fee_usd: number | null;
  fee_bps: number | null;
  sol_fee: number | null;
  sol_fee_usd: number | null;
  ata_rent_sol: number | null;
  ata_rent_usd: number | null;
  signature: string | null;
  realized_pnl_usd: number | null;
  status: string;
  reason: string | null;
  note: string | null;
}

function rowToTrade(r: TradeRow): TradeRecord {
  return {
    id: r.id,
    tsMs: r.ts_ms,
    mode: r.mode,
    strategy: r.strategy,
    mint: r.mint,
    symbol: r.symbol,
    side: r.side as "buy" | "sell",
    spendUsd: r.spend_usd,
    qty: r.qty,
    priceUsd: r.price_usd,
    expectedPriceUsd: r.expected_price_usd,
    slippageBps: r.slippage_bps,
    jupFeeUsd: r.jup_fee_usd,
    feeBps: r.fee_bps,
    solFee: r.sol_fee,
    solFeeUsd: r.sol_fee_usd,
    ataRentSol: r.ata_rent_sol,
    ataRentUsd: r.ata_rent_usd,
    signature: r.signature,
    realizedPnlUsd: r.realized_pnl_usd,
    status: r.status as TradeRecord["status"],
    reason: r.reason,
    note: r.note,
  };
}

export function insertTrade(db: DB, t: TradeRecord): number {
  const info = db
    .prepare(
      `INSERT INTO trades
       (ts_ms, mode, strategy, mint, symbol, side, spend_usd, qty, price_usd,
        expected_price_usd, slippage_bps, jup_fee_usd, fee_bps, sol_fee, sol_fee_usd,
        ata_rent_sol, ata_rent_usd, signature, realized_pnl_usd, status, reason, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      t.tsMs,
      t.mode,
      t.strategy,
      t.mint,
      t.symbol,
      t.side,
      t.spendUsd,
      t.qty,
      t.priceUsd,
      t.expectedPriceUsd ?? null,
      t.slippageBps ?? null,
      t.jupFeeUsd ?? null,
      t.feeBps ?? null,
      t.solFee ?? null,
      t.solFeeUsd ?? null,
      t.ataRentSol ?? null,
      t.ataRentUsd ?? null,
      t.signature ?? null,
      t.realizedPnlUsd ?? null,
      t.status,
      t.reason ?? null,
      t.note ?? null,
    );
  return Number(info.lastInsertRowid);
}

export function listTrades(
  db: DB,
  opts: { limit?: number; status?: string[]; mint?: string } = {},
): TradeRecord[] {
  const limit = opts.limit ?? 200;
  let sql = "SELECT * FROM trades";
  const wh: string[] = [];
  const args: (string | number)[] = [];
  if (opts.status && opts.status.length > 0) {
    wh.push(`status IN (${opts.status.map(() => "?").join(",")})`);
    args.push(...opts.status);
  }
  if (opts.mint) {
    wh.push("mint = ?");
    args.push(opts.mint);
  }
  if (wh.length > 0) {sql += " WHERE " + wh.join(" AND ");}
  sql += " ORDER BY ts_ms DESC, id DESC LIMIT ?";
  args.push(limit);
  const rows = queryAll<TradeRow>(db, sql, ...args);
  return rows.map(rowToTrade).reverse();
}

export function tradeCount(db: DB, statuses?: string[]): number {
  if (statuses && statuses.length > 0) {
    const rows = db
      .prepare(
        `SELECT COUNT(*) AS c FROM trades WHERE status IN (${statuses.map(() => "?").join(",")})`,
      )
      .get(...statuses) as { c: number };
    return rows.c;
  }
  const row = db.prepare("SELECT COUNT(*) AS c FROM trades").get() as { c: number };
  return row.c;
}

export interface CostBreakdown {
  jupFeeUsd: number;
  solFeeUsd: number;
  ataRentUsd: number;
  realizedSlippageUsd: number; // signed: positive = lost on slippage
}

export function costBreakdown(db: DB, sinceMs?: number): CostBreakdown {
  const rows = db
    .prepare(
      `SELECT jup_fee_usd, sol_fee_usd, ata_rent_usd, slippage_bps, spend_usd, expected_price_usd, price_usd
       FROM trades WHERE status IN ('filled','simulated') ${sinceMs ? "AND ts_ms >= ?" : ""}`,
    )
    .all(...(sinceMs ? [sinceMs] : [])) as {
    jup_fee_usd: number | null;
    sol_fee_usd: number | null;
    ata_rent_usd: number | null;
    slippage_bps: number | null;
    spend_usd: number;
    expected_price_usd: number | null;
    price_usd: number;
  }[];
  const out: CostBreakdown = { jupFeeUsd: 0, solFeeUsd: 0, ataRentUsd: 0, realizedSlippageUsd: 0 };
  for (const r of rows) {
    out.jupFeeUsd += r.jup_fee_usd ?? 0;
    out.solFeeUsd += r.sol_fee_usd ?? 0;
    out.ataRentUsd += r.ata_rent_usd ?? 0;
    out.realizedSlippageUsd += slipCostUsd(r);
  }
  return out;
}

function slipCostUsd(r: {
  slippage_bps: number | null;
  spend_usd: number;
  expected_price_usd: number | null;
  price_usd: number;
}): number {
  if (r.expected_price_usd !== null && r.expected_price_usd !== undefined && r.spend_usd > 0) {
    // (-) quantity expected vs realized at same spend => price drift
    const drift = (r.price_usd - r.expected_price_usd) / r.expected_price_usd;
    return drift * r.spend_usd; // positive = paid more than expected (loss)
  }
  return 0;
}

export function cumRealizedPnl(db: DB): number {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(realized_pnl_usd),0) AS r FROM trades WHERE status IN ('filled','simulated')",
    )
    .get() as { r: number };
  return row.r;
}
