// Spec 020 platform marker registry. Resolves a `platform` tag (e.g.
// "c64", "c1541") to the matching annotation tables. Downstream
// renderers consume these to emit platform-correct labels for ZP /
// I/O / ROM addresses. Each platform table grows independently;
// stubs are fine for v1.

import { c64PlatformKnowledge, type PlatformKnowledge } from "./c64.js";
import { c1541PlatformKnowledge } from "./c1541.js";

// Spec 048: scope reduction. Project name is C64RE, not C=6502RE.
// Only c64 + c1541 supported; other 6502 platforms removed from
// the registry. ArtifactRecord.platform schema still accepts the
// legacy enum values so historical projects keep parsing.
export type PlatformTag = "c64" | "c1541";

const PLATFORM_TABLE: Record<PlatformTag, PlatformKnowledge | undefined> = {
  c64: c64PlatformKnowledge,
  c1541: c1541PlatformKnowledge,
};

export function getPlatformKnowledge(platform?: PlatformTag): PlatformKnowledge {
  if (!platform) return c64PlatformKnowledge;
  return PLATFORM_TABLE[platform] ?? c64PlatformKnowledge;
}

export type { PlatformKnowledge } from "./c64.js";
