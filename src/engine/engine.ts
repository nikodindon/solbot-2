import fs from "node:fs";
import path from "node:path";
import type { DB } from "../state/db.js";
import type { AppConfig, Mode } from "../config/schema.js";
import { classifyRegime, type RegimeResult } from "../market/regime.js";
import { getHistoryCandles, getTokenMeta } from "../state/market.js";
import { getPosition, positionMark, setTrailingStopPrice } from "../state/portfolio-repo.js";
import {
  buildSnapshot,
  benchmarkBuyHold,
  paperCashGet,
  paperSolGet,
  type PortfolioSnapshot,
  type SnapshotOpts,
} from "../portfolio/portfolio.js";
import { insertDecision, insertSignal, type DecisionRecord } from "../state/decisions.js";
import { insertEquity } from "../state/equity.js";
import { kvGetJson, kvSetJson } from "../state/kv.js";
import { cumRealizedPnl } from "../state/trades.js";
import type { RiskManager, RiskFlags, RiskPortfolioState } from "../risk/risk-manager.js";
import type { Executor, TradeIntent } from "../execution/executor.js";
import { arbitrate, type Candidate, type Scored } from "../strategy/arbitration.js";
import type { Strategy, Signal, StrategyPortfolio, StrategyEval } from "../strategy/types.js";
import { checkExits, type ExitDecision, type ExitCtx } from "./exits.js";
import { runShadows } from "./shadow.js";
import { SOL_MINT, USDC_MINT } from "../constants.js";

export interface MarketFeed {
  /** Rafraîchit les prix du marché (ticks éventuels gérés côté feed). */
  pollOnce(ts: number): Promise<{ ok: boolean; prices: Map<string, number>; error?: string }>;
}

export interface EngineDeps {
  db: DB;
  cfg: AppConfig;
  mode: Mode;
  rootDir: string;
  feed: MarketFeed;
  executor: Executor;
  risk: RiskManager;
  strategies: { strategy: Strategy; weight: number }[];
  log: {
    info: (o: object, m?: string) => void;
    warn: (o: object, m?: string) => void;
    error: (o: object, m?: string) => void;
  };
}

export interface TickReport {
  tsMs: number;
  tickId: number;
  skipped: boolean;
  ok: boolean;
  error?: string;
  navUsd: number | null;
  cashUsd: number | null;
  executed: { buys: number; sells: number };
  allocation: string | null;
  riskBlocked: string | null;
}

export interface EngineEvents {
  onDecision?: (d: DecisionRecord) => void;
}

const STRAT_TF = "15m";
const DAY_MS = 86_400_000;

/**
 * Engine — un tick = marché → régimes par actif → NAV/comptabilité → sorties (priorité
 * absolue : SL/TP/trailing, signaux de sortie, régime idle) → shadows (portefeuilles
 * fantômes + allocation par hystérésis) → entrée (meilleur signal de la stratégie
 * allouée → RiskManager → executor, 1 trade en vol à la fois) → journal + equity.
 */
export class Engine {
  private busy = false;
  private tickId: number;
  private readonly stopPath: string;

  constructor(
    private readonly deps: EngineDeps,
    private readonly events: EngineEvents = {},
  ) {
    this.tickId = kvGetJson<number>(deps.db, "tickCount", 0);
    this.stopPath = path.join(deps.rootDir, "data", "STOP");
  }

  isBusy(): boolean {
    return this.busy;
  }

  async runTick(nowMs = Date.now()): Promise<TickReport> {
    if (this.busy) {
      return {
        tsMs: nowMs,
        tickId: this.tickId,
        skipped: true,
        ok: false,
        navUsd: null,
        cashUsd: null,
        executed: { buys: 0, sells: 0 },
        allocation: null,
        riskBlocked: null,
      };
    }
    this.busy = true;
    const decisions: DecisionRecord[] = [];
    const { db, cfg } = this.deps;
    try {
      const tickId = ++this.tickId;
      kvSetJson(db, "tickCount", tickId);
      const rec: (d: Omit<DecisionRecord, "tsMs" | "tickId">) => void = (d) => {
        const full: DecisionRecord = { ...d, tsMs: nowMs, tickId };
        decisions.push(full);
        this.events.onDecision?.(full);
      };

      // 1) marché
      const poll = await this.deps.feed.pollOnce(nowMs);
      if (!poll.ok) {
        this.deps.log.warn({ err: poll.error ?? "?" }, "market feed failure");
        rec({ kind: "error", line: `marché indisponible: ${poll.error ?? "?"} — tick passé sans décision` });
        return this.done(nowMs, { ok: false, error: poll.error, navUsd: null, cashUsd: null, executed: { buys: 0, sells: 0 }, allocation: null, riskBlocked: null }, decisions);
      }
      const prices = poll.prices;

      // 2) régimes par actif
      const regimes = new Map<string, RegimeResult>();
      for (const mint of this.assetMints()) {
        const bars = getHistoryCandles(db, mint, STRAT_TF, 400, nowMs);
        const r = classifyRegime(bars, this.regimeCfg());
        regimes.set(mint, r);
        rec({ kind: "regime", mint, line: this.regimeLine(mint, r) });
      }

      // 3) NAV + comptabilité + garde-fous globaux
      const solPrice = prices.get(SOL_MINT) ?? 0;
      const solUsdIsNeeded = solPrice > 0;
      const snapOpts = this.snapshotOpts(prices, nowMs);
      let snap = buildSnapshot(db, prices, snapOpts);
      const daily = this.dailyAnchor(snap, nowMs);
      for (const line of daily.lines) {rec({ kind: "kill", line });}
      const stopFile = fs.existsSync(this.stopPath);
      if (stopFile) {rec({ kind: "kill", line: "fichier STOP présent → aucune entrée tant qu'il existe" });}
      const killSwitch = snap.drawdownPct >= cfg.risk.kill_switch_max_drawdown_pct;
      if (killSwitch && kvGetJson<number | null>(db, "killSwitchAtMs", null) === null) {
        kvSetJson(db, "killSwitchAtMs", nowMs);
        rec({ kind: "kill", line: `KILL-SWITCH: drawdown ${snap.drawdownPct.toFixed(1)}% ≥ ${cfg.risk.kill_switch_max_drawdown_pct}% — plus d'entrées jusqu'à redémarrage ou rm data/STOP` });
      }
      // marque les prix sur les positions (peaks pour le trailing)
      for (const p of snap.positions) {
        const price = prices.get(p.mint);
        if (price !== undefined && price > 0) {
          positionMark(db, p.mint, price);
          this.persistTrailingIfActivated(p.mint, price, p.avgEntryUsd, p.peakPriceUsd);
        }
      }
      void solUsdIsNeeded;

      // 4) sorties — priorité absolue sur les positions ouvertes
      const executed = { buys: 0, sells: 0 };
      const ctxByMint = new Map<string, ExitCtx>();
      for (const [mint, r] of regimes) {
        const pos = getPosition(db, mint);
        const price = prices.get(mint) ?? 0;
        if (pos && price > 0) {
          ctxByMint.set(mint, { price, unrealizedPnlUsd: pos.qty * price - pos.investedUsd, regime: r.regime });
        }
      }
      const evals = this.evaluateStrategies(prices, regimes, nowMs, rec);
      for (const ex of checkExits(db, prices, ctxByMint, cfg.risk)) {
        if (await this.runSell(this.sellIntent(ex, prices), rec, "exit", nowMs)) {executed.sells++;}
      }
      for (const b of this.deps.strategies) {
        for (const sig of evals.get(b.strategy.name)?.signals ?? []) {
          if (sig.side === "sell" && getPosition(db, sig.mint)) {
            if (await this.runSell(this.strategySellIntent(sig, b.strategy.name, prices, (sig.sellPortion ?? 1)), rec, b.strategy.name, nowMs)) {
              executed.sells++;
            }
          }
        }
      }

      // 5) shadows + allocation du capital (hystérésis)
      // chaque fantôme évalue ses signaux contre son PROPRE livre (sinon les sorties
      // de stratégie ne visent jamais ses holdings → bookings fantômes figés).
      const noopRec = () => {};
      const allocated = runShadows(
        db,
        cfg,
        this.deps.strategies.map((b) => ({ strategy: b.strategy, weight: b.weight })),
        (mint) => prices.get(mint),
        this.symbols(),
        nowMs,
        (name, portfolio) => this.evaluateStrategyFor(name, portfolio, prices, regimes, nowMs, noopRec),
      );
      for (const line of allocated.lines) {
        const strat = line.split("|")[0] ?? null;
        rec({ kind: "allocation", strategy: strat, line });
      }

      // 6) entrée: meilleur signal buy de la stratégie allouée → RiskManager → executor
      let riskBlocked: string | null = null;
      snap = buildSnapshot(db, prices, snapOpts);
      if (executed.sells === 0 && allocated.allocation) {
        const riskState = this.riskState(snap);
        const flags: RiskFlags = { killSwitch, pausedUntilMs: daily.pausedUntilMs, totalLossHardPct: 0, stopFile };
        const cands: Candidate[] = [];
        for (const b of this.deps.strategies) {
          if (b.strategy.name !== allocated.allocation) {continue;}
          for (const sig of evals.get(b.strategy.name)?.signals ?? []) {
            if (sig.side === "buy") {
              if (sig.mint === USDC_MINT) {continue;}
              cands.push({ strategy: b.strategy.name, weight: b.weight, signal: sig });
            }
          }
        }
        const ranked = arbitrate(cands);
        const best: Scored | undefined = ranked.find((c) => c.signal.side === "buy");
        if (best) {
          const decision = this.deps.risk.checkEntry(
            best.signal,
            cfg.risk.max_trade_usd,
            riskState,
            flags,
            {
              solPrice: solPrice || 150,
              liquidityUsd: this.liquidityOf(best.signal.mint),
              needsAta: this.needsAta(best.signal.mint),
              priorityFeeSol: cfg.risk.priority_fee_sol,
              priceMarketUsd: prices.get(best.signal.mint) ?? 0,
            },
          );
          insertSignal(db, nowMs, best.strategy, best.signal.mint, this.symbol(best.signal.mint), "buy", best.score, best.signal.edgeEstimateBps, best.signal.reason);
          if (decision.allowed) {
            const res = await this.deps.executor.execute(this.buyIntent(best, decision.sizeUsd, prices, nowMs));
            rec({
              kind: "trade",
              strategy: best.strategy,
              mint: best.signal.mint,
              line: `${this.symbol(best.signal.mint)}: ACHAT ${decision.sizeUsd.toFixed(2)}$ — ${res.note} | coûts A/R ${decision.costBps.toFixed(1)} bps, ratio edge/coûts ${(decision.edgeVsCostRatio || 0).toFixed(1)} | ${best.signal.reason}`,
              data: { ok: res.ok, status: res.status, sizeUsd: decision.sizeUsd, costBps: decision.costBps },
            });
            if (res.ok) {
              executed.buys++;
              this.touchLastTrade(best.signal.mint, nowMs);
            }
          } else {
            riskBlocked = decision.rule ?? "unknown";
            rec({
              kind: "reject",
              strategy: best.strategy,
              mint: best.signal.mint,
              line: `${this.symbol(best.signal.mint)}: ${decision.rule} → ${decision.reason}`,
              data: decision.metrics,
            });
          }
        }
      }

      // 7) journal + equity
      if (solPrice > 0 && kvGetJson<number | null>(db, "solPrice0", null) === null) {
        kvSetJson(db, "solPrice0", solPrice);
      }
      const equityPoint = {
        tsMs: nowMs,
        tickId,
        navUsd: snap.navUsd,
        cashUsd: snap.cashUsd,
        positionsUsd: snap.positionsUsd,
        realizedTotalUsd: cumRealizedPnl(db),
        drawdownPct: snap.drawdownPct,
        benchmarkCashUsd: snap.initialCapitalUsd,
        benchmarkBhUsd: benchmarkBuyHold(snap.initialCapitalUsd, solPrice, kvGetJson<number | null>(db, "solPrice0", null)),
      };
      insertEquity(db, equityPoint);
      this.deps.log.info(
        { tick: tickId, nav: snap.navUsd.toFixed(3), cash: snap.cashUsd.toFixed(2), positions: snap.positions.length, allocation: allocated.allocation },
        "tick",
      );
      return this.done(nowMs, { ok: true, navUsd: snap.navUsd, cashUsd: snap.cashUsd, executed, allocation: allocated.allocation || null, riskBlocked }, decisions);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.log.error({ err: msg }, "engine tick exception");
      return this.done(nowMs, { ok: false, error: msg, navUsd: null, cashUsd: null, executed: { buys: 0, sells: 0 }, allocation: null, riskBlocked: null }, decisions, { kind: "error", line: `erreur engine tick: ${msg}` });
    } finally {
      this.busy = false;
    }
  }

  // ------------------------------- helpers -------------------------------

  private done(nowMs: number, rest: Omit<TickReport, "tsMs" | "tickId" | "skipped">, decisions: DecisionRecord[], extra?: Omit<DecisionRecord, "tsMs" | "tickId">): TickReport {
    const { db } = this.deps;
    for (const d of decisions) {insertDecision(db, d);}
    if (extra) {
      insertDecision(db, { ...extra, tsMs: nowMs, tickId: this.tickId });
    }
    return { tsMs: nowMs, tickId: decisions.length > 0 ? decisions[0]!.tickId : this.tickId, skipped: false, ...rest };
  }

  private regimeCfg() {
    const r = this.deps.cfg.regime;
    return {
      volLookback: r.vol_lookback,
      highVolPctl: r.high_vol_pctl / 100,
      highVolFloorBps: r.high_vol_floor_bps,
      idleVolBps: r.idle_vol_bps,
      trendAtrRatio: r.trend_atr_ratio,
    };
  }

  private regimeLine(mint: string, r: RegimeResult): string {
    return `${this.symbol(mint)}: régime ${r.regime} (vol ${Number.isFinite(r.volBps) ? r.volBps.toFixed(1) : "?"} bps/barre, rank ${Number.isFinite(r.volRank) ? r.volRank.toFixed(2) : "?"}) — momentum ${r.momentumAllowed ? "on" : "off"}, mean-rev ${r.meanReversionAllowed ? "on" : "off"}, dca ${r.dcaAllowed ? "on" : "off"}`;
  }

  private symbol(mint: string): string {
    if (mint === SOL_MINT) {return "SOL";}
    if (mint === USDC_MINT) {return "USDC";}
    return getTokenMeta(this.deps.db, mint)?.symbol ?? this.deps.cfg.universe.tokens.find((t) => t.mint === mint)?.symbol ?? mint.slice(0, 5);
  }

  private symbols(): Map<string, string> {
    const m = new Map<string, string>();
    for (const mint of this.assetMints()) {m.set(mint, this.symbol(mint));}
    return m;
  }

  private assetMints(): string[] {
    return [SOL_MINT, ...this.deps.cfg.universe.tokens.map((t) => t.mint)];
  }

  private decimalsOf(mint: string): number {
    if (mint === SOL_MINT) {return 9;}
    if (mint === USDC_MINT) {return 6;}
    return getTokenMeta(this.deps.db, mint)?.decimals ?? this.deps.cfg.universe.tokens.find((t) => t.mint === mint)?.decimals ?? 6;
  }

  private liquidityOf(mint: string): number | null {
    if (mint === SOL_MINT) {return 50_000_000;}
    return getTokenMeta(this.deps.db, mint)?.liquidityUsd ?? null;
  }

  private needsAta(mint: string): boolean {
    if (mint === SOL_MINT) {return false;}
    return getPosition(this.deps.db, mint) === null && !this.deps.cfg.universe.tokens.some((t) => t.mint === mint && (t as unknown as { ataOpen?: boolean }).ataOpen === true);
  }

  private touchLastTrade(mint: string, nowMs: number): void {
    const map = kvGetJson<Record<string, number>>(this.deps.db, "lastTradeMsByMint", {});
    map[mint] = nowMs;
    kvSetJson(this.deps.db, "lastTradeMsByMint", map);
  }

  private dailyAnchor(snap: PortfolioSnapshot, nowMs: number): { pausedUntilMs: number; lines: string[] } {
    const db = this.deps.db;
    const day = Math.floor(nowMs / DAY_MS);
    let anchor = kvGetJson<{ day: number; navUsd: number } | null>(db, "dayAnchor", null);
    if (!anchor || anchor.day !== day) {
      anchor = { day, navUsd: snap.navUsd };
      kvSetJson(db, "dayAnchor", anchor);
      return { pausedUntilMs: 0, lines: [] };
    }
    const dropped = anchor.navUsd - snap.navUsd;
    const pct = anchor.navUsd > 0 ? (dropped / anchor.navUsd) * 100 : 0;
    if (pct >= this.deps.cfg.risk.daily_loss_limit_pct) {
      const until = (anchor.day + 1) * DAY_MS;
      const cur = kvGetJson<number | null>(db, "dailyPausedUntilMs", null);
      if ((cur ?? 0) < until) {
        kvSetJson(db, "dailyPausedUntilMs", until);
        return {
          pausedUntilMs: until,
          lines: [`LIMITE JOURNALIÈRE: -${pct.toFixed(1)}% depuis l'ancre du jour ≥ ${this.deps.cfg.risk.daily_loss_limit_pct}% → entrées en pause jusqu'à minuit UTC`],
        };
      }
      return { pausedUntilMs: until, lines: [] };
    }
    return { pausedUntilMs: kvGetJson<number | null>(db, "dailyPausedUntilMs", 0) ?? 0, lines: [] };
  }

  private snapshotOpts(prices: Map<string, number>, nowMs: number): SnapshotOpts {
    return {
      mode: this.deps.mode,
      paperCashUsdc: paperCashGet(this.deps.db, this.deps.cfg.paper_initial_usdc),
      paperSol: paperSolGet(this.deps.db, this.deps.cfg.paper_initial_sol),
      balances: null,
      solPrice: prices.get(SOL_MINT) ?? 0,
      usdcPrice: prices.get(USDC_MINT) || 1,
      risk: this.deps.cfg.risk,
      nowMs,
    };
  }

  private riskState(snap: PortfolioSnapshot): RiskPortfolioState {
    const last = kvGetJson<Record<string, number>>(this.deps.db, "lastTradeMsByMint", {});
    return {
      navUsd: snap.navUsd,
      cashUsd: snap.cashUsd,
      solBalanceUsd: snap.solBalanceUsd,
      solBalanceSol: snap.solBalanceSol,
      positionsOpen: snap.positions.length,
      holdingMint: false,
      lastTradeMsByMint: last,
      initialCapitalUsd: snap.initialCapitalUsd,
      navPeakUsd: snap.navPeakUsd,
      dayStartNavUsd: kvGetJson<{ day: number; navUsd: number } | null>(this.deps.db, "dayAnchor", null)?.navUsd ?? snap.navUsd,
    };
  }

  private persistTrailingIfActivated(mint: string, price: number, avgEntryUsd: number, peak: number | null): void {
    const cfg = this.deps.cfg.risk;
    if (!(avgEntryUsd > 0) || !(price >= avgEntryUsd * (1 + cfg.trailing_activation_pct / 100)) || peak === null) {return;}
    const stop = peak * (1 - cfg.trailing_retrace_pct / 100);
    const cur = getPosition(this.deps.db, mint)?.trailingStopPrice ?? null;
    setTrailingStopPrice(this.deps.db, mint, cur === null ? stop : Math.max(cur, stop));
  }

  private sellIntent(ex: ExitDecision, prices: Map<string, number>): TradeIntent {
    return {
      mint: ex.mint,
      symbol: this.symbol(ex.mint),
      side: "sell",
      strategy: `exit_${ex.kind}`,
      priceUsd: ex.priceUsd,
      solPrice: prices.get(SOL_MINT) ?? 150,
      liquidityUsd: this.liquidityOf(ex.mint),
      spendUsd: ex.qty * ex.priceUsd,
      qty: ex.qty,
      edgeEstimateBps: 0,
      reason: ex.reason,
      needsAta: false,
      decimals: this.decimalsOf(ex.mint),
    };
  }

  private strategySellIntent(sig: Signal, strategy: string, prices: Map<string, number>, portion: number): TradeIntent {
    const pos = getPosition(this.deps.db, sig.mint);
    const qty = pos ? pos.qty * Math.min(1, Math.max(0.1, portion)) : 0;
    const price = prices.get(sig.mint) ?? 0;
    return {
      mint: sig.mint,
      symbol: this.symbol(sig.mint),
      side: "sell",
      strategy,
      priceUsd: price,
      solPrice: prices.get(SOL_MINT) ?? 150,
      liquidityUsd: this.liquidityOf(sig.mint),
      spendUsd: qty * price,
      qty,
      edgeEstimateBps: sig.edgeEstimateBps,
      reason: sig.reason,
      needsAta: false,
      decimals: this.decimalsOf(sig.mint),
    };
  }

  private buyIntent(best: Scored, sizeUsd: number, prices: Map<string, number>, nowMs: number): TradeIntent {
    void nowMs;
    const sig = best.signal;
    return {
      mint: sig.mint,
      symbol: this.symbol(sig.mint),
      side: "buy",
      strategy: best.strategy,
      priceUsd: prices.get(sig.mint) ?? 0,
      solPrice: prices.get(SOL_MINT) ?? 150,
      liquidityUsd: this.liquidityOf(sig.mint),
      spendUsd: sizeUsd,
      edgeEstimateBps: sig.edgeEstimateBps,
      reason: sig.reason,
      stopLossPct: sig.suggestedStopLossPct,
      takeProfitPct: sig.suggestedTakeProfitPct,
      needsAta: this.needsAta(sig.mint),
      decimals: this.decimalsOf(sig.mint),
    };
  }

  private async runSell(intent: TradeIntent, rec: (d: Omit<DecisionRecord, "tsMs" | "tickId">) => void, strategy: string, nowMs: number): Promise<boolean> {
    const qty = intent.qty ?? 0;
    if (!(qty > 0) || !(intent.priceUsd > 0)) {return false;}
    const res = await this.deps.executor.execute(intent);
    rec({
      kind: "trade",
      strategy,
      mint: intent.mint,
      line: `${intent.symbol}: VENTE ${strategy} — ${res.note || (res.ok ? "ok" : "échec")} | ${intent.reason}`,
      data: { ok: res.ok, status: res.status, realizedPnlUsd: res.realizedPnlUsd ?? null, qty: intent.qty },
    });
    if (res.ok) {
      const map = kvGetJson<Record<string, number>>(this.deps.db, "lastTradeMsByMint", {});
      map[intent.mint] = nowMs;
      kvSetJson(this.deps.db, "lastTradeMsByMint", map);
    }
    return res.ok;
  }

  private evaluateStrategies(
    prices: Map<string, number>,
    regimes: Map<string, RegimeResult>,
    nowMs: number,
    rec: (d: Omit<DecisionRecord, "tsMs" | "tickId">) => void,
  ): Map<string, StrategyEval> {
    const db = this.deps.db;
    const solPrice = prices.get(SOL_MINT) ?? 150;
    const snap = buildSnapshot(db, prices, this.snapshotOpts(prices, nowMs));
    const stratPortfolio: StrategyPortfolio = {
      navUsd: snap.navUsd,
      cashUsd: snap.cashUsd,
      positioned: [
        ...(snap.solBalanceSol > 1e-4
          ? [{ mint: SOL_MINT, symbol: "SOL", qty: snap.solBalanceSol, avgEntryUsd: getPosition(db, SOL_MINT)?.avgEntryUsd ?? solPrice, valueUsd: snap.solBalanceSol * solPrice }]
          : []),
        ...snap.positions
          .filter((p) => p.mint !== SOL_MINT)
          .map((p) => ({ mint: p.mint, symbol: p.symbol, qty: p.qty, avgEntryUsd: p.avgEntryUsd, valueUsd: p.valueUsd })),
      ],
      solPrice,
    };
    const evals = new Map<string, StrategyEval>();
    for (const b of this.deps.strategies) {
      evals.set(b.strategy.name, this.evaluateStrategyFor(b.strategy.name, stratPortfolio, prices, regimes, nowMs, rec));
    }
    return evals;
  }

  /** Évalue UNE stratégie contre UN portefeuille (réel OU fantôme). Extrait, pur. */
  private evaluateStrategyFor(
    name: string,
    stratPortfolio: StrategyPortfolio,
    prices: Map<string, number>,
    regimes: Map<string, RegimeResult>,
    nowMs: number,
    rec: (d: Omit<DecisionRecord, "tsMs" | "tickId">) => void,
  ): StrategyEval {
    const db = this.deps.db;
    const b = this.deps.strategies.find((x) => x.strategy.name === name);
    if (!b) {return { signals: [], notes: [] };}
    const signals: Signal[] = [];
    for (const mint of this.assetMints()) {
      if (mint === USDC_MINT) {continue;}
      const r = regimes.get(mint);
      if (!r || !this.regimeAllows(name, r)) {continue;}
      const price = prices.get(mint);
      if (price === undefined || !(price > 0)) {continue;}
      const res = b.strategy.evaluate(
        {
          mint,
          symbol: this.symbol(mint),
          decimals: this.decimalsOf(mint),
          price,
          liquidityUsd: this.liquidityOf(mint),
          candles: getHistoryCandles(db, mint, STRAT_TF, 400, nowMs),
          regime: r,
          volumeRatio: null,
          ataOpen: getPosition(db, mint) !== null,
        },
        stratPortfolio,
      );
      for (const s of res.signals) {signals.push(s);}
      for (const line of res.notes) {
        rec({ kind: res.signals.length > 0 ? "signal" : "info", strategy: name, mint, line });
      }
    }
    return { signals, notes: [] };
  }

  private regimeAllows(name: string, r: RegimeResult): boolean {
    if (name === "momentum") {return r.momentumAllowed;}
    if (name === "mean_reversion") {return r.meanReversionAllowed;}
    return r.dcaAllowed;
  }
}
