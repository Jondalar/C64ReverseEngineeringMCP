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
import { setDriveMotor, drive_writeprotect_sense, BUS_READ_DELAY, type Drive_t } from "./drive-t.js";
import {
  rotation_begins,
  rotation_byte_read,
  rotation_rotate_disk,
  rotation_speed_zone_set,
  rotation_sync_found,
} from "./rotation.js";

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
  /** Spec 424 — sink for VIA2 PB3 LED bit transitions (cycle, on). */
  ledSink?: (on: boolean, clk: number) => void;
  /** Spec 424 — clock source used when stamping LED transitions. */
  clkRef?: () => number;
  /**
   * Spec 441 step 4c — shadow drive_t. Motor/density writes propagate
   * here in addition to the GcrShifter, so rotation.ts has the state
   * it needs once the cycle-wrapper flips (step 4e).
   */
  shadowDrive?: Drive_t;
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
  const { shifter, headPosition, writeProtected = false, ledSink, clkRef, shadowDrive } = opts;
  let lastLedOn = false;
  // Spec 443 review — VICE store_prb tracks (poldpb ^ byte) for motor
  // edge detection and the Bug-1083 second-move block (via2d.c:340-351).
  // VICE reset sets via[VIA_PRB] = 0 → poldpb at first write = 0.
  let lastPbOrValue = 0;

  return {
    // VIA2 PA = $1C01 — GCR data port. Spec 441 step 4e-flip: literal
    // port of VICE via2d.c:463 read_pra:
    //   req_ref_cycles = BUS_READ_DELAY;
    //   rotation_byte_read(drive);
    //   byte = (drive->GCR_read & ~DDRA) | (PRA & DDRA);
    //   byte_ready_level = 0;
    // DDRA-merging is also done by Via6522Vice on PA read; backend
    // returns the raw GCR_read since the chip core handles the mask.
    readPa: () => {
      if (!shadowDrive) return shifter.dataByte;
      shadowDrive.req_ref_cycles = BUS_READ_DELAY;
      rotation_byte_read(shadowDrive);
      shadowDrive.byte_ready_level = 0;
      return shadowDrive.GCR_read;
    },
    // VIA2 PA write — VICE via2d.c:184 store_pra:
    //   rotation_rotate_disk(drive);
    //   drive->GCR_write_value = byte;
    //   drive->byte_ready_level = 0;
    onPaOutputChanged: (orValue, _ddr, _cause) => {
      if (shadowDrive) {
        rotation_rotate_disk(shadowDrive);
        shadowDrive.GCR_write_value = orValue & 0xff;
        shadowDrive.byte_ready_level = 0;
      }
    },

    // VIA2 PB = $1C00 — compose pin layout per VICE via2d.c:488
    // read_prb:
    //   req_ref_cycles = BUS_READ_DELAY;
    //   rotation_rotate_disk(drive);
    //   byte = (rotation_sync_found(drive) | drive_writeprotect_sense
    //           | 0x6f) & ~DDRB | (PRB & DDRB);
    //   byte_ready_level = 0;
    readPb: () => {
      if (shadowDrive) {
        shadowDrive.req_ref_cycles = BUS_READ_DELAY;
        rotation_rotate_disk(shadowDrive);
        const syncByte = rotation_sync_found(shadowDrive);
        const wps = drive_writeprotect_sense(shadowDrive);
        shadowDrive.byte_ready_level = 0;
        // Return the raw input-pin composition. Via6522Vice does
        // the DDRB / PRB merge.
        return (syncByte | wps | 0x6f) & 0xff;
      }
      // Legacy shifter fallback when no drive_t.
      let bits = DEFAULT_VIA2_PB_INPUT;
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
      // VICE via2d.c:201 store_prb prologue:
      //   rotation_rotate_disk(drv);
      // Then LED + stepper + density + motor + byte_ready_level=0.
      if (shadowDrive) rotation_rotate_disk(shadowDrive);

      // Spec 443 review — capture poldpb + pre-move stepper state so
      // the VICE Bug-1083 block below uses the SAME old_stepper_position
      // that VICE computes at via2d.c:229,245 (BEFORE any drive_move_head
      // fires).
      const poldpb = lastPbOrValue;
      const trackNumberBefore = headPosition.currentHalfTrack - 2;
      const oldStepperPosBefore = trackNumberBefore & 0x3;
      const newStepperPos = orValue & 0x3;
      let stepCount = (newStepperPos - oldStepperPosBefore) & 0x3;
      if (stepCount === 3) stepCount = -1;

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
      // VICE additionally calls rotation_begins(drv) on motor-on
      // edge so rotation_last_clk gets re-anchored (via2d.c:340).
      if ((ddrMask & PB_MOTOR) !== 0) {
        const wasMotorOn = shadowDrive
          ? ((shadowDrive.byte_ready_active & 0x04) !== 0)
          : false;
        shifter.setMotor(motorOn);
        if (shadowDrive) {
          setDriveMotor(shadowDrive, motorOn);
          if (motorOn && !wasMotorOn) rotation_begins(shadowDrive);
        }
      }

      // Density (PB5/PB6): only honoured when both bits are outputs.
      // Reset-state default = track-derived zone (cleared override),
      // matching the legacy TrackBuffer behaviour during the boot
      // window before drive ROM programs DDR.
      if ((ddrMask & (PB_DENSITY_LO | PB_DENSITY_HI)) ===
          (PB_DENSITY_LO | PB_DENSITY_HI)) {
        const zone = ((orValue >> 5) & 0x03) as 0 | 1 | 2 | 3;
        shifter.setDensity(zone);
        // Spec 441 step 4c — shadow into rotation_t.speed_zone via
        // rotation_speed_zone_set(zone, dnr).
        if (shadowDrive) {
          rotation_speed_zone_set(zone, shadowDrive.diskunit.mynumber);
        }
      } else {
        shifter.clearDensityOverride();
        // No equivalent in VICE — speed zone stays at last-set value.
      }

      // Spec 424 — LED (PB3) reporting hook. PB3 is output (DDR=1)
      // when 1541 DOS controls the LED. Sample latch state when
      // configured as output; otherwise treat as off.
      const ledOutput = (ddrMask & PB_LED) !== 0;
      const ledOn = ledOutput && ((orValue & PB_LED) !== 0);
      if (ledOn !== lastLedOn) {
        lastLedOn = ledOn;
        ledSink?.(ledOn, clkRef ? clkRef() : 0);
      }
      // Spec 443 review — VICE via2d.c:340-351 Bug-1083 block
      // (`#if 1` enabled). When the motor TRANSITIONS (any edge),
      // AND the new stepper position differs from the old, AND the
      // motor is now ON, fire a SECOND drive_move_head call.
      // Reference: "Primitive 7 Sins" requires this extra step on
      // motor-on edge with simultaneous stepper-phase change.
      const motorEdge = ((poldpb ^ orValue) & PB_MOTOR) !== 0;
      if (motorEdge && newStepperPos !== oldStepperPosBefore && motorOn) {
        if (stepCount === 1) headPosition.stepInward();
        else if (stepCount === -1) headPosition.stepOutward();
      }

      // VICE via2d.c:354 store_prb epilogue: byte_ready_level = 0.
      if (shadowDrive) shadowDrive.byte_ready_level = 0;

      // Spec 443 review — remember orValue for next call's poldpb.
      lastPbOrValue = orValue & 0xff;
    },
  };
}
