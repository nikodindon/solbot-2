import { describe, expect, it } from "vitest";
import { loadConfig, parseConfigRaw } from "../../src/config/loader.js";
import { effectiveMode } from "../../src/config/schema.js";

describe("config", () => {
  it("par défaut -> mode paper, dashboard 4100, univers JUP/BONK", () => {
    const cfg = parseConfigRaw({});
    expect(cfg.mode).toBe("paper");
    expect(cfg.dashboard.port).toBe(4100);
    expect(cfg.risk.min_trade_usd).toBe(1.5);
    expect(cfg.risk.max_trade_usd).toBe(3);
    expect(cfg.risk.gas_reserve_sol).toBeCloseTo(0.005, 6);
    expect(cfg.costs.edge_multiplier).toBe(3);
    expect(cfg.universe.tokens.map((t) => t.symbol)).toEqual(["JUP", "BONK"]);
    expect(cfg.funding.min_sol_usd).toBe(1);
    expect(cfg.funding.min_usdc_usd).toBe(5);
  });

  it("échoue sur une clé inconnue (strict)", () => {
    expect(() => parseConfigRaw({ risk: { unknown_rule: 1 } })).toThrow();
  });

  it("échoue sur des valeurs hors bornes", () => {
    expect(() => parseConfigRaw({ risk: { max_trade_usd: 50 } })).toThrow();
  });

  it("live sans confirm_live -> erreur", () => {
    expect(() => parseConfigRaw({ mode: "live", confirm_live: false })).toThrow(/confirm_live/);
  });

  it("live avec confirm_live -> ok", () => {
    expect(parseConfigRaw({ mode: "live", confirm_live: true }).mode).toBe("live");
  });

  it("précedence du mode : CLI > env > yaml", () => {
    expect(effectiveMode("dry_run", "live", "paper")).toBe("dry_run");
    expect(effectiveMode(undefined, "live", "paper")).toBe("live");
    expect(effectiveMode(undefined, undefined, "paper")).toBe("paper");
  });

  it("loader yaml de l'exemple (sans pollution d'env vitest)", () => {
    delete process.env.MODE;
    const loaded = loadConfig({ rootDir: process.cwd() });
    expect(loaded.mode).toBe("paper");
    expect(loaded.usedExample).toBe(true);
  });
});
