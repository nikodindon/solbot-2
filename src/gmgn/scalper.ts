/**
 * Scalper GMGN paper — boucle rapide:
 *  1) discovery (nouveaux lancements + trending) → candidats calés
 *  2) sorties TP / SL / time-stop (fills paper simulés)
 *  3) entrées sniper sur bougie 1m fraîche (une max par tick)
 *  4) equity NAV par tick
 * Gardes: max positions, exposition max, perte journalière, fichier data/STOP.
 */
import type { DB } from "../state/db.js";
import {
  addLot,
  setStops,
  getPosition,
  listPositions,
  reducePositionFifo,
  realizedPnlTotal,
} from "../state/portfolio-repo.js";
import type { Position } from "../state/portfolio-repo.js";
import { insertTrade } from "../state/trades.js";
import { insertDecision } from "../state/decisions.js";
import { insertEquity } from "../state/equity.js";
import { kvGetJson, kvSetJson } from "../state/kv.js";
import { paperCashGet, paperCashSet } from "../portfolio/portfolio.js";
import { simulateBuy, simulateSell } from "../execution/paper-broker.js";
import type { DiscoveryFeed, Candidate } from "./discovery.js";
import { insertTicks, upsertTokenMeta } from "../state/market.js";
import fs from "node:fs";

export interface GmgnConfig {
  initialUsd: number;
  tradeUsd: number;
  maxPositions: number;
  maxExposureUsd: number;
  minLiquidityUsd: number;
  minVol5mUsd: number;
  minChange5mPct: number;
  minAgeMin: number;
  takeProfitPct: number;
  stopLossPct: number;
  timeStopMin: number;
  cooldownMin: number;
  loopSec: number;
  dailyLossUsd: number;
  /** frais simulés bps (pool fee) + slippage bps des fills paper */
  feeBps: number;
  slippageBps: number;
  solPriceUsd: number;
}

export function gmgnDefaults(): GmgnConfig {
  return {
    initialUsd: 100,
    tradeUsd: 10,
    maxPositions: 3,
    maxExposureUsd: 40,
    minLiquidityUsd: 12_000,
    minVol5mUsd: 12_000,
    minChange5mPct: 3,
    minAgeMin: 2,
    takeProfitPct: 2.5,
    stopLossPct: 1.8,
    timeStopMin: 45,
    cooldownMin: 3,
    loopSec: 15,
    dailyLossUsd: 15,
    feeBps: 200,
    slippageBps: 250,
    solPriceUsd: 150,
  };
}

const STOP_FILE = "data/STOP";

export interface DayAnchor { day: number; navUsd: number }

export class Scalper {
  private readonly tickId = 0; // par stratégie gmgn, tick simple
  private lastBuyMsByMint = new Map<string, number>();
  private processedCandle = new Map<string, number>();
  private dayAnchor: DayAnchor | null = null;

  constructor(
    private readonly deps: {
      db: DB;
      cfg: GmgnConfig;
      feed: DiscoveryFeed;
      universeMutator?: (tokens: { mint: string; symbol: string }[]) => void;
    },
  ) {}

  private get db() {return this.deps.db;}
  private get cfg() {return this.deps.cfg;}
  private get feed() {return this.deps.feed;}

  private cash(): number {return paperCashGet(this.db, this.cfg.initialUsd);}

  private priceOf(mint: string, fallback: number): number {
    return this.feed.snapshotPrice(mint) ?? fallback;
  }

  private navOf(pos: Position[], now: number): number {
    let nav = this.cash();
    for (const p of pos) {nav += p.qty * this.priceOf(p.mint, p.avgEntryUsd);}
    void now;
    return nav;
  }

  /** NAV + exposition (mark paper cache). */
  private mark(pos: Position[]): { navUsd: number; exposureUsd: number } {
    let exposure = 0;
    for (const p of pos) {exposure += p.qty * this.priceOf(p.mint, p.avgEntryUsd);}
    return { navUsd: this.cash() + exposure, exposureUsd: exposure };
  }

  private stopNow(): boolean {return fs.existsSync(STOP_FILE);}

  private dailyLossHit(navNow: number): boolean {
    const day = Math.floor(Date.now() / 86_400_000);
    if (!this.dayAnchor || this.dayAnchor.day !== day) {
      this.dayAnchor = kvGetJson<DayAnchor | null>(this.db, "gmgnDayAnchor", null);
      if (!this.dayAnchor || this.dayAnchor.day !== day) {
        this.dayAnchor = { day, navUsd: navNow };
        kvSetJson(this.db, "gmgnDayAnchor", this.dayAnchor);
      }
    }
    return navNow <= this.dayAnchor.navUsd - this.cfg.dailyLossUsd;
  }

  private rec(kind: "info" | "signal" | "reject" | "trade" | "kill" | "error", line: string, data?: Record<string, unknown>): void {
    insertDecision(this.db, { tsMs: Date.now(), tickId: this.tickId, kind, strategy: "gmgn_sniper", line: `${kind}: ${line}`, data });
  }

  private fillCosts(liquidityUsd: number) {
    return {
      feeBps: this.cfg.feeBps,
      slippageBps: this.cfg.slippageBps,
      solPrice: this.cfg.solPriceUsd,
      priorityFeeSol: 0.0001,
      liquidityUsd,
    };
  }

  /** un cycle complet discovery → sorties → entrées → equity. Retourne lignes de journal. */
  async tick(): Promise<string[]> {
    const lines: string[] = [];
    const step = (l: string) => {lines.push(l);};
    const positions = listPositions(this.db, true);

    // === 0) STOP file / kill journalier ===
    if (this.stopNow()) {
      this.rec("kill", "STOP file présent — plus d'entrées");
      step("STOP file présent — plus d'entrées");
      return lines;
    }

    // === 1) discovery ===
    let cands: Candidate[] = [];
    try {
      cands = await this.feed.refresh();
    } catch (err) {
      this.rec("error", `discovery KO: ${err instanceof Error ? err.message : String(err)}`);
      step("discovery KO");
    }
    const tradable = cands.filter(
      (c) => c.liquidityUsd >= this.cfg.minLiquidityUsd
        && c.vol5mUsd >= this.cfg.minVol5mUsd
        && c.change5mPct >= this.cfg.minChange5mPct,
    );
    this.deps.universeMutator?.(tradable.map((c) => ({ mint: c.mint, symbol: c.symbol })));
    step(`discovery: ${cands.length} candidats, ${tradable.length} calés`);

    // === 1b) données dashboard: ticks prix + meta token ===
    const now = Date.now();
    const tickRows = new Map<string, { ts: number; mint: string; price: number; liquidity: number | null; volumeDelta: number | null }>();
    for (const c of cands.slice(0, 12)) {
      if (c.priceUsd > 0) {tickRows.set(c.mint, { ts: now, mint: c.mint, price: c.priceUsd, liquidity: c.liquidityUsd, volumeDelta: c.vol5mUsd });}
    }
    // positions ouvertes: mark courant même si le token n'est plus dans le flux
    for (const p of listPositions(this.db, true)) {
      const mark = this.feed.snapshotPrice(p.mint);
      if (mark && mark > 0) {tickRows.set(p.mint, { ts: now, mint: p.mint, price: mark, liquidity: null, volumeDelta: null });}
    }
    insertTicks(this.db, [...tickRows.values()]);
    for (const c of cands.slice(0, 12)) {
      upsertTokenMeta(this.db, { mint: c.mint, symbol: c.symbol, decimals: 6, isVerified: null, liquidityUsd: c.liquidityUsd, poolCreatedMs: c.createdMs || null }, now);
    }

    // === 2) sorties ===
    for (const pos of positions) {
      const price = this.priceOf(pos.mint, pos.avgEntryUsd);
      const runPct = ((price - pos.avgEntryUsd) / pos.avgEntryUsd) * 100;
      const ageMin = (Date.now() - pos.openedMs) / 60_000;
      const stopPx = pos.stopLossPrice ?? pos.avgEntryUsd * (1 - this.cfg.stopLossPct / 100);
      const tpPx = pos.takeProfitPrice ?? pos.avgEntryUsd * (1 + this.cfg.takeProfitPct / 100);
      if (price >= tpPx) {
        await this.sell(pos, price, `TP +${this.cfg.takeProfitPct}% touché (run ${runPct.toFixed(2)}%)`);
      } else if (price <= stopPx) {
        await this.sell(pos, price, `SL -${this.cfg.stopLossPct}% touché (run ${runPct.toFixed(2)}%)`);
      } else if (ageMin >= this.cfg.timeStopMin) {
        await this.sell(pos, price, `time-stop ${this.cfg.timeStopMin} min (run ${runPct.toFixed(2)}%)`);
      }
    }
    const after = listPositions(this.db, true);

    // === 3) entrées ===
    const { navUsd, exposureUsd } = this.mark(after);
    if (this.dailyLossHit(navUsd)) {
      this.rec("kill", "perte journalière touchée — plus d'entrées aujourd'hui");
      step("kill: perte journalière");
    } else if (after.length >= this.cfg.maxPositions || exposureUsd >= this.cfg.maxExposureUsd || this.cash() < this.cfg.tradeUsd) {
      step(`pas d'entrée — pos ${after.length}/${this.cfg.maxPositions}, expo ${exposureUsd.toFixed(0)}$, cash ${this.cash().toFixed(1)}$`);
    } else {
      await this.tryBuy(tradable.slice(0, 3), lines);
    }

    // === 4) equity ===
    const final = listPositions(this.db, true);
    const mark = this.mark(final);
    insertEquity(this.db, {
      tsMs: Date.now(),
      tickId: this.tickId,
      navUsd: mark.navUsd,
      cashUsd: this.cash(),
      positionsUsd: mark.exposureUsd,
      realizedTotalUsd: realizedPnlTotal(this.db),
      drawdownPct: this.drawdownPct(mark.navUsd),
    });
    step(`NAV ${mark.navUsd.toFixed(3)}$ cash ${this.cash().toFixed(2)}$ pos ${final.length} expo ${mark.exposureUsd.toFixed(1)}$`);
    return lines;
  }

  private drawdownPct(nav: number): number {
    const peak = Math.max(nav, this.dayAnchor?.navUsd ?? nav);
    return peak > 0 ? Math.max(0, ((peak - nav) / peak) * 100) : 0;
  }

  private async tryBuy(cands: Candidate[], lines: string[]): Promise<void> {
    const maxAssess = Math.min(cands.length, 3);
    for (let i = 0; i < maxAssess; i++) {
      const c = cands[i]!;
      const cdMs = this.lastBuyMsByMint.get(c.mint) ?? 0;
      if (Date.now() - cdMs < this.cfg.cooldownMin * 60_000) {continue;}
      if (getPosition(this.db, c.mint)) {continue;}
      const bar = await this.feed.latestCandle(c.mint);
      if (!bar) {continue;}
      if ((this.processedCandle.get(c.mint) ?? 0) === bar.ts) {continue;}
      this.processedCandle.set(c.mint, bar.ts);
      const bodyPct = ((bar.close - bar.open) / bar.open) * 100;
      if (bar.volumeUsd < this.cfg.minVol5mUsd / 4 || bodyPct < this.cfg.minChange5mPct / 2) {
        this.rec("reject", `${c.symbol}: bougie 1m insuffisante — vol ${bar.volumeUsd.toFixed(0)}$/1m, body ${bodyPct.toFixed(2)}%`);
        continue;
      }
      this.rec("signal", `${c.symbol}: sniper ${this.cfg.tradeUsd}$ — body ${bodyPct.toFixed(2)}%/1m, vol ${(bar.volumeUsd / 1000).toFixed(1)}k$/1m, liq ${(c.liquidityUsd / 1000).toFixed(0)}k$`);
      await this.buy(c, bar.close);
      lines.push(`BUY ${c.symbol} ${this.cfg.tradeUsd}$`);
      break;
    }
  }

  private async buy(c: Candidate, priceRef: number): Promise<void> {
    const f = simulateBuy(this.cfg.tradeUsd, priceRef, this.fillCosts(c.liquidityUsd));
    const ts = Date.now();
    const stopPx = f.priceEffective * (1 - this.cfg.stopLossPct / 100);
    const tpPx = f.priceEffective * (1 + this.cfg.takeProfitPct / 100);
    addLot(this.db, c.mint, c.symbol, f.qty, f.priceEffective, ts);
    setStops(this.db, c.mint, stopPx, tpPx);
    paperCashSet(this.db, this.cash() - this.cfg.tradeUsd);
    this.lastBuyMsByMint.set(c.mint, ts);
    insertTrade(this.db, {
      tsMs: ts,
      mode: "paper",
      strategy: "gmgn_sniper",
      mint: c.mint,
      symbol: c.symbol,
      side: "buy",
      spendUsd: this.cfg.tradeUsd,
      qty: f.qty,
      priceUsd: f.priceEffective,
      expectedPriceUsd: priceRef,
      slippageBps: f.slippageBps,
      jupFeeUsd: f.jupFeeUsd,
      feeBps: this.cfg.feeBps,
      solFee: f.solFee,
      status: "simulated",
      reason: `snipe ${c.symbol} (${this.feed.name})`,
      note: `liq ${(c.liquidityUsd / 1000).toFixed(0)}k$ vol5m ${(c.vol5mUsd / 1000).toFixed(0)}k$ chg5m ${c.change5mPct.toFixed(1)}%`,
    });
  }

  private async sell(pos: Position, price: number, reason: string): Promise<void> {
    const f = simulateSell(pos.qty, price, this.fillCosts(pos.qty * price));
    const priceNet = f.proceedsUsd / pos.qty;
    const ts = Date.now();
    const red = reducePositionFifo(this.db, pos.mint, pos.symbol, pos.qty, priceNet, ts);
    paperCashSet(this.db, this.cash() + f.proceedsUsd);
    insertTrade(this.db, {
      tsMs: ts,
      mode: "paper",
      strategy: "gmgn_sniper",
      mint: pos.mint,
      symbol: pos.symbol,
      side: "sell",
      spendUsd: f.proceedsUsd,
      qty: pos.qty,
      priceUsd: f.priceEffective,
      expectedPriceUsd: price,
      slippageBps: f.slippageBps,
      jupFeeUsd: f.jupFeeUsd,
      feeBps: this.cfg.feeBps,
      solFee: f.solFee,
      realizedPnlUsd: red.realizedPnlUsd,
      status: "simulated",
      reason,
      note: `exit ${this.feed.name}`,
    });
    this.rec("trade", `${pos.symbol}: VENTE ${reason} — net ${f.proceedsUsd.toFixed(3)}$, PnL ${red.realizedPnlUsd.toFixed(4)}$`);
  }
}
