import path from "node:path";
import { loadConfig } from "../config/loader.js";
import { initLogger, projectRoot, type Logger } from "../utils/logger.js";
import { openDb, closeDb, type DB } from "../state/db.js";
import { migrate } from "../state/migrations.js";
import { buildStrategies } from "../strategy/registry.js";
import { RiskManager } from "../risk/risk-manager.js";
import { Executor } from "../execution/executor.js";
import { JupiterClient } from "../jupiter/client.js";
import { PriceApi } from "../jupiter/price.js";
import { SwapApi } from "../jupiter/swap.js";
import { Poller } from "../market/poller.js";
import { GeckoBackfiller, geckoDefaults } from "../market/gecko.js";
import { RpcClient } from "../solana/rpc.js";
import { EnvSigner } from "../wallet/signer.js";
import { DashboardServer } from "../dashboard/server.js";
import { buildState } from "../dashboard/state.js";
import { Engine, type MarketFeed } from "../engine/engine.js";
import { FundingWatcher } from "../engine/funding.js";
import { reconcileOnChain, priceHelpersFrom } from "../engine/reconcile.js";
import { insertDecision } from "../state/decisions.js";
import { keypairFromBase58 } from "../wallet/create.js";
import { SOL_MINT, USDC_MINT } from "../constants.js";

export interface StartOpts {
  rootDir?: string;
  demo?: boolean;
  once?: boolean; // un seul tick puis exit (dev/CI)
}

export interface Runtime {
  cfg: ReturnType<typeof loadConfig>["config"];
  mode: ReturnType<typeof loadConfig>["mode"];
  db: DB;
  engine: Engine;
  dashboard: DashboardServer;
  log: Logger;
  rootDir: string;
  feed: MarketFeed;
  rpc: RpcClient | null;
  shutdown: () => Promise<void>;
}

export async function createRuntime(opts: StartOpts = {}, log0?: Logger): Promise<Runtime> {
  const rootDir = opts.rootDir ?? projectRoot();
  const log = log0 ?? initLogger(process.env["LOG_LEVEL"]);
  const loaded = loadConfig({ rootDir });
  const { config: cfg, mode } = loaded;
  if (mode === "live" && !cfg.confirm_live) {
    throw new Error("MODE=live exige confirm_live: true (double filet)");
  }
  const db = openDb({ path: path.join(rootDir, cfg.database.path) });
  migrate(db);

  const jup = new JupiterClient({
    apiKey: process.env["JUPITER_API_KEY"] ?? null,
    retries: cfg.execution.retries,
  });
  const priceApi = new PriceApi(jup);
  const swapApi = new SwapApi(jup);
  const rpcUrl = process.env["SOLANA_RPC_URL"];
  const rpc = rpcUrl ? new RpcClient(rpcUrl) : null;

  const strategies = buildStrategies(cfg.strategies);
  const risk = new RiskManager(cfg.risk, {
    edgeMultiplier: cfg.costs.edge_multiplier,
    expectedSlippageBps: cfg.costs.expected_slippage_bps,
    paperFillSlippageBps: cfg.costs.paper_fill_slippage_bps,
  });
  const secret = process.env["BS58_PRIVATE_KEY"];
  const signer = mode === "paper" ? null : secret ? new EnvSigner(secret) : null;
  if (mode !== "paper" && !signer) {
    throw new Error(`${mode}: BS58_PRIVATE_KEY absente — lancer d'abord "init"`);
  }
  const executor = new Executor({ db, mode, cfg, swapApi, rpc, signer }, log);

  let feed: MarketFeed;
  if (opts.demo) {
    const { DemoFeed } = await import("../demo/feed.js");
    feed = new DemoFeed(db, cfg, priceApi);
  } else {
    feed = new Poller(db, priceApi, swapApi, {
      mints: [SOL_MINT, USDC_MINT, ...cfg.universe.tokens.map((t) => t.mint)],
    });
  }

  const dashboard = new DashboardServer({ db, cfg, mode, rootDir });
  const engine = new Engine(
    {
      db,
      cfg,
      mode,
      rootDir,
      feed,
      executor,
      risk,
      strategies: strategies.map((s) => ({ strategy: s.strategy, weight: s.weight })),
      log,
    },
    { onDecision: (d) => dashboard.broadcast("decision", d) },
  );

  const shutdown = async (): Promise<void> => {
    await dashboard.stop();
    closeDb(db);
  };

  return { cfg, mode, db, engine, dashboard, log, rootDir, feed, rpc, shutdown };
}

function hasCandles(rt: Runtime): boolean {
  // léger : au moins une bougie 15m pour le premier actif
  try {
    const rows = rt.db.prepare("SELECT COUNT(*) AS n FROM candles WHERE tf='15m'").get() as { n: number };
    return rows.n > 0;
  } catch {
    return false;
  }
}

async function prepareLive(rt: Runtime): Promise<void> {
  // garde live : backtest concluant (PLAN étape 12) exigé conjointement aux autres fichiers
  const { kvGetJson } = await import("../state/kv.js");
  const verdict = kvGetJson<{ ok: boolean; at: number } | null>(rt.db, "backtestVerdict", null);
  if (!verdict || verdict.ok !== true || Date.now() - verdict.at > 7 * 86_400_000) {
    throw new Error("live: backtest concluant requis (npm run backtest) sur les 7 derniers jours");
  }
  // backfill GeckoTerminal si historique trop court (uniquement hors demo)
  const gecko = new GeckoBackfiller(rt.db, { ...geckoDefaults(), apiKey: process.env["GECKO_API_KEY"] ?? null });
  for (const t of rt.cfg.universe.tokens) {
    try {
      const n = await gecko.backfillToken(t.mint, "15m", 30);
      rt.log.info({ symbol: t.symbol, candles: n }, "backfill GeckoTerminal");
    } catch (err) {
      rt.log.warn({ err: err instanceof Error ? err.message : String(err), symbol: t.symbol }, "backfill partiel");
    }
  }
  // financement attendu en live/dry-run
  if (rt.rpc) {
    const fwatch = new FundingWatcher({ rpc: rt.rpc }, rt.cfg.funding);
    await waitFunded(fwatch, rt.log);
    // réconciliation: les soldes RPC font foi au démarrage
    const secret = process.env["BS58_PRIVATE_KEY"];
    if (secret) {
      const { keypairFromBase58 } = await import("../wallet/create.js");
      const { pubkey } = keypairFromBase58(secret);
      const prices = await resolvePrices(rt);
      const helpers = priceHelpersFrom(
        prices.usd,
        prices.usd.get(SOL_MINT) ?? 0,
        (m) => {
          const meta = m === SOL_MINT ? "SOL" : rt.cfg.universe.tokens.find((t) => t.mint === m)?.symbol;
          return meta ?? m.slice(0, 4);
        },
        (m) => rt.cfg.universe.tokens.find((t) => t.mint === m)?.decimals ?? 9,
      );
      const lines = await reconcileOnChain(rt.db, rt.rpc, pubkey, helpers, rt.cfg);
      for (const l of lines) {
        insertDecision(rt.db, { tsMs: Date.now(), tickId: 0, kind: "info", line: `réconciliation: ${l.line}` });
        rt.log.info({ line: l.line }, "réconciliation");
      }
    }
  } else {
    throw new Error(`${rt.mode}: SOLANA_RPC_URL absente — indispensable hors paper`);
  }
}

async function resolvePrices(rt: Runtime): Promise<{ usd: Map<string, number> }> {
  const st = await rt.feed.pollOnce(Date.now());
  return { usd: st.prices };
}

async function waitFunded(fwatch: FundingWatcher, log: Logger): Promise<void> {
  const secret = process.env["BS58_PRIVATE_KEY"];
  const owner = secret ? keypairPubkeySafe(secret) : null;
  for (let i = 0; ; i++) {
    const priceOfSol = await priceOfSolForWatcher(fwatch);
    const st = await fwatch.status(owner, priceOfSol);
    if (st.funded) {
      log.info({ solUsd: Number(st.solUsd.toFixed(3)), usdcUsd: Number(st.usdcUsd.toFixed(2)) }, "wallet financé → démarrage");
      return;
    }
    if (i % 10 === 0) {
      log.info({ missing: st.missing }, "attente financement (30s entre ses essais)…");
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

function keypairPubkeySafe(secret: string): string | null {
  try {
    return keypairFromBase58(secret).pubkey;
  } catch {
    return null;
  }
}

async function priceOfSolForWatcher(fwatch: FundingWatcher): Promise<number> {
  void fwatch;
  try {
    const client = new JupiterClient({ apiKey: process.env["JUPITER_API_KEY"] ?? null, retries: 1 });
    const rows = await new PriceApi(client).refresh([SOL_MINT], { fresh: true });
    return rows.get(SOL_MINT)?.usdPrice ?? 150;
  } catch {
    return 150;
  }
}

export async function runStart(opts: StartOpts = {}): Promise<Runtime> {
  const rt = await createRuntime(opts);
  const { engine, dashboard, mode, cfg, log } = rt;
  log.info({ mode, demo: opts.demo === true }, "solbot2 démarre");

  await dashboard.start();
  log.info({ url: dashboard.url() }, "dashboard (lecture seule)");

  if (!opts.demo) {
    if (mode === "paper" && !hasCandles(rt)) {
      log.warn({}, "historique 15m absent — exécute `npm run backtest` ou `doctor` (le moteur tournera, régimes indisponibles tant que les bougies manquent)");
    }
    if (mode !== "paper") {
      await prepareLive(rt);
    }
  }

  let stopping = false;
  const tick = async (): Promise<void> => {
    if (engine.isBusy() || stopping) {return;}
    const report = await engine.runTick();
    dashboard.broadcast("state", buildState(rt.db, cfg, mode));
    if (!report.ok && report.error) {log.warn({ err: report.error }, "tick en erreur");}
  };

  process.on("SIGINT", () => {
    log.info({}, "SIGINT: arrêt propre");
    stopping = true;
  });
  process.on("SIGTERM", () => {
    log.info({}, "SIGTERM: arrêt propre");
    stopping = true;
  });

  await tick();
  if (opts.once) {
    await rt.shutdown();
    return rt;
  }
  const int = setInterval(() => {
    void tick().then(() => {
      if (stopping) {
        clearInterval(int);
        void rt.shutdown().then(() => process.exit(0)).catch(() => process.exit(0));
      }
    });
  }, cfg.loop_interval_s * 1000);
  return rt;
}
