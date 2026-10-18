import type { DB } from "./db.js";
import fs from "node:fs";
import path from "node:path";

/**
 * Versioned migrations. Each runs inside a transaction; never mutate a written migration.
 * Quantities/prices are REAL floats: at micro-capital scale ($<10 trades) float64 precision
 * (≈15-16 significant digits) is far above SOL's 9 decimals; comparisons use epsilon in repos.
 */
const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: "core-state",
    sql: `
      CREATE TABLE bot_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);

      CREATE TABLE token_meta (
        mint TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        decimals INTEGER NOT NULL,
        is_verified INTEGER,
        liquidity_usd REAL,
        pool_created_ms INTEGER,
        updated_ms INTEGER NOT NULL
      );

      CREATE TABLE price_ticks (
        ts_ms INTEGER NOT NULL,
        mint TEXT NOT NULL,
        price_usd REAL NOT NULL,
        liquidity_usd REAL,
        volume_delta_usd REAL,
        PRIMARY KEY (ts_ms, mint)
      );

      CREATE TABLE candles (
        mint TEXT NOT NULL,
        tf TEXT NOT NULL,
        ts INTEGER NOT NULL,
        open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
        volume_usd REAL NOT NULL DEFAULT 0,
        ticks INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (mint, tf, ts)
      );

      CREATE TABLE candles_imported (
        mint TEXT NOT NULL,
        tf TEXT NOT NULL,
        ts INTEGER NOT NULL,
        open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
        volume_usd REAL NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'geckoterminal',
        PRIMARY KEY (mint, tf, ts)
      );

      CREATE TABLE watchlist (
        mint TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        decimals INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        added_ms INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: "trading-ledger",
    sql: `
      CREATE TABLE trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts_ms INTEGER NOT NULL,
        mode TEXT NOT NULL,
        strategy TEXT NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,            -- buy | sell
        spend_usd REAL NOT NULL,       -- input notional (incl. fees)
        qty REAL NOT NULL,             -- token units traded
        price_usd REAL NOT NULL,       -- realized price (out/in)
        expected_price_usd REAL,
        slippage_bps REAL,
        jup_fee_usd REAL,
        fee_bps REAL,
        sol_fee REAL,                  -- base + priority fees paid, in SOL
        sol_fee_usd REAL,
        ata_rent_sol REAL,
        ata_rent_usd REAL,
        signature TEXT,
        realized_pnl_usd REAL,
        status TEXT NOT NULL,          -- filled | simulated | failed | simulated_no_rpc | failed_order
        reason TEXT,
        note TEXT
      );
      CREATE INDEX idx_trades_ts ON trades (ts_ms);
      CREATE INDEX idx_trades_mint ON trades (mint, ts_ms);

      CREATE TABLE positions (
        mint TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        qty REAL NOT NULL DEFAULT 0,
        invested_usd REAL NOT NULL DEFAULT 0,
        avg_entry_usd REAL NOT NULL DEFAULT 0,
        realized_pnl_usd REAL NOT NULL DEFAULT 0,
        peak_price_usd REAL,
        stop_loss_price REAL,
        take_profit_price REAL,
        trailing_stop_price REAL,
        opened_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL
      );

      CREATE TABLE position_lots (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        mint TEXT NOT NULL,
        ts_ms INTEGER NOT NULL,
        qty REAL NOT NULL,
        remaining REAL NOT NULL,
        price_usd REAL NOT NULL,       -- effective entry price (fees included)
        closed_ms INTEGER
      );
      CREATE INDEX idx_lots_mint ON position_lots (mint, seq);

      CREATE TABLE signals (
        ts_ms INTEGER NOT NULL,
        strategy TEXT NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        score REAL NOT NULL,
        edge_bps REAL,
        reason TEXT
      );
      CREATE INDEX idx_signals_ts ON signals (ts_ms);

      CREATE TABLE decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts_ms INTEGER NOT NULL,
        tick_id INTEGER NOT NULL,
        kind TEXT NOT NULL,            -- signal | reject | trade | error | allocation | regime | funding | kill | info
        strategy TEXT,
        mint TEXT,
        line TEXT NOT NULL,
        data TEXT
      );
      CREATE INDEX idx_decisions_id ON decisions (id);

      CREATE TABLE equity (
        ts_ms INTEGER NOT NULL,
        tick_id INTEGER NOT NULL,
        nav_usd REAL NOT NULL,
        cash_usd REAL NOT NULL,
        positions_usd REAL NOT NULL,
        realized_total_usd REAL NOT NULL,
        drawdown_pct REAL NOT NULL,
        benchmark_cash_usd REAL,
        benchmark_bh_usd REAL
      );

      CREATE TABLE shadow_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shadow TEXT NOT NULL,
        ts_ms INTEGER NOT NULL,
        mint TEXT NOT NULL,
        side TEXT NOT NULL,
        qty REAL NOT NULL,
        price_usd REAL NOT NULL,
        spend_usd REAL NOT NULL,
        fee_total_usd REAL NOT NULL,
        note TEXT
      );
      CREATE INDEX idx_shadow_trades ON shadow_trades (shadow, ts_ms);

      CREATE TABLE shadow_nav (
        shadow TEXT NOT NULL,
        ts_ms INTEGER NOT NULL,
        nav_usd REAL NOT NULL,
        PRIMARY KEY (shadow, ts_ms)
      );

      CREATE TABLE reconciliation (
        ts_ms INTEGER NOT NULL,
        action TEXT NOT NULL,
        mint TEXT NOT NULL,
        db_qty REAL,
        chain_qty REAL,
        note TEXT
      );
    `,
  },
  {
    // v3 : normalise candles_imported en ms. Les runs antérieurs au fix gecko ingestaient
    // des ts SECONDES (< 1.2e10) ; le standard DB est ms. Test sans ambiguïté (< 4e10).
    version: 3,
    name: "candles-imported-ts-ms",
    sql: `
      -- dupes first: même seconde déjà importée en ms ultérieurement
      DELETE FROM candles_imported WHERE ts < 40000000000 AND EXISTS (
        SELECT 1 FROM candles_imported c2
        WHERE c2.mint = candles_imported.mint AND c2.tf = candles_imported.tf AND c2.ts = candles_imported.ts * 1000
      );
      UPDATE candles_imported SET ts = ts * 1000 WHERE ts < 40000000000;
    `,
  },
  {
    version: 4,
    name: "price-ticks-src",
    sql: `
      ALTER TABLE price_ticks ADD COLUMN src TEXT NOT NULL DEFAULT 'discovery';
    `,
  },
];

export function currentVersion(db: DB): number {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_ms INTEGER)",
  );
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as
    { v: number | null } | undefined;
  return row?.v ?? 0;
}

export function migrate(db: DB): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_ms INTEGER)",
  );
  for (const m of MIGRATIONS) {
    const done = db
      .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
      .get(m.version) as unknown;
    if (done) {continue;}
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_ms) VALUES (?, ?, ?)").run(
        m.version,
        m.name,
        Date.now(),
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`migration v${m.version} (${m.name}) failed: ${String(err)}`);
    }
  }
}

/** Diagnostic helper for tests. */
export function tablesOf(db: DB): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

export function unlinkSqliteSidecarFile(p: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(path.join(p + suffix), { force: true });
    } catch {
      /* noop */
    }
  }
}
