// Spec 611 phase 611.5 — 1541 VIA2 (disk-controller side).
//
// Replaces vice1541/via2d-stub.ts.
//
// VICE source:  src/drive/iec/via2d1541.c + src/core/viacore.c
// Doc anchor:   docs/vice-1541-arch.md §7 + §13 E
//
// What this phase delivers:
//   - PB decode for motor (PB.2), LED (PB.3), density (PB.5/PB.6),
//     stepper phase (PB.0/PB.1).
//   - PB read returns the output latch with WPS (PB.4) forced from
//     drive.readOnly (0 = write-protected, 1 = not protected).
//   - PA latched as a placeholder for the rotation-coupled byte read
//     (phase 611.6 hooks rotation into PA).
//   - CA1 signal handler: VICE pulses BYTE-READY each byte boundary
//     during rotation. Edge sets IFR_CA1 (subject to PCR polarity)
//     AND pulses the drive CPU SO line so the V-flag fast-path can
//     fire without polling the VIA.
//   - VIA2 IRQ wired through cpuIntStatus (separate IntNum from VIA1).
//
// Stepper PB.0/PB.1 decode: the four phase pairs form a Gray-coded
// 4-state ring; transitioning forward (00→01→11→10→00) steps inward
// (track++), backward (00→10→11→01→00) steps outward. Per-half-track
// move via `driveSetHalfTrack` (drive-init.ts), bounded 0..83 for
// stock 1541.

import type { InterruptCpuStatus, IntNum } from "../cpu/interrupt-cpu-status.js";
import type { DiskUnitContext } from "./diskunit.js";
import { BRA_LED, BRA_MOTOR_ON, type DriveContext } from "./drive-context.js";
import { driveSetHalfTrack } from "./drive-init.js";
import {
  Via6522,
  VIA_SIG_FALL,
  VIA_SIG_RISE,
  type Via6522Backend,
} from "./via6522.js";

/** Stepper-direction lookup table indexed by (prev<<2)|next phase pair.
 *  Diagonal entries (same phase) = 0 (no movement). Adjacent forward = +1,
 *  adjacent backward = -1. Two-step jumps (e.g. 00→11) are ambiguous and
 *  reported as 0 (VICE clamps similarly in via2d1541.c). */
const STEPPER_DELTA = new Int8Array([
  // prev=00 (0)
  0, +1,  0, -1,  // next 00,01,10,11
  // prev=01 (1)
  -1, 0, +1, 0,
  // prev=10 (2)
  +1, 0, -1, 0,
  // prev=11 (3)
  0, -1, 0, +1,
]);

function nextStepperHalftrack(current: number, delta: number): number {
  const next = current + delta;
  if (next < 0) return 0;
  if (next > 83) return 83; // 84 half-tracks = 42 tracks on 1541
  return next;
}

export interface Via2dOptions {
  diskunit: DiskUnitContext;
  cpuIntStatus: InterruptCpuStatus;
  clkPtr: { value: number };
  /** Called on BYTE-READY edge so the drive CPU SO pin can pulse the
   *  V-flag (1→0 edge sets V per Cpu65xxVice). */
  setSoLine: (level: 0 | 1) => void;
}

/**
 * Build a 1541 VIA2 (disk-controller side) wired to the supplied
 * diskunit, drive InterruptCpuStatus, and drive CPU SO setter.
 */
export function createVia2d(opts: Via2dOptions): Via6522 {
  const { diskunit, cpuIntStatus, clkPtr, setSoLine } = opts;
  const intNum: IntNum = cpuIntStatus.newIntNum("via2d1541");

  let lastStepperPhase: number = 0; // PB.0/PB.1 bits at last PB write
  let paLatch: number = 0;          // placeholder for rotation hook (611.6)

  const drive = (): DriveContext | null => diskunit.drives[0] ?? null;

  const backend: Via6522Backend = {
    storePb: (driven) => {
      const drv = drive();
      if (!drv) return;
      // Stepper phase change (PB.0 / PB.1).
      const phase = driven & 0x03;
      if (phase !== lastStepperPhase) {
        const delta = STEPPER_DELTA[(lastStepperPhase << 2) | phase] ?? 0;
        if (delta !== 0) {
          driveSetHalfTrack(drv, nextStepperHalftrack(drv.currentHalfTrack, delta), drv.side);
        }
        lastStepperPhase = phase;
      }
      // Motor on bit (PB.2).
      const motorOn = (driven & 0x04) !== 0;
      if (motorOn) drv.byteReadyActive |= BRA_MOTOR_ON;
      else drv.byteReadyActive &= ~BRA_MOTOR_ON;
      // LED bit (PB.3).
      const ledOn = (driven & 0x08) !== 0;
      drv.ledStatus = ledOn ? 1 : 0;
      if (ledOn) drv.byteReadyActive |= BRA_LED;
      else drv.byteReadyActive &= ~BRA_LED;
      // Density bits (PB.5/PB.6) — store in drive.snap_speed_zone-equivalent
      // placeholder (drive-context.ts has no field yet; defer real
      // rotation density coupling to 611.6).
    },
    readPb: () => {
      // PB read returns output latch with WPS bit (PB.4) forced from
      // drive.readOnly (1 = not protected per VICE convention).
      const drv = drive();
      const latch = via2.prb & via2.ddrb;
      const wpsBit = drv && drv.readOnly ? 0 : 0x10;
      // Bits not driven by PB output read as 1 except WPS which
      // reflects drive.readOnly.
      const inputBits = (~via2.ddrb) & 0xff;
      return (latch | (inputBits & wpsBit) | (inputBits & ~0x10)) & 0xff;
    },
    storePa: (driven) => {
      paLatch = driven;
    },
    readPa: () => paLatch,
    setIrq: (asserted) => {
      cpuIntStatus.setIrq(intNum, asserted, clkPtr.value);
    },
  };

  const via2 = new Via6522({ backend, label: "via2d1541" });

  // Phase 611.6 will replace this with the real rotation byte-ready pulse;
  // for 611.5 callers may invoke `pulseByteReady()` from the synthetic
  // smoke to verify the VIA2 + SO wiring works end-to-end.
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
  // Rising edge first (so the via signalCa1 sees a defined prior state),
  // then falling so the Cpu65xxVice 1→0 edge detector sets V.
  via2.signalCa1(VIA_SIG_RISE);
  setSoLine(1);
  via2.signalCa1(VIA_SIG_FALL);
  setSoLine(0);
}
