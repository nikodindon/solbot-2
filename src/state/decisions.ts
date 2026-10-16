import type { DB } from "./db.js";
import { tx } from "./sql.js";

export interface DecisionRecord {
  tsMs: number;
  tickId: number;
  kind:
    "signal" | "reject" | "trade" | "error" | "allocation" | "regime" | "funding" | "kill" | "info";
  strategy?: string | null;
  mint?: string | null;
  line: string;
  data?: Record<string, unknown>;
}

export function insertDecision(db: DB, d: DecisionRecord): number {
  const info = db
    .prepare(
      "INSERT INTO decisions (ts_ms, tick_id, kind, strategy, mint, line, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      d.tsMs,
      d.tickId,
      d.kind,
      d.strategy ?? null,
      d.mint ?? null,
      d.line,
      d.data ? JSON.stringify(d.data) : null,
    );
  return Number(info.lastInsertRowid);
}

export function insertDecisions(db: DB, list: DecisionRecord[]): void {
  tx(db, () => {
    for (const d of list) {insertDecision(db, d);}
  });
}

export interface DecisionRowFull extends DecisionRecord {
  id: number;
}

export function listDecisions(
  db: DB,
  opts: { limit?: number; kind?: string[]; mint?: string; strategy?: string } = {},
): DecisionRowFull[] {
  const limit = opts.limit ?? 200;
  let sql = "SELECT * FROM decisions";
  const wh: string[] = [];
  const args: (string | number)[] = [];
  if (opts.kind && opts.kind.length > 0) {
    wh.push(`kind IN (${opts.kind.map(() => "?").join(",")})`);
    args.push(...opts.kind);
  }
  if (opts.mint) {
    wh.push("mint = ?");
    args.push(opts.mint);
  }
  if (opts.strategy) {
    wh.push("strategy = ?");
    args.push(opts.strategy);
  }
  if (wh.length > 0) {sql += " WHERE " + wh.join(" AND ");}
  sql += " ORDER BY id DESC LIMIT ?";
  args.push(limit);
  const rows = db.prepare(sql).all(...args) as {
    id: number;
    ts_ms: number;
    tick_id: number;
    kind: string;
    strategy: string | null;
    mint: string | null;
    line: string;
    data: string | null;
  }[];
  return rows.reverse().map((r) => ({
    id: r.id,
    tsMs: r.ts_ms,
    tickId: r.tick_id,
    kind: r.kind as DecisionRecord["kind"],
    strategy: r.strategy,
    mint: r.mint,
    line: r.line,
    data: r.data ? (JSON.parse(r.data) as Record<string, unknown>) : undefined,
  }));
}

export function insertSignal(
  db: DB,
  tsMs: number,
  strategy: string,
  mint: string,
  symbol: string,
  side: string,
  score: number,
  edgeBps: number | null,
  reason: string,
): void {
  db.prepare(
    "INSERT INTO signals (ts_ms, strategy, mint, symbol, side, score, edge_bps, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(tsMs, strategy, mint, symbol, side, score, edgeBps, reason);
}
