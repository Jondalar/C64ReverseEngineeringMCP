// Spec 611 phase 611.5 — 1541 VIA2 (disk-controller side).
//
// VICE source:  src/drive/iecieee/via2d.c + src/core/viacore.c
// Doc anchor:   docs/vice-1541-arch.md §7 + §13 E
//
// Replaces vice1541/via2d-stub.ts.
//
// What this phase delivers (VICE-shaped, with rotation calls routed
// through `vice1541/rotation-stub.ts` until 611.6 lands real rotation):
//   - store_prb VICE-shaped side effects per via2d.c:199-355:
//       * rotation_rotate_disk(diskunit)
//       * stepper formula derived from current_half_track (NOT a
//         private latch), gated on motor-on (PB.2)
//       * LED update + drive.byteReadyActive BRA_LED bit
//       * speed_zone update via rotation_speed_zone_set((byte >> 5) & 3)
//       * motor on/off transitions update byte_ready_active +
//         rotation_begins() on motor-on edge
//       * byte_ready_level = 0 at end
//   - store_pra (via2d.c:180-192): writes GCR_write_value, clears
//     byte_ready_level
//   - read_pra (via2d.c:463-483): rotation_byte_read, fold through
//     DDRA, clear byte_ready_level
//   - read_prb returns drive WPS via drive_writeprotect_sense()
//   - set_ca2 (via2d.c:72-93): toggles BRA_BYTE_READY bit in
//     byte_ready_active; may fire SO if byte_ready_edge already set
//   - set_cb2 (via2d.c:95-110): updates drive.readWriteMode = state<<5
//   - signalCa1 (BYTE-READY input): sets IFR_CA1 per PCR; also
//     pulses cpu SO line so the V-flag fast path fires.

import type { InterruptCpuStatus, IntNum } from "../cpu/interrupt-cpu-status.js";
import type { DiskUnitContext } from "./diskunit.js";
import { BRA_BYTE_READY, BRA_LED, BRA_MOTOR_ON, type DriveContext } from "./drive-context.js";
import { driveSetHalfTrack } from "./drive-init.js";
import {
  BUS_READ_DELAY,
  drive_writeprotect_sense,
  rotation_begins,
  rotation_byte_read,
  rotation_rotate_disk,
  rotation_speed_zone_set,
  rotation_sync_found,
} from "./rotation-stub.js";
import {
  Via6522,
  VIA_SIG_FALL,
  VIA_SIG_RISE,
  type Via6522Backend,
} from "./via6522.js";

export interface Via2dOptions {
  diskunit: DiskUnitContext;
  cpuIntStatus: InterruptCpuStatus;
  clkPtr: { value: number };
  /** Called on BYTE-READY rotation pulse so the drive CPU SO pin can
   *  pulse the V-flag (1→0 edge sets V per Cpu65xxVice). */
  setSoLine: (level: 0 | 1) => void;
  /** Called by set_ca2 for VICE's direct `cpu->set_overflow(cpu)` path
   *  (via2d.c:76). Sets V flag synchronously, not via SO toggle. */
  setOverflowFlag: () => void;
}

/**
 * Build a 1541 VIA2 (disk-controller side) wired to the supplied
 * diskunit, drive InterruptCpuStatus, and drive CPU SO setter.
 */
export function createVia2d(opts: Via2dOptions): Via6522 {
  const { diskunit, cpuIntStatus, clkPtr, setSoLine, setOverflowFlag } = opts;
  const intNum: IntNum = cpuIntStatus.newIntNum("via2d1541");

  const drv = (): DriveContext | null => diskunit.drives[0] ?? null;

  const backend: Via6522Backend = {
    storePb: (driven) => {
      const d = drv();
      if (!d) return;
      // VICE via2d.c:199 — rotation catches up on every PB write.
      rotation_rotate_disk(diskunit);

      // LED bit (PB.3) — VICE drive_led toggle.
      const ledOn = (driven & 0x08) !== 0;
      d.ledStatus = ledOn ? 1 : 0;
      if (ledOn) d.byteReadyActive |= BRA_LED;
      else d.byteReadyActive &= ~BRA_LED;

      // VICE via2d.c:228-255 — stepper formula derived from current_half_track.
      // track_number = drv->current_half_track - 2;
      // old_stepper_position = track_number & 3;
      // step_count = (new_stepper_position - old_stepper_position) & 3;
      // if (step_count == 3) step_count = -1;
      // Motor gate: only step if PB.2 (motor on) is set.
      if ((driven & 0x04) !== 0) {
        const trackNumber = d.currentHalfTrack - 2;
        const oldPos = trackNumber & 3;
        const newPos = driven & 0x03;
        let step = (newPos - oldPos) & 3;
        if (step === 3) step = -1;
        if (step !== 0) {
          let next = d.currentHalfTrack + step;
          if (next < 0) next = 0;
          if (next > 83) next = 83;
          driveSetHalfTrack(d, next, d.side);
        }
      }

      // Motor on/off bit (PB.2). VICE via2d.c:299-345 transitions:
      const wasMotorOn = (d.byteReadyActive & BRA_MOTOR_ON) !== 0;
      const isMotorOn = (driven & 0x04) !== 0;
      if (isMotorOn) {
        d.byteReadyActive |= BRA_MOTOR_ON;
        if (!wasMotorOn) rotation_begins(diskunit);
      } else {
        d.byteReadyActive &= ~BRA_MOTOR_ON;
        // VICE clears byte_ready_edge on motor-off transition; we
        // surface this by also dropping the SO line (V-flag stays
        // sticky in 6502 until explicit CLV — that matches VICE).
        if (wasMotorOn) {
          d.byteReadyEdge = 0;
          setSoLine(1); // release SO (high = idle)
        }
      }

      // Density bits (PB.5/PB.6) → speed zone.
      const zone = (driven >> 5) & 0x03;
      rotation_speed_zone_set(zone, diskunit);

      // VICE via2d.c:348 — clear byte_ready_level at end of store_prb.
      d.byteReadyLevel = 0;
    },

    readPb: () => {
      // VICE via2d.c:486-511 read_prb (verbatim shape):
      //   drive->req_ref_cycles = BUS_READ_DELAY;
      //   rotation_rotate_disk(drive);
      //   byte = ((rotation_sync_found(drive)
      //          | drive_writeprotect_sense(drive)
      //          | 0x6f) & ~DDRB) | (PRB & DDRB);
      //   drive->byte_ready_level = 0;
      //
      // sync_found returns 0 or SYNC mask (bit 7, 0x80).
      // wps_sense returns true (= not protected) ⇒ bit 4 (0x10).
      // 0x6f = bits 0/1/2/3/5/6 (= all OUT-side defaults high).
      // Backend returns the unmasked `tmp`; `Via6522.read(VIA_PRB)`
      // does the (PRB & DDRB) | (tmp & ~DDRB) fold.
      const d = drv();
      if (d) d.reqRefCycles = BUS_READ_DELAY;
      rotation_rotate_disk(diskunit);
      const sync = rotation_sync_found(diskunit) ? 0x80 : 0x00;
      const wps = drive_writeprotect_sense(d) ? 0x10 : 0x00;
      const tmp = (sync | wps | 0x6f) & 0xff;
      if (d) d.byteReadyLevel = 0;
      return tmp;
    },

    storePa: (driven) => {
      // VICE via2d.c:180-192 — store_pra sets GCR_write_value, clears
      // byte_ready_level.
      const d = drv();
      if (!d) return;
      d.gcrWriteValue = driven & 0xff;
      d.byteReadyLevel = 0;
    },

    readPa: () => {
      // VICE via2d.c:463-483 — read_pra:
      //   req_ref_cycles = BUS_READ_DELAY;     (= 14 per rotation.h:35)
      //   rotation_byte_read(drive);
      //   byte = drive->GCR_read;
      //   byte = (byte & ~ddra) | (pra & ddra);
      //   byte_ready_level = 0;
      const d = drv();
      if (!d) return 0;
      d.reqRefCycles = BUS_READ_DELAY;
      rotation_byte_read(diskunit);
      const byte = d.gcrRead & 0xff;
      // PRA fold (PRA & DDRA) is performed by Via6522.read(PRA);
      // we return the input-bit value, via core handles the output overlay.
      d.byteReadyLevel = 0;
      return byte;
    },

    setIrq: (asserted) => {
      cpuIntStatus.setIrq(intNum, asserted, clkPtr.value);
    },

    // VICE via2d.c:72-93 set_ca2: toggles BRA_BYTE_READY bit in
    // byte_ready_active. When BRA_BYTE_READY is set AND byte_ready_edge
    // is already set, VICE fires the SO overflow immediately and
    // clears byte_ready_edge.
    //
    // Edge-order note: Cpu65xxVice detects a 1→0 transition at the
    // start of `executeCycle()`. So to make the V-flag actually fire,
    // the final line state must be LOW. Use release-then-fall
    // (`setSoLine(1)` → `setSoLine(0)`), same pattern as
    // pulseByteReady().
    setCa2: (state) => {
      // VICE via2d.c:72-93 set_ca2 (verbatim shape):
      //   if (state) {
      //       drive->byte_ready_active |= BRA_BYTE_READY;
      //       if (drive->byte_ready_edge) {
      //           drive->cpu->set_overflow(drive->cpu);  // direct V flag
      //           drive->byte_ready_edge = 0;
      //       }
      //   } else {
      //       drive->byte_ready_active &= ~BRA_BYTE_READY;
      //   }
      const d = drv();
      if (!d) return;
      if (state) {
        d.byteReadyActive |= BRA_BYTE_READY;
        if (d.byteReadyEdge) {
          setOverflowFlag();
          d.byteReadyEdge = 0;
        }
      } else {
        d.byteReadyActive &= ~BRA_BYTE_READY;
      }
    },

    // VICE via2d.c:95-110 set_cb2: read_write_mode = state << 5.
    setCb2: (state) => {
      const d = drv();
      if (!d) return;
      d.readWriteMode = (state ? 1 : 0) << 5;
    },
  };

  const via2 = new Via6522({ backend, label: "via2d1541" });
  return via2;
}

/**
 * Pulse BYTE-READY on the supplied VIA2 + drive CPU SO line. Public
 * helper for 611.5 synthetic smoke + the eventual 611.6 rotation
 * driver.
 */
export function pulseByteReady(
  via2: Via6522,
  setSoLine: (level: 0 | 1) => void,
): void {
  via2.signalCa1(VIA_SIG_RISE);
  setSoLine(1);
  via2.signalCa1(VIA_SIG_FALL);
  setSoLine(0);
}
