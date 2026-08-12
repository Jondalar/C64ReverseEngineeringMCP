// ════════════════════════════════════════════════════════════════════════════
//  DEPRECATED — TypeScript runtime.  THE PRODUCT RUNTIME IS TRX64.
//
//  This file is part of the in-process TS emulator. It is reachable ONLY with
//  C64RE_RUNTIME_TS=1 and is never on the default path: every runtime_* tool,
//  the workspace UI and the MCP surface route to the TRX64 daemon (Spec 771).
//
//  Do not extend it, do not fix forward in it, and do not cite it as current
//  behaviour — "how the runtime works" means TRX64, in ../TRX64.
//  Its remaining job is to be a parity oracle for the port; when that is no
//  longer needed it goes. See DOCTRINE.md.
// ════════════════════════════════════════════════════════════════════════════
// "No disk in drive" sentinel parser.
//
// Real C64 + 1541: drive powered + present, no disk inserted = drive
// head over rest position, motor off until LOAD command. LOAD with no
// disk → drive ROM seeks, finds no sync (= no SYNC# pulses, no GCR
// bytes), eventually returns ?DEVICE NOT PRESENT or ?FILE NOT FOUND.
//
// IntegratedSession used to require a diskPath at construction (=
// design error vs VICE which boots with empty drive fine). This
// sentinel parser satisfies the G64Parser shape consumed by
// GcrShifter + TrackBuffer + DiskProvider, returning null/empty
// for every track read = drive sees no sync = "empty drive"
// behavior matching real HW.

import type { G64Parser } from "../../../disk/g64-parser.js";
import type { DiskFileEntry, DiskDirectory } from "../../../disk/base.js";

class NoDiskParser {
  // GcrShifter reads via getRawTrackBytes — null = no data = no sync
  getRawTrackBytes(_trackNum: number): Uint8Array | null { return null; }
  // KERNAL trap path reads via getDirectory + extractFile — empty dir
  getDirectory(): DiskDirectory {
    return { name: "", id: "", files: [] };
  }
  extractFile(_entry: DiskFileEntry, _stripLoadAddress = false): Uint8Array | null {
    return null;
  }
  getSector(_track: number, _sector: number): Uint8Array | null {
    return null;
  }
  // Standard 35-track drive layout reported (= matches typical 1541)
  getTrackCount(): number { return 35; }
  getHalfTrackCount(): number { return 70; }
  getVersion(): number { return 0; }
}

export function createNoDiskParser(): G64Parser {
  return new NoDiskParser() as unknown as G64Parser;
}
