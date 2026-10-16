import pino from "pino";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const REDACT_KEYS = [
  "BS58_PRIVATE_KEY",
  "JUPITER_API_KEY",
  "privateKey",
  "secretKey",
  "signedTransaction",
  "SOLANA_PRIVATE_KEY",
];

const redactPaths: string[] = [];
for (const key of REDACT_KEYS) {
  redactPaths.push(key, `${key}.*`, `*.${key}`, `*.${key}.*`);
}

export interface Logger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
  child: (bindings: Record<string, unknown>) => Logger;
}

let root: pino.Logger | null = null;

export function initLogger(level?: string): Logger {
  const lvl = level ?? process.env.LOG_LEVEL ?? "info";
  root = pino({
    level: lvl,
    base: undefined,
    redact: { paths: redactPaths, censor: "[REDACTED]" },
    customLevels: undefined,
  });
  return asLogger(root);
}

function asLogger(p: pino.Logger): Logger {
  return {
    info: (obj, msg) => p.info(obj as pino.Bindings, msg),
    warn: (obj, msg) => p.warn(obj as pino.Bindings, msg),
    error: (obj, msg) => p.error(obj as pino.Bindings, msg),
    debug: (obj, msg) => p.debug(obj as pino.Bindings, msg),
    child: (bindings) => asLogger(p.child(bindings)),
  };
}

export function noopLogger(): Logger {
  const sink = () => {};
  return {
    info: sink,
    warn: sink,
    error: sink,
    debug: sink,
    child: () => noopLogger(),
  };
}

export function projectRoot(): string {
  // src/utils/logger.ts -> project root is ../../..
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..");
}
