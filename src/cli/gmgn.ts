/**
 * `npm run gmgn` — scalper paper dédié (DB data/gmgn.sqlite, dashboard :4101).
 * Process séparé: ne touche jamais au livre du bot principal.
 */
import path from "node:path";
import { loadConfig } from "../config/loader.js";
import { projectRoot, initLogger } from "../utils/logger.js";
import { openDb, closeDb, type DB } from "../state/db.js";
import { migrate } from "../state/migrations.js";
import { Scalper, gmgnDefaults } from "../gmgn/scalper.js";
import { makeFeed } from "../gmgn/discovery.js";
import { DashboardServer } from "../dashboard/server.js";
import { buildState } from "../dashboard/state.js";

export async function runGmgn(opts: { once?: boolean } = {}): Promise<void> {
  const root = projectRoot();
  initLogger(process.env["LOG_LEVEL"] ?? "info");
  const loaded = loadConfig({ rootDir: root });
  const cfg = loaded.config;
  const cfgDash = cfg.dashboard;

  const dbPath = path.join(root, "data", "gmgn.sqlite");
  const db: DB = openDb({ path: dbPath });
  migrate(db);

  const envGmgn = process.env["GMGN_API_KEY"] ?? null;
  const envGecko = process.env["GECKO_API_KEY"] ?? process.env["COINGECKO_API_KEY"] ?? null;
  const feed = makeFeed(envGmgn, envGecko);

  // univers DYNAMIQUE rempli par la discovery, lu par le dashboard à chaque requête
  let dynUniverse: { mint: string; symbol: string }[] = [];
  const scalper = new Scalper({ db, cfg: gmgnDefaults(), feed, universeMutator: (tokens) => { dynUniverse = tokens; } });

  const dashCfg = { ...cfg, dashboard: { ...cfgDash, port: 4101 } } as typeof cfg;
  Object.defineProperty(dashCfg.universe, "tokens", { get: () => dynUniverse, configurable: true });
  const dash = new DashboardServer({ db, cfg: dashCfg, mode: "paper", rootDir: root, skipTokenCheck: true });
  dash.start();

  console.log(`GMGN scalper (feed ${feed.name}) — dashboard: ${dash.url()} — DB: ${dbPath}`);
  console.log(`Stop file: ${path.join(root, "data", "STOP")} — Ctrl+C pour couper proprement.\n`);

  let running = true;
  const shutdown = async (sig: string) => {
    console.log(`\n${sig} — arrêt...`);
    running = false;
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const log = initLogger(process.env["LOG_LEVEL"] ?? "info");

  const loop = async (): Promise<void> => {
    while (running) {
      try {
        for (const l of await scalper.tick()) {
          log.info({ app: "gmgn" }, l);
        }
        dash.broadcast("state", buildState(db, dashCfg, "paper"));
      } catch (err) {
        log.error({ app: "gmgn" }, `tick KO: ${err instanceof Error ? err.stack : String(err)}`);
      }
      if (opts.once) {break;}
      await new Promise((r) => setTimeout(r, gmgnDefaults().loopSec * 1_000));
    }
  };
  await loop();

  dash.stop();
  closeDb(db);
}
