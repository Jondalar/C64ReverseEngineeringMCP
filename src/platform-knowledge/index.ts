// Spec 020 platform marker registry. Resolves a `platform` tag (e.g.
// "c64", "c1541") to the matching annotation tables. Downstream
// renderers consume these to emit platform-correct labels for ZP /
// I/O / ROM addresses. Each platform table grows independently;
// stubs are fine for v1.

import { c64PlatformKnowledge, type PlatformKnowledge } from "./c64.js";
import { c1541PlatformKnowledge } from "./c1541.js";

export type PlatformTag = "c64" | "c1541" | "c128" | "vic20" | "plus4" | "other";

const PLATFORM_TABLE: Record<PlatformTag, PlatformKnowledge | undefined> = {
  c64: c64PlatformKnowledge,
  c1541: c1541PlatformKnowledge,
  c128: undefined,
  vic20: undefined,
  plus4: undefined,
  other: undefined,
};

export function getPlatformKnowledge(platform?: PlatformTag): PlatformKnowledge {
  if (!platform) return c64PlatformKnowledge;
  return PLATFORM_TABLE[platform] ?? c64PlatformKnowledge;
}

export type { PlatformKnowledge } from "./c64.js";
