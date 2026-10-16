import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { JupiterClient, backoffFromHeaders } from "../../src/jupiter/client.js";
import { TokenBucket } from "../../src/utils/rate-limit.js";
import { PriceApi } from "../../src/jupiter/price.js";
import { RpcClient } from "../../src/solana/rpc.js";

type Res = { status: number; body: string; headers?: Record<string, string> };

function makeFetch(handlers: Res[]): { fetch: ReturnType<typeof vi.fn>; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const fetchMock = vi.fn((url: string, _init?: unknown) => {
    calls.push(url);
    const h = handlers[Math.min(i++, handlers.length - 1)];
    if (!h) {return Promise.reject(new Error("no handler"));}
    const res = {
      ok: h.status >= 200 && h.status < 300 && h.status !== 429,
      status: h.status,
      headers: { get: (n: string) => (h.headers?.[n] ?? null) as string | null },
      text: (): Promise<string> => Promise.resolve(h.body),
    };
    return Promise.resolve(res);
  });
  return { fetch: fetchMock, calls };
}

describe("jupiter client", () => {
  it("retries sur 429 avec x-ratelimit-reset", async () => {
    const { fetch } = makeFetch([
      { status: 429, body: "", headers: { "x-ratelimit-reset": String(Math.floor((Date.now() + 30) / 1000)) } },
      { status: 200, body: JSON.stringify({ ok: 1 }) },
    ]);
    const c = new JupiterClient({ apiKey: null, rps: 100, retries: 3 }, fetch as never);
    const out = await c.get("/x", {}, (j) => j as { ok: number });
    expect(out.ok).toBe(1);
    expect(c.stats.rateLimited).toBe(1);
    expect(fetch.mock.calls.length).toBe(2);
  });

  it("retry sur 5xx puis succès", async () => {
    const { fetch } = makeFetch([
      { status: 500, body: "boom" },
      { status: 200, body: JSON.stringify({ v: 3 }) },
    ]);
    const c = new JupiterClient({ apiKey: null, rps: 100, retries: 3 }, fetch as never);
    const out = await c.get("/y", {}, (j) => j as { v: number });
    expect(out.v).toBe(3);
    expect(c.stats.retries).toBe(1);
  });

  it("pas de retry sur 400", async () => {
    const { fetch } = makeFetch([{ status: 400, body: "bad request" }]);
    const c = new JupiterClient({ apiKey: null, rps: 100, retries: 3 }, fetch as never);
    await expect(c.get("/z", {}, (j) => j)).rejects.toThrow(/400/);
    expect(fetch.mock.calls.length).toBe(1);
  });

  it("x-api-key envoyé si clé présente", async () => {
    let seen: string | null = null;
    const fetchMock = vi.fn((_url: string, init?: { headers?: Record<string, string> }) => {
      seen = init?.headers?.["x-api-key"] ?? null;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: () => Promise.resolve("{}"),
      });
    });
    const c = new JupiterClient({ apiKey: "K1", rps: 100 }, fetchMock as never);
    await c.get("/a", {}, (j) => j);
    expect(seen).toBe("K1");
  });

  it("backoffFromHeaders gère reset absolu", () => {
    expect(backoffFromHeaders({ get: () => String(Math.floor(Date.now() / 1000) + 20) })).toBeGreaterThan(
      1000,
    );
    expect(backoffFromHeaders({ get: () => null })).toBeLessThanOrEqual(2000);
  });

  it("TokenBucket : tryAcquire + waitTimeMs", async () => {
    const b = new TokenBucket(200, 1);
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(false);
    expect(b.waitTimeMs()).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 12));
    expect(b.tryAcquire()).toBe(true);
  });
});

describe("price api", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn((_url: string, _init?: unknown) =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: () =>
          Promise.resolve(
            JSON.stringify({
              So11111111111111111111111111111111111111112: {
                usdPrice: 100.5,
                decimals: 9,
                liquidity: 1e9,
              } as never,
            }),
          ),
      }),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("batch de 50 et cache TTL", async () => {
    const c = new JupiterClient({ apiKey: null, rps: 1000 }, fetchMock as never);
    const p = new PriceApi(c);
    const mints = ["SOL".repeat(0)] as unknown as string[]; // not used; SOL9 mint below
    void mints;
    const sol = "So11111111111111111111111111111111111111112";
    const map = await p.refresh([sol], { fresh: true });
    expect(map.get(sol)?.usdPrice).toBeCloseTo(100.5, 6);
    expect(fetchMock.mock.calls.length).toBe(1);
    // cached within TTL
    const map2 = await p.refresh([sol]);
    expect(map2.get(sol)?.usdPrice).toBeCloseTo(100.5, 6);
    expect(fetchMock.mock.calls.length).toBe(1);
    // fresh bypasses cache
    await p.refresh([sol], { fresh: true });
    expect(fetchMock.mock.calls.length).toBe(2);
  });
});

describe("rpc", () => {
  it("tokenAccounts parse jsonParsed", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              result: {
                value: [
                  {
                    account: {
                      data: {
                        parsed: {
                          info: {
                            mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                            tokenAmount: { amount: "5000000", decimals: 6 },
                            owner: "W1",
                          },
                        },
                      },
                    },
                  },
                ],
              },
            }),
          ),
      }),
    );
    const rpc = new RpcClient("http://localhost:8899", fetchMock as never);
    const accs = await rpc.tokenAccounts("W1");
    expect(accs.length).toBe(1);
    expect(accs[0]!.mint).toContain("EPjFW");
    expect(accs[0]!.amount).toBe(5_000_000);
  });

  it("retry sur 5xx", async () => {
    let n = 0;
    const fetchMock = vi.fn(() => {
      n += 1;
      return Promise.resolve(
        n < 2
          ? { ok: false, status: 503, text: () => Promise.resolve("nope") }
          : {
              ok: true,
              status: 200,
              text: () => Promise.resolve(JSON.stringify({ result: 1234 })),
            },
      );
    });
    const rpc = new RpcClient("http://localhost:8899", fetchMock as never);
    const slot = await rpc.slot();
    expect(slot).toBe(1234);
    expect(n).toBe(2);
  });
});
