import { describe, expect, it } from "vitest";
import { MomentumStrategy, DEFAULT_MOMENTUM } from "../../src/strategy/momentum.js";
import { MeanReversionStrategy } from "../../src/strategy/mean-reversion.js";
import { DcaRotationStrategy } from "../../src/strategy/dca-rotation.js";
import { arbitrate, scoreOf } from "../../src/strategy/arbitration.js";
import { buildStrategies } from "../../src/strategy/registry.js";
import { strategySchema } from "../../src/config/schema.js";
import { ema, rsi, zScore, highestHigh } from "../../src/strategy/indicators.js";
import { SOL_MINT, JUP_MINT } from "../../src/constants.js";
import type { AssetCtx, StrategyPortfolio } from "../../src/strategy/types.js";
import type { Bar } from "../../src/strategy/indicators.js";

function regime(momentum = true, mr = true, dca = true) {
  return {
    regime: "ranging" as const,
    volBps: 10,
    volRank: 0.5,
    slopeAtr: 0.2,
    momentumAllowed: momentum,
    meanReversionAllowed: mr,
    dcaAllowed: dca,
    reason: "test",
  };
}

const PORTF = {
  navUsd: 10,
  cashUsd: 6,
  positioned: [],
  solPrice: 150,
} as StrategyPortfolio;

function flatBars(n: number, price = 100): Bar[] {
  const t = 1_000_000;
  return Array.from({ length: n }, (_, i) => ({
    ts: t + i * 900_000,
    open: price,
    high: price * 1.001,
    low: price * 0.999,
    close: price,
    volume: 10,
  }));
}

function rallyBars(n: number): Bar[] {
  // base plate puis montée franche de ~8 barres, dernier barre à fort volume
  const base = flatBars(n - 10, 100);
  let px = 100;
  const rally: Bar[] = [];
  for (let i = 0; i < 10; i++) {
    px *= 1.02;
    rally.push({
      ts: 2_000_000 + i * 900_000,
      open: px / 1.02,
      high: px * 1.002,
      low: px * 0.997,
      close: px,
      volume: i === 9 ? 400 : 12,
    });
  }
  return [...base, ...rally];
}

function asset(mint = JUP_MINT, symbol = "JUP", price: number, bars: Bar[]): AssetCtx {
  return {
    mint,
    symbol,
    decimals: 6,
    price,
    liquidityUsd: 2_000_000,
    candles: bars,
    regime: regime(),
    volumeRatio: null,
    ataOpen: false,
  };
}

describe("indicators", () => {
  it("ema / rsi bornes", () => {
    expect(ema([1], 2)).toBeNull();
    expect(ema([1, 2, 3, 4, 5], 3)).not.toBeNull();
    expect(rsi([100, 101, 100, 101, 100, 101], 5)).toBeGreaterThan(50);
    expect(rsi([101, 100, 101, 100, 101, 100], 5)).toBeLessThan(50);
  });

  it("rsi refuse définitif haussier = 100", () => {
    const out = rsi([1, 2, 3, 4, 5, 6, 7], 5);
    expect(out).toBe(100);
  });

  it("zScore détecte la cavée sur fenêtre plate", () => {
    const bars = flatBars(95);
    bars.push({ ts: 999, open: 100, high: 100, low: 94, close: 94, volume: 10 });
    const z = zScore(bars, 96);
    expect(z).toBeLessThan(-2);
  });

  it("highestHigh exclut la barre courante", () => {
    const bars: Bar[] = [
      { ts: 1, open: 10, high: 12, low: 9, close: 10, volume: 1 },
      { ts: 2, open: 10, high: 11, low: 9, close: 10, volume: 1 },
    ];
    expect(highestHigh(bars, 20)).toBe(12);
  });
});

describe("momentum", () => {
  it("pas assez de barres → pas de signal, note explicative", () => {
    const s = new MomentumStrategy({ ...DEFAULT_MOMENTUM }, 1);
    const r = s.evaluate(asset(JUP_MINT, "JUP", 100, flatBars(10)), PORTF);
    expect(r.signals).toHaveLength(0);
    expect(r.notes[0]).toContain("pas assez de barres");
  });

  it("breakout + tendance + RSI + volume → achat", () => {
    const s = new MomentumStrategy({ ...DEFAULT_MOMENTUM }, 1);
    const bars = rallyBars(40);
    const px = bars[bars.length - 1]!.close;
    const r = s.evaluate(asset(JUP_MINT, "JUP", px * 1.01, bars), PORTF);
    const buy = r.signals.find((x) => x.side === "buy");
    expect(buy).toBeDefined();
    expect(buy!.confidence).toBeGreaterThan(0.3);
    expect(buy!.suggestedStopLossPct).toBeGreaterThan(0);
  });

  it("plateau sans breakout → rejet journalisé", () => {
    const s = new MomentumStrategy({ ...DEFAULT_MOMENTUM }, 1);
    const bars = flatBars(40);
    const r = s.evaluate(asset(JUP_MINT, "JUP", 100, bars), PORTF);
    expect(r.signals).toHaveLength(0);
    expect(r.notes.join("\n")).toContain("pas de cassure");
  });
});

describe("mean-reversion", () => {
  it("survente extrême → achat avec marge à la moyenne", () => {
    const s = new MeanReversionStrategy({ window: 96, zEntry: 2, zExit: 0.5 }, 1);
    const bars = flatBars(95);
    bars.push({ ts: 999, open: 100, high: 100, low: 94, close: 94, volume: 10 });
    const r = s.evaluate(asset(JUP_MINT, "JUP", 94, bars), PORTF);
    const buy = r.signals.find((x) => x.side === "buy");
    expect(buy).toBeDefined();
    expect(buy!.reason).toContain("survente");
  });

  it("holding + retour vers la moyenne → signal de sortie", () => {
    const s = new MeanReversionStrategy({ window: 96, zEntry: 2, zExit: 0.5 }, 1);
    const bars = flatBars(94);
    // achat "à 97.6" (dip), puis retour vers la moyenne → z ≥ −0.5 → sortie
    const dip: Bar = { ts: 9_980, open: 100, high: 100, low: 97.5, close: 97.6, volume: 10 };
    const returnBar: Bar = { ts: 9_990, open: 97.6, high: 100.2, low: 97.4, close: 100.2, volume: 10 };
    bars.push(dip, returnBar);
    expect(bars.length).toBe(96);
    expect(zScore(bars, 96)).toBeGreaterThan(-0.5);
    const withPos: StrategyPortfolio = {
      ...PORTF,
      positioned: [{ mint: JUP_MINT, symbol: "JUP", qty: 10, avgEntryUsd: 97.6, valueUsd: 100.2 * 10 }],
    };
    const r = s.evaluate(asset(JUP_MINT, "JUP", 100.2, bars), withPos);
    expect(r.signals.find((x) => x.side === "sell")).toBeDefined();
  });
});

describe("dca-rotation", () => {
  it("sous-alloué SOL → signal achat edgeExempt", () => {
    const s = new DcaRotationStrategy({ targetSol: 0.35, rebalanceBps: 250 }, 0.7);
    const withSol: StrategyPortfolio = {
      ...PORTF,
      positioned: [{ mint: SOL_MINT, symbol: "SOL", qty: 0.01, avgEntryUsd: 150, valueUsd: 1.5 }],
    };
    const r = s.evaluate(asset(SOL_MINT, "SOL", 150, []), withSol);
    const sig = r.signals.find((x) => x.side === "buy");
    expect(sig).toBeDefined();
    expect(sig!.edgeExempt).toBe(true);
  });

  it("alloué à la cible (dérive < seuil) → pas d'action, note explicite", () => {
    const s = new DcaRotationStrategy({ targetSol: 0.35, rebalanceBps: 250 }, 0.7);
    // SOL = 36% du NAV → dérive +100 bps < 250
    const near: StrategyPortfolio = {
      ...PORTF,
      positioned: [{ mint: SOL_MINT, symbol: "SOL", qty: 0.024, avgEntryUsd: 150, valueUsd: 3.6 }],
    };
    const r = s.evaluate(asset(SOL_MINT, "SOL", 150, []), near);
    expect(r.signals).toHaveLength(0);
    expect(r.notes.join("\n")).toContain("pas d'action");
  });

  it("non-SOL → n'agit pas", () => {
    const s = new DcaRotationStrategy({ targetSol: 0.35, rebalanceBps: 250 }, 0.7);
    const r = s.evaluate(asset(JUP_MINT, "JUP", 1, []), PORTF);
    expect(r.signals).toHaveLength(0);
  });
});

describe("arbitration", () => {
  const sig = (side: "buy" | "sell", mint = JUP_MINT, edge = 50, conf = 0.5, exempt = false) => ({
    mint,
    symbol: mint === SOL_MINT ? "SOL" : "JUP",
    side,
    edgeEstimateBps: edge,
    confidence: conf,
    reason: "test",
    ttlMs: 10_000,
    edgeExempt: exempt,
  });

  it("les sorties devancent les achats, meilleur score par groupe", () => {
    const scored = arbitrate([
      { strategy: "momentum", weight: 1, signal: sig("buy") },
      { strategy: "mean_reversion", weight: 1, signal: sig("sell", JUP_MINT, 0, 0.8) },
      { strategy: "momentum", weight: 1, signal: sig("buy", SOL_MINT, 500, 0.9) },
    ]);
    expect(scored[0]!.signal.side).toBe("sell");
    expect(scored[0]!.strategy).toBe("mean_reversion");
    expect(scored[1]!.signal.mint).toBe(SOL_MINT);
  });

  it("scoreOf boost l'edge (plafonné)", () => {
    const low = scoreOf({ strategy: "s", weight: 1, signal: sig("buy", JUP_MINT, 10, 0.5) });
    const high = scoreOf({ strategy: "s", weight: 1, signal: sig("buy", JUP_MINT, 100, 0.5) });
    expect(high).toBeGreaterThan(low);
    expect(scoreOf({ strategy: "s", weight: 1, signal: sig("buy", JUP_MINT, 10_000, 0.5) })).toBeCloseTo(
      scoreOf({ strategy: "s", weight: 1, signal: sig("buy", JUP_MINT, 200, 0.5) }),
      9,
    );
  });
});

describe("registry", () => {
  it("construit les 3 stratégies par défaut activées", () => {
    const list = buildStrategies(strategySchema.parse({}));
    const names = list.map((b) => b.strategy.name);
    expect(names).toEqual(["momentum", "mean_reversion", "dca_rotation"]);
    expect(list.every((b) => b.weight > 0)).toBe(true);
  });
});
