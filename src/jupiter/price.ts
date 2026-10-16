import { z } from "zod";
import type { JupiterClient } from "./client.js";
import { priceV3Schema } from "./client.js";
import { chunk } from "../utils/math.js";
import type { PriceRow } from "./client.js";

const priceResponseSchema = z.record(z.string(), priceV3Schema);

export const PRICE_BATCH = 50;
const TTL_MS = 8_000;

export interface PriceOptions {
  /** bypass the TTL cache (engine wants fresh data) */
  fresh?: boolean;
}

/**
 * Price API v3 wrapper: batches of 50 mints max, TTL dedupe, throttled by JupiterClient's bucket.
 * Missing mints (illiquid/unreliable) are simply absent from the result map — the universe
 * verifier treats them as not tradable.
 */
export class PriceApi {
  private lastFetchAll = 0;
  private cache = new Map<string, PriceRow>();

  constructor(private readonly client: JupiterClient) {}

  async refresh(mints: string[], opts: PriceOptions = {}): Promise<Map<string, PriceRow>> {
    const now = Date.now();
    if (!opts.fresh && now - this.lastFetchAll < TTL_MS && this.cache.size > 0) {
      const out = new Map<string, PriceRow>();
      for (const m of mints) {
        const row = this.cache.get(m);
        if (row) {out.set(m, row);}
      }
      return out;
    }
    const all = chunk([...new Set(mints)], PRICE_BATCH);
    const map = new Map<string, PriceRow>();
    for (const part of all) {
      const ids = part.join(",");
      const raw = await this.client.get("/price/v3", { ids }, (j) => priceResponseSchema.parse(j));
      for (const [mint, row] of Object.entries(raw)) {
        const price: PriceRow = { mint, ...row };
        map.set(mint, price);
        this.cache.set(mint, price);
      }
    }
    this.lastFetchAll = Date.now();
    return map;
  }

  cached(mint: string): PriceRow | undefined {
    return this.cache.get(mint);
  }

  /** For engine phases that only need last-known prices (paper NAV recompute between polls). */
  cachedAll(mints: string[]): Map<string, PriceRow> {
    const out = new Map<string, PriceRow>();
    for (const m of mints) {
      const row = this.cache.get(m);
      if (row) {out.set(m, row);}
    }
    return out;
  }
}
