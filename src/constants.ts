export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const JUP_MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
export const BONK_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

export const JUPITER_API_BASE = "https://api.jup.ag";
export const GECKO_API_BASE = "https://api.geckoterminal.com/api/v2";
export const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";

export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Solana per-signature base fee, lamports. */
export const BASE_FEE_LAMPORTS = 5_000;
/** Approx. rent-exempt lamports for an SPL token account (ATA of a standard ~165-byte account). */
export const ATA_RENT_LAMPORTS = 2_041_200;

/** Jupiter Swap fee schedule (bps), by pair — verified against developers.jup.ag (2026-10). */
export const JUP_TOKEN_MINTS = new Set<string>([
  JUP_MINT,
  "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjxhtv", // jupSOL
]);
export const LST_MINTS = new Set<string>([
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", // jitoSOL
  "7Q2afV64in6N6SeZsAAB81UJj9skM99QqholfZiFqEE6", // fragSOL — placeholder kept minimal, see docs
]);

export const STABLE_MINTS = new Set<string>([
  USDC_MINT,
  "Es9vMFrzaCERm8HmYdW4vfzjqyx9fD2sAvm1FoVn2N8H", // USDT
]);

export const DEFAULT_WATCHLIST_EXTRA = [
  { mint: JUP_MINT, symbol: "JUP", decimals: 6 },
  { mint: BONK_MINT, symbol: "BONK", decimals: 5 },
];

export interface PairFeeRule {
  bps: number;
}

/**
 * Jupiter platform fee (bps) for a given pair, replicated from the documented schedule:
 * 0  buying Jupiter tokens (from SOL/stable, or stable↔stable / LST↔LST pegged)
 * 2  SOL↔stable
 * 5  LST↔stable
 * 10 everything else
 * 50 tokens younger than 24h (excluded from our universe anyway)
 */
export function jupiterPairFeeBps(inputMint: string, outputMint: string): number {
  const isStable = (m: string) => STABLE_MINTS.has(m);
  const isS = (m: string) => m === SOL_MINT;
  const bothPegged =
    (isStable(inputMint) && isStable(outputMint)) ||
    (LST_MINTS.has(inputMint) && LST_MINTS.has(outputMint));
  if (bothPegged) {return 0;}
  if (JUP_TOKEN_MINTS.has(inputMint) || JUP_TOKEN_MINTS.has(outputMint)) {
    // buying (or selling into) a Jupiter token product from SOL/stable = 0
    if (isS(inputMint) || isS(outputMint) || isStable(inputMint) || isStable(outputMint)) {return 0;}
  }
  if ((isS(inputMint) && isStable(outputMint)) || (isStable(inputMint) && isS(outputMint)))
    {return 2;}
  if (
    (LST_MINTS.has(inputMint) && isStable(outputMint)) ||
    (isStable(inputMint) && LST_MINTS.has(outputMint))
  )
    {return 5;}
  return 10;
}
