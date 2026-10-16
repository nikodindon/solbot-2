import fs from "node:fs";
import path from "node:path";

export interface EnvFileResult {
  data: Record<string, string>;
  path: string;
}

/** Parse a dotenv-style file. Does NOT throw on malformed lines; ignores comments and blanks. */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {continue;}
    const eq = line.indexOf("=");
    if (eq <= 0) {continue;}
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key.length === 0) {continue;}
    out[key] = value;
  }
  return out;
}

/** Empty string -> undefined (treat as absent), trims. */
export function emptyToUndefined(v: string | undefined): string | undefined {
  if (v === undefined) {return v;}
  const t = v.trim();
  return t.length === 0 ? undefined : t;
}

export interface LoadEnvResult {
  data: Record<string, string | undefined>;
  fileVars: number;
}

/**
 * Load .env from disk (if present) into a fresh record, then overlay process.env.
 * process.env wins (standard dotenv semantics), so CLI/CI env can override the file.
 */
export function loadEnv(rootDir: string): LoadEnvResult {
  const p = path.join(rootDir, ".env");
  const data: Record<string, string | undefined> = {};
  let fileVars = 0;
  if (fs.existsSync(p)) {
    const parsed = parseEnvFile(fs.readFileSync(p, "utf8"));
    for (const [k, v] of Object.entries(parsed)) {
      data[k] = v;
      fileVars += 1;
    }
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") {
      data[k] = v;
    }
  }
  return { data, fileVars };
}

export class EnvProvider {
  constructor(private readonly data: Record<string, string | undefined>) {}

  get(name: string): string | undefined {
    return emptyToUndefined(this.data[name]);
  }
}
