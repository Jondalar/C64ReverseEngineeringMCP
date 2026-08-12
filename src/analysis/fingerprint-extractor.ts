// Spec 247 — ROM routine auto-extractor.
//
// Reads a ROM binary (KERNAL or BASIC), walks all JSR-reachable
// code regions and produces FingerprintEntry records with structural
// hashes.  Used by scripts/build-fingerprint-library.mjs.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FingerprintEntry } from "./fingerprint.js";
import { structuralHash, byteHash, findRoutineBoundaries } from "./fingerprint.js";

// Re-export for convenience so callers don't need two imports.
export { structuralHash, byteHash };

// ---- Well-known KERNAL labels (by ROM-relative offset = addr - 0xE000) ----
// Source: C64 memory map / mapping-c64-symbols project.
// Only the most commonly referenced routines are named here; the extractor
// names unnamed ones "kernal-entry-<hex>".

const KERNAL_LABELS: Record<number, { name: string; signature: string; regReads: string[]; regWrites: string[] }> = {
  0x1F5A: { name: "kernal-SETLFS", signature: "Set logical file params (LA,FA,SA)", regReads: ["a","x","y"], regWrites: [] },
  0x1F5D: { name: "kernal-SETNAM", signature: "Set filename (A=len, X/Y=ptr)", regReads: ["a","x","y"], regWrites: [] },
  0x1F20: { name: "kernal-GETIN",  signature: "Get char from current input, returns in A", regReads: [], regWrites: ["a","flags"] },
  0x1F21: { name: "kernal-GETIN2", signature: "GETIN from serial", regReads: [], regWrites: ["a","flags"] },

  // CHROUT / BSOUT
  0x1D2F: { name: "kernal-CHROUT", signature: "Output char in A to current output channel", regReads: ["a"], regWrites: ["flags"] },

  // IEC / serial bus
  0x1C9B: { name: "kernal-LISTEN", signature: "Send LISTEN to serial bus device in A", regReads: ["a"], regWrites: ["flags"] },
  0x1C9F: { name: "kernal-UNLSN", signature: "Send UNLISTEN to serial bus", regReads: [], regWrites: ["flags"] },
  0x1CA3: { name: "kernal-TALK",   signature: "Send TALK to serial bus device in A", regReads: ["a"], regWrites: ["flags"] },
  0x1CA7: { name: "kernal-UNTLK", signature: "Send UNTALK to serial bus", regReads: [], regWrites: ["flags"] },

  // OPEN / CLOSE
  0x1A99: { name: "kernal-OPEN",  signature: "Open logical file", regReads: [], regWrites: ["a","flags"] },
  0x1A5C: { name: "kernal-CLOSE", signature: "Close logical file", regReads: ["a"], regWrites: ["flags"] },

  // CHKIN / CHKOUT / CLRCHN
  0x1A9C: { name: "kernal-CHKIN",  signature: "Set channel for input, X=logical file#", regReads: ["x"], regWrites: ["flags"] },
  0x1A9F: { name: "kernal-CHKOUT", signature: "Set channel for output, X=logical file#", regReads: ["x"], regWrites: ["flags"] },
  0x1AA2: { name: "kernal-CLRCHN", signature: "Clear all I/O channels", regReads: [], regWrites: ["flags"] },

  // LOAD / SAVE / VERIFY
  0x1A7C: { name: "kernal-LOAD",   signature: "Load file from device (A=verify flag)", regReads: ["a","x","y"], regWrites: ["a","x","y","flags"] },
  0x1AA6: { name: "kernal-SAVE",   signature: "Save memory to device", regReads: ["a","x","y"], regWrites: ["a","flags"] },

  // TIME
  0x1A65: { name: "kernal-SETTIM", signature: "Set internal clock (A/X/Y)", regReads: ["a","x","y"], regWrites: [] },
  0x1A68: { name: "kernal-RDTIM",  signature: "Read internal clock → A/X/Y", regReads: [], regWrites: ["a","x","y"] },

  // SCREEN / cursor
  0x1AB4: { name: "kernal-SCREEN", signature: "Return screen size in X/Y", regReads: [], regWrites: ["x","y"] },
  0x1AB7: { name: "kernal-PLOT",   signature: "Read/set cursor position", regReads: ["a","x","y"], regWrites: ["x","y","flags"] },

  // IOBASE
  0x1ABA: { name: "kernal-IOBASE", signature: "Return CIA1 base address in X/Y", regReads: [], regWrites: ["x","y"] },

  // SCNKEY / keyboard
  0x1A17: { name: "kernal-SCNKEY", signature: "Scan keyboard matrix, update buffer", regReads: [], regWrites: ["a","x","y","flags"] },

  // MEMTOP / MEMBOT
  0x1A2D: { name: "kernal-MEMTOP", signature: "Read/set top of memory in X/Y", regReads: ["a","x","y"], regWrites: ["x","y"] },
  0x1A30: { name: "kernal-MEMBOT", signature: "Read/set bottom of memory in X/Y", regReads: ["a","x","y"], regWrites: ["x","y"] },

  // RESTOR / VECTOR / IOINIT
  0x1A8A: { name: "kernal-RESTOR", signature: "Restore default I/O vectors", regReads: [], regWrites: [] },
  0x1A8D: { name: "kernal-VECTOR", signature: "Read/set RAM vector table", regReads: ["a","x","y"], regWrites: ["x","y"] },
  0x1A47: { name: "kernal-IOINIT", signature: "Initialize CIA chips", regReads: [], regWrites: ["a","x","y","flags"] },

  // CINT / SCINIT
  0x1A4A: { name: "kernal-CINT",   signature: "Initialize screen editor", regReads: [], regWrites: ["a","x","y","flags"] },
  0x1A4D: { name: "kernal-SCINIT", signature: "Initialize VIC + screen", regReads: [], regWrites: ["a","x","y","flags"] },

  // RAMTAS
  0x1A50: { name: "kernal-RAMTAS", signature: "RAM test and ZP init", regReads: [], regWrites: ["a","x","y","flags"] },
};

// Well-known BASIC ROM labels (offset = addr - 0xA000, ROM at $A000–$BFFF).
const BASIC_LABELS: Record<number, { name: string; signature: string; regReads: string[]; regWrites: string[] }> = {
  0x0000: { name: "basic-COLD",  signature: "BASIC cold start entry point", regReads: [], regWrites: ["a","x","y","flags"] },
  0x0003: { name: "basic-WARM",  signature: "BASIC warm start / restart", regReads: [], regWrites: ["a","x","y","flags"] },
  0x089A: { name: "basic-CRUNCH", signature: "Tokenize BASIC line", regReads: ["a","x","y"], regWrites: ["a","x","y","flags"] },
  0x0A5F: { name: "basic-EXECUTE", signature: "Execute one BASIC statement", regReads: [], regWrites: ["a","x","y","flags"] },
  0x11A2: { name: "basic-FADDH",  signature: "FADD half: float add helper", regReads: [], regWrites: ["a","x","y","flags"] },
  0x11A8: { name: "basic-FSUB",   signature: "Float subtract (FAC2 - FAC1)", regReads: [], regWrites: ["a","x","y","flags"] },
  0x11B7: { name: "basic-FADD5",  signature: "Float add (FAC2 + FAC1)", regReads: [], regWrites: ["a","x","y","flags"] },
  0x1240: { name: "basic-FMULT",  signature: "Float multiply", regReads: [], regWrites: ["a","x","y","flags"] },
  0x1260: { name: "basic-FDIV",   signature: "Float divide", regReads: [], regWrites: ["a","x","y","flags"] },
};

// ---- Extractor ------------------------------------------------------------

export interface ExtractOptions {
  /** Minimum routine length in bytes. Default: 4. */
  minLength?: number;
  /** Maximum routine length in bytes. Default: 512. */
  maxLength?: number;
  /** If true, also emit byte-exact hash alongside structural hash. */
  includeByteHash?: boolean;
  /** ROM version string for the 'version' field. */
  version?: string;
}

/**
 * Auto-extract FingerprintEntry records from a ROM image.
 *
 * @param romBytes  Raw ROM bytes.
 * @param romName   "kernal" or "basic" — controls label lookup + category.
 * @param baseAddr  Load address of the ROM (0xE000 for KERNAL, 0xA000 for BASIC).
 * @param opts      Tuning knobs.
 */
export function extractRoutinesFromRom(
  romBytes: Uint8Array,
  romName: "kernal" | "basic" | string,
  baseAddr: number,
  opts: ExtractOptions = {},
): FingerprintEntry[] {
  const minLen = opts.minLength ?? 4;
  const maxLen = opts.maxLength ?? 512;
  const version = opts.version ?? (romName === "kernal" ? "C64 KERNAL 901227-03" : romName === "basic" ? "C64 BASIC 901226-01" : romName);
  const category = romName === "kernal" ? "kernal" : romName === "basic" ? "basic" : "other";
  const labels = romName === "kernal" ? KERNAL_LABELS : romName === "basic" ? BASIC_LABELS : {};

  const regions = findRoutineBoundaries(romBytes, baseAddr);

  const entries: FingerprintEntry[] = [];
  const seenNames = new Set<string>();

  for (const region of regions) {
    if (region.length < minLen || region.length > maxLen) continue;

    const offset = region.offset;
    const bytes = romBytes.subarray(offset, offset + region.length);
    const label = labels[offset];

    const baseName = label?.name ?? `${romName}-entry-${(baseAddr + offset).toString(16).padStart(4, "0")}`;
    const name = seenNames.has(baseName) ? `${baseName}-dup${offset.toString(16)}` : baseName;
    seenNames.add(name);

    const hash = structuralHash(bytes);

    // Build a readable byte_pattern (first 12 bytes, rest as ellipsis).
    const patternBytes = Array.from(bytes.subarray(0, Math.min(12, bytes.length)))
      .map(b => b.toString(16).toUpperCase().padStart(2, "0"))
      .join(" ");
    const bytePattern = bytes.length > 12 ? `${patternBytes} ... <${bytes.length - 12} more>` : patternBytes;

    const entry: FingerprintEntry = {
      name,
      version,
      category,
      entry: baseAddr + offset,
      length: region.length,
      hash_kind: "structural",
      hash_value: hash,
      byte_pattern: bytePattern,
      register_use: {
        reads: label?.regReads ?? [],
        writes: label?.regWrites ?? [],
      },
      entry_signature: label?.signature ?? `${romName} routine at $${(baseAddr + offset).toString(16).toUpperCase()}`,
      links: [],
    };
    entries.push(entry);
  }

  return entries;
}

/** Convenience: load ROM file and extract. */
export function extractRoutinesFromRomFile(
  romPath: string,
  romName: "kernal" | "basic" | string,
  baseAddr: number,
  opts: ExtractOptions = {},
): FingerprintEntry[] {
  const bytes = new Uint8Array(readFileSync(romPath));
  return extractRoutinesFromRom(bytes, romName, baseAddr, opts);
}
