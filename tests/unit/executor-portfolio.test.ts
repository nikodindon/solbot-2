import { describe, expect, it } from "vitest";
import { openDb } from "../../src/state/db.js";
import { migrate } from "../../src/state/migrations.js";
import { appConfigSchema } from "../../src/config/schema.js";
import { Executor, type TradeIntent } from "../../src/execution/executor.js";
import { getPosition } from "../../src/state/portfolio-repo.js";
import { listTrades, costBreakdown } from "../../src/state/trades.js";
import { paperCashGet, buildSnapshot, benchmarkBuyHold } from "../../src/portfolio/portfolio.js";
import { JUP_MINT } from "../../src/constants.js";

type Cfg = ReturnType<typeof appConfigSchema.parse>;

function mkIntent(p: Partial<TradeIntent> = {}): TradeIntent {
  return {
    mint: JUP_MINT,
    symbol: "JUP",
    side: "buy",
    strategy: "test",
    priceUsd: 1,
    solPrice: 150,
    liquidityUsd: 2_000_000,
    spendUsd: 2,
    edgeEstimateBps: 2000,
    reason: "test",
    stopLossPct: 6,
    takeProfitPct: 12,
    needsAta: true,
    decimals: 6,
    ...p,
  };
}

async function setup(mode: "paper" | "dry_run" | "live" = "paper") {
  const db = openDb({ path: ":memory:", memory: true });
  migrate(db);
  const cfg = appConfigSchema.parse({}) as Cfg;
  const ex = new Executor(
    { db, mode, cfg, swapApi: null, rpc: null, signer: null },
    { info: () => {}, warn: () => {}, error: () => {} },
  );
  return { db, ex, cfg };
}

describe("executor paper", () => {
  it("achat: fill net de frais, lot ajouté, cash décrémenté, rent ATA facturée", async () => {
    const { db, ex, cfg } = await setup();
    const res = await ex.execute(mkIntent());
    expect(res.ok).toBe(true);
    expect(res.status).toBe("simulated");
    const pos = getPosition(db, JUP_MINT);
    expect(pos).not.toBeNull();
    expect(pos!.qty).toBeLessThan(2); // slippage + frais déjà dans le fill
    expect(pos!.avgEntryUsd).toBeGreaterThan(1);
    const cash = paperCashGet(db, cfg.paper_initial_usdc);
    expect(cash).toBeCloseTo(
      cfg.paper_initial_usdc - (res.spendUsd as number) - ((res.trade?.ataRentUsd as number) ?? 0),
      6,
    );
  });

  it("vente: FIFO, PnL réalisé >0 sur +10%, lots consommés, cash crédité", async () => {
    const { db, ex, cfg } = await setup();
    const buy = await ex.execute(mkIntent());
    const sell = await ex.execute(
      mkIntent({ side: "sell", qty: buy.qty, spendUsd: 0, priceUsd: 1.1 }),
    );
    expect(sell.ok).toBe(true);
    expect(sell.realizedPnlUsd).toBeGreaterThan(0);
    expect(sell.proceedsUsd).toBeGreaterThan(0);
    expect(getPosition(db, JUP_MINT)).toBeNull();
    const trades = listTrades(db);
    expect(trades.some((t) => t.side === "sell" && t.realizedPnlUsd)).toBe(true);
    expect(paperCashGet(db, cfg.paper_initial_usdc)).toBeGreaterThan(cfg.paper_initial_usdc - 2);
    const costs = costBreakdown(db);
    expect(costs.solFeeUsd).toBeGreaterThan(0);
    // frais Jupiter JUP↔USDC = 0 bps (paire Jupiter) mais décomposés quand même
    expect(costs.jupFeeUsd).toBeCloseTo(0, 9);
  });

  it("vente sans quantité → échec propre", async () => {
    const { ex } = await setup();
    const r = await ex.execute(mkIntent({ side: "sell", qty: 0 }));
    expect(r.ok).toBe(false);
    expect(r.status).toBe("failed");
  });

  it("stops posés à l'achat", async () => {
    const { db, ex } = await setup();
    await ex.execute(mkIntent());
    const pos = getPosition(db, JUP_MINT)!;
    expect(pos.stopLossPrice).toBeCloseTo(0.94, 9);
    expect(pos.takeProfitPrice).toBeCloseTo(1.12, 9);
  });
});

describe("portefeuille NAV", () => {
  it("mark-to-market: cash + positions; SOL paper traité équivalent cash", async () => {
    const { db, ex, cfg } = await setup();
    await ex.execute(mkIntent({ spendUsd: 2.5, needsAta: false }));
    const snap = buildSnapshot(
      db,
      new Map([[JUP_MINT, 1.2]]),
      {
        mode: "paper",
        paperCashUsdc: 3,
        solPrice: 150,
        usdcPrice: 1,
        risk: cfg.risk,
        nowMs: Date.now(),
      },
    );
    const jup = getPosition(db, JUP_MINT)!;
    expect(snap.navUsd).toBeCloseTo(3 + jup.qty * 1.2, 6);
    expect(snap.positions).toHaveLength(1);
    expect(snap.positions[0]!.unrealizedPnlUsd).toBeGreaterThan(0);
    expect(snap.initialCapitalUsd).toBeCloseTo(snap.navUsd, 6);
    expect(snap.drawdownPct).toBe(0);
  });

  it("benchmark B&H suit le ratio de prix SOL", () => {
    expect(benchmarkBuyHold(6, 165, 150)).toBeCloseTo(6.6, 9);
    expect(benchmarkBuyHold(6, 165, null)).toBe(6);
    expect(benchmarkBuyHold(6, 165, 0)).toBe(6);
  });
});
