#!/usr/bin/env node
import { Command } from "commander";
import pino from "pino";
import { loadEnv } from "./utils/env-file.js";
import { runInit } from "./cli/init.js";
import { runStart } from "./cli/start.js";
import { runDoctor } from "./cli/doctor.js";
import { runBalance } from "./cli/balance.js";
import { runBacktestCmd } from "./cli/backtest.js";
import { runGmgn } from "./cli/gmgn.js";
import { runMaxscalp } from "./cli/maxscalp.js";

// .env → process.env (process.env garde la priorité, standard dotenv)
const envLoaded = loadEnv(process.cwd());
for (const [k, v] of Object.entries(envLoaded.data)) {
  if (v !== undefined && process.env[k] === undefined) {
    (process.env as Record<string, string | undefined>)[k] = v;
  }
}

const log = pino({ level: process.env["LOG_LEVEL"] ?? "info", base: undefined });

const program = new Command();
program.name("solbot2").description("Spot trading bot Solana/Jupiter — micro-capital, sans web3.js pour l'exécution").version("2.0.0");

program
  .command("init")
  .description("crée le wallet (local) + .env chmod 600 + QR de financement")
  .option("--force-new-wallet", "génère une NOUVELLE clé (l'ancienne est écrasée)", false)
  .action(async (opts) => {
    const res = await runInit(process.cwd(), { forceNewWallet: opts.forceNewWallet === true });
    if (res.created) {
      console.log(`Wallet créé : ${res.pubkey}`);
      console.log("Financer avec ~1 SOL (frais + réserve) et ≥5 USDC, puis lancer `doctor` :");
      console.log(res.qr);
      console.log(`Secret stocké (chmod 600) : ${res.envPath}`);
    } else {
      console.log(`Wallet existant : ${res.pubkey} (${res.envPath})`);
    }
  });

program
  .command("start")
  .option("--demo", "marché synthétique zéro réseau (UI + moteur)", false)
  .option("--once", "un seul tick puis exit", false)
  .action(async (opts) => {
    await runStart({ demo: opts.demo === true, once: opts.once === true });
  });

program
  .command("demo")
  .description("npm run demo : start --demo sur la DB demo")
  .action(async () => {
    await runStart({ demo: true });
  });

program
  .command("doctor")
  .description("vérifie config/wallet/DB/RPC/Jupiter/univers avant un start réel")
  .action(async () => {
    const res = await runDoctor(process.cwd());
    for (const c of res.checks) {
      console.log(`${c.ok ? "✔" : "✘"} ${c.name.padEnd(16)} ${c.detail}`);
    }
    if (!res.ok) {process.exitCode = 1;}
  });

program
  .command("gmgn")
  .description("scalper paper dédié (discover + TP/SL rapides) — DB data/gmgn.sqlite, dashboard :4101")
  .option("--once", "un seul tick puis exit", false)
  .action(async (opts) => {
    await runGmgn({ once: opts.once === true });
  });

program
  .command("maxscalp")
  .description("loterie paper: 1$ sur tout le discovery, takes ladder à chaque x2, pas de SL — DB data/maxscalp.sqlite, dashboard :4102")
  .option("--once", "un seul tick puis exit", false)
  .action(async (opts) => {
    await runMaxscalp({ once: opts.once === true });
  });

program
  .command("backtest")
  .description("rejoue le moteur sur l'historique GTK 15m ; verdict pour la garde live")
  .option("--days <n>", "fenêtre de backfill en jours", "30")
  .action(async (opts) => {
    const out = await runBacktestCmd({ days: Number(opts.days) });
    console.log(out);
  });

program
  .command("balance")
  .description("soldes RPC honnêtes du wallet")
  .action(async () => {
    try {
      const rep = await runBalance();
      console.log(`wallet ${rep.pubkey}`);
      for (const l of rep.tokens) {
        console.log(`  ${l.asset.padEnd(6)} ${l.qty.toPrecision(8)} ${l.usd !== null ? `(${l.usd.toFixed(2)}$)` : "(pas de prix)"}`);
      }
      console.log(`SOL ${rep.solSol.toPrecision(8)} | USDC ${rep.usdcUsd.toFixed(2)}${rep.totalUsd !== null ? ` | total ≈ ${rep.totalUsd.toFixed(2)}$` : ""}`);
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv).catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
