import type { DB } from "./db.js";

export function kvGet(db: DB, key: string): string | null {
  const row = db.prepare("SELECT value FROM bot_state WHERE key = ?").get(key) as
    { value: string } | undefined;
  return row?.value ?? null;
}

export function kvSet(db: DB, key: string, value: string): void {
  db.prepare(
    "INSERT INTO bot_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function kvGetJson<T>(db: DB, key: string, def: T): T {
  const raw = kvGet(db, key);
  if (raw === null) {return def;}
  try {
    return JSON.parse(raw) as T;
  } catch {
    return def;
  }
}

export function kvSetJson(db: DB, key: string, value: unknown): void {
  kvSet(db, key, JSON.stringify(value));
}
