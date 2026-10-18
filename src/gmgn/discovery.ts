/**
 * Scalper GMGN (mode paper): discovery "nouveaux lancements + trending volume".
 * Feed swappable :
 *  - GeckoFeed (gratuit, GECKO_API_KEY) — défaut tant que la clé GMGN n'est pas dispo;
 *  - GmgnFeed (GMGN_API_KEY) — rank + kline (actif dès que la clé existe, min balance $100).
 */
import { sleep } from "../utils/time.js";

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  headers: { get(name: string): string | null };
}>;

export interface Bar {
  ts: number; // seconds (open ts)
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
}

export interface Candidate {
  mint: string;
  symbol: string;
  priceUsd: number;
  liquidityUsd: number;
  change5mPct: number;
  vol5mUsd: number;
  vol24hUsd: number;
  createdMs: number;
}

export interface DiscoveryFeed {
  readonly name: string;
  refresh(): Promise<Candidate[]>;
  latestCandle(mint: string): Promise<Bar | null>;
  snapshotPrice(mint: string): number | null;
}

const num = (v: string | number | undefined): number => {
  if (v === undefined || v === null) {return 0;}
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const SOL = "So11111111111111111111111111111111111111112";

interface PoolAttr {
  reserve_in_usd?: string | number;
  base_token?: { address?: string; symbol?: string };
  price_change_percentage?: { m5?: string | number };
  volume_usd?: { m5?: string | number; h24?: string | number };
  pool_created_at?: string;
  base_token_price_usd?: string;
}

interface PoolResp {
  data?: { id?: string; attributes?: PoolAttr; relationships?: { base_token?: { data?: { id?: string } } } }[];
  included?: { id?: string; attributes?: { address?: string; symbol?: string }; type?: string }[];
}
interface OhlcvResp { data?: { attributes?: { ohlcv_list?: number[][] } } }

// ---------- GeckoTerminal (gratuit, clé démo) ----------

export interface GeckoFeedCfg {
  baseUrl: string;
  apiKey: string | null;
  requestPauseMs: number;
  maxCandidates: number;
  /** anti-snipe de création : pool âgée d'au moins minAgeMin (min) */
  minAgeMin: number;
  maxAgeMin: number;
  maxRetries: number;
}

export function geckoFeedDefaults(apiKey: string | null): GeckoFeedCfg {
  return {
    baseUrl: apiKey ? "https://api.coingecko.com/api/v3/onchain" : "https://api.geckoterminal.com/api/v2",
    apiKey,
    requestPauseMs: 1_200,
    maxCandidates: 10,
    minAgeMin: 2,
    maxAgeMin: 24 * 60,
    maxRetries: 2,
  };
}

export class GeckoFeed implements DiscoveryFeed {
  readonly name = "gecko";
  private prices = new Map<string, number>();
  private poolCache = new Map<string, string | null>();
  private lastRefresh = 0;

  constructor(
    private cfg: GeckoFeedCfg,
    private readonly fetchImpl: FetchLike = (globalThis as unknown as { fetch: FetchLike }).fetch,
  ) {}

  private headers(): Record<string, string> | undefined {
    return this.cfg.apiKey ? { "x-cg-demo-api-key": this.cfg.apiKey } : undefined;
  }

  private async getJson<T>(url: string): Promise<T | null> {
    for (let a = 1; a <= this.cfg.maxRetries; a++) {
      try {
        const res = await this.fetchImpl(url, { headers: this.headers() });
        if (res.status === 429 || res.status >= 500) {
          const ra = res.headers.get("retry-after");
          await sleep(ra ? Number(ra) * 1_000 : this.cfg.requestPauseMs * a);
          continue;
        }
        if (!res.ok) {throw new Error(`gecko ${res.status}: ${(await res.text()).slice(0, 160)}`);}
        return (await res.json()) as T;
      } catch (err) {
        if (a >= this.cfg.maxRetries) {throw err;}
        await sleep(this.cfg.requestPauseMs * a);
      }
    }
    return null;
  }

  private parsePool(
    p: PoolAttr | undefined,
    baseToken: { address: string; symbol?: string } | null,
  ): Candidate | null {
    if (!p || !baseToken) {return null;}
    const mint = baseToken.address;
    if (!mint || mint === SOL) {return null;}
    const createdMs = p.pool_created_at ? Date.parse(p.pool_created_at) : 0;
    const ageMin = createdMs ? (Date.now() - createdMs) / 60_000 : 999_999;
    if (ageMin < this.cfg.minAgeMin || ageMin > this.cfg.maxAgeMin) {return null;}
    const price = num(p.base_token_price_usd);
    if (price <= 0) {return null;}
    const liq = num(p.reserve_in_usd);
    if (liq < 5_000) {return null;}
    return {
      mint,
      symbol: ((baseToken.symbol ?? mint.slice(0, 4)) || mint.slice(0, 4)).slice(0, 12),
      priceUsd: price,
      liquidityUsd: liq,
      change5mPct: num(p.price_change_percentage?.m5),
      vol5mUsd: num(p.volume_usd?.m5),
      vol24hUsd: num(p.volume_usd?.h24),
      createdMs,
    };
  }

  async refresh(): Promise<Candidate[]> {
    const now = Date.now();
    if (now - this.lastRefresh < this.cfg.requestPauseMs) {return this.cached();}
    this.lastRefresh = now;
    this.cachedList = [];
    for (const path of [
      "networks/solana/new_pools?page=1&include=base_token,dex",
      "networks/solana/pools?page=1&sort=h24_volume_usd_desc&include=base_token,dex",
    ]) {
      const j = await this.getJson<PoolResp>(`${this.cfg.baseUrl}/${path}`);
      // map id token gecko → {address, symbol} depuis `included`
      const baseInfo = new Map<string, { address: string; symbol?: string }>();
      for (const inc of j?.included ?? []) {
        const addr = inc.attributes?.address;
        if (inc.type === "token" && inc.id && addr) {
          baseInfo.set(inc.id, { address: addr, symbol: inc.attributes?.symbol });
        }
      }
      for (const item of j?.data ?? []) {
        const relId = item.relationships?.base_token?.data?.id;
        const base = relId ? baseInfo.get(relId) ?? null : null;
        const c = this.parsePool(item.attributes, base);
        if (c) {this.cachedList.push(c);}
        if (this.cachedList.length >= this.cfg.maxCandidates) {break;}
      }
      await sleep(this.cfg.requestPauseMs);
    }
    const seen = new Set<string>();
    this.cachedList = this.cachedList.filter((c) => (seen.has(c.mint) ? false : (seen.add(c.mint), true)));
    for (const c of this.cachedList) {this.prices.set(c.mint, c.priceUsd);}
    return this.cachedList;
  }

  private cachedList: Candidate[] = [];
  private cached(): Candidate[] {return this.cachedList;}

  snapshotPrice(mint: string): number | null {
    return this.prices.get(mint) ?? null;
  }

  /** pool du token à plus grosse réserve (cache par mint) */
  private async poolFor(mint: string): Promise<string | null> {
    if (this.poolCache.has(mint)) {return this.poolCache.get(mint) ?? null;}
    const j = await this.getJson<PoolResp>(
      `${this.cfg.baseUrl}/networks/solana/tokens/${mint}/pools?page=1&sort=h24_volume_usd_liquidity_desc`,
    );
    let best: { id: string; liq: number } | null = null;
    for (const p of j?.data ?? []) {
      const liq = num(p.attributes?.reserve_in_usd);
      const id = p.id ?? "";
      if (!best || liq > best.liq) {best = { id, liq };}
    }
    const pool = best?.id ? best.id.replace(/^[a-z0-9]+_/, "") : null;
    this.poolCache.set(mint, pool);
    return pool;
  }

  /** dernière bougie 1m clôturée (OHLCV, pool du mint). */
  async latestCandle(mint: string): Promise<Bar | null> {
    const pool = await this.poolFor(mint);
    if (!pool) {return null;}
    const j = await this.getJson<OhlcvResp>(
      `${this.cfg.baseUrl}/networks/solana/pools/${pool}/ohlcv/minute?aggregate=1&limit=2&currency=usd`,
    );
    const row = j?.data?.attributes?.ohlcv_list?.[0];
    if (!row) {return null;}
    return { ts: row[0]!, open: row[1]!, high: row[2]!, low: row[3]!, close: row[4]!, volumeUsd: row[5] ?? 0 };
  }
}

// ---------- GMGN OpenAPI (requiert GMGN_API_KEY — auth "exist") ----------

export interface GmgnFeedCfg {
  host: string;
  apiKey: string;
  requestPauseMs: number;
  maxCandidates: number;
  minAgeMin: number;
  maxAgeMin: number;
}

export function gmgnFeedDefaults(apiKey: string): GmgnFeedCfg {
  return { host: "https://api.gmgn.ai", apiKey, requestPauseMs: 1_200, maxCandidates: 10, minAgeMin: 2, maxAgeMin: 24 * 60 };
}

export class GmgnFeed implements DiscoveryFeed {
  readonly name = "gmgn";
  private prices = new Map<string, number>();
  private lastRefresh = 0;

  constructor(private cfg: GmgnFeedCfg) {}

  private headers(): Record<string, string> {
    return { "X-APIKEY": this.cfg.apiKey, "Content-Type": "application/json", "User-Agent": "solbot2-gmgn/1" };
  }

  private async get(url: string): Promise<unknown> {
    const sep = url.includes("?") ? "&" : "?";
    const full = `${url}${sep}timestamp=${Math.floor(Date.now() / 1000)}&client_id=${crypto.randomUUID()}`;
    const res = await fetch(full, { headers: this.headers() });
    if (!res.ok) {throw new Error(`gmgn ${res.status}: ${(await res.text()).slice(0, 160)}`);}
    return res.json();
  }

  async refresh(): Promise<Candidate[]> {
    const now = Date.now();
    if (now - this.lastRefresh < this.cfg.requestPauseMs) {return this.cachedList;}
    this.lastRefresh = now;
    const j = (await this.get(`${this.cfg.host}/v1/market/rank?chain=sol&interval=1m`)) as {
      data?: { data?: { address?: string; symbol?: string; price?: number; liquidity?: number; change5m?: number; volume5m?: number; volume24?: number; created_timestamp?: number }[] };
    };
    const out: Candidate[] = [];
    for (const t of j.data?.data ?? []) {
      if (!t.address) {continue;}
      const created = t.created_timestamp ? t.created_timestamp * 1000 : 0;
      const ageMin = created ? (now - created) / 60_000 : 999_999;
      if (ageMin < this.cfg.minAgeMin || ageMin > this.cfg.maxAgeMin) {continue;}
      if ((t.price ?? 0) <= 0) {continue;}
      out.push({
        mint: t.address,
        symbol: (t.symbol ?? t.address.slice(0, 4)).slice(0, 12),
        priceUsd: t.price ?? 0,
        liquidityUsd: t.liquidity ?? 0,
        change5mPct: t.change5m ?? 0,
        vol5mUsd: t.volume5m ?? 0,
        vol24hUsd: t.volume24 ?? 0,
        createdMs: created,
      });
      if (out.length >= this.cfg.maxCandidates) {break;}
    }
    this.cachedList = out;
    for (const c of out) {this.prices.set(c.mint, c.priceUsd);}
    return out;
  }

  private cachedList: Candidate[] = [];
  snapshotPrice(mint: string): number | null {
    return this.prices.get(mint) ?? null;
  }

  async latestCandle(mint: string): Promise<Bar | null> {
    const j = (await this.get(`${this.cfg.host}/v1/market/token_kline?chain=sol&address=${mint}&resolution=1m`)) as {
      data?: { klines?: { open?: number; close?: number; high?: number; low?: number; volume?: number; timestamp?: number }[] };
    };
    const k = j.data?.klines?.[0];
    if (!k || k.close === undefined) {return null;}
    return { ts: k.timestamp ?? 0, open: k.open ?? k.close, high: k.high ?? k.close, low: k.low ?? k.close, close: k.close, volumeUsd: k.volume ?? 0 };
  }
}

export function makeFeed(gmgnKey: string | null, geckoApiKey: string | null): DiscoveryFeed {
  if (gmgnKey) {return new GmgnFeed(gmgnFeedDefaults(gmgnKey));}
  return new GeckoFeed(geckoFeedDefaults(geckoApiKey));
}
