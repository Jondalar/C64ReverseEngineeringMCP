// Spec 611 phase 611.4 — 1541 VIA1 (IEC interface side).
//
// Replaces vice1541/via1d-stub.ts.
//
// VICE source:  src/drive/iec/via1d1541.c + src/core/viacore.c
// Doc anchor:   docs/vice-1541-arch.md §6 + §13 D
//               docs/vice-iec-arc42.md §5.5 + §6
//
// What this phase delivers:
//   - PB read formula from VICE read_prb: `((PRB & 0x1A) | drv_port) ^ 0x85`
//   - PB write → drive_data update on the IEC bus (DATA_OUT / CLK_OUT
//     / ATNA bits decoded per arch §6.3).
//   - CA1 = ATN line input. ATN edge (falling, per PCR config) sets
//     IFR_CA1 and raises drive IRQ via cpuIntStatus.
//   - VIA1 IRQ wired through the Via6522 backend to the drive 6502's
//     InterruptCpuStatus.
//
// VIA2 (disk controller) stays as via2d-stub for 611.4; the drive
// 1541 KERNAL initialises both VIAs at boot, but IEC ATN handling
// flows through VIA1 only.

import type { InterruptCpuStatus, IntNum } from "../cpu/interrupt-cpu-status.js";
import type { Vice1541IecBus } from "./iec-bus.js";
import {
  Via6522,
  VIA_SIG_FALL,
  VIA_SIG_RISE,
  type Via6522Backend,
} from "./via6522.js";

/**
 * VIA1 PB write — decode drive output bits into the IEC bus model.
 *
 * VICE store_prb (via1d1541.c): the drive writes PRB; bits 1, 3, 4
 * (DATA_OUT, CLK_OUT, ATNA) update the drive's bus contribution.
 *
 * Drive PB bit map per arch doc §6.1:
 *   PB.0 = DATA_IN  (read-only)
 *   PB.1 = DATA_OUT (active-low — 0 = pull, 1 = release)
 *   PB.2 = CLK_IN   (read-only)
 *   PB.3 = CLK_OUT  (active-low — 0 = pull, 1 = release)
 *   PB.4 = ATNA     (active-low — 0 = ack, 1 = release)
 *   PB.5/6 = driveid (read-only)
 *   PB.7 = ATN_IN   (read-only)
 */
function storePb(bus: Vice1541IecBus, driven: number): void {
  // Output bits the drive currently drives onto the bus.
  // PB.1 / PB.3 / PB.4 — VICE bit-of-PRB → IEC.
  bus.drvDataReleased = (driven & 0x02) !== 0;
  bus.drvClkReleased = (driven & 0x08) !== 0;
  bus.drvAtnaReleased = (driven & 0x10) !== 0;
}

/**
 * VIA1 PB read formula per VICE `via1d1541.c:337-355` (verbatim):
 *
 *   tmp  = (drv_port ^ 0x85) | 0x1a | driveid;
 *   byte = (PRB & DDRB) | (tmp & ~DDRB);
 *
 * The backend returns `tmp` here; the DDR fold lives in
 * `Via6522.read(VIA_PRB)`. This matters when DDRB configures any of
 * bits 1/3/4 (DATA_OUT / CLK_OUT / ATNA) as **input**: VICE forces
 * those input-side defaults *high* via the `| 0x1a` mask, regardless
 * of the PRB latch. An earlier draft pre-folded PRB into the input
 * value, which leaked the PRB latch through bits 1/3/4 when they
 * were configured as input — Codex 14:51 UTC review caught it.
 *
 * `driveid` encodes the unit number into bits 5/6 of the PB read (so
 * the 1541 firmware can read its own device number). Single-1541 on
 * device 8 ⇒ driveid = 0; device 9 ⇒ 0x20; device 10 ⇒ 0x40;
 * device 11 ⇒ 0x60. We compute it from the diskunit's `mynumber`
 * convention (mynumber = unit - 8).
 */
function readPb(bus: Vice1541IecBus, driveid: number): number {
  return (((bus.driveDrvPort() ^ 0x85) | 0x1a | driveid) & 0xff);
}

export interface Via1dOptions {
  bus: Vice1541IecBus;
  /** Drive 6502 interrupt-status into which VIA1 IRQ pushes. */
  cpuIntStatus: InterruptCpuStatus;
  /** Read-side clock provider so `setIrq` can stamp a release clock. */
  clkPtr: { value: number };
  /** VICE diskunit `mynumber` (= device-number minus 8). */
  mynumber?: number;
}

/**
 * Build a 1541 VIA1 (IEC side) wired to the supplied IEC bus and
 * drive InterruptCpuStatus. Returns the Via6522 instance so callers
 * can `signalCa1()` on ATN edges.
 */
export function createVia1d(opts: Via1dOptions): Via6522 {
  const { bus, cpuIntStatus, clkPtr } = opts;
  const intNum: IntNum = cpuIntStatus.newIntNum("via1d1541");
  // driveid = mynumber bits packed into PB.5/PB.6 (covers devices 8..11).
  const driveid = ((opts.mynumber ?? 0) & 0x03) << 5;

  const backend: Via6522Backend = {
    storePb: (driven) => storePb(bus, driven),
    readPb: () => readPb(bus, driveid),
    setIrq: (asserted) => {
      cpuIntStatus.setIrq(intNum, asserted, clkPtr.value);
    },
  };

  const via1 = new Via6522({ backend, label: "via1d1541" });
  return via1;
}

/**
 * Drive a CA1 (= ATN line) edge into the VIA1 from the IEC bus side.
 * Caller is responsible for tracking ATN polarity changes and only
 * invoking this when an edge actually occurs.
 */
export function signalVia1Ca1(via1: Via6522, atnReleased: boolean): void {
  via1.signalCa1(atnReleased ? VIA_SIG_RISE : VIA_SIG_FALL);
}
