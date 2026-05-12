// Spec 247 — Routine fingerprinting (library match).
//
// Provides types + scanning logic for matching code regions against
// a curated library of known C64 routine patterns (KERNAL, BASIC,
// fastloaders, copy-protection stubs).
//
// Library lookup is a configurable chain (bundled → trex → local).
// Config via C64RE_FINGERPRINT_LIBS env (colon-separated paths) or
// project profile. First-match-wins by default; opts.reportAll=true
// returns every library hit.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---- Types ----------------------------------------------------------------

export interface RegisterUse {
  reads: string[];
  writes: string[];
}

/** One entry in a fingerprint library JSON file. */
export interface FingerprintEntry {
  /** Unique short name, e.g. "kernal-chrget". */
  name: string;
  /** ROM / version string for display. */
  version: string;
  /** Broad category: "kernal" | "basic" | "fastloader" | "copyprotect" | "other". */
  category: string;
  /** Canonical entry-point offset from ROM base (for ROM-based entries). */
  entry: number;
  /** Byte length of the routine. */
  length: number;
  /**
   * How the hash was computed:
   *  structural — opcode sequence only (operands masked out).
   *  byte       — exact byte sequence.
   *  graph      — call-graph topology hash (optional, future).
   */
  hash_kind: "structural" | "byte" | "graph";
  /** "sha256:<hex>" */
  hash_value: string;
  /** Human-readable byte pattern (may include <relocatable> placeholders). */
  byte_pattern: string;
  register_use: RegisterUse;
  /** One-line summary of what this routine does and what it returns. */
  entry_signature: string;
  /** External references (e.g. mapping docs). */
  links: string[];
}

/** Result of a single match. */
export interface FingerprintMatch {
  /** Address in the scanned artifact where the routine begins. */
  routinePc: number;
  /** Artifact identifier (passed through from opts). */
  artifactId: string;
  /** library entry name that was matched. */
  matchedFingerprint: string;
  matchKind: "structural" | "byte" | "graph";
  /** 0..1. */
  confidence: number;
  details: {
    byteOverlap?: number;
    opcodeMatch?: number;
  };
}

/** Options for scanFingerprints(). */
export interface ScanOptions {
  /** Paths to library directories or JSON files, in lookup order. */
  libraryPaths?: string[];
  /** If true, return all matches (not just first per region). */
  reportAll?: boolean;
  /** Confidence threshold; defaults to 0.90. */
  threshold?: number;
  /** Restrict scan to this address range [lo, hi] inclusive. */
  addrRange?: [number, number];
}

// ---- Opcode size table (inline minimal) -----------------------------------
// Avoids importing the full pipeline mos6502 from the runtime side.

const OPCODE_SIZE: Uint8Array = new Uint8Array(256).fill(1);
// 2-byte instructions
for (const op of [
  0x01,0x03,0x04,0x05,0x06,0x07,0x09,0x0b,
  0x10,0x11,0x13,0x14,0x15,0x16,0x17,
  0x21,0x23,0x24,0x25,0x26,0x27,0x29,0x2b,
  0x30,0x31,0x33,0x34,0x35,0x36,0x37,
  0x41,0x43,0x44,0x45,0x46,0x47,0x49,0x4b,
  0x50,0x51,0x53,0x54,0x55,0x56,0x57,
  0x61,0x63,0x64,0x65,0x66,0x67,0x69,0x6b,
  0x70,0x71,0x73,0x74,0x75,0x76,0x77,
  0x80,0x82,0x83,0x84,0x85,0x86,0x87,0x89,0x8b,
  0x90,0x91,0x93,0x94,0x95,0x96,0x97,
  0xa0,0xa1,0xa2,0xa3,0xa4,0xa5,0xa6,0xa7,0xa9,0xab,
  0xb0,0xb1,0xb3,0xb4,0xb5,0xb6,0xb7,
  0xc0,0xc1,0xc2,0xc3,0xc4,0xc5,0xc6,0xc7,0xc9,0xcb,
  0xd0,0xd1,0xd3,0xd4,0xd5,0xd6,0xd7,
  0xe0,0xe1,0xe2,0xe3,0xe4,0xe5,0xe6,0xe7,0xe9,0xeb,
  0xf0,0xf1,0xf3,0xf4,0xf5,0xf6,0xf7,
]) { OPCODE_SIZE[op] = 2; }
// 3-byte instructions
for (const op of [
  0x0c,0x0d,0x0e,0x0f,
  0x19,0x1b,0x1c,0x1d,0x1e,0x1f,
  0x20,0x2c,0x2d,0x2e,0x2f,
  0x39,0x3b,0x3c,0x3d,0x3e,0x3f,
  0x4c,0x4d,0x4e,0x4f,
  0x59,0x5b,0x5c,0x5d,0x5e,0x5f,
  0x6c,0x6d,0x6e,0x6f,
  0x79,0x7b,0x7c,0x7d,0x7e,0x7f,
  0x8c,0x8d,0x8e,0x8f,
  0x99,0x9b,0x9c,0x9d,0x9e,0x9f,
  0xac,0xad,0xae,0xaf,
  0xb9,0xbb,0xbc,0xbd,0xbe,0xbf,
  0xcc,0xcd,0xce,0xcf,
  0xd9,0xdb,0xdc,0xdd,0xde,0xdf,
  0xec,0xed,0xee,0xef,
  0xf9,0xfb,0xfc,0xfd,0xfe,0xff,
]) { OPCODE_SIZE[op] = 3; }

// ---- Hash helpers ---------------------------------------------------------

/** Structural hash: only opcodes, operands replaced by zeros. */
export function structuralHash(bytes: Uint8Array): string {
  const masked: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const op = bytes[i];
    const size = OPCODE_SIZE[op];
    masked.push(op);
    for (let j = 1; j < size && i + j < bytes.length; j++) masked.push(0);
    i += size;
  }
  return "sha256:" + createHash("sha256").update(Buffer.from(masked)).digest("hex");
}

/** Exact byte hash. */
export function byteHash(bytes: Uint8Array): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

// ---- Library loading ------------------------------------------------------

export interface FingerprintLibrary {
  /** Path this library was loaded from. */
  path: string;
  entries: FingerprintEntry[];
}

function parseLibraryJson(raw: unknown): FingerprintEntry[] {
  if (Array.isArray(raw)) return raw as FingerprintEntry[];
  const r = raw as Record<string, unknown>;
  if (r["name"]) return [raw as FingerprintEntry];
  if (Array.isArray(r["entries"])) return r["entries"] as FingerprintEntry[];
  return [];
}

/** Load all .json fingerprint files from a directory or single file path. */
export function loadLibrary(path: string): FingerprintLibrary {
  const resolved = resolve(path);
  if (!existsSync(resolved)) return { path: resolved, entries: [] };

  let entries: FingerprintEntry[] = [];
  const isDir = statSync(resolved).isDirectory();

  if (isDir) {
    let files: string[] = [];
    try { files = readdirSync(resolved).filter(f => f.endsWith(".json")).sort(); } catch { /* empty */ }
    for (const f of files) {
      try {
        entries.push(...parseLibraryJson(JSON.parse(readFileSync(join(resolved, f), "utf8"))));
      } catch { /* skip malformed */ }
    }
  } else {
    try {
      entries = parseLibraryJson(JSON.parse(readFileSync(resolved, "utf8")));
    } catch { /* skip */ }
  }
  return { path: resolved, entries };
}

/**
 * Load multiple libraries in chain order.
 * If paths is empty, falls back to C64RE_FINGERPRINT_LIBS env (colon-separated),
 * then the bundled library shipped with the repo.
 */
export function loadLibraries(paths?: string[]): FingerprintLibrary[] {
  let resolved: string[] = paths ?? [];
  if (resolved.length === 0) {
    const env = process.env["C64RE_FINGERPRINT_LIBS"];
    if (env) {
      resolved = env.split(":").filter(Boolean);
    } else {
      // Default: bundled directory next to resources/ from repo root.
      const here = fileURLToPath(import.meta.url);
      // dist/runtime/headless/v2/fingerprint.js → up 5 to repo root
      const repoRoot = resolve(here, "../../../../..");
      resolved = [join(repoRoot, "resources/fingerprints/bundled")];
    }
  }
  return resolved.map(loadLibrary).filter(lib => lib.entries.length > 0);
}

// ---- Routine boundary discovery -------------------------------------------

/**
 * Given a flat byte buffer, find RTS-terminated code regions starting
 * at addresses that are targets of JSR instructions within the buffer.
 * Returns (offset, length, pc) triples.
 */
export function findRoutineBoundaries(
  bytes: Uint8Array,
  baseAddr: number,
  addrRange?: [number, number],
): Array<{ offset: number; length: number; pc: number }> {
  const lo = addrRange ? Math.max(0, addrRange[0] - baseAddr) : 0;
  const hi = addrRange ? Math.min(bytes.length, addrRange[1] - baseAddr + 1) : bytes.length;

  // Collect JSR targets within range.
  const jsrTargets = new Set<number>();
  jsrTargets.add(lo); // treat start of range as implicit routine entry

  for (let i = lo; i < hi - 2; ) {
    const op = bytes[i];
    if (op === 0x20) { // JSR abs
      const target = bytes[i + 1] | (bytes[i + 2] << 8);
      const targetOffset = target - baseAddr;
      if (targetOffset >= lo && targetOffset < hi) {
        jsrTargets.add(targetOffset);
      }
    }
    i += OPCODE_SIZE[op];
  }

  const results: Array<{ offset: number; length: number; pc: number }> = [];

  for (const startOffset of jsrTargets) {
    // Walk forward to find RTS/JMP/RTI terminators.
    let i = startOffset;
    while (i < hi) {
      const op = bytes[i];
      const size = OPCODE_SIZE[op];
      if (i + size > hi) break;
      if (op === 0x60 || op === 0x40) { // RTS or RTI
        const length = i - startOffset + 1;
        if (length >= 3 && length <= 512) {
          results.push({ offset: startOffset, length, pc: baseAddr + startOffset });
        }
        break;
      }
      if (op === 0x4c || op === 0x6c) { // JMP abs / JMP (ind)
        const length = i - startOffset + 3;
        if (length >= 3 && length <= 512) {
          results.push({ offset: startOffset, length, pc: baseAddr + startOffset });
        }
        break;
      }
      i += size;
    }
  }

  return results;
}

// ---- Confidence scoring ---------------------------------------------------

function scoreCandidate(
  candidate: Uint8Array,
  entry: FingerprintEntry,
): { confidence: number; matchKind: FingerprintEntry["hash_kind"]; details: FingerprintMatch["details"] } {
  // Byte-exact check.
  if (entry.hash_kind === "byte") {
    if (byteHash(candidate) === entry.hash_value) {
      return { confidence: 1.0, matchKind: "byte", details: { byteOverlap: 1.0, opcodeMatch: 1.0 } };
    }
  }

  // Structural check (also fallback for byte entries with relocation).
  if (entry.hash_kind === "structural" || entry.hash_kind === "byte") {
    if (structuralHash(candidate) === entry.hash_value) {
      const conf = entry.hash_kind === "structural" ? 1.0 : 0.97;
      return { confidence: conf, matchKind: "structural", details: { opcodeMatch: 1.0 } };
    }
  }

  // Fuzzy: byte-overlap ratio as proxy confidence.
  // Only bother if candidate is within 50%..200% of entry length.
  const ratio = candidate.length / entry.length;
  if (ratio < 0.5 || ratio > 2.0) return { confidence: 0, matchKind: "structural", details: {} };

  const byteOverlap = Math.min(candidate.length, entry.length) / Math.max(candidate.length, entry.length);
  const lengthPenalty = Math.abs(candidate.length - entry.length) / entry.length;
  const confidence = Math.max(0, byteOverlap * (1 - lengthPenalty) * 0.85);

  return { confidence, matchKind: "structural", details: { byteOverlap, opcodeMatch: byteOverlap } };
}

// ---- Main scan API --------------------------------------------------------

/**
 * Scan `artifactBytes` for known fingerprints from the configured library chain.
 *
 * @param artifactId  Opaque string passed through into each FingerprintMatch.
 * @param artifactBytes  Raw bytes of the code region to scan.
 * @param baseAddr  Load address of the first byte (for routinePc calculation).
 * @param opts  Library paths, threshold, reportAll, addrRange.
 */
export function scanFingerprints(
  artifactId: string,
  artifactBytes: Uint8Array,
  baseAddr: number,
  opts: ScanOptions = {},
): FingerprintMatch[] {
  const libraries = loadLibraries(opts.libraryPaths);
  if (libraries.length === 0) return [];

  const threshold = opts.threshold ?? 0.90;
  const reportAll = opts.reportAll ?? false;

  const regions = findRoutineBoundaries(artifactBytes, baseAddr, opts.addrRange);

  const matches: FingerprintMatch[] = [];
  const matchedPcs = new Set<number>();

  for (const region of regions) {
    if (!reportAll && matchedPcs.has(region.pc)) continue;
    const candidate = artifactBytes.subarray(region.offset, region.offset + region.length);
    let foundForRegion = false;

    for (const lib of libraries) {
      if (foundForRegion && !reportAll) break;
      for (const entry of lib.entries) {
        const ratio = region.length / entry.length;
        if (ratio < 0.5 || ratio > 2.0) continue;

        const { confidence, matchKind, details } = scoreCandidate(candidate, entry);
        if (confidence >= threshold) {
          matches.push({ routinePc: region.pc, artifactId, matchedFingerprint: entry.name, matchKind, confidence, details });
          matchedPcs.add(region.pc);
          foundForRegion = true;
          if (!reportAll) break;
        }
      }
    }
  }

  matches.sort((a, b) => b.confidence - a.confidence || a.routinePc - b.routinePc);
  return matches;
}

/**
 * Add (or replace) a fingerprint entry in a library JSON file (array format).
 * Creates the file if it doesn't exist.
 */
export function addFingerprintToLibrary(filePath: string, entry: FingerprintEntry): void {
  let existing: FingerprintEntry[] = [];
  if (existsSync(filePath)) {
    try {
      existing = parseLibraryJson(JSON.parse(readFileSync(filePath, "utf8")));
    } catch { /* overwrite */ }
  }
  const idx = existing.findIndex(e => e.name === entry.name);
  if (idx >= 0) existing[idx] = entry;
  else existing.push(entry);
  writeFileSync(filePath, JSON.stringify(existing, null, 2) + "\n", "utf8");
}
