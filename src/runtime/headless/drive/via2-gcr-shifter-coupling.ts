// Spec 153 / Sprint 114 — VIA2 ↔ GcrShifter coupling.
//
// Wires the Spec 153 standalone GcrShifter (drive/gcr-shifter.ts) into
// the Via2d1541 backend via the existing Via2GcrPortCoupling shape.
//
// This replaces the legacy TrackBuffer-inline-shifter coupling
// (via2-gcr.ts → makeGcrVia2Pa/Pb) with a 1:1 VICE bit-stream model:
//   - PA reads return GcrShifter.dataByte (latched VIA2 PRA byte)
//   - PB reads compose the standard 1541 bit layout, with bit 7 = SYNC#
//     pulled live from GcrShifter.syncBit (active LOW)
//   - PB writes still drive HeadPosition.applyStepBits and propagate
//     motor/density to the shifter (replacing the TrackBuffer setters)
//
// VICE source pages used:
//   src/drive/iecieee/via2d.c   — VIA2 backend wiring (PA latch, PB bits)
//   src/drive/rotation.c        — rotation_sync_found returns 0/0x80 for
//                                  bit 7, which we mirror via syncBit
//
// The TrackBuffer is intentionally NOT touched here. When this coupling
// is active the legacy shifter inside TrackBuffer is bypassed (caller
// must skip its tickShifter call, see DriveCpu wiring in drive-cpu.ts).
// TrackBuffer is retained as the write-buffer for V3 GCR-write support.

import type { Via2GcrPortCoupling } from "../via/via2d1541.js";
import type { GcrShifter } from "./gcr-shifter.js";
import type { HeadPosition } from "./head-position.js";

import {
  PB_STEP_LO,
  PB_STEP_HI,
  PB_MOTOR,
  PB_LED,
  PB_WPS,
  PB_DENSITY_LO,
  PB_DENSITY_HI,
  PB_SYNC,
  DEFAULT_VIA2_PB_INPUT,
} from "./via2-gcr.js";

export interface GcrShifterCouplingOptions {
  shifter: GcrShifter;
  headPosition: HeadPosition;
  /** Optional: write-protect sense. Default false (writable). */
  writeProtected?: boolean;
}

/**
 * Build a Via2GcrPortCoupling backed by GcrShifter.
 *
 * Replaces makeGcrVia2Pa + makeGcrVia2Pb (legacy TrackBuffer path).
 * Use exactly one of the two for any drive instance.
 */
export function makeGcrShifterCoupling(
  opts: GcrShifterCouplingOptions,
): Via2GcrPortCoupling {
  const { shifter, headPosition, writeProtected = false } = opts;

  return {
    // VIA2 PA = $1C01 — current latched GCR data byte from the shifter.
    // Read-only V2; storePa is V3 (write-back).
    readPa: () => shifter.dataByte,
    onPaOutputChanged: (_or, _ddr, _cause) => {
      // V3 backlog — write-back not modeled. Drop the output.
    },

    // VIA2 PB = $1C00 — compose pin layout per VICE via2d.c.
    readPb: () => {
      let bits = DEFAULT_VIA2_PB_INPUT;
      // PB7 = SYNC# (active LOW). Pulled live from shifter.
      // syncBit returns 0 when sync detected, 1 otherwise.
      if (shifter.syncBit === 0) bits &= ~PB_SYNC;
      // PB4 = WPS — VICE drive_writeprotect_sense semantics.
      // Returns 0x10 (WP set) for no-disk + attached writable,
      // 0x0 (WP cleared) during attach delay window. 1541 DOS
      // watches PB4 transitions via `wpsw` / `lwpt` to detect
      // disk insert. Constructor `writeProtected` option overrides
      // = always WP set if disk image is read-only.
      const wpSenseFromShifter = shifter.writeProtectSense();
      if (writeProtected) {
        // Caller-forced WP: pull low always
        bits &= ~PB_WPS;
      } else if (wpSenseFromShifter === 0) {
        // VICE attach window: WP just changed → pull low
        bits &= ~PB_WPS;
      }
      // wpSenseFromShifter === 0x10 → leave PB4 high (= WP not set
      // = drive ready for write, or no disk → DOS will probe)
      // Other bits (LED, motor read-back, density read-back, step phase
      // read-back) are normally driven by the latch; the chip core
      // already merges DDR-output bits in, so we leave them at default
      // input level. Real HW returns the latch for any output bits.
      return bits;
    },
    onPbOutputChanged: (orValue, ddrMask) => {
      // Spec 411 / vice-1541-arch.md §7.3 + §14 invariant 7 +
      // §17 OQ-411-1 — stepper is GATED on motor-on. VICE via2d.c:255
      // `if (byte & 0x4)` wraps drive_move_head. Pass motor latch to
      // applyStepBits so phase changes during motor-off don't move
      // the head (matches §7.4 motor-on coil-enable semantics).
      const motorOn = (orValue & PB_MOTOR) !== 0;
      headPosition.applyStepBits(orValue & (PB_STEP_LO | PB_STEP_HI), motorOn);

      // Motor (PB2): only when configured as output (DDR=1). Mirrors
      // VICE drive_set_motor sampling: motor latch ignored if pin is
      // input. Cite: via2d.c:325-337 (BRA_MOTOR_ON branch).
      if ((ddrMask & PB_MOTOR) !== 0) {
        shifter.setMotor(motorOn);
      }

      // Density (PB5/PB6): only honoured when both bits are outputs.
      // Reset-state default = track-derived zone (cleared override),
      // matching the legacy TrackBuffer behaviour during the boot
      // window before drive ROM programs DDR.
      if ((ddrMask & (PB_DENSITY_LO | PB_DENSITY_HI)) ===
          (PB_DENSITY_LO | PB_DENSITY_HI)) {
        const zone = ((orValue >> 5) & 0x03) as 0 | 1 | 2 | 3;
        shifter.setDensity(zone);
      } else {
        shifter.clearDensityOverride();
      }

      // LED (PB3) is observable-only at this layer; ignored.
      // (Reserved for V3 disk-LED reporting hooks.)
      void PB_LED;
    },
  };
}
