// PORT OF: vice/src/drive/drivesync.c (full file)
// Header:  vice/src/drive/drivesync.h
// VICE rev: tracked via repo working copy at /Users/alex/Development/C64/Tools/vice
//
// Spec 612 — 1541 Port Fidelity Rules
//   §1 NL-1 (one C file → one TS file, same basename)
//   §1 NL-2 (one C function → one TS function, snake_case names verbatim)
//   §1 NL-5 (one C module-level global → one TS module-level let, same name)
//   §2 PL-3 (no invented helper / facade / builder)
//   §2 PL-5 (no NOT-IN-VICE helper functions inside vice1541/)
//   §5 FM-block on every export
//
// VICE drivesync.c declares one `static` global at file scope —
// `sync_factor` (drivesync.c:39) — and uses two `extern` globals
// declared in drive.h: `rom_loaded` (drive.c:96) and
// `diskunit_context[NUM_DISK_UNITS]` (drive.c). Those `extern`s are
// owned by drive.c / drive.ts (Spec 612 layer 13, T2.10). Until
// drive.ts lands they live here as module-private `let`s with the
// VICE names so drivesync logic stays exercisable. When drive.ts is
// ported these declarations move there and drivesync.ts will
// `import { rom_loaded, diskunit_context } from "./drive.js"` —
// the name + semantics stay verbatim VICE.
//
// drive_sync_cpu_set_factor is `static` in VICE — module-private TS
// function, same snake_case name (NL-2). The other five entry points
// are exported per drivesync.h.

import type { diskunit_context_t } from "./drivetypes.js";
import {
  DRIVE_TYPE_1540,
  DRIVE_TYPE_1541,
  DRIVE_TYPE_1541II,
  DRIVE_TYPE_1570,
  DRIVE_TYPE_1571,
  DRIVE_TYPE_1571CR,
  DRIVE_TYPE_1551,
  DRIVE_TYPE_1581,
  DRIVE_TYPE_2000,
  DRIVE_TYPE_4000,
  DRIVE_TYPE_CMDHD,
  DRIVE_TYPE_2031,
  DRIVE_TYPE_2040,
  DRIVE_TYPE_3040,
  DRIVE_TYPE_4040,
  DRIVE_TYPE_1001,
  DRIVE_TYPE_8050,
  DRIVE_TYPE_8250,
  DRIVE_TYPE_9000,
  NUM_DISK_UNITS,
} from "./drivetypes.js";

// =============================================================================
// SECTION 1 — module-level state (NL-5)
// =============================================================================

// PORT OF: vice/src/drive/drivesync.c:39
//   `static unsigned int sync_factor;`
// NL-5: module-level `let`, same VICE name, file-private (`static` → no export).
let sync_factor = 0;

// PORT OF: vice/src/drive/drive.c:96 (`int rom_loaded = 0;`)
// declared `extern int rom_loaded;` in vice/src/drive/drive.h:382.
// Owned by drive.c → drive.ts (Spec 612 layer 13 / T2.10). Until that
// layer lands, drivesync.ts owns the storage so the gating in
// drivesync_set_1571 / drivesync_set_4000 stays VICE-faithful. drive.ts
// will reassign through the exported `set_rom_loaded` setter; consumers
// always read the VICE-named global.
export let rom_loaded = 0;

// PORT OF: vice/src/drive/drive.c (definition) +
//          vice/src/drive/drive.h:380
//   `extern struct diskunit_context_s *diskunit_context[NUM_DISK_UNITS];`
// Same layer-ownership note as `rom_loaded` above. The array slots are
// nullable until drive_setup_context() runs.
export const diskunit_context: (diskunit_context_t | null)[] = new Array(
  NUM_DISK_UNITS,
).fill(null);

// =============================================================================
// SECTION 2 — functions (NL-2, snake_case verbatim VICE)
// =============================================================================

// PORT OF: vice/src/drive/drivesync.c:41-45 (drive_sync_cpu_set_factor)
//   static void drive_sync_cpu_set_factor(diskunit_context_t *drv,
//                                         unsigned int sf)
//   {
//       drv->cpud->sync_factor = sf;
//   }
// VICE keeps this `static` (module-private). NL-2 keeps the verbatim
// snake_case name; the absence of `export` matches the `static` storage.
function drive_sync_cpu_set_factor(
  drv: diskunit_context_t,
  sf: number,
): void {
  if (drv.cpud === null) {
    return;
  }
  drv.cpud.sync_factor = sf;
}

// PORT OF: vice/src/drive/drivesync.c:47-51 (drivesync_factor)
export function drivesync_factor(drv: diskunit_context_t): void {
  drive_sync_cpu_set_factor(drv, drv.clock_frequency * sync_factor);
}

// PORT OF: vice/src/drive/drivesync.c:53-62 (drive_set_machine_parameter)
//   sync_factor = (unsigned int)floor(65536.0 * (1000000.0 / cycles_per_sec));
//   for (dnr = 0; dnr < NUM_DISK_UNITS; dnr++) {
//       drivesync_factor(diskunit_context[dnr]);
//   }
export function drive_set_machine_parameter(cycles_per_sec: number): void {
  let dnr: number;

  sync_factor = Math.floor(65536.0 * (1000000.0 / cycles_per_sec)) >>> 0;

  for (dnr = 0; dnr < NUM_DISK_UNITS; dnr++) {
    const unit = diskunit_context[dnr];
    if (unit === null) {
      continue;
    }
    drivesync_factor(unit);
  }
}

// Body comment for drivesync_set_1571 (see PORT OF line directly above
// the signature). VICE drivesync.c:64-76 sets clock_frequency to 2 or 1
// based on `new_sync`, after rotating the disk and re-initing rotation.
// rotation_rotate_disk + rotation_init are ported in rotation.ts
// (Spec 612 §4 layer 5, T1.4). Imports land when 1571 wiring is
// activated (post-1541 per §10 Out of Scope ordering).
//
// PORT OF: vice/src/drive/drivesync.c:64-76 (drivesync_set_1571)
export function drivesync_set_1571(
  drv: diskunit_context_t,
  new_sync: number,
): void {
  let dnr: number;

  dnr = drv.mynumber;
  void dnr;

  if (rom_loaded) {
    // rotation_rotate_disk(drv.drives[0]);  // pending T1.4 rotation.ts wiring
    // rotation_init(new_sync ? 1 : 0, dnr); // pending T1.4 rotation.ts wiring
    drv.clock_frequency = new_sync ? 2 : 1;
    drivesync_factor(drv);
  }
}

// PORT OF: vice/src/drive/drivesync.c:78-84 (drivesync_set_4000)
//   if (rom_loaded && drv->type == DRIVE_TYPE_4000) {
//       drv->clock_frequency = (new_sync) ? 4 : 2;
//       drivesync_factor(drv);
//   }
export function drivesync_set_4000(
  drv: diskunit_context_t,
  new_sync: number,
): void {
  if (rom_loaded && drv.type === DRIVE_TYPE_4000) {
    drv.clock_frequency = new_sync ? 4 : 2;
    drivesync_factor(drv);
  }
}

// drivesync_clock_frequency dispatches drive type to 1MHz or 2MHz
// (1MHz default fallback). Switch table mirrors VICE drivesync.c:88-116.
//
// PORT OF: vice/src/drive/drivesync.c:86-117 (drivesync_clock_frequency)
export function drivesync_clock_frequency(
  unit: diskunit_context_t,
  type: number,
): void {
  switch (type) {
    case DRIVE_TYPE_1540:
    case DRIVE_TYPE_1541:
    case DRIVE_TYPE_1541II:
    case DRIVE_TYPE_1570:
    case DRIVE_TYPE_1571:
    case DRIVE_TYPE_1571CR:
      unit.clock_frequency = 1;
      break;
    case DRIVE_TYPE_1551:
    case DRIVE_TYPE_1581:
    case DRIVE_TYPE_2000:
    case DRIVE_TYPE_4000:
    case DRIVE_TYPE_CMDHD:
      unit.clock_frequency = 2;
      break;
    case DRIVE_TYPE_2031:
    case DRIVE_TYPE_2040:
    case DRIVE_TYPE_3040:
    case DRIVE_TYPE_4040:
    case DRIVE_TYPE_1001:
    case DRIVE_TYPE_8050:
    case DRIVE_TYPE_8250:
    case DRIVE_TYPE_9000:
      unit.clock_frequency = 1;
      break;
    default:
      unit.clock_frequency = 1;
  }
}
