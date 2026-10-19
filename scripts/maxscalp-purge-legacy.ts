/**
 * v9: grand nettoyage one-shot des lots hérités d'une config antérieure.
 * Usage: npx tsx scripts/maxscalp-purge-legacy.ts <avant_ms_ou_heures>
 *   - "6.5h" → lots ouverts il y a plus de 6.5h
 *   - 1792420000000 → lots ouverts avant ce ts
 * Liquide au mark frais, sinon dernier prix connu, sinon haircut 50% (dead exit).
 */
import { openDb, closeDb } from "../src/state/db.js";
import { migrate } from "../src/state/migrations.js";
import { paperCashGet } from "../src/portfolio/portfolio.js";
import { listPositions } from "../src/state/portfolio-repo.js";
import { maxscalpDefaults, MaxScalper } from "../src/gmgn/maxscalp.js";
import type { DiscoveryFeed } from "../src/gmgn/discovery.js";

const stub: DiscoveryFeed = {
  refresh(): Promise<never> {return Promise.reject(new Error("purge: pas de feed"));},
  latestCandle(): Promise<null> {return Promise.resolve(null);},
  snapshotPrice(): null {return null;},
};

function cutBefore(arg: string | undefined): number {
  if (arg === undefined) {throw new Error("usage: <6.5h | ts_ms | -Xh>");}
  if (arg.startsWith("-")) {return Date.now() - parseFloat(arg.slice(1, -1)) * 3_600_000;}
  const m = /^([\d.]+)h$/.exec(arg);
  if (m) {return Date.now() - parseFloat(m[1]) * 3_600_000;}
  return Number(arg);
}

const db = openDb({ path: "data/maxscalp.sqlite" });
migrate(db);
const before = cutBefore(process.argv[process.argv.length - 1]);
const ouverts = listPositions(db, true).filter((p) => p.openedMs < before);
const cout = ouverts.reduce((a, p) => a + p.qty * p.avgEntryUsd, 0);
console.log("lots pré-coupe:", ouverts.length, "| coût en jeu", cout.toFixed(2), "$");

const s = new MaxScalper({ db, cfg: maxscalpDefaults(), feed: stub });
const cashBefore = paperCashGet(db, 0);
const sold = await s.purgeLegacy(before);
const cashAfter = paperCashGet(db, 0);
console.log("vendu", sold, "lots | cash", cashBefore.toFixed(2), "$ →", cashAfter.toFixed(2), "$");
const after = listPositions(db, true);
console.log("positions restantes:", after.length, "| mark total:", after.length ? `${after.reduce((a, p) => a + p.qty * p.avgEntryUsd, 0).toFixed(2)}$ (coût)` : "0");
closeDb(db);
