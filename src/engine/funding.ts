import type { RpcClient } from "../solana/rpc.js";
import type { FundingConfig } from "../config/schema.js";
import { USDC_MINT, LAMPORTS_PER_SOL } from "../constants.js";

export interface WalletBalances {
  lamports: number;
  tokens: { mint: string; amount: number; decimals: number }[];
}

export interface FundingStatus {
  funded: boolean;
  solSol: number;
  solUsd: number;
  usdcUsd: number;
  missing: { item: string; have: number; need: number }[];
  sinceMs: number;
}

export interface BalanceDeps {
  rpc: RpcClient | null;
}

/**
 * FundingWatcher — attend le financement initial (config funding: min_sol_usd / min_usdc_usd)
 * en polling honnête des soldes RPC. Utilisé par `start` (paper: instantané) et doctor.
 */
export class FundingWatcher {
  constructor(private readonly deps: BalanceDeps, private readonly min: FundingConfig) {}

  async measure(owner: string | null, priceOfSol: number): Promise<FundingStatus> {
    const { rpc } = this.deps;
    if (!rpc || !owner) {
      return {
        funded: false,
        solSol: 0,
        solUsd: 0,
        usdcUsd: 0,
        missing: [{ item: "wallet/RPC", have: 0, need: 1 }],
        sinceMs: Date.now(),
      };
    }
    const lamports = await rpc.getBalance(owner);
    let usdc = 0;
    for (const t of await rpc.tokenAccounts(owner)) {
      if (t.mint === USDC_MINT) {
        usdc = t.amount / Math.pow(10, t.decimals);
      }
    }
    const solSol = lamports / LAMPORTS_PER_SOL;
    const solUsd = solSol * priceOfSol;
    const missing: FundingStatus["missing"] = [];
    if (solUsd < this.min.min_sol_usd) {
      missing.push({ item: "SOL", have: Number(solUsd.toFixed(4)), need: this.min.min_sol_usd });
    }
    if (usdc < this.min.min_usdc_usd) {
      missing.push({ item: "USDC", have: Number(usdc.toFixed(2)), need: this.min.min_usdc_usd });
    }
    return {
      funded: missing.length === 0,
      solSol,
      solUsd,
      usdcUsd: usdc,
      missing,
      sinceMs: Date.now(),
    };
  }

  async status(owner: string | null, priceOfSol: number): Promise<FundingStatus> {
    return this.measure(owner, priceOfSol);
  }
}
