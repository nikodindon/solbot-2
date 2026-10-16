import type { Strategy } from "./types.js";
import { MomentumStrategy, DEFAULT_MOMENTUM } from "./momentum.js";
import { MeanReversionStrategy, DEFAULT_MEAN_REVERSION } from "./mean-reversion.js";
import { DcaRotationStrategy, DEFAULT_DCA_ROTATION } from "./dca-rotation.js";
import type { StrategyConfig } from "../config/schema.js";

export interface BuiltStrategy {
  strategy: Strategy;
  enabled: boolean;
  weight: number;
}

/** Build the strategy set from config (only enabled ones participate). */
export function buildStrategies(cfg: StrategyConfig): BuiltStrategy[] {
  const out: BuiltStrategy[] = [];
  const m = cfg.momentum;
  if (m.enabled) {
    out.push({
      strategy: new MomentumStrategy({ ...DEFAULT_MOMENTUM, ...m.params }, m.weight),
      enabled: true,
      weight: m.weight,
    });
  }
  const mr = cfg.mean_reversion;
  if (mr.enabled) {
    out.push({
      strategy: new MeanReversionStrategy({ ...DEFAULT_MEAN_REVERSION, ...mr.params }, mr.weight),
      enabled: true,
      weight: mr.weight,
    });
  }
  const dca = cfg.dca_rotation;
  if (dca.enabled) {
    out.push({
      strategy: new DcaRotationStrategy({ ...DEFAULT_DCA_ROTATION, ...dca.params }, dca.weight),
      enabled: true,
      weight: dca.weight,
    });
  }
  return out.filter((b) => b.enabled);
}
