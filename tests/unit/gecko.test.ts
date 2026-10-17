import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, closeDb, type DB } from "../../src/state/db.js";
import { migrate } from "../../src/state/migrations.js";
import { countImportedCandles } from "../../src/state/market.js";
import { GeckoBackfiller, geckoDefaults, type FetchLike } from "../../src/market/gecko.js";

process.env["MODE"] = "test";

const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const POOL_ID = "solana_C8Gr6AUuq9hEdSYJzoEpNcdjpojPZwqG5MtQbeouNNwg";

interface CapturedReq {
  url: string;
  headers: Record<string, string>;
}

function poolBody(): unknown {
  return {
    data: [{ id: POOL_ID, type: "pool", attributes: { reserve_in_usd: 2_000_000, name: "JUP / SOL" } }],
  };
}

function ohlcvBody(rows: number[][]): unknown {
  return { data: { id: POOL_ID, type: "pool", attributes: { ohlcv_list: rows } } };
}

interface Step {
  status: number;
  body: unknown;
  retryAfter?: string;
}

/** fetch scripté : chaque appel consomme le step suivant. */
function scriptedFetch(steps: Step[], reqs: CapturedReq[], breaks = 0): FetchLike {
  let i = 0;
  return async (url, init) => {
    const s = steps[Math.min(i, steps.length - 1)] ?? { status: 500, body: null };
    i++;
    reqs.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (breaks > 0) {await new Promise((r) => setTimeout(r, 2));}
    return {
      ok: s.status >= 200 && s.status < 300,
      status: s.status,
      json: async () => s.body,
      text: async () => JSON.stringify(s.body),
      headers: { get: (name: string) => (name === "retry-after" ? s.retryAfter ?? null : null) },
    };
  };
}

describe("GeckoBackfiller", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb({ path: ":memory:", memory: true });
    migrate(db);
  });
  afterEach(() => closeDb(db));

  it("sans clé : URL geckoterminal v2, aucun header auth, petites bougies importées", async () => {
    const now = Math.floor(Date.now() / 1000);
    const reqs: CapturedReq[] = [];
    const fetch = scriptedFetch(
      [
        { status: 200, body: poolBody() },
        { status: 200, body: ohlcvBody([[now, 1, 1.1, 0.9, 1.05, 10]]) },
      ],
      reqs,
    );
    const gecko = new GeckoBackfiller(db, { ...geckoDefaults(), requestPauseMs: 5 }, fetch);
    const n = await gecko.backfillToken(JUP, "15m", 7);
    expect(n).toBe(1);
    expect(reqs[0]?.url).toContain("https://api.geckoterminal.com/api/v2/networks/solana/tokens/");
    expect(Object.keys(reqs[0]?.headers ?? {})).toHaveLength(0);
    expect(countImportedCandles(db, JUP, "15m")).toBe(1);
  });

  it("avec clé GECKO_API_KEY : bascule v3 onchain + header x-cg-demo-api-key", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const reqs: CapturedReq[] = [];
    const fetch = scriptedFetch(
      [
        { status: 200, body: poolBody() },
        { status: 200, body: ohlcvBody([[nowSec, 2, 2.2, 1.9, 2.1, 10]]) },
      ],
      reqs,
    );
    const gecko = new GeckoBackfiller(db, { ...geckoDefaults(), requestPauseMs: 5, apiKey: "CG-demo-fake" }, fetch);
    const n = await gecko.backfillToken(JUP, "15m", 7);
    expect(n).toBe(1);
    expect(reqs[0]?.url).toContain("https://api.coingecko.com/api/v3/onchain/networks/solana/tokens/");
    expect(reqs[1]?.url).toContain("onchain/networks/solana/pools/C8Gr6AUuq9hEdSYJzoEpNcdjpojPZwqG5MtQbeouNNwg/ohlcv/");
    expect(reqs[1]?.url).not.toContain("pools/solana_");
    expect(reqs[0]?.headers["x-cg-demo-api-key"]).toBe("CG-demo-fake");
  });

  it("429 honore Retry-After puis import OK", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const reqs: CapturedReq[] = [];
    const fetch = scriptedFetch(
      [
        { status: 200, body: poolBody(), retryAfter: "1" },
        { status: 429, body: ohlcvBody([]), retryAfter: "1" },
        { status: 200, body: ohlcvBody([[nowSec, 1, 1.05, 0.99, 1.02, 3]]) },
      ],
      reqs,
    );
    const gecko = new GeckoBackfiller(db, { ...geckoDefaults(), requestPauseMs: 2 }, fetch);
    const n = await gecko.backfillToken(JUP, "15m", 7);
    expect(n).toBe(1);
    expect(countImportedCandles(db, JUP, "15m")).toBe(1);
  });

  it("404 OHLCV sans clé → erreur explicite avec hint GECKO_API_KEY", async () => {
    const reqs: CapturedReq[] = [];
    const fetch = scriptedFetch(
      [
        { status: 200, body: poolBody() },
        { status: 404, body: { errors: [{ status: "404", title: "Not Found" }] } },
      ],
      reqs,
    );
    const gecko = new GeckoBackfiller(db, { ...geckoDefaults(), requestPauseMs: 2 }, fetch);
    await expect(gecko.backfillToken(JUP, "15m", 7)).rejects.toThrow(/GECKO_API_KEY/);
  });

  it("OHLCV vide (rows []) → 0 candles, pas d'URL paginée ensuite", async () => {
    const reqs: CapturedReq[] = [];
    const fetch = scriptedFetch(
      [
        { status: 200, body: poolBody() },
        { status: 200, body: ohlcvBody([]) },
      ],
      reqs,
    );
    const gecko = new GeckoBackfiller(db, { ...geckoDefaults(), requestPauseMs: 2 }, fetch);
    expect(await gecko.backfillToken(JUP, "15m", 7)).toBe(0);
    expect(reqs).toHaveLength(2);
  });

  it("ts GECKO seconds → stockage ms (régression unité 24h)", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const reqs: CapturedReq[] = [];
    const fetch = scriptedFetch(
      [
        { status: 200, body: poolBody() },
        { status: 200, body: ohlcvBody([[nowSec, 1, 1, 1, 1, 1]]) },
      ],
      reqs,
    );
    const gecko = new GeckoBackfiller(db, { ...geckoDefaults(), requestPauseMs: 2 }, fetch);
    await gecko.backfillToken(JUP, "15m", 7);
    const row = db.prepare("SELECT ts FROM candles_imported WHERE mint = ? LIMIT 1").get(JUP) as { ts: number };
    expect(row.ts).toBeGreaterThan(1e12); // ms, pas secondes
  });
});
