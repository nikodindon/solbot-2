/**
 * MAXSCALP — scalpeur loterie paper, sans stop loss:
 *  - entrée 1$ sur TOUS les tokens détectés par la discovery (gecko new pools/min liq de fill)
 *  - quand la position double (mark ×2 contre la ref): 1er take = 1.2$ prélevés (cost + gain),
 *    puis laisser courir le reste (~0.8$) sans stop
 *  - ensuite à chaque nouveau ×2 du sol restant: take 20% du sol, ref recalée
 *  - pas de SL, pas de limite journalière — em portefeuille "loterie"
 * État d'échelle (ref coûts et takes par mint) persisté en kv "maxscalpLadder".
 */
import type { DB } from "../state/db.js";
import {
  addLot,
  getPosition,
  listPositions,
  reducePositionFifo,
  realizedPnlTotal,
} from "../state/portfolio-repo.js";
import type { Position } from "../state/portfolio-repo.js";
import { insertTrade } from "../state/trades.js";
import { insertDecision } from "../state/decisions.js";
import { insertEquity } from "../state/equity.js";
import { kvGetJson, kvSetJson } from "../state/kv.js";
import { paperCashGet, paperCashSet } from "../portfolio/portfolio.js";
import { simulateBuy, simulateSell } from "../execution/paper-broker.js";
import { insertTicks, upsertTokenMeta, latestTickAnyAge, latestDiscoveryTick, getTokenMeta, type Tick } from "../state/market.js";

type TickRowMap = Map<string, Tick>;
import type { DiscoveryFeed, Candidate } from "./discovery.js";
import fs from "node:fs";

export interface MaxScalpConfig {
  initialUsd: number;
  /** premier take: récupérer ce montant en $ (vs la position doublée) */
  firstTakeUsd: number;
  /** v11.1 kickoff: premier lot (takes 0) qui touche kickoffTakeX × refUsd → prélever kickoffTakePct du sol, ref basé sur value−kick */
  kickoffTakeX: number;
  kickoffTakePct: number;
  /** v11.2 anti-journée-pourrie: réalisé net (2h) ≤ ça OU série de ruggers (≥ badDayRugCount / 2h) avec < badDayLatchMin depuis le dernier → PAUSE des entrées (les sorties continuent) */
  badDayRealizedUsd: number;
  badDayLatchMin: number;
  badDayRugCount: number;
  /** v12 fenêtre de session: heure locale incluse / exclue d'entrées (1002 lots classés: 19-21h = 25-33% rug, 12-16h = 0-3%; vague du soir 21-22h récurrente). Sorties toujours permises. */
  entryBanStartHour: number;
  entryBanEndHour: number;
  /** ensuite: % du sol prélevé à chaque nouveau ×2 */
  ladderTakePct: number;
  minLiquidityUsd: number;
  /** v8→v10.2: plancher de volume 5 min à l'entrée. 30-50k "neutre" sur l'échantillon run 6 mais v10.1 live: 27 rug à −3.2$/lot → retour 50k (revisiter avec un échantillon live ≥ 2 d) */
  minVol5mUsd: number;
  /** anti-trap: jamais d'entrée sur un listing coté au-dessus de ce prix (stables / mauvais cotations) */
  maxPriceUsd: number;
  /** si (takés nuls et mark ≤ rugExitPct × entry) → dump complet du lot */
  rugExitPct: number;
  /** moon stop: lot déjà profité (takes ≥ 1) qui retombe à ≤ (1−moonStopDropPct) × peak → on prend tout le sol */
  moonStopDropPct: number;
  /** nombre max de lots simultanés partageant le même nom (variants Solcasino/TRUMP...) */
  maxLotsPerSymbol: number;
  /** sécurité: NAV au-dessus du trigger → USDT mis à l'abri */
  sweepTriggerUsd: number;
  sweepUsd: number;
  /** ref protection: token déjà intéragi vérouillé cooldown écoule pour re-buys */
  cooldownSec: number;
  /** churn idle exit: lot plus vieux que ça, plat, et sans volume → purge complète oldest-first */
  idleExitMinAgeMin: number;
  idleExitNoVolMin: number;
  idleExitPnlUsd: number;
  maxIdlePurgesPerTick: number;
  /** un sell n'existe que sur un prix de source < sellMarkFreshS (anti-fiction comptable) */
  sellMarkFreshS: number;
  /** purge "dead listing" au dernier prix connu si le mark est plus vieux que ça */
  deadLotMinAgeMin: number;
  /** pas de prix connu du tout → amorti à deadHaircutPct du coût d'entrée */
  deadHaircutPct: number;
  /** garde anti-fausse lune (v7): un prix de vente capé à maxEntryMultiple × prix d'entrée — au-delà, fiction de pool relancée */
  maxEntryMultiple: number;
  /** garde anti-fausse lune: un prix > maxCandleJump × dernier prix discovery (liquide) est une cote douteuse → on vend au prix discovery */
  maxCandleJump: number;
  /** v10.2 fake pump (STREAM): saut discovery en un tick sans bougie + gel → purge au dernier niveau légitime × haircut */
  fakePumpJump: number;
  fakePumpStallMs: number;
  fakePumpHaircut: number;
  loopSec: number;
  feeBps: number;
  slippageBps: number;
  maxPositions: number;
  /** lot de base pour la bande 50-100k$ de volume 5m */
  tradeUsd: number;
  /** v10 turbo: vol5m ≥ turboVol5mUsd → lot tradeUsdTurbo (la bande ≥100k$ est le seul signal fortement positif) */
  tradeUsdTurbo: number;
  turboVol5mUsd: number;
}

export function maxscalpDefaults(initialUsd = 500): MaxScalpConfig {
  return {
    initialUsd,
    tradeUsd: 3,
    firstTakeUsd: 1.2,
    /** v11.1: resserre le stop gagnant — un pic ×2 qui retombe ne doit pas redonner la moitié */
    moonStopDropPct: 0.35,
    kickoffTakeX: 1.4,
    kickoffTakePct: 0.25,
    badDayRealizedUsd: -8,
    badDayLatchMin: 60,
    badDayRugCount: 3,
    entryBanStartHour: 18,
    entryBanEndHour: 23,
    ladderTakePct: 0.2,
    minLiquidityUsd: 5_000,
    /** v11.2: bande turbo seule — le 50-100k a ruggé en bande à chaque fin de journée (run 7: 27 rugs −86$, run 8: 17 rugs −61$); le ≥100k: 0 rug sur 2 runs */
    minVol5mUsd: 100_000,
    maxPriceUsd: 0.05,
    rugExitPct: 0.6,
    maxLotsPerSymbol: 2,
    /** v11: sécurisation au-dessus de capital initial + 5 — le trigger porte sur le CAPITAL GARANTI (cash + réalisé net), jamais les marks flottants (run 7: 160$ swept pendant l'ère fake-marks) */
    sweepTriggerUsd: initialUsd + 5,
    sweepUsd: 5,
    cooldownSec: 60,
    /** churn: lot ≥ 30 min, plat (±0.08$), token sans volume (vu en discovery il y a ≥ 30 min) → purge */
    idleExitMinAgeMin: 30,
    idleExitNoVolMin: 30,
    idleExitPnlUsd: 0.08,
    maxIdlePurgesPerTick: 5,
    /** un sell (take/rug/moon/idle/recycle) n'existe que si le mark vient d'un prix de <5 min — sinon fiction comptable */
    sellMarkFreshS: 300,
    /** lot sans mark récent (vieux tick ≥ ça) → purge "dead listing" au dernier prix connu (ou haircut) */
    deadLotMinAgeMin: 60,
    /** pas de prix connu du tout → amorti à deadHaircutPct du coût d'entrée */
    deadHaircutPct: 0.5,
    /** v7: jamais de vente officielle au-dessus de 20× l'entrée (la loterie endormie ne crée pas de cash) */
    maxEntryMultiple: 20,
    /** v7: price > 4× dernier prix discovery (liquide) = pool relancé / cote mule → la vente se fait au prix discovery */
    maxCandleJump: 4,
    /** v10.2 fake pump (STREAM): discovery ×4+ en un tick sans bougie puis gelé 15 min = pool relancée → purge au niveau légitime × fakePumpHaircut */
    fakePumpJump: 4,
    fakePumpStallMs: 15 * 60_000,
    fakePumpHaircut: 0.5,
    loopSec: 15,
    /** v9: fee = LP pool réel (Raydium/Meteora ~25-60 bps) — l'ancien 200 bps "platform fee Jupiter" n'existe pas par défaut sur le router retail et doublait le péage de churn en fiction */
    feeBps: 45,
    slippageBps: 250,
    maxPositions: 40,
    /** v10 turbo: la bande ≥ 100k$ de volume 5m porte le lot gros (avg +1.18$/sym à l'échantillon) */
    tradeUsdTurbo: 5,
    turboVol5mUsd: 100_000,
  };
}

const STOP_FILE = "data/STOP_MAXSCALP";

export interface LadderState {
  refUsd: number;      // valeur de sol qui sert de repère au prochain ×2
  takes: number;       // nb de takes déjà faits
  entryCount: number;  // ust de re-buys sur le mint
  peakUsd?: number;    // pic de valeur du sol (pour le moon stop)
}

type LadderMap = Record<string, LadderState>;

export class MaxScalper {
  /** rate positions dont le mark vient d'être rafraîchi via OHLCV (feu tournant) */
  private markCursor = new Map<string, number>();

  constructor(
    private readonly deps: {
      db: DB;
      cfg: MaxScalpConfig;
      feed: DiscoveryFeed;
      universeMutator?: (tokens: { mint: string; symbol: string }[]) => void;
    },
  ) {}

  private get db() {return this.deps.db;}
  private get cfg() {return this.deps.cfg;}
  private get feed() {return this.deps.feed;}

  private cash(): number {return paperCashGet(this.db, this.cfg.initialUsd);}

  private ladder(): LadderMap {
    return kvGetJson<LadderMap>(this.db, "maxscalpLadder", {});
  }

  private seenAt(): Record<string, number> {
    return kvGetJson<Record<string, number>>(this.db, "maxscalpSeenAt", {});
  }

  /** zone d'exclusion: ticker exact d'un coin ruggé → les prochains listings au même ticker ne sont plus achetés */
  private rugTickers(): Record<string, number> {
    return kvGetJson<Record<string, number>>(this.db, "maxscalpRugTickers", {});
  }

  private blacklistRug(symbol: string): void {
    const map = this.rugTickers();
    map[symbol] = Date.now();
    kvSetJson(this.db, "maxscalpRugTickers", map);
    this.rec("signal", `EXCLUSION ZONE: ticker ${symbol} ruggé → les prochains coins au même ticker exact ne seront plus achetés`);
  }

  /**
   * churn idle exit: purge complète des lots vieux + plats + dont le token n'apparaît plus (aucun volume),
   * plus vieux d'abord. mode "slots": sert à libérer des places sous le cap maxPositions.
   * mode "cash": sert aussi à re-financer les entrées (ignoré le garde-fou de cap).
   */
  private async purgeIdle(candsOk: Candidate[], step: (l: string) => void, mode: "slots" | "cash" = "slots"): Promise<void> {
    const now = Date.now();
    const seen = this.seenAt();
    const candidates = new Set(candsOk.map((c) => c.mint));
    const ageMinMs = this.cfg.idleExitMinAgeMin * 60_000;
    const noVolMs = this.cfg.idleExitNoVolMin * 60_000;
    const freshLimitMs = this.cfg.sellMarkFreshS * 1_000;
    const deadMinMs = this.cfg.deadLotMinAgeMin * 60_000;
    const map = this.ladder();
    const positions = listPositions(this.db, true).sort((a, b) => a.openedMs - b.openedMs);
    if (mode === "slots" && positions.length < this.cfg.maxPositions) {return;} // slots en surplus → rien à faire
    let purged = 0;
    for (const pos of positions) {
      if (purged >= this.cfg.maxIdlePurgesPerTick) {break;}
      if (candidates.has(pos.mint)) {continue;} // encore actif en discovery
      const seenTs = seen[pos.mint] ?? pos.openedMs;
      if (now - seenTs < noVolMs) {continue;} // volume récent
      const ageMs = now - pos.openedMs;
      if (ageMs < ageMinMs) {continue;}
      const st = map[pos.mint];
      if (!st) {continue;}
      const { price, ageMs: markAgeMs, src: markSrc } = this.priceWithAge(pos.mint, pos.avgEntryUsd);
      const value = pos.qty * price;
      const pnl = value - pos.qty * pos.avgEntryUsd;
      if (markAgeMs <= freshLimitMs) {
        // mark frais → lot plat → idle exit normal au prix réel
        if (Math.abs(pnl) > this.cfg.idleExitPnlUsd) {continue;}
        this.rec("trade", `${pos.symbol}: IDLE EXIT — lot plat (pnl ${pnl.toFixed(3)}$), âge ${(ageMs / 60_000).toFixed(0)} min, sans volume depuis ${((now - seenTs) / 60_000).toFixed(0)} min → purge pour churmer`);
        if (await this.partialSell(pos, price, 1, st, "idle exit", { ageMs: markAgeMs, src: markSrc })) {
          delete map[pos.mint];
          kvSetJson(this.db, "maxscalpLadder", map);
          purged += 1;
        }
        continue;
      }
      // dead listing: pas de prix frais → purge au dernier prix connu (ou haircut), JAMAIS au prix d'entrée
      if (ageMs < deadMinMs) {continue;}
      if (markAgeMs === Number.POSITIVE_INFINITY) {
        const dead = pos.avgEntryUsd * this.cfg.deadHaircutPct;
        this.rec("trade", `${pos.symbol}: DEAD EXIT — aucun prix connu, lot amorti à −${((1 - this.cfg.deadHaircutPct) * 100).toFixed(0)}% (mark haircuted)`);
        if (await this.partialSell(pos, dead, 1, st, "dead exit", { allowStale: true, src: markSrc })) {
          delete map[pos.mint];
          kvSetJson(this.db, "maxscalpLadder", map);
          purged += 1;
        }
        continue;
      }
      this.rec("trade", `${pos.symbol}: DEAD EXIT — dernier prix connu (${((markAgeMs / 60_000) | 0)} min), purge au mark`);
      if (await this.partialSell(pos, price, 1, st, "dead exit", { allowStale: true, src: markSrc })) {
        delete map[pos.mint];
        kvSetJson(this.db, "maxscalpLadder", map);
        purged += 1;
      }
    }
    if (purged > 0) {step(`churn: ${purged} lot(s) purgé(s) (idle/dead), slots libérés`);}
  }

  /**
   * v9: grand nettoyage one-shot — liquide tous les lots ouverts avant `beforeMs` (marés
   * hérités d'une config antérieure), au mark frais si le marché permet la vente, sinon au
   * dernier prix connu / haircut (même discipline que dead exit). Retourne le nb de lots vendus.
   */
  async purgeLegacy(beforeMs: number): Promise<number> {
    const map = this.ladder();
    const freshLimitMs = this.cfg.sellMarkFreshS * 1_000;
    const positions = listPositions(this.db, true).filter((p) => p.openedMs < beforeMs).sort((a, b) => a.openedMs - b.openedMs);
    let sold = 0;
    for (const pos of positions) {
      const st: LadderState = map[pos.mint] ?? { refUsd: pos.qty * pos.avgEntryUsd * 2, takes: 0, entryCount: 1 };
      const { price, ageMs: markAgeMs, src: markSrc } = this.priceWithAge(pos.mint, pos.avgEntryUsd);
      if (markAgeMs <= freshLimitMs) {
        await this.partialSell(pos, price, 1, st, "purge legacy v9", { ageMs: markAgeMs, src: markSrc });
      } else if (markAgeMs !== Number.POSITIVE_INFINITY) {
        await this.partialSell(pos, price, 1, st, "purge legacy v9 (dead)", { allowStale: true, src: markSrc });
      } else {
        const dead = pos.avgEntryUsd * this.cfg.deadHaircutPct;
        await this.partialSell(pos, dead, 1, st, "purge legacy v9 (haircut)", { allowStale: true, src: markSrc });
      }
      delete map[pos.mint];
      kvSetJson(this.db, "maxscalpLadder", map);
      sold += 1;
    }
    return sold;
  }

  private rec(kind: "info" | "signal" | "reject" | "trade" | "kill" | "error", line: string, data?: Record<string, unknown>): void {
    insertDecision(this.db, { tsMs: Date.now(), tickId: 0, kind, strategy: "maxscalp", line: `${kind}: ${line}`, data });
  }

  private stopNow(): boolean {return fs.existsSync(STOP_FILE);}

  /** feu tournant: pour les positions dont le mark stagne > 2 min, recharge une OHLCV 1m via le feed (max N/tick). */
  private async rotateMarks(tickRows: TickRowMap, now: number): Promise<void> {
    const oldestNow = listPositions(this.db, true)
      .filter((p) => {
        const row = tickRows.get(p.mint);
        return !row || now - row.ts > 120_000;
      })
      .sort((a, b) => (this.markCursor.get(a.mint) ?? 0) - (this.markCursor.get(b.mint) ?? 0))
      // budget: le feed gecko public ne laisse passer qu'une requête par fenêtre — 2 bougies/tick, pas plus
      .slice(0, 2);
    for (const p of oldestNow) {
      try {
        const bar = await this.feed.latestCandle(p.mint);
        if (bar && bar.close > 0) {
          tickRows.set(p.mint, { ts: now, mint: p.mint, price: bar.close, liquidity: null, volumeDelta: bar.volumeUsd, src: "candle" });
          const ladder = this.ladder();
          const st = ladder[p.mint];
          if (st) {
            const value = p.qty * bar.close;
            st.peakUsd = Math.max(st.peakUsd ?? value, value);
            if (st.takes >= 1 && value <= st.peakUsd * (1 - this.cfg.moonStopDropPct)) {
              this.rec("trade", `${p.symbol}: MOON STOP (rotate) — purge du sol`);
              await this.partialSell(p, bar.close, 1, st, "moon stop (rotate)", { ageMs: 0, src: "candle" });
              delete ladder[p.mint];
              kvSetJson(this.db, "maxscalpLadder", ladder);
            } else if (st.takes === 0 && bar.close <= p.avgEntryUsd * this.cfg.rugExitPct) {
              this.rec("trade", `${p.symbol}: RUG EXIT (rotate) — purge du lot`);
              await this.partialSell(p, bar.close, 1, st, "rug exit (rotate)", { ageMs: 0, src: "candle" });
              delete ladder[p.mint];
              kvSetJson(this.db, "maxscalpLadder", ladder);
              this.blacklistRug(p.symbol);
            } else if (st.takes === 0 && value >= this.cfg.kickoffTakeX * st.refUsd) {
              // v11.1 kickoff: premier frôlement ×1.4 → prélever 25% du sol (couverture rug précoce), sol courir sans SL
              const takeUsd = value * this.cfg.kickoffTakePct;
              if (await this.partialSell(p, bar.close, this.cfg.kickoffTakePct, st, undefined, { ageMs: 0, src: "candle" })) {
                st.refUsd = value - takeUsd;
                st.takes += 1;
                kvSetJson(this.db, "maxscalpLadder", ladder);
              }
            } else if (value >= 2 * st.refUsd) {
              const takeUsd = st.takes === 0 ? this.cfg.firstTakeUsd : value * this.cfg.ladderTakePct;
              const takePct = Math.min(0.9, takeUsd / value);
              if (takePct > 0) {
                if (await this.partialSell(p, bar.close, takePct, st, undefined, { ageMs: 0, src: "candle" })) {
                  st.refUsd = value - takeUsd;
                  st.takes += 1;
                  kvSetJson(this.db, "maxscalpLadder", ladder);
                }
              }
            }
          }
        }
      } catch {
        // rate limit gecko / pool absente — retenter au prochain tour
      }
      this.markCursor.set(p.mint, now);
    }
  }

  private priceOf(mint: string, fallback: number): number {
    return this.priceWithAge(mint, fallback).price;
  }

  /**
   * v10.2 — garde anti fake-pump: STREAM a sauté ×37 en UN tick discovery à 10:02 puis est resté
   * gelé au millième pendant 1h (pool relancée par son dev — le mark frais ré-émis à chaque refresh
   * désamorce le churn "dead listing" qui gère déjà les baisses). Un vrai pump = escalade multi-ticks;
   * un relancement = un saut vertical suivi d'un plateau gelé, sans bougie OHLCV qui confirme.
   * openedMs: si la pool qui cote désormais le mint a été CRÉÉE APRÈS l'ouverture de la position,
   * le market d'entrée n'existe plus → purge même si une bougie "confirme" (elle est la bougie de
   * la pool relancée — v10.2bis, STREAM au boot: repriceAll a écrit la bougie du nouveau pool et le
   * moon stop a liquidé au clamp entry×20 = +90$ de cash fiction, trade id 82).
   * Retourne le dernier niveau légitime d'avant-jump si purge, sinon null.
   */
  private async fakePumpCheck(mint: string, openedMs: number): Promise<number | null> {
    const rows = this.db
      .prepare("SELECT ts_ms, price_usd, src FROM price_ticks WHERE mint = ? ORDER BY ts_ms DESC LIMIT 32")
      .all(mint) as { ts_ms: number; price_usd: number; src: string }[];
    if (rows.length < 2) {return null;}
    const top = rows[0]!.price_usd;
    // régime légitime = la ligne la plus RÉCENTE sous top/fakePumpJump (des bougies intermédiaires
    // de la pool relancée à ±quelques % du top ne cassent plus la structure: STREAM mark 7.36e-3,
    // bougie repriceAll 7.35e-3, legit 1.98e-4)
    let legitIdx = -1;
    for (let i = 1; i < rows.length; i += 1) {
      if (rows[i]!.price_usd < top / this.cfg.fakePumpJump) {legitIdx = i; break;}
    }
    if (legitIdx === -1) {return null;}
    const legit = rows[legitIdx]!.price_usd;
    if (!(legit > 0)) {return null;}
    // jumpStart = la ligne juste après le régime légitime (le tick le plus récent au-dessus du régime)
    const jumpStart = rows[legitIdx - 1]!.ts_ms;
    if (Date.now() - jumpStart < this.cfg.fakePumpStallMs) {return null;}
    // une bougie OHLCV d'une pool qui existait AVANT l'entrée confirme un vrai marché. Une pool
    // née APRÈS = relancement: sa bougie ne prouve rien. Détecte via token_meta (actualisé quand
    // le mint passe dans la discovery) puis, si besoin, par la probe gecko tokenPools.
    const confirm = this.db
      .prepare("SELECT 1 AS x FROM price_ticks WHERE mint = ? AND src = 'candle' AND ts_ms > ? LIMIT 1")
      .get(mint, jumpStart);
    if (!confirm) {return legit;}
    const meta = getTokenMeta(this.db, mint);
    if (meta !== null && meta.poolCreatedMs !== null && meta.poolCreatedMs > openedMs + 300_000) {return legit;}
    if (typeof this.feed.tokenPools === "function") {
      const pools = await this.feed.tokenPools(mint);
      if (pools.some((t) => t > openedMs + 300_000)) {return legit;}   // pool relancée prouvée
    }
    return null;
  }

  /**
   * Prix + ancienneté de sa source: snapshot discovery (frais, âge 0) → dernier tick connu en DB
   * (âge = now − ts) → fallback prix d'entrée (âge ∞ = fiction, jamais vendable).
   */
  private priceWithAge(mint: string, fallback: number): { price: number; ageMs: number; src?: "discovery" | "candle" } {
    const snap = this.feed.snapshotPrice(mint);
    if (snap && snap > 0) {return { price: snap, ageMs: 0, src: "discovery" };}
    const tick = latestTickAnyAge(this.db, mint);
    if (tick && tick.price > 0) {
      let price = tick.price;
      let ageMs = Date.now() - tick.tsMs;
      // v7: candle seule face à la discovery → méfiance (réf au dernier liquide connu)
      const disc = latestDiscoveryTick(this.db, mint);
      if (tick.src === "candle" && disc && disc.price > 0 && price > disc.price * this.cfg.maxCandleJump) {
        price = disc.price;
        ageMs = Date.now() - disc.tsMs;
      }
      // v7: clamp dur — le papier ignore la fiction au-delà de maxEntryMultiple × entry
      if (fallback > 0 && price > fallback * this.cfg.maxEntryMultiple) {
        price = fallback * this.cfg.maxEntryMultiple;
      }
      return { price, ageMs, src: tick.src ?? "discovery" };
    }
    return { price: fallback, ageMs: Number.POSITIVE_INFINITY };
  }

  /**
   * v7 — garde anti-fausse lune: NIVRA (pool relancé par son dev) cotait ×5225 l'entrée sur l'OHLCV
   * et le ladder "réalisait" ~2300$ de fiction en cash. Règles KNOWN:
   *  1) prix d'origine candle (OHLCV pool) > maxCandleJump × dernier prix discovery (liquide)
   *     → cote mule douteuse → on vend au dernier prix discovery;
   *  2) clamp dur TOUTES ventes: prix > maxEntryMultiple × entry → cap (le papier ignore les
   *     gains incolores au-delà — la loterie endormie ne crée pas de cash).
   */
  private sellPriceGuard(pos: Position, price: number, src?: "discovery" | "candle"): { price: number; note?: string } {
    let out = price;
    let note: string | undefined;
    if (src === "candle") {
      const disc = latestDiscoveryTick(this.db, pos.mint);
      if (disc && disc.price > 0 && out > disc.price * this.cfg.maxCandleJump) {
        note = `clamp candle ×${(price / disc.price).toFixed(1)} → prix discovery ${disc.price.toExponential(2)}`;
        out = disc.price;
      }
    }
    const capEntry = pos.avgEntryUsd * this.cfg.maxEntryMultiple;
    if (out > capEntry) {
      out = capEntry;
      note = `clamp entry×${this.cfg.maxEntryMultiple} (${out.toExponential(2)})`;
    }
    return { price: out, note };
  }

  /** réchauffe au boot: re-pricer 100% des positions via OHLCV avant que le churn ne tourne (!= feu tournant 5/tick) */
  async repriceAll(): Promise<number> {
    const now = Date.now();
    const rows: Tick[] = [];
    for (const p of listPositions(this.db, true)) {
      try {
        const bar = await this.feed.latestCandle(p.mint);
        if (bar && bar.close > 0) {
          rows.push({ ts: now, mint: p.mint, price: bar.close, liquidity: null, volumeDelta: bar.volumeUsd ?? null, src: "candle" });
          this.markCursor.set(p.mint, now);
        }
      } catch {
        // rate limit gecko / pool absente — le feu tournant retentera
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    if (rows.length > 0) {insertTicks(this.db, rows);}
    if (rows.length > 0) {this.rec("info", `warmup: ${rows.length} position(s) re-pricée(s) via OHLCV au boot`);}
    return rows.length;
  }

  /** un cycle: discovery → ladder/feed (takes) → entrées 1$ → equity. */
  async tick(): Promise<string[]> {
    const lines: string[] = [];
    const step = (l: string) => {lines.push(l);};

    if (this.stopNow()) {
      this.rec("kill", `STOP file (${STOP_FILE}) — plus d'entrées`);
      step(`STOP file — plus d'entrées`);
      return lines;
    }

    // === 1) discovery ===
    let cands: Candidate[] = [];
    try {
      cands = await this.feed.refresh();
    } catch (err) {
      this.rec("error", `discovery KO: ${err instanceof Error ? err.message : String(err)}`);
      step("discovery KO");
    }
    const candsOk = cands.filter(
      (c) => c.liquidityUsd >= this.cfg.minLiquidityUsd
        && c.vol5mUsd >= this.cfg.minVol5mUsd
        && c.priceUsd > 0
        && c.priceUsd <= this.cfg.maxPriceUsd,
    );
    this.deps.universeMutator?.(candsOk.map((c) => ({ mint: c.mint, symbol: c.symbol })));
    step(`discovery: ${cands.length} candidats, ${candsOk.length} entrables`);

    // === 1b) dashboard: ticks + meta ===
    const now = Date.now();
    const tickRows: TickRowMap = new Map();
    for (const c of cands.slice(0, 12)) {
      if (c.priceUsd > 0) {tickRows.set(c.mint, { ts: now, mint: c.mint, price: c.priceUsd, liquidity: c.liquidityUsd, volumeDelta: c.vol5mUsd, src: "discovery" });}
    }
    // positions ouvertes: garder un mark courant même si le token a tourné hors de la discovery.
    // 1) hop du cache feed (gratuit); 2) feu tournant OHLCV (markPositionsPerTick positions les plus anciennes)
    for (const p of listPositions(this.db, true)) {
      const mark = this.feed.snapshotPrice(p.mint);
      if (mark && mark > 0) {
        const prev = tickRows.get(p.mint);
        if (!prev || prev.price !== mark) {tickRows.set(p.mint, { ts: now, mint: p.mint, price: mark, liquidity: null, volumeDelta: null, src: "discovery" });}
      }
    }
    await this.rotateMarks(tickRows, now);
    insertTicks(this.db, [...tickRows.values()]);
    for (const c of cands.slice(0, 12)) {
      upsertTokenMeta(this.db, { mint: c.mint, symbol: c.symbol, decimals: 6, isVerified: null, liquidityUsd: c.liquidityUsd, poolCreatedMs: c.createdMs || null }, now);
    }

    // === 2) ladder: takes sur ×2 + rug exit + moon stop (lots pas encore profitables) ===
    const map = this.ladder();
    const freshLimitMs = this.cfg.sellMarkFreshS * 1_000;
    for (const pos of listPositions(this.db, true)) {
      const { price, ageMs: markAgeMs, src: markSrc } = this.priceWithAge(pos.mint, pos.avgEntryUsd);
      const fresh = markAgeMs <= freshLimitMs;
      const value = pos.qty * price;
      let st = map[pos.mint];
      if (!st) {
        st = { refUsd: pos.qty * pos.avgEntryUsd, takes: 0, entryCount: 1, peakUsd: value };
        map[pos.mint] = st;
      }
      // v10.2 fake pump: priorité absolue — saut discovery ≥ fakePumpJump sans bougie + gel ≥ fakePumpStallMs
      // → purge au dernier niveau légitime × haircut (le NAV courant est compté sur une fiction)
      const fakeLegit = await this.fakePumpCheck(pos.mint, pos.openedMs);
      if (fakeLegit !== null) {
        const purgePrice = fakeLegit * this.cfg.fakePumpHaircut;
        this.rec("trade", `${pos.symbol}: FAKE PUMP PURGE — discovery sauté ×${(price / fakeLegit).toFixed(0)} en un tick sans bougie puis gelé ≥${Math.round(this.cfg.fakePumpStallMs / 60_000)} min → purge au niveau légitime ${fakeLegit.toExponential(2)} ×${this.cfg.fakePumpHaircut} = ${purgePrice.toExponential(2)}`);
        if (await this.partialSell(pos, purgePrice, 1, st, "fake pump purge", { allowStale: true, src: "discovery" })) {
          delete map[pos.mint];
          kvSetJson(this.db, "maxscalpLadder", map);
          this.blacklistRug(pos.symbol);
          continue;
        }
      }
      // moon stop: lot déjà profité (takes ≥ 1) qui retombe depuis son peak → prendre tout le sol
      st.peakUsd = Math.max(st.peakUsd ?? value, value);
      if (fresh && st.takes >= 1 && value <= st.peakUsd * (1 - this.cfg.moonStopDropPct)) {
        this.rec("trade", `${pos.symbol}: MOON STOP — peak ${(st.peakUsd ?? 0).toFixed(2)}$, sol retombé à ${value.toFixed(2)}$, maj à +${(st.peakUsd ? (st.peakUsd / (pos.qty * pos.avgEntryUsd)) : 1).toFixed(1)}×, purge du sol`);
        if (await this.partialSell(pos, price, 1, st, "moon stop", { ageMs: markAgeMs, src: markSrc })) {
          delete map[pos.mint];
          kvSetJson(this.db, "maxscalpLadder", map);
          continue;
        }
      }
      // rug exit: lot jamais profitable et mark effondré ≤ rugExitPct × entrée → purge (sauver ce qui reste)
      if (fresh && st.takes === 0 && price <= pos.avgEntryUsd * this.cfg.rugExitPct) {
        this.rec("trade", `${pos.symbol}: RUG EXIT — mark ≤ ${(this.cfg.rugExitPct * 100).toFixed(0)}% entrée, purge du lot`);
        if (await this.partialSell(pos, price, 1, st, "rug exit", { ageMs: markAgeMs, src: markSrc })) {
          delete map[pos.mint];
          kvSetJson(this.db, "maxscalpLadder", map);
          this.blacklistRug(pos.symbol);
          continue;
        }
      }
      if (fresh && st.takes === 0 && value >= this.cfg.kickoffTakeX * st.refUsd) {
        // v11.1 kickoff: premier frôlement ×1.4 → prélever 25% du sol (couverture rug précoce), sol courir sans SL
        const takeUsd = value * this.cfg.kickoffTakePct;
        if (await this.partialSell(pos, price, this.cfg.kickoffTakePct, st, undefined, { ageMs: markAgeMs, src: markSrc })) {
          st.refUsd = value - takeUsd;
          st.takes += 1;
          step(`KICKOFF ${pos.symbol} — ${(takeUsd).toFixed(2)}$ prélevés à ×${(value / (pos.qty * pos.avgEntryUsd)).toFixed(1)}, sol courir sans stop`);
        }
      } else if (fresh && value >= 2 * st.refUsd) {
        const takeUsd = st.takes === 0 ? this.cfg.firstTakeUsd : value * this.cfg.ladderTakePct;
        const takePct = Math.min(0.9, takeUsd / value);
        if (takePct > 0) {
          if (await this.partialSell(pos, price, takePct, st, undefined, { ageMs: markAgeMs, src: markSrc })) {
            st.refUsd = value - takeUsd;
            st.takes += 1;
            step(`TAKE ${pos.symbol} ×${st.takes} — ${takeUsd.toFixed(2)}$ prélevés, sol courir sans stop`);
          }
        }
      }
    }
    kvSetJson(this.db, "maxscalpLadder", map);

    // === 2b) churn: purge des lots idle (vieux + plats + sans volume) pour libérer des slots ===
    await this.purgeIdle(candsOk, step);

    // === 2c) sécurisation v11: CAPITAL GARANTI (cash + réalisé net — JAMAIS les marks flottants:
    // run 7 a swept 160$ sur des NAV plâtrés de marks gelés-faux) > trigger → sweep USDT hors du wallet
    const navNow = this.cash() + listPositions(this.db, true).reduce((a, p) => a + p.qty * this.priceOf(p.mint, p.avgEntryUsd), 0);
    const capital = this.cash() + Math.max(0, realizedPnlTotal(this.db));
    if (capital > this.cfg.sweepTriggerUsd) {
      const sweptBefore = kvGetJson<number>(this.db, "maxscalpSweptUsd", 0);
      const swept = sweptBefore + this.cfg.sweepUsd;
      kvSetJson(this.db, "maxscalpSweptUsd", swept);
      paperCashSet(this.db, this.cash() - this.cfg.sweepUsd);
      this.rec("trade", `SECURISE: capital garanti ${capital.toFixed(2)}$ (cash ${this.cash().toFixed(2)}$ + réalisé net) > ${this.cfg.sweepTriggerUsd}$ — NAV papier ${navNow.toFixed(2)}$ → ${this.cfg.sweepUsd}$ USDT mis à l'abri, total secure ${swept.toFixed(2)}$`);
      step(`SECURISE ${this.cfg.sweepUsd}$ USDT (total secure ${swept.toFixed(2)}$)`);
    }

    // === 3) entrées sur tout candidat — v11.2: bande turbo seule (100k$) ===
    // v12 fenêtre de session: PAS de nouvelles entrées pendant la fenêtre de session (18h-23h local
    // par défaut). Le bilan 1002 lots classés: entrées 19-21h = 25-33% de ruggers, 12-16h = 0-3%;
    // les vagues rug (9-10h, 21-22h) répondent à l'HEURE, pas à la bande (4 rugs turbo le matin, run 8
    // turbo-only v11.2). Les sorties / churn / moon stops / sweep continuent toujours.
    const localHour = new Date(now).getHours();
    // start === end → fenêtre désactivée (défaut des tests)
    const inBan =
      this.cfg.entryBanStartHour === this.cfg.entryBanEndHour
        ? false
        : this.cfg.entryBanStartHour <= this.cfg.entryBanEndHour
          ? localHour >= this.cfg.entryBanStartHour && localHour < this.cfg.entryBanEndHour
          : localHour >= this.cfg.entryBanStartHour || localHour < this.cfg.entryBanEndHour;
    if (inBan) {
      this.rec("info", `SESSION: ${localHour}h dans fenêtre bannie [${this.cfg.entryBanStartHour}h-${this.cfg.entryBanEndHour}h) → pas d'entrées (sorties continuent)`);
      step(`SESSION: fenêtre bannie ${this.cfg.entryBanStartHour}-${this.cfg.entryBanEndHour}h → pas d'entrées, sorties continuent`);
    }
    // v11.2 humeur à verrou: réalisé net (2h) ≤ badDayRealizedUsd OU un rug exit de < badDayLatchMin
    // → PAUSE des entrées (les sorties/churn continuent). v11.1 leçon (run 8): la fenêtre 1h se vide
    // dès la fin du déluge et les entrées reprenaient à minuit pendant que la bande convalescente
    // ruggait encore — le verrou sur le DERNIER rug tient la pause 30 min de plus.
    const moodRow = this.db
      .prepare("SELECT COALESCE(SUM(realized_pnl_usd), 0) AS r FROM trades WHERE status IN ('filled','simulated') AND side='sell' AND ts_ms >= ? AND ts_ms <= ?")
      .get(now - 2 * 3_600_000, now) as { r: number };
    const rugCount2h = this.db
      .prepare("SELECT COUNT(*) n FROM trades WHERE status IN ('filled','simulated') AND side='sell' AND ts_ms >= ? AND (reason LIKE 'rug exit%' OR reason LIKE 'fake pump purge%')")
      .get(now - 2 * 3_600_000) as { n: number };
    const lastRug = this.db
      .prepare("SELECT MAX(ts_ms) t FROM trades WHERE status IN ('filled','simulated') AND side='sell' AND (reason LIKE 'rug exit%' OR reason LIKE 'fake pump purge%')")
      .get() as { t: number | null };
    const rugMinAgo = lastRug.t ? (now - lastRug.t) / 60_000 : Number.POSITIVE_INFINITY;
    // verrou: une SÉRIE de ruggers (≥ badDayRugCount sur 2h) dont le dernier < badDayLatchMin — un rug isolé ne ferme pas l'offre
    const latchOk = !(rugCount2h.n >= this.cfg.badDayRugCount && rugMinAgo <= this.cfg.badDayLatchMin);
    const moodOk = !inBan && latchOk && moodRow.r > this.cfg.badDayRealizedUsd;
    if (!moodOk && !inBan) {
      const pourquoi = !latchOk
        ? `série de ruggers (${rugCount2h.n}/2h) et dernier il y a ${Math.round(rugMinAgo)} min < ${this.cfg.badDayLatchMin} min → verrou`
        : `réalisé net (2h) ${moodRow.r.toFixed(2)}$ ≤ ${this.cfg.badDayRealizedUsd}$`;
      this.rec("info", `HUMEUR: ${pourquoi} → pause des entrées (sorties continuent)`);
      step(`HUMEUR MAUVAISE: ${pourquoi} → pause des entrées, sorties continuent`);
    }
    let buys = 0;
    const positionsAll = listPositions(this.db, true);
    const symbolCount = new Map<string, number>();
    for (const p of positionsAll) {symbolCount.set(p.symbol, (symbolCount.get(p.symbol) ?? 0) + 1);}
    const needCash = this.cfg.tradeUsd * 1.05;
    if (this.cash() < needCash) {await this.recycleCash(needCash);}
    // seen map: dernier moment où le mint était entrable (pour le critère "aucun volume" du churn)
    const seen = this.seenAt();
    const rug = this.rugTickers();
    const staleBefore = now - 24 * 3_600_000;
    for (const [mint, ts] of Object.entries(seen)) {if (ts < staleBefore) {delete seen[mint];}}
    for (const c of candsOk) {seen[c.mint] = now;}
    for (const c of moodOk ? candsOk : []) {
      const held = getPosition(this.db, c.mint);
      if (held) {continue;}
      if (rug[c.symbol]) {
        this.rec("reject", `${c.symbol}: zone d'exclusion — un coin ruggé porte déjà ce ticker exact, pas d'achat`);
        continue;
      }
      if (positionsAll.length + buys >= this.cfg.maxPositions) {break;}
      const lotUsd = this.lotUsd(c);
      if (this.cash() < lotUsd * 1.05) {
        this.rec("reject", `${c.symbol}: cash ${this.cash().toFixed(2)}$ < lot ${lotUsd}$ — pas d'entrée`);
        break;
      }
      if ((symbolCount.get(c.symbol) ?? 0) >= this.cfg.maxLotsPerSymbol) {
        this.rec("reject", `${c.symbol}: cap familles — déjà ${(symbolCount.get(c.symbol) ?? 0)} lot(s) du même nom de la range, pas de lot supplémentaire`);
        continue;
      }
      await this.buy(c, lotUsd, this.lotBand(c));
      symbolCount.set(c.symbol, (symbolCount.get(c.symbol) ?? 0) + 1);
      seen[c.mint] = now;
      buys += 1;
    }
    kvSetJson(this.db, "maxscalpSeenAt", seen);
    if (buys > 0) {step(`entrées: ${buys} nouveau(x) lot(s)`);}

    // === 4) equity ===
    const finalPos = listPositions(this.db, true);
    const exposure = finalPos.reduce((a, p) => a + p.qty * this.priceOf(p.mint, p.avgEntryUsd), 0);
    const nav = this.cash() + exposure;
    insertEquity(this.db, {
      tsMs: now,
      tickId: 0,
      navUsd: nav,
      cashUsd: this.cash(),
      positionsUsd: exposure,
      realizedTotalUsd: realizedPnlTotal(this.db),
      drawdownPct: 0,
    });
    step(`NAV ${nav.toFixed(3)}$ cash ${this.cash().toFixed(2)}$ pos ${finalPos.length} expo ${exposure.toFixed(1)}$`);
    return lines;
  }

  /** v10: lot par bande de vol5m — le turbo ≥ 100k$ (seule bande à +1.18$/sym sur 380 syms) porte le gros lot */
  private lotUsd(c: Candidate): number {
    return c.vol5mUsd >= this.cfg.turboVol5mUsd ? this.cfg.tradeUsdTurbo : this.cfg.tradeUsd;
  }

  /** v11.1: étiquette la bande d'entrée (base 50-100k$ / turbo ≥100k$) sur la raison pour le bilan par bande live */
  private lotBand(c: Candidate): string {
    return c.vol5mUsd >= this.cfg.turboVol5mUsd ? "turbo" : "base";
  }

  private buy(c: Candidate, lotUsd: number, band: string): void {
    const ts = Date.now();
    const f = simulateBuy(lotUsd, c.priceUsd, {
      feeBps: this.cfg.feeBps,
      slippageBps: this.cfg.slippageBps,
      solPrice: 150,
      priorityFeeSol: 0.0001,
      liquidityUsd: c.liquidityUsd,
    });
    addLot(this.db, c.mint, c.symbol, f.qty, f.priceEffective, ts);
    paperCashSet(this.db, this.cash() - lotUsd);
    const map = this.ladder();
    const st = map[c.mint];
    if (st) {st.entryCount += 1;}
    kvSetJson(this.db, "maxscalpLadder", map);
    insertTrade(this.db, {
      tsMs: ts,
      mode: "paper",
      strategy: "maxscalp",
      mint: c.mint,
      symbol: c.symbol,
      side: "buy",
      spendUsd: lotUsd,
      qty: f.qty,
      priceUsd: f.priceEffective,
      expectedPriceUsd: c.priceUsd,
      slippageBps: f.slippageBps,
      jupFeeUsd: f.jupFeeUsd,
      feeBps: this.cfg.feeBps,
      solFee: f.solFee,
      status: "simulated",
      reason: `maxscalp entry (loterie, ${band})`,
      note: `liq ${(c.liquidityUsd / 1000).toFixed(0)}k$ vol5m ${(c.vol5mUsd / 1000).toFixed(0)}k$`,
    });
  }

  /** cash vide → liquider 50% de chaque position en profit, de la plus vieille à la plus récente, jusqu'à refaire un budget d'achat */
  private async recycleCash(need: number): Promise<void> {
    let did = 0;
    const freshLimitMs = this.cfg.sellMarkFreshS * 1_000;
    const positions = listPositions(this.db, true).sort((a, b) => a.openedMs - b.openedMs);
    for (const pos of positions) {
      if (this.cash() >= need) {break;}
      const { price, ageMs: markAgeMs, src: markSrc } = this.priceWithAge(pos.mint, pos.avgEntryUsd);
      if (markAgeMs > freshLimitMs) {continue;} // pas de sell sur mark pas frais
      const value = pos.qty * price;
      if (value <= pos.investedUsd) {continue;} // en profit uniquement
      const st = this.ladder()[pos.mint];
      if (!st) {continue;}
      const step = 0.5;
      if (pos.qty * step <= 0) {continue;}
      this.rec("trade", `${pos.symbol}: RECYCLE CASH −50% du lot (profit, plus ancien d'abord) pour re-financer les entrées`);
      if (await this.partialSell(pos, price, step, st, "recycle cash", { ageMs: markAgeMs, src: markSrc })) {
        st.refUsd = pos.qty * (1 - step) * price;
        kvSetJson(this.db, "maxscalpLadder", this.ladder());
        did += 1;
      }
    }
    // fallback churn: toujours short après les winners → fermer des idle lots (cash + slots)
    if (this.cash() < need) {
      const cands: Candidate[] = [];
      await this.purgeIdle(cands, () => {}, "cash");
    }
    if (did > 0 && this.cash() < need) {
      this.rec("info", `RECYCLE: purge des profitables terminée, cash ${this.cash().toFixed(2)}$ toujours < ${need.toFixed(2)}$ — la loterie attend des pumps`);
    }
  }

  /**
   * Une vente n'existe que sur un prix dont la source a < sellMarkFreshS (anti-fiction comptable:
   * le fallback "prix d'entrée" n'est pas un marché). allowStale s'enhardit pour les purges
   * délibérées au "dernier prix connu" (dead exit) ou au haircut.
   */
  private partialSell(
    pos: Position,
    price: number,
    takePct: number,
    _st: LadderState,
    reason?: string,
    opts: { ageMs?: number; allowStale?: boolean; src?: "discovery" | "candle" } = {},
  ): boolean {
    const sellQty = pos.qty * takePct;
    const freshLimit = this.cfg.sellMarkFreshS * 1_000;
    if (!(price > 0) || !(sellQty > 0)) {
      this.rec("error", `${pos.symbol}: partialSell annulé — prix/qty invalides (price ${price}, qty ${sellQty})`);
      return false;
    }
    if (opts.allowStale !== true && (opts.ageMs === undefined || opts.ageMs > freshLimit)) {
      this.rec("info", `${pos.symbol}: sell évité — mark pas frais (âge source ${(opts.ageMs === undefined ? "fallback ∞" : Math.round(opts.ageMs / 60_000) + " min")}, limite ${this.cfg.sellMarkFreshS}s)`);
      return false;
    }
    const guarded = this.sellPriceGuard(pos, price, opts.src);
    if (guarded.note !== undefined) {
      this.rec("trade", `${pos.symbol}: prix de vente ${price.toExponential(3)} → ${guarded.price.toExponential(3)} (${guarded.note})`);
    }
    price = guarded.price;
    // profondeur du pool: le dernier liquide connu de la discovery; à défaut le plancher d'entrée
    // (minLiquidityUsd 5000$) — jamais sellQty×price (auto-référentiel: le pool ne rétrécit pas parce qu'on vend)
    const discLq = latestDiscoveryTick(this.db, pos.mint)?.liquidityUsd ?? 0;
    const f = simulateSell(sellQty, price, {
      feeBps: this.cfg.feeBps,
      slippageBps: this.cfg.slippageBps,
      solPrice: 150,
      priorityFeeSol: 0.0001,
      liquidityUsd: discLq > 0 ? discLq : this.cfg.minLiquidityUsd,
    });
    if (f.proceedsUsd <= 0) {
      this.rec("error", `${pos.symbol}: partialSell annulé — proceeds net 0$ (liquidité insuffisante pour ${sellQty.toPrecision(4)} u @ ${price})`);
      return false;
    }
    const ts = Date.now();
    const priceNet = f.proceedsUsd / sellQty;
    const red = reducePositionFifo(this.db, pos.mint, pos.symbol, sellQty, priceNet, ts);
    paperCashSet(this.db, this.cash() + f.proceedsUsd);
    insertTrade(this.db, {
      tsMs: ts,
      mode: "paper",
      strategy: "maxscalp",
      mint: pos.mint,
      symbol: pos.symbol,
      side: "sell",
      spendUsd: f.proceedsUsd,
      qty: sellQty,
      priceUsd: f.priceEffective,
      expectedPriceUsd: price,
      slippageBps: f.slippageBps,
      jupFeeUsd: f.jupFeeUsd,
      feeBps: this.cfg.feeBps,
      solFee: f.solFee,
      realizedPnlUsd: red.realizedPnlUsd,
      status: "simulated",
      reason: reason ?? `take ladder (${_st.takes === 0 ? "x2 initial" : "x2 n°" + (_st.takes + 1)})`,
      note: "maxscalp — pas de SL, sol laisse courir",
    });
    this.rec("trade", `${pos.symbol}: ${reason ?? "TAKE"} − prélèv ${f.proceedsUsd.toFixed(3)}$, PnL réalisation ${red.realizedPnlUsd.toFixed(4)}$, sol restant ${(pos.qty * (1 - takePct)).toFixed(4)}`);
    return true;
  }
}
