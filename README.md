# solbot2

Bot de trading **spot Solana (Jupiter Aggregator + Solana RPC lecture seule)**, pensé pour un
micro-capital (~6 $ en USDC). Rien d'exotique : SQLite `node:sqlite`, pino, commander,
dashboard lecture seule — et le portefeuille réel est réduit à sa plus simple expression
(signer local, zéro web3 côté exécution).

> **Nouveautés 2026** : deux **scalpeurs paper dédiés** aux mèmes récents — `maxscalp`
> (loterie ×2 sans stop loss) et `gmgn` (TP/SL classiques) — avec leur propre DB, leur
> propre dashboard et un arsenal de garde-fous appris sur run (sweep USDT, churn dead
> listings, garde anti-fausse lune).

## Démarrage rapide

```bash
# 1) installer
npm ci

# 2) configuer (copie config.example.yaml → config.yaml au besoin)
cp config/config.example.yaml config/config.yaml

# 3) créer le wallet + .env (chmod 600)
npm run init
# → adresse + QR ("Phantom" pour financer) ; financer ~1 SOL + ≥5 USDC avant live

# 4) vérifier tout le contexte
npm run doctor

# 5) lancer la démo (marché synthétique, zéro réseau, zéro wallet)
npm run demo          # dashboard http://127.0.0.1:4100

# 6) mode paper réel (Jupiter réel, exécution simulée, capital fictif 6 $)
npm run start

# 7) scalpeurs paper dédiés (bases vierges 100$, dashboards séparés)
npm run maxscalp      # loterie ×2 — dashboard http://127.0.0.1:4102, DB data/maxscalp.sqlite
npm run gmgn          # TP/SL classiques — dashboard http://127.0.0.1:4101, DB data/gmgn.sqlite

# 8) backtest (obligatoire avant live — bot principal)
npm run backtest      # verdict en kv ; les 7 derniers jours exigés par la garde live
```

Env optionnelle : `GECKO_API_KEY=CG-…` (OHLCV GeckoTerminal on-demand, requis depuis le
paywall de l'endpoint), `GMGN_API_KEY` (feed gmgn natif — solde >100$ côté GMGN pour
l'instant non fourni, non-bloquant).

## Les trois bots

| Bot | Port | Univers | Risques | DB |
|---|---|---|---|---|
| **principal** (start) | 4100 | top liquidités (SOL/USDC/JUP…) | SL/TP/trailing + régimes | `data/solbot2.sqlite` |
| **`gmgn`** | 4101 | mèmes 0→24 h | stop loss & take profit classiques, **kill journalier** (pausé à la perte du jour) | `data/gmgn.sqlite` |
| **`maxscalp`** | 4102 | mèmes 0→24 h, loterie | **pas de SL** — purges plutôt que stops, ladder de prélèvements | `data/maxscalp.sqlite` |

Les scalpeurs sont **paper uniquement** (1 $/lot sur 100$ initiaux) — la loterie
n'arme jamais de wallet. Le journal des runs et expériences est dans
`results/scalping-experiments.md` (runs 0→5, post-mortems inclus).

## Checkout maxscalp (loterie ×2)

- **Entrée** : 1$ par listing neuf >5k$ de réserve, <0.05$, cap 2 lots par nom de
  famille, cooldown 60 s, exclusion des tickers déjà ruggés.
- **Sorties** :
  - take ladder — au premier ×2 → 1.2$ prélevés, puis +20% du sol à chaque nouveau ×2
    (l'escalade se récolte, le reste court sans stop) ;
  - moon stop — un lot profité qui retombe de son peak est liquidé ;
  - rug exit — lot jamais profité à ≤60% du coût → purge + ticker blacklisté ;
  - churn — plats ≥30 min vs purges cap, morceaux manque-de-volume ≥30/60 min → idle/dead exit ;
  - sweep — NAV >102$ → 2 USDT retirés du wallet **vers un coffre hors marché** ;
  - recycle — cash vide → 50% des positions en profit, oldest-first ;
  - dead exit — lot sans prix frais depuis ≥60 min → dernier prix connu ou −50%.
- **v7 — anti-fausse lune** : la fraîcheur d'un prix n'est pas sa légitimité. Chaque tick
  trace son origine (`price_ticks.src` = `discovery` | `candle`) ; une bougie OHLCV
  >4× le dernier liquide recent discovery est considérée pool-mule (la vente est clampée
  au dernier prix discovery) ; tout « gain » >20× l'entrée est clampé aussi. La
  profondeur du pool pour la fill = dernier liquide discovery connu (jamais
  auto-référentielle). Warmup au boot : `repriceAll` re-price 100% des positions via
  OHLCV avant le premier tick de churn.

## Commandes (CLI)

| Commande | Utilité |
|---|---|
| `init` | wallet local + `.env` chmod 600 + QR financement |
| `doctor` | config / wallet / DB+migrations / RPC / Jupiter / univers en ligne / STOP |
| `start [--demo] [--once]` | moteur plein (backfill GeckoTerminal si nécessaire, funding watcher en live, réconciliation on-chain au démarrage) |
| `demo` | `start --demo` |
| `gmgn` | scalpeur paper TP/SL dédié, dashboard :4101 |
| `maxscalp` | scalpeur paper loterie dédié, dashboard :4102 |
| `backtest [--days 30]` | rejoue le moteur sur l'historique 15m (`candles_imported`), verdict |
| `balance` | soldes RPC honnêtes (SOL / tokens / total estimé) |

## Dashboard (3 en simultané)

- `:4100` bot principal — NAV/cash/buy&hold (uPlot), positions, trades, décisions, shadows.
- `:4101` gmgn — TP/SL, kill journalier.
- `:4102` maxscalp — **Sécurisé (USDT)** et **Fortune totale** (NAV + coffre), **Takes
  réalisés** ($), **En jeu** (%), table positions avec entrée vs **mark** frais et
  "dont friction" (slippage d'entrée).
- Lecture seule partout : SSE `/api/stream`, `/metrics` Prometheus, `/healthz`, aucun
  ordre accepté, clés redigées (`DASHBOARD_TOKEN` optionnel + avertissement si exposé).

## Pipeline d'un tick (défaut 30 s — bot principal)

1. **market refresh** — Jupiter Price v3 (batch ≤50 mints) → ticks + bougies 15m ;
2. **régimes** — trending/ranging/idle par actif (15m) ;
3. **NAV + kill-switch** — initital, peak/drawdown, ancre journalière, STOP fichier, `data/STOP` ;
4. **sorties** (priorité absolue) — SL/TP/trailing pulsé, signaux de sortie, régime idle ;
5. **shadows** — portefeuilles fantômes + allocation hystérésis (`kv allocatedStrategy`);
6. **entrée** — meilleur signal de la stratégie allouée → RiskManager (edge_net ≥ 3× coûts, tailles,
   cooldowns, réserve SOL, ATA rent) → Executor paper/dry-run/live ;
7. **journal** — equity + decisions (tela/off ; résultats SSE).

Pipeline d'un tick maxscalp (15 s) : discovery (GeckoTerminal new_pools/pools par défaut)
→ marks (feu tournant OHLCV 5/tick + repriceAll au warmup) → ladder (takes/rug/moon, prix
frais <5 min obligatoire) → purgeIdle → sweep NAV → recycle → entrées.

Architecture : `src/engine` (tick), `src/strategy` (AMD/momentum/régime), `src/risk`,
`src/execution` (costs/executor/paper-broker), `src/portfolio`, `src/market` (poller, regime,
GeckoTerminal backfill), `src/jupiter` (client bucket, price v3, swap `/order`+`/execute`),
`src/solana` (RPC lecture seule), `src/gmgn` (discovery GeckoFeed/GmgnFeed, scalpeurs),
`src/state` (SQLite migrations v1..v4 — dernière : `price_ticks.src`), `src/dashboard`,
`src/backtest`, `src/cli`, `src/demo`.

## Garde-fous (non négociables)

- paper/demo par défaut ; confirm_live double-filet + backtest + funding (bot principal) ;
- kill-switch fichiers `data/STOP` (bot) et `data/STOP_MAXSCALP` / `data/STOP_GMGN`
  (scalpeurs) ; kill-switch drawdown 30 %, perte journalière, cooldown par actif, cap positions ;
- scalpeurs : vente seulement sur mark <5 min, garde anti-pool-mule (v7), sweep USDT ;
- exposition du dashboard sans token → avertissement au boot.

## Tests

```bash
npm test   # vitest — 126 tests verts (unit + intégration moteur + dashboard + scalpeurs)
npm run lint
npm run typecheck
```

## Vol. Docker & fichiers

- `data/` : SQLite (`data/solbot2.sqlite`, scalpeurs), STOP files ; **volume persisté**.
- `.env` : en dehors du conteneur, passé par `env_file:` — ne **pas** le régénérer dans
  l'image (rebuild = perte de clé).
- Scalpeurs : journal `results/scalping-experiments.md` versionné ; archives de runs
  `results/archive/` (40 MB de sqlite) non versionnées.

## Dépannage

- `gecko ohlcv 404/401` (backtest & scalpeurs) : l'endpoint **OHLCV GeckoTerminal exige
  une clé**. Clé démo gratuite sur coingecko.com, puis `.env` : `GECKO_API_KEY=CG-…`
  (le client bascule sur l'endpoint v3 onchain avec header demo).
- Scalpeur gelé / « STOP file — plus d'entrées » dans le log : un `data/STOP_MAXSCALP`
  (ou `data/STOP_GMGN`) traine — `rm data/STOP_*`.
- Fausse lune (NAV qui explose sur un mème) : les garde-fous v7 clampent déjà le take ;
  pour l'audit, examiner `price_ticks.src` (candle vs discovery) et le journal des
  décisions (« clamp candle », « clamp entry×20 »).
- `.env` est chargé au lancement de la CLI (`init` écrit le fichier chmod 600) — les
  variables gagnées n'écrasent jamais `process.env`.

Plan complet : `PLAN.md`. Licence MIT.
