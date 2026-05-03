// VIA2 control + GCR pin assignments (Sprint 60: pin layout only —
// real GCR fetch / write logic lands in Sprint 62).
//
// 1541 VIA2 PA = byte port to/from GCR read/write head ($1C01):
//   read = next byte from current track at head position (Sprint 62)
//   write = stage byte for current sector write (Sprint 62)
//
// VIA2 PB pin assignment ($1C00):
//   PB0  STEP_LO    (head step bit 0)
//   PB1  STEP_HI    (head step bit 1)
//   PB2  MOTOR      (drive motor on/off)
//   PB3  LED        (drive activity LED)
//   PB4  WPS        (write-protect sense — input)
//   PB5  DENSITY_LO (track-density low — output)
//   PB6  DENSITY_HI (track-density high — output)
//   PB7  SYNC       (set when SYNC mark detected on read — input)
//
// Sprint 60: storage-only pins. No head movement, no SYNC detection,
// no motor effect. Sprint 62 wires head positioning via STEP bits and
// SYNC detection from the GCR byte stream.
//
// CA1 = BYTE READY — set when the GCR shifter has assembled a full
// byte and it's ready at $1C01. Sprint 60 stub.
// CA2 = SOE (Set Output Enable for the GCR write path).
// CB1 = unused.
// CB2 = R/W mode select (0 = write, 1 = read).

import type { ViaPortBackend } from "./via6522.js";

export const PB_STEP_LO = 1 << 0;
export const PB_STEP_HI = 1 << 1;
export const PB_MOTOR = 1 << 2;
export const PB_LED = 1 << 3;
export const PB_WPS = 1 << 4;
export const PB_DENSITY_LO = 1 << 5;
export const PB_DENSITY_HI = 1 << 6;
export const PB_SYNC = 1 << 7;

// Default: WPS = 1 (not write-protected), SYNC = 1 (idle).
export const DEFAULT_VIA2_PB_INPUT = 0xff;

export function makeStubVia2Pa(): ViaPortBackend {
  return {
    readPins: () => 0x00, // GCR byte fetch — Sprint 62 returns track byte
    onOutputChanged: () => { /* GCR write — Sprint 62 stages bytes */ },
  };
}

export function makeStubVia2Pb(): ViaPortBackend {
  return {
    readPins: () => DEFAULT_VIA2_PB_INPUT,
    onOutputChanged: () => { /* head step / motor / LED — Sprint 62 acts on STEP bits */ },
  };
}
