import type { DB } from "../state/db.js";
import type { AppConfig } from "../config/schema.js";
import type { MarketFeed } from "../engine/engine.js";
import { insertTicks, upsertCandles, getTokenMeta, upsertTokenMeta, type Tick } from "../state/market.js";
import type { PriceApi } from "../jupiter/price.js";
import { SOL_MINT, USDC_MINT } from "../constants.js";

/** Mulberry32 — PRNG déterministe (seed fixe du config `demo.seed`). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY_MS = 86_400_000;
const TF_MS = 900_000; // 15m
/** avancée du temps virtuel par poll (⇒ 1 bougie 15m toutes les ~24 ticks de démo) */
const VIRTUAL_STEP_MS = 2_300_000;
/** retour du temps virtuel vers le présent : la démo simule un marché du passé récent */
const CANDLE_HISTORY_DAYS = 30;

const FALLBACK_PRICES: Record<string, number> = {
  [SOL_MINT]: 150,
  "JUPyiwrYJFUKUzgctMz2f8ahKkrgJqL86sBGDvCN": 0.9,
  "DezXAZ8z7PnrnRJjz3fXBi1tBnVijayaHnzB263": 0.000025,
};

/**
 * DemoFeed — marché synthétique zéro réseau : GBM déterministe (seed config), moves en
 * virtual-time accéléré (1 bougie 15m ≈ 24 ticks), ticks + bougies 15m écrits dans la DB
 * comme le ferait le Poller réel. USD de base immuable ; SOL légèrement corrélé.
 */
export class DemoFeed implements MarketFeed {
  private readonly rnd: () => number;
  private vNow: number;
  private readonly prices = new Map<string, number>();
  private readonly sigmaCandle: number;
  private seeded = false;

  constructor(
    private readonly db: DB,
    private readonly cfg: AppConfig,
    private readonly priceApi?: PriceApi,
  ) {
    this.rnd = mulberry32(this.cfg.demo.seed);
    this.sigmaCandle = this.cfg.demo.vol_daily / Math.sqrt(86_400_000 / TF_MS);
    this.vNow = Date.now() - CANDLE_HISTORY_DAYS * DAY_MS;
  }

  async pollOnce(_ts = Date.now()): Promise<{ ok: boolean; prices: Map<string, number>; error?: string }> {
    if (!this.seeded) {
      await this.seed();
    }
    // avancée du temps virtuel + GBM par actif (sol corrélé à 0.3)
    this.vNow += VIRTUAL_STEP_MS;
    this.vNow = Math.min(this.vNow, Date.now() - TF_MS); // jamais dans le futur (candle queries = now)
    const zSol = gauss(this.rnd) * 0.3;
    for (const symbol of this.prices.keys()) {
      const isSol = symbol === SOL_MINT;
      const z = gauss(this.rnd) + (isSol ? zSol * 0 : zSol);
      const cur = this.prices.get(symbol) ?? 1;
      const next = Math.max(cur * Math.exp(-this.sigmaCandle * this.sigmaCandle / 2 + this.sigmaCandle * z), symbol === USDC_MINT ? 1 : 1e-12);
      this.prices.set(symbol, next);
    }
    this.prices.set(USDC_MINT, 1);
    const ticks: Tick[] = [...this.prices].map(([mint, price]) => ({
      ts: this.vNow,
      mint,
      price,
      liquidity: null,
      volumeDelta: null,
    }));
    insertTicks(this.db, ticks);
    for (const mint of this.prices.keys()) {
      upsertCandles(this.db, "15m", this.vNow, ticks.filter((t) => t.mint === mint));
    }
    const out = new Map(this.prices);
    return { ok: true, prices: out };
  }

  /** Prices initiales : API Jupiter si dispo, sinon fallback documenté. */
  private async seed(): Promise<void> {
    const mints = [SOL_MINT, USDC_MINT, ...this.cfg.universe.tokens.map((t) => t.mint)];
    if (this.priceApi) {
      try {
        const rows = await this.priceApi.refresh(mints, { fresh: false });
        for (const m of mints) {
          const p = rows.get(m)?.usdPrice;
          if (p && p > 0) {this.prices.set(m, p);}
        }
      } catch {
        // zéro réseau garanti : fallback silencieux
      }
    }
    for (const m of mints) {
      if (!this.prices.has(m)) {
        const fb = FALLBACK_PRICES[m];
        if (fb) {this.prices.set(m, fb);}
      }
    }
    for (const t of this.cfg.universe.tokens) {
      if (!getTokenMeta(this.db, t.mint)) {
        upsertTokenMeta(this.db, { mint: t.mint, symbol: t.symbol, decimals: t.decimals, isVerified: true, liquidityUsd: null, poolCreatedMs: null }, this.vNow);
      }
    }
    this.prices.set(USDC_MINT, 1);
    this.seeded = true;
  }
}

/** Box-Muller (paire minimale, un z par appel). */
function gauss(rnd: () => number): number {
  const u = Math.max(rnd(), 1e-12);
  const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
