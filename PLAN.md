# PLAN — solbot2

Bot de trading spot autonome sur Solana (mainnet, Jupiter), pensé pour un capital de test de **~6 $** (~1 $ SOL + ~5 $ USDC).
Fork d'esprit du projet `solbot` (v1) : on reprend son pipeline éprouvé, on corrige ses limites, on supprime ce qui ne sert pas à cette échelle.

> Objectif honnête : **pas de rentabilité**, mais la preuve, avec de vrais fonds, que toute la chaîne
> fonctionne (données → signal → risque → swap réel → comptabilité → dashboard) en perdant le moins
> possible en frais. Chaque décision est expliquée en clair.

---

## 1. Ce qu'on garde du v1 (et pourquoi)

| Idée v1 | Verdict v2 | Détails |
| --- | --- | --- |
| Pipeline Scanner → Stratégies → Arbitrage par score → RiskManager (dernier mot) → Executor → journal | ✅ conservé | c'est la bonne topologie, testée par le v1 |
| Swap v2 `/order` + `/execute` (RTSE, landing Jupiter) | ✅ conservé | `/execute` a son propre bucket de rate limit ; pas besoin du path Router `/build` (inutile avec de micro-tailles, complexité non justifiée) |
| Modes paper / dry-run / live, **paper par défaut** | ✅ conservé | `confirm_live` + backtest concluant + wallet financé exigés conjointement |
| SQLite `node:sqlite` + migrations versionnées | ✅ conservé | zéro dépendance native, single process |
| Config zod fail-fast (yaml + .env) | ✅ conservé | simplifiée (pas de copy-trade, router path, notifications) |
| Réconciliation on-chain au démarrage | ✅ conservé | les soldes RPC font foi, adoption/ajustement/fermeture des positions |
| Kill-switch fichier `STOP`, SL/TP/trailing, cooldowns, perte journalière | ✅ conservé | + kill-switch NAV<70% du capital initial (nouveau) |
| Tests vitest, lint, TS strict | ✅ conservé | exigence du v1, maintenue |
| Backtest rejouant le **même moteur** + historique GeckoTerminal | ✅ conservé | avec backfill automatique au démarrage (supprime le warm-up de 7 h) |

## 2. Ce qu'on corrige / ajoute (limites du v1)

1. **Micro-capital comme contrainte de conception** (le v1 taille en % NAV sur 500–1000 $) :
   - réserve de gaz **~0,005 SOL** (jamais 0,05) et compteur continu « swaps encore possibles » ;
   - taille min ~1,5–2 $, max 2 positions ouvertes, **1 trade en vol à la fois** ;
   - univers restreint : SOL/USDC + ≤5 tokens vérifiés, liquidité > 1 M$, âge > 30 j — chaque
     ouverture d'ATA (~0,00204 SOL de rent) est un **coût modélisé** dans la décision ;
   - filtre **edge net de coûts** : edge attendu > `3× coût aller-retour estimé` (frais Jupiter par
     paire + base fee + priority fee + slippage + rent amorti). Rejets journalisés avec les chiffres.
2. **Warm-up supprimé** : backfill automatique OHLCV GeckoTerminal au démarrage (15m, 30 j) →
   stratégies opérationnelles en minutes.
3. **Détection de régime** par actif (trending/ranging/highVol/idle) qui active/désactive les
   stratégies — « ne pas trader » est une décision valide et fréquente.
4. **Portefeuilles fantômes** : toutes les stratégies tournent en paper en parallèle du capital réel ;
   le capital suit la meilleure performance glissante **nette de coûts**, avec seuil d'échantillons
   et hystérésis. Le dashboard compare réel vs fantômes.
5. **Journal d'explication** : une ligne lisible par tick par actif (« SOL: momentum 0.62, edge 38 bps
   < seuil 3×coûts (45 bps) → pas d'entrée »).
6. **Reporting des coûts réels** : chaque trade décompose frais Jupiter, base fee, priority fee,
   slippage réalisé vs attendu ; « coût total payé » vs « PnL brut » partout.
7. **Démarrage sans friction** : `npm run setup` (wallet + .env chmod 600 + QR) → `npm start` attend
   le financement (polling des soldes) et démarre seul une fois les seuils atteints.
8. **Dashboard temps réel** (port 4100) : lecture seule, SSE, thème sombre, uPlot vendu en local,
   endpoints JSON documentés + `/metrics` Prometheus.
9. **Mode demo** : marché synthétique, zéro réseau, zéro wallet — pour tester l'UI et le moteur.

## 3. Ce qu'on ne reprend PAS du v1

- Path Router `/build`, landing Jito/tx.jup, transactions v1, A/B bascule auto : complexité
  injustifiée à <10 $ ; Meta-Aggregator suffit (RTSE + landing gérés par Jupiter).
- copy-trade, Telegram, backups automatiques, scan dynamique de l'univers (centaines de tokens) :
  hors scope micro-capital. L'univers est une whitelist statique vérifiée (avec ses données
  revérifiées en ligne au démarrage : `isVerified`, décimales, liquidité, âge).
- Keystore chiffré, pages CLI avancées (`watch`, `paths`, `ui`, `stub`).

## 4. Architecture

```
                ┌─────────────────────────────── src/ ───────────────────────────────┐
 config/      ┌─┤ schema zod (yaml + env, fail-fast)  utils/ (logger pino redact,   │
 (yaml+.env)  │ │                                       rate limiter bucket, time)   │
              │ ├─ jupiter/   client HTTP (bucket 0,5 RPS keyless, backoff 429 via    │
              │ │             x-ratelimit-reset, retries 5xx, zod) · price v3 batch50 │
              │ │             · tokens v2 (vérif univers) · /order + /execute        │
              │ ├─ market/    poller → ticks → candles 15m/1h · backfill GeckoTerminal│
              │ │             · regime (trending/ranging/highVol/idle)               │
              │ ├─ strategy/  contrats Strategy/Signal · indicators EMA/RSI/ATR/z    │
              │ │             · momentum · mean_reversion · dca_rotation · benches   │
              │ ├─ risk/      RiskManager : edge net > 3×coûts, sizing micro, réserve│
              │ │             gaz, count ATA, kill-switch, perte journalière, cooldown│
              │ ├─ execution/ cost model · paper broker (fills modélisés) · executor │
              │ │             (paper | dry-run /order+simul | live signe+/execute)   │
              │ ├─ portfolio/ FIFO lots, PnL réalisé/latent, NAV                     │
              │ ├─ engine/    tick 30s : snapshot → sorties → entrées · 1 trade en   │
              │ │             vol · journal d'explication · shadows + allocation     │
              │ │             hystérésis · funding watcher · réconciliation on-chain │
              │ ├─ dashboard/ http 0.0.0.0:4100, SSE /api/stream, /api/state·trades· │
              │ │             equity·decisions, /healthz /metrics, static public/    │
              │ └─ state/     node:sqlite + migrations v1..n (kv, tick log, decision logs, shadow history)
              │  CLI commander : init | start | demo | doctor | backtest | balance   │
              │
        SQLite  data/solbot2.sqlite   ← workspace volume Docker
```

Flux d'un tick (défaut 30 s) :

1. **market refresh** — Price v3 (1 requête, batch ≤50 mints) → ticks → candles ; volume via stats
   24 h de Tokens v2 tous les N ticks (throttled) ;
2. **régimes** recalculés par actif ;
3. **NAV + comptabilité** : mark-to-market, peak/drawdown, ancre journalière UTC, kill-switch 30 % ;
4. **sorties** (priorité absolue) : SL/TP/trailing, signaux de sortie, régime idle ;
5. **shadows** : toutes les stratégies évaluent → signaux → portefeuilles fantômes virtuels (fills
   modélisés, mêmes coûts) + scores glissants → allocation du capital réel (hystérésis) ;
6. **entrées** : meilleur signal de la stratégie allouée → RiskManager (edge net, sizing, réserves,
   cooldowns, kill-switch) → executor ; 1 trade en vol à la fois ;
7. **journal d'explication** + point equity + notifications dashboard.

## 5. Modèle de coûts (le cœur honnête du projet)

Coût aller-retour estimé (en bps du notional) avant toute entrée :

```
fee_bps aller + fee_bps retour          (barème Jupiter : 2 SOL↔stable, 10 sinon, 50 <24 h)
base_fee SOL × 2 (0,000005 SOL/tx ×2)
priority_fee SOL × 2 (config, défaut 0,00002 SOL/tx)
slippage estimé × 2 (défaut 15 bps sur majors à cette taille)
rent ATA (~0,00204 SOL ⇄ $) si 1er achat du token — modèle amorti sur ATA horizon
```

Entrée seulement si `edge stratégique > edge_multiplier(3) × coût_aller_retour`. Chaque rejet est
journalisé avec la raison chiffrée (ex : « edge 38 bps < seuil 3×coûts 45 bps »).

Paramètres par défaut (config/config.yaml, adaptés à 6 $) : `min_trade_usd 1.5`, `max_trade_usd 3`,
`max_positions 2`, `priority_fee_sol 0.00002`, `gas_reserve_sol 0.005`, `max_slippage_bps 300`
(plafond dur de willingess, RTSE en pratique), `kill_switch_max_drawdown_pct 30`, `daily_loss_limit_pct 10`.

## 6. Sécurité / garde-fous (non négociables)

- Paper par défaut ; live exige `MODE=live` + `confirm_live: true` + backtest concluant + wallet
  financé. Plafonds durs **aussi codés en constant** (double filet) : taille max 10 $, perte max 50 %.
- Lecture seule au dashboard ; aucun secret dans /api/*; `DASHBOARD_TOKEN` optionnel ; avertissement
  au boot si exposé sans token.
- Redaction pino de `BS58_PRIVATE_KEY`, `JUPITER_API_KEY`, secrets ; `.env` jamais commité.

## 7. Risques connus & mitigations

| Risque | Mitigation |
| --- | --- |
| Graisse → solde < réserve → swap impossible | check pré-trade `gas` + compteur swaps possibles ; refus si trade ferait passer sous réserve |
| Rent ATA mange l'edge sur petits tokens | coût rent modélisé, univers restreint, réutilisation d'ATAs existants |
| 429 Jupiter (keyless 0.5 RPS) | bucket client-side, batch 50, cache TTL, backoff honnête sur `x-ratelimit-reset` |
| Trades concurrents dupliqués | 1 trade en vol à la fois (verrou), refus sinon |
| Crash en live | réconciliation on-chain au démarrage (soldes RPC font foi) |
| Perte hors contrôle | kill-switch 30 % + STOP fichier + perte journalière |
| Frais organisés > edge | filtre edge net de coûts ; sans edge → ne pas trader (régime idle, rejets journalisés) |

## 8. Ordre de construction (commits atomiques, tests à chaque étape)

1. Scaffold + config + logger (+ tests)
2. SQLite + repos (positions FIFO, trades, decisions, equity, candles) (+ tests FIFO)
3. Client Jupiter (rate limits, price v3, /order+/execute) (+ tests mocks HTTP)
4. Marché : poller, OHLCV, backfill Gecko, régime (+ tests)
5. Stratégies + indicateurs + benchmarks (+ tests)
6. Coûts + RiskManager micro-capital (+ tests règle par règle)
7. Portfolio + executor (paper → dry-run → live) (+ tests paper fills)
8. Engine (tick, sorties d'abord, shadows, journal) (+ test intégration demo)
9. Dashboard : serveur + SSE + UI (+ tests endpoints + temps réel)
10. CLI init/start/doctor + funding watcher (+ tests)
11. Mode demo (`npm run demo`)
12. Backtest + garde live
13. Docker + README + polish ; erreur restante si écart repo/local.
14. Validation : `npm run demo` + inspection manuelle de l'UI sur :4100 ; tests vitest verts ; lint/typecheck propres.

## 9. Choix par défaut (documentés, configurables)

- Timeframe de travail : **15m** (1m aussi agrégé). Tick : 30 s. Backfill : 30 j (GeckoTerminal).
- Univers défaut : SOL, USDC + **JUP, BONK** (vérifiés, liq >5 M$, pools >30 j — données canvassées)
  ; extensible via `universe.tokens`.
- Sol hover : `--demo` actif → seed fixe.
- Le capital associé est opéré sur la paire **USDC ⇄ token** (USDC base), jamais ventes de la réserve.
- Dashboard 0.0.0.0:4100 ; token optionnel `DASHBOARD_TOKEN`.
