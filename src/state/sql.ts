import type { DB } from "./db.js";

/** Run `fn` inside an explicit SQLite transaction (node:sqlite has no .transaction() helper). */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* noop */
    }
    throw err;
  }
}

export function queryAll<T>(db: DB, sql: string, ...args: (string | number | null)[]): T[] {
  return db.prepare(sql).all(...args) as unknown as T[];
}

export function queryGet<T>(
  db: DB,
  sql: string,
  ...args: (string | number | null)[]
): T | undefined {
  return db.prepare(sql).get(...args) as unknown as T | undefined;
}
