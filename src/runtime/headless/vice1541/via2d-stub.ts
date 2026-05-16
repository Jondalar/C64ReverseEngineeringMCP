// SPEC 611.5 placeholder — replace, do not extend.
//
// Minimal register-storage stub for the 1541 VIA2 (disk-controller
// side). Provides 16 bytes of read/write storage so ROM init can
// touch $1C00-$1C0F without hitting an unimplemented dispatch. No
// BYTE-READY → SO pulse, no stepper, no motor decode, no
// rotation/GCR coupling — those land in phase 611.5
// (via2d.ts real port of VICE via2d1541.c) and 611.6 (rotation).
//
// The only non-zero default vs the viacore reset baseline:
//   PB read returns PB.4 (WPS = write-protect-sense) = 1 = "not
//   write-protected". On the real 1541 this line is asserted by the
//   drive's WPS photo-sensor; with no disk attached, VICE leaves it
//   high (= not protected). Phase 611.7's attachDisk() will replace
//   this with a real per-image read_only value.

import type { DiskUnitContext } from "./diskunit.js";

/** Number of byte-addressable VIA registers. */
export const VIA2D_REG_COUNT = 16;

/** Base address inside drive memory ($1C00-$1C0F, mirrored ×64 in §4). */
export const VIA2D_BASE = 0x1c00;

/** PB.4 mask (WPS = write-protect sense). */
export const VIA2D_PB_WPS = 0x10;

export interface Via2dStub {
  regs: Uint8Array;
  /** Plain read — PB returns stored value OR WPS bit if drive-side. */
  read(reg: number): number;
  /** Plain write — stores the value, no side effect. */
  write(reg: number, value: number): void;
  /** Reset to viacore defaults. */
  reset(): void;
}

export function createVia2dStub(_diskunit: DiskUnitContext): Via2dStub {
  const regs = new Uint8Array(VIA2D_REG_COUNT);
  return {
    regs,
    read(reg) {
      const r = reg & 0x0f;
      // PB = register 0x00 in the 6522 layout (then PA at 0x01).
      // Drive reads PB to sense WPS in addition to its own writes.
      if (r === 0x00) {
        return (regs[0] | VIA2D_PB_WPS) & 0xff;
      }
      return regs[r] ?? 0;
    },
    write(reg, value) {
      regs[reg & 0x0f] = value & 0xff;
    },
    reset() {
      regs.fill(0);
    },
  };
}
