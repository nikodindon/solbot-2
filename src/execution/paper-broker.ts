import { LAMPORTS_PER_SOL } from "../constants.js";

export interface FillCommon {
  priceEffective: number;
  jupFeeUsd: number;
  solFee: number; // SOL units (base + priority)
  slippageBps: number; // modeled
  impactBps: number;
}

export interface BuyFill extends FillCommon {
  qty: number;
  spendUsd: number;
}

export interface SellFill extends FillCommon {
  proceedsUsd: number; // net USDC credited
  grossUsd: number;
}

export interface FillCosts {
  feeBps: number; // Jupiter platform fee for the pair (one-way)
  slippageBps: number; // paper fill slippage
  solPrice: number;
  priorityFeeSol: number;
  liquidityUsd?: number | null;
}

/** Estimated xy=k-ish impact in bps for paper fills (capped). */
function impactBps(notionalUsd: number, liquidityUsd?: number | null): number {
  const liq = liquidityUsd ?? 1_000_000;
  if (!(liq > 0)) {return 0;}
  return Math.min(500, ((2 * Math.max(0, notionalUsd)) / liq) * 10_000);
}

/** BUY: spend `spendUsd` (USDC, fees included) -> qty of token. */
export function simulateBuy(spendUsd: number, price: number, c: FillCosts): BuyFill {
  if (!(price > 0) || !(spendUsd > 0)) {throw new Error(`simulateBuy: entrées invalides (${spendUsd}, ${price})`);}
  const impact = impactBps(spendUsd, c.liquidityUsd);
  const priceEff = price * (1 + (c.slippageBps + impact) / 10_000);
  const jupFeeUsd = (spendUsd * c.feeBps) / 10_000;
  const solFee = ((5_000 + c.priorityFeeSol * LAMPORTS_PER_SOL) / LAMPORTS_PER_SOL);
  const solFeeUsd = solFee * c.solPrice;
  const investable = Math.max(0, spendUsd - jupFeeUsd - solFeeUsd);
  const qty = investable / priceEff;
  return { qty, spendUsd, priceEffective: priceEff, jupFeeUsd, solFee, slippageBps: c.slippageBps, impactBps: impact };
}

/** SELL: qty at price -> net USDC proceeds. */
export function simulateSell(qty: number, price: number, c: FillCosts): SellFill {
  if (!(price > 0) || !(qty > 0)) {throw new Error(`simulateSell: entrées invalides (${qty}, ${price})`);}
  const grossUsd = qty * price;
  const impact = impactBps(grossUsd, c.liquidityUsd);
  const priceEff = price * (1 - (c.slippageBps + impact) / 10_000);
  const grossEff = qty * priceEff;
  const jupFeeUsd = (grossEff * c.feeBps) / 10_000;
  const solFee = ((5_000 + c.priorityFeeSol * LAMPORTS_PER_SOL) / LAMPORTS_PER_SOL);
  const solFeeUsd = solFee * c.solPrice;
  const proceedsUsd = Math.max(0, grossEff - jupFeeUsd - solFeeUsd);
  return { proceedsUsd, grossUsd, priceEffective: priceEff, jupFeeUsd, solFee, slippageBps: c.slippageBps, impactBps: impact };
}
