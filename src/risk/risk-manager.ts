import { USDC_MINT } from "../constants.js";
import type { RiskConfig } from "../config/schema.js";
import type { Signal } from "../strategy/types.js";
import type { CostModelCfg } from "../execution/costs.js";
import { estimateCostWithSlippage, impactBps, swapsRemaining } from "../execution/costs.js";
import { clamp } from "../utils/math.js";

export interface RiskRejection {
  rule: string;
  metrics: Record<string, number | string | boolean | null>;
}

export interface RiskEntryRequest {
  signal: Signal;
  notionalUsd: number; // proposed size BEFORE risk
  isSolPair: boolean; // trading SOL itself (vs "token with USDC quotes")
}

export interface RiskPortfolioState {
  navUsd: number;
  cashUsd: number; // USDC spendable
  solBalanceUsd: number;
  solBalanceSol: number;
  positionsOpen: number;
  holdingMint: boolean; // already holding the mint of the signal
  lastTradeMsByMint: Record<string, number>;
  initialCapitalUsd: number;
  navPeakUsd: number;
  dayStartNavUsd: number;
}

export interface RiskFlags {
  killSwitch: boolean;
  pausedUntilMs: number;
  totalLossHardPct: number; // live NAV drop from initial capital
  stopFile: boolean;
}

export interface RiskEntryDecision {
  allowed: boolean;
  reason?: string;
  rule?: string;
  metrics: Record<string, number | string | boolean | null>;
  sizeUsd: number;
  stopLossPct: number;
  takeProfitPct: number;
  costBps: number;
  edgeVsCostRatio: number;
}

/**
 * RiskManager — last word before any trade. Micro-capital rules, ordered:
 * kill-switch → daily pause → hard total loss → position caps → cooldown → gas reserve →
 * ATA rent −edge-net (edge > 3× ROUND-TRIP costs) → liquidity impact → min/max sizing.
 */
export class RiskManager {
  constructor(
    private readonly cfg: RiskConfig,
    private readonly costCfg: CostModelCfg,
  ) {}

  checkEntry(
    signal: Signal,
    notionalUsd: number,
    state: RiskPortfolioState,
    flags: RiskFlags,
    extra: {
      solPrice: number;
      liquidityUsd: number | null;
      needsAta: boolean;
      priorityFeeSol: number;
      priceMarketUsd: number;
    },
  ): RiskEntryDecision {
    const me: Record<string, number | string | boolean | null> = {};
    me.notionals = notionalUsd.toFixed(2);
    me.edgeBps = signal.edgeEstimateBps.toFixed(0);

    if (flags.killSwitch || flags.stopFile) {
      return reject(signal, "kill_switch", "kill-switch actif : plus d'entrées", me, 0, this.cfg);
    }
    if (Date.now() < flags.pausedUntilMs) {
      return reject(
        signal,
        "daily_pause",
        `entrées en pause jusqu'à ${new Date(flags.pausedUntilMs).toISOString().slice(11, 16)} UTC (limite de perte journalière)`,
        me,
        0,
        this.cfg,
      );
    }
    if (state.initialCapitalUsd > 0) {
      const totalLossPct = ((state.initialCapitalUsd - state.navUsd) / state.initialCapitalUsd) * 100;
      me.lossTotalPct = totalLossPct.toFixed(1);
      if (totalLossPct >= Math.min(this.cfg.hard_max_total_loss_pct, 50)) {
        return reject(
          signal,
          "hard_total_loss",
          `perte totale ${totalLossPct.toFixed(1)}% ≥ plafond dur ${Math.min(this.cfg.hard_max_total_loss_pct, 50)}%`,
          me,
          0,
          this.cfg,
        );
      }
      if (totalLossPct >= this.cfg.kill_switch_max_drawdown_pct) {
        return reject(
          signal,
          "kill_switch_dd",
          `drawdown ${totalLossPct.toFixed(1)}% ≥ kill-switch ${this.cfg.kill_switch_max_drawdown_pct}%`,
          me,
          0,
          this.cfg,
        );
      }
    }
    if (!state.holdingMint && state.positionsOpen >= this.cfg.max_positions) {
      return reject(
        signal,
        "max_positions",
        `${state.positionsOpen} positions ouvertes ≥ ${this.cfg.max_positions}`,
        me,
        0,
        this.cfg,
      );
    }
    const last = state.lastTradeMsByMint[signal.mint] ?? 0;
    const cdLeft = this.cfg.cooldown_s * 1000 - (Date.now() - last);
    if (last > 0 && cdLeft > 0) {
      return reject(
        signal,
        "cooldown",
        `cooldown actif : ${(cdLeft / 1000).toFixed(0)}s restantes (déjà tradé il y a ${Math.round((Date.now() - last) / 1000)}s)`,
        me,
        0,
        this.cfg,
      );
    }

    // gas reserve: cost of trading both ways + smart sanity that SOL balance stays above reserve
    const perSwapSol = (5_000 + extra.priorityFeeSol * 1e9) / 1e9;
    const needSol = 2 * perSwapSol + (extra.needsAta ? ATA_RENT_SOL : 0) + 0.001; // + buffer
    const solAboveReserve = state.solBalanceSol - this.cfg.gas_reserve_sol;
    if (solAboveReserve < needSol) {
      return reject(
        signal,
        "gas_reserve",
        `SOL au-dessus de la réserve: ${solAboveReserve.toFixed(4)} < besoin ${(needSol).toFixed(4)} (base+priority ×2${extra.needsAta ? " + rent ATA" : ""})`,
        me,
        0,
        this.cfg,
      );
    }
    me.swapsRemaining = swapsRemaining(solAboveReserve, extra.priorityFeeSol, extra.solPrice).toString();

    // notional caps
    if (signal.side === "buy") {
      if (state.cashUsd < Math.min(this.cfg.min_trade_usd, notionalUsd) && !state.holdingMint) {
        return reject(
          signal,
          "insufficient_cash",
          `cash ${state.cashUsd.toFixed(2)}$ < taille proposée ${notionalUsd.toFixed(2)}$`,
          me,
          0,
          this.cfg,
        );
      }
    }

    // edge-net filter
    const q = {
      notionalUsd: Math.min(notionalUsd, this.cfg.max_trade_usd),
      solPrice: extra.solPrice,
      inputMint: signal.side === "buy" ? USDC_MINT : signal.mint,
      outputMint: signal.side === "buy" ? signal.mint : USDC_MINT,
      priorityFeeSol: extra.priorityFeeSol,
      needsAta: extra.needsAta,
    };
    const costs = estimateCostWithSlippage(q, this.costCfg);
    me.costBps = costs.totalBps.toFixed(1);
    const threshold = this.costCfg.edgeMultiplier * costs.totalBps;
    me.edgeThresholdBps = threshold.toFixed(1);
    if (!signal.edgeExempt && signal.edgeEstimateBps < threshold) {
      return reject(
        signal,
        "edge_net",
        `edge attendu ${signal.edgeEstimateBps.toFixed(0)} bps < seuil ${this.costCfg.edgeMultiplier}×coûts (${threshold.toFixed(0)} bps) — coûts aller-retour: ${costs.totalBps.toFixed(1)} bps (frais Jupiter ${costs.feeBps}, SOL ${costs.solBps.toFixed(2)}, slippage ${costs.slippageBps}${costs.rentBps ? `, rent ATA ${costs.rentBps.toFixed(1)}` : ""})`,
        me,
        0,
        this.cfg,
      );
    }

    // liquidity/impact
    const imp = impactBps(notionalUsd, extra.liquidityUsd);
    me.impactBps = imp.toFixed(1);
    if (imp > this.cfg.max_price_impact_bps) {
      return reject(
        signal,
        "price_impact",
        `impact estimé ${imp.toFixed(0)} bps > max ${this.cfg.max_price_impact_bps} bps`,
        me,
        0,
        this.cfg,
      );
    }

    // sizing: min 1.5$, max the tightest of config/hard cap/nav pct/cash
    let size = notionalUsd;
    if (!signal.edgeExempt && signal.side === "buy") {
      size = Math.min(
        size,
        clamp(
          (this.cfg.max_position_pct / 100) * state.navUsd,
          this.cfg.min_trade_usd,
          this.cfg.max_position_pct,
        ),
      );
    }
    size = Math.min(
      size,
      this.cfg.max_trade_usd,
      this.cfg.hard_max_trade_usd,
      Math.max(0, state.cashUsd),
    );
    if (!state.holdingMint) {size = Math.max(this.cfg.min_trade_usd, Math.min(size, this.cfg.max_trade_usd));}
    me.sizeUsd = size.toFixed(2);
    if (signal.side === "buy" && !signal.edgeExempt && size < this.cfg.min_trade_usd) {
      return reject(
        signal,
        "min_trade",
        `taille calculée ${size.toFixed(2)}$ < min ${this.cfg.min_trade_usd}$`,
        me,
        0,
        this.cfg,
      );
    }

    const stopPct = clamp(signal.suggestedStopLossPct ?? this.cfg.stop_loss_pct, 0.5, 30);
    const edgeRatio = costs.totalBps > 0 ? signal.edgeEstimateBps / costs.totalBps : Number.POSITIVE_INFINITY;
    return {
      allowed: true,
      metrics: me,
      sizeUsd: Number(size.toFixed(6)),
      stopLossPct: stopPct,
      takeProfitPct: this.cfg.take_profit_pct,
      costBps: costs.totalBps,
      edgeVsCostRatio: Number.isFinite(edgeRatio) ? edgeRatio : 0,
    };
  }
}

const ATA_RENT_SOL = 0.0020412;

function reject(
  signal: Signal,
  rule: string,
  reason: string,
  metrics: Record<string, number | string | boolean | null>,
  size: number,
  _cfg: RiskConfig,
): RiskEntryDecision {
  return { allowed: false, reason, rule, metrics, sizeUsd: size, stopLossPct: 0, takeProfitPct: 0, costBps: 0, edgeVsCostRatio: 0 };
}
