import { z } from "zod";
import { TokenBucket } from "../utils/rate-limit.js";

export const priceV3Schema = z.object({
  usdPrice: z.number(),
  priceChange24h: z.number().optional(),
  blockId: z.number().optional(),
  decimals: z.number().optional(),
  liquidity: z.number().optional(),
  createdAt: z.string().optional(),
});
export type PriceV3Row = z.infer<typeof priceV3Schema>;

export type PriceRow = PriceV3Row & { mint: string };

export interface SwapOrderResponse {
  transaction: string | null;
  requestId: string;
  outAmount: string;
  inAmount?: string;
  router?: string;
  mode?: string;
  feeBps?: number;
  feeMint?: string;
  platformFee?: { amount: string; feeBps: number; feeMint: string } | null;
  errorCode?: number;
  errorMessage?: string;
  transactionVersion?: string | number;
}

export interface SwapExecuteResponse {
  status: "Success" | "Failed";
  code: number;
  signature: string;
  totalInputAmount?: string;
  totalOutputAmount?: string;
  inputAmountResult?: string;
  outputAmountResult?: string;
  error?: string;
}

export interface TokenInfo {
  id: string;
  symbol: string;
  name?: string;
  decimals: number;
  isVerified?: boolean;
  liquidity?: number;
  usdPrice?: number;
  firstPool?: { id: string; createdAt?: string } | null;
  tags?: string[];
}

export interface JupiterStats {
  requests: number;
  retries: number;
  rateLimited: number;
  errors: number;
  lastErrorAt: number | null;
}

export interface HttpResult<T> {
  data: T;
  attempts: number;
}

export interface JupiterCfg {
  apiKey?: string | null;
  /** requests per second of the main bucket (keyless default 0.5, with key 1) */
  rps?: number;
  base?: string;
  timeoutMs?: number;
  /** number of retry attempts for retryable failures (429 handled with dedicated backoff) */
  retries?: number;
}

export interface FetchLike {
  (input: string, init?: RequestInit): Promise<{
    ok: boolean;
    status: number;
    headers: Headers | { get(name: string): string | null };
    text(): Promise<string>;
  }>;
}

export class JupiterError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly endpoint: string,
    readonly body?: string,
  ) {
    super(message);
    if (body && body.length > 300) {super.message = `${message} — body: ${body.slice(0, 300)}…`;}
  }
}

/**
 * Shared HTTP client for all Jupiter API calls:
 * - token bucket honouring the keyless 0.5 RPS (or Free 1 RPS) main bucket
 * - 429 backoff driven by x-ratelimit-reset (absolute unix seconds)
 * - retries on 5xx / network errors (exponential + jitter), never on 4xx
 * - every response parsed by a zod schema (fail-fast on API drift)
 */
export class JupiterClient {
  private readonly bucket: TokenBucket;
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  readonly apiKey: string | null;
  readonly stats: JupiterStats = {
    requests: 0,
    retries: 0,
    rateLimited: 0,
    errors: 0,
    lastErrorAt: null,
  };

  constructor(
    cfg: JupiterCfg,
    private readonly fetchImpl: FetchLike = (globalThis as unknown as { fetch: FetchLike }).fetch,
  ) {
    this.apiKey = cfg.apiKey ?? null;
    this.base = cfg.base ?? "https://api.jup.ag";
    this.timeoutMs = cfg.timeoutMs ?? 15_000;
    this.retries = Math.max(0, cfg.retries ?? 3);
    const rps = cfg.rps ?? (cfg.apiKey ? 1 : 0.5);
    this.bucket = new TokenBucket(rps, Math.max(1, Math.ceil(rps)));
  }

  bucketStats() {
    return this.bucket.stats;
  }

  private headers(withKey: boolean): Record<string, string> {
    const h: Record<string, string> = { accept: "application/json" };
    if (withKey && this.apiKey) {h["x-api-key"] = this.apiKey;}
    return h;
  }

  async get<T>(
    path: string,
    params: Record<string, string | number | (string | number)[] | undefined>,
    parse: (raw: unknown) => T,
    opts: { extraBucket?: TokenBucket; timeoutMs?: number } = {},
  ): Promise<T> {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) {continue;}
      usp.set(k, String(v));
    }
    const qs = usp.toString();
    const url = `${this.base}${path}${qs ? "?" + qs : ""}`;
    return this.request(url, "GET", this.headers(true), undefined, parse, opts);
  }

  async post<T>(
    path: string,
    body: unknown,
    parse: (raw: unknown) => T,
    opts: { ownBucket?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    const url = `${this.base}${path}`;
    const headers = { ...this.headers(true), "content-type": "application/json" };
    return this.request(url, "POST", headers, JSON.stringify(body), parse, {
      timeoutMs: opts.timeoutMs,
    });
  }

  private async request<T>(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
    parse: (raw: unknown) => T,
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    const maxAttempts = this.retries + 1;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // main bucket (token bucket) — /swap/v2/execute would have an own bucket but 0.5 RPS
      // keyless throughput is irrelevant: one fetch is plenty-fast enough for a trade
      while (!this.bucket.tryAcquire()) {
        const w = this.bucket.waitTimeMs();
        this.bucket.stats.waited += 1;
        this.bucket.stats.totalWaitMs += w;
        await sleep(Math.min(w, 2000));
      }
      this.stats.requests += 1;
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
        });
        if (res.status === 429) {
          this.stats.rateLimited += 1;
          lastErr = new JupiterError("rate limited", 429, url);
          const wait = backoffFromHeaders(res.headers);
          if (attempt < maxAttempts) {
            this.stats.retries += 1;
            await sleep(wait);
            continue;
          }
          throw lastErr;
        }
        if (res.status >= 500) {
          lastErr = new JupiterError(`jupiter ${res.status}`, res.status, url);
          if (attempt < maxAttempts) {
            this.stats.retries += 1;
            await sleep(retryDelayMs(attempt));
            continue;
          }
          throw lastErr;
        }
        const text = await res.text();
        if (!res.ok) {
          this.stats.errors += 1;
          this.stats.lastErrorAt = Date.now();
          throw new JupiterError(`jupiter ${res.status} on ${method} ${shortUrl(url)}`, res.status, shortUrl(url), text);
        }
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          this.stats.errors += 1;
          throw new JupiterError(`réponse non-JSON (${shortUrl(url)})`, res.status, shortUrl(url), text);
        }
        return parse(json);
      } catch (err) {
        if (err instanceof JupiterError) {throw err;}
        // network / timeout errors: retryable
        this.stats.errors += 1;
        this.stats.lastErrorAt = Date.now();
        lastErr = err;
        if (attempt < maxAttempts) {
          this.stats.retries += 1;
          await sleep(retryDelayMs(attempt));
          continue;
        }
        throw err instanceof Error ? err : new Error(String(err));
      }
    }
    // unreachable
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

function retryDelayMs(attempt: number): number {
  const base = 400 * Math.pow(2, attempt - 1);
  return Math.min(60_000, base + Math.floor(Math.random() * 120));
}

/** x-ratelimit-reset is an absolute unix timestamp (seconds) — wait until then, capped. */
export function backoffFromHeaders(headers: { get(name: string): string | null }): number {
  const reset = headers.get("x-ratelimit-reset");
  if (reset) {
    const resetMs = Number(reset) * 1000;
    if (Number.isFinite(resetMs) && resetMs > 0) {
      return Math.max(100, Math.min(120_000, resetMs - Date.now()));
    }
  }
  return Math.min(2000, 250 * (1 + Math.floor(Math.random() * 2)));
}

export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}${u.search.length > 60 ? u.search.slice(0, 60) + "…" : u.search}`;
  } catch {
    return url;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
