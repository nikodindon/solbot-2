import { describe, it, expect } from "vitest";
import { parseConfigRaw } from "../../src/config/loader.js";
import { openDb, closeDb, type DB } from "../../src/state/db.js";
import { migrate } from "../../src/state/migrations.js";
import { upsertImportedCandles, upsertTokenMeta } from "../../src/state/market.js";
import { runBacktest } from "../../src/backtest/runner.js";
import { SOL_MINT } from "../../src/constants.js";

const DAY_MS = 86_400_000;
const TF_MS = 900_000;
const JUP = "JUPyiwrYJFUKUzgctMz2f8ahKkrgJqL86sBGDvCN";
const BONK = "DezXAZ8z7PnrnRJjz3fXBi1tBnVijayaHnzB263";

process.env["MODE"] = "test";

function cfg() {
  return parseConfigRaw({});
}

function seedCandles(db: DB, mints: string[], days: number): void {
  const n = Math.floor((days * DAY_MS) / TF_MS);
  const t0 = Date.now() - days * DAY_MS;
  const series: Record<string, (i: number) => number> = {
    // JUP : pente ascendante régulière (momentum attendu)
    [JUP]: (i) => 1 * Math.exp(0.0004 * i),
    // BONK : oscillation lente autour de 0.000025
    [BONK]: (i) => 0.000025 * (1 + 0.02 * Math.sin(i / 16)),
    [SOL_MINT]: (i) => 150 * Math.exp(0.00005 * i),
  };
  for (const m of mints) {
    const seriesFn = series[m];
    if (!seriesFn) {continue;}
    const bars = [];
    for (let i = 0; i < n; i++) {
      const ts = t0 + i * TF_MS;
      const seriesFn = series[m];
    if (!seriesFn) {continue;}
    const close = seriesFn(i);
      bars.push({ ts, open: close, high: close * 1.001, low: close * 0.999, close, volume: 20_000 });
    }
    upsertImportedCandles(db, m, "15m", bars);
  }
}

describe("backtest runner", () => {
  it("rejoue le moteur complet sur l'historique importé (mémoire only)", async () => {
    const db = openDb({ path: ":memory:", memory: true });
    migrate(db);
    seedCandles(db, [SOL_MINT, JUP, BONK], 20);
    const c = cfg();
    const res = await runBacktest(db, c);
    expect(res.steps).toBeGreaterThan(1000);
    expect(res.finalNav).toBeGreaterThan(0);
    expect(res.maxDrawdownPct).toBeGreaterThanOrEqual(0);
    expect(res.maxDrawdownPct).toBeLessThan(60);
    expect(res.trades).toBeGreaterThanOrEqual(0);
    expect(res.guard.minDays).toBe(c.backtest.guard_min_days);
    expect(res.guard.days).toBeGreaterThan(19);
    expect(res.guard.ok).toBe(true);
    closeDb(db);
  });

  it("garde non.concluant si l'historique est trop court", async () => {
    const db = openDb({ path: ":memory:", memory: true });
    migrate(db);
    seedCandles(db, [SOL_MINT, JUP, BONK], 7);
    const res = await runBacktest(db, cfg());
    expect(res.guard.days).toBeLessThan(10);
    expect(res.guard.ok).toBe(false);
    closeDb(db);
  });

  it("échoue proprement sans historique", async () => {
    const db = openDb({ path: ":memory:", memory: true });
    migrate(db);
    upsertTokenMeta(db, { mint: JUP, symbol: "JUP", decimals: 6, isVerified: true, liquidityUsd: 9e6, poolCreatedMs: 0 }, 0);
    await expect(runBacktest(db, cfg())).rejects.toThrow(/historique 15m insuffisant/);
    closeDb(db);
  });
});
