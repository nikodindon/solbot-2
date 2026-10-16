import type { DB } from "../state/db.js";
import { upsertImportedCandles, countImportedCandles } from "../state/market.js";
import { sleep } from "../utils/time.js";

export const TF_TO_GECKO: Record<string, { unit: string; aggregate: number }> = {
  "1m": { unit: "minute", aggregate: 1 },
  "5m": { unit: "minute", aggregate: 5 },
  "15m": { unit: "minute", aggregate: 15 },
  "1h": { unit: "hour", aggregate: 1 },
};

export interface GeckoCfg {
  baseUrl: string;
  requestPauseMs: number;
  maxPages: number;
  maxRetries: number;
}

export function geckoDefaults(): GeckoCfg {
  return { baseUrl: "https://api.geckoterminal.com/api/v2", requestPauseMs: 1100, maxPages: 12, maxRetries: 3 };
}

export interface FetchLike {
  (input: string): Promise<{
    ok: boolean
    status: number
    json(): Promise<unknown>
    text(): Promise<string>
    headers: { get(name: string): string | null }
  }>;
}

interface PoolResp {
  data?: { id?: string; attributes?: { reserve_in_usd?: number | string } }[];
}

interface OhlcvResp {
  data?: { attributes?: { ohlcv_list?: number[][] } };
}

function sleepMs(ms: number): Promise<void> {
  return sleep(ms);
}

/**
 * GeckoTerminal OHLCV backfill:
 *  1) pick the pool with the largest reserve for the token;
 *  2) paginate `ohlcv` (limit=1000) from now backwards to `sinceTs`;
 *  3) store candle rows in candles_imported (source = geckoterminal).
 * Politeness: pause between requests, honors Retry-After on 429.
 */
export class GeckoBackfiller {
  constructor(
    private readonly db: DB,
    private readonly cfg: GeckoCfg = geckoDefaults(),
    private readonly fetchImpl: FetchLike = (globalThis as unknown as { fetch: FetchLike }).fetch,
  ) {}

  async bestPool(mint: string): Promise<string | null> {
    const url = `${this.cfg.baseUrl}/networks/solana/tokens/${mint}/pools?page=1&sort=h24_volume_usd_liquidity_desc`;
    let data: PoolResp | null = null;
    for (let attempt = 1; attempt <= this.cfg.maxRetries; attempt++) {
      await sleepMs(this.cfg.requestPauseMs);
      const res = await this.fetchImpl(url);
      if (res.status === 429 || res.status >= 500) {
        await sleepMs(retryAfterOrBackoff(res.headers, attempt));
        continue;
      }
      if (!res.ok) {throw new Error(`gecko pools ${res.status}: ${(await res.text()).slice(0, 200)}`);}
      data = (await res.json()) as PoolResp;
      break;
    }
    if (!data?.data?.length) {return null;}
    let best: { id: string; reserve: number } | null = null;
    for (const pool of data.data) {
      const reserve = Number(pool.attributes?.reserve_in_usd ?? 0);
      if (!best || reserve > best.reserve) {
        best = { id: pool.id ? pool.id : "", reserve };
      }
    }
    return best && best.id ? best.id : null;
  }

  /** Import `days` of `tf` candles for a token. Returns the number of rows stored. */
  async backfillToken(mint: string, tf: string, days: number): Promise<number> {
    const g = TF_TO_GECKO[tf];
    if (!g) {throw new Error(`tf non supporté par gecko: ${tf}`);}
    const pool = await this.bestPool(mint);
    if (!pool) {return 0;}
    const sinceTs = Math.floor(Date.now() / 1000 - days * 86400);
    const stored = countImportedCandles(this.db, mint, tf);
    if (stored > 0) {
      // Quick coverage check: last imported ts; if it's fresh (< 4 bars ago), nothing to do.
      const rows = latestImportedTs(this.db, mint, tf);
      if (rows && Date.now() / 1000 - rows < 4 * tfSeconds(tf) && stored >= (days * 86400 / tfSeconds(tf)) * 0.9) {
        return 0;
      }
    }
    let before: number | undefined;
    let total = 0;
    for (let page = 0; page < this.cfg.maxPages; page++) {
      const params = new URLSearchParams({
        aggregate: String(g.aggregate),
        limit: "1000",
        currency: "usd",
      });
      if (before !== undefined) {params.set("before_timestamp", String(before));}
      const url = `${this.cfg.baseUrl}/networks/solana/pools/${pool}/ohlcv/${g.unit}?${params.toString()}`;
      let rows: number[][] | null = null;
      for (let attempt = 1; attempt <= this.cfg.maxRetries; attempt++) {
        await sleepMs(this.cfg.requestPauseMs);
        const res = await this.fetchImpl(url);
        if (res.status === 429 || res.status >= 500) {
          await sleepMs(retryAfterOrBackoff(res.headers, attempt));
          continue;
        }
        if (!res.ok) {throw new Error(`gecko ohlcv ${res.status}: ${(await res.text()).slice(0, 200)}`);}
        const json = (await res.json()) as OhlcvResp;
        rows = json.data?.attributes?.ohlcv_list ?? null;
        break;
      }
      if (!rows || rows.length === 0) {break;}
      const valid = rows.filter(
        (r) =>
          r.length >= 5 &&
          r.slice(0, 5).every((v) => typeof v === "number" && Number.isFinite(v)) &&
          (r[0] as number) >= sinceTs &&
          (r[4] as number) > 0,
      );
      const candles = valid.map((r) => ({
        ts: r[0] as number,
        open: r[1] as number,
        high: r[2] as number,
        low: r[3] as number,
        close: r[4] as number,
        volume: (r.length > 5 ? (r[5] as number) : 0) as number,
      }));
      if (candles.length > 0) {
        upsertImportedCandles(this.db, mint, tf, candles);
        total += candles.length;
      }
      const oldest = valid.length > 0 ? (valid[valid.length - 1]![0] as number) : 0;
      if (oldest <= sinceTs) {break;}
      before = oldest - 1;
      if (rows.length < 1000) {break;}
    }
    return total;
  }
}

export function retryAfterOrBackoff(headers: { get(name: string): string | null }, attempt: number): number {
  const ra = headers.get("retry-after");
  if (ra && Number.isFinite(Number(ra))) {
    return Math.min(60_000, Math.max(1000, Number(ra) * 1000));
  }
  return Math.min(60_000, 1000 * Math.pow(2, attempt));
}

export function tfSeconds(tf: string): number {
  switch (tf) {
    case "1m":
      return 60;
    case "5m":
      return 300;
    case "15m":
      return 900;
    case "1h":
      return 3600;
    default:
      throw new Error(`tf: ${tf}`);
  }
}

function latestImportedTs(db: DB, mint: string, tf: string): number | null {
  const row = db
    .prepare("SELECT MAX(ts) AS m FROM candles_imported WHERE mint = ? AND tf = ?")
    .get(mint, tf) as { m: number | null } | undefined;
  return row?.m ?? null;
}
