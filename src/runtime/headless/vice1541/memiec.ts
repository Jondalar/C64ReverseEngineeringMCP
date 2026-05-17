// PORT OF: vice/src/drive/iec/memiec.c (full file, 282 lines)
// PORT OF: vice/src/drive/iec/memiec.h (full file, 36 lines — folded here per NL-1)
// VICE rev: tree-state of /Users/alex/Development/C64/Tools/vice/vice/src as of 2026-05-17
//
// Spec 612 — 1541 Port Fidelity Rules
//   §1 NL-1 (memiec.c → memiec.ts; .h folds into .ts)
//   §1 NL-2 (function names verbatim VICE snake_case)
//   §1 NL-3 (first arg = diskunit_context_t per VICE)
//   §2 PL-1 (NO class — module-level functions only)
//   §2 PL-3 (NO "MemoryMap" / "Bus" / "Bindings" wrapper invented here —
//            we call drivemem_set_func() directly per VICE)
//   §2 PL-5 (drive_read_zero / drive_store_zero / drive_read_1541ram /
//            drive_store_1541ram / drive_read_ram / drive_store_ram /
//            drive_read_rom et al. are ports of the C statics — every helper
//            traces back to a VICE symbol in memiec.c)
//   §5     (every export has a PORT OF comment within 5 lines)
//
// =============================================================================
// DISPATCH CONTRACT
// =============================================================================
//
// VICE memiec.c installs the 1541-family memory map by calling
// drivemem_set_func() on the unit's drivecpud_context_t page tables. The
// callee (drivemem.ts) updates `read_tab[0][page]`, `store_tab[0][page]`,
// `peek_tab[0][page]`, `read_base_tab[0][page]`, `read_limit_tab[0][page]`
// for each page in the supplied [start, stop) range.
//
// The 1541 memory map per VICE memiec.c:132-177:
//
//   $0000-$00FF  drive_ram zero page                  drive_read_zero / drive_store_zero
//   $0100-$07FF  drive_ram pages 1..7 (incl. stack)   drive_read_1541ram / drive_store_1541ram
//   $0800-$17FF  open bus (default drive_read_free)   NOT installed by memiec_init
//   $1800-$1BFF  VIA1                                  via1d1541_read / via1d1541_store
//   $1C00-$1FFF  VIA2                                  via2d_read     / via2d_store
//   $2000-$27FF  drive_ram mirror (if !ram2_enabled)  drive_read_1541ram (mask & 0x7ff)
//                                                     OR drive_ram[$2000] expansion if ram2_enabled
//   $2800-$37FF  open bus
//   $3800-$3BFF  VIA1 mirror (if !ram2_enabled)
//   $3C00-$3FFF  VIA2 mirror (if !ram2_enabled)
//   $4000-$47FF  drive_ram mirror (if !ram4_enabled) OR drive_ram[$4000] expansion
//   $5800-$5BFF  VIA1 mirror (if !ram4_enabled)
//   $5C00-$5FFF  VIA2 mirror (if !ram4_enabled)
//   $6000-$67FF  drive_ram mirror (if !ram6_enabled) OR drive_ram[$6000] expansion
//   $7800-$7BFF  VIA1 mirror (if !ram6_enabled)
//   $7C00-$7FFF  VIA2 mirror (if !ram6_enabled)
//   $8000-$9FFF  trap_rom[$0000-$1FFF]                drive_read_rom (read-only)
//                                                     OR drive_ram[$8000] if ram8_enabled
//   $A000-$BFFF  trap_rom[$2000-$3FFF]                drive_read_rom
//                                                     OR drive_ram[$A000] if rama_enabled
//   $C000-$FFFF  trap_rom[$4000-$7FFF]                drive_read_rom
//
// The non-1541 cases in VICE memiec.c (1570/1571, 1571CR, 1581, 2000/4000,
// CMDHD) require chip ports that are out of scope for Spec 612 layer 6
// (`wd1770`, `cia1571`, `cia1581`, `mos5710`, `via4000`, `pc8477`, `cmdhd`,
// `ds1216e`). They are kept as `throw`-stubs with a clear spec marker per
// the precedent in `feedback_p64_stubs_ok.md` (2026-05-13: stubs must throw
// loudly, not silently no-op). The 1541 family path (DRIVE_TYPE_1540 /
// DRIVE_TYPE_1541 / DRIVE_TYPE_1541II) is fully ported.
//
// =============================================================================

import type {
  diskunit_context_t,
} from "./drivetypes.js";

import {
  DRIVE_TYPE_1540,
  DRIVE_TYPE_1541,
  DRIVE_TYPE_1541II,
  DRIVE_TYPE_1570,
  DRIVE_TYPE_1571,
  DRIVE_TYPE_1571CR,
  DRIVE_TYPE_1581,
  DRIVE_TYPE_2000,
  DRIVE_TYPE_4000,
  DRIVE_TYPE_CMDHD,
} from "./drivetypes.js";

import { drivemem_set_func } from "./drivemem.js";

import {
  via1d1541_read,
  via1d1541_store,
  via1d1541_peek,
} from "./via1d1541.js";

import {
  via2d_read,
  via2d_store,
  via2d_peek,
} from "./via2d.js";

// =============================================================================
// SECTION 1 — ROM HELPERS (memiec.c:54-74)
// =============================================================================

// PORT OF: vice/src/drive/iec/memiec.c:54-58 (drive_read_rom)
// Reads from drv->rom masked by 0x7fff (32 KB ROM image window). Echoes the
// byte back through cpu_last_data per VICE's open-bus model.
// LOG() macro elided per Spec 612 §2 PL-5.
function drive_read_rom(drv: diskunit_context_t, address: number): number {
  const v = drv.rom[address & 0x7fff]!;
  drv.cpu!.cpu_last_data = v;
  return v;
}

// PORT OF: vice/src/drive/iec/memiec.c:60-64 (drive_peek_rom)
// Monitor non-side-effecting variant — same value as drive_read_rom but
// never mutates cpu_last_data.
function drive_peek_rom(drv: diskunit_context_t, address: number): number {
  return drv.rom[address & 0x7fff]!;
}

// =============================================================================
// SECTION 2 — RAM HELPERS (memiec.c:76-128)
// =============================================================================

// PORT OF: vice/src/drive/iec/memiec.c:76-80 (drive_read_ram)
// Used for the 8KB RAM expansion regions ($2000/$4000/$6000/$8000/$A000)
// and the 1581/CMDHD memory maps (latter two stubbed). cpu_last_data echo
// per VICE.
function drive_read_ram(drv: diskunit_context_t, address: number): number {
  const v = drv.drive_ram[address]!;
  drv.cpu!.cpu_last_data = v;
  return v;
}

// PORT OF: vice/src/drive/iec/memiec.c:82-86 (drive_peek_ram)
function drive_peek_ram(drv: diskunit_context_t, address: number): number {
  return drv.drive_ram[address]!;
}

// PORT OF: vice/src/drive/iec/memiec.c:88-92 (drive_store_ram)
// cpu_last_data updated BEFORE the RAM write (matches VICE order — the
// open-bus value reflects what the CPU drove on the data bus).
function drive_store_ram(drv: diskunit_context_t, address: number, value: number): void {
  drv.cpu!.cpu_last_data = value & 0xff;
  drv.drive_ram[address] = value & 0xff;
}

// PORT OF: vice/src/drive/iec/memiec.c:94-98 (drive_read_1541ram)
// 2KB drive RAM mirror — `address & 0x7ff` wraps any access into the first
// 2KB. This is how the 1541's open address-decoder maps RAM into
// $0000-$07FF / $2000-$27FF / $4000-$47FF / $6000-$67FF.
function drive_read_1541ram(drv: diskunit_context_t, address: number): number {
  const v = drv.drive_ram[address & 0x7ff]!;
  drv.cpu!.cpu_last_data = v;
  return v;
}

// PORT OF: vice/src/drive/iec/memiec.c:100-104 (drive_peek_1541ram)
function drive_peek_1541ram(drv: diskunit_context_t, address: number): number {
  return drv.drive_ram[address & 0x7ff]!;
}

// PORT OF: vice/src/drive/iec/memiec.c:106-110 (drive_store_1541ram)
function drive_store_1541ram(drv: diskunit_context_t, address: number, value: number): void {
  drv.cpu!.cpu_last_data = value & 0xff;
  drv.drive_ram[address & 0x7ff] = value & 0xff;
}

// PORT OF: vice/src/drive/iec/memiec.c:112-116 (drive_read_zero)
// Zero-page read — `address & 0xff` wraps any 16-bit access into the first
// 256 bytes. Used by the zero-page slot in every drive type's memory map.
function drive_read_zero(drv: diskunit_context_t, address: number): number {
  const v = drv.drive_ram[address & 0xff]!;
  drv.cpu!.cpu_last_data = v;
  return v;
}

// PORT OF: vice/src/drive/iec/memiec.c:118-122 (drive_peek_zero)
function drive_peek_zero(drv: diskunit_context_t, address: number): number {
  return drv.drive_ram[address & 0xff]!;
}

// PORT OF: vice/src/drive/iec/memiec.c:124-128 (drive_store_zero)
function drive_store_zero(drv: diskunit_context_t, address: number, value: number): void {
  drv.cpu!.cpu_last_data = value & 0xff;
  drv.drive_ram[address & 0xff] = value & 0xff;
}

// =============================================================================
// SECTION 3 — memiec_init (memiec.c:132-281)
// =============================================================================

// Installs the per-drive-type 1541-family (and friends) memory map onto the
// unit's drivecpud_context_t page tables via drivemem_set_func(). The drive
// type switch maps verbatim to VICE memiec.c:136-280.
//
// Spec 612 §10 scope: only the DRIVE_TYPE_1540 / DRIVE_TYPE_1541 /
// DRIVE_TYPE_1541II path is fully ported. Other types throw a PORT-STUB
// error (P64 stubs OK precedent — loud failure, never silent no-op).
//
// PORT OF: vice/src/drive/iec/memiec.c:132-281 (memiec_init)
export function memiec_init(drv: diskunit_context_t, type: number): void {
  const cpud = drv.cpud!;

  switch (type) {
    case DRIVE_TYPE_1540:
    case DRIVE_TYPE_1541:
    case DRIVE_TYPE_1541II:
      // VICE: drv->cpu->pageone = drv->drive_ram + 0x100;
      // The stack page pointer is set to RAM[0x100..0x1FF] so the CPU core
      // can dispatch stack pushes/pulls without going through the page
      // tables.
      drv.cpu!.pageone = drv.drive_ram.subarray(0x100);

      // $0000-$00FF zero page (mask & 0xff)
      drivemem_set_func(cpud, 0x00, 0x01, drive_read_zero, drive_store_zero, drive_peek_zero, null, 0);

      // $0100-$07FF RAM (mask & 0x7ff). VICE base = &drv->drive_ram[0x0100].
      drivemem_set_func(cpud, 0x01, 0x08, drive_read_1541ram, drive_store_1541ram, drive_peek_1541ram, drv.drive_ram.subarray(0x0100), 0);

      // $1800-$1BFF VIA1 (drive-side, IEC bus)
      drivemem_set_func(cpud, 0x18, 0x1c, via1d1541_read, via1d1541_store, via1d1541_peek, null, 0);

      // $1C00-$1FFF VIA2 (disk-controller side)
      drivemem_set_func(cpud, 0x1c, 0x20, via2d_read, via2d_store, via2d_peek, null, 0);

      // $2000-$3FFF: RAM expansion at $2000 if ram2_enabled, otherwise
      // mirror of drive RAM ($2000-$27FF only) + VIA1/VIA2 mirrors.
      if (drv.drive_ram2_enabled) {
        drivemem_set_func(cpud, 0x20, 0x40, drive_read_ram, drive_store_ram, drive_peek_ram, drv.drive_ram.subarray(0x2000), 0);
      } else {
        drivemem_set_func(cpud, 0x20, 0x28, drive_read_1541ram, drive_store_1541ram, drive_peek_1541ram, drv.drive_ram, 0);
        drivemem_set_func(cpud, 0x38, 0x3c, via1d1541_read, via1d1541_store, via1d1541_peek, null, 0);
        drivemem_set_func(cpud, 0x3c, 0x40, via2d_read, via2d_store, via2d_peek, null, 0);
      }

      // $4000-$5FFF: RAM expansion at $4000 if ram4_enabled, otherwise
      // mirror of drive RAM ($4000-$47FF only) + VIA1/VIA2 mirrors.
      if (drv.drive_ram4_enabled) {
        drivemem_set_func(cpud, 0x40, 0x60, drive_read_ram, drive_store_ram, drive_peek_ram, drv.drive_ram.subarray(0x4000), 0);
      } else {
        drivemem_set_func(cpud, 0x40, 0x48, drive_read_1541ram, drive_store_1541ram, drive_peek_1541ram, drv.drive_ram, 0);
        drivemem_set_func(cpud, 0x58, 0x5c, via1d1541_read, via1d1541_store, via1d1541_peek, null, 0);
        drivemem_set_func(cpud, 0x5c, 0x60, via2d_read, via2d_store, via2d_peek, null, 0);
      }

      // $6000-$7FFF: RAM expansion at $6000 if ram6_enabled, otherwise
      // mirror of drive RAM ($6000-$67FF only) + VIA1/VIA2 mirrors.
      if (drv.drive_ram6_enabled) {
        drivemem_set_func(cpud, 0x60, 0x80, drive_read_ram, drive_store_ram, drive_peek_ram, drv.drive_ram.subarray(0x6000), 0);
      } else {
        drivemem_set_func(cpud, 0x60, 0x68, drive_read_1541ram, drive_store_1541ram, drive_peek_1541ram, drv.drive_ram, 0);
        drivemem_set_func(cpud, 0x78, 0x7c, via1d1541_read, via1d1541_store, via1d1541_peek, null, 0);
        drivemem_set_func(cpud, 0x7c, 0x80, via2d_read, via2d_store, via2d_peek, null, 0);
      }

      // $8000-$9FFF: RAM expansion at $8000 if ram8_enabled, otherwise
      // ROM image low half (trap_rom[$0000-$1FFF]). Read-only.
      if (drv.drive_ram8_enabled) {
        drivemem_set_func(cpud, 0x80, 0xa0, drive_read_ram, drive_store_ram, drive_peek_ram, drv.drive_ram.subarray(0x8000), 0);
      } else {
        drivemem_set_func(cpud, 0x80, 0xa0, drive_read_rom, null, drive_peek_rom, drv.trap_rom, 0);
      }

      // $A000-$BFFF: RAM expansion at $A000 if rama_enabled, otherwise
      // ROM image mid half (trap_rom[$2000-$3FFF]). Read-only.
      if (drv.drive_rama_enabled) {
        drivemem_set_func(cpud, 0xa0, 0xc0, drive_read_ram, drive_store_ram, drive_peek_ram, drv.drive_ram.subarray(0xa000), 0);
      } else {
        drivemem_set_func(cpud, 0xa0, 0xc0, drive_read_rom, null, drive_peek_rom, drv.trap_rom.subarray(0x2000), 0);
      }

      // $C000-$FFFF: ROM image canonical (trap_rom[$4000-$7FFF]). Read-only.
      drivemem_set_func(cpud, 0xc0, 0x100, drive_read_rom, null, drive_peek_rom, drv.trap_rom.subarray(0x4000), 0);
      break;

    case DRIVE_TYPE_1570:
    case DRIVE_TYPE_1571:
    case DRIVE_TYPE_1571CR:
    case DRIVE_TYPE_1581:
    case DRIVE_TYPE_2000:
    case DRIVE_TYPE_4000:
    case DRIVE_TYPE_CMDHD:
      // PORT-STUB: Spec 612 §10 — non-1541 memory maps require chip ports
      // (wd1770, cia1571, cia1581, mos5710, via4000, pc8477, cmdhd,
      // ds1216e) that are out of scope for Spec 612 layer 6. Per
      // `feedback_p64_stubs_ok.md` (2026-05-13): stubs MUST throw with a
      // spec marker, never silent no-op.
      throw new Error(
        `[Spec 612 T2.2 PORT-STUB] memiec_init: drive type ${type} not yet ported (1571/1581/CMD-series require additional chip ports — see vice/src/drive/iec/memiec.c:178-280)`,
      );

    default:
      // VICE: `default: return;` — unknown drive types silently no-op so
      // that the memory map is not touched. Match verbatim.
      return;
  }
}
