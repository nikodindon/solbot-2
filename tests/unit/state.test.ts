import { describe, expect, it } from "vitest";
import { openDb } from "../../src/state/db.js";
import { migrate, currentVersion, tablesOf } from "../../src/state/migrations.js";
import { addLot, reducePositionFifo, getPosition } from "../../src/state/portfolio-repo.js";
import { insertTrade, listTrades, costBreakdown, cumRealizedPnl } from "../../src/state/trades.js";
import { insertDecision, listDecisions } from "../../src/state/decisions.js";
import { insertEquity, listEquity } from "../../src/state/equity.js";
import { insertTicks, upsertCandles, listCandles, tfMs } from "../../src/state/market.js";
import { kvGetJson, kvSetJson } from "../../src/state/kv.js";

const SOL = "So11111111111111111111111111111111111111112";

describe("state", () => {
  it("migrations idempotentes", () => {
    const db = openDb({ path: ":memory:" });
    migrate(db);
    migrate(db);
    expect(currentVersion(db)).toBeGreaterThanOrEqual(2);
    expect(tablesOf(db)).toContain("positions");
    db.close();
  });

  it("FIFO : deux lots, sortie partielle puis totale, PnL net de frais dans lad base", () => {
    const db = openDb({ path: ":memory:" });
    migrate(db);
    // lot 1: 0.5 @ 100 (facturé 100$ avec 1$ de frais déjà inclus -> prix effectif 102)
    addLot(db, SOL, "SOL", 0.5, 102, 1000);
    // lot 2: 0.5 @ 104 (0.5*104=52 investi)
    addLot(db, SOL, "SOL", 0.5, 104, 2000);
    let pos = getPosition(db, SOL);
    expect(pos).not.toBeNull();
    expect(pos!.qty).toBeCloseTo(1.0, 9);
    expect(pos!.avgEntryUsd).toBeCloseTo(103, 6);

    // vente partielle 0.3 @ 110 (net de frais)
    let r = reducePositionFifo(db, SOL, "SOL", 0.3, 110, 3000);
    expect(r.soldQty).toBeCloseTo(0.3, 9);
    expect(r.realizedPnlUsd).toBeCloseTo(0.3 * (110 - 102), 9);
    expect(getPosition(db, SOL)!.qty).toBeCloseTo(0.7, 9);

    // vente totale 0.7 @ 105
    r = reducePositionFifo(db, SOL, "SOL", 0.7, 105, 4000);
    // FIFO: 0.2 du lot 1 (110-102 déjà réalisée au-dessus, reste 0.2*8) + 0.5 lot 2 (0.2*(110-102)+... )
    // lots restants après 1re vente : lot1 0.2 @102, lot2 0.5@104
    // PnL 2e vente = 0.2*(105-102) + 0.5*(105-104) = 0.6 + 0.5 = 1.1
    expect(r.realizedPnlUsd).toBeCloseTo(0.2 * (105 - 102) + 0.5 * (105 - 104), 9);
    expect(getPosition(db, SOL)).toBeNull();
  });

  it("refuse de vendre plus que la position", () => {
    const db = openDb({ path: ":memory:" });
    migrate(db);
    addLot(db, SOL, "SOL", 0.1, 100, 1000);
    expect(() => reducePositionFifo(db, SOL, "SOL", 0.2, 100, 2000)).toThrow();
  });

  it("trades : insertion, listing, coût, PnL réalisé", () => {
    const db = openDb({ path: ":memory:" });
    migrate(db);
    insertTrade(db, {
      tsMs: 1000,
      mode: "paper",
      strategy: "momentum",
      mint: SOL,
      symbol: "SOL",
      side: "buy",
      spendUsd: 2.0,
      qty: 0.018,
      priceUsd: 105.123,
      expectedPriceUsd: 105,
      slippageBps: 12,
      jupFeeUsd: 0.004,
      solFeeUsd: 0.003,
      status: "simulated",
    });
    insertTrade(db, {
      tsMs: 2000,
      mode: "paper",
      strategy: "momentum",
      mint: SOL,
      symbol: "SOL",
      side: "sell",
      spendUsd: 2.05,
      qty: 0.018,
      priceUsd: 110,
      realizedPnlUsd: 0.08,
      status: "simulated",
    });
    const all = listTrades(db);
    expect(all.length).toBe(2);
    expect(all[0]!.side).toBe("buy");
    expect(cumRealizedPnl(db)).toBeCloseTo(0.08, 9);
    const cd = costBreakdown(db);
    expect(cd.jupFeeUsd).toBeCloseTo(0.004, 9);
    expect(cd.solFeeUsd).toBeCloseTo(0.003, 9);
  });

  it("decisions & equity", () => {
    const db = openDb({ path: ":memory:" });
    migrate(db);
    insertDecision(db, {
      tsMs: 1,
      tickId: 1,
      kind: "reject",
      mint: SOL,
      strategy: "momentum",
      line: "SOL: momentum 0.62, edge 38 bps < seuil 45 bps -> pas d'entrée",
    });
    const rows = listDecisions(db);
    expect(rows[0]!.line).toContain("38 bps");
    insertEquity(db, {
      tsMs: 1,
      tickId: 1,
      navUsd: 6,
      cashUsd: 6,
      positionsUsd: 0,
      realizedTotalUsd: 0,
      drawdownPct: 0,
    });
    const eq = listEquity(db);
    expect(eq[0]!.navUsd).toBe(6);
  });

  it("candles : agrégation dégénérée sur plusieurs ticks", () => {
    const db = openDb({ path: ":memory:" });
    migrate(db);
    const TF = "15m";
    const ts0 = tfMs(TF) * 10;
    insertTicks(db, [
      { ts: ts0 + 5_000, mint: SOL, price: 100, liquidity: 1e6, volumeDelta: 50 },
      { ts: ts0 + 65_000, mint: SOL, price: 101, liquidity: 1e6, volumeDelta: 30 },
      { ts: ts0 + 125_000, mint: SOL, price: 99, liquidity: 1e6, volumeDelta: 10 },
    ]);
    upsertCandles(db, TF, ts0 + 5_000, [{ ts: ts0 + 5_000, mint: SOL, price: 100, liquidity: 1e6, volumeDelta: 50 }]);
    upsertCandles(db, TF, ts0 + 65_000, [{ ts: ts0 + 65_000, mint: SOL, price: 101, liquidity: 1e6, volumeDelta: 30 }]);
    upsertCandles(db, TF, ts0 + 125_000, [{ ts: ts0 + 125_000, mint: SOL, price: 99, liquidity: 1e6, volumeDelta: 10 }]);
    const cs = listCandles(db, [SOL], TF, 10, ts0 + tfMs(TF) * 2);
    // les 3 ticks tombent dans le même bucket 15m -> une seule bougie
    expect(cs.length).toBe(1);
    expect(cs[0]!.open).toBe(100);
    expect(cs[0]!.close).toBe(99);
    expect(cs[0]!.high).toBe(101);
    expect(cs[0]!.low).toBe(99);
    expect(cs[0]!.volume).toBeCloseTo(90, 6);
    expect(cs[0]!.ticks).toBe(3);
  });

  it("kv json", () => {
    const db = openDb({ path: ":memory:" });
    migrate(db);
    kvSetJson(db, "navPeak", { v: 6.12 });
    expect(kvGetJson(db, "navPeak", { v: 0 })).toEqual({ v: 6.12 });
    expect(kvGetJson(db, "absent", { v: 1 })).toEqual({ v: 1 });
  });
});
