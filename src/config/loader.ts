import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { z } from "zod";
import { appConfigSchema, effectiveMode, envSchema } from "./schema.js";
import type { AppConfig, AppEnv, Mode } from "./schema.js";
import { loadEnv, EnvProvider } from "../utils/env-file.js";

export interface LoadOpts {
  rootDir: string;
  configPath?: string;
  cliMode?: Mode;
}

export interface LoadedConfig {
  config: AppConfig;
  env: EnvProvider;
  envData: AppEnv;
  usedExample: boolean;
  mode: Mode;
  rootDir: string;
  configPath: string;
}

function failFastPrefix(e: z.ZodError): string {
  return e.issues
    .map((i) => `config${i.path.length ? " [" + i.path.join(".") + "]" : ""}: ${i.message}`)
    .join("; ");
}

/**
 * Fail-fast config loader: YAML (config/config.yaml) + .env + process.env.
 * Throws on unknown keys or invalid values — better to crash at boot than mid-trade.
 */
export function loadConfig(opts: LoadOpts): LoadedConfig {
  const { rootDir } = opts;
  const configPath = opts.configPath ?? path.join(rootDir, "config", "config.yaml");
  let usedExample = false;
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    raw = (YAML.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>) ?? {};
  } else {
    const examplePath = path.join(rootDir, "config", "config.example.yaml");
    if (fs.existsSync(examplePath)) {
      raw = (YAML.parse(fs.readFileSync(examplePath, "utf8")) as Record<string, unknown>) ?? {};
      usedExample = true;
    }
  }

  const { data: envRaw } = loadEnv(rootDir);
  const envParsed = envSchema.safeParse({ ...envRaw, ...process.env });
  if (!envParsed.success) {
    throw new Error(`invalid environment: ${failFastPrefix(envParsed.error)}`);
  }
  const envData = envParsed.data;

  const mode = effectiveMode(opts.cliMode, envData.MODE, (raw as { mode: Mode }).mode ?? "paper");
  const withMode = { ...raw, mode };
  const parsedApp = appConfigSchema.safeParse(withMode);
  if (!parsedApp.success) {
    throw new Error(`invalid config: ${failFastPrefix(parsedApp.error)}`);
  }
  const data = parsedApp.data;

  return {
    config: data,
    env: new EnvProvider({ ...envRaw, ...process.env }),
    envData,
    usedExample,
    mode,
    rootDir,
    configPath,
  };
}

/** Parse a full AppConfig from a raw object (used by tests/demo presets). */
export function parseConfigRaw(raw: unknown): AppConfig {
  const parsed = appConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid config: ${failFastPrefix(parsed.error)}`);
  }
  const data = parsed.data;
  if (data.mode === "live" && data.confirm_live !== true) {
    throw new Error(
      "config invalide : MODE=live exige confirm_live: true dans config.yaml (double-filet anti-accident)",
    );
  }
  return data;
}
