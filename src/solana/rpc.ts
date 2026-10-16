
export interface FetchLike {
  (input: string, init?: RequestInit): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
    json(): Promise<unknown>;
  }>;
}

export interface TokenAccount {
  mint: string;
  amount: number;
  decimals: number;
  owner: string;
}

export interface RpcStats {
  requests: number;
  retries: number;
  errors: number;
  lastErrorAt: number | null;
}

const MIN_INTERVAL_MS = 250; // public RPC politeness
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export class RpcError extends Error {
  constructor(message: string, readonly status: number, readonly body?: string) {
    super(message);
  }
}

/**
 * Minimal Solana RPC client (read-only): balances for reconciliation, slot probe for health.
 * Politeness: min interval 250ms between calls + retry on non-500-with-JSON errors never;
 * 429/5xx → exponential backoff (3 attempts).
 */
export class RpcClient {
  private lastCall = 0;
  readonly stats: RpcStats = { requests: 0, retries: 0, errors: 0, lastErrorAt: null };

  constructor(
    private readonly url: string,
    private readonly fetchImpl: FetchLike = (globalThis as unknown as { fetch: FetchLike }).fetch,
  ) {}

  private async call<T = unknown>(method: string, params: unknown[], attempt = 1): Promise<T> {
    const wait = MIN_INTERVAL_MS - (Date.now() - this.lastCall);
    if (wait > 0) {await sleep(wait);}
    this.lastCall = Date.now();
    this.stats.requests += 1;
    let res;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      this.stats.errors += 1;
      this.stats.lastErrorAt = Date.now();
      if (attempt < 3) {
        this.stats.retries += 1;
        await sleep(500 * Math.pow(2, attempt));
        return this.call<T>(method, params, attempt + 1);
      }
      throw new RpcError(`RPC réseau: ${String(err)}`, 0);
    }
    const text = await res.text();
    if (res.status === 429 || res.status >= 500) {
      this.stats.errors += 1;
      this.stats.lastErrorAt = Date.now();
      if (attempt < 3) {
        this.stats.retries += 1;
        await sleep(600 * Math.pow(2, attempt) + Math.floor(Math.random() * 200));
        return this.call<T>(method, params, attempt + 1);
      }
      throw new RpcError(`RPC ${res.status} sur ${method}`, res.status, text);
    }
    if (!res.ok) {
      this.stats.errors += 1;
      this.stats.lastErrorAt = Date.now();
      throw new RpcError(`RPC ${res.status} sur ${method}`, res.status, text);
    }
    let parsed: { result?: T; error?: { message?: string; code?: number } };
    try {
      parsed = JSON.parse(text) as { result?: T; error?: { message?: string; code?: number } };
    } catch {
      throw new RpcError(`réponse RPC non-JSON`, res.status, text);
    }
    if (parsed.error) {
      this.stats.errors += 1;
      this.stats.lastErrorAt = Date.now();
      throw new RpcError(`RPC erreur ${String(parsed.error.code ?? "")}: ${parsed.error.message ?? ""}`, 200, text);
    }
    return parsed.result as T;
  }

  async slot(): Promise<number> {
    const r = await this.call<number>("getSlot", [{ commitment: "confirmed" }]);
    return r;
  }

  async getBalance(owner: string): Promise<number> {
    const r = await this.call<{ context: { value: number }; value: number }>("getBalance", [owner, { commitment: "confirmed" }]);
    return r.value;
  }

  /** All SPL token accounts (jsonParsed) for an owner: mint, decimals, raw amount. */
  async tokenAccounts(owner: string): Promise<TokenAccount[]> {
    const r = await this.call<{
      value: {
        account: {
          data: {
            parsed?: {
              info?: { mint?: string; tokenAmount?: { amount?: string; decimals?: number }; owner?: string };
            };
          };
        };
      }[];
    }>(
      "getTokenAccountsByOwner",
      [
        owner,
        { programId: TOKEN_PROGRAM },
        { encoding: "jsonParsed", commitment: "confirmed" },
      ],
    );
    const out: TokenAccount[] = [];
    for (const v of r.value ?? []) {
      const info = v.account?.data?.parsed?.info;
      if (!info?.mint) {continue;}
      out.push({
        mint: info.mint,
        amount: Number(info.tokenAmount?.amount ?? "0"),
        decimals: info.tokenAmount?.decimals ?? 0,
        owner: info.owner ?? owner,
      });
    }
    return out;
  }

  /** Token account balance for one mint (decoded lookup for quick checks). */
  async tokenBalance(owner: string, mint: string): Promise<TokenAccount | null> {
    const r = await this.call<{
      value: {
        account: {
          data: {
            parsed?: { info?: { tokenAmount?: { amount?: string; decimals?: number } } };
          };
        };
      }[];
    }>(
      "getTokenAccountsByOwner",
      [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }],
    );
    const v = r.value?.[0];
    if (!v) {return null;}
    const info = v.account?.data?.parsed?.info;
    if (!info?.tokenAmount) {return null;}
    return {
      mint,
      amount: Number(info.tokenAmount.amount ?? "0"),
      decimals: info.tokenAmount.decimals ?? 0,
      owner,
    };
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
