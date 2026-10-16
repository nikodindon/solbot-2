import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/loader.js";
import { keypairFromBase58, shortAddress } from "../wallet/create.js";
import { openDb, closeDb } from "../state/db.js";
import { migrate, currentVersion } from "../state/migrations.js";
import { JupiterClient } from "../jupiter/client.js";
import { PriceApi } from "../jupiter/price.js";
import { SwapApi } from "../jupiter/swap.js";
import { RpcClient } from "../solana/rpc.js";
import { countCandles, getTokenMeta } from "../state/market.js";
import { tradeCount, costBreakdown, cumRealizedPnl } from "../state/trades.js";
import { paperCashGet } from "../portfolio/portfolio.js";
import { kvGetJson } from "../state/kv.js";
import { SOL_MINT, USDC_MINT, LAMPORTS_PER_SOL } from "../constants.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  ok: boolean;
  mode: string;
}

export interface DoctorDeps {
  rpc?: RpcClient | null;
}

/**
 * `doctor` : vérifie tout ce qui doit être prêt avant un start réel — config, clé, DB/migrations,
 * RPC (slot + soldes), Jupiter API (prix), univers Vérifié (liquidité/âge), historique OHLCV,
 * état du portefeuille. Ne modifie rien.
 */
export async function runDoctor(rootDir: string, deps: DoctorDeps = {}): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
  };

  // 1) config
  let cfg;
  try {
    const loaded = loadConfig({ rootDir });
    cfg = loaded.config;
    add("config", true, `mode=${loaded.mode}${loaded.usedExample ? " (config.example.yaml)" : ""} univers=${cfg.universe.tokens.map((t) => t.symbol).join(",")}`);
    if (loaded.mode === "live") {
      add("mode live", cfg.confirm_live === true, cfg.confirm_live ? "confirm_live=true (double-filet OK)" : "MODE=live exige confirm_live: true");
    }
  } catch (err) {
    add("config", false, String(err instanceof Error ? err.message : err));
    return { checks, ok: false, mode: "?" };
  }

  // 2) wallet (.env)
  let pubkey: string | null = null;
  const { EnvProvider } = await import("../utils/env-file.js");
  const { loadEnv } = await import("../utils/env-file.js");
  const env = new EnvProvider({ ...loadEnv(rootDir).data, ...process.env });
  const key = env.get("BS58_PRIVATE_KEY");
  if (!key) {
    add("wallet", true, "absente — OK en paper/demo (live exige BS58_PRIVATE_KEY)");
  } else {
    try {
      pubkey = keypairFromBase58(key).pubkey;
      add("wallet", true, `valide (${shortAddress(pubkey)})`);
    } catch (err) {
      add("wallet", false, err instanceof Error ? err.message : "invalide");
    }
  }

  // 3) DB + migrations
  const dbPath = path.join(rootDir, cfg.database.path);
  try {
    const db = openDb({ path: dbPath });
    migrate(db);
    add("sqlite", currentVersion(db) >= 1, `v${currentVersion(db)} (${path.basename(dbPath)})`);
    add("trades", true, `${tradeCount(db)} trades, PnL réalisé cumulé ${cumRealizedPnl(db).toFixed(4)}$, cash paper ${paperCashGet(db, cfg.paper_initial_usdc).toFixed(2)}$`);
    const tickCount = kvGetJson<number>(db, "tickCount", 0);
    add("ticks", tickCount >= 0, `${tickCount} ticks exécutés (allocation: ${kvGetJson<string | null>(db, "allocatedStrategy", null) ?? "aucune"})`);
    // candles 15m par actif
    const mints = [SOL_MINT, ...cfg.universe.tokens.map((t) => t.mint)];
    const counts = mints.map((m) => `${sym(m, cfg)}:${countCandles(db, m, "15m")}`);
    const minCandles = Math.min(...mints.map((m) => countCandles(db, m, "15m")));
    add("ohlcv", minCandles > 0, `candles 15m ${counts.join(" ")}`);
    const missingMeta = mints.filter((m) => m !== SOL_MINT && !getTokenMeta(db, m));
    if (missingMeta.length > 0) {
      add("token_meta", false, `metadonnées absentes: ${missingMeta.map((m) => sym(m, cfg)).join(",")} (requis au démarrage)`);
    } else {
      add("token_meta", true, "tous les actifs connus");
    }
    closeDb(db);
  } catch (err) {
    add("sqlite", false, err instanceof Error ? err.message : String(err));
  }

  // 4) Jupiter API
  let solPrice = 0;
  try {
    const client = new JupiterClient({ apiKey: process.env["JUPITER_API_KEY"] ?? null, retries: 1 });
    const priceApi = new PriceApi(client);
    const rows = await priceApi.refresh([SOL_MINT, USDC_MINT, ...cfg.universe.tokens.map((t) => t.mint)], { fresh: true });
    solPrice = rows.get(SOL_MINT)?.usdPrice ?? 0;
    add("jupiter prices", rows.size > 0, `${rows.size} prix récupéré${rows.size > 1 ? "s" : ""} (SOL ${solPrice.toFixed(2)}$)`);
  } catch (err) {
    add("jupiter prices", false, err instanceof Error ? err.message : String(err));
  }

  // 5) univers vérifié (metadata liquidité/âge)
  try {
    const client = new JupiterClient({ apiKey: process.env["JUPITER_API_KEY"] ?? null, retries: 1 });
    const swap = new SwapApi(client);
    const infos = await swap.tokenInfo(cfg.universe.tokens.map((t) => t.mint));
    const problems: string[] = [];
    for (const t of cfg.universe.tokens) {
      const i = infos.get(t.mint);
      if (!i) {
        problems.push(`${t.symbol}: introuvable`);
        continue;
      }
      const ageDays = i.poolCreatedMs ? Math.round((Date.now() - i.poolCreatedMs) / 86_400_000) : null;
      if ((i.liquidity ?? 0) < cfg.universe.min_liquidity_usd) {
        problems.push(`${t.symbol}: liquidité ${(i.liquidity ?? 0).toFixed(0)}$ < ${cfg.universe.min_liquidity_usd}`);
      }
      if (ageDays !== null && ageDays < cfg.universe.min_age_days) {
        problems.push(`${t.symbol}: âge ${ageDays}j < ${cfg.universe.min_age_days}j`);
      }
      if (!i.isVerified) {
        problems.push(`${t.symbol}: non vérifié`);
      }
    }
    add("universe", problems.length === 0, problems.length ? problems.join("; ") : `${cfg.universe.tokens.length} tokens vérifiés en ligne`);
  } catch (err) {
    add("universe", false, err instanceof Error ? err.message : String(err));
  }

  // 6) RPC
  const rpc = deps.rpc ?? (process.env["SOLANA_RPC_URL"] ? new RpcClient(process.env["SOLANA_RPC_URL"]) : new RpcClient(process.env["DEFAULT_RPC_URL_OVERRIDE"] ?? (await import("../constants.js")).DEFAULT_RPC_URL));
  try {
    const slot = await rpc.slot();
    if (pubkey) {
      const lamports = await rpc.getBalance(pubkey);
      const tokens = await rpc.tokenAccounts(pubkey);
      const usdc = tokens.find((t) => t.mint === USDC_MINT);
      const solUsd = (lamports / LAMPORTS_PER_SOL) * solPrice;
      const usdcAmt = usdc ? usdc.amount / Math.pow(10, usdc.decimals) : 0;
      const funded = solUsd > 0.5 && usdcAmt > 1;
      add("rpc", true, `slot ${slot} · SOL ${solUsd.toFixed(3)}$ · USDC ${usdcAmt.toFixed(2)}${funded ? "" : " — NON FINANCÉ (le start live attendra)"}`);
    } else {
      add("rpc", true, `slot ${slot} (pas de wallet à sonder)`);
    }
  } catch (err) {
    add("rpc", false, err instanceof Error ? err.message : String(err));
  }

  // 7) STOP fichier
  const stopPath = path.join(rootDir, "data", "STOP");
  add("stop-file", true, fs.existsSync(stopPath) ? "PRÉSENT — entrées bloquées" : "absent");

  const costs = (() => {
    try {
      const db = openDb({ path: dbPath });
      const c = costBreakdown(db);
      closeDb(db);
      return c;
    } catch {
      return null;
    }
  })();
  if (costs) {
    add("coûts cumulés", true, `Jupiter ${costs.jupFeeUsd.toFixed(4)}$, SOL ${costs.solFeeUsd.toFixed(4)}$, slippage réalisé ${costs.realizedSlippageUsd.toFixed(4)}$`);
  }

  return { checks, ok: checks.every((c) => c.ok), mode: "?" };
}

function sym(mint: string, cfg: { universe: { tokens: { mint: string; symbol: string }[] } }): string {
  if (mint === SOL_MINT) {return "SOL";}
  if (mint === USDC_MINT) {return "USDC";}
  return cfg.universe.tokens.find((t) => t.mint === mint)?.symbol ?? mint.slice(0, 4);
}
