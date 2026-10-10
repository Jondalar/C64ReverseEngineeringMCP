// Spec 898 D5 — which machine a render, an analysis or a lookup is for.
//
// In order: the platform the caller names → the artifact record's `platform` (Spec 020) →
// the project's default (`knowledge/project.json` → `platform`, set by project_init) → c64.
// One function, so the disassembly doors, the analysis door, inspect_address_range and
// c64ref_lookup cannot each grow their own order.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM_TAGS, type PlatformTag } from "../platform-kb/schema.js";

export type PlatformSource = "argument" | "artifact" | "project" | "default";

export function isPlatformTag(value: unknown): value is PlatformTag {
  return typeof value === "string" && (PLATFORM_TAGS as readonly string[]).includes(value);
}

/** The project's default machine, or undefined when the project names none. */
export function projectDefaultPlatform(projectDir: string | undefined): PlatformTag | undefined {
  if (!projectDir) return undefined;
  const path = join(projectDir, "knowledge", "project.json");
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { platform?: unknown };
    return isPlatformTag(raw.platform) ? raw.platform : undefined;
  } catch {
    return undefined;
  }
}

export interface ResolvedPlatform {
  platform: PlatformTag;
  source: PlatformSource;
}

/**
 * `explicit` is the tool argument (a tag; "none" is a rendering switch, not a machine, and is
 * the caller's to handle). `artifactPlatform` is the artifact record's marker — only the four
 * tags the store knows count; `c128` / `other` fall through to the next rule.
 */
export function resolvePlatform(input: {
  projectDir?: string;
  explicit?: PlatformTag | undefined;
  artifactPlatform?: string | undefined;
}): ResolvedPlatform {
  if (input.explicit) return { platform: input.explicit, source: "argument" };
  if (isPlatformTag(input.artifactPlatform)) return { platform: input.artifactPlatform, source: "artifact" };
  const fromProject = projectDefaultPlatform(input.projectDir);
  if (fromProject) return { platform: fromProject, source: "project" };
  return { platform: "c64", source: "default" };
}

/**
 * Where a tool that must guess a load address for a headerless block starts guessing (D6):
 * the first is the primary guess. The VIC-20 has three, one per memory configuration
 * (unexpanded, +3K, +8K and up); the TED machines one; the C64 is `$0801`. The 1541 has no
 * BASIC start, so it offers none. A PRG header always wins over any of them.
 */
export function defaultLoadAddresses(platform: PlatformTag): number[] {
  switch (platform) {
    case "vic20": return [0x1001, 0x0401, 0x1201];
    case "plus4": return [0x1001];
    case "c1541": return [];
    default: return [0x0801];
  }
}

/** One sentence naming the load addresses a foreign machine's programs usually carry, for a refusal that asks for `load_address`. Undefined for the C64 / 1541, whose refusals stay as they were. */
export function loadAddressOffer(platform: PlatformTag | undefined): string | undefined {
  if (platform === "vic20") return "A VIC-20 program usually loads at $1001 (unexpanded), $0401 (+3K) or $1201 (+8K and up); a raw cartridge image at $A000.";
  if (platform === "plus4") return "BASIC on the C16 / C116 / Plus/4 starts at $1001.";
  return undefined;
}

/**
 * A cartridge image's own autostart signature (Spec 898 D9). Both are what the KERNAL
 * compares, read off the instructions: the VIC-20 KERNAL tests `$A004-$A008` against the
 * bytes `$41 $30 $C3 $C2 $CD` (`A0` then CBM with the high bit set); the TED KERNAL tests
 * `$8007-$8009` against `$43 $42 $4D` (CBM). The offset is the image's, so a headerless
 * image placed at the address reads the same bytes the KERNAL does.
 */
export interface CartridgeSignature {
  platform: "vic20" | "plus4";
  /** Where the KERNAL looks for it, and so where the image is placed. */
  loadAddress: number;
  /** Byte offset of the signature inside the image. */
  offset: number;
  bytes: number[];
  /** The signature as the evidence line prints it. */
  name: string;
}

const CARTRIDGE_SIGNATURES: readonly CartridgeSignature[] = [
  { platform: "vic20", loadAddress: 0xa000, offset: 4, bytes: [0x41, 0x30, 0xc3, 0xc2, 0xcd], name: "A0CBM ($41 $30 $C3 $C2 $CD)" },
  { platform: "plus4", loadAddress: 0x8000, offset: 7, bytes: [0x43, 0x42, 0x4d], name: "CBM ($43 $42 $4D)" },
];

/** The cartridge signature the leading bytes of an image carry, if any. */
export function cartridgeSignatureOf(head: Uint8Array): CartridgeSignature | undefined {
  return CARTRIDGE_SIGNATURES.find((sig) => sig.bytes.every((b, i) => head[sig.offset + i] === b));
}

/** How many leading bytes `cartridgeSignatureOf` needs. */
export const CARTRIDGE_SIGNATURE_HEAD = 16;

export const MACHINE_NAMES: Record<PlatformTag, string> = {
  c64: "Commodore 64",
  c1541: "1541 drive",
  vic20: "VIC-20",
  plus4: "C16 / C116 / Plus/4 (TED)",
};
