// VIA2 control + GCR backends.
//
// Sprint 60: stub backends (PA returns 0, PB returns default-high).
// Sprint 62: bus-coupled backends that wire $1C01 read/write to the
// drive's TrackBuffer + head positioner, and decode VIA2 PB STEP bits
// to advance the head.
//
// 1541 VIA2 PA = byte port to/from GCR read/write head ($1C01):
//   read  → next GCR byte from current track at head position
//   write → stage byte for current sector write
//
// 1541 VIA2 PB pin assignment ($1C00):
//   PB0  STEP_LO    (head step bit 0)
//   PB1  STEP_HI    (head step bit 1)
//   PB2  MOTOR      (drive motor on/off — Sprint 62: ignored)
//   PB3  LED        (drive activity LED — read only — Sprint 62: ignored)
//   PB4  WPS        (write-protect sense — input — default high = not WP)
//   PB5  DENSITY_LO (track density low — output, ignored)
//   PB6  DENSITY_HI (track density high — output, ignored)
//   PB7  SYNC       (1 = no sync, 0 = sync mark currently under head)
//
// Notes on SYNC:
// On real hardware SYNC is active-low and reflects whether the GCR
// shifter is currently inside a sync run (≥10 consecutive 1-bits).
// We model byte-aligned sync detection: SYNC = 0 when the last GCR
// byte read was 0xFF and the run-length is ≥10 bytes.

import type { ViaPortBackend } from "./via6522.js";
import type { HeadPosition, TrackBuffer } from "./head-position.js";

export const PB_STEP_LO = 1 << 0;
export const PB_STEP_HI = 1 << 1;
export const PB_MOTOR = 1 << 2;
export const PB_LED = 1 << 3;
export const PB_WPS = 1 << 4;
export const PB_DENSITY_LO = 1 << 5;
export const PB_DENSITY_HI = 1 << 6;
export const PB_SYNC = 1 << 7;

export const DEFAULT_VIA2_PB_INPUT = 0xff;

export function makeStubVia2Pa(): ViaPortBackend {
  return {
    readPins: () => 0x00,
    onOutputChanged: () => { /* no head connected */ },
  };
}

export function makeStubVia2Pb(): ViaPortBackend {
  return {
    readPins: () => DEFAULT_VIA2_PB_INPUT,
    onOutputChanged: () => { /* no motor / step / LED */ },
  };
}

// Sprint 62: bus-coupled backends.
export interface Via2GcrCoupling {
  trackBuffer: TrackBuffer;
  headPosition: HeadPosition;
  writeProtected?: boolean;       // default false
}

export function makeGcrVia2Pa(coupling: Via2GcrCoupling): ViaPortBackend {
  return {
    // Sprint 96 part 7: read latched byte (no cursor advance). Real
    // VIA2 PA is wired to the GCR shifter's latched byte register;
    // shifter clocks bytes off the disk at GCR rate via tickShifter().
    readPins: () => coupling.trackBuffer.readLatchedByte(coupling.headPosition.currentTrack),
    onOutputChanged: (orValue, ddrMask, cause) => {
      // Only commit a track-buffer write on actual ORA writes — DDR
      // mode flips don't push a new GCR byte. Drive only writes when
      // DDR is "all output" (= write mode).
      if (cause !== "or") return;
      if (ddrMask !== 0xff) return;
      coupling.trackBuffer.writeByte(coupling.headPosition.currentTrack, orValue);
    },
  };
}

export function makeGcrVia2Pb(coupling: Via2GcrCoupling): ViaPortBackend {
  return {
    readPins: () => {
      let bits = DEFAULT_VIA2_PB_INPUT;
      // WPS bit: 1 = not write-protected (default). Pull low if WP.
      if (coupling.writeProtected) bits &= ~PB_WPS;
      // SYNC bit: 0 = currently over a sync mark.
      if (coupling.trackBuffer.syncDetected()) bits &= ~PB_SYNC;
      return bits;
    },
    onOutputChanged: (orValue, _ddrMask, _cause) => {
      coupling.headPosition.applyStepBits(orValue & (PB_STEP_LO | PB_STEP_HI));
      // Motor / LED / DENSITY effects ignored in Sprint 62.
    },
  };
}
