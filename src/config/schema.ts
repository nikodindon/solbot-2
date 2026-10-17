import { z } from "zod";
import { SOL_MINT, USDC_MINT } from "../constants.js";

export const MODES = ["paper", "dry_run", "live"] as const;
export type Mode = (typeof MODES)[number];


export const universeSchema = z
  .object({
    tokens: z
      .array(
        z.object({
          mint: z.string().min(32),
          symbol: z.string().min(1).max(15),
          decimals: z.number().int().min(0).max(18),
        }),
      )
      .max(5)
      .default([
        { mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", symbol: "JUP", decimals: 6 },
        { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", symbol: "BONK", decimals: 5 },
      ]),
    min_liquidity_usd: z.number().positive().default(1_000_000),
    min_age_days: z.number().positive().default(30),
  })
  .strict();

export const momentumParams = z
  .object({
    ema_fast: z.number().int().min(2).max(200).default(9),
    ema_slow: z.number().int().min(3).max(400).default(21),
    rsi_period: z.number().int().min(2).max(200).default(14),
    rsi_entry: z.number().min(50).max(100).default(68),
    breakout_lookback: z.number().int().min(2).max(500).default(20),
    volume_lookback: z.number().int().min(2).max(500).default(20),
    volume_mult: z.number().min(1).max(20).default(1.5),
    atr_stop_mult: z.number().min(0.5).max(10).default(2),
  })
  .strict();

export const meanReversionParams = z
  .object({
    window: z.number().int().min(10).max(2000).default(96),
    z_entry: z.number().min(0.5).max(10).default(2.0),
    z_exit: z.number().min(-5).max(5).default(0.5),
  })
  .strict();

export const dcaRotationParams = z
  .object({
    target_sol: z.number().min(0).max(1).default(0.35),
    rebalance_bps: z.number().min(10).max(10000).default(250),
  })
  .strict();

export const strategySchema = z
  .object({
    momentum: z
      .object({
        enabled: z.boolean().default(true),
        weight: z.number().min(0).max(10).default(1),
        params: momentumParams.default({}),
      })
      .strict()
      .default({}),
    mean_reversion: z
      .object({
        enabled: z.boolean().default(true),
        weight: z.number().min(0).max(10).default(1),
        params: meanReversionParams.default({}),
      })
      .strict()
      .default({}),
    dca_rotation: z
      .object({
        enabled: z.boolean().default(true),
        weight: z.number().min(0).max(10).default(0.7),
        params: dcaRotationParams.default({}),
      })
      .strict()
      .default({}),
  })
  .strict();

export const riskSchema = z
  .object({
    min_trade_usd: z.number().min(0.1).max(25).default(1.5),
    max_trade_usd: z.number().min(0.5).max(10).default(3),
    hard_max_trade_usd: z.number().min(1).max(20).default(10),
    max_positions: z.number().int().min(1).max(5).default(2),
    max_position_pct: z.number().min(1).max(100).default(45),
    daily_loss_limit_pct: z.number().min(0.5).max(50).default(10),
    kill_switch_max_drawdown_pct: z.number().min(5).max(80).default(30),
    hard_max_total_loss_pct: z.number().min(10).max(90).default(50),
    stop_loss_pct: z.number().min(0.5).max(50).default(6),
    take_profit_pct: z.number().min(1).max(200).default(12),
    trailing_activation_pct: z.number().min(0.5).max(50).default(4),
    trailing_retrace_pct: z.number().min(0.1).max(50).default(2.5),
    cooldown_s: z.number().min(0).max(86400).default(180),
    gas_reserve_sol: z
      .number()
      .min(0)

      .max(0.006)
      .default(0.005),
    priority_fee_sol: z.number().min(0).max(0.001).default(0.00002),
    max_slippage_bps: z.number().min(10).max(1000).default(300),
    max_price_impact_bps: z.number().min(10).max(2000).default(100),
    ata_rent_horizon_trades: z.number().int().min(1).max(500).default(20),
  })
  .strict();

export const costsSchema = z
  .object({
    edge_multiplier: z.number().min(1).max(50).default(4),
    expected_slippage_bps: z.number().min(0).max(1000).default(15),
    paper_fill_slippage_bps: z.number().min(0).max(1000).default(10),
  })
  .strict();

export const executionSchema = z
  .object({
    retries: z.number().int().min(0).max(10).default(2),
    retry_backoff_ms: z.number().min(0).max(60_000).default(750),
    confirm_timeout_s: z.number().int().min(5).max(600).default(60),
  })
  .strict();

export const regimeSchema = z
  .object({
    vol_lookback: z.number().int().min(20).max(2000).default(96),
    high_vol_pctl: z.number().min(60).max(100).default(95),
    high_vol_floor_bps: z.number().min(1).max(1000).default(25),
    idle_vol_bps: z.number().min(0).max(1000).default(4),
    trend_atr_ratio: z.number().min(0.05).max(10).default(0.75),
  })
  .strict();

export const dashboardSchema = z
  .object({
    host: z.string().min(1).default("0.0.0.0"),
    port: z.number().int().min(1).max(65535).default(4100),
    stale_after_s: z.number().int().min(10).max(3600).default(120),
  })
  .strict();

export const shadowSchema = z
  .object({
    cash_usd: z.number().min(1).max(10_000).default(30),
    trade_usd: z.number().min(0.5).max(1_000).default(3),
    max_positions: z.number().int().min(1).max(5).default(4),
    min_samples: z.number().int().min(1).max(1000).default(8),
    amd_margin_usd: z.number().min(0).max(1000).default(0.5),
  })
  .strict();

export const fundingSchema = z
  .object({
    min_sol_usd: z.number().min(0).max(20).default(1),
    min_usdc_usd: z.number().min(0).max(50).default(5),
  })
  .strict();

export type FundingConfig = z.infer<typeof fundingSchema>;

export const backtestSchema = z
  .object({
    initial_usdc: z.number().min(1).max(100_000).default(6),
    guard_min_days: z.number().min(1).max(720).default(14),
    guard_require_positive_net_pnl: z.boolean().default(false),
  })
  .strict();

export const demoSchema = z
  .object({
    seed: z.number().int().default(42),
    vol_daily: z.number().min(0.001).max(5).default(0.05),
  })
  .strict();

export const appConfigSchema = z
  .object({
    mode: z.enum(MODES).default("paper"),
    confirm_live: z.boolean().default(false),
    loop_interval_s: z.number().int().min(5).max(3600).default(30),
    base_currency: z.enum(["USDC"]).default("USDC"),
    universe: universeSchema.default({}),
    strategies: strategySchema.default({}),
    risk: riskSchema.default({}),
    costs: costsSchema.default({}),
    execution: executionSchema.default({}),
    regime: regimeSchema.default({}),
    dashboard: dashboardSchema.default({}),
    shadow: shadowSchema.default({}),
    funding: fundingSchema.default({}),
    backtest: backtestSchema.default({}),
    demo: demoSchema.default({}),
    paper_initial_usdc: z.number().min(0).max(1_000_000).default(6),
    paper_initial_sol: z.number().min(0).max(100).default(0.05),
    database: z
      .object({ path: z.string().min(1).default("./data/solbot2.sqlite") })
      .strict()
      .default({ path: "./data/solbot2.sqlite" }),
  })
  .strict();

export type AppConfig = z.infer<typeof appConfigSchema>;
export type StrategyConfig = z.infer<typeof strategySchema>;
export type RiskConfig = z.infer<typeof riskSchema>;

export const envSchema = z
  .object({
    BS58_PRIVATE_KEY: z
      .string()
      .regex(/^[1-9A-HJ-NP-Za-km-z]{87,90}$/, "clé privée base58 invalide")
      .optional(),
    JUPITER_API_KEY: z.string().optional(),
    JUPITER_RPS: z
      .string()
      .regex(/^\d+(\.\d+)?$/, "doit être un nombre")
      .transform(Number)
      .refine((v) => v > 0 && v <= 200, "0 < JUPITER_RPS <= 200")
      .optional(),
    SOLANA_RPC_URL: z.string().url().optional(),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).optional(),
    DASHBOARD_TOKEN: z.string().optional(),
    GECKO_API_KEY: z.string().optional(),
    MODE: z.enum(MODES).optional(),
  })
  .passthrough();

export type AppEnv = z.infer<typeof envSchema>;

export const CORE_MINTS = [SOL_MINT, USDC_MINT] as const;

export interface ConfigError {
  detail: string;
}

/** Effective mode: CLI flag > env MODE > yaml mode > default paper. */
export function effectiveMode(
  cliMode: Mode | undefined,
  envMode: string | undefined,
  yamlMode: Mode,
): Mode {
  if (cliMode) {return cliMode;}
  if (envMode === "paper" || envMode === "dry_run" || envMode === "live") {return envMode;}
  return yamlMode;
}
