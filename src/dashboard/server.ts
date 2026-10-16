import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { DB } from "../state/db.js";
import type { AppConfig, Mode } from "../config/schema.js";
import { buildState, equitySeries, tradeList, decisionList, shadowOverview } from "./state.js";
import { kvGetJson } from "../state/kv.js";

export interface DashboardDeps {
  db: DB;
  cfg: AppConfig;
  mode: Mode;
  rootDir: string;
  skipTokenCheck?: boolean; // unit tests
}

const API_DOC = {
  api: "solbot2-dashboard/1",
  endpoints: {
    "/healthz": "GET — liveness (ok)",
    "/api/state": "GET — état courant: NAV, positions, garde-fous, allocation, marchés (read-only)",
    "/api/equity": "GET ?limit= — série equity (nav/cash/benchmarks)",
    "/api/trades": "GET ?limit= — journal des trades (status filled/simulated/failed)",
    "/api/decisions": "GET ?limit=&kind=&mint=&strategy= — journal d'explication",
    "/api/shadows": "GET — portefeuilles fantômes: NAV + score 24h + allocation",
    "/api/stream": "GET text/event-stream — décisions + état à chaque tick (SSE, read-only)",
    "/metrics": "GET — format Prometheus",
  },
  auth: "DASHBOARD_TOKEN optionnel: header bearer ou ?token=",
  note: "lecture seule; aucun secret n'est servi par ces endpoints",
};

/**
 * Dashboard HTTP read-only (défaut 0.0.0.0:4100). SSE /api/stream + endpoints JSON documentés
 * + /metrics Prometheus. Token optionnel (bearer / ?token=) ; avertit au boot si exposé sans token.
 */
export class DashboardServer {
  private server: http.Server | null = null;
  private sseClients = new Set<http.ServerResponse>();

  constructor(private readonly deps: DashboardDeps) {}

  url(): string {
    const addr = this.server?.address();
    if (addr && typeof addr === "object") {
      return `http://127.0.0.1:${addr.port}`;
    }
    return `http://127.0.0.1:${this.deps.cfg.dashboard.port}`;
  }

  /** Push a live event to all SSE clients (decisions or state refresh). */
  broadcast(kind: "decision" | "state", payload: unknown): void {
    const line = `event: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(line);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  async start(): Promise<void> {
    const { cfg } = this.deps;
    const token = process.env.DASHBOARD_TOKEN ?? null;
    await new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        try {
          this.route(req, res, token);
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });
      server.on("error", reject);
      server.listen(cfg.dashboard.port, cfg.dashboard.host, resolve);
      this.server = server;
    });
    const host = cfg.dashboard.host;
    const exposed = host === "0.0.0.0" || host === "::";
    if (exposed && !token) {
      console.warn(
        `[dashboard] ATTENTION: dashboard exposé sur ${host}:${cfg.dashboard.port} sans DASHBOARD_TOKEN — lecture publique`,
      );
    }
  }

  async stop(): Promise<void> {
    const srv = this.server;
    if (!srv) {return;}
    await new Promise<void>((resolve) => {
      for (const res of this.sseClients) {
        try {
          res.end();
        } catch { /* already closed */ }
      }
      this.sseClients.clear();
      srv.close(() => resolve());
    });
    this.server = null;
  }

  private json(res: http.ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  }

  private authed(req: http.IncomingMessage, url: URL, token: string | null): boolean {
    if (!token || this.deps.skipTokenCheck) {return true;}
    const h = req.headers.authorization;
    if (h === `Bearer ${token}`) {return true;}
    if (url.searchParams.get("token") === token) {return true;}
    return false;
  }

  private route(req: http.IncomingMessage, res: http.ServerResponse, token: string | null): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const { db, cfg, mode } = this.deps;
    const p = url.pathname;
    if (p === "/healthz") {
      this.json(res, 200, { ok: true, ts: Date.now(), mode });
      return;
    }
    if (p === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(this.promText());
      return;
    }
    if (p === "/api") {
      this.json(res, 200, API_DOC);
      return;
    }
    if (!p.startsWith("/api/")) {
      // static files (index.html, app.js, vendor)
      if (p === "/" || p.startsWith("/app") || p.startsWith("/style") || p.startsWith("/vendor") || p.startsWith("/index.html")) {
        this.staticFile(p, res);
        return;
      }
      this.json(res, 404, { error: "not found" });
      return;
    }
    if (!this.authed(req, url, token)) {
      this.json(res, 401, { error: "unauthorized (DASHBOARD_TOKEN)" });
      return;
    }
    if (p === "/api") {
      this.json(res, 200, API_DOC);
      return;
    }
    if (p === "/api/state") {
      this.json(res, 200, buildState(db, cfg, mode));
      return;
    }
    if (p === "/api/equity") {
      const limit = Math.min(5_000, Math.max(1, Number(url.searchParams.get("limit") ?? 2_000)));
      this.json(res, 200, { points: equitySeries(db, limit) });
      return;
    }
    if (p === "/api/trades") {
      const limit = Math.min(1_000, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));
      this.json(res, 200, { trades: tradeList(db, limit) });
      return;
    }
    if (p === "/api/decisions") {
      const limit = Math.min(1_000, Math.max(1, Number(url.searchParams.get("limit") ?? 200)));
      const kind = url.searchParams.get("kind");
      const mint = url.searchParams.get("mint");
      const strategy = url.searchParams.get("strategy");
      this.json(res, 200, {
        decisions: decisionList(db, { limit, kind: kind ? [kind] : undefined, mint: mint ?? undefined, strategy: strategy ?? undefined }),
      });
      return;
    }
    if (p === "/api/shadows") {
      this.json(res, 200, { shadows: shadowOverview(db) });
      return;
    }
    if (p === "/api/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.flushHeaders();
      res.write(`event: state\ndata: ${JSON.stringify(buildState(db, cfg, mode))}\n\n`);
      res.write(`event: hello\ndata: ${JSON.stringify({ note: "flux SSE solbot2 (lecture seule)" })}\n\n`);
      this.sseClients.add(res);
      const heartbeat = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {
          clearInterval(heartbeat);
          this.sseClients.delete(res);
        }
      }, 15_000);
      req.on("close", () => {
        clearInterval(heartbeat);
        this.sseClients.delete(res);
      });
      return;
    }
    this.json(res, 404, { error: "endpoint inconnu", doc: "/api" });
  }

  private staticFile(p: string, res: http.ServerResponse): void {
    const root = path.join(this.deps.rootDir, "public");
    const rel = p === "/" ? "index.html" : p.replace(/^\/+/, "");
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      this.json(res, 404, { error: "not found" });
      return;
    }
    const ext = path.extname(file);
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
    };
    res.writeHead(200, { "content-type": types[ext] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  }

  private promText(): string {
    const { db, cfg, mode } = this.deps;
    const s = buildState(db, cfg, mode);
    const lines: string[] = [];
    const add = (name: string, help: string, value: number | string) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`);
    };
    add("solbot2_nav_usd", "NAV courante estimée", s.nav.usd.toFixed(6));
    add("solbot2_cash_usd", "cash USDC", s.nav.cashUsd.toFixed(6));
    add("solbot2_positions_usd", "exposition positions", s.nav.positionsUsd.toFixed(6));
    add("solbot2_realized_pnl_usd", "PnL réalisé cumulé", s.nav.realizedTotalUsd.toFixed(6));
    add("solbot2_drawdown_pct", "drawdown depuis le peak (%)", s.nav.drawdownPct.toFixed(4));
    add("solbot2_trades_total", "nombre total de trades", s.counters.tradesTotal);
    add("solbot2_decisions_total", "nombre total de décisions journalisées", s.counters.decisionsTotal);
    add("solbot2_equity_points", "points equity en base", s.counters.equityPoints);
    add("solbot2_ticks_total", "ticks moteur exécutés", kvGetJson<number>(db, "tickCount", 0));
    add("solbot2_swaps_remaining", "swaps SOL restants au-dessus de la réserve de gaz", s.nav.swapsRemaining);
    add("solbot2", "mode courant (label)", JSON.stringify(mode).replace(/"/g, ""));
    lines.push("# EOF");
    return lines.join("\n") + "\n";
  }
}
