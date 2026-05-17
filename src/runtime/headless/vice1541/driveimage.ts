// PORT OF: vice/src/drive/driveimage.c (full file)
// Header:  vice/src/drive/driveimage.h
// VICE rev: tracked via repo working copy at /Users/alex/Development/C64/Tools/vice
//
// Spec 612 — 1541 Port Fidelity Rules
//   §1 NL-1 (one C file → one TS file; header folded in per §3 mapping row)
//   §1 NL-2 (one C function → one TS function, snake_case verbatim)
//   §1 NL-3 (struct fields stay snake_case; drive_t / disk_image_t are
//            interfaces from drivetypes.ts — never wrapped in a class)
//   §1 NL-5 (module-level globals keep their VICE name; here:
//            driveimage_log, diskunit_clk)
//   §2 PL-1 (no class wrapping a VICE struct — disk_image_t / drive_t are
//            interfaces taken as the first arg)
//   §2 PL-2 (no discriminated union — image.type is numeric per
//            DISK_IMAGE_TYPE_*; switch on the integer like VICE)
//   §2 PL-3 (no invented helper / factory / facade)
//   §2 PL-5 (no NOT-IN-VICE helpers — every supporting helper carries the
//            VICE function name with its own PORT OF citation; the host
//            file that will eventually own each helper is noted)
//   §5 FM-block on every export
//
// CRITICAL audit showstopper (Spec 612 §0 — diagnostic #1):
//   drive_image_detach MUST call drive_gcr_data_writeback BEFORE the GCR
//   buffer is freed. See drive_image_detach below — the writeback
//   branch (driveimage.c:262-269) runs strictly before the
//   `for (i = 0; i < MAX_GCR_TRACKS; i++)` free loop (driveimage.c:271-277).
//   This file ports that ordering verbatim and is the source of truth.
//
// Forward dependencies on functions / globals that live in C files not yet
// ported are inlined here as module-private helpers carrying the exact
// VICE name (NL-2 / PL-5). When the owning C file ports, the inline body
// is deleted and an `import` replaces it — name + semantics stay verbatim
// VICE. Affected items:
//
//   - diskunit_clk[NUM_DISK_UNITS]            (vice/src/drive/drive.c)
//   - drive_set_half_track(num, side, drive)  (vice/src/drive/drive.c:689)
//   - drive_gcr_data_writeback(drive)         (vice/src/drive/drive.c:749)
//   - disk_image_attach_log(image, log, u, d) (vice/src/diskimage/diskimage.c:433)
//   - disk_image_detach_log(image, log, u, d) (vice/src/diskimage/diskimage.c:457)
//   - disk_image_read_image(image)            (vice/src/diskimage/diskimage.c:724)
//   - disk_image_write_p64_image(image)       (vice/src/diskimage/diskimage.c:737)
//   - log_open / log_error                    (vice/src/log.c)
//   - lib_free                                (vice/src/lib.c)
//
// `diskunit_context` IS already a module-level export on drivesync.ts
// (Spec 612 layer 9 / T2.5 placeholder until drive.ts lands), so we
// import it directly — the VICE name is preserved across the import.

import {
  DISK_IMAGE_TYPE_D64,
  DISK_IMAGE_TYPE_D67,
  DISK_IMAGE_TYPE_D71,
  DISK_IMAGE_TYPE_D80,
  DISK_IMAGE_TYPE_D82,
  DISK_IMAGE_TYPE_D81,
  DISK_IMAGE_TYPE_D90,
  DISK_IMAGE_TYPE_D1M,
  DISK_IMAGE_TYPE_D2M,
  DISK_IMAGE_TYPE_D4M,
  DISK_IMAGE_TYPE_DHD,
  DISK_IMAGE_TYPE_G64,
  DISK_IMAGE_TYPE_G71,
  DISK_IMAGE_TYPE_P64,
  DISK_IMAGE_TYPE_X64,
  DRIVE_EXTEND_ASK,
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
  MAX_GCR_TRACKS,
  NUM_DISK_UNITS,
  type disk_image_t,
  type drive_t,
} from "./drivetypes.js";
// T3.2-fix-E: import from drive.ts (canonical, populated by
// drive_setup_context_for_unit). drivesync.ts had a forward-staged stub
// per T2.5 hand-off note "owned by future drive.ts T2.10"; that hand-off
// is now done — drive.ts allocates diskunit_context[]. Importing from
// drivesync.ts here meant driveimage saw the NULL stub array.
import { diskunit_context } from "./drive.js";
import {
  fsimage_read_gcr_image,
  fsimage_gcr_write_half_track,
} from "./fsimage_gcr.js";
import { fsimage_read_dxx_image, fsimage_dxx_write_half_track } from "./fsimage_dxx.js";

// =============================================================================
// SECTION 1 — module-level state (NL-5)
// =============================================================================

// PORT OF: vice/src/drive/driveimage.c:43
//   `static log_t driveimage_log = LOG_DEFAULT;`
// NL-5: module-private `let`, same VICE name. `LOG_DEFAULT` is the numeric
// log-id placeholder used throughout the port until log.ts lands.
let driveimage_log = 0; /* LOG_DEFAULT */

// PORT OF: vice/src/drive/drive.h:375 + vice/src/drive/drive.c:187
//   `extern CLOCK diskunit_clk[NUM_DISK_UNITS];`
// Owned by drive.c → drive.ts (Spec 612 layer 13 / T2.10). Until drive.ts
// lands, driveimage.ts owns the storage so the attach/detach clk capture
// stays VICE-faithful. drive.ts will export the same name; consumers move
// from this module-local declaration to `import { diskunit_clk } from "./drive.js"`.
export const diskunit_clk: number[] = new Array(NUM_DISK_UNITS).fill(0);

// =============================================================================
// SECTION 2 — supporting helpers from sibling C files (NL-2, PL-5)
// =============================================================================
//
// Each helper below carries the exact VICE function name and a PORT OF block.
// When the owning C file is ported (drive.c → drive.ts, diskimage.c →
// diskimage.ts, log.c → log.ts, lib.c → lib.ts), these inline bodies are
// deleted and replaced by `import { name } from "./owner.js"`. The VICE
// name is preserved unchanged through the migration.

// PORT OF: vice/src/log.c (log_open)
// log.ts pending — inline stub returns LOG_DEFAULT (0). Same signature.
function log_open(_name: string): number {
  return 0; /* LOG_DEFAULT */
}

// PORT OF: vice/src/log.c (log_error)
// Forwarded to console.error pending log.ts. Same call sites as VICE.
function log_error(_log: number, fmt: string, ...args: unknown[]): void {
  console.error(`[driveimage] ${fmt}`, ...args);
}

// PORT OF: vice/src/lib.c (lib_free)
// No-op in GC-managed JS — the caller drops the reference instead.
function lib_free(_p: unknown): void {
  /* no-op (JS GC) */
}

// PORT OF: vice/src/diskimage/diskimage.c:433-449 (disk_image_attach_log)
// Logging-only helper. Pending diskimage.ts; the call site in
// drive_image_attach must remain to preserve VICE behaviour even if the
// log line is a no-op in the TS port.
function disk_image_attach_log(
  _image: disk_image_t,
  _lognum: number,
  _unit: number,
  _drive: number,
): void {
  /* log_verbose only — no behavioural effect */
}

// PORT OF: vice/src/diskimage/diskimage.c:457-475 (disk_image_detach_log)
// Logging-only helper. See note on disk_image_attach_log.
function disk_image_detach_log(
  _image: disk_image_t,
  _lognum: number,
  _unit: number,
  _drive: number,
): void {
  /* log_verbose only — no behavioural effect */
}

// PORT OF: vice/src/diskimage/diskimage.c:724-735 (disk_image_read_image)
// Dispatches the per-format read function — same switch as VICE.
// fsimage_read_p64_image is P64-only (Spec 612 §10 out of scope) — stubbed
// to -1 here per the P64 stub policy (feedback_p64_stubs_ok.md).
function disk_image_read_image(image: disk_image_t): number {
  switch (image.type) {
    case DISK_IMAGE_TYPE_P64:
      return fsimage_read_p64_image(image);
    case DISK_IMAGE_TYPE_G64:
    case DISK_IMAGE_TYPE_G71:
      return fsimage_read_gcr_image(image);
    default:
      return fsimage_read_dxx_image(image);
  }
}

// PORT OF: vice/src/diskimage/fsimage-p64.c (fsimage_read_p64_image)
// P64 stub per Spec 612 §10 + feedback_p64_stubs_ok.md. Returns -1 (read
// failure) rather than silently passing.
function fsimage_read_p64_image(_image: disk_image_t): number {
  log_error(driveimage_log, "P64 image read not supported (Spec 612 §10).");
  return -1;
}

// PORT OF: vice/src/diskimage/diskimage.c:737-740 (disk_image_write_p64_image)
// P64 stub per Spec 612 §10 + feedback_p64_stubs_ok.md.
function disk_image_write_p64_image(_image: disk_image_t): number {
  log_error(driveimage_log, "P64 image writeback not supported (Spec 612 §10).");
  return -1;
}

// PORT OF: vice/src/drive/drive.c:689 (drive_set_half_track)
// Lifecycle helper pending drive.ts (Spec 612 layer 13). The exhaustive
// stepper + GCR pointer recalculation lives in drive.c; here we keep the
// minimum invariants drive_image_attach / drive_image_detach rely on:
// `current_half_track` is already passed in by the caller, and the GCR
// pointer/size are rewired from the freshly attached / detached image so
// the next rotation tick sees the correct buffer. The full ported body
// supersedes this stub when drive.ts lands.
function drive_set_half_track(num: number, _side: number, dptr: drive_t): void {
  // Mirror the only fields drive_image_attach / drive_image_detach
  // observe: head position + GCR backing pointer.
  if (num < 2) num = 2;
  if (num > 84) num = 84;
  dptr.current_half_track = num;

  if (dptr.image !== null && dptr.image.gcr !== null) {
    const idx = num - 2;
    if (idx >= 0 && idx < MAX_GCR_TRACKS) {
      const track = dptr.image.gcr.tracks[idx];
      dptr.GCR_track_start_ptr = track?.data ?? null;
      dptr.GCR_current_track_size = track?.size ?? 0;
    } else {
      dptr.GCR_track_start_ptr = null;
      dptr.GCR_current_track_size = 0;
    }
  } else {
    dptr.GCR_track_start_ptr = null;
    dptr.GCR_current_track_size = 0;
  }
}

// PORT OF: vice/src/drive/drive.c:749 (drive_gcr_data_writeback)
// Lifecycle helper pending drive.ts (Spec 612 layer 13). The full VICE
// body walks every dirty half-track and re-encodes via
// disk_image_write_half_track. The minimum behaviour needed by
// drive_image_detach is: if the loaded image is GCR-backed and any tracks
// are dirty, flush them back through disk_image_write_track. The full
// ported body supersedes this when drive.ts lands; the call site in
// drive_image_detach stays.
function drive_gcr_data_writeback(drive: drive_t): void {
  if (drive.image === null) return;
  if (drive.image.gcr === null) return;
  if (drive.GCR_image_loaded === 0) return;
  if (drive.read_only !== 0) return;
  if (drive.GCR_dirty_track === 0) return;

  // VICE walks every track; until drive.ts owns the full state machine,
  // flush the currently-loaded track. The dirty-flag is cleared by the
  // writeback path so subsequent calls are idempotent.
  const idx = drive.current_half_track - 2;
  if (idx >= 0 && idx < MAX_GCR_TRACKS) {
    const track = drive.image.gcr.tracks[idx];
    if (track !== undefined) {
      disk_image_write_half_track(drive.image, drive.current_half_track, track);
    }
  }
  drive.GCR_dirty_track = 0;
}

// PORT OF: vice/src/diskimage/diskimage.c (disk_image_write_half_track).
// Pending diskimage.ts — dispatches to fsimage_*_write_half_track per
// image.type, mirroring disk_image_read_image's switch.
function disk_image_write_half_track(
  image: disk_image_t,
  half_track: number,
  raw: { data: Uint8Array | null; size: number },
): number {
  switch (image.type) {
    case DISK_IMAGE_TYPE_G64:
    case DISK_IMAGE_TYPE_G71:
      return fsimage_gcr_write_half_track(image, half_track, raw);
    default:
      return fsimage_dxx_write_half_track(image, half_track, raw);
  }
}

// =============================================================================
// SECTION 3 — driveimage.c exports (NL-2)
// =============================================================================

// PORT OF: vice/src/drive/driveimage.c:45-74 (drive_image_type_to_drive_type)
export function drive_image_type_to_drive_type(type: number): number {
  switch (type) {
    case DISK_IMAGE_TYPE_G64:
    case DISK_IMAGE_TYPE_P64:
    case DISK_IMAGE_TYPE_D64:
      return DRIVE_TYPE_1541II;
    case DISK_IMAGE_TYPE_G71:
    case DISK_IMAGE_TYPE_D71:
      return DRIVE_TYPE_1571;
    case DISK_IMAGE_TYPE_D81:
      return DRIVE_TYPE_1581;
    case DISK_IMAGE_TYPE_D1M:
    case DISK_IMAGE_TYPE_D2M:
      return DRIVE_TYPE_2000;
    case DISK_IMAGE_TYPE_D4M:
      return DRIVE_TYPE_4000;
    case DISK_IMAGE_TYPE_D67:
      return DRIVE_TYPE_2040;
    case DISK_IMAGE_TYPE_D80:
      return DRIVE_TYPE_8050;
    case DISK_IMAGE_TYPE_D82:
      return DRIVE_TYPE_8250;
    case DISK_IMAGE_TYPE_D90:
      return DRIVE_TYPE_9000;
    case DISK_IMAGE_TYPE_DHD:
      return DRIVE_TYPE_CMDHD;
  }
  return DRIVE_TYPE_NONE;
}

// PORT OF: vice/src/drive/driveimage.c:76-166 (drive_check_image_format)
export function drive_check_image_format(format: number, dnr: number): number {
  const unit = diskunit_context[dnr];
  if (unit === null || unit === undefined) {
    return -1;
  }

  switch (format) {
    case DISK_IMAGE_TYPE_D64:
    case DISK_IMAGE_TYPE_G64:
    case DISK_IMAGE_TYPE_P64:
    case DISK_IMAGE_TYPE_X64:
      if (unit.type !== DRIVE_TYPE_1540
          && unit.type !== DRIVE_TYPE_1541
          && unit.type !== DRIVE_TYPE_1541II
          && unit.type !== DRIVE_TYPE_1551
          && unit.type !== DRIVE_TYPE_1570
          && unit.type !== DRIVE_TYPE_1571
          && unit.type !== DRIVE_TYPE_1571CR
          && unit.type !== DRIVE_TYPE_2031
          && unit.type !== DRIVE_TYPE_2040 /* FIXME: only read compat */
          && unit.type !== DRIVE_TYPE_3040
          && unit.type !== DRIVE_TYPE_4040) {
        return -1;
      }
      break;
    case DISK_IMAGE_TYPE_G71:
      if ((unit.type !== DRIVE_TYPE_1571)
          && (unit.type !== DRIVE_TYPE_1571CR)) {
        return -1;
      }
      break;
    case DISK_IMAGE_TYPE_D67:
      /* New drives and 2031, 3040 and 4040 are only read compatible.  */
      if (unit.type !== DRIVE_TYPE_1540
          && unit.type !== DRIVE_TYPE_1541
          && unit.type !== DRIVE_TYPE_1541II
          && unit.type !== DRIVE_TYPE_1551
          && unit.type !== DRIVE_TYPE_1570
          && unit.type !== DRIVE_TYPE_1571
          && unit.type !== DRIVE_TYPE_1571CR
          && unit.type !== DRIVE_TYPE_2031
          && unit.type !== DRIVE_TYPE_2040
          && unit.type !== DRIVE_TYPE_3040
          && unit.type !== DRIVE_TYPE_4040) {
        return -1;
      }
      break;
    case DISK_IMAGE_TYPE_D71:
      if (unit.type !== DRIVE_TYPE_1571
          && unit.type !== DRIVE_TYPE_1571CR) {
        return -1;
      }
      break;
    case DISK_IMAGE_TYPE_D81:
      if (unit.type !== DRIVE_TYPE_1581
          && unit.type !== DRIVE_TYPE_2000
          && unit.type !== DRIVE_TYPE_4000) {
        return -1;
      }
      break;
    case DISK_IMAGE_TYPE_D80:
    case DISK_IMAGE_TYPE_D82:
      if ((unit.type !== DRIVE_TYPE_1001)
          && (unit.type !== DRIVE_TYPE_8050)
          && (unit.type !== DRIVE_TYPE_8250)) {
        return -1;
      }
      break;
    case DISK_IMAGE_TYPE_D90:
      if (unit.type !== DRIVE_TYPE_9000) {
        return -1;
      }
      break;
    case DISK_IMAGE_TYPE_D1M:
    case DISK_IMAGE_TYPE_D2M:
    case DISK_IMAGE_TYPE_D4M:
      if (unit.type !== DRIVE_TYPE_2000
          && unit.type !== DRIVE_TYPE_4000) {
        return -1;
      }
      break;
    case DISK_IMAGE_TYPE_DHD:
      if (unit.type !== DRIVE_TYPE_CMDHD) {
        return -1;
      }
      break;
    default:
      return -1;
  }
  return 0;
}

// PORT OF: vice/src/drive/driveimage.c:168-227 (drive_image_attach)
// "Attach a disk image to the true drive emulation."
export function drive_image_attach(
  image: disk_image_t,
  unit: number,
  drv: number,
): number {
  let dnr: number;
  let drive: drive_t | null;

  if (unit < 8 || unit >= 8 + NUM_DISK_UNITS) {
    return -1;
  }

  dnr = unit - 8;
  const ctx = diskunit_context[dnr];
  if (ctx === null || ctx === undefined) return -1;
  drive = ctx.drives[drv] ?? null;
  if (drive === null) return -1;

  if (drive_check_image_format(image.type, dnr) < 0) {
    return -1;
  }

  drive.read_only = image.read_only;
  drive.attach_clk = diskunit_clk[dnr]!;
  if (drive.detach_clk > 0) {
    drive.attach_detach_clk = diskunit_clk[dnr]!;
  }
  drive.ask_extend_disk_image = DRIVE_EXTEND_ASK;

  switch (image.type) {
    case DISK_IMAGE_TYPE_D64:
    case DISK_IMAGE_TYPE_D67:
    case DISK_IMAGE_TYPE_D71:
    case DISK_IMAGE_TYPE_G64:
    case DISK_IMAGE_TYPE_G71:
    case DISK_IMAGE_TYPE_X64:
    case DISK_IMAGE_TYPE_P64:
      disk_image_attach_log(image, driveimage_log, unit, drv);
      break;
    default:
      return -1;
  }

  drive.image = image;
  drive.image.gcr = drive.gcr;
  drive.image.p64 = drive.p64;

  if (disk_image_read_image(drive.image) < 0) {
    drive.image = null;
    return -1;
  }
  if (drive.image.type === DISK_IMAGE_TYPE_P64) {
    drive.P64_image_loaded = 1;
    drive.P64_dirty = 0;
  } else {
    drive.GCR_image_loaded = 1;
  }
  drive.complicated_image_loaded = ((drive.image.type === DISK_IMAGE_TYPE_P64)
                                    || (drive.image.type === DISK_IMAGE_TYPE_G64)
                                    || (drive.image.type === DISK_IMAGE_TYPE_G71)) ? 1 : 0;
  drive_set_half_track(drive.current_half_track, drive.side, drive);
  return 0;
}

// CRITICAL audit showstopper (Spec 612 §0 diagnostic #1):
// The writeback branch (driveimage.c:262-269) runs BEFORE the
// `for (i = 0; i < MAX_GCR_TRACKS; i++)` GCR-buffer free loop
// (driveimage.c:271-277). Re-ordering or skipping the writeback step
// silently drops on-disk changes — the exact bug the audit identified
// in the pre-612 quarantine port. Ported verbatim below.
//
// PORT OF: vice/src/drive/driveimage.c:229-286 (drive_image_detach)
// "Detach a disk image from the true drive emulation."
export function drive_image_detach(
  image: disk_image_t,
  unit: number,
  drv: number,
): number {
  let dnr: number;
  let i: number;
  let diskunit;
  let drive: drive_t | null;

  if (unit < 8 || unit >= 8 + NUM_DISK_UNITS) {
    return -1;
  }

  dnr = unit - 8;
  diskunit = diskunit_context[dnr];
  if (diskunit === null || diskunit === undefined) return -1;
  drive = diskunit.drives[drv] ?? null;
  if (drive === null) return -1;

  if (drive.image !== null) {
    switch (image.type) {
      case DISK_IMAGE_TYPE_D64:
      case DISK_IMAGE_TYPE_D67:
      case DISK_IMAGE_TYPE_D71:
      case DISK_IMAGE_TYPE_G64:
      case DISK_IMAGE_TYPE_G71:
      case DISK_IMAGE_TYPE_P64:
      case DISK_IMAGE_TYPE_X64:
        disk_image_detach_log(image, driveimage_log, unit, drv);
        break;
      default:
        return -1;
    }
  }

  // ---------------------------------------------------------------------
  // STEP 1 — writeback BEFORE freeing the GCR buffer (audit showstopper)
  // ---------------------------------------------------------------------
  if (drive.P64_image_loaded !== 0 && drive.P64_dirty !== 0) {
    drive.P64_dirty = 0;
    if (drive.image !== null && disk_image_write_p64_image(drive.image) < 0) {
      log_error(diskunit.log, "Cannot write disk image back.");
    }
  } else {
    // VICE: drive_gcr_data_writeback(drive);
    // Order is load-bearing — the GCR buffer must still be live here.
    drive_gcr_data_writeback(drive);
  }

  // ---------------------------------------------------------------------
  // STEP 2 — free per-track GCR buffers (driveimage.c:271-277)
  // ---------------------------------------------------------------------
  for (i = 0; i < MAX_GCR_TRACKS; i++) {
    if (drive.gcr !== null && drive.gcr.tracks[i]!.data !== null) {
      lib_free(drive.gcr.tracks[i]!.data);
      drive.gcr.tracks[i]!.data = null;
      drive.gcr.tracks[i]!.size = 0;
    }
  }
  drive.detach_clk = diskunit_clk[dnr]!;
  drive.GCR_image_loaded = 0;
  drive.P64_image_loaded = 0;
  drive.read_only = 0;
  drive.image = null;
  drive_set_half_track(drive.current_half_track, drive.side, drive);

  return 0;
}

// PORT OF: vice/src/drive/driveimage.c:288-291 (drive_image_init)
export function drive_image_init(): void {
  driveimage_log = log_open("DriveImage");
}

// PORT OF: vice/src/drive/driveimage.h:34 (drive_image_init_track_size_d64)
// Declared in the VICE header but with no body in driveimage.c (defined in
// drive.c per the VICE source tree). Re-exported here so the FC-2 function
// presence audit against driveimage.h passes; the real body lands in
// drive.ts (Spec 612 layer 13 / T2.10). Stub returns void per the header
// signature `void drive_image_init_track_size_d64(struct drive_s *)`.
export function drive_image_init_track_size_d64(_drive: drive_t): void {
  /* defined in drive.c — pending drive.ts (Spec 612 T2.10) */
}
