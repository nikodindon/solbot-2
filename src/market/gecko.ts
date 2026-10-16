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
  /** clé démo CoinGecko (GECKO_API_KEY) — OHLCV exige une clé depuis 2026 : bascule l'URL */
  apiKey?: string | null;
}

export function geckoDefaults(): GeckoCfg {
  return { baseUrl: "https://api.geckoterminal.com/api/v2", requestPauseMs: 1100, maxPages: 12, maxRetries: 3, apiKey: null };
}

export interface FetchLike {
  (input: string, init?: { headers?: Record<string, string> }): Promise<{
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
  /** apiKey → endpoint v3 onchain (où OHLCV accepte les clés démo). */
  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly cfg: GeckoCfg;

  constructor(
    private readonly db: DB,
    cfg: GeckoCfg = geckoDefaults(),
    private readonly fetchImpl: FetchLike = (globalThis as unknown as { fetch: FetchLike }).fetch,
  ) {
    this.cfg = { ...cfg, apiKey: null };
    this.apiKey = cfg.apiKey ?? null;
    this.baseUrl = this.apiKey && cfg.baseUrl === "https://api.geckoterminal.com/api/v2"
      ? "https://api.coingecko.com/api/v3/onchain"
      : cfg.baseUrl;
  }

  private reqInit(): { headers?: Record<string, string> } | undefined {
    return this.apiKey ? { headers: { "x-cg-demo-api-key": this.apiKey } } : undefined;
  }

  async bestPool(mint: string): Promise<string | null> {
    const url = `${this.baseUrl}/networks/solana/tokens/${mint}/pools?page=1&sort=h24_volume_usd_liquidity_desc`;
    let data: PoolResp | null = null;
    for (let attempt = 1; attempt <= this.cfg.maxRetries; attempt++) {
      await sleepMs(this.cfg.requestPauseMs);
      const res = await this.fetchImpl(url, this.reqInit());
      if (res.status === 429 || res.status >= 500) {
        await sleepMs(retryAfterOrBackoff(res.headers, attempt));
        continue;
      }
      if (!res.ok) {
        const hint = this.apiKey ? "" : " — accès pools OK sans clé (si 404 persistant: URL du pool à re-vérifier)";
        throw new Error(`gecko pools ${res.status}: ${(await res.text()).slice(0, 200)}${hint}`);
      }
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
    // endpoint OHLCV onchain: adresse NUE attendue (pas l'ID "solana_…" de la v2)
    const poolAddress = pool.replace(/^[a-z0-9]+_/, "");
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
      const url = `${this.baseUrl}/networks/solana/pools/${poolAddress}/ohlcv/${g.unit}?${params.toString()}`;
      let rows: number[][] | null = null;
      for (let attempt = 1; attempt <= this.cfg.maxRetries; attempt++) {
        await sleepMs(this.cfg.requestPauseMs);
        const res = await this.fetchImpl(url, this.reqInit());
        if (res.status === 429 || res.status >= 500) {
          await sleepMs(retryAfterOrBackoff(res.headers, attempt));
          continue;
        }
        if (!res.ok) {
          const hint = this.apiKey ? "" : " — l'OHLCV exige une clé (register une clé démo gratuite CoinGecko puis GECKO_API_KEY in .env)";
          throw new Error(`gecko ohlcv ${res.status}: ${(await res.text()).slice(0, 200)}${hint}`);
        }
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
