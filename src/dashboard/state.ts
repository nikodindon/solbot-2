import type { DB } from "../state/db.js";
import type { AppConfig, Mode } from "../config/schema.js";
import { buildSnapshot, paperCashGet, paperSolGet, benchmarkBuyHold } from "../portfolio/portfolio.js";
import { listTrades, cumRealizedPnl, costBreakdown } from "../state/trades.js";
import { listDecisions } from "../state/decisions.js";
import { equityCount } from "../state/equity.js";
import { latestTicks } from "../state/market.js";
import { kvGetJson } from "../state/kv.js";
import { tradeCount } from "../state/trades.js";
import fs from "node:fs";
import path from "node:path";
import { SOL_MINT, USDC_MINT } from "../constants.js";

export interface DashboardState {
  tsMs: number;
  clock: { tickId: number; intervalS: number };
  mode: Mode;
  fresh: boolean;
  nav: {
    usd: number;
    cashUsd: number;
    positionsUsd: number;
    realizedTotalUsd: number;
    drawdownPct: number;
    initialCapitalUsd: number;
    navPeakUsd: number;
    swapsRemaining: number;
  };
  portfolio: {
    positions: {
      mint: string;
      symbol: string;
      qty: number;
      avgEntryUsd: number;
      valueUsd: number;
      unrealizedPnlUsd: number;
      stopLossPrice: number | null;
      takeProfitPrice: number | null;
      trailingStopPrice: number | null;
      ageMs: number;
    }[];
    costs: { jupFeeUsd: number; solFeeUsd: number; ataRentUsd: number; realizedSlippageUsd: number };
  };
  allocation: { strategy: string | null; sinceMs: number | null };
  guards: {
    stopFile: boolean;
    killSwitchAtMs: number | null;
    pausedUntilMs: number | null;
    dailyLossLimitPct: number;
    daily: { anchorNavUsd: number; dropPct: number | null };
  };
  markets: { mint: string; symbol: string; priceUsd: number; liquidityUsd: number | null; lastTickMs: number }[];
  benchmarks: { cashUsd: number; bhUsd: number | null };
  counters: { tradesTotal: number; decisionsTotal: number; equityPoints: number };
}

/** Read-only API state (documented contract of /api/state) — no secrets. */
export function buildState(db: DB, cfg: AppConfig, mode: Mode, nowMs = Date.now()): DashboardState {
  const prices = new Map<string, number>();
  const ticks = latestTicks(db, nowMs, 120_000);
  for (const t of ticks) {
    prices.set(t.mint, t.price);
  }
  const mints = cfg.universe.tokens.map((t) => t.mint);
  for (const t of cfg.universe.tokens) {
    if (!prices.has(t.mint)) {
      prices.set(t.mint, 0);
    }
  }
  const snap = buildSnapshot(db, prices, {
    mode,
    paperCashUsdc: paperCashGet(db, cfg.paper_initial_usdc),
    paperSol: paperSolGet(db, cfg.paper_initial_sol),
    balances: null,
    solPrice: prices.get(SOL_MINT) ?? 0,
    usdcPrice: prices.get(USDC_MINT) || 1,
    risk: cfg.risk,
    nowMs,
  });
  const alloc = kvGetJson<string | null>(db, "allocatedStrategy", null);
  const allocSince = kvGetJson<number | null>(db, "allocatedSinceMs", null);
  const kill = kvGetJson<number | null>(db, "killSwitchAtMs", null);
  const paused = kvGetJson<number | null>(db, "dailyPausedUntilMs", null);
  const anchor = kvGetJson<{ day: number; navUsd: number } | null>(db, "dayAnchor", null);
  const dropPct = anchor && anchor.navUsd > 0 ? ((anchor.navUsd - snap.navUsd) / anchor.navUsd) * 100 : null;
  const lastActivity = Math.max(...[...ticks.map((t) => t.ts)], 0);
  const solPrice0 = kvGetJson<number | null>(db, "solPrice0", null);
  const equityPointsCount = equityCount(db);
  const lastEquityRow = lastEquityNav(db);
  void equityPointsCount;
  return {
    tsMs: nowMs,
    clock: { tickId: kvGetJson<number>(db, "tickCount", 0), intervalS: cfg.loop_interval_s },
    mode,
    fresh: lastActivity > 0 && nowMs - lastActivity < cfg.dashboard.stale_after_s * 1000,
    nav: {
      usd: snap.navUsd,
      cashUsd: snap.cashUsd,
      positionsUsd: snap.positionsUsd,
      realizedTotalUsd: cumRealizedPnl(db),
      drawdownPct: snap.drawdownPct,
      initialCapitalUsd: snap.initialCapitalUsd,
      navPeakUsd: snap.navPeakUsd,
      swapsRemaining: snap.swapsRemaining,
    },
    portfolio: {
      positions: snap.positions,
      costs: costBreakdown(db),
    },
    allocation: { strategy: alloc, sinceMs: allocSince },
    guards: {
      stopFile: fs.existsSync(path.join(process.cwd(), "data", "STOP")),
      killSwitchAtMs: kill,
      pausedUntilMs: paused,
      dailyLossLimitPct: cfg.risk.daily_loss_limit_pct,
      daily: { anchorNavUsd: anchor?.navUsd ?? snap.initialCapitalUsd, dropPct },
    },
    markets: [...mints, SOL_MINT].map((mint) => {
      const t = ticks.find((x) => x.mint === mint);
      const meta = cfg.universe.tokens.find((x) => x.mint === mint);
      return {
        mint,
        symbol: mint === SOL_MINT ? "SOL" : (meta?.symbol ?? mint),
        priceUsd: t?.price ?? 0,
        liquidityUsd: t?.liquidity ?? null,
        lastTickMs: t?.ts ?? 0,
      };
    }),
    benchmarks: {
      cashUsd: snap.initialCapitalUsd,
      bhUsd: lastEquityRow?.benchmarkBhUsd ?? benchmarkBuyHold(snap.initialCapitalUsd, prices.get(SOL_MINT) ?? 0, solPrice0),
    },
    counters: {
      tradesTotal: tradeCount(db),
      decisionsTotal: decisionCount(db),
      equityPoints: lastEquityRow === null ? 0 : equityPointsCount,
    },
  };
}

function lastEquityNav(db: DB): { navUsd: number; benchmarkBhUsd: number | null } | null {
  const row = db
    .prepare("SELECT nav_usd, benchmark_bh_usd FROM equity ORDER BY ts_ms DESC, tick_id DESC LIMIT 1")
    .get() as { nav_usd: number; benchmark_bh_usd: number | null } | undefined;
  return row ? { navUsd: row.nav_usd, benchmarkBhUsd: row.benchmark_bh_usd } : null;
}

function decisionCount(db: DB): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM decisions").get() as { c: number };
  return row.c;
}

export interface SeriesPoint {
  tsMs: number;
  navUsd: number;
  cashUsd: number;
  benchmarkCashUsd: number | null;
  benchmarkBhUsd: number | null;
}

export function equitySeries(db: DB, limit = 2_000): SeriesPoint[] {
  const rows = db
    .prepare("SELECT ts_ms, nav_usd, cash_usd, benchmark_cash_usd, benchmark_bh_usd FROM equity ORDER BY ts_ms DESC, tick_id DESC LIMIT ?")
    .all(limit) as {
    ts_ms: number;
    nav_usd: number;
    cash_usd: number;
    benchmark_cash_usd: number | null;
    benchmark_bh_usd: number | null;
  }[];
  return rows.reverse().map((r) => ({
    tsMs: r.ts_ms,
    navUsd: r.nav_usd,
    cashUsd: r.cash_usd,
    benchmarkCashUsd: r.benchmark_cash_usd,
    benchmarkBhUsd: r.benchmark_bh_usd,
  }));
}

export function tradeList(db: DB, limit = 100): (ReturnType<(typeof listTrades)>[number])[] {
  return listTrades(db, { limit, status: ["filled", "simulated", "failed", "failed_order"] });
}

export function decisionList(
  db: DB,
  opts: { limit?: number; kind?: string[]; mint?: string; strategy?: string } = {},
) {
  return listDecisions(db, opts);
}

export function shadowOverview(db: DB, nowMs = Date.now()): {
  shadow: string;
  navUsd: number | null;
  nav24hAgo: number | null;
  score24hUsd: number | null;
  trades24h: number;
  allocated: boolean | null;
}[] {
  const alloc = kvGetJson<string | null>(db, "allocatedStrategy", null);
  const rows = db
    .prepare("SELECT DISTINCT shadow FROM shadow_nav")
    .all() as { shadow: string }[];
  const since = nowMs - 24 * 3_600_000;
  return rows.map((r) => {
    const navRow = db
      .prepare("SELECT nav_usd FROM shadow_nav WHERE shadow = ? ORDER BY ts_ms DESC LIMIT 1")
      .get(r.shadow) as { nav_usd: number } | undefined;
    const navThen = db
      .prepare("SELECT nav_usd FROM shadow_nav WHERE shadow = ? AND ts_ms <= ? ORDER BY ts_ms DESC LIMIT 1")
      .get(r.shadow, since) as { nav_usd: number } | undefined;
    const navFirst = navThen
      ? null
      : (db
          .prepare("SELECT nav_usd FROM shadow_nav WHERE shadow = ? ORDER BY ts_ms ASC LIMIT 1")
          .get(r.shadow) as { nav_usd: number } | undefined);
    const cnt = (
      db
        .prepare("SELECT COUNT(*) AS c FROM shadow_trades WHERE shadow = ? AND ts_ms >= ?")
        .get(r.shadow, since) as { c: number }
    ).c;
    return {
      shadow: r.shadow,
      navUsd: navRow?.nav_usd ?? null,
      nav24hAgo: navThen?.nav_usd ?? navFirst?.nav_usd ?? null,
      score24hUsd: navRow && (navThen ?? navFirst) ? navRow.nav_usd - (navThen ?? navFirst)!.nav_usd : null,
      trades24h: cnt,
      allocated: alloc === null ? null : alloc === r.shadow,
    };
  });
}
