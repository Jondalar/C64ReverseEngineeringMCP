// Which cartridge are these bytes from?
//
// A listing of cartridge code names the I/O window ($DE00-$DFFF) for the CARTRIDGE: the register
// at $DE00 is EasyFlash's bank register on one board and GMod2's EEPROM/bank control on another.
// The type is not guessed from bytes — the .crt header carries it at offset $16, and
// `extract_crt` writes it into the manifest (`header.hardwareType`). This module answers "what
// type does the project have recorded for THESE bytes", in three steps, strongest first:
//
//   1. lineage — the bytes' artifact descends from a cartridge image or manifest;
//   2. place   — the file sits under the directory a manifest was extracted into;
//   3. project — every cartridge the project holds is one type, so the bytes can only be that.
//
// Several types in one project and none of the first two: unknown, and the caller names the
// window neutrally rather than pick one.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, sep } from "node:path";

interface ArtifactLike {
  id: string;
  path: string;
  title?: string;
  role?: string;
  kind?: string;
  sourceArtifactIds?: string[];
}

export interface CartridgeTypeHit {
  hardwareType: number;
  /** what the type was read from, for the answer */
  via: string;
}

const CRT_MAGIC = "C64 CARTRIDGE   ";

/** CRT hardware-type ids the listing knows by name (VICE `cartridge.h`); anything else prints as its number. */
const NAMES: Record<number, string> = { 0: "Generic", 3: "Final Cartridge III", 5: "Ocean", 19: "Magic Desk", 32: "EasyFlash", 60: "GMod2", 62: "GMod3", 86: "Protovision MegaByter" };

export function cartridgeTypeName(hardwareType: number): string {
  return NAMES[hardwareType] ?? `hardware type ${hardwareType}`;
}

/** The hardware type a cartridge image or manifest file records, or undefined when it records none. */
function typeOf(artifact: ArtifactLike): number | undefined {
  if (!artifact.path || !existsSync(artifact.path)) return undefined;
  try {
    const bytes = readFileSync(artifact.path);
    if (bytes.subarray(0, 16).toString("latin1") === CRT_MAGIC) return bytes.length >= 0x18 ? bytes.readUInt16BE(0x16) : undefined;
    if (artifact.role === "crt-manifest" || /\.json$/iu.test(artifact.path)) {
      const parsed = JSON.parse(bytes.toString("utf8")) as { header?: { hardwareType?: unknown } };
      const t = parsed.header?.hardwareType;
      return typeof t === "number" && Number.isInteger(t) && t >= 0 ? t : undefined;
    }
  } catch { /* an unreadable image records nothing */ }
  return undefined;
}

const isCartridgeRecord = (a: ArtifactLike): boolean => a.role === "crt-manifest" || a.role === "cartridge-image" || a.kind === "crt";
// `extract_crt` always names its manifest `manifest.json`; a row for it that another door re-registered under a
// different role (as a listing's input) is still the same file and still records the type
const isManifestFile = (a: ArtifactLike): boolean => a.role === "crt-manifest" || /(^|[\\/])manifest\.json$/iu.test(a.path);

export function cartridgeTypeFor(artifacts: ArtifactLike[], sourceAbs: string, sourceArtifactId?: string): CartridgeTypeHit | undefined {
  const byId = new Map(artifacts.map((a) => [a.id, a]));
  const hit = (a: ArtifactLike, how: string): CartridgeTypeHit | undefined => {
    const hardwareType = typeOf(a);
    return hardwareType === undefined ? undefined : { hardwareType, via: `${how} ${a.title ?? basename(a.path)}` };
  };

  // 1. lineage
  const start = sourceArtifactId ? byId.get(sourceArtifactId) : artifacts.find((a) => a.path === sourceAbs);
  if (start) {
    const seen = new Set<string>([start.id]);
    let frontier = [start];
    for (let depth = 0; depth < 8 && frontier.length > 0; depth += 1) {
      const next: ArtifactLike[] = [];
      for (const a of frontier) {
        for (const id of a.sourceArtifactIds ?? []) {
          const parent = byId.get(id);
          if (!parent || seen.has(id)) continue;
          seen.add(id);
          if (isCartridgeRecord(parent)) {
            const found = hit(parent, "descends from");
            if (found) return found;
          }
          next.push(parent);
        }
      }
      frontier = next;
    }
  }

  const records = artifacts.filter((a) => isCartridgeRecord(a) || isManifestFile(a));
  // 2. place
  for (const a of artifacts.filter(isManifestFile)) {
    const dir = dirname(a.path) + sep;
    if (sourceAbs.startsWith(dir)) {
      const found = hit(a, "extracted beside");
      if (found) return found;
    }
  }

  // 3. project
  const types = new Map<number, ArtifactLike>();
  for (const a of records) {
    const t = typeOf(a);
    if (t !== undefined && !types.has(t)) types.set(t, a);
  }
  if (types.size === 1) {
    const [[hardwareType, a]] = [...types.entries()] as [[number, ArtifactLike]];
    return { hardwareType, via: `the project's only cartridge, ${a.title ?? basename(a.path)}` };
  }
  return undefined;
}
