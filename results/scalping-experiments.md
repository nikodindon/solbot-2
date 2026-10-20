# Scalping Solana — Journal d'expériences (paper)

Deux bots scalpeurs en paper trading tournent séparément du bot principal (`:4100`) :

| Bot | Port | DB | Philosophie |
|---|---|---|---|
| `gmgn` | :4101 | `data/gmgn.sqlite` | snipe discovery + TP 2.5% / SL 1.8% / time-stop 45 min |
| `maxscalp` | :4102 | `data/maxscalp.sqlite` | **loterie ×2** : pas de SL, take ladder progressif, free ride |

Lancement : `npm run gmgn` / `npm run maxscalp` (tsx, budget paper 100$ chacun, frais paper 2% (200 bps), slippage 250 bps).
Stop propre : créer `data/STOP` (gmgn) ou `data/STOP_MAXSCALP` ; le process sort au prochain tick.

---

## Timeline des ajustements

### Run 0 — gmgn scalper (classique TP/SL) — RÉSULTAT : FUITE UNIVERSELLE
- 8 snipes réels sur discovery live : **tous stop loss**, −12.45$ (NAV 100 → 84.45 à l'arrêt, kill journalier déclenché).
- Constat : les tokens les plus chauds du marché font **toujours** un dip > 2% avant de pump → un TP 2.5% / SL 1.8% en SNAPVEUR à −12.45$ par 8 trades, il ne peut pas tenir compte du bruit de la volatilité des mèmes.
- **Leçon** : ce ratio TP/SL est invendable sur de la détention de quelques minutes → passer à la philosophie « pas de SL, ladder de takes » (maxscalp).

### Run 1 — maxscalp loterie v1 (14:49 → 15:40 UTC 2026-10-17, ~56 min)

**Config v1** (`maxscalpDefaults()`) :
- 1$ / lot sur tout candidat discovery (liq ≥ 5000$, âge ≥ 2 min, cooldown 60 s, tick 15 s)
- ×2 → take 1.2$ cash ; chaque nouveau ×2 du sol → take 20% du sol ; sinon **free ride sans stop**
- 64 lots, 54 positions, cash 45.55$ in fine

**Résultats** :
- Réalisé sur trades : **−2.84$** (takes au cash +7.28$, rugues d'avant-garde −10.1$)
- Positions ouvertes mark-to-market : +8.2$
- Net théorique ≈ +5.4$ ; NAV affichée 94.63$ (sous-valorisée par les marks à l'entrée tant que le feu tournant n'a pas re-pricé)
- Distribution : ~55% des lots plats, ~25% rugues (−0.96$), ~20% pumps — **3 winners portent tout le run** :

| Token | PnL total | Détail |
|---|---|---|
| ETF | **+5.22$** | 2 takes n°1 + 2 takes ladder n°2, lot ×3 en cours |
| Solcasino (×6.85) | +2.24$ | 1 rug purgé + moon ride ×6.85, take 0.92$ cash, sol ~4.6$ |
| SOT | +1.81$ | take +0.77$ + sol courir |
| TRUMP | +1.75$ | take +0.51$ + variantes plats |
| Nought | +1.17$ | take +0.56$ + sol ×2.35 |

Perdants type : ruggés −0.96$ (Aloooong, Claude AI, BUILD, STEVEN, LOCKIN, ETF500 ×2, ELONCOIN…).

**Failles observées** (→ corrections ci-dessous) :
1. Les floats gagnants redescendent sans filet (Solcasino mark 4.78e-4 → 3.60e-4, −25% du peak en quelques minutes) : du profit non verrouillé s'évapore.
2. Cumul de variants du même nom : 4 lots « Solcasino », 6 « TRUMP » → corrélation perdante sur un même nom de famille.

### Fixes d'infrastructure (même session)
- SSE du dashboard : le state n'était émis qu'au boot → chaque tick broadcast `state` dans `src/cli/{gmgn,maxscalp}.ts`.
- NAV vaporisée : `buildState` valorisait les positions sans tick récent au prix d'entrée → fallback `listPositions` + `avgEntryUsd` (`src/dashboard/state.ts`).
- Discovery gecko : `include=base_token,dex` + mapping `relationships.base_token.data.id` → `included[]` (le `base_token` n'est sinon jamais résolu), `minAgeMin` 3 → 2.
- Feu tournant `rotateMarks` : 5 positions/tick re-pricées par OHLCV 1m (`feed.latestCandle`), oldest-first via map `markCursor` — re-price ~5 lots/min sur 54 lots, sinon rien ne bouge jamais.
- Anti-trap stables : `maxPriceUsd 0.05` (aucune entrée si le listing cote > 5¢).
- Purge anti-rug `rugExitPct 0.6` : lot jamais profitable dont le mark tombe ≤ 60% de l'entrée → dump complet (sauve ~40% du coût au lieu de tenir jusqu'à ×0.01).
- Pré à l'usage concret : paper fees 200 bps + slippage 250 bps calibrés sur fills réels v1.

### Run 2 — maxscalp v2 : moon stop + cap familles (lancé 15:44 UTC)

Deux nouvelles règles dérivées des failles du run 1 :

1. **Moon stop** (`moonStopDropPct: 0.6`) : un lot déjà profité (takes ≥ 1) qui retombe à ≤ 40% de son *pic de valeur* post-take → on liquide **tout le sol**. C'est un stop glissant sur profit exclusivement — le coût initial reste déjà remboursé par le take n°1. Va et vient entre free ride et verrouillage : le sol court tant qu'il fait de nouveaux plus-hauts, purge s'il retourne au nivellement.
2. **Cap familles** (`maxLotsPerSymbol: 2`) : max 2 lots simultanés partageant le même nom (variantes Solcasino/TRUMP dupliquées). Réduit les corrélations perdantes, élargit le tirage aux autres noms.

`LadderState` gagne `peakUsd` (persisté kv `maxscalpLadder`), suivi dans le tick principal **et** dans le feu tournant `rotateMarks`.

**Tests unitaires (11 sur maxscalp, 112 au total)** :
- take n°1 = 1.2$ encaissés, sol libre de tout stop en montée
- ladder : 20% du sol prélevés à chaque ×2 consécutif
- rug exit purge le lot jamais profitable ≤ 60% d'entrée
- **moon stop purge le sol à −70% du peak** (take + purge = 2 sells, position fermée)
- le rug exit **ne** purge pas un lot profité mais le moon stop prend le relais
- cap familles : 2 lots « MAX » pré-existants → 3e refusé ; un nouveau nom passe
- filtre `maxPriceUsd` : listing > 5¢ refusé

Premier tick post-relance : NAV 99.32$, cash 47.77$, 55 positions revalorisées, univers live. Le moon stop et le cap sont actifs à partir de maintenant — à réévaluer dans ~1 h.

### Run 2 — bilan (15:44 → 18:52 UTC, ~3 h, maxscalp v2 moon stop + cap)

Config v2 = v1 + moonStopDropPct 0.6 + maxLotsPerSymbol 2.

| | |
|---|---|
| Buys | 96 lots (~96$ bruts) |
| Sells | 38 (tous sens confondus : takes, rug exit, moon stop) |
| Realized close | **−2.38$** |
| Positions à l'arrêt | 79 lots, 72.81$ investi |
| NAV fin | **93.86$** (dash, marks partiels) — environ −6% sur 3 h |

Interprétation : le cap familles a cassé la dynamique des variants gagnants (ETF/TRUMP/Solcasino cumulaient +9$ au run 1 grâce aux re-buys du même nom), tandis que le moon stop coupait le free ride trop tôt sur les pumps qui continuent après une respiration > −40%. Résultat net : **moins de profit pris bas et moins de re-exposition gagnante**. V2 > v1 n'est pas acquis — run 1 (~56 min) était +5% vs run 2 (−6% sur 3 h).

Décision : repartir à zéro (100$, 0 position) avec **v3** (run 3).

### Run 3 — maxscalp v3 : sweep USDT + recycle cash (lancé 19:00 UTC, DB vierge)

Deux règles ajoutées :
1. **Sweep sécurisation** (`sweepTriggerUsd: 102`, `sweepUsd: 2`) : dès que le NAV du bot dépasse 102$, on sort systématiquement 2 USDT du wallet du bot (avant de les transférer via `paperCashSet`, compteur cumulative kv `maxscalpSweptUsd`) → le capital en jeu repart vers ~100$ et le gain se verrouille hors marché.
2. **Recycle cash** : si le cash du bot tombe sous le budget d'achat (1.05$), on liquide 50% de chaque position **en profit** (mark > PA, strict), les plus anciennes d'abord, jusqu'à re-créditer le budget d'achat → le bot ne reste jamais à court de munitions tant qu'il y a des gagnants. Les lots en perte ne sont jamais touchés, la loterie reste gratuite/hold.
3. (Passage) Raisons des sells nommées explicitement : `rug exit`, `moon stop`, `recycle cash`, `take ladder x2 n°x` (avant tout était « take ladder » dans le journal).

Ordre d'activation dans un tick : moon stop/rug/recycle ladder → sweep NAV → recycle cash → entrées 1$.

**Tests (14 sur maxscalp, 115 au total, tsc/eslint verts)** :
- sweep : NAV > trigger → 2$ sortis, cash < 99.3, compteur kv = 2 ; NAV < trigger au tick suivant → pas de double sweep
- recycle : 2 lots en profit, cash à 0 → 2 sells `recycle cash` oldest-first (OTHX puis MAX), puis nouvelle entrée faite
- recycle : lot en perte → aucune purge
- + tous les tests v1/v2 (11) 

Premier tick : NAV 99.64$, 6 lots, univers 6 candidats.

### Run 3 — bilan nocturne (19:00 UTC → 06:49, ~13 h) : blocage du cap 90

| | |
|---|---|
| Buys | 90 lots (cap maxPositions=90 atteint, saturé) |
| Sells | 2 (1 take ladder ×2, 1 rug exit) |
| Realized close | **+1.34$** |
| NAV fin | **101.43$** (+1.4%, friction −2.4%/lot incluse) |

Le trou noir : **90/90 slots remplis → plus aucune entrée** depuis des heures. La boucle d'entrées `break` dès que `positions ≥ maxPositions`, et rien ne libère les slots qu'à un ×2 (rares) ou un rug. Le bot est resté spectateur toute la fin de nuit.

Leçon : la loterie a besoin de **churn**. Sans purge mécanique des plats, le cap devient un plafond à une seule impulsion.

### Run 3' — maxscalp v4 : idle exit (churn) + friction affichée

Nouvelle règle (demandée niko) : quand les vieux lots sont **plats** et **sans volume**, les fermer oldest-first pour continuer à acheter les nouveaux :

1. **Idle exit** : lot dont (a) âge ≥ 30 min `idleExitMinAgeMin`, (b) `|pnl| ≤ 0.08$` `idleExitPnlUsd` (la friction d'entrée −0.024$ reste dans la bande), (c) token absent de la discovery ≥ 30 min `idleExitNoVolMin` (tracking kv `maxscalpSeenAt`, prune 24h) → **purge complète** (reason `idle exit`), oldest-first, **max 5 purges/tick** `maxIdlePurgesPerTick`, uniquement lorsque le cap est atteint (mode slots).
2. **Recycle cash** étendu : toujours short après les winners → fallback purge idle (mode cash).
3. **Option A (friction affichée)** : chaque position expose `entryFrictionUsd = −qty × (prix effectif − mid du buy)` (≈ −0.024$) ; dashboards affichent le PnL mtm + « dont friction » (comptabilité inchangée, lecture claire).

Ordre du tick : ladder (takes/rug/moon) → **purgeIdle** → sweep 102$ → recycle cash → entrées 1$.

**Tests (17 sur maxscalp, 118 au total)** : purge au cap (5 purged oldest-first, slot re-acheté), épargne des gagnants / token vu récemment / lot frais, friction exacte depuis le buy réel.

Restart à chaud (sans reset DB) → le churn prend la main sur les 90 lots plats de la nuit dans les premiers ticks.

### Run 3'' — maxscalp v5 : zone d'exclusion des rugs

Règle anti-re-rug (demandée niko) : quand un coin rugue (purge `rug exit`, mark ≤ 60% de l'entrée, jamais profité), son **ticker exact** est mis en zone d'exclusion (kv `maxscalpRugTickers`). Tout listing futur portant ce même ticker exact est refusé (log `reject`) — les mèmes dupliqués (SOLCASINO ×4, TRUMP ×6 au run 1) ne bouffent plus de munitions.

N'est PAS blacklisté : moon stop (lot profité), idle exit, recycle cash — uniquement la purge rug.
Permanence dans la session (pas de TTL).

**Tests (19 sur maxscalp, 120 au total)** : rug → exclusion (helper `blacklistRug`, re-achat refusé, autre ticker acheté), moon stop → pas d'exclusion.

### Run 3 — bilan final (16 h, v3→v5) : le NAV nocturne était fictif

| | |
|---|---|
| NAV finale | **69.67$** (realized −24.10$ sur 126 sells, 159 lots achetés) |
| Take ladder | **+14.6$** sur 17× — le seul moteur positif |
| Rug exits | −34.6$ sur 43× (95% des pertes, déferlante post-restart(churn)) |
| Idle exits | −2.6$ sur 25× (neutre/friction) |
| Sweep 102$ | jamais déclenché |
| Exclusion zone | 32 tickers |

Le plateau NAV 101.4$ exactement pendant 6 h de nuit = **marks gelés** (feu tournant OHLCV sans données) — le churn a ensuite révélé la vérité : une grande partie des lots déjà ruggés. Deux fautes comptables ont masqué les pertes :
1. Les sells sur marks priés au prix d'entrée (fallback) créaient du cash de fiction.
2. Le churn purgeait sur des marks fictifs juste après un restart.

Leçon majeure : **pas de vente sur un mark qui n'est pas frais** — sinon le paper book s'auto-illusionne.

### Run 4 — maxscalp v6 : anti-fiction comptable + warmup

Base vierge (100$, 0 position), deux garde-fous de vérité :
1. **Sell interdit sur mark pas frais** (`sellMarkFreshS 300`) : take ladder / rug exit / moon stop / idle / recycle ne s'exécutent que si le prix source a <5 min (discovery snapshot, OHLCV 1m ou tick récent). Les appels constatent l'âge de la source (`priceWithAge`) — plus jamais d'entrée contrôlée à x1.025 côté vente.
2. **Dead listing purge** (`deadLotMinAgeMin 60`, `deadHaircutPct 0.5`) : lot sans mark frais depuis ≥60 min → vendu au **dernier prix connu** (peu importe son âge) ou, faute de tout prix, **amorti à −50% du coût** — jamais au prix d'entrée. Raison `dead exit`.
3. **Warmup au boot** : `repriceAll()` re-pricé 100% des positions via OHLCV (80 ms/mint) AVANT le premier tick de churn — plus de déferlante de purges sur des marks morts.

`priceOf` passe sur une cascade honnête : snapshot discovery (frais) → dernier tick connu en DB (âge mesuré) → prix d'entrée (marqué fictionnel, vendable jamais).

**Tests (22 sur maxscalp, 123 au total)** : rug sans mark frais → aucun sell ; dead exit au dernier prix connu (0.004$ ≠ 0.01$ entrée) ; dead exit amputé à 50% sans aucun prix ; repriceAll OK.

### Run 4 bis — crash de la comptabilité : la fausse lune de NIVRA (→ v7)

~5 h30 dans le run, NIVRA (1$ investi, entrée 8.39e-9) a vu son pool **relancé par le dev** : la bougie OHLCV (pool `6igB4b…`, réserve ~104$, FDV 42.8k$) cote le mark ×5225 l'entrée (4.28e-5). Effet dominos ferme:
1. Ladder + `recycle cash` "réalisent" sur ce mark : **un sell de `recycle cash` matérialise 2229$ de cash papier** (0.48$ de stake liquidé ×4600), mucron ×28 et 安安 dans la même vague (même mécanisme) ;
2. le NAV s'emballe → sweep 60$ (30 × 2$), part sur des gains fictifs ;
3. NAV affiché 4736$ = 2205$ cash fictif + NIVRA "valeur" 2459$.

**Leçon v6 n'était pas suffisante** : la garde « mark frais » ne sauve pas d'un mark frais émanant d'une pool-mule — la fraîcheur n'est pas la légitimité.

**v7 — garde anti-fausse lune** :
1. **Migration `price_ticks.src`** ('discovery' | 'candle') : l'origine de chaque tick est tracée en DB. Les ventes "candle-sourced" sont les seules contraintes par le contrôle de cohérence.
2. **`priceWithAge`** cap les ventes (et le sizing du ladder/NAV) : bougie > `maxCandleJump 4` × dernier liquide connu discovery → le prix retourné devient ce dernier prix discovery ; clamp dur **`maxEntryMultiple 20`** : aucun « gain » >20× l'entrée ne compte (le paper ignore la fiction au-delà).
3. **`partialSell.sellPriceGuard` double sécurité** : même si un prix brut s'infiltre (rotate bar.close), la vente est clampée au même régime.
4. **`simulateSell` profondeur**: `liquidityUsd` pool = dernier liquide discovery connu (sinon `minLiquidityUsd 5000$`) — plus de liquidité auto-référentielle `sellQty×price` (le pool ne rétrécit pas parce qu'on vend).

**Tests (25 maxscalp, 126 total)** : NIVRA ×5225 → vente au prix discovery, pas de cash fiction ; bougie légitime ×2.1 → honorée ; candle ×10 000 sans discovery → clamp entry×20 ; chain x2 inchangée (les doubles légitimes passent à travers le guard).

### Run 5 — 18 h : NAV 72.06$ ; le churn est le métronome, mais la loterie s'est endormie

- **Churn** : 211 `idle exit` façon (re-financent 178.8$), 9 `dead exit` (7.3$), 4 rug exit, 2 moon stop (1.3$).
- **Ladder à plat** : seulement 2 `take ladder` (2.26$) — la nuit sans entrées (0:11→15:00, discovery muet) a déshydraté le pipeline : churnait sans re-semer.
- **Inset incident attribuable** : la clé démo CG a raté son quota mensuel (10k calls) → endpoint `/onchain` + error 10006 avec data vide en 200 → "0 candidats" muet. Trait-maintenant : maxscalp sur l'API publique + page 2 de `new_pools` + détection d'erreur visible (commit `3295f82`).
- swept 0 (jamais >102$ NAV), 1 ticker blacklisté.

### Post-mortem run 6 (analyse à NAV 49$) → v8

- **L'anatomie du −51$ n'est PAS un pick raté** : le pire symbole du run perd −1.21$ (PIERRE). Le vrai découpage : churn `idle exit` 511 lots → **−39.74$** (−0.078$/lot), fees jup sur 1 264 trades → **−21.66$**, moteurs positifs (recycle +7.12$, moon stop +4.75$, 4 takes +3.45$) → +15.3$. Les pertes sont une **taxe de rotation** (12% de roundtrip sur chaque lot de 1$), pas la sélection.
- **Révélation par bande de vol5m à l'entrée** (380 syms) : vol5m < 8k −19.9$, 8-20k −10.2$, **≥ 20k = seule bande positive** (+0.35$ sur 31 syms). Contrefactuel : filtrer ≥ 20k ≈ tout acheter = +30$ de delta.
- **Fausse piste écartée** : le `impactBps` de sell (≈4.8 bps sur 1.2$) est négligeable — pas de patch paper-broker. Les micro-frais fixes (jup 2% + $0.015 SOL/side) structurés en % du lot de 1$ font ~12% de roundtrip.
- **v8** : `minVol5mUsd: 20_000` à l'entrée. 127/127.question test ajouté (vol < 20k refusé, = limite accepté).
- **Leçon** : sur la loterie à micro-lots, la question "quoi acheter" compte moins que "combien de fois on paie le péage" — quand les moteurs prennent (0.7% de take rate ce run vs 4.4% run 4) le churn devient fonds de roulement de Jupiter.

### v9 / v9.1 — réarmer : frais réels, purge legacy, budget gecko (perdant 40-46$)

- **feeBps 200 → 45** : la "platform fee Jupiter" 2% n'existe pas par défaut pour le router retail ; l'alternative honnête est la LP fee pool (Raydium/Meteora 25-60 bps). Le roundtrip passe de ~12% → ~7% — LE principal gisement du fusible d'ancienneté churn paper.
- **Purge legacy one-shot** (`scripts/maxscalp-purge-legacy.ts` + `MaxScalper.purgeLegacy`): liquide tout lot antérieur à la coupe, mark frais → sinon dernier prix connu → sinon haircut 50%. Résultat run réel : seulement 4 lots (coût 1.01$) — l'idle exit avait déjà mangé l'essentiel; le reste est réparti dans les 43 pos qui décutent.
- **Constato findamental** : le NAS 6 retient ~40$ cassé (à 9-10 h) non pas par la vue du pick mais car 97% du capital était confiné dans des lots hérités à −7%/tour. Équation fix : en jeu 97%, cash 2%. Prévention future: sweep thruster octroi + purge.
- **Étincelle découverte : la double-throttle gecko public** — l'IP se take ~1 requête toutes les ~5-15 s, et toute rafale (3 paths discovery + 4-6 fetch bougies/tick) déclenche une cascade 429 ratée: le cooldown généra **"0 candidats" muet** pendant des heures sans jamais écrire "discovery KO" (les bougies mangent le throw). Vérité instrumentée par probe direct : req 1 ok → req 2 429.
- **v9.1 budget unique dans la feed** : portière `gateMs 4.6s` (12-13 req/min) partagée par discovery ET candles, discovery en **round-robin 1 path/refresh + cache persistant** (pages new_pools + h24 sort + `trending_pools` = la surface qui nourrissait les NTDA), cooldown 429 visible 60 s, 2 bougies/tick max. Le warmup boot passe à ~7 min (86 requêtes portières), les ticks ensuite flottent en 15 s.
- **v9.1 live** : discovery 3 candidats / 1 entrable → buy. NAV 38.8$.

### v10 — capital 500$, gate 50k$, lots par bande (en route)

- **Découpage final des 380 syms** par vol5m à l'entrée : 20-30k −0.278$/sym (LE cratère — des "pumps" naissants purs), 30-50k −0.03 (neutre), **50-100k +0.381$/sym, ≥100k +1.183$/sym** (les NTDA +8.8, MUNK +3.9, DAC +2.8, MIRIAM +11.9 vivaient tous dans ces bandes).
- **Config v10** : `minVol5mUsd 50_000`, `tradeUsd 3` (50-100k), `tradeUsdTurbo 5` + `turboVol5mUsd 100_000`, `maxPositions 40` (lots plus gros, plus de cash en munition), `initialUsd 500`, sweep 505$/5$.
- **Fair-play noté** : la bande ≥50k n>17/9 uniquement — v10 est une mesure, pas une certitude. Critère d'arrêt : si en 2-3h la bande turbo fait la même casse que 20-30k, le signal vol n'était pas le bon discriminateur.
- **DB neuve à 500$** (run 6 archivé `maxscalp-run6-churn.sqlite`, ~−51$ de churn/fees en 11h). Premier tick : FABLES/SO/ALLOX langé en turbo 5$ (vol5m 219k/209k/215k — exactement la bande visée).

### Run 7 (v10) — premier bilan 11 h : fortune 508.11$, la thèse turbo tient le choc

- **Capital** 500 → 503.11 NAV + 5 swept = **508.11 (+1.6%)** ; B&H SOL identique 500 (SPL plat sur la période french défense). Courbe serrée : min 496.8 / max 504.7.
- **Vitesse** : 33 buys / 123$ investis (21 lots 3$ sur la bande 50-100k, 12 turbo 5$) — flux ~3 entrées/h, la bande-passante discovery ≥50k est le testa stretching, pas le cash (75% du capital en réserve).
- **Premières statistiques par bande** : les 3 rugs (UHI, HOOT, COLLECTOOOR −1.30/−1.35/−1.39 = −4.04) sont tous venus de la bande 3$-50-100k ; **zéro rug sur les 12 turbo** (n=12, jeune échantillon mais cohérent avec la thèse).
- **Frais LP à 45 bps** : 0.58$ sur 129$ échangés (vs ~11$ équivalents au plafond fictif 2%()); slippage 3.45% buy / 3.97% sell (plancher vs run 6 : 6.3/12.5).
- **CT, l'idole du run** : lot turbo 5$ à prix 1.97e-4 → mark 7.23e-4 = **×3.67** (+11.71$ unrealized), ladder posicionning le 1er take au ×2 (19.1$ requis, 16.1$ atteints) — l'algorithme courtise mais n'est pas encore payé.
- **La book v10** : 30/40 pos, 112.43$ coût → 125.10 mark (+12.67 unrealized), worst-case des losers ~−0.49 (faible vs le fiable intense run 6).
- **Le programme de poursuite** : (1) si ×2 prends d'être — les takes turbo devraient payer la facture des rugs 3$ ; (2) Documents des events du passage des ruggers pour modifier le fichier take (les rug-exit -1.3$ × 6 en bandes 50-100k = deliver 8$) au seuil de rug exit...

### v10.1 & v10.2 — la bande-passante, puis le garde-fou fake-pump (STREAM)

- **v10.1 : seuil d'entrée 50k → 30k$** (la bande 30-50k = neutre −0.03$/sym sur 380 syms ; jamais sous 30k, le cratère 20-30k reste interdit). Motif : le goulot était la bande-passante discovery (~3 entrées/h à ≥50k → 75% du capital assis), pas les slots (churn libère 5/tick + dead exit 60 min + recycle cash).
- **v10.1 live ~13h** : NAV dérivé 503 → 490 avec STREAM qui affiche un « gros PnL ». Analyse demandée : **legit ?**
- **STREAM non-legit — signature exacte du fake** (mint `BEywMF9JE6M1YWAKJqWxNC5EtDWSjNykTS3kqBwbxJgP`, lot turbo 5$, vol5m 632k$ à l'entrée) :
  - 08:06 → 10:01 : grind propre +50% (1.32e-4 → 1.98e-4) ;
  - **10:02 : UN seul tick discovery ×37** (1.98e-4 → 7.36e-3) puis **gel au millième pendant 1h** — un vrai pump s'imprime en escalade multi-ticks avec volume ; pool relancée par son dev = un saut vertical suivi d'un plateau ;
  - conséquences : lot marqué **267.82$ dans le NAV** (fiction), le take ladder avait encaissé 0.41$ sur le saut (protectif par accident), et le churn « dead listing » était désamorcé car le mark gelé est ré-émis **frais** (âge 0) à chaque refresh.
- **CORRECTION DU VERDICT (v10.2bis, probe gecko `tokens/{mint}/pools`)** : STREAM n'était **PAS un fake** — **une seule pool, créée 05:57 AVANT l'entrée (08:06)**, et la vol5m au moment du saut = **72k$** (buy baleine ~55k$ réel dans une pool de 128k de liq, cohérent mécaniquement: monter le prix ×37 demande ~60k$ d'achats). Le « gel au millième 3h » n'est PAS une signature de manipulation: après un buy baleine qui aspire le carnet, plus personne ne trade → le prix coté gèle. **Le pump était réel**, le moon-stop au clamp entry×20 (95.72$) = **cash réels** (pool liquide 128k, sell de 268$ sans impact). Le leçon: le saut vertical n'est suspect que si (a) la pool qui cote est née APRÈS l'opening (relaunch prouvé par la probe), ou (b) AUCUNE bougie/conf volume ne le soutient. Le gel seul ne prouve rien.
- **v10.2 : garde-fou fake-pump** (trois paramètres: `fakePumpJump 4` ×, `fakePumpStallMs 15 min`, `fakePumpHaircut 0.5`) :
  - détection par position : mark courant ≥ 4× le dernier niveau différent, **aucune bougie OHLCV** après le début du plateau, plateau gelé ≥ 15 min → **FAKE PUMP PURGE** : vente complète au dernier niveau légitime ×0.5, blacklist du ticker ;
  - la bougie qui confirme le niveau d'une pool née APRÈS l'ouverture des lots = relaunch → purge quand même (`getTokenMeta.poolCreatedMs`, sinon probe feed `tokenPools(mint)` qui renvoie les naissances de toutes les pools qui cotent le mint) ;
  - purge en priorité absolue dans la boucle ladder avant moon/rug/takes;
  - pièges du chantier : `.all()` sans bind → mint = NULL → 0 rows silencieux, et le binding `undefined` de src fait ROLLBACK la transaction sans trace (les tests le font vieillir avec ticks datés pour le burst age de 18 min).
- **Le faux débat « cash fiction »**: le moon-stop STREAM du boot (trade id 82, puis 90/91/92 après la restauration chirurgicale du lot) vendait au clamp entry×20 = 2.64e-3 — **en dessous du vrai prix de pool 7.36e-3**: c'était une sortie conservatrice et RÉELLE, pas une fiction. Les purges du ledger (ids 74/87/88/89 puis re-revente propre) se sont soldées à l'identique: cash ~288$, STREAM liquidé, réalisé +90$ pour le token. Enseignements: (1) restaurer un lot en chirurgie sans restaurer son `LadderState` KV fait repartir le cycle take→moon proprement (comportement accepté); (2) le NAV « 501$ » de 14:27 était plâtré par ~90$ de marks gelés-faux d'autres tokens (les vrais morts de l'après-midi), pas par STREAM.
- **v10.1 (30k) autopsie et RVF**: l'après-midi 30-50k live = 27 `rug exit (rotate)` pour −86.74$, ~−3.2$/lot (bands run-6: neutre −0.03$/sym à l'échantillon → la mémoire d'échantillon ne survit pas au marché live). **Retour 50k** et leçon générale: la bande 30-50k ne se retouche qu'avec un échantillon live ≥ ~2 d de preuve contraire, pas avec l'archive.

### v11 — le sweep ne prélève plus que le capital garanti + reset 200$

- **Run 7 clôture à 479.6$ de fortune réelle (−4.1%)** : takes/moon STREAM +93$, ruggers 30-50k −95$, zombie book 13 lots (~41$ coût, marks morts).
- **Le sweep change de base (leçon du run 7)** : l'ancien trigger NAV-mark a prélevé 160$ pendant l'ère des marks gelés-faux (une part de cette fortune n'existait pas). v11: trigger = **cash + max(0, réalisé net)** — les marks flottants, mêmes ×37, ne font plus sortir un centime; le take ×1 qui réalise du profit devient le déclencheur naturel du prélèvement. `sweepTriggerUsd = initialUsd + 5` (dérivé), réglable par override.
- **Reset à 200$** : DB archivée (`maxscalp-run7-stream.sqlite`), `MAXSCALP_INITIAL_USD=200` (env, défaut 500) — le trigger sweep devient 205$. La question du run 8: le take ladder (prouvé sur STREAM) suffit-il à faire vivre un capital 200$ sur la bande ≥50k pure, sans que les ruggers ne l'entament plus vite que les moons ne la remplissent.

---

## Leçons générales (running notes)

- Sur les mèmes neufs, **le stop loss classique est le pire geste** : le bruit dip > tout ROI de 2 min. Mieux vaut un filet de purge « rug » (−40%) + verrouiller du profit par prélèvements échelonnés.
- L'impact des frais paper (2%) + slippage (2.5%) : chaque lot paye ~4.5% → un ×2 réel exige un pump ≈ ×1.09 avant de « payer ». Les takes à 1.2$ d'un lot ×2 couvrent ainsi ~2× le coût du lot — les chiffres ci-dessus les incluent déjà.
- Le dashboard est le juge de paix : NAV, trade journal, big-losers/rug table — regarder `localhost:4102` pour les stats, `localhost:4101` pour le comparatif de stratégie.
- Un run de 56 min n'est **pas** une conclusion statistique — itérer jusqu'à ce que plusieurs runs de 2 h+ concordent avant de laisser tourner la nuit.

## Prochaines expériences candidates (à arbitrer après le run 2)

1. Recyclage des plats : lots > 45 min et −20~−40% ni rug ni pump → sortie douce pour recycler le cash (vs laisser pourrir).
2. Anti-rug d'entrée agressif : refuser les listings avec volume/pool asymétrique (cf. gecko bars) — à tester si la purge τ40% n'est pas suffisante.
3. Double anti-Solcasino : détection « même nom, plusieurs mints distincts » (les 4 Solcasino du run 1 sont 4 mints différents — la famille ne se réfpre pas maintenant craqués par cap nom).
