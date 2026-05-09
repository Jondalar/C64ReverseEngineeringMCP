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
