import { createRuntime, type StartOpts } from "./start.js";
import { runBacktest, type BacktestResult } from "../backtest/runner.js";
import { GeckoBackfiller, geckoDefaults } from "../market/gecko.js";
import { kvSetJson } from "../state/kv.js";
import { countImportedCandles } from "../state/market.js";
import { SOL_MINT } from "../constants.js";

export interface BacktestOpts extends StartOpts {
  days?: number;
}

/**
 * `backtest` : backfill (Gecko) l'historique 15m manquant puis rejoue le moteur complet
 * en paper-filling déterministe ; verdict stocké en kv pour le garde live.
 */
export async function runBacktestCmd(opts: BacktestOpts = {}): Promise<string> {
  const rt = await createRuntime(opts);
  try {
    const mints = [...rt.cfg.universe.tokens.map((t) => t.mint), SOL_MINT];
    const needDays = opts.days ?? 30;
    let imported = 0;
    for (const m of mints) {
      imported += countImportedCandles(rt.db, m, "15m");
    }
    if (imported < mints.length * (needDays * 96) * 0.8) {
      if (!process.env["GECKO_API_KEY"]) {
        rt.log.warn({}, "GECKO_API_KEY absente — l'OHLCV GeckoTerminal exige une clé démo gratuite (register coingecko.com)");
      }
      const gecko = new GeckoBackfiller(rt.db, { ...geckoDefaults(), apiKey: process.env["GECKO_API_KEY"] ?? null });
      for (const m of mints) {
        try {
          const n = await gecko.backfillToken(m, "15m", needDays);
          rt.log.info({ candles: n }, "backfill");
        } catch (err) {
          rt.log.warn({ err: err instanceof Error ? err.message : String(err) }, "backfill partiel");
        }
      }
    }
    const res = await runBacktest(rt.db, rt.cfg, { log: rt.log });
    kvSetJson(rt.db, "backtestVerdict", { ok: res.guard.ok, at: Date.now(), freq: res.guard.days });
    return formatBacktest(res);
  } finally {
    await rt.shutdown();
  }
}

export function formatBacktest(res: BacktestResult): string {
  const d = (ts: number) => new Date(ts).toISOString().slice(0, 10);
  const lines = [
    `backtest ${d(res.fromTs)} → ${d(res.toTs)} (${res.guard.days} j, ${res.steps} pas 15m)`,
    `NAV finale : ${res.finalNav.toFixed(4)}$ sur ${res.initialUsdc}$ initial (${res.pnlUsd >= 0 ? "+" : ""}${res.pnlUsd.toFixed(4)}$ / ${res.pnlPct.toFixed(2)} %)`,
    `max drawdown : ${res.maxDrawdownPct.toFixed(1)} % · trades : ${res.trades} · buy&hold : ${res.buyHoldUsd === null ? "n/a" : `${res.buyHoldUsd.toFixed(4)}$`}`,
    `coûts cumulés : JUP ${res.costs.jupFeeUsd.toFixed(4)}$ · SOL ${res.costs.solFeeUsd.toFixed(4)}$ · slippage réalisé ${res.costs.realizedSlippageUsd.toFixed(4)}$`,
    `garde : ${res.guard.ok ? "CONCLUANT" : "NON CONCLUANT"} (jours ${res.guard.days} ≥ ${res.guard.minDays}${res.guard.positivePnlRequired ? `, PnL ${res.guard.positivePnl ? ">" : "<"} 0 requis` : " ; PnL>0 non requis"})`,
  ];
  return lines.join("\n");
}
