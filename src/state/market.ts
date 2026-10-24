import type { DB } from "./db.js";
import { tx, queryAll } from "./sql.js";

export interface Tick {
  ts: number;
  mint: string;
  price: number;
  liquidity: number | null;
  volumeDelta: number | null;
  /** origine du prix: découverte (fair quotes), bougie OHLCV pool (peut être une mule pumpée) ou quote Jupiter (independence de quota) */
  src?: QuoteSrc;
}

/** v12.4: quote Jupiter price v3 = source de mark indépendante de gecko (1 appel batch pour tous les lots) */
export type QuoteSrc = "discovery" | "candle" | "jup";

export interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ticks: number;
}

export interface AssetMeta {
  mint: string;
  symbol: string;
  decimals: number;
  isVerified: boolean | null;
  liquidityUsd: number | null;
  poolCreatedMs: number | null;
}

const EPS = 1e-9;

export function upsertTokenMeta(db: DB, meta: AssetMeta, ts: number): void {
  db.prepare(
    `INSERT INTO token_meta (mint, symbol, decimals, is_verified, liquidity_usd, pool_created_ms, updated_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mint) DO UPDATE SET
       symbol = excluded.symbol, decimals = excluded.decimals,
       is_verified = COALESCE(excluded.is_verified, token_meta.is_verified),
       liquidity_usd = COALESCE(excluded.liquidity_usd, token_meta.liquidity_usd),
       pool_created_ms = COALESCE(excluded.pool_created_ms, token_meta.pool_created_ms),
       updated_ms = excluded.updated_ms`,
  ).run(
    meta.mint,
    meta.symbol,
    meta.decimals,
    meta.isVerified ? 1 : 0,
    meta.liquidityUsd,
    meta.poolCreatedMs,
    ts,
  );
}

export function getTokenMeta(db: DB, mint: string): AssetMeta | null {
  const row = db.prepare("SELECT * FROM token_meta WHERE mint = ?").get(mint) as
    | {
        mint: string;
        symbol: string;
        decimals: number;
        is_verified: number | null;
        liquidity_usd: number | null;
        pool_created_ms: number | null;
      }
    | undefined;
  if (!row) {return null;}
  return {
    mint: row.mint,
    symbol: row.symbol,
    decimals: row.decimals,
    isVerified: row.is_verified === null ? null : row.is_verified === 1,
    liquidityUsd: row.liquidity_usd,
    poolCreatedMs: row.pool_created_ms,
  };
}

export function insertTicks(db: DB, ticks: Tick[]): void {
  const stmt = db.prepare(
    `INSERT INTO price_ticks (ts_ms, mint, price_usd, liquidity_usd, volume_delta_usd, src)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(ts_ms, mint) DO UPDATE SET
       price_usd = excluded.price_usd,
       liquidity_usd = excluded.liquidity_usd,
       volume_delta_usd = COALESCE(excluded.volume_delta_usd, price_ticks.volume_delta_usd),
       src = excluded.src`,
  );
  tx(db, () => {
    for (const t of ticks) {stmt.run(t.ts, t.mint, t.price, t.liquidity, t.volumeDelta, t.src ?? "discovery");}
  });
}

/** dernier prix discovery (source = feed, fair): contexte de garde pour les ventes du scalpeur. */
export function latestDiscoveryTick(db: DB, mint: string): { tsMs: number; price: number; liquidityUsd: number | null } | null {
  const row = db
    .prepare("SELECT ts_ms, price_usd, liquidity_usd FROM price_ticks WHERE mint = ? AND src = 'discovery' AND liquidity_usd > 0 ORDER BY ts_ms DESC LIMIT 1")
    .get(mint) as { ts_ms: number; price_usd: number; liquidity_usd: number | null } | undefined;
  return row ? { tsMs: row.ts_ms, price: row.price_usd, liquidityUsd: row.liquidity_usd } : null;
}


export function latestTickAnyAge(db: DB, mint: string): { tsMs: number; price: number; src?: QuoteSrc } | null {
  const row = db
    .prepare("SELECT ts_ms, price_usd, src FROM price_ticks WHERE mint = ? ORDER BY ts_ms DESC LIMIT 1")
    .get(mint) as { ts_ms: number; price_usd: number; src: string } | undefined;
  return row ? { tsMs: row.ts_ms, price: row.price_usd, src: row.src === "candle" ? "candle" : row.src === "jup" ? "jup" : "discovery" } : null;
}

/** Last tick per mint (latest ts). */
export function latestTicks(db: DB, ts: number, ms: number): Tick[] {  const rows = db
    .prepare(
      `SELECT ts_ms, mint, price_usd, liquidity_usd, volume_delta_usd
       FROM price_ticks WHERE ts_ms >= ? AND ts_ms <= ? GROUP BY mint
       HAVING ts_ms = MAX(ts_ms)`,
    )
    .all(ts - ms, ts) as {
    ts_ms: number;
    mint: string;
    price_usd: number;
    liquidity_usd: number | null;
    volume_delta_usd: number | null;
  }[];
  return rows.map((r) => ({
    ts: r.ts_ms,
    mint: r.mint,
    price: r.price_usd,
    liquidity: r.liquidity_usd,
    volumeDelta: r.volume_delta_usd,
  }));
}

const TF_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
};

export function tfMs(tf: string): number {
  const v = TF_MS[tf];
  if (!v) {throw new Error(`timeframe inconnu: ${tf}`);}
  return v;
}

/**
 * Degenerate candle aggregation: bucket = floor(ts / tfMs) - first tick opens,
 * subsequent ticks widen high/low and update close; volume accumulates.
 * Single statement upsert per candle (SQLite).
 */
export function upsertCandles(db: DB, tf: string, ts: number, ticks: Tick[]): Candle[] {
  const bucket = Math.floor(ts / tfMs(tf)) * tfMs(tf);
  const ins = db.prepare(
    `INSERT INTO candles (mint, tf, ts, open, high, low, close, volume_usd, ticks)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(mint, tf, ts) DO UPDATE SET
       high = MAX(candles.high, excluded.high),
       low = MIN(candles.low, excluded.low),
       close = excluded.close,
       volume_usd = candles.volume_usd + excluded.volume_usd,
       ticks = candles.ticks + 1`,
  );
  tx(db, () => {
    for (const t of ticks) {
      const vd = t.volumeDelta ?? 0;
      ins.run(t.mint, tf, bucket, t.price, t.price, t.price, t.price, Math.max(0, vd));
    }
  });
  return listCandles(db, bulletMints(ticks), tf, 1, bucket);
}

function bulletMints(ticks: Tick[]): string[] {
  return [...new Set(ticks.map((t) => t.mint))];
}

function rowToCandle(r: {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume_usd: number;
  ticks: number;
}): Candle {
  return {
    ts: r.ts,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume_usd,
    ticks: r.ticks,
  };
}

export function listCandles(
  db: DB,
  mints: string[],
  tf: string,
  limit: number,
  beforeTs: number,
): Candle[] {
  const placeholders = mints.map(() => "?").join(",");
  if (mints.length === 0) {return [];}
  const rows = queryAll<{
    ts: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume_usd: number;
    ticks: number;
  }>(
    db,
    `SELECT ts, open, high, low, close, volume_usd, ticks
       FROM candles WHERE mint IN (${placeholders}) AND tf = ? AND ts <= ? ORDER BY ts DESC LIMIT ?`,
    ...mints,
    tf,
    beforeTs,
    limit,
  );
  return rows.reverse().map(rowToCandle);
}

export function countCandles(db: DB, mint: string, tf: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM candles WHERE mint = ? AND tf = ?")
    .get(mint, tf) as { c: number } | undefined;
  return row?.c ?? 0;
}

/** Imported (GeckoTerminal) candles, separate table so live-built candles are never confused with history. */
export function upsertImportedCandles(
  db: DB,
  mint: string,
  tf: string,
  rows: { ts: number; open: number; high: number; low: number; close: number; volume: number }[],
): number {
  const ins = db.prepare(
    `INSERT INTO candles_imported (mint, tf, ts, open, high, low, close, volume_usd, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'geckoterminal')
     ON CONFLICT(mint, tf, ts) DO UPDATE SET
       open = excluded.open, high = excluded.high, low = excluded.low,
       close = excluded.close, volume_usd = excluded.volume_usd`,
  );
  try {
    tx(db, () => {
      for (const r of rows) {ins.run(mint, tf, r.ts, r.open, r.high, r.low, r.close, r.volume);}
    });
    return rows.length;
  } catch {
    return 0;
  }
}

export function countImportedCandles(db: DB, mint: string | null, tf: string): number {
  if (mint === null) {
    const row = db.prepare("SELECT COUNT(*) AS c FROM candles_imported WHERE tf = ?").get(tf) as {
      c: number;
    };
    return row.c;
  }
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM candles_imported WHERE mint = ? AND tf = ?")
    .get(mint, tf) as { c: number };
  return row.c;
}

/** Unified history view: imported candles prioritized where they overlap live ones. */
export function getHistoryCandles(
  db: DB,
  mint: string,
  tf: string,
  limit: number,
  beforeTs: number,
): Candle[] {
  const imported = db
    .prepare(
      `SELECT ts, open, high, low, close, volume_usd, 1 AS ticks
       FROM candles_imported WHERE mint = ? AND tf = ? AND ts <= ?
       ORDER BY ts DESC LIMIT ?`,
    )
    .all(mint, tf, beforeTs, limit) as {
    ts: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume_usd: number;
    ticks: number;
  }[];
  const live = listCandles(db, [mint], tf, limit, beforeTs);
  const merged = new Map<number, Candle>();
  for (const r of live) {merged.set(r.ts, r);}
  for (const r of imported) {
    if (!merged.has(r.ts)) {
      merged.set(r.ts, {
        ts: r.ts,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume_usd,
        ticks: r.ticks,
      });
    }
  }
  const all = [...merged.values()].sort((a, b) => a.ts - b.ts);
  return all.slice(-limit);
}

export function historyCoverage(db: DB, tf: string, fromTs: number, toTs: number): number {
  // fraction of expected buckets covered for the mint with the least coverage among those present
  const mints = db.prepare("SELECT DISTINCT mint FROM candles_imported WHERE tf = ?").all(tf) as {
    mint: string;
  }[];
  if (mints.length === 0) {return 0;}
  const expected = Math.floor((toTs - fromTs) / tfMs(tf)) + 1;
  let best = Infinity;
  const stmt = db.prepare(
    "SELECT COUNT(*) AS c FROM candles_imported WHERE mint = ? AND tf = ? AND ts >= ? AND ts <= ?",
  );
  for (const m of mints) {
    const row = stmt.get(m.mint, tf, fromTs, toTs) as { c: number };
    best = Math.min(best, row.c / checkPositive(expected));
  }
  return Number.isFinite(best) ? Math.max(0, Math.min(1, best)) : 0;
}

function checkPositive(n: number): number {
  return n > EPS ? n : 1;
}

/* ------------------------------ watchlist ------------------------------ */

export function upsertWatchlist(
  db: DB,
  mint: string,
  symbol: string,
  decimals: number,
  ts: number,
): void {
  db.prepare(
    `INSERT INTO watchlist (mint, symbol, decimals, added_ms) VALUES (?, ?, ?, ?)
     ON CONFLICT(mint) DO UPDATE SET symbol = excluded.symbol, decimals = excluded.decimals`,
  ).run(mint, symbol, decimals, ts);
}

export function watchlistBrief(db: DB): { mint: string; symbol: string; decimals: number }[] {
  return db
    .prepare("SELECT mint, symbol, decimals FROM watchlist ORDER BY added_ms, symbol")
    .all() as {
    mint: string;
    symbol: string;
    decimals: number;
  }[];
}
