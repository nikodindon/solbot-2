/**
 * `npm run maxscalp` — loterie paper dédiée (DB data/maxscalp.sqlite, dashboard :4102).
 * Entrées 1$ à chaque découverte, ladders de take (x2) sans stop loss.
 */
import path from "node:path";
import { loadConfig } from "../config/loader.js";
import { projectRoot, initLogger } from "../utils/logger.js";
import { openDb, closeDb, type DB } from "../state/db.js";
import { migrate } from "../state/migrations.js";
import { tradeCount } from "../state/trades.js";
import { paperCashSet } from "../portfolio/portfolio.js";
import { MaxScalper, maxscalpDefaults } from "../gmgn/maxscalp.js";
import { DashboardServer } from "../dashboard/server.js";
import { buildState } from "../dashboard/state.js";
import { makeFeed } from "../gmgn/discovery.js";

export async function runMaxscalp(opts: { once?: boolean } = {}): Promise<void> {
  const root = projectRoot();
  initLogger(process.env["LOG_LEVEL"] ?? "info");
  const loaded = loadConfig({ rootDir: root });
  const cfg = loaded.config;

  const dbPath = path.join(root, "data", "maxscalp.sqlite");
  const db: DB = openDb({ path: dbPath });
  migrate(db);

  // portefeuille frais à MAXSCALP_INITIAL_USD (défaut 500) tant qu'aucun trade n'existe (re-boot idempotent)
  const initialUsd = Number(process.env["MAXSCALP_INITIAL_USD"] ?? "") || maxscalpDefaults().initialUsd;
  if (tradeCount(db) === 0) {
    paperCashSet(db, initialUsd);
  }

  const envGmgn = process.env["GMGN_API_KEY"] ?? null;
  // scalpeur sur l'API publique GeckoTerminal : le quota démo CG (10k appels/mois) bascule
  // sur api.coingecko.com qui finit par renvoyer error_code 10006 + data vide silencieusement.
  const feed = makeFeed(envGmgn, null);

  let dynUniverse: { mint: string; symbol: string }[] = [];
  const scalper = new MaxScalper({ db, cfg: maxscalpDefaults(initialUsd), feed, universeMutator: (tokens) => { dynUniverse = tokens; } });

  const dashCfg = { ...cfg, dashboard: { ...cfg.dashboard, port: 4102 } } as typeof cfg;
  Object.defineProperty(dashCfg.universe, "tokens", { get: () => dynUniverse, configurable: true });
  const dash = new DashboardServer({ db, cfg: dashCfg, mode: "maxscalp", rootDir: root, skipTokenCheck: true });
  dash.start();

  console.log(`MAXSCALP paper (feed ${feed.name}) — dashboard: ${dash.url()} — DB: ${dbPath}`);
  console.log(`Stop file: ${path.join(root, "data", "STOP_MAXSCALP")} — Ctrl+C pour couper proprement.\n`);

  let running = true;
  const shutdown = async (sig: string) => {
    console.log(`\n${sig} — arrêt...`);
    running = false;
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const log = initLogger(process.env["LOG_LEVEL"] ?? "info");
  // warmup: re-pricer 100% des positions via OHLCV AVANT que le churn ne tourne (anti marks fictifs)
  const priced = await scalper.repriceAll();
  log.info({ app: "maxscalp" }, `warmup: ${priced} position(s) re-pricée(s) via OHLCV`);
  const loop = async (): Promise<void> => {
    while (running) {
      try {
        for (const l of await scalper.tick()) {
          log.info({ app: "maxscalp" }, l);
        }
        dash.broadcast("state", buildState(db, dashCfg, "maxscalp"));
      } catch (err) {
        log.error({ app: "maxscalp" }, `tick KO: ${err instanceof Error ? err.stack : String(err)}`);
      }
      if (opts.once) {break;}
      await new Promise((r) => setTimeout(r, maxscalpDefaults().loopSec * 1_000));
    }
  };
  await loop();

  dash.stop();
  closeDb(db);
}
