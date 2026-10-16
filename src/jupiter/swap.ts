import { z } from "zod";
import type { JupiterClient } from "./client.js";
import type { SwapExecuteResponse, SwapOrderResponse } from "./client.js";
import { jupiterPairFeeBps, STABLE_MINTS } from "../constants.js";

const orderSchema = z.object({
  transaction: z.string().nullable().optional(),
  requestId: z.string().optional(),
  outAmount: z.string().optional(),
  inAmount: z.string().optional(),
  router: z.string().optional(),
  mode: z.string().optional(),
  feeBps: z.number().optional(),
  feeMint: z.string().optional(),
  platformFee: z
    .object({ amount: z.string(), feeBps: z.number(), feeMint: z.string() })
    .nullish(),
  errorCode: z.number().optional(),
  errorMessage: z.string().optional(),
  transactionVersion: z.union([z.string(), z.number()]).optional(),
});

const executeSchema = z.object({
  status: z.enum(["Success", "Failed"]),
  code: z.number(),
  signature: z.string().nullable().optional(),
  totalInputAmount: z.string().optional(),
  totalOutputAmount: z.string().optional(),
  inputAmountResult: z.string().optional(),
  outputAmountResult: z.string().optional(),
  error: z.string().optional(),
});

const tokenSearchSchema = z.array(
  z.object({
    id: z.string(),
    symbol: z.string(),
    name: z.string().optional(),
    decimals: z.number(),
    isVerified: z.boolean().optional(),
    liquidity: z.number().optional(),
    usdPrice: z.number().optional(),
    firstPool: z.object({ id: z.string(), createdAt: z.string().optional() }).nullish(),
    stats24h: z
      .object({ buyVolume: z.number().optional(), sellVolume: z.number().optional() })
      .optional(),
    tags: z.array(z.string()).optional(),
  }),
);

export class SwapApi {
  constructor(private readonly client: JupiterClient) {}

  /** Meta-Aggregator /order (quote + assembled transaction). Pass taker to get a signable tx. */
  async order(req: {
    inputMint: string;
    outputMint: string;
    amount: string;
    taker?: string;
    maxSupportedTransactionVersion?: "0" | "1";
  }): Promise<SwapOrderResponse> {
    const raw = await this.client.get(
      "/swap/v2/order",
      { ...req },
      (j) => orderSchema.parse(j),
      { timeoutMs: 30_000 },
    );
    return raw as SwapOrderResponse;
  }

  /** POST /swap/v2/execute — own bucket server-side; no extra client-side bucket needed. */
  async execute(body: { signedTransaction: string; requestId: string; lastValidBlockHeight?: string }): Promise<SwapExecuteResponse> {
    const raw = await this.client.post("/swap/v2/execute", body, (j) => executeSchema.parse(j), {
      timeoutMs: 60_000,
    });
    return raw as SwapExecuteResponse;
  }

  /** Tokens v2 search — runtime universe verification (verified, decimals, liquidity, age). */
  async tokenInfo(mints: string[]): Promise<Map<string, TokenInfoParsed>> {
    const usp = mints.slice(0, 10).join(","); // search accepts comma-separated addresses
    const raw = await this.client.get("/tokens/v2/search", { query: usp }, (j) =>
      tokenSearchSchema.parse(j),
    );
    const out = new Map<string, TokenInfoParsed>();
    for (const t of raw) {
      let poolCreatedMs: number | null = null;
      if (t.firstPool?.createdAt) {
        const ts = Date.parse(t.firstPool.createdAt);
        if (Number.isFinite(ts)) {poolCreatedMs = ts;}
      }
      out.set(t.id, {
        mint: t.id,
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals,
        isVerified: t.isVerified === true,
        liquidity: t.liquidity,
        poolCreatedMs,
        stats24h: t.stats24h
          ? { buyVolume: t.stats24h.buyVolume ?? 0, sellVolume: t.stats24h.sellVolume ?? 0 }
          : undefined,
      });
    }
    return out;
  }
}

export type TokenInfoParsed = {
  mint: string;
  symbol: string;
  name?: string;
  decimals: number;
  isVerified: boolean;
  liquidity?: number;
  poolCreatedMs: number | null;
  stats24h?: { buyVolume: number; sellVolume: number };
};

/** Modeled Jupiter platform fee (bps) for a pair — same schedule vX docs; used pre-trade in the cost model. */
export function modeledPairFeeBps(inputMint: string, outputMint: string): number {
  if (STABLE_MINTS.has(inputMint) && STABLE_MINTS.has(outputMint)) {return 0;}
  return jupiterPairFeeBps(inputMint, outputMint);
}
