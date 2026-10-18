/* solbot2 dashboard — client read-only (SSE + JSON polling de secours). */
"use strict";

const $ = (id) => document.getElementById(id);
const fmtUsd = (v, d = 3) => (v === null || v === undefined || (typeof v === "number" && !isFinite(v))) ? "—" : `${v >= 0 ? "" : "−"}$${Math.abs(v).toFixed(d)}`;
const fmtPct = (v, d = 1) => (v === null || v === undefined || !isFinite(v)) ? "—" : `${v.toFixed(d)}%`;
const agoOf = (ts) => !ts ? "—" : Math.round((Date.now() - ts) / 1000) < 60 ? `${Math.round((Date.now() - ts) / 1000)}s` : `${Math.round((Date.now() - ts) / 60000)}min`;
const symFix = (s) => s === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" ? "USDC" : s;

let chart = null;
let lastEquityFetch = 0;

function renderState(s) {
  $("mode").textContent = s.mode;
  const dd = s.nav.drawdownPct;
  $("nav").textContent = fmtUsd(s.nav.usd);
  $("nav").className = dd >= 30 ? "neg" : dd >= 15 ? "" : "";
  $("cash").textContent = fmtUsd(s.nav.cashUsd, 2);
  $("pos").textContent = `${s.portfolio.positions.length} / ${fmtUsd(s.nav.positionsUsd, 2)}`;
  $("dd").textContent = fmtPct(dd);
  $("dd").className = dd >= 30 ? "neg" : "";
  $("realized").textContent = fmtUsd(s.nav.realizedTotalUsd);
  $("realized").className = s.nav.realizedTotalUsd >= 0 ? "pos" : "neg";
  $("swept").textContent = fmtUsd(s.nav.sweptUsd ?? 0, 2);
  $("wealth").textContent = fmtUsd((s.nav.usd ?? 0) + (s.nav.sweptUsd ?? 0), 2);
  if (s.scalper) {
    const swapsKpi = document.getElementById("swaps").parentElement;
    swapsKpi.querySelector("label").textContent = "Takes réalisés";
    $("swaps").textContent = `${s.scalper.takes} / ${fmtUsd(s.scalper.takeUsd, 2)}`;
    $("swaps").title = s.scalper.purges ? `${s.scalper.purges} lots purgés (rug/moon/idle/dead)` : "";
    const allocKpi = document.getElementById("alloc").parentElement;
    allocKpi.querySelector("label").textContent = "En jeu";
    $("alloc").textContent = `${s.scalper.expoPct}%`;
    $("alloc").title = `expo ${fmtUsd(s.scalper.expoUsd, 2)}$ / fortune ${fmtUsd(s.scalper.expoUsd + (s.nav.sweptUsd ?? 0), 2)}$`;
  } else {
    $("alloc").textContent = s.allocation.strategy ?? "—";
    $("swaps").textContent = String(s.nav.swapsRemaining);
  }
  const bhDur = s.benchmarks.bhUsd - s.nav.initialCapitalUsd;
  $("bh").textContent = fmtUsd(s.benchmarks.bhUsd, 2);
  $("bh").title = `Δ vs initial: ${fmtUsd(bhDur)}`;

  $("fresh").textContent = s.fresh ? "données fraîches" : `stale (> ${s.clock.intervalS}s)`;
  renderCosts(s.portfolio.costs);
  renderGuards(s.guards);
  renderPositions(s.portfolio.positions);
  renderMarkets(s.markets);
  renderTradesFooter();

  if (Date.now() - lastEquityFetch > 30_000) {lastEquityFetch = Date.now(); refreshEquity();}
}

function renderCosts(c) {
  const rows = [
    ["frais Jupiter", fmtUsd(c.jupFeeUsd)],
    ["frais SOL (base+priority)", fmtUsd(c.solFeeUsd)],
    ["slippage réalisé", c.realizedSlippageUsd >= 0 ? fmtUsd(c.realizedSlippageUsd) : "−" + fmtUsd(-c.realizedSlippageUsd)],
    ["rent ATA", fmtUsd(c.ataRentUsd)],
  ];
  $("costs").querySelector("tbody").innerHTML = rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join("");
}

function renderGuards(g) {
  const rows = [
    ["kill-switch", g.killSwitchAtMs ? `ACTIF depuis ${agoOf(g.killSwitchAtMs)}` : "armé"],
    ["fichier STOP", g.stopFile ? "PRÉSENT (entrées bloquées)" : "absent"],
    ["pause journalière", g.pausedUntilMs && Date.now() < g.pausedUntilMs ? `jusqu'à ${new Date(g.pausedUntilMs).toISOString().slice(11, 16)}Z` : "inactive"],
    ["limite journalière", `${g.dailyLossLimitPct}% (ancre NAV ${fmtUsd(g.daily.anchorNavUsd, 2)})`],
  ];
  $("guards").querySelector("tbody").innerHTML = rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join("");
}

function fmtPrice(v) {
  if (!(v > 0)) {return "—";}
  return v >= 0.01 ? `$${v.toPrecision(6)}` : `$${v.toExponential(2)}`;
}

function renderPositions(ps) {
  const tb = $("positions").querySelector("tbody");
  if (!ps.length) { tb.innerHTML = `<tr><td colspan="8" style="color:var(--dim)">aucune position</td></tr>`; }
  else {
    tb.innerHTML = ps.map((p) => {
      const stops = [p.stopLossPrice ? `SL ${p.stopLossPrice.toPrecision(4)}` : null, p.takeProfitPrice ? `TP ${p.takeProfitPrice.toPrecision(4)}` : null, p.trailingStopPrice ? `TS ${p.trailingStopPrice.toPrecision(4)}` : null].filter(Boolean).join(" · ") || "—";
      return `<tr>
        <td>${symFix(p.symbol)}</td>
        <td>${p.qty.toPrecision(6)}</td>
        <td>${fmtPrice(p.avgEntryUsd)}</td>
        <td>${fmtPrice(p.markUsd)}</td>
        <td>${fmtUsd(p.valueUsd, 2)}</td>
        <td class="${p.unrealizedPnlUsd >= 0 ? "pos" : "neg"}">${fmtUsd(p.unrealizedPnlUsd)}${p.entryFrictionUsd ? `<div class="dim">${fmtUsd(p.entryFrictionUsd)} friction</div>` : ""}</td>
        <td>${stops}</td>
        <td>${agoOf(Date.now() - p.ageMs)}</td>
      </tr>`;
    }).join("");
  }
}

function renderMarkets(ms) {
  $("markets").querySelector("tbody").innerHTML = ms.map((m) => `<tr>
    <td>${m.symbol}</td>
    <td>${m.priceUsd ? m.priceUsd.toPrecision(6) : "—"}</td>
    <td>${m.liquidityUsd ? fmtUsd(m.liquidityUsd, 0) : "—"}</td>
    <td>${m.lastTickMs ? agoOf(m.lastTickMs) : "—"}</td>
  </tr>`).join("");
}

let cachedTrades = [];
async function refreshShadows() {
  try {
    const r = await (await fetch("/api/shadows")).json();
    $("shadows").querySelector("tbody").innerHTML = (r.shadows || []).map((sh) => {
      const delta = sh.score24hUsd === null ? "—" : fmtUsd(sh.score24hUsd);
      return `<tr>
        <td>${sh.shadow}</td>
        <td>${sh.navUsd === null ? "—" : fmtUsd(sh.navUsd, 2)}</td>
        <td class="${sh.score24hUsd > 0 ? "pos" : sh.score24hUsd < 0 ? "neg" : ""}">${delta}</td>
        <td>${sh.trades24h}</td>
        <td>${sh.allocated === null ? "—" : sh.allocated ? "◀ capital" : ""}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="5" style="color:var(--dim)">aucun shadow actif</td></tr>`;
  } catch { /* silent */ }
}

async function refreshTrades() {
  try {
    const r = await (await fetch("/api/trades?limit=30")).json();
    cachedTrades = r.trades || [];
    const tb = $("trades").querySelector("tbody");
    tb.innerHTML = cachedTrades.map((t) => `<tr>
      <td>${new Date(t.tsMs).toISOString().slice(11, 19)}</td>
      <td>${symFix(t.symbol)}</td>
      <td>${t.side === "buy" ? "achat" : "vente"}</td>
      <td>${t.qty.toPrecision(6)}</td>
      <td>${fmtUsd(t.priceUsd, 4)}</td>
      <td>${fmtUsd((t.jupFeeUsd || 0) + (t.solFeeUsd || 0) + (t.ataRentUsd || 0), 4)}</td>
      <td>${fmtUsd(t.spendUsd, 2)}</td>
      <td class="${(t.realizedPnlUsd ?? 0) >= 0 ? "pos" : "neg"}">${t.realizedPnlUsd === null ? "—" : fmtUsd(t.realizedPnlUsd)}</td>
    </tr>`).join("") || `<tr><td colspan="8" style="color:var(--dim)">aucun trade</td></tr>`;
  } catch { /* silent */ }
}

async function refreshEquity() {
  try {
    const r = await (await fetch("/api/equity?limit=1000")).json();
    drawChart(r.points || []);
  } catch { /* silent */ }
}

function drawChart(points) {
  const el = $("chart");
  if (!window.uPlot || !el) {return;}
  if (points.length < 2) {
    el.innerHTML = `<em style="color:var(--dim)">au moins 2 points d'equity nécessaire…</em>`;
    return;
  }
  const xs = points.map((p) => p.tsMs / 1000);
  const nav = points.map((p) => p.navUsd);
  const cash = points.map((p) => p.cashUsd);
  const bh = points.map((p) => (p.benchmarkBhUsd === null || p.benchmarkBhUsd === undefined) ? null : p.benchmarkBhUsd);
  const data = [xs, nav, cash, bh];
  const opts = {
    width: el.clientWidth,
    height: 260,
    legend: { show: true },
    cursor: { show: false },
    series: [
      {},
      { label: "NAV", stroke: "#58a6ff", width: 2 },
      { label: "cash", stroke: "#8b949e", width: 1.5, dash: [4, 3] },
      { label: "B&H SOL", stroke: "#d29922", width: 1.5, dash: [2, 3], spanGaps: true },
    ],
    scales: { x: { time: true } },
    axes: [
      { stroke: "#30363d", grid: { stroke: "#21262d" }, ticks: { stroke: "#30363d" } },
      { stroke: "#30363d", grid: { stroke: "#21262d" }, ticks: { stroke: "#30363d" },
        values: (u, vals) => vals.map((v) => "$" + v.toFixed(2)) },
    ],
  };
  if (chart) {chart.destroy();}
  chart = new uPlot(opts, data, el);
}

async function refreshDecisions() {
  try {
    const r = await (await fetch("/api/decisions?limit=60")).json();
    $("log").innerHTML = (r.decisions || []).map(d => {
      const time = new Date(d.tsMs).toISOString().slice(11, 19);
      return `<li class="k-${d.kind}"><span class="meta">${time} · ${d.tickId}${d.strategy ? " · " + d.strategy : ""}</span>${escapeHtml(d.line)}</li>`;
    }).join("");
  } catch { /* silent */ }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function liveLog(d) {
  const time = new Date(d.tsMs).toISOString().slice(11, 19);
  const li = document.createElement("li");
  li.className = `k-${d.kind}`;
  li.innerHTML = `<span class="meta">${time} · ${d.tickId}${d.strategy ? " · " + d.strategy : ""}</span>${escapeHtml(d.line)}`;
  const log = $("log");
  log.prepend(li);
  while (log.children.length > 80) {log.removeChild(log.lastChild);}
}

function renderTradesFooter() {
  /* rafraichi via refreshTrades périodique */
}

function connectSSE() {
  const es = new EventSource("/api/stream");
  es.addEventListener("state", (ev) => {
    try {renderState(JSON.parse(ev.data));} catch { /* ignore */ }
  });
  es.addEventListener("decision", (ev) => {
    try {liveLog(JSON.parse(ev.data));} catch { /* ignore */ }
  });
  es.onopen = () => {const c = $("conn"); c.textContent = "SSE ✓"; c.className = "badge conn ok";};
  es.onerror = () => {const c = $("conn"); c.textContent = "SSE ⚠"; c.className = "badge conn ko";};
}

async function boot() {
  await refreshTrades();
  await refreshDecisions();
  await refreshShadows();
  try {
    const s = await (await fetch("/api/state")).json();
    renderState(s);
  } catch { /* SSE retry */ }
  connectSSE();
  setInterval(refreshTrades, 15_000);
  setInterval(refreshShadows, 30_000);
  setInterval(refreshDecisions, 60_000);
  window.addEventListener("resize", () => {if (chart) {chart.setSize({ width: document.getElementById("chart").clientWidth, height: 260 });}});
}

boot();
