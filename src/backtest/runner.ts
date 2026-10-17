import type { DB } from "../state/db.js";
import type { AppConfig } from "../config/schema.js";
import { openDb, closeDb, type DB as WorkDb } from "../state/db.js";
import { migrate } from "../state/migrations.js";
import { upsertTokenMeta, upsertImportedCandles, countImportedCandles } from "../state/market.js";
import { paperCashSet } from "../portfolio/portfolio.js";
import { buildStrategies } from "../strategy/registry.js";
import { RiskManager } from "../risk/risk-manager.js";
import { Executor } from "../execution/executor.js";
import { tradeCount, costBreakdown } from "../state/trades.js";
import { listEquity } from "../state/equity.js";
import { Engine, type MarketFeed, type EngineDeps } from "../engine/engine.js";
import { SOL_MINT } from "../constants.js";
import type { Logger } from "../utils/logger.js";

const DAY_MS = 86_400_000;
const STRAT_TF = "15m";

export interface BacktestResult {
  fromTs: number;
  toTs: number;
  steps: number;
  trades: number;
  initialUsdc: number;
  finalNav: number;
  pnlUsd: number;
  pnlPct: number;
  maxDrawdownPct: number;
  buyHoldUsd: number | null;
  costs: { jupFeeUsd: number; solFeeUsd: number; realizedSlippageUsd: number };
  guard: { ok: boolean; days: number; coverageDays: number; minDays: number; positivePnlRequired: boolean; positivePnl: boolean };
}

export interface BacktestDeps {
  log?: Logger;
}

interface Sample {
  ts: number;
  prices: Map<string, number>;
}

/** Feed de replay : avance dans la série de bougies 15m importées (pas de réseau). */
class ReplayFeed implements MarketFeed {
  private idx = 0;
  private readonly prices = new Map<string, number>();
  constructor(private readonly samples: Sample[]) {}

  async pollOnce(_ts = Date.now()): Promise<{ ok: boolean; prices: Map<string, number>; error?: string }> {
    const s = this.samples[this.idx];
    this.idx += 1;
    if (!s) {
      return { ok: false, prices: new Map(this.prices), error: "historique épuisé" };
    }
    for (const [m, p] of s.prices) {this.prices.set(m, p);}
    return { ok: true, prices: new Map(this.prices) };
  }
}

/**
 * Backtest qui rejoue le MÊME moteur (Engine complet : régimes, sorties, shadows,
 * RiskManager, executor paper filling) sur l'historique 15m déjà importé
 * (`candles_imported`). DB de travail en mémoire — la DB principale n'est pas modifiée.
 */
export async function runBacktest(srcDb: DB, cfg: AppConfig, deps: BacktestDeps = {}): Promise<BacktestResult> {
  const mints = cfg.universe.tokens.map((t) => t.mint);
  const work = openDb({ path: ":memory:", memory: true });
  try {
    migrate(work);
    // recopie l'historique importé + les métadonnées
    for (const m of mints) {
      const meta = srcDb
        .prepare("SELECT symbol, decimals, is_verified, liquidity_usd, pool_created_ms FROM token_meta WHERE mint=?")
        .get(m) as { symbol: string; decimals: number; is_verified: number | null; liquidity_usd: number | null; pool_created_ms: number | null } | undefined;
      upsertTokenMeta(
        work,
        {
          mint: m,
          symbol: meta?.symbol ?? m.slice(0, 4),
          decimals: meta?.decimals ?? cfg.universe.tokens.find((t) => t.mint === m)?.decimals ?? 6,
          isVerified: meta?.is_verified === 1 ? true : meta?.is_verified === 0 ? false : null,
          liquidityUsd: meta?.liquidity_usd ?? null,
          poolCreatedMs: meta?.pool_created_ms ?? null,
        },
        0,
      );
    }
    const solMeta = srcDb.prepare("SELECT symbol, decimals FROM token_meta WHERE mint=?").get(SOL_MINT) as { symbol: string; decimals: number } | undefined;
    upsertTokenMeta(work, { mint: SOL_MINT, symbol: solMeta?.symbol ?? "SOL", decimals: solMeta?.decimals ?? 9, isVerified: true, liquidityUsd: null, poolCreatedMs: null }, 0);
    // recopie l'historique importé (candles_imported) pour chaque mint demandé
    const srcMints = [...mints, SOL_MINT].filter((m, i, a) => a.indexOf(m) === i);
    for (const m of srcMints) {
      const rows = srcDb
        .prepare(`SELECT ts, open, high, low, close, volume_usd FROM candles_imported WHERE mint = ? AND tf = ? ORDER BY ts ASC`)
        .all(m, STRAT_TF) as { ts: number; open: number; high: number; low: number; close: number; volume_usd: number }[];
      if (rows.length > 0) {
        upsertImportedCandles(
          work,
          m,
          STRAT_TF,
          rows.map((c) => ({
            // défense pare-chocs: bougies seconds (runs antérieurs) → ms
            ts: c.ts < 40_000_000_000 ? c.ts * 1000 : c.ts,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume_usd,
          })),
        );
      }
    }

    const samples = buildSamples(work, mints);
    if (samples.length < 10) {
      throw new Error("backtest: historique 15m insuffisant (lancer `npm run backtest` après import/backfill)");
    }
    paperCashSet(work, cfg.backtest.initial_usdc);

    const built = buildStrategies(cfg.strategies);
    const risk = new RiskManager(cfg.risk, {
      edgeMultiplier: cfg.costs.edge_multiplier,
      expectedSlippageBps: cfg.costs.expected_slippage_bps,
      paperFillSlippageBps: 0,
    });
    const executor = new Executor(
      { db: work, mode: "paper", cfg, swapApi: null, rpc: null, signer: null },
      deps.log ?? noop(),
    );
    const engine = new Engine(
      {
        db: work,
        cfg,
        mode: "paper",
        rootDir: "/tmp",
        feed: new ReplayFeed(samples),
        executor,
        risk,
        strategies: built.map((b) => ({ strategy: b.strategy, weight: b.weight })),
        log: deps.log ?? noop(),
      } satisfies EngineDeps,
      {},
    );

    // pas de bougie SOL dans les samples tiers → liquidité tiers par défaut (cap de risque seul)
    for (const s of samples) {
      await engine.runTick(s.ts);
    }

    const equity = listEquity(work, 0).sort((a, b) => a.tsMs - b.tsMs || a.tickId - b.tickId);
    const navs = equity.map((e) => e.navUsd);
    // NAV de départ réellement observée (inclut le wallet SOL gaz virtuel seedé)
    const initial = navs.length > 0 ? navs[0] ?? cfg.backtest.initial_usdc : cfg.backtest.initial_usdc;
    const finalNav = navs.length > 0 ? navs[navs.length - 1] ?? initial : initial;
    let peak = initial;
    let maxDd = 0;
    for (const nav of navs) {
      if (nav > peak) {peak = nav;}
      if (peak > 0) {maxDd = Math.max(maxDd, (peak - nav) / peak);}
    }
    const costs = costBreakdown(work);
    const buyHold = equity.length > 0 ? equity[equity.length - 1]?.benchmarkCashUsd ?? null : null;
    const fromTs = samples[0]?.ts ?? 0;
    const toTs = samples[samples.length - 1]?.ts ?? 0;
    const days = (toTs - fromTs) / DAY_MS;
    const coverageDays = Math.min(...srcMints.map((m) => countImportedCandles(work, m, STRAT_TF))) * (900_000 / DAY_MS);
    const pnlUsd = finalNav - initial;
    const positivePnl = pnlUsd > 0;
    const guard = {
      ok: days >= cfg.backtest.guard_min_days && (!cfg.backtest.guard_require_positive_net_pnl || positivePnl),
      days: Number(days.toFixed(2)),
      coverageDays: Number(coverageDays.toFixed(2)),
      minDays: cfg.backtest.guard_min_days,
      positivePnlRequired: cfg.backtest.guard_require_positive_net_pnl,
      positivePnl,
    };
    return {
      fromTs,
      toTs,
      steps: samples.length,
      trades: tradeCount(work),
      initialUsdc: initial,
      finalNav,
      pnlUsd,
      pnlPct: (pnlUsd / initial) * 100,
      maxDrawdownPct: maxDd * 100,
      buyHoldUsd: buyHold,
      costs: {
        jupFeeUsd: costs.jupFeeUsd,
        solFeeUsd: costs.solFeeUsd,
        realizedSlippageUsd: costs.realizedSlippageUsd,
      },
      guard,
    };
  } finally {
    closeDb(work);
  }
}

/** Bougies → samples de prix par ts (liquidité : volume 15m comme proxy honnête). */
function buildSamples(db: WorkDb, mints: string[]): Sample[] {
  const byTs = new Map<number, { mints: Map<string, number>; volumes: Map<string, number> }>();
  for (const m of mints) {
    const rows = db
      .prepare(`SELECT ts, close, volume_usd FROM candles_imported WHERE mint=? AND tf='${STRAT_TF}' ORDER BY ts ASC`)
      .all(m) as { ts: number; close: number; volume_usd: number }[];
    for (const r of rows) {
      let bucket = byTs.get(r.ts);
      if (!bucket) {
        bucket = { mints: new Map(), volumes: new Map() };
        byTs.set(r.ts, bucket);
      }
      bucket.mints.set(m, r.close);
      bucket.volumes.set(m, r.volume_usd);
    }
  }
  const solRows = db
    .prepare(`SELECT ts, close FROM candles_imported WHERE mint=? AND tf='${STRAT_TF}' ORDER BY ts ASC`)
    .all(SOL_MINT) as { ts: number; close: number }[];
  for (const r of solRows) {
    let bucket = byTs.get(r.ts);
    if (!bucket) {
      bucket = { mints: new Map(), volumes: new Map() };
      byTs.set(r.ts, bucket);
    }
    bucket.mints.set(SOL_MINT, r.close);
  }
  const out: Sample[] = [];
  for (const [ts, b] of [...byTs.entries()].sort((a, c) => a[0] - c[0])) {
    if (b.mints.size === 0 || !(b.mints.get(SOL_MINT) ?? 0 > 0)) {continue;}
    void b.volumes;
    out.push({ ts, prices: b.mints });
  }
  return out;
}

function noop(): Logger {
  const sink = () => {};
  return {
    info: sink,
    warn: sink,
    error: sink,
    debug: sink,
    child: () => noop(),
  };
}
