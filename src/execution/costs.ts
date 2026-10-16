import { BASE_FEE_LAMPORTS, ATA_RENT_LAMPORTS, LAMPORTS_PER_SOL } from "../constants.js";
import { modeledPairFeeBps } from "../jupiter/swap.js";

export interface CostModelCfg {
  edgeMultiplier: number;
  expectedSlippageBps: number;
  paperFillSlippageBps: number;
}

export interface CostParts {
  /** Jupiter platform fee round trip (2 swaps) */
  feeBps: number;
  /** base fee + priority fee over 2 swaps, in bps of notional */
  solBps: number;
  /** expected slippage over 2 swaps (conservative: charged both ways) */
  slippageBps: number;
  /** ATA rent (one-time, worst-case full cost) in bps of notional */
  rentBps: number;
  totalBps: number;
}

export interface CostQuery {
  notionalUsd: number;
  solPrice: number;
  inputMint: string;
  outputMint: string;
  /** SOL priority fee config (0 → modeled at 0.00002) */
  priorityFeeSol: number;
  /** true → a brand-new token account would be opened by this trade (~0.00204 SOL all-in) */
  needsAta: boolean;
}

/** Round-trip cost estimate BEFORE trading (buy→sell), in bps of notional. Honest, worst-case-ish. */
export function estimateRoundTripCost(q: CostQuery): CostParts {
  const notional = Math.max(0.01, q.notionalUsd);
  const feeBps = modeledPairFeeBps(q.inputMint, q.outputMint) + modeledPairFeeBps(q.outputMint, q.inputMint);
  const solFeeSol = (BASE_FEE_LAMPORTS + Math.max(0, q.priorityFeeSol) * LAMPORTS_PER_SOL) / LAMPORTS_PER_SOL;
  const solFeeUsd = solFeeSol * q.solPrice;
  const solBps = ((2 * solFeeUsd) / notional) * 10_000;
  const slippageBps = 2 * 15; // fixed expectation placeholder, overridden below
  let rentBps = 0;
  if (q.needsAta) {
    const rentUsd = (ATA_RENT_LAMPORTS / LAMPORTS_PER_SOL) * q.solPrice;
    rentBps = (rentUsd / notional) * 10_000;
  }
  return { feeBps, solBps, slippageBps, rentBps, totalBps: feeBps + solBps + slippageBps + rentBps };
}

export function estimateCostWithSlippage(q: CostQuery, cfg: CostModelCfg): CostParts {
  const base = estimateRoundTripCost(q);
  const slippageBps = 2 * Math.max(0, cfg.expectedSlippageBps);
  return { ...base, slippageBps, totalBps: base.feeBps + base.solBps + slippageBps + base.rentBps };
}

/** How many more swaps the gas above the reserve can afford (base fee + priority each way). */
export function swapsRemaining(solAboveReserve: number, priorityFeeSol: number, _solPrice?: number): number {
  const perSwapSol = (BASE_FEE_LAMPORTS + Math.max(0, priorityFeeSol) * LAMPORTS_PER_SOL) / LAMPORTS_PER_SOL;
  if (!(perSwapSol > 0)) {return 999;}
  return Math.floor(Math.max(0, solAboveReserve) / perSwapSol);
}

/** Estimated price impact in bps for a small market order (conservative xy=k-ish). */
export function impactBps(notionalUsd: number, liquidityUsd: number | null): number {
  const liq = liquidityUsd ?? 1_000_000;
  if (!(liq > 0)) {return 0;}
  return Math.min(5_000, (2 * Math.max(0, notionalUsd) / liq) * 10_000);
}
