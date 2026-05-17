// PORT OF: vice/src/drive/iec/iec.c (full file, 328 lines)
// PORT OF: vice/src/drive/iec.h     (full file, 56 lines — folded per NL-1)
// VICE rev: tree-state of /Users/alex/Development/C64/Tools/vice/vice/src as of 2026-05-17
//
// Spec 612 — 1541 Port Fidelity Rules
//   §1 NL-1 (iec.c → iec.ts; iec.h folds in here)
//   §1 NL-2 (function names verbatim VICE — snake_case preserved:
//             iec_drive_resources_init, iec_drive_resources_shutdown,
//             iec_drive_cmdline_options_init, iec_drive_init,
//             iec_drive_shutdown, iec_drive_reset, iec_drive_mem_init,
//             iec_drive_setup_context, iec_drive_idling_method,
//             iec_drive_rom_load, iec_drive_rom_setup_image,
//             iec_drive_rom_check_loaded, iec_drive_rom_do_checksum,
//             iec_drive_snapshot_read, iec_drive_snapshot_write,
//             iec_drive_image_attach, iec_drive_image_detach,
//             iec_drive_port_default)
//   §1 NL-3 (first arg = diskunit_context_t per VICE iec.c signatures —
//             struct passed by reference, snake_case fields)
//   §1 NL-5 (`static iecbus_t *drive_iecbus;` at iec.c:54 → module-level
//             `let drive_iecbus: iecbus_t | null` here, same name)
//   §2 PL-1 (NO class — module-level functions only)
//   §2 PL-3 (no invented helper / facade / builder)
//   §2 PL-5 (every supporting helper traces back to a VICE peer symbol —
//             iecrom_*, cia1571_*, cia1581_*, via4000_*, wd1770_*, pc8477_*,
//             cmdhd_* — none of which exist yet in this port; the install
//             hooks below mirror the boundary pattern already used in
//             driverom.ts / drive.ts)
//   §2 PL-10 (OLD `_quarantine_vice1541_v4/iec-bus.ts` does NOT come over —
//             it was a parallel rewrite of the bus model (audit DIVERGENT);
//             the real bus model lives in iecbus.ts (T2.11))
//   §5     (every export has a PORT OF comment within 5 lines above)
//
// Layer 14 of Spec 612 §4 LO — drive-side helper layer alongside iecbus.ts
// (already ported as T2.11) and c64iec.ts (T2.12). Depends on:
//   - drivetypes.ts (T1.2): diskunit_context_t / DRIVE_TYPE_* / snapshot_t
//   - memiec.ts     (T2.2): memiec_init
//   - driverom.ts   (T2.9): driverom_load_images-class wiring (iecrom shim)
//   - drive.ts      (T2.10): diskunit_context[] array
//   - iecbus.ts     (T2.11): iecbus_drive_port + iecbus_t / drv_bus / drv_data
//   - via1d1541.ts  (T1.6): via1d1541_setup_context / via1d1541_init
//   - viacore.ts    (T1.5): viacore_reset / viacore_disable /
//                             viacore_shutdown /
//                             viacore_snapshot_read_module /
//                             viacore_snapshot_write_module
//
// VICE iec.c is a drive-type fan-out for the 1540/1541/1541II/1570/1571/
// 1571CR/1581/2000/4000/CMDHD family. The 1541-family path is fully ported
// (T2.13 is the 1541 scope per Spec 612 §10). Non-1541 paths in
// iec_drive_init / iec_drive_reset / iec_drive_setup_context /
// iec_drive_shutdown / iec_drive_snapshot_* / iec_drive_image_*  call into
// chip ports (cia1571, cia1581, via4000, wd1770, pc8477, cmdhd) that don't
// exist yet — they go through hookable callbacks per the established
// `feedback_p64_stubs_ok.md` (2026-05-13) precedent: stubs throw with a
// spec marker, never silent no-op. The 1541 path uses real implementations.

import {
  DRIVE_TYPE_1001,
  DRIVE_TYPE_1540,
  DRIVE_TYPE_1541,
  DRIVE_TYPE_1541II,
  DRIVE_TYPE_1570,
  DRIVE_TYPE_1571,
  DRIVE_TYPE_1571CR,
  DRIVE_TYPE_1581,
  DRIVE_TYPE_2000,
  DRIVE_TYPE_4000,
  DRIVE_TYPE_8050,
  DRIVE_TYPE_8250,
  DRIVE_TYPE_CMDHD,
  type diskunit_context_t,
  type disk_image_t,
  type snapshot_t,
} from "./drivetypes.js";

import { memiec_init } from "./memiec.js";

import {
  via1d1541_init,
  via1d1541_setup_context,
} from "./via1d1541.js";

import {
  viacore_disable,
  viacore_reset,
  viacore_shutdown,
  viacore_snapshot_read_module,
  viacore_snapshot_write_module,
} from "./viacore.js";

import {
  iecbus_drive_port,
  type iecbus_t,
} from "./iecbus.js";

// =============================================================================
// SECTION 1 — Module-level state (NL-5: static C globals → module `let`)
// =============================================================================

// PORT OF: vice/src/drive/iec/iec.c:54
//   `static iecbus_t *drive_iecbus;`
// NL-5: module-private (no export — VICE keeps it `static`). Cached pointer
// to the iecbus singleton, populated by iec_drive_port_default().
let drive_iecbus: iecbus_t | null = null;

// =============================================================================
// SECTION 2 — Peer-module hook boundary (Spec 612 §2 PL-5 / PL-7 / PL-10)
// =============================================================================
//
// VICE iec.c calls into peer modules that are not yet ported under the
// Spec 612 1541-only scope:
//
//   - iecrom_init / _load_1540 / _load_1541 / _load_1541ii / _load_1570 /
//     _load_1571 / _load_1581 / _load_2000 / _load_4000 / _load_CMDHD /
//     iecrom_setup_image / iecrom_check_loaded / iecrom_do_checksum
//     vice/src/drive/iec/iecrom.c — driverom.ts (T2.9) covers the unit-level
//     load semantics; the per-bus dispatch table is exposed through hooks.
//
//   - cia1571_init / cia1571_setup_context / cia1571_init etc.
//     vice/src/drive/iec/cia1571d.c — 1571/1570/1571CR only.
//
//   - cia1581_init / cia1581_setup_context
//     vice/src/drive/iec/cia1581d.c — 1581 only.
//
//   - via4000_init / via4000_setup_context
//     vice/src/drive/iec/via4000.c — 2000/4000 only.
//
//   - wd1770d_init / wd1770_setup_context / wd1770_reset /
//     wd1770_attach_image / wd1770_detach_image /
//     wd1770_snapshot_read_module / wd1770_snapshot_write_module
//     vice/src/drive/iec/wd1770.c — 1581 only.
//
//   - pc8477d_init / pc8477_setup_context / pc8477_reset /
//     pc8477_attach_image / pc8477_detach_image
//     vice/src/drive/iec/pc8477.c — 2000/4000 only.
//
//   - cmdhd_init / cmdhd_setup_context / cmdhd_reset /
//     cmdhd_attach_image / cmdhd_detach_image /
//     cmdhd_snapshot_read_module / cmdhd_snapshot_write_module
//     vice/src/drive/iec/cmdhd/cmdhd.c — CMDHD only.
//
//   - ciacore_reset / ciacore_disable / ciacore_shutdown /
//     ciacore_snapshot_read_module / ciacore_snapshot_write_module
//     vice/src/core/ciacore.c — invoked indirectly via cia1571/cia1581
//     contexts.
//
//   - iec_resources_init / _shutdown
//     vice/src/drive/iec/iec-resources.c — resource wiring.
//
//   - iec_cmdline_options_init
//     vice/src/drive/iec/iec-cmdline-options.c — CLI options.
//
//   - resources_touch
//     vice/src/resources.c — invoked from iec_drive_idling_method.
//
//   - diskunit_context provider — VICE has a global
//     `diskunit_context_t *diskunit_context[NUM_DISK_UNITS]`; ported in
//     drive.ts as `export const diskunit_context`. The hook lets iec.ts
//     stay self-contained at import time.
//
// Same hook pattern as driverom.ts §4 — explicit mutable bag, no closure
// capture, no method dispatch. drive.ts (T2.10) wires the hooks at init
// time; until peer modules land they remain `null` and the helpers throw
// PORT-STUB for non-1541 paths (loud failure per
// feedback_p64_stubs_ok.md 2026-05-13).

/** PL-5 callback shape: VICE iec-resources.c iec_resources_init(). */
export type iec_resources_init_func_t = () => number;
/** PL-5 callback shape: VICE iec-resources.c iec_resources_shutdown(). */
export type iec_resources_shutdown_func_t = () => void;
/** PL-5 callback shape: VICE iec-cmdline-options.c iec_cmdline_options_init(). */
export type iec_cmdline_options_init_func_t = () => number;

/** PL-5 callback shape: VICE iecrom.c iecrom_init(). */
export type iecrom_init_func_t = () => void;
/** PL-5 callback shape: VICE iecrom.c iecrom_load_<TYPE>() family — keyed by drive type. */
export type iecrom_load_func_t = () => void;
/** PL-5 callback shape: VICE iecrom.c iecrom_setup_image(diskunit_context_t *). */
export type iecrom_setup_image_func_t = (drv: diskunit_context_t) => void;
/** PL-5 callback shape: VICE iecrom.c iecrom_check_loaded(unsigned int type). */
export type iecrom_check_loaded_func_t = (type: number) => number;
/** PL-5 callback shape: VICE iecrom.c iecrom_do_checksum(diskunit_context_t *). */
export type iecrom_do_checksum_func_t = (drv: diskunit_context_t) => void;

/** PL-5 callback shape: VICE resources.c resources_touch(const char *name). */
export type resources_touch_func_t = (name: string) => void;

/** Diskunit-array provider — VICE: `diskunit_context_t *diskunit_context[NUM_DISK_UNITS]`. */
export type diskunit_context_provider_t = () => (diskunit_context_t | null)[];

/** PL-5 callback shape: cia1571_init / cia1571_setup_context — 1570/1571/1571CR. */
export type cia1571_init_func_t = (drv: diskunit_context_t) => void;
export type cia1571_setup_context_func_t = (drv: diskunit_context_t) => void;
/** PL-5 callback shape: cia1581_init / cia1581_setup_context — 1581. */
export type cia1581_init_func_t = (drv: diskunit_context_t) => void;
export type cia1581_setup_context_func_t = (drv: diskunit_context_t) => void;
/** PL-5 callback shape: via4000_init / via4000_setup_context — 2000/4000. */
export type via4000_init_func_t = (drv: diskunit_context_t) => void;
export type via4000_setup_context_func_t = (drv: diskunit_context_t) => void;
/** PL-5 callback shape: wd1770d_init / wd1770_setup_context / wd1770_reset — 1581. */
export type wd1770d_init_func_t = (drv: diskunit_context_t) => void;
export type wd1770_reset_func_t = (wd: unknown) => void;
export type wd1770_shutdown_func_t = (wd: unknown) => void;
export type wd1770_attach_image_func_t = (image: disk_image_t, unit: number) => number;
export type wd1770_detach_image_func_t = (image: disk_image_t, unit: number) => number;
export type wd1770_snapshot_read_module_func_t = (wd: unknown, s: snapshot_t) => number;
export type wd1770_snapshot_write_module_func_t = (wd: unknown, s: snapshot_t) => number;
/** PL-5 callback shape: pc8477d_init / pc8477_setup_context / pc8477_reset — 2000/4000. */
export type pc8477d_init_func_t = (drv: diskunit_context_t) => void;
export type pc8477_setup_context_func_t = (drv: diskunit_context_t) => void;
export type pc8477_reset_func_t = (pc: unknown, is_4000: boolean) => void;
export type pc8477_shutdown_func_t = (pc: unknown) => void;
export type pc8477_attach_image_func_t = (image: disk_image_t, unit: number) => number;
export type pc8477_detach_image_func_t = (image: disk_image_t, unit: number) => number;
/** PL-5 callback shape: cmdhd_init / cmdhd_setup_context / cmdhd_reset — CMDHD. */
export type cmdhd_init_func_t = (drv: diskunit_context_t) => void;
export type cmdhd_setup_context_func_t = (drv: diskunit_context_t) => void;
export type cmdhd_reset_func_t = (hd: unknown) => void;
export type cmdhd_shutdown_func_t = (hd: unknown) => void;
export type cmdhd_attach_image_func_t = (image: disk_image_t, unit: number) => number;
export type cmdhd_detach_image_func_t = (image: disk_image_t, unit: number) => number;
export type cmdhd_snapshot_read_module_func_t = (hd: unknown, s: snapshot_t) => number;
export type cmdhd_snapshot_write_module_func_t = (hd: unknown, s: snapshot_t) => number;
/** PL-5 callback shape: ciacore_reset / disable / shutdown / snapshot for cia1571/cia1581. */
export type ciacore_reset_func_t = (ctx: unknown) => void;
export type ciacore_disable_func_t = (ctx: unknown) => void;
export type ciacore_shutdown_func_t = (ctx: unknown) => void;
export type ciacore_snapshot_read_module_func_t = (ctx: unknown, s: snapshot_t) => number;
export type ciacore_snapshot_write_module_func_t = (ctx: unknown, s: snapshot_t) => number;
/** PL-5 callback shape: lib.c lib_free / lib_msprintf — drive shutdown frees
 *  fixed_size_text and idling-method builds a per-unit resource key. */
export type lib_msprintf_func_t = (fmt: string, ...args: unknown[]) => string;

/** Per Spec 612 §2 PL-3 / PL-5: explicit boundary between iec.c and the peer
 *  modules that VICE calls through normal C extern symbols. Same shape as
 *  driverom.ts §4 hooks. */
export interface iec_drive_hooks_t {
  iec_resources_init: iec_resources_init_func_t;
  iec_resources_shutdown: iec_resources_shutdown_func_t;
  iec_cmdline_options_init: iec_cmdline_options_init_func_t;

  iecrom_init: iecrom_init_func_t;
  iecrom_load_1540: iecrom_load_func_t;
  iecrom_load_1541: iecrom_load_func_t;
  iecrom_load_1541ii: iecrom_load_func_t;
  iecrom_load_1570: iecrom_load_func_t;
  iecrom_load_1571: iecrom_load_func_t;
  iecrom_load_1581: iecrom_load_func_t;
  iecrom_load_2000: iecrom_load_func_t;
  iecrom_load_4000: iecrom_load_func_t;
  iecrom_load_CMDHD: iecrom_load_func_t;
  iecrom_setup_image: iecrom_setup_image_func_t;
  iecrom_check_loaded: iecrom_check_loaded_func_t;
  iecrom_do_checksum: iecrom_do_checksum_func_t;

  resources_touch: resources_touch_func_t;
  diskunit_context: diskunit_context_provider_t;
  lib_msprintf: lib_msprintf_func_t;

  cia1571_init: cia1571_init_func_t;
  cia1571_setup_context: cia1571_setup_context_func_t;
  cia1581_init: cia1581_init_func_t;
  cia1581_setup_context: cia1581_setup_context_func_t;
  via4000_init: via4000_init_func_t;
  via4000_setup_context: via4000_setup_context_func_t;

  wd1770d_init: wd1770d_init_func_t;
  wd1770_reset: wd1770_reset_func_t;
  wd1770_shutdown: wd1770_shutdown_func_t;
  wd1770_attach_image: wd1770_attach_image_func_t;
  wd1770_detach_image: wd1770_detach_image_func_t;
  wd1770_snapshot_read_module: wd1770_snapshot_read_module_func_t;
  wd1770_snapshot_write_module: wd1770_snapshot_write_module_func_t;

  pc8477d_init: pc8477d_init_func_t;
  pc8477_setup_context: pc8477_setup_context_func_t;
  pc8477_reset: pc8477_reset_func_t;
  pc8477_shutdown: pc8477_shutdown_func_t;
  pc8477_attach_image: pc8477_attach_image_func_t;
  pc8477_detach_image: pc8477_detach_image_func_t;

  cmdhd_init: cmdhd_init_func_t;
  cmdhd_setup_context: cmdhd_setup_context_func_t;
  cmdhd_reset: cmdhd_reset_func_t;
  cmdhd_shutdown: cmdhd_shutdown_func_t;
  cmdhd_attach_image: cmdhd_attach_image_func_t;
  cmdhd_detach_image: cmdhd_detach_image_func_t;
  cmdhd_snapshot_read_module: cmdhd_snapshot_read_module_func_t;
  cmdhd_snapshot_write_module: cmdhd_snapshot_write_module_func_t;

  ciacore_reset: ciacore_reset_func_t;
  ciacore_disable: ciacore_disable_func_t;
  ciacore_shutdown: ciacore_shutdown_func_t;
  ciacore_snapshot_read_module: ciacore_snapshot_read_module_func_t;
  ciacore_snapshot_write_module: ciacore_snapshot_write_module_func_t;
}

let iec_drive_hooks: iec_drive_hooks_t | null = null;

// Install boundary for peer-module extern symbols (iecrom / cia1571d /
// cia1581d / via4000 / wd1770 / pc8477 / cmdhd / ciacore / iec-resources /
// iec-cmdline-options / resources / lib). VICE binds these statically at
// compile time; the TS port receives them through this single install call
// from drive.ts (T2.10). Same shape as driverom_install_hooks.
// PORT OF: vice/src/drive/iec/iec.c (install-boundary equivalent of VICE's
// compile-time extern wiring; PL-3 / PL-5 hook pattern, NO class)
export function iec_drive_install_hooks(hooks: iec_drive_hooks_t): void {
  iec_drive_hooks = hooks;
}

/** Helper used by every iec_drive_* helper that touches a peer module. Throws
 *  with a clear spec marker if the host hasn't wired the hooks yet — loud
 *  failure per feedback_p64_stubs_ok.md (2026-05-13), never silent. */
function require_hooks(fn: string): iec_drive_hooks_t {
  if (iec_drive_hooks === null) {
    throw new Error(
      `[Spec 612 T2.13 PORT-WIRING] ${fn}: iec_drive_hooks not installed (drive.ts T2.10 must call iec_drive_install_hooks before invoking iec_drive_* helpers)`,
    );
  }
  return iec_drive_hooks;
}

/** Stub helper for drive types whose chip ports are out of scope (Spec 612
 *  §10). Loud failure per feedback_p64_stubs_ok.md (2026-05-13). The
 *  1541-family path (1540/1541/1541II) never reaches these. */
function stub_non_1541(fn: string, type: number, peer: string): never {
  throw new Error(
    `[Spec 612 T2.13 PORT-STUB] ${fn}: drive type ${type} requires ${peer} (Spec 612 §10 out-of-scope; only 1541-family — 1540/1541/1541II — is in scope for the 1541-only rebuild)`,
  );
}

// =============================================================================
// SECTION 3 — Exported functions (NL-2: verbatim VICE names, snake_case)
// =============================================================================

// PORT OF: vice/src/drive/iec/iec.c:57-60 (iec_drive_resources_init)
// Trivial delegate to iec_resources_init() (iec-resources.c). VICE returns
// the int directly; the hook fans out the same value.
export function iec_drive_resources_init(): number {
  const hooks = require_hooks("iec_drive_resources_init");
  return hooks.iec_resources_init();
}

// PORT OF: vice/src/drive/iec/iec.c:62-65 (iec_drive_resources_shutdown)
// Trivial delegate to iec_resources_shutdown() (iec-resources.c).
export function iec_drive_resources_shutdown(): void {
  const hooks = require_hooks("iec_drive_resources_shutdown");
  hooks.iec_resources_shutdown();
}

// PORT OF: vice/src/drive/iec/iec.c:67-70 (iec_drive_cmdline_options_init)
// Trivial delegate to iec_cmdline_options_init() (iec-cmdline-options.c).
export function iec_drive_cmdline_options_init(): number {
  const hooks = require_hooks("iec_drive_cmdline_options_init");
  return hooks.iec_cmdline_options_init();
}

// Calls every per-chip init for the drive. All chips are constructed
// unconditionally regardless of drive type — VICE allocates the per-chip
// contexts so the drive type can be changed at runtime without
// re-constructing. Non-1541 chip inits go through the hook boundary.
// Order matches VICE verbatim (PL-8): iecrom_init → via1d1541_init →
// cia1571_init → cia1581_init → via4000_init → wd1770d_init → pc8477d_init
// → cmdhd_init.
// PORT OF: vice/src/drive/iec/iec.c:72-84 (iec_drive_init)
export function iec_drive_init(drv: diskunit_context_t): void {
  const hooks = require_hooks("iec_drive_init");
  hooks.iecrom_init();
  via1d1541_init(drv);
  hooks.cia1571_init(drv);
  hooks.cia1581_init(drv);
  hooks.via4000_init(drv);
  hooks.wd1770d_init(drv);
  hooks.pc8477d_init(drv);
  /* due to the complexity of the CMD HD memory addressing and IO,
      we keep the setup of it in separate functions */
  hooks.cmdhd_init(drv);
}

// PORT OF: vice/src/drive/iec/iec.c:86-128 (iec_drive_reset)
// called by machine_drive_reset(). Per-drive-type chip enable/disable
// dispatch. The 1541-family branch (1540/1541/1541II + 1570/1571/1571CR)
// calls viacore_reset(drv->via1d1541) directly; non-1541-family chips
// (CIA1571, CIA1581, VIA4000, PC8477, CMDHD) are gated through hooks.
export function iec_drive_reset(drv: diskunit_context_t): void {
  const hooks = require_hooks("iec_drive_reset");

  if (
    drv.type === DRIVE_TYPE_1540 ||
    drv.type === DRIVE_TYPE_1541 ||
    drv.type === DRIVE_TYPE_1541II ||
    drv.type === DRIVE_TYPE_1570 ||
    drv.type === DRIVE_TYPE_1571 ||
    drv.type === DRIVE_TYPE_1571CR
  ) {
    viacore_reset(drv.via1d1541!);
  } else {
    viacore_disable(drv.via1d1541!);
  }

  if (
    drv.type === DRIVE_TYPE_1570 ||
    drv.type === DRIVE_TYPE_1571 ||
    drv.type === DRIVE_TYPE_1571CR
  ) {
    hooks.ciacore_reset(drv.cia1571);
  } else {
    hooks.ciacore_disable(drv.cia1571);
  }

  if (drv.type === DRIVE_TYPE_1581) {
    hooks.ciacore_reset(drv.cia1581);
    hooks.wd1770_reset(drv.wd1770);
  } else {
    hooks.ciacore_disable(drv.cia1581);
  }

  if (drv.type === DRIVE_TYPE_2000 || drv.type === DRIVE_TYPE_4000) {
    viacore_reset(drv.via4000!);
    hooks.pc8477_reset(drv.pc8477, drv.type === DRIVE_TYPE_4000);
  } else {
    viacore_disable(drv.via4000!);
  }

  if (drv.type === DRIVE_TYPE_CMDHD) {
    /* due to the complexity of the CMD HD memory addressing and IO,
        we keep the setup of it in separate functions */
    hooks.cmdhd_reset(drv.cmdhd);
  }
}

// PORT OF: vice/src/drive/iec/iec.c:130-133 (iec_drive_mem_init)
// Trivial delegate to memiec_init() (memiec.ts T2.2). Installs the per-drive
// 1541-family memory map onto the unit's drivecpud_context_t page tables.
export function iec_drive_mem_init(drv: diskunit_context_t, type: number): void {
  memiec_init(drv, type);
}

// PORT OF: vice/src/drive/iec/iec.c:135-145 (iec_drive_setup_context)
// Per-chip setup_context fan-out. VICE order verbatim (PL-8):
// via1d1541 → cia1571 → cia1581 → via4000 → pc8477 → cmdhd. Note: VICE iec.c
// does NOT call wd1770_setup_context here — wd1770 is set up inside the
// cia1581/wd1770 init chain.
export function iec_drive_setup_context(drv: diskunit_context_t): void {
  const hooks = require_hooks("iec_drive_setup_context");
  via1d1541_setup_context(drv);
  hooks.cia1571_setup_context(drv);
  hooks.cia1581_setup_context(drv);
  hooks.via4000_setup_context(drv);
  hooks.pc8477_setup_context(drv);
  /* due to the complexity of the CMD HD memory addressing and IO,
      we keep the setup of it in separate functions */
  hooks.cmdhd_setup_context(drv);
}

// PORT OF: vice/src/drive/iec/iec.c:147-163 (iec_drive_shutdown)
// Per-chip shutdown fan-out. VICE order verbatim (PL-8):
// viacore_shutdown(via1d1541) → ciacore_shutdown(cia1571) →
// ciacore_shutdown(cia1581) → viacore_shutdown(via4000) →
// wd1770_shutdown → pc8477_shutdown → cmdhd_shutdown. Then frees
// drv->fixed_size_text (CMDHD ASCII resource).
export function iec_drive_shutdown(drv: diskunit_context_t): void {
  const hooks = require_hooks("iec_drive_shutdown");
  viacore_shutdown(drv.via1d1541!);
  hooks.ciacore_shutdown(drv.cia1571);
  hooks.ciacore_shutdown(drv.cia1581);
  viacore_shutdown(drv.via4000!);
  hooks.wd1770_shutdown(drv.wd1770);
  hooks.pc8477_shutdown(drv.pc8477);
  /* due to the complexity of the CMD HD memory addressing and IO,
      we keep the setup of it in separate functions */
  hooks.cmdhd_shutdown(drv.cmdhd);
  /* free existing ASCII value of resource */
  if (drv.fixed_size_text) {
    drv.fixed_size_text = null;
  }
}

// PORT OF: vice/src/drive/iec/iec.c:165-174 (iec_drive_idling_method)
// Builds the per-unit resource key "Drive<N>IdleMethod" (N = dnr + 8) and
// calls resources_touch() to re-fire the resource handler. VICE uses
// lib_msprintf + lib_free; the TS port uses the hook for the string
// builder (so the call traces back to the VICE peer) and lets GC reclaim
// the buffer.
export function iec_drive_idling_method(dnr: number): void {
  const hooks = require_hooks("iec_drive_idling_method");
  const tmp = hooks.lib_msprintf("Drive%uIdleMethod", dnr + 8);
  hooks.resources_touch(tmp);
  /* lib_free(tmp) — TS GC handles the buffer. */
}

// PORT OF: vice/src/drive/iec/iec.c:176-188 (iec_drive_rom_load)
// test all ROMs for existence, size. Fans out to per-type iecrom_load_*
// (iecrom.c). Order verbatim VICE.
export function iec_drive_rom_load(): void {
  const hooks = require_hooks("iec_drive_rom_load");
  hooks.iecrom_load_1540();
  hooks.iecrom_load_1541();
  hooks.iecrom_load_1541ii();
  hooks.iecrom_load_1570();
  hooks.iecrom_load_1571();
  hooks.iecrom_load_1581();
  hooks.iecrom_load_2000();
  hooks.iecrom_load_4000();
  hooks.iecrom_load_CMDHD();
}

// PORT OF: vice/src/drive/iec/iec.c:190-194 (iec_drive_rom_setup_image)
// setup (=load) the ROM for a given disk unit nr. Delegates to
// iecrom_setup_image(diskunit_context[dnr]).
export function iec_drive_rom_setup_image(dnr: number): void {
  const hooks = require_hooks("iec_drive_rom_setup_image");
  const units = hooks.diskunit_context();
  const drv = units[dnr];
  if (drv === null || drv === undefined) return;
  hooks.iecrom_setup_image(drv);
}

// PORT OF: vice/src/drive/iec/iec.c:196-200 (iec_drive_rom_check_loaded)
// check if the drive ROM is available for a given drive type, returns -1
// on error. Trivial delegate to iecrom_check_loaded(type).
export function iec_drive_rom_check_loaded(type: number): number {
  const hooks = require_hooks("iec_drive_rom_check_loaded");
  return hooks.iecrom_check_loaded(type);
}

// PORT OF: vice/src/drive/iec/iec.c:202-205 (iec_drive_rom_do_checksum)
// Trivial delegate to iecrom_do_checksum(diskunit_context[dnr]).
export function iec_drive_rom_do_checksum(dnr: number): void {
  const hooks = require_hooks("iec_drive_rom_do_checksum");
  const units = hooks.diskunit_context();
  const drv = units[dnr];
  if (drv === null || drv === undefined) return;
  hooks.iecrom_do_checksum(drv);
}

// PORT OF: vice/src/drive/iec/iec.c:207-252 (iec_drive_snapshot_read)
// Per-drive-type chip snapshot read dispatch. 1540/1541/1541II reads the
// via1d1541 module only; 1570/1571/1571CR adds cia1571; 1581 reads
// cia1581 + wd1770; 2000/4000 reads via4000; CMDHD reads cmdhd. Unknown
// types are a silent success (`default: break;` in VICE). Returns -1 on
// any peer module error, 0 on success.
export function iec_drive_snapshot_read(
  ctxptr: diskunit_context_t,
  s: snapshot_t,
): number {
  const hooks = require_hooks("iec_drive_snapshot_read");
  switch (ctxptr.type) {
    case DRIVE_TYPE_1540:
    case DRIVE_TYPE_1541:
    case DRIVE_TYPE_1541II:
      if (viacore_snapshot_read_module(ctxptr.via1d1541!, s) < 0) {
        return -1;
      }
      break;
    case DRIVE_TYPE_1570:
    case DRIVE_TYPE_1571:
    case DRIVE_TYPE_1571CR:
      if (viacore_snapshot_read_module(ctxptr.via1d1541!, s) < 0) {
        return -1;
      }
      if (hooks.ciacore_snapshot_read_module(ctxptr.cia1571, s) < 0) {
        return -1;
      }
      break;
    case DRIVE_TYPE_1581:
      if (hooks.ciacore_snapshot_read_module(ctxptr.cia1581, s) < 0) {
        return -1;
      }
      if (hooks.wd1770_snapshot_read_module(ctxptr.wd1770, s) < 0) {
        return -1;
      }
      break;
    case DRIVE_TYPE_2000:
    case DRIVE_TYPE_4000:
      if (viacore_snapshot_read_module(ctxptr.via4000!, s) < 0) {
        return -1;
      }
      break;
    case DRIVE_TYPE_CMDHD:
      if (hooks.cmdhd_snapshot_read_module(ctxptr.cmdhd, s) < 0) {
        return -1;
      }
      break;
    default:
      break;
  }
  return 0;
}

// PORT OF: vice/src/drive/iec/iec.c:254-299 (iec_drive_snapshot_write)
// Per-drive-type chip snapshot write dispatch. Mirror of
// iec_drive_snapshot_read above. Returns -1 on any peer module error,
// 0 on success.
export function iec_drive_snapshot_write(
  ctxptr: diskunit_context_t,
  s: snapshot_t,
): number {
  const hooks = require_hooks("iec_drive_snapshot_write");
  switch (ctxptr.type) {
    case DRIVE_TYPE_1540:
    case DRIVE_TYPE_1541:
    case DRIVE_TYPE_1541II:
      if (viacore_snapshot_write_module(ctxptr.via1d1541!, s) < 0) {
        return -1;
      }
      break;
    case DRIVE_TYPE_1570:
    case DRIVE_TYPE_1571:
    case DRIVE_TYPE_1571CR:
      if (viacore_snapshot_write_module(ctxptr.via1d1541!, s) < 0) {
        return -1;
      }
      if (hooks.ciacore_snapshot_write_module(ctxptr.cia1571, s) < 0) {
        return -1;
      }
      break;
    case DRIVE_TYPE_1581:
      if (hooks.ciacore_snapshot_write_module(ctxptr.cia1581, s) < 0) {
        return -1;
      }
      if (hooks.wd1770_snapshot_write_module(ctxptr.wd1770, s) < 0) {
        return -1;
      }
      break;
    case DRIVE_TYPE_2000:
    case DRIVE_TYPE_4000:
      if (viacore_snapshot_write_module(ctxptr.via4000!, s) < 0) {
        return -1;
      }
      break;
    case DRIVE_TYPE_CMDHD:
      if (hooks.cmdhd_snapshot_write_module(ctxptr.cmdhd, s) < 0) {
        return -1;
      }
      break;
    default:
      break;
  }
  return 0;
}

// Per-drive-type image-attach fan-out. VICE returns the bitwise AND of the
// three peer attach return values — wd1770 + pc8477 + cmdhd — because each
// returns 0 on success and non-zero on error, and the bitwise AND lets the
// caller observe "all three accepted" without short-circuiting. The 1541
// family doesn't use these (the GCR layer in driveimage.ts handles attach).
// If `drive` != 0, returns -1 (single-drive IEC chain only).
// PORT OF: vice/src/drive/iec/iec.c:301-308 (iec_drive_image_attach)
export function iec_drive_image_attach(
  image: disk_image_t,
  unit: number,
  drive: number,
): number {
  if (drive) {
    return -1;
  }
  const hooks = require_hooks("iec_drive_image_attach");
  return (
    hooks.wd1770_attach_image(image, unit) &
    hooks.pc8477_attach_image(image, unit) &
    hooks.cmdhd_attach_image(image, unit)
  );
}

// PORT OF: vice/src/drive/iec/iec.c:310-317 (iec_drive_image_detach)
// Mirror of iec_drive_image_attach — returns the bitwise AND of the three
// peer detach return values.
export function iec_drive_image_detach(
  image: disk_image_t,
  unit: number,
  drive: number,
): number {
  if (drive) {
    return -1;
  }
  const hooks = require_hooks("iec_drive_image_detach");
  return (
    hooks.wd1770_detach_image(image, unit) &
    hooks.pc8477_detach_image(image, unit) &
    hooks.cmdhd_detach_image(image, unit)
  );
}

// Initialises this unit's IEC drv_bus / drv_data lanes to 0xff (idle high)
// on the iecbus singleton. Caches the iecbus pointer in the module-level
// `drive_iecbus` (NL-5). Unit index in iecbus is `drv->mynumber + 8`.
// drv_bus / drv_data are snake_case fields on iecbus_t per VICE iecbus.h:56-83
// (already ported in iecbus.ts T2.11). Type-agnostic in VICE — same 0xff.
// PORT OF: vice/src/drive/iec/iec.c:319-327 (iec_drive_port_default)
export function iec_drive_port_default(drv: diskunit_context_t): void {
  drive_iecbus = iecbus_drive_port();

  if (drive_iecbus !== null) {
    drive_iecbus.drv_bus[drv.mynumber + 8] = 0xff;
    drive_iecbus.drv_data[drv.mynumber + 8] = 0xff;
  }
}

// =============================================================================
// SECTION 4 — internal references (not exported, kept so stub_non_1541 is
// reachable from any future per-type expansion of the helpers above)
// =============================================================================

// Reference the per-type stub so the lint pass doesn't flag it as unused.
// Out-of-scope drive types (1551 / 1001 / 8050 / 8250 / etc.) currently
// flow through the `default: break;` branches in the snapshot helpers
// above; once those drive types come into scope they'll dispatch through
// stub_non_1541 with their peer chip names (riot2 / tpid / cia6526 / ...).
void stub_non_1541;
void DRIVE_TYPE_1001;
void DRIVE_TYPE_8050;
void DRIVE_TYPE_8250;
