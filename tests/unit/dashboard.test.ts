import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type DB } from "../../src/state/db.js";
import { migrate } from "../../src/state/migrations.js";
import { parseConfigRaw } from "../../src/config/loader.js";
import { addLot } from "../../src/state/portfolio-repo.js";
import { insertEquity, insertShadowTrade, insertShadowNav } from "../../src/state/equity.js";
import { insertTrade } from "../../src/state/trades.js";
import { DashboardServer } from "../../src/dashboard/server.js";
import { buildState, type DashboardState } from "../../src/dashboard/state.js";

interface Ctx {
  db: DB;
  server: DashboardServer;
  cfg: ReturnType<typeof parseConfigRaw>;
  root: string;
}

async function makeServer(opts?: { token?: string }): Promise<Ctx> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solbot2-dash-"));
  fs.mkdirSync(path.join(root, "public"), { recursive: true });
  const db = openDb({ path: ":memory:", memory: true });
  migrate(db);
  const base = parseConfigRaw({ mode: "paper" });
  const cfg = {
    ...base,
    dashboard: { ...base.dashboard, host: "127.0.0.1", port: 0 },
  };
  process.env.DASHBOARD_TOKEN = opts?.token;
  const s = new DashboardServer({ db, cfg, mode: "paper", rootDir: root, skipTokenCheck: !opts?.token });
  await s.start();
  return { db, server: s, cfg, root };
}

async function close(ctx: Ctx): Promise<void> {
  await ctx.server.stop();
  fs.rmSync(ctx.root, { recursive: true, force: true });
  delete process.env.DASHBOARD_TOKEN;
}

function seed(ctx: Ctx): void {
  const now = Date.now();
  addLot(ctx.db, "JUP1", "JUP", 2, 1.0, now - 30_000);
  insertEquity(ctx.db, { tsMs: now - 60_000, tickId: 1, navUsd: 6, cashUsd: 6, positionsUsd: 0, realizedTotalUsd: 0, drawdownPct: 0 });
  insertEquity(ctx.db, { tsMs: now, tickId: 2, navUsd: 6.2, cashUsd: 5.0, positionsUsd: 1.2, realizedTotalUsd: 0.2, drawdownPct: 0 });
  insertTrade(ctx.db, {
    tsMs: now - 10_000, mode: "paper", strategy: "momentum", mint: "JUP1", symbol: "JUP",
    side: "buy", spendUsd: 2, qty: 2, priceUsd: 1.0, status: "simulated", reason: "test",
  });
  insertShadowTrade(ctx.db, { shadow: "momentum", tsMs: now - 10_000, mint: "JUP1", side: "buy", qty: 3, priceUsd: 1, spendUsd: 3, feeTotalUsd: 0.001 });
  insertShadowNav(ctx.db, "momentum", now - 20_000, 30);
  insertShadowNav(ctx.db, "momentum", now - 10_000, 30.5);
}

describe("dashboard server", () => {
  it("healthz + doc API", async () => {
    const ctx = await makeServer();
    try {
      const hz = await fetch(`${ctx.server.url()}/healthz`);
      expect(hz.status).toBe(200);
      expect(await hz.json()).toEqual(expect.objectContaining({ ok: true }));
      const doc = (await (await fetch(`${ctx.server.url()}/api`)).json()) as { endpoints?: Record<string, string> };
      expect(doc.endpoints?.["/api/state"]).toBeTruthy();
    } finally {
      await close(ctx);
    }
  });

  it("endpoints documentés: state, equity, trades, decisions, shadows, metrics", async () => {
    const ctx = await makeServer();
    seed(ctx);
    try {
      const base = ctx.server.url();
      const state = (await (await fetch(`${base}/api/state`)).json()) as DashboardState;
      expect(state.nav.usd).toBeGreaterThan(0);
      expect(state.counters.tradesTotal).toBe(1);
      expect(state.benchmarks.bhUsd).not.toBeNull();
      expect(state.portfolio.positions.length).toBe(1);

      const eq = (await (await fetch(`${base}/api/equity?limit=10`)).json()) as { points: Record<string, unknown>[] };
      expect(Array.isArray(eq.points)).toBe(true);
      expect(eq.points.length).toBe(2);

      const tr = (await (await fetch(`${base}/api/trades?limit=5`)).json()) as { trades: Record<string, unknown>[] };
      expect(tr.trades.length).toBe(1);
      expect(tr.trades[0]?.mint).toBe("JUP1");

      const dc = (await (await fetch(`${base}/api/decisions?limit=10`)).json()) as { decisions: unknown[] };
      expect(dc.decisions).toEqual([]);

      const sh = (await (await fetch(`${base}/api/shadows`)).json()) as { shadows: Record<string, unknown>[] };
      expect(sh.shadows[0]?.shadow === undefined ? {} : sh.shadows[0]).toEqual(
        expect.objectContaining({ shadow: "momentum", score24hUsd: expect.closeTo(0.5, 6), allocated: null }),
      );

      const met = await (await fetch(`${base}/metrics`)).text();
      expect(met).toContain("solbot2_nav_usd ");
      expect(met).toContain("solbot2_trades_total 1");
    } finally {
      await close(ctx);
    }
  });

  it("statiques: index.html servi, path traversal refusé, 404 sinon", async () => {
    const ctx = await makeServer();
    try {
      fs.writeFileSync(path.join(ctx.root, "public", "index.html"), "<html>ok</html>");
      const idx = await fetch(`${ctx.server.url()}/`);
      expect(idx.status).toBe(200);
      expect(await idx.text()).toContain("ok");
      const nf = await fetch(`${ctx.server.url()}/ ../../../etc/passwd`.replace(" ", "%20%20"));
      expect(nf.status).toBe(404);
      const nf2 = await fetch(`${ctx.server.url()}/rien.js`);
      expect(nf2.status).toBe(404);
    } finally {
      await close(ctx);
    }
  });

  it("SSE /api/stream: events hello + state puis broadcast", async () => {
    const ctx = await makeServer();
    seed(ctx);
    try {
      const res = await fetch(`${ctx.server.url()}/api/stream`);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const first = decoder.decode((await reader.read()).value);
      expect(first).toContain("event: state");
      await reader.read(); // hello
      ctx.server.broadcast("decision", { line: "test sse" });
      const next = decoder.decode((await reader.read()).value);
      expect(next).toContain("event: decision");
      expect(next).toContain("test sse");
      await reader.cancel();
    } finally {
      await close(ctx);
    }
  });

  it("auth par token: 401 sans credentials, 200 avec bearer (skipTokenCheck => tests)", async () => {
    const ctx = await makeServer({ token: "sekrit" });
    try {
      const base = ctx.server.url();
      const no = await fetch(`${base}/api/state`);
      expect(no.status).toBe(401);
      const ok = await fetch(`${base}/api/state`, { headers: { authorization: "Bearer sekrit" } });
      expect(ok.status).toBe(200);
      const viaQuery = await fetch(`${base}/api/state?token=sekrit`);
      expect(viaQuery.status).toBe(200);
    } finally {
      await close(ctx);
    }
  });

  it("buildState: garde-fous + markets + counters cohérents", () => {
    const db = openDb({ path: ":memory:", memory: true });
    migrate(db);
    const cfg = parseConfigRaw({ mode: "paper" });
    const st = buildState(db, cfg, "paper");
    expect(st.mode).toBe("paper");
    expect(st.guards.stopFile).toBe(false);
    expect(st.markets.length).toBeGreaterThanOrEqual(3); // SOL + JUP + BONK (universe de défaut)
    expect(st.markets.every((m) => m.symbol.length > 0)).toBe(true);
    expect(st.nav.initialCapitalUsd).toBeGreaterThanOrEqual(0);
    expect(st.markets.some((m) => m.symbol === "JUP")).toBe(true);
  });
});
