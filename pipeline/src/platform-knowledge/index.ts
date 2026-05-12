// Spec 048: pipeline-side platform-knowledge gateway. Returns
// platform-specific ZP / IO / ROM comment tables for the renderer.
// For c64 the renderer keeps its existing hardcoded tables; the
// gateway is queried only as a fallback / override layer.

import { c1541IoComments, c1541RomComments, c1541ZpComments } from "./c1541";

export type PlatformTag = "c64" | "c1541";

export interface PlatformOverrides {
  zp: Record<number, string>;
  io: Record<number, string>;
  rom: Record<number, string>;
}

const C1541: PlatformOverrides = {
  zp: c1541ZpComments,
  io: c1541IoComments,
  rom: c1541RomComments,
};

const C64_EMPTY: PlatformOverrides = { zp: {}, io: {}, rom: {} };

export function getPlatformOverrides(platform?: PlatformTag): PlatformOverrides {
  if (platform === "c1541") return C1541;
  return C64_EMPTY;
}
