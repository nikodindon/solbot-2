# solbot2

Bot de trading **spot Solana (Jupiter Aggregator + Solana RPC lecture seule)**, pensé pour un
micro-capital (~6 $ en USDC). Rien d'exotique : SQLite `node:sqlite`, pino, commander,
dashboard lecture seule — et le portefeuille réel est réduit à sa plus simple expression
(signer local, zéro web3 côté exécution).

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

# 7) backtest (obligatoire avant live)
npm run backtest      # verdict en kv ; les 7 derniers jours exigés par la garde live
```

## Modes

| Mode | Réseau Jupiter | Exécution | Capital |
|---|---|---|---|
| `paper` (défaut) | réel (taille de trade simulée, `paper_fill_slippage_bps`) | simulée | `paper_initial_usdc` + wallet gaz `paper_initial_sol` (rent ATA remboursée au close) |
| `demo` (CLI `--demo`) | aucun (marché synthétique GBM seedé) | simulée | même capital |
| `dry_run` | réel | ordre construit mais **non signé** (signature évitée) | fictif |
| `live` | réel | Meta-Aggregator (`/order` + `/execute`) | réel (wallet RPC) |

Mode `live` exige conjointement : `MODE=live`, `confirm_live: true`, **backtest concluant** sur
les 7 derniers jours (kv `backtestVerdict`), et wallet financé (`funding.min_sol_usd`,
`funding.min_usdc_usd`).

## Commandes (CLI)

| Commande | Utilité |
|---|---|
| `init` | wallet local + `.env` chmod 600 + QR financement |
| `doctor` | config / wallet / DB+migrations / RPC / Jupiter / univers en ligne / STOP |
| `start [--demo] [--once]` | moteur plein (backfill GeckoTerminal si nécessaire, funding watcher en live, réconciliation on-chain au démarrage) |
| `demo` | `start --demo` |
| `backtest [--days 30]` | rejoue le moteur sur l'historique 15m (`candles_imported`), verdict |
| `balance` | soldes RPC honnêtes (SOL / tokens / total estimé) |

## Dashboard

- `http://0.0.0.0:4100` — **lecture seule** : NAV/cash/buy&hold (uPlot), positions, trades,
  décisions, shadows, SSE `/api/stream`, `/metrics` Prometheus, `/healthz`.
- Auth optionnelle : `DASHBOARD_TOKEN`. Un avertissement clair s'affiche si exposé sans token.
- Aucune route n'accepte d'ordres, aucune clé dans `/api/*` (`BS58_PRIVATE_KEY`, `JUPITER_API_KEY`
  redigés; `.env` jamais commité).

## Pipeline d'un tick (défaut 30 s)

1. **market refresh** — Jupiter Price v3 (batch ≤50 mints) → ticks + bougies 15m ;
2. **régimes** — trending/ranging/idle par actif (15m) ;
3. **NAV + kill-switch** — initital, peak/drawdown, ancre journalière, STOP fichier, `data/STOP` ;
4. **sorties** (priorité absolue) — SL/TP/trailing pulsé, signaux de sortie, régime idle ;
5. **shadows** — portefeuilles fantômes + allocation hystérésis (`kv allocatedStrategy`);
6. **entrée** — meilleur signal de la stratégie allouée → RiskManager (edge_net ≥ 3× coûts, tailles,
   cooldowns, réserve SOL, ATA rent) → Executor paper/dry-run/live ;
7. **journal** — equity + decisions (tela/off ; résultats SSE).

Architecture : `src/engine` (tick), `src/strategy` (AMD/momentum/régime), `src/risk`,
`src/execution` (costs/executor/paper-broker), `src/portfolio`, `src/market` (poller, regime,
GeckoTerminal backfill), `src/jupiter` (client bucket, price v3, swap `/order`+`/execute`),
`src/solana` (RPC lecture seule), `src/state` (SQLite migrations v1..v2), `src/dashboard`,
`src/backtest`, `src/cli`, `src/demo`.

## Volumes Docker

- `data/` : SQLite (`data/solbot2.sqlite`), STOP, STOP historique ; **volumé persisté**.
- `.env` : en dehors du conteneur, passé par `env_file:` — ne **pas** le régénérer dans
  l'image (rebuild = key loss).

## Garde-fous (non négociables)

- paper/demo par défaut ; confirm_live double-filet + backtest + funding ;
- kill-switch fichier `data/STOP` (toutes entrées bloquées), kill-switch drawdown 30 %,
  perte journalière `daily_loss_limit_pct`, cooldown par actif, max positions ;
- 1 trade en vol max ; slippage/edge net ; réserve SOL GAS (désimulée en live) ;
- exposition du dashboard sans token → avertissement au boot.

## Tests

```bash
npm test   # vitest (unit + intégration moteur + dashboard)
npm run lint
npm run typecheck
```

## Dépannage

- `gecko ohlcv 404/401` au backtest : l'endpoint **OHLCV de GeckoTerminal exige désormais
  une clé**. Register une clé démo gratuite sur coingecko.com, puis dans `.env` :
  `GECKO_API_KEY=CG-…` (le client bascule alors sur l'endpoint v3 onchain avec le header
  `x-cg-demo-api-key`).
- `.env` est chargé au lancement de la CLI (`init` écrit le fichier chmod 600) — les
  variables gagnées n'écrasent jamais `process.env`.

Plan complet : `PLAN.md`. Licence MIT.
