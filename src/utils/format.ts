export function fmtUsd(v: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (v === null || v === undefined || !Number.isFinite(v)) {return "—";}
  const sign = opts.sign && v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}$`;
}

export function fmtBps(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) {return "—";}
  return `${v.toFixed(0)} bps`;
}

export function fmtQty(v: number | null | undefined, decimals = 4): string {
  if (v === null || v === undefined || !Number.isFinite(v)) {return "—";}
  if (v === 0) {return "0";}
  if (Math.abs(v) < 1e-6) {return v.toExponential(3);}
  return v.toFixed(decimals).replace(/\.?0+$/, "");
}

export function fmtAgo(tms: number | null | undefined, nowMs: number): string {
  if (!tms) {return "jamais";}
  const s = Math.max(0, Math.round((nowMs - tms) / 1000));
  if (s < 60) {return `${s}s`;}
  if (s < 3600) {return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;}
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}
