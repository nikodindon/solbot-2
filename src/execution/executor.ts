import type { DB } from "../state/db.js";
import type { AppConfig } from "../config/schema.js";
import { insertTrade, type TradeRecord } from "../state/trades.js";
import { addLot, reducePositionFifo, getPosition, setStops } from "../state/portfolio-repo.js";
import { paperCashGet, paperCashSet, paperSolGet, paperSolSet } from "../portfolio/portfolio.js";
import { simulateBuy, simulateSell } from "./paper-broker.js";
import { modeledPairFeeBps } from "../jupiter/swap.js";
import type { SwapApi } from "../jupiter/swap.js";
import type { RpcClient } from "../solana/rpc.js";
import type { Signer } from "../wallet/signer.js";
import { SOL_MINT, USDC_MINT, ATA_RENT_LAMPORTS, LAMPORTS_PER_SOL } from "../constants.js";

export interface TradeIntent {
  mint: string;
  symbol: string;
  side: "buy" | "sell";
  strategy: string;
  priceUsd: number;
  solPrice: number;
  liquidityUsd?: number | null;
  /** buys: USDC notional (fees included); sells token notional gross */
  spendUsd: number;
  /** sells: exact token qty (already risk-sized) */
  qty?: number;
  sellPortion?: number;
  edgeEstimateBps: number;
  reason: string;
  stopLossPct?: number;
  takeProfitPct?: number;
  needsAta: boolean;
  /** token decimals for unit conversions (from token_meta) */
  decimals: number;
}

export interface ExecuteResult {
  ok: boolean;
  status: string;
  note: string;
  qty?: number;
  spendUsd?: number;
  proceedsUsd?: number;
  realizedPnlUsd?: number;
  signature?: string | null;
  trade?: TradeRecord;
}

export interface ExecutorDeps {
  db: DB;
  mode: "paper" | "dry_run" | "live";
  cfg: AppConfig;
  swapApi: SwapApi | null;
  rpc: RpcClient | null;
  signer: Signer | null;
}

const EPS = 1e-9;

function toUnits(qty: number, decimals: number): string {
  return BigInt(Math.max(0, Math.floor(qty * Math.pow(10, decimals)))).toString();
}

function fromUnits(units: string | number | undefined, decimals: number): number {
  const n = Number(units ?? "0");
  return Number.isFinite(n) ? n / Math.pow(10, decimals) : 0;
}

/**
 * Executor — turns a risk-approved intent into a fill in the ledger:
 *  - paper: broker model (fees + slippage + impact + rent), book updated, cash moved (kv)
 *  - dry_run: real /order + RPC simulate (sigVerify=false), no sign, no book change, ledger entry
 *  - live: /order -> sign -> /execute, fees decomposed, book updated with actual amounts
 */
export class Executor {
  constructor(
    private readonly deps: ExecutorDeps,
    private readonly log: {
      info: (o: object, m?: string) => void;
      warn: (o: object, m?: string) => void;
      error: (o: object, m?: string) => void;
    },
  ) {}

  async execute(intent: TradeIntent): Promise<ExecuteResult> {
    const mode = this.deps.mode;
    if (mode === "live") {return this.executeLive(intent);}
    if (mode === "dry_run") {return this.executeDryRun(intent);}
    return this.executePaper(intent);
  }

  private costsFor(intent: TradeIntent): { feeBps: number; slippageBps: number } {
    const inMint = intent.side === "buy" ? USDC_MINT : intent.mint;
    const outMint = intent.side === "buy" ? intent.mint : USDC_MINT;
    return {
      feeBps: modeledPairFeeBps(inMint, outMint),
      slippageBps: this.deps.cfg.costs.paper_fill_slippage_bps,
    };
  }

  // ---------------- paper ----------------

  private executePaper(intent: TradeIntent): ExecuteResult {
    const { db, cfg } = this.deps;
    const ts = Date.now();
    const costs = this.costsFor(intent);
    const fill = {
      feeBps: costs.feeBps,
      slippageBps: costs.slippageBps,
      solPrice: intent.solPrice,
      priorityFeeSol: cfg.risk.priority_fee_sol,
      liquidityUsd: intent.liquidityUsd,
    };
    if (intent.side === "buy") {
      const spend = intent.spendUsd;
      const f = simulateBuy(spend, intent.priceUsd, fill);
      const rentSol = intent.needsAta ? ATA_RENT_LAMPORTS / LAMPORTS_PER_SOL : 0;
      const rentUsd = rentSol * intent.solPrice;
      const pos = addLot(db, intent.mint, intent.symbol, f.qty, f.spendUsd / f.qty, ts);
      if (pos.created && intent.mint !== SOL_MINT) {
        // first SOL-like entry: charge the ATA rent as an immediate cash cost
        paperCashSet(db, paperCashGet(db, cfg.paper_initial_usdc) - rentUsd);
      }
      paperCashSet(db, paperCashGet(db, cfg.paper_initial_usdc) - spend);
      paperSolSet(db, paperSolGet(db, cfg.paper_initial_sol) - (f.solFee + rentSol));
      const stopPrice = intent.priceUsd * (1 - (intent.stopLossPct ?? cfg.risk.stop_loss_pct) / 100);
      const tpPrice = intent.priceUsd * (1 + (intent.takeProfitPct ?? cfg.risk.take_profit_pct) / 100);
      setStops(db, intent.mint, stopPrice, tpPrice);
      const rec: TradeRecord = {
        tsMs: ts,
        mode: "paper",
        strategy: intent.strategy,
        mint: intent.mint,
        symbol: intent.symbol,
        side: "buy",
        spendUsd: spend,
        qty: f.qty,
        priceUsd: f.priceEffective,
        expectedPriceUsd: intent.priceUsd,
        slippageBps: f.slippageBps,
        jupFeeUsd: f.jupFeeUsd,
        feeBps: costs.feeBps,
        solFee: f.solFee,
        solFeeUsd: f.solFee * intent.solPrice,
        ataRentSol: rentSol || null,
        ataRentUsd: rentUsd || null,
        status: "simulated",
        reason: intent.reason,
        note: `${intent.needsAta ? `location ATA facturée au pire cas (${rentSol.toFixed(6)} SOL) — ` : ""}impact ${f.impactBps.toFixed(1)} bps`,
      };
      insertTrade(db, rec);
      return {
        ok: true,
        status: "simulated",
        note: `achat simulé ${f.qty.toFixed(9)} ${intent.symbol}`,
        qty: f.qty,
        spendUsd: spend,
        trade: rec,
      };
    }
    // ---- sell
    const pos = getPosition(db, intent.mint);
    let qty = intent.qty ?? 0;
    if (intent.sellPortion !== undefined && pos) {
      qty = Math.min(qty > EPS ? qty : pos.qty, pos.qty * intent.sellPortion);
    }
    if (!(qty > EPS)) {
      return { ok: false, status: "failed", note: "aucune quantité à vendre" };
    }
    const f = simulateSell(qty, intent.priceUsd, fill);
    const red = reducePositionFifo(db, intent.mint, intent.symbol, qty, f.proceedsUsd / qty, ts);
    paperCashSet(db, paperCashGet(db, cfg.paper_initial_usdc) + f.proceedsUsd);
    paperSolSet(db, paperSolGet(db, cfg.paper_initial_sol) - f.solFee);
    // close ATA account at full closure: refund the rent (at worst case charged on entry)
    const closeRentSol = red.position === null && intent.mint !== SOL_MINT ? ATA_RENT_LAMPORTS / LAMPORTS_PER_SOL : 0;
    if (closeRentSol > 0) {
      paperSolSet(db, paperSolGet(db, cfg.paper_initial_sol) + closeRentSol);
    }
    const priceNet = f.proceedsUsd / qty;
    const rec: TradeRecord = {
      tsMs: ts,
      mode: "paper",
      strategy: intent.strategy,
      mint: intent.mint,
      symbol: intent.symbol,
      side: "sell",
      spendUsd: f.proceedsUsd,
      qty,
      priceUsd: priceNet,
      expectedPriceUsd: intent.priceUsd,
      slippageBps: f.slippageBps,
      jupFeeUsd: f.jupFeeUsd,
      feeBps: costs.feeBps,
      solFee: f.solFee,
      solFeeUsd: f.solFee * intent.solPrice,
      realizedPnlUsd: red.realizedPnlUsd,
      status: "simulated",
      reason: intent.reason,
      note: `impact ${f.impactBps.toFixed(1)} bps${closeRentSol > 0 ? `, ATA close: rent remboursée (${closeRentSol.toFixed(6)} SOL)` : ""}`,
    };
    insertTrade(db, rec);
    return {
      ok: true,
      status: "simulated",
      note: `vente simulée ${qty.toFixed(9)} ${intent.symbol} → ${f.proceedsUsd.toFixed(2)}$`,
      qty,
      proceedsUsd: f.proceedsUsd,
      realizedPnlUsd: red.realizedPnlUsd,
      trade: rec,
    };
  }

  // ---------------- dry_run ----------------

  private orderAmount(intent: TradeIntent): string {
    if (intent.side === "buy") {return toUnits(intent.spendUsd, 6);} // USDC decimals
    return toUnits(intent.qty ?? 0, intent.decimals);
  }

  private async executeDryRun(intent: TradeIntent): Promise<ExecuteResult> {
    const { swapApi, rpc } = this.deps;
    if (!swapApi) {return { ok: false, status: "failed", note: "swapApi indisponible en dry-run" }; }
    const ts = Date.now();
    const base = {
      tsMs: ts,
      mode: "dry_run" as const,
      strategy: intent.strategy,
      mint: intent.mint,
      symbol: intent.symbol,
      side: intent.side,
      spendUsd: intent.side === "buy" ? intent.spendUsd : (intent.qty ?? 0) * intent.priceUsd,
      qty: intent.qty ?? (intent.side === "buy" ? intent.spendUsd / Math.max(intent.priceUsd, EPS) : 0),
      priceUsd: intent.priceUsd,
      reason: intent.reason,
    };
    try {
      const signer = this.deps.signer;
      const order = await swapApi.order({
        inputMint: intent.side === "buy" ? USDC_MINT : intent.mint,
        outputMint: intent.side === "buy" ? intent.mint : USDC_MINT,
        amount: this.orderAmount(intent),
        taker: signer?.pubkey,
      });
      if (!order.transaction) {
        const note = `/order refusé [${order.router ?? "?"}] code ${order.errorCode ?? "?"} — ${order.errorMessage ?? ""}`;
        const rec: TradeRecord = { ...base, status: "failed_order", note };
        insertTrade(this.deps.db, rec);
        return { ok: false, status: "failed_order", note, trade: rec };
      }
      let sim = "RPC absent: pas de simulation";
      if (rpc) {
        try {
          const r = await rpc.callRaw<{ value?: { err?: unknown; unitsConsumed?: number } }>(
            "simulateTransaction",
            [order.transaction, { sigVerify: false, replaceRecentBlockhash: true, encoding: "base64" }],
          );
          sim = r.value?.err
            ? `simulation: ERREUR ${JSON.stringify(r.value.err)}`
            : `simulation OK (${r.value?.unitsConsumed ?? "?"} CU)`;
        } catch (e) {
          sim = `simulation impossible: ${String(e)}`;
        }
      }
      const outQty = fromUnits(order.outAmount, this.outDecimals(intent));
      const rec: TradeRecord = {
        ...base,
        qty: intent.side === "buy" ? outQty : base.qty,
        jupFeeUsd: order.platformFee ? fromUnits(order.platformFee.amount, 6) : null,
        feeBps: order.feeBps ?? null,
        status: "validated_order",
        note: `order OK: out≈${outQty.toPrecision(6)} ${intent.symbol} (${order.router ?? "?"}), fee ${order.feeBps ?? "?"} bps — ${sim}`,
      };
      insertTrade(this.deps.db, rec);
      return { ok: true, status: "validated_order", note: rec.note ?? "", trade: rec };
    } catch (err) {
      const note = `erreur /order: ${err instanceof Error ? err.message : String(err)}`;
      const rec: TradeRecord = { ...base, status: "failed", note };
      insertTrade(this.deps.db, rec);
      return { ok: false, status: "failed", note, trade: rec };
    }
  }

  private outDecimals(intent: TradeIntent): number {
    return intent.side === "buy" ? intent.decimals : 6; // USDC out
  }

  // ---------------- live ----------------

  private async executeLive(intent: TradeIntent): Promise<ExecuteResult> {
    const { swapApi, rpc, signer } = this.deps;
    if (!swapApi || !rpc) {return { ok: false, status: "failed", note: "live exige swapApi + rpc" }; }
    if (!signer) {return { ok: false, status: "failed", note: "live exige un wallet (BS58_PRIVATE_KEY)" }; }
    const ts = Date.now();
    const base = {
      tsMs: ts,
      mode: "live" as const,
      strategy: intent.strategy,
      mint: intent.mint,
      symbol: intent.symbol,
      side: intent.side,
      spendUsd: intent.side === "buy" ? intent.spendUsd : (intent.qty ?? 0) * intent.priceUsd,
      qty: intent.qty ?? 0,
      priceUsd: intent.priceUsd,
      reason: intent.reason,
    };
    const inputMint = intent.side === "buy" ? USDC_MINT : intent.mint;
    const outputMint = intent.side === "buy" ? intent.mint : USDC_MINT;
    const solBefore = await rpc.getBalance(signer.pubkey);
    try {
      const order = await swapApi.order({
        inputMint,
        outputMint,
        amount: this.orderAmount(intent),
        taker: signer.pubkey,
      });
      if (!order.transaction) {
        const note = `/order refusé [${order.router ?? "?"}] code ${order.errorCode ?? "?"} — ${order.errorMessage ?? ""}`;
        const rec: TradeRecord = { ...base, status: "failed_order", note };
        insertTrade(this.deps.db, rec);
        return { ok: false, status: "failed_order", note, trade: rec };
      }
      const { VersionedTransaction } = await import("@solana/web3.js");
      const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
      signer.signVersioned(tx);
      const signedTx = Buffer.from(tx.serialize()).toString("base64");
      const res = await swapApi.execute({ signedTransaction: signedTx, requestId: order.requestId });
      const solAfter = await rpc.getBalance(signer.pubkey);
      const solFee = Math.max(0, solBefore - solAfter) / LAMPORTS_PER_SOL;
      if (res.status === "Success" && res.code === 0) {
        return this.applyLiveFill(intent, base, res, order, solFee);
      }
      const note = `/execute échec: code ${res.code} — ${res.error ?? res.status}`;
      const rec: TradeRecord = {
        ...base,
        solFee,
        solFeeUsd: solFee * intent.solPrice,
        signature: res.signature ?? null,
        status: "failed",
        note,
      };
      insertTrade(this.deps.db, rec);
      return { ok: false, status: "failed", note, signature: res.signature ?? null, trade: rec };
    } catch (err) {
      const note = `erreur live: ${err instanceof Error ? err.message : String(err)}`;
      const rec: TradeRecord = { ...base, status: "failed", note };
      insertTrade(this.deps.db, rec);
      this.log.error({ err: note }, "executeLive échec");
      return { ok: false, status: "failed", note, trade: rec };
    }
  }

  private applyLiveFill(
    intent: TradeIntent,
    base: { tsMs: number; mode: "live"; strategy: string; mint: string; symbol: string; side: "buy" | "sell"; priceUsd: number; reason: string },
    res: { signature?: string | null; totalInputAmount?: string; totalOutputAmount?: string },
    order: { outAmount?: string; inAmount?: string; feeBps?: number; platformFee?: { amount: string; feeBps: number; feeMint: string } | null },
    solFee: number,
  ): ExecuteResult {
    const db = this.deps.db;
    const cfg = this.deps.cfg;
    const inDec = intent.side === "buy" ? 6 : intent.decimals;
    const outDec = intent.side === "buy" ? intent.decimals : 6;
    const inQty = fromUnits(res.totalInputAmount ?? order.inAmount, inDec);
    const outQty = fromUnits(res.totalOutputAmount ?? order.outAmount, outDec);
    const priceIn = intent.side === "buy" ? 1 : intent.priceUsd; // USDC in = 1$
    const priceOut = intent.side === "buy" ? intent.priceUsd : 1;
    const inUsd = inQty * priceIn;
    const outUsd = outQty * priceOut;
    const jupFeeUsd = order.platformFee ? fromUnits(order.platformFee.amount, 6) : null;
    const slippageBps =
      Number(order.outAmount) > 0
        ? ((Number(order.outAmount) - Number(res.totalOutputAmount ?? order.outAmount)) / Number(order.outAmount)) * 10_000
        : null;
    if (intent.side === "buy") {
      if (!(outQty > EPS)) {return { ok: false, status: "failed", note: "quantité reçue nulle" }; }
      const basisPrice = inUsd / outQty;
      addLot(db, intent.mint, intent.symbol, outQty, basisPrice, base.tsMs);
      setStops(
        db,
        intent.mint,
        intent.priceUsd * (1 - (intent.stopLossPct ?? cfg.risk.stop_loss_pct) / 100),
        intent.priceUsd * (1 + (intent.takeProfitPct ?? cfg.risk.take_profit_pct) / 100),
      );
      const rec: TradeRecord = {
        ...base,
        side: "buy",
        spendUsd: inUsd,
        qty: outQty,
        priceUsd: basisPrice,
        expectedPriceUsd: intent.priceUsd,
        slippageBps,
        jupFeeUsd,
        feeBps: order.feeBps ?? null,
        solFee,
        solFeeUsd: solFee * intent.solPrice,
        signature: res.signature ?? null,
        status: "filled",
      };
      insertTrade(db, rec);
      return {
        ok: true,
        status: "filled",
        note: `achat live ${outQty.toPrecision(6)} ${intent.symbol}`,
        qty: outQty,
        spendUsd: inUsd,
        signature: res.signature ?? null,
        trade: rec,
      };
    }
    const priceNet = outQty > EPS ? outUsd / inQty : intent.priceUsd;
    const red = reducePositionFifo(db, intent.mint, intent.symbol, inQty, priceNet, base.tsMs);
    const rec: TradeRecord = {
      ...base,
      side: "sell",
      spendUsd: outUsd,
      qty: inQty,
      priceUsd: priceNet,
      expectedPriceUsd: intent.priceUsd,
      slippageBps,
      jupFeeUsd,
      feeBps: order.feeBps ?? null,
      solFee,
      solFeeUsd: solFee * intent.solPrice,
      realizedPnlUsd: red.realizedPnlUsd,
      signature: res.signature ?? null,
      status: "filled",
    };
    insertTrade(db, rec);
    return {
      ok: true,
      status: "filled",
      note: `vente live ${inQty.toPrecision(6)} ${intent.symbol} → ${outUsd.toFixed(2)}$`,
      qty: inQty,
      proceedsUsd: outUsd,
      realizedPnlUsd: red.realizedPnlUsd,
      signature: res.signature ?? null,
      trade: rec,
    };
  }
}
