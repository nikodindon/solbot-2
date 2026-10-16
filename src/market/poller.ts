import type { DB } from "../state/db.js";
import { insertTicks, upsertCandles, upsertTokenMeta } from "../state/market.js";
import type { PriceApi } from "../jupiter/price.js";
import { SOL_MINT, USDC_MINT } from "../constants.js";
import type { SwapApi } from "../jupiter/swap.js";

export const TFS = ["1m", "5m", "15m", "1h"] as const;
export type TF = (typeof TFS)[number];

export interface PollerCfg {
  mints: string[]; // full watchlist incl. SOL/USDC
}

export interface PollOnceResult {
  ok: boolean;
  prices: Map<string, number>;
  volumesKnown: boolean;
  error?: string;
}

/**
 * Market refresh per tick — 2 API requests for the whole watchlist (≤50 mints):
 *  - price/v3 (fresh) -> ticks -> degenerate candles 1m/5m/15m/1h
 *  - tokens/v2/search -> decimals/liquidity/age + stats24h -> volume delta estimate for the candle
 * Volume failures are tolerated (candle volume simply delayed by one tick).
 */
export class Poller {
  private lastStats = new Map<string, number>();

  constructor(
    private readonly db: DB,
    private readonly priceApi: PriceApi,
    private readonly swapApi: SwapApi,
    private readonly cfg: PollerCfg,
  ) {}

  async pollOnce(ts = Date.now()): Promise<PollOnceResult> {
    const mints = [...new Set(this.cfg.mints)];
    try {
      const rows = await this.priceApi.refresh(mints, { fresh: true });
      if (rows.size === 0) {
        return { ok: false, prices: new Map(), volumesKnown: false, error: "aucun prix (price v3 vide)" };
      }
      const { volumes, ok: volOk } = await this.fetchVolumes(mints);
      const ticks: {
        ts: number;
        mint: string;
        price: number;
        liquidity: number | null;
        volumeDelta: number | null;
      }[] = [];
      for (const [mint, row] of rows) {
        const volumeDelta = volumes.get(mint) ?? null;
        ticks.push({ ts, mint, price: row.usdPrice, liquidity: row.liquidity ?? null, volumeDelta });
      }
      insertTicks(this.db, ticks);
      for (const tf of TFS) {
        upsertCandles(this.db, tf, ts, ticks);
      }
      const metaRows = await this.swapApi.tokenInfo(mints.filter((m) => m !== SOL_MINT && m !== USDC_MINT));
      for (const [mint, t] of metaRows) {
        upsertTokenMeta(
          this.db,
          {
            mint,
            symbol: t.symbol,
            decimals: t.decimals,
            isVerified: t.isVerified,
            liquidityUsd: t.liquidity ?? null,
            poolCreatedMs: t.poolCreatedMs,
          },
          ts,
        );
      }
      return {
        ok: true,
        prices: new Map([...rows.entries()].map(([m, r]) => [m, r.usdPrice])),
        volumesKnown: volOk,
      };
    } catch (err) {
      return { ok: false, prices: new Map(), volumesKnown: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async fetchVolumes(mints: string[]): Promise<{ volumes: Map<string, number>; ok: boolean }> {
    const volumes = new Map<string, number>();
    const extra = mints.filter((m) => m !== SOL_MINT && m !== USDC_MINT);
    if (extra.length === 0) {return { volumes, ok: mints.length <= 2 };}
    try {
      const stats = await this.swapApi.tokenInfo(extra);
      for (const [mint, t] of stats) {
        const v24 = (t.stats24h?.buyVolume ?? 0) + (t.stats24h?.sellVolume ?? 0);
        const last = this.lastStats.get(mint);
        if (last !== undefined && v24 >= last) {volumes.set(mint, v24 - last);}
        this.lastStats.set(mint, v24);
      }
      return { volumes, ok: true };
    } catch {
      return { volumes, ok: false };
    }
  }
}
