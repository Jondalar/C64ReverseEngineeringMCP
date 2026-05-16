// Spec 611 phase 611.2 — port of VICE diskunit_context_t shape.
//
// VICE source:  src/drive/drivetypes.h diskunit_context_s
// Doc anchor:   docs/vice-1541-arch.md §2.1 + §13 A (1–2)
//
// Data-shape only. Sub-context fields (cpu/cpud/via1/via2) are
// declared as nullable here; real ports land in later phases
// (cpu/cpud → 611.3, via1 → 611.4, via2 → 611.5).

import type { DriveContext } from "./drive-context.js";

/** Allocated drive RAM buffer (64 KB; 1541 uses 2 KB at $0000-$07FF). */
export const DRIVE_RAM_SIZE = 65_536;
/** Allocated drive ROM buffer (32 KB; 1541 uses 16 KB at $C000-$FFFF). */
export const DRIVE_ROM_SIZE = 32_768;
/** Slots per unit. 1541 uses slot 0 only; 1571/1581 may use slot 1. */
export const NUM_DRIVES = 2;

/** Drive types relevant for the 1541-family (Spec 611 ports 1541 only). */
export const DRIVE_TYPE_1541 = 1541;
export const DRIVE_TYPE_1541II = 1542;
export const DRIVE_TYPE_1570 = 1570;
export const DRIVE_TYPE_1571 = 1571;
export const DRIVE_TYPE_1581 = 1581;

/**
 * Idling-method enum (drive.c IDLE_*). 1541 default is IDLE_NO_IDLE.
 */
export const IDLE_NO_IDLE = 0;
export const IDLE_SKIP_CYCLES = 1;
export const IDLE_TRAP_IDLE = 2;

/** Parallel-cable enum (drive.h DRIVE_PC_*). 1541 default is NONE. */
export const DRIVE_PC_NONE = 0;

/**
 * Shared mutable clock counter. VICE uses `CLOCK *clk_ptr` so the
 * drive CPU and the host can both reference the same counter; in TS we
 * wrap it in a single-field object for shared-reference semantics.
 */
export interface ClockRef {
  value: number;
}

/**
 * Direct port of `diskunit_context_t` from `src/drive/drivetypes.h`.
 * Fields whose backing structs are not yet ported are typed `null`
 * and will be tightened as later phases land.
 */
export interface DiskUnitContext {
  mynumber: number;                // 0..NUM_DISK_UNITS-1; for 1541-only setups always 0
  clkPtr: ClockRef;                // shared drive clock counter
  drives: Array<DriveContext | null>; // length NUM_DRIVES; slot 1 unused on 1541

  // Sub-context placeholders. Tightened per phase.
  cpu: null;                       // drivecpu_context_t → phase 611.3
  cpud: null;                      // drivecpud_context_t → phase 611.3
  via1d1541: null;                 // VIA1 → phase 611.4
  via2: null;                      // VIA2 → phase 611.5
  cia1571: null;                   // 1571 only — not used by 1541

  enable: number;                  // 0/1
  type: number;                    // DRIVE_TYPE_*
  clockFrequency: number;          // 1 = 1 MHz (1541)

  idlingMethod: number;            // IDLE_*
  parallelCable: number;           // DRIVE_PC_*

  rom: Uint8Array;                 // DRIVE_ROM_SIZE
  trapRom: Uint8Array;             // ROM with idle traps patched in
  trap: number;
  trapcont: number;
  drvRam: Uint8Array;              // DRIVE_RAM_SIZE

  log: number;                     // VICE log handle; -1 = none
}

/**
 * Build an idle DiskUnitContext for unit 0 / 1541 / no disk attached.
 *
 * 611.2 acceptance ("Factory constructs vice module without throw")
 * relies on this returning a fully-initialised shape — no field is
 * left undefined.
 */
export function createIdleDiskUnitContext(unit = 0): DiskUnitContext {
  return {
    mynumber: unit,
    clkPtr: { value: 0 },
    drives: new Array(NUM_DRIVES).fill(null),

    cpu: null,
    cpud: null,
    via1d1541: null,
    via2: null,
    cia1571: null,

    enable: 0,                     // not enabled until reset/attach
    type: DRIVE_TYPE_1541,
    clockFrequency: 1,             // 1 MHz

    idlingMethod: IDLE_NO_IDLE,
    parallelCable: DRIVE_PC_NONE,

    rom: new Uint8Array(DRIVE_ROM_SIZE),
    trapRom: new Uint8Array(DRIVE_ROM_SIZE),
    trap: -1,
    trapcont: -1,
    drvRam: new Uint8Array(DRIVE_RAM_SIZE),

    log: -1,
  };
}
