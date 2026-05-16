// SPEC 611.4 placeholder — replace, do not extend.
//
// Minimal register-storage stub for the 1541 VIA1 (IEC interface
// side). Provides 16 bytes of read/write storage so ROM init can
// touch $1800-$180F without hitting an unimplemented dispatch. No
// timers, no IRQ, no IEC line pulls, no CA1 ATN edge — those land
// in phase 611.4 (via1d.ts real port of VICE via1d1541.c).
//
// VICE viacore reset values (viacore.c):
//   pra = prb = ddra = ddrb = 0
//   acr = pcr = 0
//   ifr = ier = 0
//   t1 / t2 timers and SDR initialised but never driven here.

import type { DiskUnitContext } from "./diskunit.js";

/** Number of byte-addressable VIA registers (the standard 6522 layout). */
export const VIA1D_REG_COUNT = 16;

/** Base address inside drive memory ($1800-$180F, mirrored ×64 in §4). */
export const VIA1D_BASE = 0x1800;

export interface Via1dStub {
  regs: Uint8Array; // length = VIA1D_REG_COUNT
  /** Plain read — returns last-written register value. */
  read(reg: number): number;
  /** Plain write — stores the value, no side effect. */
  write(reg: number, value: number): void;
  /** Reset to viacore defaults (all zero). */
  reset(): void;
}

export function createVia1dStub(_diskunit: DiskUnitContext): Via1dStub {
  const regs = new Uint8Array(VIA1D_REG_COUNT);
  return {
    regs,
    read(reg) {
      return regs[reg & 0x0f] ?? 0;
    },
    write(reg, value) {
      regs[reg & 0x0f] = value & 0xff;
    },
    reset() {
      regs.fill(0);
    },
  };
}
