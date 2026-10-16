import { describe, expect, it } from "vitest";
import {
  estimateRoundTripCost,
  estimateCostWithSlippage,
  swapsRemaining,
  impactBps,
} from "../../src/execution/costs.js";
import { simulateBuy, simulateSell } from "../../src/execution/paper-broker.js";
import { RiskManager } from "../../src/risk/risk-manager.js";
import { riskSchema } from "../../src/config/schema.js";
import { SOL_MINT, USDC_MINT, BONK_MINT } from "../../src/constants.js";
import type { Signal } from "../../src/strategy/types.js";

const solPrice = 150;

const risk = riskSchema.parse({});
const costCfg = {
  edgeMultiplier: 3,
  expectedSlippageBps: 15,
  paperFillSlippageBps: 10,
};

function signal(p: Partial<Signal> = {}): Signal {
  return {
    mint: BONK_MINT,
    symbol: "BONK",
    side: "buy",
    edgeEstimateBps: 1500,
    confidence: 0.5,
    reason: "test",
    ttlMs: 10_000,
    ...p,
  };
}

function state(p: Partial<Parameters<RiskManager["checkEntry"]>[2]> = {}) {
  return {
    navUsd: 6,
    cashUsd: 5,
    solBalanceUsd: 1.5,
    solBalanceSol: 0.01,
    positionsOpen: 0,
    holdingMint: false,
    lastTradeMsByMint: {},
    initialCapitalUsd: 6,
    navPeakUsd: 6,
    dayStartNavUsd: 6,
    ...p,
  };
}

function flags(p: Partial<Parameters<RiskManager["checkEntry"]>[3]> = {}) {
  return { killSwitch: false, pausedUntilMs: 0, totalLossHardPct: 0, stopFile: false, ...p };
}

function extra(p: Partial<Parameters<RiskManager["checkEntry"]>[4]> = {}) {
  return {
    solPrice,
    liquidityUsd: 2_000_000,
    needsAta: true,
    priorityFeeSol: risk.priority_fee_sol,
    priceMarketUsd: 1,
    ...p,
  };
}

describe("modèle de coûts", () => {
  it("aller-retour BONK/USDC: frais paire 10+10, SOL×2, slippage, rent modélisée", () => {
    const c = estimateRoundTripCost({
      notionalUsd: 3,
      solPrice,
      inputMint: USDC_MINT,
      outputMint: BONK_MINT,
      priorityFeeSol: 0.00002,
      needsAta: true,
    });
    expect(c.feeBps).toBe(20);
    // SOL: base + priority ≈ 0.000025 SOL × aller-retour → 2×0.00375$ sur 3$ = 25 bps
    expect(c.solBps).toBeCloseTo(25, 0);
    expect(c.rentBps).toBeGreaterThan(500); // rent 0.306$ sur 3$
    expect(c.totalBps).toBeGreaterThan(50);
  });

  it("SOL↔stables: frais 2 bps par sens)", () => {
    const c = estimateRoundTripCost({
      notionalUsd: 3,
      solPrice,
      inputMint: USDC_MINT,
      outputMint: SOL_MINT,
      priorityFeeSol: 0.00002,
      needsAta: false,
    });
    expect(c.feeBps).toBe(4);
    expect(c.rentBps).toBe(0);
  });

  it("estimateCostWithSlippage remplace le slippage par 2×expected", () => {
    const c = estimateCostWithSlippage(
      { notionalUsd: 3, solPrice, inputMint: USDC_MINT, outputMint: SOL_MINT, priorityFeeSol: 0, needsAta: false },
      { edgeMultiplier: 3, expectedSlippageBps: 15, paperFillSlippageBps: 10 },
    );
    expect(c.slippageBps).toBe(30);
    expect(c.totalBps).toBeCloseTo(c.feeBps + c.solBps + 30, 9);
  });

  it("swapsRemaining compte la réserve", () => {
    // 0.000025 SOL par swap (base+priority) → 100 sol → 4000 swaps
    expect(swapsRemaining(0.0025, 0.00002)).toBe(100);
    expect(swapsRemaining(0, 0.00002)).toBe(0);
  });

  it("impactBps croissant avec taille/de liquidité, plafonné", () => {
    expect(impactBps(2_000, 1_000_000)).toBeCloseTo(40, 6);
    expect(impactBps(500, 10_000)).toBe(1_000); // 2×notional/liq, plafond 5000
  });
});

describe("paper broker", () => {
  const fill = { feeBps: 10, slippageBps: 10, solPrice: 150, priorityFeeSol: 0.00002, liquidityUsd: 2_000_000 };

  it("simulateBuy: prix effectif > prix, qty réduite des frais", () => {
    const f = simulateBuy(3, 1, fill);
    expect(f.priceEffective).toBeGreaterThan(1);
    expect(f.qty).toBeLessThan(3);
    expect(f.jupFeeUsd).toBeCloseTo(3 * 0.001, 9);
    expect(f.solFee).toBeGreaterThan(0);
  });

  it("simulateSell: proceeds < gross, symétrique", () => {
    const f = simulateSell(2, 1, fill);
    expect(f.proceedsUsd).toBeLessThan(f.grossUsd);
    expect(f.priceEffective).toBeLessThan(1);
  });
});

describe("RiskManager — règle par règle", () => {
  const rm = new RiskManager(risk, costCfg);

  it("kill-switch / STOP fichier", () => {
    const d = rm.checkEntry(signal(), 2, state(), flags({ killSwitch: true }), extra());
    expect(d.allowed).toBe(false);
    expect(d.rule).toBe("kill_switch");
    const d2 = rm.checkEntry(signal(), 2, state(), flags({ stopFile: true }), extra());
    expect(d2.rule).toBe("kill_switch");
  });

  it("pause journalière", () => {
    const d = rm.checkEntry(signal(), 2, state(), flags({ pausedUntilMs: Date.now() + 60_000 }), extra());
    expect(d.allowed).toBe(false);
    expect(d.rule).toBe("daily_pause");
  });

  it("plafond dur perte totale codé en constant (50%)", () => {
    const d = rm.checkEntry(signal(), 2, state({ navUsd: 2.4 }), flags(), extra());
    expect(d.allowed).toBe(false);
    expect(d.rule).toBe("hard_total_loss");
  });

  it("kill-switch drawdown 30%", () => {
    const d = rm.checkEntry(signal(), 2, state({ navUsd: 4.1, navPeakUsd: 6 }), flags(), extra());
    expect(d.rule).toBe("kill_switch_dd");
  });

  it("max positions et holding exempt", () => {
    const d = rm.checkEntry(signal(), 2, state({ positionsOpen: 2 }), flags(), extra());
    expect(d.rule).toBe("max_positions");
    const ok = rm.checkEntry(signal(), 2, state({ positionsOpen: 5, holdingMint: true }), flags(), extra({ needsAta: false }));
    // holding: on ajoute à une position existante → pas bloqué par max_positions
    expect(ok.allowed).toBe(true);
  });

  it("cooldown par mint", () => {
    const d = rm.checkEntry(signal(), 2, state({ lastTradeMsByMint: { [BONK_MINT]: Date.now() - 10_000 } }), flags(), extra());
    expect(d.rule).toBe("cooldown");
  });

  it("réserve de gaz: SOL insuffisant → refus + compteur swaps", () => {
    const d = rm.checkEntry(signal(), 2, state({ solBalanceSol: 0.0055 }), flags(), extra());
    expect(d.rule).toBe("gas_reserve");
    const s = state({ solBalanceSol: 0.012 });
    const d2 = rm.checkEntry(signal(), 2, s, flags(), extra());
    expect(d2.metrics.swapsRemaining).toBeDefined();
  });

  it("cash insuffisant", () => {
    const d = rm.checkEntry(signal(), 3.5, state({ cashUsd: 1 }), flags(), extra({ needsAta: false }));
    expect(d.rule).toBe("insufficient_cash");
  });

  it("edge-net: rejet chiffré (edge < 3×coûts aller-retour)", () => {
    const d = rm.checkEntry(signal({ edgeEstimateBps: 38 }), 3, state(), flags(), extra());
    expect(d.rule).toBe("edge_net");
    expect(d.reason).toContain("38 bps");
    expect(d.reason).toContain("3×coûts");
  });

  it("edge-net: accepté si edge dépasse largement le seuil", () => {
    const d = rm.checkEntry(signal({ edgeEstimateBps: 5_000 }), 3, state(), flags(), extra());
    expect(d.allowed).toBe(true);
    expect(d.costBps).toBeGreaterThan(0);
    expect(d.edgeVsCostRatio).toBeGreaterThan(3);
  });

  it("edgeExempt (rééquilibrage) bypasse le filtre edge-net mais pas le reste", () => {
    const d = rm.checkEntry(signal({ mint: SOL_MINT, symbol: "SOL", edgeExempt: true, edgeEstimateBps: 0 }), 3, state(), flags(), extra({ needsAta: false }));
    expect(d.allowed).toBe(true);
  });

  it("impact prix trop fort", () => {
    const d = rm.checkEntry(signal({ edgeEstimateBps: 5_000 }), 3, state(), flags(), extra({ liquidityUsd: 30, needsAta: false }));
    expect(d.rule).toBe("price_impact");
  });

  it("sizing: min_trade et clamps appliqués", () => {
    const d = rm.checkEntry(signal({ edgeEstimateBps: 5_000 }), 9.9, state(), flags(), extra());
    expect(d.allowed).toBe(true);
    expect(d.sizeUsd).toBeLessThanOrEqual(risk.max_trade_usd);
    const d2 = rm.checkEntry(signal({ edgeEstimateBps: 5_000, suggestedStopLossPct: 9 }), 2, state(), flags(), extra());
    expect(d2.stopLossPct).toBe(9);
  });
});
