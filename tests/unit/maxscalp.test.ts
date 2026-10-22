import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { openDb, closeDb, type DB } from "../../src/state/db.js";
import { migrate } from "../../src/state/migrations.js";
import { listPositions, addLot } from "../../src/state/portfolio-repo.js";
import { kvGetJson } from "../../src/state/kv.js";
import { paperCashGet, paperCashSet } from "../../src/portfolio/portfolio.js";
import { listTrades } from "../../src/state/trades.js";
import type { Candidate, Bar, DiscoveryFeed } from "../../src/gmgn/discovery.js";
import { MaxScalper, maxscalpDefaults, type MaxScalpConfig } from "../../src/gmgn/maxscalp.js";

process.env["MODE"] = "test";

class LadderFeed implements DiscoveryFeed {
  name = "stub";
  price: number;
  constructor(
    public cands: Candidate[],
    price = 0,
  ) {
    this.price = price;
  }
  refresh(): Promise<Candidate[]> {return Promise.resolve(this.cands);}
  latestCandle(): Promise<Bar | null> {return Promise.resolve(null);}
  snapshotPrice(mint: string): number | null {
    if (this.price > 0) {return this.price;}
    return this.cands.find((c) => c.mint === mint)?.priceUsd ?? null;
  }
}

const CAND: Candidate = {
  mint: "MAX_mint",
  symbol: "MAX",
  priceUsd: 0.01,
  liquidityUsd: 30_000,
  change5mPct: 9,
  vol5mUsd: 100_000,
  vol24hUsd: 500_000,
  createdMs: Date.now() - 600_000,
};

function scalperFor(db: DB, feed: DiscoveryFeed, over: Partial<MaxScalpConfig> = {}): MaxScalper {
  // tests: lots de 1$ (les défauts v10 sont 3$/5$), capital 100$; fenêtre session v12 désactivée (25===25) sauf test dédié
  return new MaxScalper({ db, cfg: { ...maxscalpDefaults(), tradeUsd: 1, tradeUsdTurbo: 1, initialUsd: 100, entryBanStartHour: 25, entryBanEndHour: 25, ...over }, feed });
}

function freshDb(): DB {
  const db = openDb({ path: ":memory:" });
  migrate(db);
  paperCashSet(db, 100);
  return db;
}

describe("MaxScalper (loterie ×2)", () => {
  let db: DB;
  beforeEach(() => {db = freshDb();});
  afterEach(() => {closeDb(db);});

  it("tick 1: achat 1$ du candidat + NAV conservée ~100", async () => {
    const s = scalperFor(db, new LadderFeed([CAND]));
    const lines = await s.tick();
    expect(listTrades(db, {})).toHaveLength(1);
    expect(listTrades(db, {})[0]!.side).toBe("buy");
    expect(listTrades(db, {})[0]!.spendUsd).toBe(1);
    const [pos] = listPositions(db, true);
    expect(pos?.symbol).toBe("MAX");
    // 1$ dépensé → NAV 100 (cash -1, position +~0.95 net)
    const navSum = paperCashGet(db, 100) + pos!.qty * pos!.avgEntryUsd;
    expect(navSum).toBeGreaterThan(99.9);
    expect(lines.some((l) => l.includes("NAV"))).toBe(true);
  });

  it("v11.1 kickoff: premier take à ×1.4-2.2 (25% du sol prélevés), sol continue, pas de SL", async () => {
    const s1 = scalperFor(db, new LadderFeed([CAND]));
    await s1.tick();
    // prix ×2.2 vs valeur nette d'entrée ≈0.96$ → position doublée; le premiere take est le KICKOFF (25%)
    const s2 = scalperFor(db, new LadderFeed([], 0.022));
    await s2.tick();
    const trades = listTrades(db, {});
    expect(trades).toHaveLength(2);
    expect(trades[1]!.side).toBe("sell");
    // kickoff = 25% de la valeur (~2$) → proceeds net ≈ 0.45-0.55$
    expect(trades[1]!.spendUsd).toBeGreaterThan(0.4);
    expect(trades[1]!.spendUsd).toBeLessThan(0.55);
    // sol restant en position
    const [pos] = listPositions(db, true);
    expect(pos).toBeTruthy();
  });

  it("chain: kickoff à ×1.4, puis ladder 20% du sol à chaque doublement", async () => {
    const s1 = scalperFor(db, new LadderFeed([CAND]));
    await s1.tick();
    const cashBefore = paperCashGet(db, 100);
    // premier ×2.2 → kickoff 25%
    await scalperFor(db, new LadderFeed([], 0.022), { sweepTriggerUsd: 1e9 }).tick();
    // deuxième doublement du sol restant → ladder 20%
    await scalperFor(db, new LadderFeed([], 0.06), { sweepTriggerUsd: 1e9 }).tick();
    // troisième doublement
    await scalperFor(db, new LadderFeed([], 0.14), { sweepTriggerUsd: 1e9 }).tick();
    const trades = listTrades(db, {});
    const sells = trades.filter((t) => t.side === "sell");
    expect(sells.length).toBe(3);
    // le kickoff ~25% de 2$; les suivants = 20% du sol courant (croissant)
    expect(sells[0]!.spendUsd).toBeGreaterThan(0.4);
    expect(sells[0]!.spendUsd).toBeLessThan(0.55);
    expect(sells[1]!.spendUsd).toBeGreaterThan(sells[0]!.spendUsd);   // 20% du sol après kickoff ×6
    expect(sells[2]!.spendUsd).toBeGreaterThan(sells[1]!.spendUsd);   // 20% du sol ×14
    // cash augmenté au total
    expect(paperCashGet(db, 100)).toBeGreaterThan(cashBefore);
  });

  it("pas de trade immédiat sans x2", async () => {
    const s = scalperFor(db, new LadderFeed([CAND]));
    await s.tick();
    // même prix → rien de nouveau (pas de vente, pas de re-buy: discretes en positions)
    await scalperFor(db, new LadderFeed([CAND])).tick();
    const trades = listTrades(db, {});
    expect(trades).toHaveLength(1);
    expect(listTrades(db, {}).filter((t) => t.side === "buy")).toHaveLength(1);
  });

  it("pas de re-buy du même mint tant qu'une position existe", async () => {
    const s = scalperFor(db, new LadderFeed([CAND]));
    await s.tick();
    await s.tick();
    expect(listTrades(db, {}).filter((t) => t.side === "buy")).toHaveLength(1);
  });
});

describe("MaxScalper garde-fous anti-rug", () => {
  let db: DB;
  beforeEach(() => {db = freshDb();});
  afterEach(() => {closeDb(db);});

  it("filtre entrée: listing coté au-dessus de maxPriceUsd (5¢) refusé", async () => {
    const expensive = { ...CAND, symbol: "USD_TROP", priceUsd: 0.61 };
    const s = scalperFor(db, new LadderFeed([expensive]));
    await s.tick();
    expect(listTrades(db, {}).filter((t) => t.side === "buy")).toHaveLength(0);
  });

  it("v11.2 seuil: vol5m < 100k$ refusé (bande turbo seule) — les 50-100k ont ruggé en bande le soir des deux runs (−86$, −61$)", async () => {
    const dead = { ...CAND, vol5mUsd: 99_000 };
    const s = scalperFor(db, new LadderFeed([dead]));
    await s.tick();
    expect(listTrades(db, {}).filter((t) => t.side === "buy")).toHaveLength(0);
    // exactement à la limite → accepté
    const alive = { ...CAND, vol5mUsd: 100_000 };
    const s2 = scalperFor(db, new LadderFeed([alive]));
    await s2.tick();
    expect(listTrades(db, {}).filter((t) => t.side === "buy")).toHaveLength(1);
  });

  it("v11.2 sizing: bande 90k sous le seuil turbo refusée, bande 100k+ lot turbo, cash insuffisant → rejet propre", async () => {
    const mid = { ...CAND, vol5mUsd: 90_000, symbol: "MIDBAND" };
    const s = scalperFor(db, new LadderFeed([mid]), { tradeUsd: 3 });
    await s.tick();
    expect(listTrades(db, {}).filter((t) => t.side === "buy")).toHaveLength(0); // sous le seuil turbo → rien

    const db2 = freshDb();
    try {
      paperCashSet(db2, 6.2);
      const turbo = { ...CAND, mint: "TURBO_mint", symbol: "TURBO", vol5mUsd: 200_000 };
      const s2 = new MaxScalper({ db: db2, cfg: { ...maxscalpDefaults(), initialUsd: 5 }, feed: new LadderFeed([turbo]) });
      await s2.tick();
      const buys = listTrades(db2, {}).filter((t) => t.side === "buy");
      expect(buys).toHaveLength(1);
      expect(buys[0]!.spendUsd).toBe(5);
      // si le cash ne couvre pas le lot → reject logué, zéro trade
      const db3 = freshDb();
      try {
        paperCashSet(db3, 4.2);
        const s3 = new MaxScalper({ db: db3, cfg: { ...maxscalpDefaults(), initialUsd: 5 }, feed: new LadderFeed([turbo]) });
        await s3.tick();
        expect(listTrades(db3, {}).filter((t) => t.side === "buy")).toHaveLength(0);
      } finally {closeDb(db3);}
    } finally {closeDb(db2);}
  });

  it("v9: purgeLegacy liquide les lots ouverts avant la coupe, pas les nouveaux", async () => {
    // un lot "ancien" (simulé via openedMs réécrit) + un lot frais
    await scalperFor(db, new LadderFeed([CAND])).tick();
    const dbRows = db.prepare("SELECT ts_ms FROM trades WHERE side=? ORDER BY ts_ms").all("buy");
    const first = Number(dbRows[0]!.ts_ms);
    const s2 = scalperFor(db, new LadderFeed([{ ...CAND, mint: "LEG_mint2", symbol: "FRESH" }]));
    await s2.tick();
    const before = listPositions(db, true);
    expect(before.length).toBeGreaterThanOrEqual(2);
    db.prepare("UPDATE positions SET opened_ms=? WHERE mint=?").run(first - 10_000, before[0]!.mint);
    expect(listPositions(db, true).filter((p) => p.openedMs < first)).toHaveLength(1);
    const sold = await s2.purgeLegacy(first);
    expect(sold).toBe(1);
    const sells = listTrades(db, {}).filter((t) => t.side === "sell");
    expect(sells.some((t) => (t.reason ?? "").startsWith("purge legacy v9"))).toBe(true);
    expect(listPositions(db, true).map((p) => p.mint)).not.toContain(before[0]!.mint);
  });

  it("v9: feeBps LP réel (45) — jup fee d'un lot de 1$ < 0.02$", async () => {
    const s = scalperFor(db, new LadderFeed([CAND]));
    await s.tick();
    const [buy] = listTrades(db, {}).filter((t) => t.side === "buy");
    expect(buy!.jupFeeUsd).toBeLessThan(0.02);
  });

  it("rug exit: lot jamais profitable qui tombe à ≤60% du coût → purge complète", async () => {
    await scalperFor(db, new LadderFeed([CAND])).tick();
    // crash −50% (limite de purge 60%)
    await scalperFor(db, new LadderFeed([], 0.005)).tick();
    const sells = listTrades(db, {}).filter((t) => t.side === "sell");
    expect(sells).toHaveLength(1);
    expect(listPositions(db, true)).toHaveLength(0);
    const [pos] = listPositions(db, false) as { qty: number }[];
    expect(pos?.qty ?? 0).toBe(0);
  });

  it("rug exit ne purge PAS un lot déjà profitable, mais moon stop le liquide à −70% du peak", async () => {
    await scalperFor(db, new LadderFeed([CAND])).tick();
    await scalperFor(db, new LadderFeed([], 0.022)).tick();   // x2 → take n°1, peak ≈2.07$
    // crash à 0.008 (−70% du peak): free ride du coût évincé, mais le profit monte? → moon stop purge le sol
    await scalperFor(db, new LadderFeed([], 0.008)).tick();
    const sells = listTrades(db, {}).filter((t) => t.side === "sell");
    expect(sells).toHaveLength(2); // take + moon stop
    expect(listPositions(db, true)).toHaveLength(0);
  });
});

describe("MaxScalper moon stop + cap familles", () => {
  let db: DB;
  beforeEach(() => {db = freshDb();});
  afterEach(() => {closeDb(db);});

  it("moon stop: sol du lot profité qui retombe du peak → purge complète", async () => {
    await scalperFor(db, new LadderFeed([CAND])).tick();          // entrée
    await scalperFor(db, new LadderFeed([], 0.022)).tick();       // x2 → take 1, peak ≈2.07$
    const lines = await scalperFor(db, new LadderFeed([], 0.012)).tick();  // retombée −77% du peak
    const sells = listTrades(db, {}).filter((t) => t.side === "sell");
    expect(sells).toHaveLength(2);                                // take + moon stop
    expect(listPositions(db, true)).toHaveLength(0);
    expect(lines.some((l) => l.includes("NAV"))).toBe(true);
  });

  it("cap familles: pas de 3e lot sur le même nom", async () => {
    // 2 lots pré-existants du même symbole (mints différents)
    for (const mint of ["MAX_mint", "MAX2_mint"]) {
      addLot(db, mint, "MAX", 94, 0.01, Date.now() - 1000);
    }
    const s = scalperFor(db, new LadderFeed([CAND]));             // CAND symbol MAX, price 0.01
    await s.tick();
    expect(listTrades(db, {}).filter((t) => t.side === "buy")).toHaveLength(0);
  });

  it("cap familles: lot accepté sur une NOUVELLE famille", async () => {
    for (const mint of ["MAX_mint", "MAX2_mint"]) {
      addLot(db, mint, "MAX", 94, 0.01, Date.now() - 1000);
    }
    const other = { ...CAND, mint: "OTHER_mint", symbol: "OTHR" };
    const s = scalperFor(db, new LadderFeed([other]));
    await s.tick();
    expect(listTrades(db, {}).filter((t) => t.side === "buy")).toHaveLength(1);
  });
});

describe("MaxScalper v3 — sweep USDT + recycle cash", () => {
  let db: DB;
  beforeEach(() => {db = freshDb();});
  afterEach(() => {closeDb(db);});

  it("sweep v11: capital garanti (cash + réalisé net) > trigger → 2$ à l'abri; les marks flottants ne déclenchent RIEN", async () => {
    // tick 1: achat 1$ → cash 99, réalisé 0 → capital 99 < 100.05 → pas de sweep
    const s1 = scalperFor(db, new LadderFeed([CAND]), { sweepTriggerUsd: 100.05, sweepUsd: 2 });
    await s1.tick();
    expect(kvGetJson<number>(db, "maxscalpSweptUsd", 0)).toBe(0);
    // tick 2: mark ×3.1 flottant → take ×1 (réalisé ~+1.09) → capital ~100.09 > 100.05 → sweep
    const s2 = scalperFor(db, new LadderFeed([], 0.031), { sweepTriggerUsd: 100.05, sweepUsd: 2 });
    await s2.tick();
    expect(kvGetJson<number>(db, "maxscalpSweptUsd", 0)).toBe(2);
    const cashAfter = paperCashGet(db, 100);
    expect(cashAfter).toBeLessThan(98.2);        // 99 +1.148 −2
    // capital retombé sous trigger → pas de double sweep au tick suivant
    const before = paperCashGet(db, 100);
    await scalperFor(db, new LadderFeed([], 0.031), { sweepTriggerUsd: 100.05, sweepUsd: 2 }).tick();
    expect(paperCashGet(db, 100)).toBeCloseTo(before, 6);
    expect(kvGetJson<number>(db, "maxscalpSweptUsd", 0)).toBe(2);
  });

  it("v11.1 kickoff: à ×1.4 le 25% part, ref rebasé à 0.75×value — le ladder ne re-take que 2× le ref (plus tard)", async () => {
    await scalperFor(db, new LadderFeed([CAND]), { sweepTriggerUsd: 1e9 }).tick();   // entrée 1$
    // ×1.45 du mark: friction d'entrée 2% → value/ref ≈ ×1.417 ≥ 1.4 → kickoff 25% du sol
    await scalperFor(db, new LadderFeed([], 0.0145), { sweepTriggerUsd: 1e9 }).tick();
    let sells = listTrades(db, {}).filter((t) => t.side === "sell");
    expect(sells).toHaveLength(1);
    const kick = sells[0]!.spendUsd;
    expect(kick).toBeGreaterThan(0.3);          // 25% de ~1.39, net de frais
    expect(kick).toBeLessThan(0.42);
    // ref rebasé à 0.75×value ≈1.04 avec qty restant 72 tok: 2×ref exige mark ≥ 0.0289
    // → mark ×2 du prix (0.02: value 1.44 sur le sol restant) → PAS de take
    await scalperFor(db, new LadderFeed([], 0.02), { sweepTriggerUsd: 1e9 }).tick();
    sells = listTrades(db, {}).filter((t) => t.side === "sell");
    expect(sells).toHaveLength(1);
    // au-dessus de 2×ref (mark 0.03 → value restante 2.16 ≥ 2.08) → ladder 20% reprend
    await scalperFor(db, new LadderFeed([], 0.03), { sweepTriggerUsd: 1e9 }).tick();
    sells = listTrades(db, {}).filter((t) => t.side === "sell");
    expect(sells).toHaveLength(2);
    expect(sells[1]!.spendUsd).toBeGreaterThan(kick);   // ladder 20% du sol ×3 > kickoff
  });

  it("v11.2 humeur: réalisé(2h) ≤ −8$ → pause entrées; série ≥3 ruggers/2h → verrou 30 min; rug isolé non bloquant (v5atég)", async () => {
    const { insertTrade } = await import("../../src/state/trades.js");
    const rugTrade = (pnl: number, minAgo: number) => insertTrade(db, {
      tsMs: Date.now() - minAgo * 60_000, mode: "paper", strategy: "maxscalp", mint: "RUGZ_mint", symbol: "RUGZ",
      side: "sell", spendUsd: 2.4, qty: 0.9, priceUsd: 0.0027, status: "simulated", realizedPnlUsd: pnl,
      reason: "rug exit (test)",
    });
    // 1) rug isolé frais (-0.5): PAS de pause (un seul rug ne ferme pas l'offre, 亿元 fenêtre > −8)
    rugTrade(-0.5, 2);
    const lines0 = await scalperFor(db, new LadderFeed([CAND])).tick();
    expect(lines0.some((l) => l.includes("pause des entrées"))).toBe(false);
    expect(listTrades(db, {}).some((t) => t.side === "buy" && t.symbol === "MAX")).toBe(true);
    // 2) série: 3 ruggers dont le dernier 2 min (réalisé −8.8 ≤ −8 aussi) → pause
    rugTrade(-9, 40); rugTrade(-1, 20);
    const lines1 = await scalperFor(db, new LadderFeed([CAND])).tick();
    expect(lines1.some((l) => l.includes("pause des entrées"))).toBe(true);
    expect(listTrades(db, {}).filter((t) => t.side === "buy" && t.symbol === "MAX")).toHaveLength(1); // que le buy de la phase 1
    // 3) verrou tient TANT QUE le dernier rug < 30 min — même quand la fenêtre 2h s'élide (run 8: essuie-glace 23h → réacheter à minuit pendant les ruggers)
    db.prepare("UPDATE trades SET realized_pnl_usd = 0.2 WHERE reason = ?").run("rug exit (test)");
    const lines2 = await scalperFor(db, new LadderFeed([CAND])).tick();
    expect(lines2.some((l) => l.includes("pause des entrées"))).toBe(true);
    // 4) verrou écoulé (dernier rug backdaté à −61 min > latch 60) → entrées reviennent
    db.prepare("UPDATE trades SET ts_ms = ? WHERE mint = ?").run(Date.now() - 61 * 60_000, "RUGZ_mint");
    const lines3 = await scalperFor(db, new LadderFeed([CAND])).tick();
    expect(lines3.some((l) => l.includes("pause des entrées"))).toBe(false);
    expect(listTrades(db, {}).some((t) => t.side === "buy" && t.symbol === "MAX")).toBe(true);
  });

  it("v11.2 humeur: réalisé(2h) ≤ −8$ sans rug → pause quand même (dégradation lente)", async () => {
    const { insertTrade } = await import("../../src/state/trades.js");
    insertTrade(db, {
      tsMs: Date.now() - 300_000, mode: "paper", strategy: "maxscalp", mint: "IDLE_mint", symbol: "IDLE",
      side: "sell", spendUsd: 3, qty: 1, priceUsd: 0.01, status: "simulated", realizedPnlUsd: -8.5,
      reason: "idle exit (test)",
    });
    const lines1 = await scalperFor(db, new LadderFeed([CAND])).tick();
    expect(lines1.some((l) => l.includes("pause des entrées"))).toBe(true);
    expect(listTrades(db, {}).filter((t) => t.side === "buy" && t.symbol === "MAX")).toHaveLength(0);
  });

  it("v12 fenêtre de session: PAS d'entrées dans la fenêtre bannie (les sorties/churn continuent), reprise hors fenêtre", async () => {
    const nowHour = new Date().getHours();
    const lines1 = await scalperFor(db, new LadderFeed([CAND]), { entryBanStartHour: nowHour, entryBanEndHour: (nowHour + 1) % 26 }).tick();
    expect(lines1.some((l) => l.includes("fenêtre bannie"))).toBe(true);
    expect(listTrades(db, {}).filter((t) => t.side === "buy")).toHaveLength(0);
    // hors fenêtre → l'entrée passe
    const lines2 = await scalperFor(db, new LadderFeed([CAND]), { entryBanStartHour: 25 }).tick();
    expect(lines2.some((l) => l.includes("fenêtre bannie"))).toBe(false);
    expect(listTrades(db, {}).some((t) => t.side === "buy")).toBe(true);
  });

  it("sweep v11: une moon flottante NON réalisée (mark ×1.3, sous le kickoff) ne fait PAS sweeper — run 7: 160$ sur des NAV plâtrés", async () => {
    const s = scalperFor(db, new LadderFeed([], 0), { sweepTriggerUsd: 100.05, sweepUsd: 2 });
    addLot(db, "FLOAT_mint", "FLOAT", 96, 0.01, Date.now() - 60_000);
    const { insertTicks } = await import("../../src/state/market.js");
    insertTicks(db, [{ ts: Date.now() - 10_000, mint: "FLOAT_mint", price: 0.013, liquidity: 20_000, volumeDelta: 5_000 }]); // ×1.3 flottant: NAV papier 101.2 > trigger, sous le kickoff 1.4, réalisé 0
    await s.tick();
    expect(kvGetJson<number>(db, "maxscalpSweptUsd", 0)).toBe(0);   // l'ancien NAV-mark rule aurait sweepé ICI
    expect(paperCashGet(db, 100)).toBe(100);       // aucune vente, aucun prélèvement
  });

  it("recycle: cash vide → 50% des positions en profit oldest-first jusqu'à re-acheter", async () => {
    await scalperFor(db, new LadderFeed([CAND])).tick();                 // 1 lot MAX (mark défaut 0.019 > entrée 0.01, < 2×)
    addLot(db, "OTHX_mint", "OTHX", 94, 0.01, Date.now() - 60_000);      // lot vieux de 60 s → plus ancien que le lot MAX (acheté au tick)
    paperCashSet(db, 0);                                                // vider le cash
    // ×1.3: en profit MAIS sous le kickoff ×1.4 → pas de take → le recycle doit agir
    const other = { ...CAND, mint: "OTHER_mint", symbol: "OTHR" };
    await scalperFor(db, new LadderFeed([other], 0.013)).tick();
    const sells = listTrades(db, {}).filter((t) => t.side === "sell").filter((t) => t.reason === "recycle cash");
    expect(sells).toHaveLength(2);                                    // MAX puis OTHX hydraté
    expect(sells.map((t) => t.symbol).join("")).toBe("OTHXMAX");        // plus ancien d'abord
    const lines = await scalperFor(db, new LadderFeed([other], 0.013)).tick();
    expect(lines.length).toBeGreaterThan(0);
    expect(listTrades(db, {}).some((t) => t.side === "buy" && t.symbol === "OTHR")).toBe(true);
  });

  it("recycle: position en perte non touchée", async () => {
    await scalperFor(db, new LadderFeed([CAND])).tick();
    paperCashSet(db, 0);
    await scalperFor(db, new LadderFeed([CAND], 0.008)).tick();      // prix −20% → pas en profit
    const sells = listTrades(db, {}).filter((t) => t.side === "sell").filter((t) => t.reason === "recycle cash");
    expect(sells).toHaveLength(0);
    expect(listPositions(db, true).length).toBeGreaterThanOrEqual(0);
  });
});

describe("MaxScalper v4 — idle exit (churn)", () => {
  let db: DB;
  beforeEach(() => {db = freshDb();});
  afterEach(() => {closeDb(db);});

  it("v10 cap 40 → purge des 5 plus vieux lots plats sans volume, oldest-first, slot re-acheté au même tick", async () => {
    const now = Date.now();
    // 44 lots: 10 vieux (2h), 34 récents
    for (let i = 0; i < 44; i++) {
      const age = i < 10 ? now - 2 * 3_600_000 : now - 60_000;
      addLot(db, `m${i}_mint`, `SYM${i}`, 96, 0.01, age);
    }
    expect(listPositions(db, true)).toHaveLength(44);
    const newly = { ...CAND, mint: "NEW_mint", symbol: "NEW" };
    const s = scalperFor(db, new LadderFeed([{ ...newly }], 0.01));
    await s.tick();
    const idleSells = listTrades(db, {}).filter((t) => t.side === "sell" && t.reason === "idle exit");
    expect(idleSells).toHaveLength(5);
    expect(idleSells.every((t) => /^m[0-9]_/.test(t.mint))).toBe(true); // vieux d'abord
    expect(listPositions(db, true)).toHaveLength(40); // 44 − 5 purges + 1 nouvelle entrée (cap 40)
    expect(listTrades(db, {}).some((t) => t.side === "buy" && t.symbol === "NEW")).toBe(true);
  });

  it("idle exit épargne: gagnant, token vu récemment, lot frais", async () => {
    const now = Date.now();
    for (let i = 0; i < 90; i++) {
      addLot(db, `m${i}_mint`, `SYM${i}`, 96, 0.01, now - 2 * 3_600_000);
    }
    // m0: gagnant (mark 0.0155 → pnl +0.49); m1: plat mais cam vu il y a 5 min; m90: lot frais (5 min)
    addLot(db, "m90_zmint", "SYMZ", 96, 0.01, now - 5 * 60_000);
    const feed: DiscoveryFeed = {
      name: "stub",
      refresh: async () => [],
      latestCandle: async () => null,
      snapshotPrice: (mint: string) => (mint === "m0_mint" ? 0.0155 : 0.01),
    };
    const seen = { "m1_mint": now - 5 * 60_000 };
    const s = scalperFor(db, feed, {});
    await s.tick();
    const idleSells = listTrades(db, {}).filter((t) => t.reason === "idle exit");
    expect(idleSells.length).toBeGreaterThanOrEqual(5);
    expect(idleSells.some((t) => t.mint === "m0_mint")).toBe(false);
    expect(idleSells.some((t) => t.mint === "m1_mint")).toBe(false);
    expect(idleSells.some((t) => t.mint === "m90_zmint")).toBe(false);
    void seen;
  });
});

describe("Option A — friction d'entrée affichée", () => {
  let db: DB;
  beforeEach(() => {db = freshDb();});
  afterEach(() => {closeDb(db);});

  it("entryFrictionUsd = −qty×(effectif − mid) du buy, mtm inchangé", async () => {
    await scalperFor(db, new LadderFeed([CAND]), { sweepTriggerUsd: 1e9 }).tick();
    const { buildSnapshot } = await import("../../src/portfolio/portfolio.js");
    const snap = buildSnapshot(db, new Map([["MAX_mint", 0.01]]), {
      mode: "paper",
      paperCashUsdc: paperCashGet(db, 100),
      solPrice: 150,
      usdcPrice: 1,
      risk: { daily_loss_limit_pct: 5, max_usdc_deploy_pct: 100 } as never,
      nowMs: Date.now(),
    });
    const p = snap.positions[0]!;
    // friction ≈ −qty × priceEff × (1 − 1/1.025...) ~ entre −0.020 et −0.035 pour un lot de 1$
    expect(p.markUsd).toBeGreaterThan(0);
    expect(p.entryFrictionUsd).toBeLessThan(0);
    expect(p.entryFrictionUsd).toBeGreaterThan(-0.04);
    expect(p.unrealizedPnlUsd).toBeCloseTo(p.valueUsd - p.avgEntryUsd * p.qty, 6);
  });
});

describe("v5 — zone d'exclusion des rugs", () => {
  let db: DB;
  beforeEach(() => {db = freshDb();});
  afterEach(() => {closeDb(db);});

  it("rug exit → ticker blacklisté: le prochain coin au même ticker exact est refusé", async () => {
    // 1) coin SILLY qui rugue → rug exit + blacklist
    const silly = { ...CAND, mint: "SILLY_mint", symbol: "SILLY" };
    await scalperFor(db, new LadderFeed([silly])).tick();
    await scalperFor(db, new LadderFeed([], 0.005), { sweepTriggerUsd: 1e9 }).tick(); // −50% → rug exit
    expect(listTrades(db, {}).some((t) => t.reason === "rug exit")).toBe(true);
    expect(kvGetJson<Record<string, number>>(db, "maxscalpRugTickers", {})).toHaveProperty("SILLY");
    // 2) un nouveau SILLY mint différent → refus; un autre ticker → acheté
    const silly2 = { ...CAND, mint: "SILLY2_mint", symbol: "SILLY" };
    const good = { ...CAND, mint: "GOOD_mint", symbol: "GOOD" };
    await scalperFor(db, new LadderFeed([silly2, good])).tick();
    const buys = listTrades(db, {}).filter((t) => t.side === "buy");
    expect(buys.some((t) => t.mint === "GOOD_mint")).toBe(true);
    expect(buys.some((t) => t.mint === "SILLY2_mint")).toBe(false);
  });

  it("moon stop/rug d'un lot profité n'ajoute PAS le ticker à l'exclusion", async () => {
    await scalperFor(db, new LadderFeed([CAND])).tick();                    // entrée
    await scalperFor(db, new LadderFeed([], 0.022)).tick();                 // take n°1
    await scalperFor(db, new LadderFeed([], 0.008), { sweepTriggerUsd: 1e9 }).tick(); // moon stop
    expect(listTrades(db, {}).some((t) => t.reason === "moon stop")).toBe(true);
    expect(kvGetJson<Record<string, number>>(db, "maxscalpRugTickers", {})).not.toHaveProperty("MAX");
  });
});

describe("v6 — anti-fiction comptable (marks frais) + warmup reprice", () => {
  let db: DB;
  beforeEach(() => {db = freshDb();});
  afterEach(() => {closeDb(db);});

  it("lot ruggé mais mark pas frais → NO sell; dead exit au dernier prix connu (cash mode)", async () => {
    const now = Date.now();
    addLot(db, "DEAD_mint", "DEAD", 96, 0.01, now - 2 * 3_600_000);
    const { insertTicks } = await import("../../src/state/market.js");
    insertTicks(db, [{ ts: now - 3 * 3_600_000, mint: "DEAD_mint", price: 0.004, liquidity: null, volumeDelta: null }]); // −60% mais il y a 3h
    paperCashSet(db, 0);
    // LadderFeed price 0 → snapshot null; latestCandle null → aucun mark frais possible
    const s = scalperFor(db, new LadderFeed([], 0), { sweepTriggerUsd: 1e9 });
    await s.tick();
    expect(listTrades(db, {}).some((t) => t.reason === "rug exit")).toBe(false);
    const dead = listTrades(db, {}).filter((t) => t.reason === "dead exit");
    expect(dead).toHaveLength(1);
    expect(dead[0]!.expectedPriceUsd).toBeCloseTo(0.004, 9);          // derniers prix connus, pas l'entrée
    expect(listPositions(db, true)).toHaveLength(0);
  });

  it("lot sans AUCUN prix connu → dead exit amputé à 50% du coût", async () => {
    const now = Date.now();
    addLot(db, "GHOST_mint", "GHOST", 96, 0.01, now - 2 * 3_600_000);
    paperCashSet(db, 0);
    const s = scalperFor(db, new LadderFeed([], 0), { sweepTriggerUsd: 1e9 });
    await s.tick();
    const dead = listTrades(db, {}).filter((t) => t.reason === "dead exit");
    expect(dead).toHaveLength(1);
    expect(dead[0]!.expectedPriceUsd).toBeCloseTo(0.005, 9);          // 0.01 × deadHaircutPct 0.5
  });

  it("repriceAll: tous les marks repricé via OHLCV au boot", async () => {
    const now = Date.now();
    addLot(db, "WARM_mint", "WARM", 96, 0.01, now - 3_600_000);
    const feed: DiscoveryFeed = {
      name: "stub",
      refresh: async () => [],
      latestCandle: async () => ({ ts: now, open: 0.02, high: 0.02, low: 0.02, close: 0.02, volumeUsd: 1000 }),
      snapshotPrice: () => null,
    };
    const s = scalperFor(db, feed);
    const n = await s.repriceAll();
    expect(n).toBe(1);
    const { latestTickAnyAge } = await import("../../src/state/market.js");
    expect(latestTickAnyAge(db, "WARM_mint")?.price).toBe(0.02);
  });
});

describe("v7 — garde anti-fausse lune (suivre fake moons)", () => {
  let db: DB;
  beforeEach(() => {db = freshDb();});
  afterEach(() => {closeDb(db);});

  it("candle ×5225 sur une pool relancée → vente au dernier prix discovery (pas de 2300$ fiction)", async () => {
    const now = Date.now();
    addLot(db, "NIVRA_mint", "NIVRA", 57_459_501, 8.389e-9, now - 600_000);         // ~0.48$ investi
    const { insertTicks } = await import("../../src/state/market.js");
    // discovery: prix mort 8.18e-9 (liquide, mais VIEUX de 2h) puis candle OHLCV "pool relancée" à 4.28e-5 (12s)
    insertTicks(db, [
      { ts: now - 7_200_000, mint: "NIVRA_mint", price: 8.18e-9, liquidity: 104, volumeDelta: 0, src: "discovery" },
      { ts: now - 12_000, mint: "NIVRA_mint", price: 4.28e-5, liquidity: null, volumeDelta: 27, src: "candle" },
    ]);
    paperCashSet(db, 0);
    const s = scalperFor(db, new LadderFeed([], 0), { sweepTriggerUsd: 1e9, maxPositions: 1, idleExitNoVolMin: 0, idleExitMinAgeMin: 0, deadLotMinAgeMin: 0 });
    await s.tick();
    const sells = listTrades(db, {}).filter((t) => t.side === "sell");
    expect(sells.length).toBeGreaterThanOrEqual(1);
    // le lot finit liquidé (recycle/idle/dead) au prix discovery 8.18e-9 — JAMAIS au candle ×5225
    expect(sells.every((t) => t.expectedPriceUsd! < 1e-7)).toBe(true);
    expect(sells[0]!.spendUsd).toBeLessThan(1);
    // le sol n'a pas été gonflé de cash fictif
    expect(paperCashGet(db, 0)).toBeLessThan(2);
  });

  it("candle légitime ×2 vs discovery → prix candle honnête pour la vente", async () => {
    const now = Date.now();
    addLot(db, "MOON_mint", "MOON", 96, 0.01, now - 600_000);
    const { insertTicks } = await import("../../src/state/market.js");
    insertTicks(db, [
      { ts: now - 30_000, mint: "MOON_mint", price: 0.021, liquidity: 12_000, volumeDelta: 5_000, src: "discovery" },
      { ts: now - 12_000, mint: "MOON_mint", price: 0.021, liquidity: null, volumeDelta: 6_000, src: "candle" },
    ]);
    const s = scalperFor(db, new LadderFeed([], 0.021), { sweepTriggerUsd: 1e9 });
    await s.tick();
    const trades = listTrades(db, {}).filter((t) => t.reason?.startsWith("take ladder"));
    expect(trades.length).toBeGreaterThanOrEqual(1);
    expect(trades[0]!.expectedPriceUsd).toBeCloseTo(0.021, 9);
  });

  it("aucun prix discovery mais candle ×10 000 l'entrée → venta clampée à entry×20", async () => {
    const now = Date.now();
    addLot(db, "MULE_mint", "MULE", 96, 0.01, now - 600_000);
    const { insertTicks } = await import("../../src/state/market.js");
    insertTicks(db, [{ ts: now - 12_000, mint: "MULE_mint", price: 100, liquidity: null, volumeDelta: 50, src: "candle" }]);
    const s = scalperFor(db, new LadderFeed([], 0), { sweepTriggerUsd: 1e9 });
    await s.tick();
    const trades = listTrades(db, {}).filter((t) => t.symbol === "MULE");
    const sells = trades.filter((t) => t.side === "sell");
    expect(sells.length).toBeGreaterThanOrEqual(1);
    expect(sells[0]!.expectedPriceUsd).toBeCloseTo(0.2, 9);   // clamp entry×20 = 0.01×20
    expect(sells[0]!.spendUsd).toBeLessThan(20);
    // v11.1: le kickoff prélève 25% du clamp (≈4.6$ net sur le sol 19.2$) — jamais les 2300$ fiction
    expect(paperCashGet(db, 0)).toBeLessThan(105.5);            // pas de +9600$ fiction
  });
});

describe("v10.2 — garde anti fake-pump (STREAM: pool relancée, discovery ×37 gelé 1h)", () => {
  let db: DB;
  beforeEach(() => {db = freshDb();});
  afterEach(() => {closeDb(db);});

  it("saut discovery ×37 en un tick sans bougie + gel ≥15 min → purge au niveau légitime ×0.5", async () => {
    const now = Date.now();
    addLot(db, "STREAM_mint", "STREAM", 36_000, 1.4e-4, now - 2 * 3_600_000); // lot ~5$
    const { insertTicks } = await import("../../src/state/market.js");
    const T = (ts: number, price: number, src: "discovery" | "candle" = "discovery") => ({ ts, mint: "STREAM_mint", price, liquidity: 80_000, volumeDelta: null, src });
    insertTicks(db, [
      T(now - 20 * 60_000, 1.4e-4),    // niveau légitime (entrée, grind)
      T(now - 19 * 60_000, 1.98e-4),   // dernier niveau légitime d'avant-jump
      T(now - 18 * 60_000, 7.36e-3),   // la jump fiction ×37 en un seul tick discovery
      T(now - 10 * 60_000, 7.36e-3),   // gelé…
      T(now - 3 * 60_000, 7.36e-3),    // …18 min au total, mark "frais" (ré-émis) → dead listing désamorcé
    ]);
    paperCashSet(db, 0);
    const s = scalperFor(db, new LadderFeed([], 0), { sweepTriggerUsd: 1e9, deadLotMinAgeMin: 999 });
    await s.tick();
    const purges = listTrades(db, {}).filter((t) => t.reason === "fake pump purge");
    expect(purges).toHaveLength(1);
    const priceNet = purges[0]!.spendUsd! / purges[0]!.qty!;
    expect(priceNet).toBeLessThanOrEqual(1.98e-4);           // vendu AU NIVEAU LÉGITIME ×haircut, jamais au 7.36e-3 fictif
    expect(priceNet).toBeGreaterThan(5e-5);                  // et pas donné (haircut 0.5 du niveau 1.98e-4)
    expect(listPositions(db, true)).toHaveLength(0);         // la position fantôme n'existe plus
    expect(paperCashGet(db, 0)).toBeLessThan(5);             // NAV corrigé: ~3.5$ rapatrié, PAS 267$ de fiction
  });

  it("saut ×37 MAIS la bougie OHLCV du pool confirme le niveau → pas de purge (pump légitime)", async () => {
    const now = Date.now();
    addLot(db, "REAL_mint", "REAL", 36_000, 1.4e-4, now - 2 * 3_600_000);
    const { insertTicks } = await import("../../src/state/market.js");
    const T = (ts: number, price: number, src: "discovery" | "candle" = "discovery") => ({ ts, mint: "REAL_mint", price, liquidity: 80_000, volumeDelta: null, src });
    insertTicks(db, [
      T(now - 20 * 60_000, 1.4e-4),
      T(now - 19 * 60_000, 1.98e-4),
      T(now - 18 * 60_000, 7.36e-3),
      T(now - 5 * 60_000, 7.35e-3, "candle"), // bougie frais qui confirme le nouveau niveau
      T(now - 3 * 60_000, 7.36e-3),
    ]);
    const s = scalperFor(db, new LadderFeed([], 0), { sweepTriggerUsd: 1e9, deadLotMinAgeMin: 999 });
    await s.tick();
    expect(listTrades(db, {}).filter((t) => t.reason === "fake pump purge")).toHaveLength(0);
    expect(listPositions(db, true)).toHaveLength(1);         // le lot court encore (cette fois le paper n'y croit pas plus qu'avant: clamp entry×20 gère les ventes)
  });

  it("bougie 'confirmante' mais pool créée APRÈS l'ouverture des lots (pool relancée au boot: STREAM id82) → purge quand même", async () => {
    const now = Date.now();
    addLot(db, "STREAM_mint", "STREAM", 36_000, 1.4e-4, now - 2 * 3_600_000);
    const { insertTicks, upsertTokenMeta } = await import("../../src/state/market.js");
    const T = (ts: number, price: number, src: "discovery" | "candle" = "discovery") => ({ ts, mint: "STREAM_mint", price, liquidity: 80_000, volumeDelta: null, src });
    insertTicks(db, [
      T(now - 20 * 60_000, 1.4e-4),
      T(now - 19 * 60_000, 1.98e-4),
      T(now - 18 * 60_000, 7.36e-3),
      T(now - 5 * 60_000, 7.35e-3, "candle"), // la bougie du NOUVEAU pool (celle qu'écrit repriceAll au boot)
      T(now - 3 * 60_000, 7.36e-3),
    ]);
    // token_meta: la pool qui cote désormais a été créée 1h après l'ouverture des lots → relaunch
    upsertTokenMeta(db, { mint: "STREAM_mint", symbol: "STREAM", decimals: 6, isVerified: null, liquidityUsd: 80_000, poolCreatedMs: now - 1 * 3_600_000 }, now);
    paperCashSet(db, 0);
    const s = scalperFor(db, new LadderFeed([], 0), { sweepTriggerUsd: 1e9, deadLotMinAgeMin: 999 });
    await s.tick();
    const purges = listTrades(db, {}).filter((t) => t.reason === "fake pump purge");
    expect(purges).toHaveLength(1);
    const priceNet = purges[0]!.spendUsd! / purges[0]!.qty!;
    expect(priceNet).toBeLessThanOrEqual(1.98e-4);           // purge au niveau légitime ×haircut, pas de clamp ×20
    expect(listPositions(db, true)).toHaveLength(0);
    expect(paperCashGet(db, 0)).toBeLessThan(5);
  });
});
