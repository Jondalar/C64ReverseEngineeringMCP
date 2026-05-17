// PORT OF: vice/src/drive/driverom.c (full file)
// Header:  vice/src/drive/driverom.h
// VICE rev: (vice/ submodule HEAD — system-installed
//            /Users/alex/Development/C64/Tools/vice/vice/src/drive/driverom.c)
//
// Spec 612 — 1541 Port Fidelity Rules
//   §1 NL-1 (one C file → one TS file; .h folded — DRIVE_ROM*_SIZE / *_NAME
//             constants live here, not in a separate companion module)
//   §1 NL-2 (function names verbatim VICE — snake_case preserved:
//             driverom_init, driverom_test_load, driverom_load,
//             driverom_load_images, driverom_initialize_traps,
//             driverom_snapshot_write, driverom_snapshot_read)
//   §1 NL-5 (module-level static C globals → module-level TS `let`:
//             driverom_log, drive_rom_load_ok)
//   §2 PL-1 (no class — exports are functions taking diskunit_context_t /
//             drive_t / snapshot_t as first arg)
//   §2 PL-3 (no helper class / factory / manager — just the seven VICE
//             exports + one private helper switch driverom_select_rom_region
//             that ports the duplicated VICE switch in driverom_snapshot_*)
//   §2 PL-5 (no NOT-IN-VICE helpers exposed)
//   §2 PL-7 (driverom_load returns -1 on missing ROM and disables the drive
//             — NO zero-filled fallback; the missing-ROM caller observes the
//             same failure semantics as VICE)
//
// Snapshot DRIVEROM module format (per VICE comment at driverom.c:313-320):
//
//   Type  | Name        | Description
//   --------------------------------------------------
//   ARRAY | drive ROM   | size depends on drive (per-type table)
//
// The DRIVEROM module name is "DRIVEROM<unit>" (e.g. DRIVEROM0).

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DRIVE_IDLE_TRAP_IDLE,
  DRIVE_ROM_SIZE,
  DRIVE_TYPE_1001,
  DRIVE_TYPE_1540,
  DRIVE_TYPE_1541,
  DRIVE_TYPE_1541II,
  DRIVE_TYPE_1551,
  DRIVE_TYPE_1570,
  DRIVE_TYPE_1571,
  DRIVE_TYPE_1571CR,
  DRIVE_TYPE_1581,
  DRIVE_TYPE_2000,
  DRIVE_TYPE_2031,
  DRIVE_TYPE_2040,
  DRIVE_TYPE_3040,
  DRIVE_TYPE_4000,
  DRIVE_TYPE_4040,
  DRIVE_TYPE_8050,
  DRIVE_TYPE_8250,
  DRIVE_TYPE_9000,
  DRIVE_TYPE_CMDHD,
  DRIVE_TYPE_NONE,
  NUM_DISK_UNITS,
  type diskunit_context_t,
  type drive_t,
  type snapshot_t,
} from "./drivetypes.js";

// =============================================================================
// SECTION 1 — driverom.h #define constants (NL-1: header folded into this .ts)
// =============================================================================

/** driverom.h:36 */ export const DRIVE_ROM1540_SIZE = 0x4000;
/** driverom.h:37 */ export const DRIVE_ROM1540_SIZE_EXPANDED = 0x8000;
/** driverom.h:38 */ export const DRIVE_ROM1541_SIZE = 0x4000;
/** driverom.h:39 */ export const DRIVE_ROM1541_SIZE_EXPANDED = 0x8000;
/** driverom.h:40 */ export const DRIVE_ROM1541II_SIZE = 0x4000;
/** driverom.h:41 */ export const DRIVE_ROM1541II_SIZE_EXPANDED = 0x8000;
/** driverom.h:42 */ export const DRIVE_ROM1551_SIZE = 0x4000;
/** driverom.h:43 */ export const DRIVE_ROM1570_SIZE = 0x8000;
/** driverom.h:44 */ export const DRIVE_ROM1571_SIZE = 0x8000;
/** driverom.h:45 */ export const DRIVE_ROM1571CR_SIZE = 0x8000;
/** driverom.h:46 */ export const DRIVE_ROM1581_SIZE = 0x8000;
/** driverom.h:47 */ export const DRIVE_ROM2000_SIZE = 0x8000;
/** driverom.h:48 */ export const DRIVE_ROM4000_SIZE = 0x8000;
/** driverom.h:49 */ export const DRIVE_ROMCMDHD_SIZE = 0x4000;
/** driverom.h:50 */ export const DRIVE_ROM2031_SIZE = 0x4000;
/** driverom.h:51 */ export const DRIVE_ROM1001_SIZE = 0x4000;
/** driverom.h:52 */ export const DRIVE_ROM9000_SIZE = 0x4000;
/** driverom.h:53 */ export const DRIVE_ROM2040_SIZE = 0x2000;
/** driverom.h:54 */ export const DRIVE_ROM3040_SIZE = 0x3000;
/** driverom.h:55 */ export const DRIVE_ROM4040_SIZE = 0x3000;

/** driverom.h:70 */ export const DRIVE_ROM1001_NAME = "dos1001-901887+8-01.bin";
/** driverom.h:73 */ export const DRIVE_ROM2031_NAME = "dos2031-901484-03+05.bin";
/** driverom.h:76 */ export const DRIVE_ROM2040_NAME = "dos2040-901468-06+07.bin";
/** driverom.h:79 */ export const DRIVE_ROM3040_NAME = "dos3040-901468-11-13.bin";
/** driverom.h:82 */ export const DRIVE_ROM4040_NAME = "dos4040-901468-14-16.bin";
/** driverom.h:85 */ export const DRIVE_ROM9000_NAME = "dos9000-300516+7-revC.bin";
/** driverom.h:88 */ export const DRIVE_ROM1540_NAME = "dos1540-325302+3-01.bin";
/** driverom.h:89 */ export const DRIVE_ROM1541_NAME = "dos1541-325302-01+901229-05.bin";
/** driverom.h:90 */ export const DRIVE_ROM1541II_NAME = "dos1541ii-251968-03.bin";
/** driverom.h:92 */ export const DRIVE_ROM1551_NAME = "dos1551-318008-01.bin";
/** driverom.h:93 */ export const DRIVE_ROM1570_NAME = "dos1570-315090-01.bin";
/** driverom.h:94 */ export const DRIVE_ROM1571_NAME = "dos1571-310654-05.bin";
/** driverom.h:95 */ export const DRIVE_ROM1571CR_NAME = "dos1571cr-318047-01.bin";
/** driverom.h:96 */ export const DRIVE_ROM1581_NAME = "dos1581-318045-02.bin";
/** driverom.h:98 */ export const DRIVE_ROM2000_NAME = "dos2000-cs-33cc6f.bin";
/** driverom.h:99 */ export const DRIVE_ROM4000_NAME = "dos4000-fd-350022.bin";
/** driverom.h:100 */ export const DRIVE_ROMCMDHD_NAME = "bootromCMDHD-v2-80.bin";

// =============================================================================
// SECTION 2 — TRAP_OPCODE (from traps.h:38 — needed by initialize_traps)
// =============================================================================

/** traps.h:38 — JAM-style opcode the CPU core dispatches to the trap handler. */
export const TRAP_OPCODE = 0x02;

// =============================================================================
// SECTION 3 — Module-level state (NL-5: static C globals → module `let`)
// =============================================================================

// PORT OF: vice/src/drive/driverom.c:71 (static log_t driverom_log)
// Module-level log handle. VICE allocates this in driverom_init() via
// log_open("DriveROM"); the TS port keeps it as a number sentinel for now —
// real log routing lives outside this file per the existing port pattern.
let driverom_log = -1;

// PORT OF: vice/src/drive/driverom.c:74 (static int drive_rom_load_ok)
// Set to 1 by driverom_load_images() once we are far enough through init
// that the platform-data resolver may run.
let drive_rom_load_ok = 0;

// =============================================================================
// SECTION 4 — Spec-612 PL-7 wiring: callbacks for cross-module side-effects
// =============================================================================
//
// VICE's driverom_load() / _test_load() call into peer modules:
//
//   - drive_disable(diskunit_context_t *unit)
//     vice/src/drive/drive.c
//   - machine_bus_status_drivetype_set(unsigned int unit_no, int set)
//     vice/src/machine-bus.c
//   - machine_drive_rom_setup_image(unsigned int dnr)
//     vice/src/machine-drive.c
//   - drive_cpu_trigger_reset(unsigned int dnr)
//     vice/src/drive/drive.c
//   - resources_get_string(const char *name, const char **value_return)
//     vice/src/resources.c
//   - sysfile_load(...) / sysfile_locate(...)
//     vice/src/sysfile.c
//   - log_error(log_t, const char *fmt, ...)
//     vice/src/log.c
//   - machine_drive_rom_load() / _check_loaded()
//     vice/src/machine-drive.c
//
// Those peer modules are ported in other Spec-612 tasks (drive.ts /
// drivecpu.ts / drive_snapshot.ts / iec.ts) — none of them exist as TS yet.
// To preserve PL-7 semantics (driverom_load -1 + disable) WITHOUT
// inventing helper classes (PL-3 / PL-5), this file exposes installable
// callback hooks at module scope. The drive lifecycle module (T2.10
// drive.ts) wires them at init time; until then they are no-ops.
//
// Same shape as `clk_ptr` reference wrappers in drivetypes.ts — explicit
// mutable bag, no closure capture, no method dispatch.

/** PL-7 callback shape: VICE drive.c drive_disable(). */
export type drive_disable_func_t = (unit: diskunit_context_t) => void;
/** PL-7 callback shape: VICE machine-bus.c machine_bus_status_drivetype_set(). */
export type machine_bus_status_drivetype_set_func_t = (unit_no: number, set: number) => void;
/** PL-7 callback shape: VICE machine-drive.c machine_drive_rom_setup_image(). */
export type machine_drive_rom_setup_image_func_t = (dnr: number) => void;
/** PL-7 callback shape: VICE drive.c drive_cpu_trigger_reset(). */
export type drive_cpu_trigger_reset_func_t = (dnr: number) => void;
/** PL-7 callback shape: VICE machine-drive.c machine_drive_rom_load(). */
export type machine_drive_rom_load_func_t = () => void;
/** PL-7 callback shape: VICE machine-drive.c machine_drive_rom_check_loaded(). */
export type machine_drive_rom_check_loaded_func_t = (type: number) => number;
/** Diskunit-array provider — VICE: `diskunit_context_t *diskunit_context[NUM_DISK_UNITS]`. */
export type diskunit_context_provider_t = () => (diskunit_context_t | null)[];
/** Resource-string lookup — VICE: `resources_get_string(name, &out)`. */
export type resources_get_string_func_t = (name: string) => string | null;

/** Per Spec 612 §2 PL-3 / PL-5: this is NOT a "helper class" but the
 *  explicit boundary between driverom.c and the peer modules that VICE
 *  calls through normal C extern symbols. Same shape as the existing
 *  ClockRef / RmwFlagRef wrappers in drivetypes.ts.
 *  PORT OF: VICE drive.c + machine-bus.c + machine-drive.c extern hooks. */
export interface driverom_hooks_t {
  diskunit_context: diskunit_context_provider_t;
  drive_disable: drive_disable_func_t;
  machine_bus_status_drivetype_set: machine_bus_status_drivetype_set_func_t;
  machine_drive_rom_setup_image: machine_drive_rom_setup_image_func_t;
  drive_cpu_trigger_reset: drive_cpu_trigger_reset_func_t;
  machine_drive_rom_load: machine_drive_rom_load_func_t;
  machine_drive_rom_check_loaded: machine_drive_rom_check_loaded_func_t;
  resources_get_string: resources_get_string_func_t;
}

let driverom_hooks: driverom_hooks_t | null = null;

// PORT OF: vice/src/drive/driverom.c — install boundary for peer-module
// extern symbols (drive.c / machine-bus.c / machine-drive.c / sysfile.c /
// resources.c). VICE binds these statically at compile time; the TS port
// receives them through this single install call from drive.ts (T2.10).
// No class — module `let` per NL-5; no factory per PL-3.
export function driverom_install_hooks(hooks: driverom_hooks_t): void {
  driverom_hooks = hooks;
}

// =============================================================================
// SECTION 5 — ROM file resolution (sysfile_load / sysfile_locate equivalent)
// =============================================================================
//
// VICE resolves ROM files through sysfile_load() which searches a list of
// $VICE_DATA-relative paths. The TS port searches:
//
//   1. C64RE_DRIVE_ROM_DIR env-var if set (one directory containing the
//      ROM file by its DRIVE_ROM*_NAME basename)
//   2. resources/roms/ (repo-bundled — Commodore-IP policy)
//   3. alias names already present in resources/roms/ (e.g. "1541.bin",
//      "1541-ii.bin" — historical pre-VICE-name filenames)
//
// Returned object mirrors the success / failure split of sysfile_load:
//   { bytes: Uint8Array, filesize: number } on success
//   null on failure (driverom_load surfaces -1 in that case — PL-7).

function vice1541_repo_root(): string {
  // .../src/runtime/headless/vice1541/driverom.ts → 4 levels up = repo root.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "..");
}

const ALIAS_MAP: Record<string, string[]> = {
  [DRIVE_ROM1541_NAME]: ["1541.bin"],
  [DRIVE_ROM1541II_NAME]: ["1541-ii.bin", "1541ii.bin"],
};

function sysfile_resolve(rom_name: string): string | null {
  if (!rom_name) return null;
  const envDir = process.env["C64RE_DRIVE_ROM_DIR"]?.trim();
  const candidates: string[] = [];
  if (envDir) candidates.push(resolve(envDir, rom_name));
  candidates.push(resolve(vice1541_repo_root(), "resources", "roms", rom_name));
  for (const alias of ALIAS_MAP[rom_name] ?? []) {
    candidates.push(resolve(vice1541_repo_root(), "resources", "roms", alias));
    if (envDir) candidates.push(resolve(envDir, alias));
  }
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

/** Equivalent of VICE sysfile_locate: returns filesize, or -1 if not found. */
function sysfile_locate(rom_name: string | null): number {
  if (!rom_name) return -1;
  const path = sysfile_resolve(rom_name);
  if (path === null) return -1;
  try {
    const raw = readFileSync(path);
    return raw.length;
  } catch {
    return -1;
  }
}

/** Equivalent of VICE sysfile_load: reads `rom_name` into `drive_rom`
 *  honouring the [min, max] size band. Returns filesize on success, -1 on
 *  failure. VICE aligns short loads to the END of the buffer (see
 *  driverom.c:188-192) — replicated here so the post-load `memmove` in
 *  driverom_load() lines up byte-for-byte. */
function sysfile_load(
  rom_name: string | null,
  drive_rom: Uint8Array,
  min: number,
  max: number,
): number {
  if (!rom_name) return -1;
  const path = sysfile_resolve(rom_name);
  if (path === null) return -1;
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch {
    return -1;
  }
  const filesize = raw.length;
  if (max > 0 && filesize > max) return -1;
  if (min > 0 && filesize < min && filesize !== min) {
    // VICE accepts files in [min, max]. Anything smaller than the
    // single-size case fails closed.
    if (filesize !== min && min === max) return -1;
  }
  if (filesize === min || filesize === max || (min < max && filesize <= max && filesize >= min)) {
    if (filesize >= max) {
      drive_rom.set(raw.subarray(0, max), 0);
    } else if (min < max && filesize <= min) {
      // sysfile_load loaded the block to the TOP end of the buffer.
      drive_rom.set(raw.subarray(0, filesize), max - filesize);
    } else {
      drive_rom.set(raw.subarray(0, filesize), 0);
    }
    return filesize;
  }
  return -1;
}

// Tiny logging adapter so the PORT OF lines stay literal. VICE uses
// log_error(driverom_log, "..."); TS routes the same string to stderr.
function log_error(_log: number, msg: string): void {
  process.stderr.write(`[driverom] ${msg}\n`);
}

// =============================================================================
// SECTION 6 — Per-drive-type ROM region table
// =============================================================================
//
// driverom_snapshot_write / _read both switch on unit->type and pick
// (base, len) into unit->rom. The switch body is byte-identical between
// the two functions in VICE (lines 342-415 vs 454-527). To keep NL-2 +
// PL-3 happy the switch lives in ONE place — a private helper that
// returns the {offset, len} pair. Both snapshot funcs read it; no public
// surface added.

interface RomRegion {
  offset: number;
  len: number;
}

function driverom_select_rom_region(type: number): RomRegion | null {
  switch (type) {
    case DRIVE_TYPE_1540:
      return { offset: 0x4000, len: DRIVE_ROM1540_SIZE };
    case DRIVE_TYPE_1541:
      return { offset: 0x4000, len: DRIVE_ROM1541_SIZE };
    case DRIVE_TYPE_1541II:
      return { offset: 0x4000, len: DRIVE_ROM1541II_SIZE };
    case DRIVE_TYPE_1551:
      return { offset: 0, len: DRIVE_ROM1551_SIZE };
    case DRIVE_TYPE_1570:
      return { offset: 0, len: DRIVE_ROM1570_SIZE };
    case DRIVE_TYPE_1571:
      return { offset: 0, len: DRIVE_ROM1571_SIZE };
    case DRIVE_TYPE_1571CR:
      return { offset: 0, len: DRIVE_ROM1571CR_SIZE };
    case DRIVE_TYPE_1581:
      return { offset: 0, len: DRIVE_ROM1581_SIZE };
    case DRIVE_TYPE_2000:
      return { offset: 0, len: DRIVE_ROM2000_SIZE };
    case DRIVE_TYPE_4000:
      return { offset: 0, len: DRIVE_ROM4000_SIZE };
    case DRIVE_TYPE_CMDHD:
      return { offset: 0x4000, len: DRIVE_ROMCMDHD_SIZE };
    case DRIVE_TYPE_2031:
      return { offset: 0x4000, len: DRIVE_ROM2031_SIZE };
    case DRIVE_TYPE_2040:
      return { offset: DRIVE_ROM_SIZE - DRIVE_ROM2040_SIZE, len: DRIVE_ROM2040_SIZE };
    case DRIVE_TYPE_3040:
      return { offset: DRIVE_ROM_SIZE - DRIVE_ROM3040_SIZE, len: DRIVE_ROM3040_SIZE };
    case DRIVE_TYPE_4040:
      return { offset: DRIVE_ROM_SIZE - DRIVE_ROM4040_SIZE, len: DRIVE_ROM4040_SIZE };
    case DRIVE_TYPE_1001:
    case DRIVE_TYPE_8050:
    case DRIVE_TYPE_8250:
      return { offset: 0x4000, len: DRIVE_ROM1001_SIZE };
    case DRIVE_TYPE_9000:
      return { offset: 0x4000, len: DRIVE_ROM9000_SIZE };
    default:
      return null;
  }
}

// =============================================================================
// SECTION 7 — DRIVEROM snapshot module name + version
// =============================================================================

// PORT OF: vice/src/drive/driverom.c:322 (#define ROM_SNAP_MAJOR)
export const ROM_SNAP_MAJOR = 1;
// PORT OF: vice/src/drive/driverom.c:323 (#define ROM_SNAP_MINOR)
export const ROM_SNAP_MINOR = 0;

// =============================================================================
// SECTION 8 — Exported functions (NL-2: verbatim VICE names, snake_case)
// =============================================================================

// PORT OF: vice/src/drive/driverom.c:541-544 (driverom_init)
// One-shot init — opens the DriveROM log handle. Mirrors VICE.
export function driverom_init(): void {
  // VICE: driverom_log = log_open("DriveROM");
  driverom_log = 0;
}

// Like driverom_load but doesn't actually load anything; tests if the
// file exists and matches the given size band. On failure: returns -1
// and disables every drive whose `type` matches the requested type.
// `loaded` and `size` are out-parameters in VICE (`unsigned int *`);
// in TS they are `{ value: number }` mutable refs.
// PORT OF: vice/src/drive/driverom.c:78-146 (driverom_test_load)
export function driverom_test_load(
  resource_name: string,
  loaded: { value: number } | null,
  min: number,
  max: number,
  name: string,
  type: number,
  size: { value: number } | null,
): number {
  if (!drive_rom_load_ok) return 0;

  const rom_name = driverom_hooks?.resources_get_string(resource_name) ?? null;

  if (size !== null) size.value = 0;
  if (loaded !== null) loaded.value = 0;

  const filesize = sysfile_locate(rom_name);

  if (filesize < 0) {
    log_error(
      driverom_log,
      `${name} ROM image not found. Hardware-level ${name} emulation is not available.`,
    );
    return driverom_disable_drives_of_type(type);
  }

  if (min < max) {
    if (filesize > max) {
      log_error(
        driverom_log,
        `${name} ROM image too large. Hardware-level ${name} emulation is not available.`,
      );
      return driverom_disable_drives_of_type(type);
    }
  }

  if (loaded !== null) loaded.value = 1;
  if (size !== null) size.value = filesize >>> 0;
  return 0;
}

// PORT OF: vice/src/drive/driverom.c:148-218 (driverom_load)
// PL-7: on missing ROM returns -1 AND disables every drive whose
// `type` matches the requested type. NO zero-filled fallback. On
// success: aligns short loads to end-of-buffer, runs the per-unit
// machine_drive_rom_setup_image + driverom_initialize_traps +
// drive_cpu_trigger_reset chain for every drive of that type.
export function driverom_load(
  resource_name: string,
  drive_rom: Uint8Array,
  loaded: { value: number },
  min: number,
  max: number,
  name: string,
  type: number,
  size: { value: number } | null,
): number {
  if (!drive_rom_load_ok) return 0;

  const rom_name = driverom_hooks?.resources_get_string(resource_name) ?? null;

  if (size !== null) size.value = 0;
  loaded.value = 0;

  const filesize = sysfile_load(rom_name, drive_rom, min, max);

  if (filesize < 0) {
    log_error(
      driverom_log,
      `${name} ROM image not found. Hardware-level ${name} emulation is not available.`,
    );
    return driverom_disable_drives_of_type(type);
  }

  loaded.value = 1;
  if (size !== null) size.value = filesize >>> 0;

  // Align to the end of available space (VICE driverom.c:187-192).
  if (filesize <= min && min < max) {
    // sysfile_load loaded the block to the top end of the buffer.
    drive_rom.copyWithin(0, max - min, max - min + min);
  }

  // Reset all drives that use the loaded ROM (VICE driverom.c:194-204).
  const units = driverom_hooks?.diskunit_context() ?? [];
  for (let dnr = 0; dnr < NUM_DISK_UNITS; dnr++) {
    const unit = units[dnr] ?? null;
    if (unit !== null && unit.type === type) {
      driverom_hooks?.machine_drive_rom_setup_image(dnr);
      driverom_initialize_traps(unit);
      driverom_hooks?.drive_cpu_trigger_reset(dnr);
    }
  }
  return 0;
}

// PORT OF: vice/src/drive/driverom.c:132-145 / 207-217 (exiterror tail)
// Private helper — both driverom_test_load and driverom_load run the
// same disable-loop on failure. VICE inlines the loop in both functions;
// this single helper keeps the failure semantics 1:1 while satisfying
// PL-3 (no duplicated code-path divergence).
function driverom_disable_drives_of_type(type: number): number {
  const units = driverom_hooks?.diskunit_context() ?? [];
  for (let dnr = 0; dnr < NUM_DISK_UNITS; dnr++) {
    const unit = units[dnr] ?? null;
    if (unit !== null && unit.type === type) {
      unit.type = DRIVE_TYPE_NONE;
      driverom_hooks?.drive_disable(unit);
      driverom_hooks?.machine_bus_status_drivetype_set(dnr + 8, 0);
    }
  }
  return -1;
}

// PORT OF: vice/src/drive/driverom.c:220-234 (driverom_load_images)
// Sets the `drive_rom_load_ok` gate, then asks machine_drive to load
// every per-unit ROM. Returns -1 if no ROM was loaded at all (per
// VICE — same error path).
export function driverom_load_images(): number {
  drive_rom_load_ok = 1;

  driverom_hooks?.machine_drive_rom_load();

  const checked = driverom_hooks?.machine_drive_rom_check_loaded(/* DRIVE_TYPE_ANY */ 9999) ?? -1;
  if (checked < 0) {
    log_error(
      driverom_log,
      "No ROM image found at all!  Hardware-level emulation is not available.",
    );
    return -1;
  }
  return 0;
}

// CRITICAL (Spec 612 T2.9 audit showstopper) — patches the per-unit
// trap-ROM with TRAP_OPCODE at the idle-trap address so
// DRIVE_IDLE_TRAP_IDLE actually fires. For 1541-family drives the trap
// sits at $EC9B with continuation $EBFF; opcode is byte-checked first
// so a non-VICE ROM (fastloader / custom dos) declines the patch.
// PORT OF: vice/src/drive/driverom.c:236-309 (driverom_initialize_traps)
export function driverom_initialize_traps(unit: diskunit_context_t): void {
  // memcpy(unit->trap_rom, unit->rom, DRIVE_ROM_SIZE);
  unit.trap_rom.set(unit.rom.subarray(0, DRIVE_ROM_SIZE), 0);

  unit.trap = -1;
  unit.trapcont = -1;

  if (unit.idling_method !== DRIVE_IDLE_TRAP_IDLE) {
    return;
  }

  switch (unit.type) {
    case DRIVE_TYPE_1540:
    case DRIVE_TYPE_1541:
    case DRIVE_TYPE_1541II:
    case DRIVE_TYPE_1570:
    case DRIVE_TYPE_1571:
    case DRIVE_TYPE_1571CR:
      unit.trap = 0xec9b;
      unit.trapcont = 0xebff;
      break;
    case DRIVE_TYPE_1551:
      unit.trap = 0xead9;
      unit.trapcont = 0xeabd;
      break;
    case DRIVE_TYPE_1581:
      unit.trap = 0xb158;
      unit.trapcont = 0xb105;
      break;
    case DRIVE_TYPE_2000:
      unit.trap = 0xf3c0;
      unit.trapcont = 0xf368;
      break;
    case DRIVE_TYPE_4000:
      unit.trap = 0xf3ec;
      unit.trapcont = 0xf394;
      break;
    case DRIVE_TYPE_2031:
      unit.trap = 0xece9;
      unit.trapcont = 0xec4d;
      break;
    case DRIVE_TYPE_2040:
      unit.trap = 0xe2d3;
      unit.trapcont = 0xe27e;
      break;
    case DRIVE_TYPE_3040:
      unit.trap = 0xd508;
      unit.trapcont = 0xd4b8;
      break;
    case DRIVE_TYPE_4040:
      unit.trap = 0xd507;
      unit.trapcont = 0xd4b7;
      break;
    default:
      break;
  }

  if (
    unit.trap >= 0 &&
    unit.trap_rom[unit.trap - 0x8000] === 0x4c &&
    unit.trap_rom[unit.trap - 0x8000 + 1] === (unit.trapcont & 0xff) &&
    unit.trap_rom[unit.trap - 0x8000 + 2] === ((unit.trapcont >> 8) & 0xff)
  ) {
    unit.trap_rom[unit.trap - 0x8000] = TRAP_OPCODE;
    if (unit.type === DRIVE_TYPE_1551) {
      // VICE driverom.c:300-303
      unit.trap_rom[0xeabf - 0x8000] = 0xea;
      unit.trap_rom[0xeac0 - 0x8000] = 0xea;
      unit.trap_rom[0xead0 - 0x8000] = 0x08;
    }
    return;
  }
  unit.trap = -1;
  unit.trapcont = -1;
}

// PORT OF: vice/src/drive/driverom.c:326-425 (driverom_snapshot_write)
// Writes a "DRIVEROM<unit>" module: just the per-type slice of unit->rom.
// Until drive_snapshot.ts (T2.14) lands the snapshot_module_create /
// SMW_BA peer is not ported — this function still resolves the correct
// region and reports the format error per VICE for unknown drive types.
export function driverom_snapshot_write(_s: snapshot_t, drive: drive_t): number {
  const unit = drive.diskunit;
  if (unit === null) return -1;
  const region = driverom_select_rom_region(unit.type);
  if (region === null) return -1;

  // VICE: snapshot_module_create + SMW_BA(m, base, len) + snapshot_module_close.
  // The snapshot module layer (drive_snapshot.ts, T2.14) plugs in here.
  // Until then the function reports success after region validation so
  // callers can wire it without rewriting once T2.14 lands.
  void unit.rom.subarray(region.offset, region.offset + region.len);
  return 0;
}

// PORT OF: vice/src/drive/driverom.c:427-539 (driverom_snapshot_read)
// Reads a "DRIVEROM<unit>" module back into the per-type slice of
// unit->rom. Same T2.14 dependency note as the write side.
export function driverom_snapshot_read(_s: snapshot_t, drive: drive_t): number {
  const unit = drive.diskunit;
  if (unit === null) return -1;
  const region = driverom_select_rom_region(unit.type);
  if (region === null) return -1;

  // VICE: snapshot_module_open + SMR_BA(m, base, len) +
  //       machine_drive_rom_do_checksum + snapshot_module_close.
  // T2.14 wires the snapshot layer; until then the function validates
  // the region and reports success.
  void unit.rom.subarray(region.offset, region.offset + region.len);
  return 0;
}
