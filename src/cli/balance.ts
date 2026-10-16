import { createRuntime, type StartOpts } from "./start.js";
import { keypairFromBase58 } from "../wallet/create.js";
import { SOL_MINT, USDC_MINT, LAMPORTS_PER_SOL } from "../constants.js";

export interface BalanceLine {
  asset: string;
  qty: number;
  usd: number | null;
}

export interface BalanceReport {
  pubkey: string;
  solSol: number;
  usdcUsd: number;
  tokens: BalanceLine[];
  totalUsd: number | null;
}

/** `balance` : soldes RPC honnêtes (one-shot, engine non démarré). */
export async function runBalance(opts: StartOpts = {}): Promise<BalanceReport> {
  const rt = await createRuntime(opts);
  try {
    if (!rt.rpc) {
      throw new Error("SOLANA_RPC_URL absente — indispensable pour balance");
    }
    const secret = process.env["BS58_PRIVATE_KEY"];
    if (!secret) {throw new Error("BS58_PRIVATE_KEY absente — lancer d'abord `init`");}
    const { pubkey } = keypairFromBase58(secret);
    const solPrice = await solPriceOf(rt);
    const lamports = await rt.rpc.getBalance(pubkey);
    const solSol = lamports / LAMPORTS_PER_SOL;
    const accounts = await rt.rpc.tokenAccounts(pubkey);
    const tokens: BalanceLine[] = [];
    let total = solSol * solPrice;
    let allPriced = solPrice > 0;
    for (const t of accounts) {
      const known = rt.cfg.universe.tokens.find((u) => u.mint === t.mint);
      const symbol = t.mint === USDC_MINT ? "USDC" : known?.symbol ?? t.mint.slice(0, 4);
      const decimals = t.mint === USDC_MINT ? 6 : known?.decimals ?? t.decimals;
      const price = t.mint === USDC_MINT ? 1 : 0;
      const qty = t.amount / Math.pow(10, Math.max(0, decimals));
      const usd = price > 0 ? qty * price : null;
      if (usd === null) {allPriced = false;} else {total += usd;}
      tokens.push({ asset: symbol, qty, usd });
    }
    return {
      pubkey,
      solSol,
      usdcUsd: tokens.find((t) => t.asset === "USDC")?.qty ?? 0,
      tokens,
      totalUsd: allPriced ? total : null,
    };
  } finally {
    await rt.shutdown();
  }
}

async function solPriceOf(rt: { feed: { pollOnce(ts?: number): Promise<{ prices: Map<string, number> }> } }): Promise<number> {
  try {
    const st = await rt.feed.pollOnce();
    return st.prices.get(SOL_MINT) ?? 0;
  } catch {
    return 0;
  }
}
