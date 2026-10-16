import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type DB } from "../../src/state/db.js";
import { migrate } from "../../src/state/migrations.js";
import { parseConfigRaw } from "../../src/config/loader.js";
import { buildStrategies, type BuiltStrategy } from "../../src/strategy/registry.js";
import { RiskManager } from "../../src/risk/risk-manager.js";
import { Executor } from "../../src/execution/executor.js";
import { Engine, type MarketFeed } from "../../src/engine/engine.js";
import { listDecisions } from "../../src/state/decisions.js";
import { listEquity } from "../../src/state/equity.js";
import { listTrades } from "../../src/state/trades.js";
import { getPosition } from "../../src/state/portfolio-repo.js";
import { upsertImportedCandles } from "../../src/state/market.js";
import { SOL_MINT, JUP_MINT, BONK_MINT, USDC_MINT } from "../../src/constants.js";

const DAY = 15 * 60_000;

function setupRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solbot2-eng-"));
  const cfgDir = path.join(dir, "config");
  if (!fs.existsSync(cfgDir)) {fs.mkdirSync(cfgDir, { recursive: true });}
  fs.writeFileSync(path.join(cfgDir, "config.example.yaml"), "");
  return dir;
}

type Prices = Record<string, number>;

interface Harness {
  db: DB;
  engine: Engine;
  executor: Executor;
  cfg: ReturnType<typeof parseConfigRaw>;
  built: BuiltStrategy[];
}

function flatBars(n: number, endTs: number, price: number): { ts: number; open: number; high: number; low: number; close: number; volume: number }[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: endTs - (n - 1 - i) * DAY,
    open: price,
    high: price * 1.002,
    low: price * 0.998,
    close: price,
    volume: 50_000,
  }));
}

async function harness(root: string, prices: Prices, seedBars = 120): Promise<Harness> {
  const db = openDb({ path: ":memory:", memory: true });
  migrate(db);
  const now = Date.now();
  for (const [mint] of [["SOL", SOL_MINT], ["JUP", JUP_MINT], ["BONK", BONK_MINT]] as [string, string][]) {
    const price = mint === "SOL" ? (prices[SOL_MINT] ?? 150) : mint === "JUP" ? (prices[JUP_MINT] ?? 1) : (prices[BONK_MINT] ?? 0.000025);
    upsertImportedCandles(db, mint, "15m", flatBars(seedBars, now - DAY, price));
  }
  const cfg = { ...parseConfigRaw({ mode: "paper" }), paper_initial_usdc: 6 };
  const feed: MarketFeed = {
    pollOnce: async () => ({
      ok: true,
      prices: new Map([
        [SOL_MINT, prices[SOL_MINT] ?? 150],
        [USDC_MINT, 1],
        [JUP_MINT, prices[JUP_MINT] ?? 1],
        [BONK_MINT, prices[BONK_MINT] ?? 0.000025],
      ]),
    }),
  };
  const logger = { warn: () => {}, info: () => {}, error: () => {} };
  const executor = new Executor({ db, mode: "paper", cfg, swapApi: null, rpc: null, signer: null }, logger);
  const rm = new RiskManager(cfg.risk, {
    edgeMultiplier: cfg.costs.edge_multiplier,
    expectedSlippageBps: cfg.costs.expected_slippage_bps,
    paperFillSlippageBps: cfg.costs.paper_fill_slippage_bps,
  });
  const built = buildStrategies(cfg.strategies);
  const engine = new Engine(
    {
      db,
      cfg,
      mode: "paper",
      rootDir: root,
      feed,
      executor,
      risk: rm,
      strategies: built.map((b) => ({ strategy: b.strategy, weight: b.weight })),
      log: logger,
    },
    {},
  );
  return { db, engine, executor, cfg, built };
}

describe("engine — intégration", () => {
  it("tick calme: NAV, régimes, journal de décisions, equity, shadow nav", async () => {
    const root = setupRoot();
    try {
      const h = await harness(root, { [SOL_MINT]: 150, [JUP_MINT]: 1, [BONK_MINT]: 0.000025 });
      const report = await h.engine.runTick();
      expect(report.ok).toBe(true);
      expect(report.navUsd).toBeGreaterThan(0);
      expect(report.skipped).toBe(false);
      const dec = listDecisions(h.db, { limit: 50 });
      expect(dec.some((d) => d.kind === "regime")).toBe(true);
      expect(dec.some((d) => d.kind === "allocation" || d.kind === "info")).toBe(true);
      const points = listEquity(h.db);
      expect(points.length).toBeGreaterThanOrEqual(1);
      expect(points[0]!.navUsd).toBeCloseTo(6, 1); // 6$ cash, pas de position → NAV 6
      expect(points[0]!.benchmarkBhUsd).not.toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("stop-loss à ±6%: position fermée, perte journalisée, trade 'exit' enregistré", async () => {
    const root = setupRoot();
    try {
      const h = await harness(root, { [SOL_MINT]: 150, [JUP_MINT]: 1.05, [BONK_MINT]: 0.000025 });
      const buy = await h.executor.execute({
        mint: JUP_MINT,
        symbol: "JUP",
        side: "buy",
        strategy: "seed",
        priceUsd: 1.05,
        solPrice: 150,
        liquidityUsd: 2_000_000,
        spendUsd: 2,
        edgeEstimateBps: 5_000,
        reason: "seed",
        stopLossPct: 6,
        takeProfitPct: 12,
        needsAta: true,
        decimals: 6,
      });
      expect(buy.ok).toBe(true);
      const pos = getPosition(h.db, JUP_MINT);
      expect(pos).not.toBeNull();
      expect(pos!.stopLossPrice).toBeCloseTo(0.987, 6);
      // prix déjà sous le SL ce tick
      const h2 = await harness2(root, h.db, { [SOL_MINT]: 150, [JUP_MINT]: 0.96, [BONK_MINT]: 0.000025 }, h.built, h.cfg);
      const report = await h2.runTick();
      expect(report.executed.sells).toBe(1);
      expect(getPosition(h.db, JUP_MINT)).toBeNull();
      const sell = listTrades(h.db, {}).find((t) => t.side === "sell");
      expect(sell?.realizedPnlUsd).toBeLessThan(0);
      const dec = listDecisions(h.db, { kind: ["trade"] });
      expect(dec.some((d) => d.line.includes("VENTE") || d.line.includes("SORTIE"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("1 trade en vol: runTick concurrent est skip (pas de secondes exécutions)", async () => {
    const root = setupRoot();
    try {
      const h = await harness(root, { [SOL_MINT]: 150, [JUP_MINT]: 1, [BONK_MINT]: 0.000025 });
      const [a, b] = await Promise.all([h.engine.runTick(), h.engine.runTick()]);
      const skippedCount = [a, b].filter((x) => x.skipped).length;
      expect(skippedCount).toBe(1);
      expect([a, b].some((x) => x.ok)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

/** Variante: même db mais feed à d'autres prix (simulation d'un tick suivant). */
async function harness2(root: string, db: DB, prices: Prices, built: BuiltStrategy[], cfg: Harness["cfg"]): Promise<Engine> {
  const feed: MarketFeed = {
    pollOnce: async () => ({
      ok: true,
      prices: new Map([
        [SOL_MINT, prices[SOL_MINT] ?? 150],
        [USDC_MINT, 1],
        [JUP_MINT, prices[JUP_MINT] ?? 1],
        [BONK_MINT, prices[BONK_MINT] ?? 0.000025],
      ]),
    }),
  };
  const logger = { warn: () => {}, info: () => {}, error: () => {} };
  const executor = new Executor({ db, mode: "paper", cfg, swapApi: null, rpc: null, signer: null }, logger);
  return new Engine(
    {
      db,
      cfg,
      mode: "paper",
      rootDir: root,
      feed,
      executor,
      risk: new RiskManager(cfg.risk, {
        edgeMultiplier: cfg.costs.edge_multiplier,
        expectedSlippageBps: cfg.costs.expected_slippage_bps,
        paperFillSlippageBps: cfg.costs.paper_fill_slippage_bps,
      }),
      strategies: built.map((b) => ({ strategy: b.strategy, weight: b.weight })),
      log: logger,
    },
    {},
  );
}
