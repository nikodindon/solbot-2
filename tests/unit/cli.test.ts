import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseConfigRaw } from "../../src/config/loader.js";
import { openDb, closeDb, type DB } from "../../src/state/db.js";
import { migrate } from "../../src/state/migrations.js";
import { FundingWatcher } from "../../src/engine/funding.js";
import { reconcileOnChain } from "../../src/engine/reconcile.js";
import { upsertTokenMeta } from "../../src/state/market.js";
import { addLot, getPosition } from "../../src/state/portfolio-repo.js";
import { DemoFeed } from "../../src/demo/feed.js";
import { runInit } from "../../src/cli/init.js";
import { USDC_MINT } from "../../src/constants.js";

process.env["MODE"] = "test";

function cfg() {
  return parseConfigRaw({});
}

const JUP = "JUPyiwrYJFUKUzgctMz2f8ahKkrgJqL86sBGDvCN";
const BONK = "DezXAZ8z7PnrnRJjz3fXBi1tBnVijayaHnzB263";

function fakeRpc(balances: { lamports?: number; tokens?: { mint: string; amount: number; decimals: number }[] }) {
  return {
    getBalance: async (): Promise<number> => balances.lamports ?? 0,
    tokenAccounts: async (): Promise<{ mint: string; amount: number; decimals: number }[]> => balances.tokens ?? [],
  };
}

describe("FundingWatcher", () => {
  beforeEach(() => {});

  it("funded quand SOL ≥ min et USDC ≥ min", async () => {
    const cfgv = cfg();
    cfgv.funding.min_sol_usd = 1;
    cfgv.funding.min_usdc_usd = 5;
    const rpc = fakeRpc({ lamports: 0.02e9, tokens: [{ mint: USDC_MINT, amount: 6e6, decimals: 6 }] }) as never;
    const w = new FundingWatcher({ rpc }, cfgv.funding);
    const st = await w.status("abc", 100); // SOL ≈ 2$
    expect(st.funded).toBe(true);
    expect(st.missing).toHaveLength(0);
  });

  it("missing couvre SOL et USDC sous-financés", async () => {
    const cfgv = cfg();
    const rpc = fakeRpc({ lamports: 0.001e9, tokens: [] }) as never;
    const w = new FundingWatcher({ rpc }, cfgv.funding);
    const st = await w.status("abc", 100);
    expect(st.funded).toBe(false);
    const items = st.missing.map((m) => m.item).sort();
    expect(items).toEqual(["SOL", "USDC"]);
  });

  it("sans RPC/wallet → missing wallet/RPC", async () => {
    const w = new FundingWatcher({ rpc: null }, cfg().funding);
    const st = await w.status(null, 100);
    expect(st.funded).toBe(false);
    const m0 = st.missing[0];
    expect(m0?.item).toBe("wallet/RPC");
  });
});

describe("reconcileOnChain", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb({ path: ":memory:", memory: true });
    migrate(db);
  });
  afterEach(() => closeDb(db));

  const market = {
    priceOf: (m: string) => (m === JUP ? 1 : m === BONK ? 0.00002 : undefined),
    solPrice: 150,
    decimalsOf: () => 6,
    symbolOf: (m: string) => (m === JUP ? "JUP" : "BONK"),
  };

  it("adopte un token détenu on-chain absent du carnet + journałe un trade reconcile", async () => {
    const cfgv = cfg();
    upsertTokenMeta(db, { mint: JUP, symbol: "JUP", decimals: 6, isVerified: true, liquidityUsd: 9e6, poolCreatedMs: 0 }, Date.now());
    const rpc = fakeRpc({ lamports: 0, tokens: [{ mint: JUP, amount: 42e6, decimals: 6 }] }) as never;
    const lines = await reconcileOnChain(db, rpc, "owner", market, cfgv, 1_000);
    expect(lines).toHaveLength(1);
    const l0 = lines[0];
    expect(l0?.action).toBe("adopt");
    const pos = getPosition(db, JUP);
    expect(pos && Math.abs(pos.qty - 42) < 1e-9).toBe(true);
    const trades = db.prepare("SELECT COUNT(*) n FROM trades WHERE strategy='reconcile'").get() as { n: number };
    expect(trades.n).toBe(1);
  });

  it("ferme FIFO une position carnet dont le solde on-chain est nul", async () => {
    const cfgv = cfg();
    upsertTokenMeta(db, { mint: BONK, symbol: "BONK", decimals: 5, isVerified: true, liquidityUsd: 9e6, poolCreatedMs: 0 }, Date.now());
    addLot(db, BONK, "BONK", 100, 0.00002, 900);
    const rpc = fakeRpc({ lamports: 0, tokens: [] }) as never;
    const lines = await reconcileOnChain(db, rpc, "owner", market, cfgv, 2_000);
    expect(lines.some((l) => l.action === "close")).toBe(true);
    const pos = getPosition(db, BONK);
    expect(pos === null || pos.qty < 1e-9).toBe(true);
  });

  it("rien à faire quand tout est aligné", async () => {
    const cfgv = cfg();
    const rpc = fakeRpc({ lamports: 0, tokens: [] }) as never;
    const lines = await reconcileOnChain(db, rpc, "owner", market, cfgv, 3_000);
    expect(lines).toHaveLength(0);
  });
});

describe("DemoFeed", () => {
  it("déterministe (seed fixe) : deux feeds identiques avancent les mêmes prix", async () => {
    const db1 = openDb({ path: ":memory:", memory: true });
    migrate(db1);
    const a = new DemoFeed(db1, cfg());
    const db2 = openDb({ path: ":memory:", memory: true });
    migrate(db2);
    const b = new DemoFeed(db2, cfg());
    const s1 = await a.pollOnce();
    const s2 = await b.pollOnce();
    expect(s1.ok).toBe(true);
    expect(s1.prices.get(USDC_MINT)).toBe(1);
    for (const [m, p] of s1.prices) {
      if (m !== USDC_MINT) {expect(s2.prices.get(m)).toBeCloseTo(p, 12);}
    }
    closeDb(db2);
  });

  it("écrit des bougies 15m virtuelles ≥ 0 et un plancher de prix", async () => {
    const db = openDb({ path: ":memory:", memory: true });
    migrate(db);
    const feed = new DemoFeed(db, cfg());
    for (let i = 0; i < 3; i++) {await feed.pollOnce();}
    const n = (db.prepare("SELECT COUNT(*) n FROM candles WHERE tf='15m'").get() as { n: number }).n;
    expect(n).toBeGreaterThanOrEqual(3);
    const minP = (db.prepare("SELECT MIN(price_usd) p FROM price_ticks").get() as { p: number }).p;
    expect(minP).toBeGreaterThan(0);
    closeDb(db);
  });
});

describe("runInit", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "solbot2-init-"));
    process.chdir(root);
  });
  afterEach(() => {
    process.chdir("/");
  });

  it("crée .env chmod 600 avec clé valide, puis réutilise (created=false)", async () => {
    const first = await runInit(root);
    expect(first.created).toBe(true);
    expect(first.pubkey).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    const stat = (await import("node:fs")).statSync(first.envPath);
    expect(stat.mode & 0o777).toBe(0o600);
    const second = await runInit(root);
    expect(second.created).toBe(false);
    expect(second.pubkey).toBe(first.pubkey);
  });

  it("patch une .env sans clé (BS58 vide)", async () => {
    (await import("node:fs")).writeFileSync(path.join(root, ".env"), "MODE=paper\nBS58_PRIVATE_KEY=\n");
    const res = await runInit(root);
    expect(res.created).toBe(true);
    const content = (await import("node:fs")).readFileSync(res.envPath, "utf8");
    expect(/^BS58_PRIVATE_KEY=[1-9A-HJ-NP-Za-km-z]{40,}$/m.test(content)).toBe(true);
  });
});
