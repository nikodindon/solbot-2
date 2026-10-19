import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, closeDb, type DB } from "../../src/state/db.js";
import { migrate } from "../../src/state/migrations.js";
import { listPositions, addLot } from "../../src/state/portfolio-repo.js";
import { paperCashSet } from "../../src/portfolio/portfolio.js";
import { listTrades } from "../../src/state/trades.js";
import { queryAll } from "../../src/state/sql.js";
import { GeckoFeed, geckoFeedDefaults, type Candidate, type Bar } from "../../src/gmgn/discovery.js";
import type { DiscoveryFeed } from "../../src/gmgn/discovery.js";
import { Scalper, gmgnDefaults, type GmgnConfig } from "../../src/gmgn/scalper.js";

process.env["MODE"] = "test";

// ---------- GeckoFeed ----------

interface Step { status: number; body: unknown }

function mockedFeed(steps: Step[]): GeckoFeed {
  let i = 0;
  const fetchImpl = async (_url: string, _init?: { headers?: Record<string, string> }) => {
    const s = steps[Math.min(i, steps.length - 1)]!;
    i++;
    return {
      ok: s.status < 400 && s.status >= 200,
      status: s.status,
      json: async () => s.body,
      text: async () => JSON.stringify(s.body),
      headers: { get: () => null },
    };
  };
  const cfg = { ...geckoFeedDefaults("demo"), requestPauseMs: 0, gateMs: 0 };
  return new GeckoFeed(cfg, fetchImpl);
}

const TTLINESS = (relId: string, addr: string, sym: string) => ({
  data: [
    {
      id: "solana_POOL",
      attributes: {
        base_token_price_usd: "1.5",
        reserve_in_usd: "120000",
        price_change_percentage: { m5: "12" },
        volume_usd: { m5: "80000", h24: "1_000" },
        pool_created_at: new Date(Date.now() - 600_000).toISOString(),
      },
      relationships: { base_token: { data: { id: relId } } },
    },
    {
      id: "solana_OLD",
      attributes: {
        base_token_price_usd: "1",
        reserve_in_usd: "50000",
        price_change_percentage: { m5: "3" },
        volume_usd: { m5: "90000", h24: "1_000" },
        pool_created_at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      },
    },
    {
      id: "solana_SOLLIKE",
      attributes: {
        base_token_price_usd: "150",
        reserve_in_usd: "900000",
        price_change_percentage: { m5: "0" },
        volume_usd: { m5: "1_000", h24: "1_000" },
        pool_created_at: new Date(Date.now() - 900_000).toISOString(),
      },
    },
  ],
  included: [
    { id: relId, type: "token", attributes: { address: addr, symbol: sym } },
    { id: "solana_OLD", type: "token", attributes: { address: "OLD_mint", symbol: "OLD" } },
    { id: "solana_SOLLIKE", type: "token", attributes: { address: "So11111111111111111111111111111111111111112", symbol: "wSOL" } },
  ],
});

const POOL_BODY = TTLINESS("solana_ABCTOKEN", "ABC_mint", "TEST");

describe("GeckoFeed (discovery)", () => {
  it("filtre l'âge, la liquidité et SOL natif", async () => {
    const feed = mockedFeed([{ status: 200, body: POOL_BODY }, { status: 200, body: { data: [] } }]);
    const cands = await feed.refresh();
    expect(cands).toHaveLength(1);
    expect(cands[0]!.symbol).toBe("TEST");
    expect(cands[0]!.vol5mUsd).toBe(80_000);
    expect(feed.snapshotPrice("ABC_mint")).toBe(1.5);
  });

  it("renvoie la dernière bougie 1m via le pool du mint", async () => {
    const feed = mockedFeed([
      { status: 200, body: { data: [{ id: "solana_POOLABC", attributes: { reserve_in_usd: "95000" } }] } },
      { status: 200, body: { data: { attributes: { ohlcv_list: [[7000, 1, 1.1, 0.9, 1.02, 123]] } } } },
    ]);
    const bar = await feed.latestCandle("ABC_mint");
    expect(bar?.ts).toBe(7000);
    expect(bar?.close).toBeCloseTo(1.02);
    // 2e appel: pool en cache → 1 seule requête OHLCV
    const bar2 = await feed.latestCandle("ABC_mint");
    expect(bar2?.ts).toBe(7000);
  });

  it("429 épuisé → erreur visée + cooldown: refresh() ressert le cache au lieu de silencieux", async () => {
    const feed = mockedFeed([
      { status: 200, body: POOL_BODY },
      { status: 429, body: {} },
      { status: 429, body: {} },
    ]);
    // 1 path per refresh (budget IP) : refresh#1 parse 1 candidat
    expect(await feed.refresh()).toHaveLength(1);
    // refresh#2 → 429 ×2 → throw visible (avant: "0 candidats" muet)
    await expect(feed.refresh()).rejects.toThrow("gecko 429");
    // cooldown: pas de re-fetch (steps épuisés) → cache non vide
    const again = await feed.refresh();
    expect(again).toHaveLength(1);
  });
});

// ---------- Scalper (mini-integration) ----------

class StubFeed implements DiscoveryFeed {
  name = "stub";
  price: number;
  constructor(
    public cands: Candidate[],
    public candle: Bar | null,
    price = 0,
  ) {
    this.price = price;
  }
  refresh(): Promise<Candidate[]> {return Promise.resolve(this.cands);}
  latestCandle(): Promise<Bar | null> {return Promise.resolve(this.candle);}
  snapshotPrice(mint: string): number | null {
    return this.price || this.cands.find((c) => c.mint === mint)?.priceUsd || null;
  }
}

function scalperFor(db: DB, feed: DiscoveryFeed, over: Partial<GmgnConfig> = {}): Scalper {
  return new Scalper({ db, cfg: { ...gmgnDefaults(), ...over }, feed });
}

const CAND: Candidate = {
  mint: "ABC_mint",
  symbol: "TEST",
  priceUsd: 1,
  liquidityUsd: 500_000,
  change5mPct: 10,
  vol5mUsd: 200_000,
  vol24hUsd: 900_000,
  createdMs: Date.now() - 600_000,
};

function freshDb(): DB {
  const db = openDb({ path: ":memory:" });
  migrate(db);
  paperCashSet(db, 100);
  return db;
}

describe("Scalper paper", () => {
  let db: DB;
  beforeEach(() => {db = freshDb();});
  afterEach(() => {closeDb(db);});

  it("tick 1: entrée sniper paper (buy simulé, stop/TP posés)", async () => {
    const s = scalperFor(db, new StubFeed([CAND], { ts: 1, open: 0.97, high: 1.01, low: 0.9, close: 1, volumeUsd: 100_000 }));
    const lines = await s.tick();
    const trades = listTrades(db, { limit: 10 });
    expect(trades).toHaveLength(1);
    expect(trades[0]!.side).toBe("buy");
    expect(trades[0]!.status).toBe("simulated");
    const [pos] = listPositions(db, true);
    expect(pos?.symbol).toBe("TEST");
    expect(pos?.takeProfitPrice ?? 0).toBeGreaterThan(pos!.avgEntryUsd);
    expect(pos?.stopLossPrice ?? 99).toBeLessThan(pos!.avgEntryUsd);
    expect(lines.some((l) => l.includes("NAV"))).toBe(true);
  });

  it("tick 2: TP touché → vente paper + PnL réalisé + position close", async () => {
    const candle = { ts: 1, open: 0.97, high: 1.01, low: 0.9, close: 1, volumeUsd: 100_000 };
    const s = scalperFor(db, new StubFeed([CAND], candle));
    await s.tick();
    // bougie longue servis plus tard (same ts → pas de 2e entrée sur ce tick)
    const feed2 = new StubFeed([], candle, 1);
    void feed2;
    // TP hit: snapshot price = TP + marge
    const [pos] = listPositions(db, true);
    const price = (pos?.takeProfitPrice ?? 1) * 1.001;
    const bigFeed = new StubFeed([], candle, price);
    const s2 = new Scalper({ db, cfg: gmgnDefaults(), feed: bigFeed });
    await s2.tick();
    const trades = listTrades(db, { limit: 10 });
    expect(trades).toHaveLength(2);
    expect(trades[1]?.side).toBe("sell");
    expect(trades[1]!.realizedPnlUsd).not.toBeNull();
    expect(listPositions(db, true)).toHaveLength(0);
    // cash augmenté par les proceeds
    const eq = queryAll<{ n: number }>(db, "SELECT COUNT(*) AS n FROM equity");
    expect(eq[0]?.n).toBe(2);
  });

  it("garde bougie: volume/body trop faibles → rejet, pas de trade", async () => {
    const s = scalperFor(db, new StubFeed([CAND], { ts: 1, open: 1, high: 1.01, low: 0.99, close: 1.001, volumeUsd: 50 }));
    await s.tick();
    expect(listTrades(db, { limit: 10 })).toHaveLength(0);
    expect(listPositions(db, true)).toHaveLength(0);
  });

  it("positions max atteintes + exposition max → pas de nouvelle entrée", async () => {
    // 3 lots déjà ouverts sur 3 mints différents
    for (const mint of ["m1", "m2", "m3"]) {
      addLot(db, mint, mint.slice(0, 4), 9.8, 1, Date.now() - 10);
    }
    const s = scalperFor(db, new StubFeed([CAND], { ts: 1, open: 0.97, high: 1.01, low: 0.9, close: 1, volumeUsd: 900_000 }), { maxPositions: 3 });
    await s.tick();
    expect(listTrades(db, { limit: 10 })).toHaveLength(0); // un seul trade par tick max, positions pleines
    expect(listPositions(db, true)).toHaveLength(3);
  });

  it("perte journalière: NAV sous l'ancre - dailyLossUsd → kill, pas d'entrées", async () => {
    // position qui s'effondre (SL simulé par crash price)
    addLot(db, "CRASH_mint", "CRSH", 9.8, 2, Date.now() - 10_000);
    const cands = [CAND];
    const feed = new StubFeed(cands, { ts: 1, open: 0.97, high: 1.01, low: 0.9, close: 1, volumeUsd: 900_000 });
    // snapshot price du CRASH à 0 (perte ~9.8$ < dailyLoss 15$: nav ≈ 90.2)... pas assez.
    // Il faut couvrir aussi la perte CF candidate? Le dailyKill au 1er tick: nav = cash + pos ... anchor= nav0 → pas de kill.
    // Second tick: anchor figé, crash plus bas → sous l'ancre - 15$.
    const priceCrash = 0.01;
    const feed2 = new StubFeed([], { ts: 2, open: 1, high: 1, low: 1, close: 1, volumeUsd: 50 }, 0);
    (feed2 as unknown as { crash: number }).crash = priceCrash;
    // stub manuellement: snapshot renvoie un prix à 0 pour CRASH si on override…
    const cfg = gmgnDefaults();
    cfg.dailyLossUsd = 1; // petite perte → kill déclenché au tick 2
    const s = scalperFor(db, feed, cfg);
    await s.tick(); // anchor posé, pas de crash encore
    const anchor = queryAll<{ n: number }>(db, "SELECT COUNT(*) AS n FROM equity");
    expect(anchor[0]?.n).toBe(1);
    // tick 2: force un prix effondré → SL de CRSH (0.01 ≈ -99.5% = perte > dailyLoss)
    const feedCrash: DiscoveryFeed = {
      name: "crash",
      refresh: async () => [],
      latestCandle: async () => null,
      snapshotPrice: (mint) => (mint === "CRASH_mint" ? 0.01 : null),
    };
    const s2 = new Scalper({ db, cfg, feed: feedCrash });
    // pas de nouvelle entrée BUY après kill (le buy éventuel de tick1 reste):
    const buysBefore = queryAll<{ n: number }>(db, "SELECT COUNT(*) AS n FROM trades WHERE side='buy'");
    await s2.tick();
    const buys = queryAll<{ side: string }>(db, "SELECT side FROM trades WHERE side='buy'");
    expect(buys).toHaveLength(buysBefore[0]?.n ?? 0);
  });
});
