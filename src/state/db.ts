import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export type DB = DatabaseSync;

export interface OpenOpts {
  path: string;
  memory?: boolean;
}

/** Open (creating dirs) a SQLite DB with pragmas tuned for a single-process bot. :memory: supported for tests/backtests. */
export function openDb(opts: OpenOpts): DB {
  let p = opts.path;
  if (opts.memory) {p = ":memory:";}
  else {
    fs.mkdirSync(path.dirname(p), { recursive: true });
  }
  const db = new DatabaseSync(p);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = NORMAL;
  `);
  return db;
}

export function closeDb(db: DB): void {
  db.close();
}
