// PORT OF: vice/src/drive/drive-snapshot.c (full file)
// Header:  vice/src/drive/drive-snapshot.h
// VICE rev: tracked via repo working copy at /Users/alex/Development/C64/Tools/vice
//
// Spec 612 — 1541 Port Fidelity Rules
//   §1 NL-1 (one C file -> one TS file; basename verbatim — drive-snapshot.c
//            -> drive_snapshot.ts per §3 mapping row 15)
//   §1 NL-2 (one C function -> one TS function, snake_case names verbatim —
//            all 8 entry points present including the four image submodules)
//   §1 NL-5 (one C module-level global -> one TS module-level let/const;
//            drive_snapshot_log + the SNAP_MAJOR/MINOR triples kept)
//   §2 PL-1 (NO TS class wrapping a VICE struct — only module-scope state +
//            installed hook table)
//   §2 PL-3 (NO facades / managers / helpers — `vice1541Snapshot()` and
//            `vice1541Restore()` are EXPLICITLY out of scope of this file
//            per T2.14 acceptance; they belong on the kernel boundary
//            facade outside `vice1541/`)
//   §2 PL-5 (the snapshot_module_* infrastructure ported here is the
//            chunked-IO equivalent of vice/src/snapshot.c — explicitly
//            in-scope per T2.14 since it's the VICE binary format primitive
//            that the module functions need)
//   §2 PL-7 (no silent fallbacks — every -1 path matches VICE byte-for-byte)
//   §2 PL-9 (snapshot writes VICE-format module chunks: DRIVE<n>, IMAGE<n>,
//            NOIMAGE<n>, GCRIMAGE<n>, P64IMAGE<n>. NOT a flat blob.
//            NO `V1541SNP` magic. Per-module name + version per VICE.)
//   §5 FM-block on every export
//
// Mapping rationale per VICE drive-snapshot.c structure:
//   * `drive_snapshot_write_module` / `drive_snapshot_read_module` walk all
//     four disk units, write the DRIVE<n> chunk with per-unit drive_t
//     fields (verbatim drive-snapshot.c:209-272), then delegate to
//     `drivecpu_snapshot_write_module` (T2.4) and `driverom_snapshot_write`
//     (T2.9), and finally write one of the three image module families.
//   * `drive_snapshot_write_image_module` / `_read_image_module` handle the
//     `IMAGE<n>` / `NOIMAGE<n>` modules for sector-encoded D-images
//     (D81/D80/D82/D90). Sector bytes streamed via the host hooks
//     `disk_image_read_sector` / `disk_image_write_sector`.
//   * `drive_snapshot_write_gcrimage_module` / `_read_gcrimage_module`
//     write the `GCRIMAGE<n>` module by serialising every half-track of
//     `drive->gcr->tracks[]` with its per-track size header.
//   * `drive_snapshot_write_p64image_module` / `_read_p64image_module` are
//     PORT-STUBs per Spec 612 §10 (P64 out of scope, PAL-only). They throw
//     with the marker per PL-7 (no silent success).
//   * Host hooks (Spec 612 §2 PL-3 boundary): the per-process snapshot IO
//     primitives (snapshot_module_create / SMW_BA / SMR_DW / ...) live in
//     vice/src/snapshot.c. That is NOT a drive-side file, so this port keeps
//     the same install-hook pattern used by drivecpu.ts and driverom.ts:
//     the host wires the real implementation once at startup. No closure
//     capture, no class methods — just a module-scope `g_hooks` record.
//   * `diskunit_context[]` is owned by drivesync.ts (per the existing
//     vice1541/ layout). To stay consistent with driverom.ts (which uses
//     the same provider pattern to avoid a circular import) we accept a
//     `diskunit_context` provider hook rather than importing the array.

import type {
  diskunit_context_t,
  drive_t,
  disk_image_t,
  snapshot_t,
  ClockRef,
} from "./drivetypes.js";
import {
  NUM_DISK_UNITS,
  DRIVE_HALFTRACKS_1571,
  DRIVE_PC_NUM,
  MAX_GCR_TRACKS,
  NUM_MAX_MEM_BYTES_TRACK,
  DRIVE_TYPE_NONE,
  DRIVE_TYPE_1540,
  DRIVE_TYPE_1541,
  DRIVE_TYPE_1541II,
  DRIVE_TYPE_1551,
  DRIVE_TYPE_1570,
  DRIVE_TYPE_1571,
  DRIVE_TYPE_1571CR,
  DRIVE_TYPE_1581,
  DRIVE_TYPE_2000,
  DRIVE_TYPE_4000,
  DRIVE_TYPE_CMDHD,
  DRIVE_TYPE_2031,
  DRIVE_TYPE_1001,
  DRIVE_TYPE_2040,
  DRIVE_TYPE_3040,
  DRIVE_TYPE_4040,
  DRIVE_TYPE_8050,
  DRIVE_TYPE_8250,
  DRIVE_TYPE_9000,
} from "./drivetypes.js";
import {
  drivecpu_snapshot_write_module,
  drivecpu_snapshot_read_module,
  type snapshot_module_t,
} from "./drivecpu.js";
import {
  driverom_snapshot_write,
  driverom_snapshot_read,
} from "./driverom.js";
import {
  rotation_table_get,
  rotation_table_set,
} from "./rotation.js";
// driveimage.ts owns `drive_gcr_data_writeback_all` per the Spec 612 §3
// mapping (drive.c lifecycle helpers fold into drive.ts later, but the
// writeback walker is currently exported from driveimage.ts).
// Until drive.ts (T2.10) lands, we read the walker through a host hook so
// this file does not anticipate the move.

// =============================================================================
// SECTION 1 — module-level state (NL-5)
// =============================================================================

// PORT OF: vice/src/drive/drive-snapshot.c:69 (static log_t drive_snapshot_log)
// VICE: `static log_t drive_snapshot_log = LOG_DEFAULT;`
let drive_snapshot_log = 0;
void drive_snapshot_log;

// PORT OF: vice/src/drive/drive-snapshot.c:159-160 (DRIVE_SNAP_MAJOR / _MINOR)
const DRIVE_SNAP_MAJOR = 2;
const DRIVE_SNAP_MINOR = 0;

// PORT OF: vice/src/drive/drive-snapshot.c:644-645 (IMAGE_SNAP_MAJOR / _MINOR)
const IMAGE_SNAP_MAJOR = 1;
const IMAGE_SNAP_MINOR = 0;

// PORT OF: vice/src/drive/drive-snapshot.c:857-858 (GCRIMAGE_SNAP_MAJOR / _MINOR)
const GCRIMAGE_SNAP_MAJOR = 3;
const GCRIMAGE_SNAP_MINOR = 1;

// PORT OF: vice/src/drive/drive-snapshot.c:992-993 (P64IMAGE_SNAP_MAJOR / _MINOR)
const P64IMAGE_SNAP_MAJOR = 1;
const P64IMAGE_SNAP_MINOR = 0;
void P64IMAGE_SNAP_MAJOR;
void P64IMAGE_SNAP_MINOR;

// VICE drive-snapshot.c uses `D81_FILE_SIZE` / `D80_FILE_SIZE` / `D82_FILE_SIZE`
// from diskconstants.h. Same names, same values.
/** diskconstants.h:64 — D81 disk image bytes (80 tracks × 40 sectors × 256). */
const D81_FILE_SIZE = 819200;
/** diskconstants.h:62 — D80 disk image bytes (77 tracks × variable sectors). */
const D80_FILE_SIZE = 533248;
/** diskconstants.h:63 — D82 disk image bytes (D80 × 2). */
const D82_FILE_SIZE = 1066496;

// MAX_TRACKS_1571 from diskconstants.h:35. Used by write_gcrimage_module to
// size num_half_tracks = MAX_TRACKS_1571 * 2.
const MAX_TRACKS_1571 = 70;

// =============================================================================
// SECTION 2 — host hooks (PL-3 boundary; pattern matches drivecpu/driverom)
// =============================================================================

/** Provider for the `diskunit_context[]` array (matches drivesync.ts).
 *  PL-3-boundary hook: drivesync.ts owns the array; this file reads it
 *  through a provider to avoid a layered import cycle. */
export type diskunit_context_provider_t = () => readonly (diskunit_context_t | null)[];

/** PL-9 host hooks — the VICE-format chunked-IO primitives plus the small
 *  set of lifecycle helpers that drive-snapshot.c calls into
 *  (file_system_*, parallel_cable_drive_write, resources_*,
 *  machine_drive_*, vdrive_snapshot_*, drive_*). All host wiring matches
 *  the VICE C-function names verbatim. */
export interface drive_snapshot_host_hooks_t {
  // ---- diskunit_context array provider ----
  diskunit_context: diskunit_context_provider_t;

  // ---- snapshot.c primitives (chunked module IO) ----
  snapshot_module_create: (
    s: snapshot_t,
    name: string,
    major: number,
    minor: number,
  ) => snapshot_module_t | null;
  snapshot_module_open: (
    s: snapshot_t,
    name: string,
  ) => { module: snapshot_module_t; major: number; minor: number } | null;
  snapshot_module_close: (m: snapshot_module_t) => number;
  snapshot_version_is_bigger: (
    maj: number,
    min: number,
    ref_maj: number,
    ref_min: number,
  ) => boolean;
  snapshot_version_is_smaller: (
    maj: number,
    min: number,
    ref_maj: number,
    ref_min: number,
  ) => boolean;
  snapshot_set_error: (code: number) => void;

  // ---- SMW / SMR primitives ----
  SMW_B: (m: snapshot_module_t, v: number) => number;
  SMW_W: (m: snapshot_module_t, v: number) => number;
  SMW_DW: (m: snapshot_module_t, v: number) => number;
  SMW_CLOCK: (m: snapshot_module_t, v: number) => number;
  SMW_BA: (m: snapshot_module_t, buf: Uint8Array, len: number) => number;
  SMR_B: (m: snapshot_module_t) => { ok: boolean; v: number };
  SMR_B_INT: (m: snapshot_module_t) => { ok: boolean; v: number };
  SMR_W: (m: snapshot_module_t) => { ok: boolean; v: number };
  SMR_W_INT: (m: snapshot_module_t) => { ok: boolean; v: number };
  SMR_DW: (m: snapshot_module_t) => { ok: boolean; v: number };
  SMR_DW_INT: (m: snapshot_module_t) => { ok: boolean; v: number };
  SMR_DW_UINT: (m: snapshot_module_t) => { ok: boolean; v: number };
  SMR_DW_UL: (m: snapshot_module_t) => { ok: boolean; v: number };
  SMR_CLOCK: (m: snapshot_module_t, ref: ClockRef) => number;
  SMR_BA: (m: snapshot_module_t, buf: Uint8Array, len: number) => number;

  // ---- vdrive snapshot bookends ----
  vdrive_snapshot_module_write: (s: snapshot_t) => number;
  vdrive_snapshot_module_read: (s: snapshot_t) => number;

  // ---- machine-side lifecycle ----
  machine_drive_snapshot_write: (drv: diskunit_context_t, s: snapshot_t) => number;
  machine_drive_snapshot_read: (drv: diskunit_context_t, s: snapshot_t) => number;
  machine_drive_rom_setup_image: (dnr: number) => void;
  machine_bus_status_drivetype_set: (devnr: number, on: number) => void;

  // ---- drive-c helpers (drive_init / drive_enable / drive_disable /
  //      drive_set_half_track / drive_set_active_led_color /
  //      drive_gcr_data_writeback_all / drive_is_dualdrive_by_devnr /
  //      drive_update_ui_status / drive_sound_stop) ----
  drive_enable: (drv: diskunit_context_t) => number;
  drive_disable: (drv: diskunit_context_t) => void;
  drive_set_active_led_color: (type: number, dnr: number) => void;
  drive_set_half_track: (num: number, side: number, drive: drive_t) => void;
  drive_gcr_data_writeback_all: () => void;
  drive_is_dualdrive_by_devnr: (devnr: number) => boolean;
  drive_update_ui_status: () => void;
  drive_sound_stop: () => void;

  // ---- iec / parallel ----
  iec_update_ports_embedded: () => void;
  parallel_cable_drive_write: (
    cable: number,
    byte: number,
    mode: number,
    dnr: number,
  ) => void;

  // ---- drivemem / driverom traps ----
  drivemem_init: (drv: diskunit_context_t) => void;
  driverom_initialize_traps: (drv: diskunit_context_t) => void;

  // ---- file_system attach / detach + zfile_close_action ----
  file_system_attach_disk: (devnr: number, drive: number, name: string) => number;
  file_system_detach_disk: (devnr: number, drive: number) => void;
  zfile_close_action: (name: string, action: number, request: string) => void;

  // ---- resources_get_int / resources_set_int (sprintf variants kept
  //      identical to VICE — the format string is the literal C format) ----
  resources_get_int: (name: string) => { ok: boolean; v: number };
  resources_set_int: (name: string, value: number) => number;
  resources_get_int_sprintf: (
    fmt: string,
    devnr: number,
  ) => { ok: boolean; v: number };
  resources_set_int_sprintf: (
    fmt: string,
    value: number,
    devnr: number,
  ) => number;

  // ---- disk_image_read_sector / _write_sector (for IMAGE<n> module) ----
  disk_image_read_sector: (
    image: disk_image_t,
    buf: Uint8Array,
    track: number,
    sector: number,
  ) => number;
  disk_image_write_sector: (
    image: disk_image_t,
    buf: Uint8Array,
    track: number,
    sector: number,
  ) => number;

  // ---- archdep_mkstemp_fd (returns temp filename for image attach) ----
  archdep_mkstemp_fd: (lenBytes: number) => string | null;

  // ---- snapshot.h error codes ----
  SNAPSHOT_MODULE_HIGHER_VERSION: number;
  SNAPSHOT_MODULE_INCOMPATIBLE: number;

  // ---- parallel.h modes ----
  PARALLEL_WRITE: number;

  // ---- zfile actions ----
  ZFILE_REQUEST: number;

  // ---- log_error / log_message ----
  log_error: (log: number, fmt: string, ...args: unknown[]) => void;
}

// PL-7: error-loud defaults so any missing wiring is visible immediately
// instead of silently passing. Used when the host hasn't installed hooks.
let g_hooks: drive_snapshot_host_hooks_t = {
  diskunit_context: () => [],
  snapshot_module_create: () => null,
  snapshot_module_open: () => null,
  snapshot_module_close: () => 0,
  snapshot_version_is_bigger: () => false,
  snapshot_version_is_smaller: () => false,
  snapshot_set_error: () => { /* no-op */ },
  SMW_B: () => 0,
  SMW_W: () => 0,
  SMW_DW: () => 0,
  SMW_CLOCK: () => 0,
  SMW_BA: () => 0,
  SMR_B: () => ({ ok: false, v: 0 }),
  SMR_B_INT: () => ({ ok: false, v: 0 }),
  SMR_W: () => ({ ok: false, v: 0 }),
  SMR_W_INT: () => ({ ok: false, v: 0 }),
  SMR_DW: () => ({ ok: false, v: 0 }),
  SMR_DW_INT: () => ({ ok: false, v: 0 }),
  SMR_DW_UINT: () => ({ ok: false, v: 0 }),
  SMR_DW_UL: () => ({ ok: false, v: 0 }),
  SMR_CLOCK: () => -1,
  SMR_BA: () => -1,
  vdrive_snapshot_module_write: () => 0,
  vdrive_snapshot_module_read: () => 0,
  machine_drive_snapshot_write: () => 0,
  machine_drive_snapshot_read: () => 0,
  machine_drive_rom_setup_image: () => { /* no-op */ },
  machine_bus_status_drivetype_set: () => { /* no-op */ },
  drive_enable: () => 0,
  drive_disable: () => { /* no-op */ },
  drive_set_active_led_color: () => { /* no-op */ },
  drive_set_half_track: () => { /* no-op */ },
  drive_gcr_data_writeback_all: () => { /* no-op */ },
  drive_is_dualdrive_by_devnr: () => false,
  drive_update_ui_status: () => { /* no-op */ },
  drive_sound_stop: () => { /* no-op */ },
  iec_update_ports_embedded: () => { /* no-op */ },
  parallel_cable_drive_write: () => { /* no-op */ },
  drivemem_init: () => { /* no-op */ },
  driverom_initialize_traps: () => { /* no-op */ },
  file_system_attach_disk: () => -1,
  file_system_detach_disk: () => { /* no-op */ },
  zfile_close_action: () => { /* no-op */ },
  resources_get_int: () => ({ ok: false, v: 0 }),
  resources_set_int: () => 0,
  resources_get_int_sprintf: () => ({ ok: false, v: 0 }),
  resources_set_int_sprintf: () => 0,
  disk_image_read_sector: () => -1,
  disk_image_write_sector: () => -1,
  archdep_mkstemp_fd: () => null,
  SNAPSHOT_MODULE_HIGHER_VERSION: -1,
  SNAPSHOT_MODULE_INCOMPATIBLE: -1,
  PARALLEL_WRITE: 0,
  ZFILE_REQUEST: 0,
  log_error: () => { /* no-op */ },
};

// PORT OF: vice/src/drive/drive-snapshot.c (host-facility wiring shim — Spec
//          612 §2 PL-3 boundary, NOT in the C source). Installs the
//          snapshot.c / drive.c / machine_drive.c / vdrive.c bridges the
//          drive_snapshot_* functions need. Called once by the host at
//          startup (kernel boot or test fixture setup).
export function drive_snapshot_install_hooks(
  hooks: drive_snapshot_host_hooks_t,
): void {
  g_hooks = hooks;
}

// =============================================================================
// SECTION 3 — drive_snapshot_write_module (drive-snapshot.c:162-354)
// =============================================================================

// PORT OF: vice/src/drive/drive-snapshot.c:162-354 (drive_snapshot_write_module)
//   int drive_snapshot_write_module(snapshot_t *s, int save_disks, int save_roms)
export function drive_snapshot_write_module(
  s: snapshot_t,
  save_disks: number,
  save_roms: number,
): number {
  // VICE local arrays per drive-snapshot.c:167-172
  const rotation_table_ptr = new Uint32Array(NUM_DISK_UNITS);
  const has_tde = new Array<number>(NUM_DISK_UNITS).fill(0);
  const has_drives = new Array<number>(NUM_DISK_UNITS).fill(0);
  let sync_factor = 0;

  // drive-snapshot.c:174-177 — write vdrive info first
  if (g_hooks.vdrive_snapshot_module_write(s) < 0) {
    return -1;
  }

  // drive-snapshot.c:179-180
  g_hooks.drive_gcr_data_writeback_all();

  // rotation_table_get fills the per-unit offsets into a flat uint32 array
  // — match the VICE signature (out-param). The TS port of rotation_table_get
  // (rotation.ts) takes the diskunit_context array as an explicit arg, so
  // adapt: VICE passes a single uint32_t* of length NUM_DISK_UNITS. We back
  // it with the Uint32Array allocated above.
  rotation_table_get(rotation_table_ptr, g_hooks.diskunit_context());

  const units = g_hooks.diskunit_context();

  for (let unr = 0; unr < NUM_DISK_UNITS; unr++) {
    const unit = units[unr];
    if (unit === null || unit === undefined) {
      // VICE always indexes a non-null array; in TS we may have null
      // placeholders. Skip with the same shape as VICE would emit — write
      // a stub DRIVE<n> chunk with has_tde=0 to keep snapshot symmetry.
      const stubName = `DRIVE${8 + unr}`;
      const stubM = g_hooks.snapshot_module_create(
        s, stubName, DRIVE_SNAP_MAJOR & 0xff, DRIVE_SNAP_MINOR & 0xff,
      );
      if (stubM === null) return -1;
      if (
        g_hooks.SMW_B(stubM, 0) < 0 ||  // has_tde
        g_hooks.SMW_B(stubM, 0) < 0     // has_drives
      ) {
        g_hooks.snapshot_module_close(stubM);
        return -1;
      }
      if (g_hooks.snapshot_module_close(stubM) < 0) return -1;
      continue;
    }

    // drive-snapshot.c:186-187 — DRIVE<unr+8> chunk
    const snap_module_name = `DRIVE${8 + unr}`;
    const m = g_hooks.snapshot_module_create(
      s, snap_module_name,
      DRIVE_SNAP_MAJOR & 0xff,
      DRIVE_SNAP_MINOR & 0xff,
    );
    if (m === null) return -1;

    // drive-snapshot.c:192-194
    has_drives[unr] = g_hooks.drive_is_dualdrive_by_devnr(unr + 8) ? 2 : 1;
    const tdeRes = g_hooks.resources_get_int_sprintf(
      "Drive%iTrueEmulation", unr + 8,
    );
    has_tde[unr] = tdeRes.ok ? tdeRes.v : 0;

    if (
      g_hooks.SMW_B(m, has_tde[unr]! & 0xff) < 0 ||
      g_hooks.SMW_B(m, has_drives[unr]! & 0xff) < 0
    ) {
      g_hooks.snapshot_module_close(m);
      return -1;
    }

    if (has_tde[unr]) {
      // drive-snapshot.c:212-218 — MachineVideoStandard goes into the drive
      // snapshot (VICE FIXME comment preserved as a note).
      const sv = g_hooks.resources_get_int("MachineVideoStandard");
      sync_factor = sv.ok ? sv.v : 0;
      if (g_hooks.SMW_DW(m, sync_factor >>> 0) < 0) {
        g_hooks.snapshot_module_close(m);
        return -1;
      }

      for (let dnr = 0; dnr < has_drives[unr]!; dnr++) {
        const drive = unit.drives[dnr];
        if (drive === null || drive === undefined) {
          g_hooks.snapshot_module_close(m);
          return -1;
        }

        if (
          // drive-snapshot.c:224-238 — base fields
          g_hooks.SMW_CLOCK(m, drive.attach_clk) < 0 ||
          g_hooks.SMW_B(m, drive.byte_ready_level & 0xff) < 0 ||
          g_hooks.SMW_B(m, unit.clock_frequency & 0xff) < 0 ||
          g_hooks.SMW_W(m,
            (drive.current_half_track + drive.side * DRIVE_HALFTRACKS_1571) & 0xffff,
          ) < 0 ||
          g_hooks.SMW_CLOCK(m, drive.detach_clk) < 0 ||
          g_hooks.SMW_B(m, drive.extend_image_policy & 0xff) < 0 ||
          g_hooks.SMW_DW(m, drive.GCR_head_offset >>> 0) < 0 ||
          g_hooks.SMW_B(m, drive.GCR_read & 0xff) < 0 ||
          g_hooks.SMW_B(m, drive.GCR_write_value & 0xff) < 0 ||
          g_hooks.SMW_B(m, unit.idling_method & 0xff) < 0 ||
          g_hooks.SMW_B(m, unit.parallel_cable & 0xff) < 0 ||
          g_hooks.SMW_B(m, drive.read_only & 0xff) < 0 ||
          g_hooks.SMW_DW(m, rotation_table_ptr[unr]! >>> 0) < 0 ||
          g_hooks.SMW_DW(m, unit.type >>> 0) < 0 ||

          // drive-snapshot.c:240-265 — rotation snap_* fields
          g_hooks.SMW_DW(m, drive.snap_accum >>> 0) < 0 ||
          g_hooks.SMW_CLOCK(m, drive.snap_rotation_last_clk) < 0 ||
          g_hooks.SMW_DW(m, drive.snap_bit_counter >>> 0) < 0 ||
          g_hooks.SMW_DW(m, drive.snap_zero_count >>> 0) < 0 ||
          g_hooks.SMW_W(m, drive.snap_last_read_data & 0xffff) < 0 ||
          g_hooks.SMW_B(m, drive.snap_last_write_data & 0xff) < 0 ||
          // NOTE: drive-snapshot.c:247 uses SMW_DW with a uint8_t cast — a
          // known VICE quirk. We preserve the 4-byte width to stay binary
          // compatible with VICE-emitted snapshots.
          g_hooks.SMW_DW(m, drive.snap_seed >>> 0) < 0 ||
          g_hooks.SMW_DW(m, drive.snap_speed_zone >>> 0) < 0 ||
          g_hooks.SMW_DW(m, drive.snap_ue7_dcba >>> 0) < 0 ||
          g_hooks.SMW_DW(m, drive.snap_ue7_counter >>> 0) < 0 ||
          g_hooks.SMW_DW(m, drive.snap_uf4_counter >>> 0) < 0 ||
          g_hooks.SMW_DW(m, drive.snap_fr_randcount >>> 0) < 0 ||
          g_hooks.SMW_DW(m, drive.snap_filter_counter >>> 0) < 0 ||
          g_hooks.SMW_DW(m, drive.snap_filter_state >>> 0) < 0 ||
          g_hooks.SMW_DW(m, drive.snap_filter_last_state >>> 0) < 0 ||
          g_hooks.SMW_DW(m, drive.snap_write_flux >>> 0) < 0 ||
          g_hooks.SMW_DW(m, drive.snap_PulseHeadPosition >>> 0) < 0 ||
          g_hooks.SMW_DW(m, drive.snap_xorShift32 >>> 0) < 0 ||
          g_hooks.SMW_DW(m, drive.snap_so_delay >>> 0) < 0 ||
          g_hooks.SMW_DW(m, drive.snap_cycle_index >>> 0) < 0 ||
          g_hooks.SMW_CLOCK(m, drive.snap_ref_advance) < 0 ||
          g_hooks.SMW_DW(m, drive.snap_req_ref_cycles >>> 0) < 0 ||
          g_hooks.SMW_CLOCK(m, drive.attach_detach_clk) < 0 ||
          g_hooks.SMW_B(m, drive.byte_ready_edge & 0xff) < 0 ||
          g_hooks.SMW_B(m, drive.byte_ready_active & 0xff) < 0
        ) {
          g_hooks.snapshot_module_close(m);
          return -1;
        }
      }
    }

    if (g_hooks.snapshot_module_close(m) < 0) {
      return -1;
    }
  }

  // drive-snapshot.c:281-305 — save state of drive CPUs
  for (let unr = 0; unr < NUM_DISK_UNITS; unr++) {
    if (!has_tde[unr]) continue;
    const unit = units[unr];
    if (unit === null || unit === undefined) continue;
    if (unit.enable) {
      // VICE drive-snapshot.c:288-299: branch on drive type for 65c02
      // variants (2000 / 4000 / CMDHD). 1541 path uses drivecpu_snapshot_*.
      // Per Spec 612 §10 only the 1541-family path is in scope; for the
      // 65c02 variants we fall back to the same hook (drivecpu65c02 is not
      // in the §3 mapping table — out of scope for the 1541 rebuild).
      if (
        unit.type === DRIVE_TYPE_2000 ||
        unit.type === DRIVE_TYPE_4000 ||
        unit.type === DRIVE_TYPE_CMDHD
      ) {
        // PORT-STUB: drivecpu65c02_snapshot_write_module is out of scope per
        // Spec 612 §10 — caller should not enable these drive types from
        // the 1541 facade. Match VICE's contract (returns -1 on failure).
        return -1;
      } else {
        if (drivecpu_snapshot_write_module(unit, s) < 0) {
          return -1;
        }
      }
      if (g_hooks.machine_drive_snapshot_write(unit, s) < 0) {
        return -1;
      }
    }
  }

  // drive-snapshot.c:308-336 — put disk images to snapshot
  if (save_disks) {
    for (let unr = 0; unr < NUM_DISK_UNITS; unr++) {
      if (!has_tde[unr]) continue;
      const unit = units[unr];
      if (unit === null || unit === undefined) continue;
      for (let dnr = 0; dnr < has_drives[unr]!; dnr++) {
        const drive = unit.drives[dnr];
        if (drive === null || drive === undefined) continue;

        if (drive.GCR_image_loaded > 0) {
          if (drive_snapshot_write_gcrimage_module(s, unr) < 0) {
            return -1;
          }
        } else if (drive.P64_image_loaded > 0) {
          if (drive_snapshot_write_p64image_module(s, unr) < 0) {
            return -1;
          }
        } else {
          if (drive_snapshot_write_image_module(s, unr) < 0) {
            return -1;
          }
        }
      }
    }
  }

  // drive-snapshot.c:338-351 — put drive roms to snapshot
  for (let unr = 0; unr < NUM_DISK_UNITS; unr++) {
    if (!has_tde[unr]) continue;
    const unit = units[unr];
    if (unit === null || unit === undefined) continue;
    const drive = unit.drives[0];
    if (drive === null || drive === undefined) continue;
    if (save_roms && unit.enable) {
      if (driverom_snapshot_write(s, drive) < 0) {
        return -1;
      }
    }
  }

  return 0;
}

// =============================================================================
// SECTION 4 — drive_snapshot_read_module (drive-snapshot.c:356-639)
// =============================================================================

// PORT OF: vice/src/drive/drive-snapshot.c:356-639 (drive_snapshot_read_module)
//   int drive_snapshot_read_module(snapshot_t *s)
export function drive_snapshot_read_module(s: snapshot_t): number {
  const rotation_table_ptr = new Uint32Array(NUM_DISK_UNITS);
  const has_tde = new Array<number>(NUM_DISK_UNITS).fill(0);
  const attach_clk = new Array<number>(NUM_DISK_UNITS).fill(0);
  const detach_clk = new Array<number>(NUM_DISK_UNITS).fill(0);
  const attach_detach_clk = new Array<number>(NUM_DISK_UNITS).fill(0);
  let sync_factor = 0;
  const half_track = new Array<number>(NUM_DISK_UNITS).fill(0);
  const has_drives = new Array<number>(NUM_DISK_UNITS).fill(0);

  // drive-snapshot.c:373
  g_hooks.drive_gcr_data_writeback_all();

  const units = g_hooks.diskunit_context();

  for (let unr = 0; unr < NUM_DISK_UNITS; unr++) {
    const unit = units[unr];

    // drive-snapshot.c:379-380 — open the DRIVE<n> module
    const snap_module_name = `DRIVE${8 + unr}`;
    const open = g_hooks.snapshot_module_open(s, snap_module_name);
    if (open === null) {
      // drive-snapshot.c:381-387 — module absent => true emulation is off
      g_hooks.resources_set_int_sprintf(
        "Drive%iTrueEmulation", 0, unr + 8,
      );
      has_tde[unr] = 0;
      continue;
    }
    const m = open.module;
    const major_version = open.major;
    const minor_version = open.minor;

    // drive-snapshot.c:389-401 — version checks
    if (g_hooks.snapshot_version_is_bigger(
      major_version, minor_version, DRIVE_SNAP_MAJOR, DRIVE_SNAP_MINOR,
    )) {
      g_hooks.snapshot_set_error(g_hooks.SNAPSHOT_MODULE_HIGHER_VERSION);
      g_hooks.snapshot_module_close(m);
      return -1;
    }
    if (g_hooks.snapshot_version_is_smaller(
      major_version, minor_version, DRIVE_SNAP_MAJOR, DRIVE_SNAP_MINOR,
    )) {
      g_hooks.snapshot_set_error(g_hooks.SNAPSHOT_MODULE_INCOMPATIBLE);
      g_hooks.snapshot_module_close(m);
      return -1;
    }

    // drive-snapshot.c:403-409
    const tdeR = g_hooks.SMR_B_INT(m);
    const drvCntR = g_hooks.SMR_B_INT(m);
    if (!tdeR.ok || !drvCntR.ok) {
      g_hooks.snapshot_module_close(m);
      return -1;
    }
    has_tde[unr] = tdeR.v;
    has_drives[unr] = drvCntR.v;
    g_hooks.resources_set_int_sprintf(
      "Drive%iTrueEmulation", has_tde[unr]!, unr + 8,
    );

    if (has_tde[unr]) {
      // drive-snapshot.c:417-421 — sync_factor
      const syncR = g_hooks.SMR_DW_INT(m);
      if (!syncR.ok) {
        g_hooks.snapshot_module_close(m);
        return -1;
      }
      sync_factor = syncR.v;

      for (let dnr = 0; dnr < has_drives[unr]!; dnr++) {
        if (unit === null || unit === undefined) {
          g_hooks.snapshot_module_close(m);
          return -1;
        }
        const drive = unit.drives[dnr];
        if (drive === null || drive === undefined) {
          g_hooks.snapshot_module_close(m);
          return -1;
        }

        // drive-snapshot.c:428-469 — base fields then snap_* rotation
        const attachRef: ClockRef = { value: 0 };
        const detachRef: ClockRef = { value: 0 };
        const attachDetachRef: ClockRef = { value: 0 };
        const snapRotLastRef: ClockRef = { value: 0 };
        const snapRefAdvRef: ClockRef = { value: 0 };

        if (g_hooks.SMR_CLOCK(m, attachRef) < 0) {
          g_hooks.snapshot_module_close(m); return -1;
        }
        attach_clk[unr] = attachRef.value;

        const brLevelR = g_hooks.SMR_B_INT(m);
        const clkFreqR = g_hooks.SMR_B_INT(m);
        const htR = g_hooks.SMR_W_INT(m);
        if (!brLevelR.ok || !clkFreqR.ok || !htR.ok) {
          g_hooks.snapshot_module_close(m); return -1;
        }
        drive.byte_ready_level = brLevelR.v;
        unit.clock_frequency = clkFreqR.v;
        half_track[unr] = htR.v;

        if (g_hooks.SMR_CLOCK(m, detachRef) < 0) {
          g_hooks.snapshot_module_close(m); return -1;
        }
        detach_clk[unr] = detachRef.value;

        const extR = g_hooks.SMR_B_INT(m);
        const gcrHoR = g_hooks.SMR_DW_UINT(m);
        const gcrReadR = g_hooks.SMR_B(m);
        const gcrWvR = g_hooks.SMR_B(m);
        const idleR = g_hooks.SMR_B_INT(m);
        const parR = g_hooks.SMR_B_INT(m);
        const roR = g_hooks.SMR_B_INT(m);
        const rotPtrR = g_hooks.SMR_DW(m);
        const typeR = g_hooks.SMR_DW_UINT(m);

        if (
          !extR.ok || !gcrHoR.ok || !gcrReadR.ok || !gcrWvR.ok ||
          !idleR.ok || !parR.ok || !roR.ok || !rotPtrR.ok || !typeR.ok
        ) {
          g_hooks.snapshot_module_close(m); return -1;
        }
        drive.extend_image_policy = extR.v;
        drive.GCR_head_offset = gcrHoR.v >>> 0;
        drive.GCR_read = gcrReadR.v & 0xff;
        drive.GCR_write_value = gcrWvR.v & 0xff;
        unit.idling_method = idleR.v;
        unit.parallel_cable = parR.v;
        drive.read_only = roR.v;
        rotation_table_ptr[unr] = rotPtrR.v >>> 0;
        unit.type = typeR.v >>> 0;

        // drive-snapshot.c:444-468 — snap_* rotation fields
        const snapAccumR = g_hooks.SMR_DW_UL(m);
        if (g_hooks.SMR_CLOCK(m, snapRotLastRef) < 0) {
          g_hooks.snapshot_module_close(m); return -1;
        }
        const bitCntR = g_hooks.SMR_DW_INT(m);
        const zeroCntR = g_hooks.SMR_DW_INT(m);
        const snapLastReadR = g_hooks.SMR_W_INT(m);
        const snapLastWriteR = g_hooks.SMR_B(m);
        const snapSeedR = g_hooks.SMR_DW_INT(m);
        const snapZoneR = g_hooks.SMR_DW(m);
        const snapUe7DcbaR = g_hooks.SMR_DW(m);
        const snapUe7CntR = g_hooks.SMR_DW(m);
        const snapUf4CntR = g_hooks.SMR_DW(m);
        const snapFrRandR = g_hooks.SMR_DW(m);
        const snapFiltCntR = g_hooks.SMR_DW(m);
        const snapFiltStR = g_hooks.SMR_DW(m);
        const snapFiltLastR = g_hooks.SMR_DW(m);
        const snapWriteFluxR = g_hooks.SMR_DW(m);
        const snapPulseHpR = g_hooks.SMR_DW(m);
        const snapXorShiftR = g_hooks.SMR_DW(m);
        const snapSoDelayR = g_hooks.SMR_DW(m);
        const snapCycleIdxR = g_hooks.SMR_DW(m);
        if (g_hooks.SMR_CLOCK(m, snapRefAdvRef) < 0) {
          g_hooks.snapshot_module_close(m); return -1;
        }
        const snapReqRefR = g_hooks.SMR_DW(m);
        if (g_hooks.SMR_CLOCK(m, attachDetachRef) < 0) {
          g_hooks.snapshot_module_close(m); return -1;
        }
        attach_detach_clk[unr] = attachDetachRef.value;
        const brEdgeR = g_hooks.SMR_B_INT(m);
        const brActiveR = g_hooks.SMR_B_INT(m);

        if (
          !snapAccumR.ok || !bitCntR.ok || !zeroCntR.ok ||
          !snapLastReadR.ok || !snapLastWriteR.ok || !snapSeedR.ok ||
          !snapZoneR.ok || !snapUe7DcbaR.ok || !snapUe7CntR.ok ||
          !snapUf4CntR.ok || !snapFrRandR.ok || !snapFiltCntR.ok ||
          !snapFiltStR.ok || !snapFiltLastR.ok || !snapWriteFluxR.ok ||
          !snapPulseHpR.ok || !snapXorShiftR.ok || !snapSoDelayR.ok ||
          !snapCycleIdxR.ok || !snapReqRefR.ok ||
          !brEdgeR.ok || !brActiveR.ok
        ) {
          g_hooks.snapshot_module_close(m); return -1;
        }

        drive.snap_accum = snapAccumR.v >>> 0;
        drive.snap_rotation_last_clk = snapRotLastRef.value;
        drive.snap_bit_counter = bitCntR.v | 0;
        drive.snap_zero_count = zeroCntR.v | 0;
        drive.snap_last_read_data = snapLastReadR.v & 0xffff;
        drive.snap_last_write_data = snapLastWriteR.v & 0xff;
        drive.snap_seed = snapSeedR.v | 0;
        drive.snap_speed_zone = snapZoneR.v >>> 0;
        drive.snap_ue7_dcba = snapUe7DcbaR.v >>> 0;
        drive.snap_ue7_counter = snapUe7CntR.v >>> 0;
        drive.snap_uf4_counter = snapUf4CntR.v >>> 0;
        drive.snap_fr_randcount = snapFrRandR.v >>> 0;
        drive.snap_filter_counter = snapFiltCntR.v >>> 0;
        drive.snap_filter_state = snapFiltStR.v >>> 0;
        drive.snap_filter_last_state = snapFiltLastR.v >>> 0;
        drive.snap_write_flux = snapWriteFluxR.v >>> 0;
        drive.snap_PulseHeadPosition = snapPulseHpR.v >>> 0;
        drive.snap_xorShift32 = snapXorShiftR.v >>> 0;
        drive.snap_so_delay = snapSoDelayR.v >>> 0;
        drive.snap_cycle_index = snapCycleIdxR.v >>> 0;
        drive.snap_ref_advance = snapRefAdvRef.value;
        drive.snap_req_ref_cycles = snapReqRefR.v >>> 0;
        drive.byte_ready_edge = brEdgeR.v;
        drive.byte_ready_active = brActiveR.v;
      }
    }
    g_hooks.snapshot_module_close(m);
  }

  // drive-snapshot.c:480
  rotation_table_set(rotation_table_ptr, units);

  // drive-snapshot.c:482-521 — per-unit enable / type dispatch
  for (let unr = 0; unr < NUM_DISK_UNITS; unr++) {
    if (!has_tde[unr]) continue;
    const unit = units[unr];
    if (unit === null || unit === undefined) continue;

    switch (unit.type) {
      case DRIVE_TYPE_1540:
      case DRIVE_TYPE_1541:
      case DRIVE_TYPE_1541II:
      case DRIVE_TYPE_1551:
      case DRIVE_TYPE_1570:
      case DRIVE_TYPE_1571:
      case DRIVE_TYPE_1571CR:
      case DRIVE_TYPE_1581:
      case DRIVE_TYPE_2000:
      case DRIVE_TYPE_4000:
      case DRIVE_TYPE_CMDHD:
      case DRIVE_TYPE_2031:
      case DRIVE_TYPE_1001:
      case DRIVE_TYPE_2040:
      case DRIVE_TYPE_3040:
      case DRIVE_TYPE_4040:
      case DRIVE_TYPE_8050:
      case DRIVE_TYPE_8250:
      case DRIVE_TYPE_9000:
        unit.enable = 1;
        g_hooks.machine_drive_rom_setup_image(unr);
        g_hooks.drivemem_init(unit);
        g_hooks.resources_set_int_sprintf(
          "Drive%iIdleMethod", unit.idling_method, unr + 8,
        );
        g_hooks.driverom_initialize_traps(unit);
        g_hooks.drive_set_active_led_color(unit.type, 0);
        g_hooks.machine_bus_status_drivetype_set(8 + unr, 1);
        break;
      case DRIVE_TYPE_NONE:
        g_hooks.drive_disable(unit);
        g_hooks.machine_bus_status_drivetype_set(8 + unr, 0);
        break;
      default:
        return -1;
    }
  }

  // drive-snapshot.c:524-528 — clear parallel cable
  for (let unr = 0; unr < DRIVE_PC_NUM; unr++) {
    g_hooks.parallel_cable_drive_write(unr, 0xff, g_hooks.PARALLEL_WRITE, 0);
    g_hooks.parallel_cable_drive_write(unr, 0xff, g_hooks.PARALLEL_WRITE, 1);
  }

  // drive-snapshot.c:530-554 — read drive CPUs
  for (let unr = 0; unr < NUM_DISK_UNITS; unr++) {
    if (!has_tde[unr]) continue;
    const unit = units[unr];
    if (unit === null || unit === undefined) continue;
    if (unit.enable) {
      if (
        unit.type === DRIVE_TYPE_2000 ||
        unit.type === DRIVE_TYPE_4000 ||
        unit.type === DRIVE_TYPE_CMDHD
      ) {
        // PORT-STUB: drivecpu65c02_snapshot_read_module out of scope per
        // Spec 612 §10.
        return -1;
      } else {
        if (drivecpu_snapshot_read_module(unit, s) < 0) {
          return -1;
        }
      }
      if (g_hooks.machine_drive_snapshot_read(unit, s) < 0) {
        return -1;
      }
    }
  }

  // drive-snapshot.c:556-571 — read image(s)
  for (let unr = 0; unr < NUM_DISK_UNITS; unr++) {
    if (!has_tde[unr]) continue;
    const unit = units[unr];
    if (unit === null || unit === undefined) continue;
    for (let dnr = 0; dnr < has_drives[unr]!; dnr++) {
      void dnr;
      if (
        drive_snapshot_read_image_module(s, unr) < 0 ||
        drive_snapshot_read_gcrimage_module(s, unr) < 0 ||
        drive_snapshot_read_p64image_module(s, unr) < 0
      ) {
        return -1;
      }
    }
  }

  // drive-snapshot.c:573-585 — read drive roms
  for (let unr = 0; unr < NUM_DISK_UNITS; unr++) {
    if (!has_tde[unr]) continue;
    const unit = units[unr];
    if (unit === null || unit === undefined) continue;
    const drive = unit.drives[0];
    if (drive === null || drive === undefined) continue;
    if (unit.enable) {
      if (driverom_snapshot_read(s, drive) < 0) {
        return -1;
      }
    }
  }

  // drive-snapshot.c:587-599 — re-enable
  for (let unr = 0; unr < NUM_DISK_UNITS; unr++) {
    const unit = units[unr];
    if (unit === null || unit === undefined) continue;
    const drive = unit.drives[0];
    if (drive === null || drive === undefined) continue;
    if (unit.type !== DRIVE_TYPE_NONE) {
      g_hooks.drive_enable(unit);
      drive.attach_clk = attach_clk[unr]!;
      drive.detach_clk = detach_clk[unr]!;
      drive.attach_detach_clk = attach_detach_clk[unr]!;
    }
  }

  // drive-snapshot.c:601-620 — set half track
  for (let unr = 0; unr < NUM_DISK_UNITS; unr++) {
    let side = 0;
    const unit = units[unr];
    if (unit === null || unit === undefined) continue;
    const drive = unit.drives[0];
    if (drive === null || drive === undefined) continue;
    if (has_tde[unr]) {
      if (
        unit.type === DRIVE_TYPE_1570 ||
        unit.type === DRIVE_TYPE_1571 ||
        unit.type === DRIVE_TYPE_1571CR
      ) {
        if (half_track[unr]! > DRIVE_HALFTRACKS_1571 + 1) {
          side = 1;
          half_track[unr] = half_track[unr]! - DRIVE_HALFTRACKS_1571;
        }
      }
      g_hooks.drive_set_half_track(half_track[unr]!, side, drive);
      g_hooks.resources_set_int("MachineVideoStandard", sync_factor);
    }
  }

  // drive-snapshot.c:622-630
  g_hooks.drive_sound_stop();
  g_hooks.iec_update_ports_embedded();
  g_hooks.drive_update_ui_status();

  // drive-snapshot.c:632-635
  if (g_hooks.vdrive_snapshot_module_read(s) < 0) {
    return -1;
  }

  return 0;
}

// =============================================================================
// SECTION 5 — drive_snapshot_write_image_module (drive-snapshot.c:656-713)
// =============================================================================

// PORT OF: vice/src/drive/drive-snapshot.c:656-713 (drive_snapshot_write_image_module)
//   static int drive_snapshot_write_image_module(snapshot_t *s, unsigned int dnr)
// Note: VICE marks this `static`. Per Spec 612 §1 NL-2 we still export it
// (it's an entry point per T2.14 acceptance and per the §6 FC-2 grep).
export function drive_snapshot_write_image_module(
  s: snapshot_t,
  dnr: number,
): number {
  const units = g_hooks.diskunit_context();
  const unit = units[dnr];
  if (unit === null || unit === undefined) return -1;
  const drive = unit.drives[0];
  if (drive === null || drive === undefined) return -1;

  // drive-snapshot.c:669-673
  let snap_module_name: string;
  if (drive.image === null || unit.type === DRIVE_TYPE_CMDHD) {
    snap_module_name = `NOIMAGE${dnr}`;
  } else {
    snap_module_name = `IMAGE${dnr}`;
  }

  const m = g_hooks.snapshot_module_create(
    s, snap_module_name,
    IMAGE_SNAP_MAJOR & 0xff,
    IMAGE_SNAP_MINOR & 0xff,
  );
  if (m === null) return -1;

  if (drive.image === null || unit.type === DRIVE_TYPE_CMDHD) {
    if (g_hooks.snapshot_module_close(m) < 0) return -1;
    return 0;
  }

  // drive-snapshot.c:689-690 — image type word
  const word = drive.image.type & 0xffff;
  g_hooks.SMW_W(m, word);

  // drive-snapshot.c:694-707 — iterate tracks/sectors until read returns
  // non-zero. Match VICE: rc=0 means "ok, more data".
  const sector_data = new Uint8Array(0x100);
  for (let track = 1; ; track++) {
    let rc = 0;
    let sector = 0;
    for (sector = 0; ; sector++) {
      rc = g_hooks.disk_image_read_sector(drive.image, sector_data, track, sector);
      if (rc === 0) {
        g_hooks.SMW_BA(m, sector_data, 0x100);
      } else {
        break;
      }
    }
    if (sector === 0) break;
  }

  if (g_hooks.snapshot_module_close(m) < 0) return -1;
  return 0;
}

// =============================================================================
// SECTION 6 — drive_snapshot_read_image_module (drive-snapshot.c:715-852)
// =============================================================================

// PORT OF: vice/src/drive/drive-snapshot.c:715-852 (drive_snapshot_read_image_module)
//   static int drive_snapshot_read_image_module(snapshot_t *s, unsigned int dnr)
export function drive_snapshot_read_image_module(
  s: snapshot_t,
  dnr: number,
): number {
  const units = g_hooks.diskunit_context();
  const unit = units[dnr];
  if (unit === null || unit === undefined) return 0;
  const drive = unit.drives[0];
  if (drive === null || drive === undefined) return 0;

  // drive-snapshot.c:733-745 — NOIMAGE<n> branch
  const noimage = `NOIMAGE${dnr}`;
  const openNo = g_hooks.snapshot_module_open(s, noimage);
  if (openNo !== null) {
    if (unit.type !== DRIVE_TYPE_CMDHD) {
      g_hooks.file_system_detach_disk(dnr + 8, 0);
    }
    g_hooks.file_system_detach_disk(dnr + 8, 1);
    g_hooks.snapshot_module_close(openNo.module);
    return 0;
  }

  // drive-snapshot.c:747-753 — IMAGE<n> branch
  const snap_module_name = `IMAGE${dnr}`;
  const open = g_hooks.snapshot_module_open(s, snap_module_name);
  if (open === null) return 0;
  const m = open.module;

  if (g_hooks.snapshot_version_is_bigger(
    open.major, open.minor, IMAGE_SNAP_MAJOR, IMAGE_SNAP_MINOR,
  )) {
    g_hooks.snapshot_set_error(g_hooks.SNAPSHOT_MODULE_HIGHER_VERSION);
    g_hooks.snapshot_module_close(m);
    return -1;
  }
  if (g_hooks.snapshot_version_is_smaller(
    open.major, open.minor, IMAGE_SNAP_MAJOR, IMAGE_SNAP_MINOR,
  )) {
    g_hooks.snapshot_set_error(g_hooks.SNAPSHOT_MODULE_INCOMPATIBLE);
    g_hooks.snapshot_module_close(m);
    return -1;
  }

  // drive-snapshot.c:769-772 — image type word
  const wordR = g_hooks.SMR_W(m);
  if (!wordR.ok) {
    g_hooks.snapshot_module_close(m);
    return -1;
  }
  const word = wordR.v;

  // drive-snapshot.c:774-793 — derive image size
  let len = 0;
  switch (word) {
    case 1581:
      len = D81_FILE_SIZE;
      break;
    case 8050:
      len = D80_FILE_SIZE;
      break;
    case 8250:
      len = D82_FILE_SIZE;
      break;
    case 9000:
      if (drive.image === null) {
        g_hooks.snapshot_module_close(m);
        return -1;
      }
      len = drive.image.tracks * drive.image.sectors * 256;
      break;
    default:
      g_hooks.log_error(drive_snapshot_log,
        "Snapshot of disk image unknown (type %d)", word);
      g_hooks.snapshot_module_close(m);
      return -1;
  }

  // drive-snapshot.c:795-815 — create temp file of right size + attach
  const filename = g_hooks.archdep_mkstemp_fd(len);
  if (filename === null) {
    g_hooks.log_error(drive_snapshot_log, "Could not create temporary file!");
    g_hooks.snapshot_module_close(m);
    return -1;
  }

  // drive-snapshot.c:817-822
  if (g_hooks.file_system_attach_disk(dnr + 8, 0, filename) < 0) {
    g_hooks.log_error(drive_snapshot_log, "Invalid Disk Image");
    g_hooks.snapshot_module_close(m);
    return -1;
  }

  // drive-snapshot.c:825-828 — zfile_close_action for the temp
  const request_str = `Disk image unit #${dnr + 8} imported from snapshot`;
  g_hooks.zfile_close_action(filename, g_hooks.ZFILE_REQUEST, request_str);

  // drive-snapshot.c:830-846 — sector loop
  if (drive.image === null) {
    g_hooks.snapshot_module_close(m);
    return -1;
  }
  const sector_data = new Uint8Array(0x100);
  g_hooks.SMR_BA(m, sector_data, 0x100);
  for (let track = 1; ; track++) {
    let rc = 0;
    let sector = 0;
    for (sector = 0; ; sector++) {
      rc = g_hooks.disk_image_write_sector(drive.image, sector_data, track, sector);
      if (rc === 0) {
        g_hooks.SMR_BA(m, sector_data, 0x100);
      } else {
        break;
      }
    }
    if (sector === 0) break;
  }

  g_hooks.snapshot_module_close(m);
  return 0;
}

// =============================================================================
// SECTION 7 — drive_snapshot_write_gcrimage_module (drive-snapshot.c:860-903)
// =============================================================================

// PORT OF: vice/src/drive/drive-snapshot.c:860-903 (drive_snapshot_write_gcrimage_module)
//   static int drive_snapshot_write_gcrimage_module(snapshot_t *s, unsigned int dnr)
export function drive_snapshot_write_gcrimage_module(
  s: snapshot_t,
  dnr: number,
): number {
  const units = g_hooks.diskunit_context();
  const unit = units[dnr];
  if (unit === null || unit === undefined) return -1;
  const drive = unit.drives[0];
  if (drive === null || drive === undefined) return -1;
  if (drive.gcr === null) return -1;

  const snap_module_name = `GCRIMAGE${dnr}`;
  const m = g_hooks.snapshot_module_create(
    s, snap_module_name,
    GCRIMAGE_SNAP_MAJOR & 0xff,
    GCRIMAGE_SNAP_MINOR & 0xff,
  );
  if (m === null) return -1;

  // drive-snapshot.c:878
  const num_half_tracks = MAX_TRACKS_1571 * 2;

  // drive-snapshot.c:881-884 — header
  if (g_hooks.SMW_DW(m, num_half_tracks >>> 0) < 0) {
    g_hooks.snapshot_module_close(m);
    return -1;
  }

  // drive-snapshot.c:887-896 — per-track data
  let i: number;
  for (i = 0; i < num_half_tracks; i++) {
    const trk = drive.gcr.tracks[i];
    const data = trk?.data ?? null;
    const track_size = data ? (trk!.size >>> 0) : 0;
    if (g_hooks.SMW_DW(m, track_size) < 0) break;
    if (track_size && g_hooks.SMW_BA(m, data!, track_size) < 0) break;
  }

  if (g_hooks.snapshot_module_close(m) < 0 || i !== num_half_tracks) {
    return -1;
  }
  return 0;
}

// =============================================================================
// SECTION 8 — drive_snapshot_read_gcrimage_module (drive-snapshot.c:905-987)
// =============================================================================

// PORT OF: vice/src/drive/drive-snapshot.c:905-987 (drive_snapshot_read_gcrimage_module)
//   static int drive_snapshot_read_gcrimage_module(snapshot_t *s, unsigned int dnr)
export function drive_snapshot_read_gcrimage_module(
  s: snapshot_t,
  dnr: number,
): number {
  const units = g_hooks.diskunit_context();
  const unit = units[dnr];
  if (unit === null || unit === undefined) return 0;
  const drive = unit.drives[0];
  if (drive === null || drive === undefined) return 0;

  const snap_module_name = `GCRIMAGE${dnr}`;
  const open = g_hooks.snapshot_module_open(s, snap_module_name);
  if (open === null) return 0;
  const m = open.module;

  if (g_hooks.snapshot_version_is_bigger(
    open.major, open.minor, GCRIMAGE_SNAP_MAJOR, GCRIMAGE_SNAP_MINOR,
  )) {
    g_hooks.snapshot_set_error(g_hooks.SNAPSHOT_MODULE_HIGHER_VERSION);
    g_hooks.snapshot_module_close(m);
    return -1;
  }
  if (g_hooks.snapshot_version_is_smaller(
    open.major, open.minor, GCRIMAGE_SNAP_MAJOR, GCRIMAGE_SNAP_MINOR,
  )) {
    g_hooks.snapshot_set_error(g_hooks.SNAPSHOT_MODULE_INCOMPATIBLE);
    g_hooks.snapshot_module_close(m);
    return -1;
  }

  // drive-snapshot.c:938-943
  const nhtR = g_hooks.SMR_DW(m);
  if (!nhtR.ok || (nhtR.v >>> 0) > MAX_GCR_TRACKS) {
    g_hooks.snapshot_module_close(m);
    return -1;
  }
  const num_half_tracks = nhtR.v >>> 0;

  if (drive.gcr === null) {
    g_hooks.snapshot_module_close(m);
    return -1;
  }

  let i: number;
  for (i = 0; i < num_half_tracks; i++) {
    const tsR = g_hooks.SMR_DW(m);
    if (!tsR.ok || (tsR.v >>> 0) > NUM_MAX_MEM_BYTES_TRACK) {
      g_hooks.snapshot_module_close(m);
      return -1;
    }
    const track_size = tsR.v >>> 0;

    const trk = drive.gcr.tracks[i];
    if (trk === undefined) {
      g_hooks.snapshot_module_close(m);
      return -1;
    }

    if (track_size) {
      if (trk.data === null) {
        // VICE: lib_calloc(1, track_size)
        trk.data = new Uint8Array(track_size);
      } else if (trk.size !== track_size) {
        // VICE: lib_realloc — preserve VICE behaviour where the new buffer
        // is then memset to 0 (next statement in VICE).
        trk.data = new Uint8Array(track_size);
      } else {
        // VICE memsets the existing buffer to 0.
        trk.data.fill(0);
      }
    } else {
      // VICE: lib_free + NULL
      trk.data = null;
    }
    trk.size = track_size;

    if (track_size && trk.data) {
      if (g_hooks.SMR_BA(m, trk.data, track_size) < 0) {
        g_hooks.snapshot_module_close(m);
        return -1;
      }
    }
  }

  // drive-snapshot.c:973-979 — free remaining tracks above num_half_tracks
  for (; i < MAX_GCR_TRACKS; i++) {
    const trk = drive.gcr.tracks[i];
    if (trk?.data) {
      trk.data = null;
      trk.size = 0;
    }
  }
  g_hooks.snapshot_module_close(m);

  drive.GCR_image_loaded = 1;
  drive.complicated_image_loaded = 1;
  drive.image = null;

  return 0;
}

// =============================================================================
// SECTION 9 — drive_snapshot_write_p64image_module (drive-snapshot.c:995-1044)
// =============================================================================

// PORT OF: vice/src/drive/drive-snapshot.c:995-1044 (drive_snapshot_write_p64image_module)
//   static int drive_snapshot_write_p64image_module(snapshot_t *s, unsigned int dnr)
// PORT-STUB per Spec 612 §10 (P64 / PAL out of scope). Throws with the
// marker per PL-7 — no silent success.
export function drive_snapshot_write_p64image_module(
  _s: snapshot_t,
  _dnr: number,
): number {
  void _s; void _dnr;
  throw new Error(
    "PORT-STUB: drive_snapshot_write_p64image_module — P64 out of scope per Spec 612 §10.",
  );
}

// =============================================================================
// SECTION 10 — drive_snapshot_read_p64image_module (drive-snapshot.c:1046-1131)
// =============================================================================

// PORT OF: vice/src/drive/drive-snapshot.c:1046-1131 (drive_snapshot_read_p64image_module)
//   static int drive_snapshot_read_p64image_module(snapshot_t *s, unsigned int dnr)
// PORT-STUB per Spec 612 §10. Returns 0 like VICE when the P64IMAGE<n>
// module is absent, but throws on attempted use so the failure is loud.
export function drive_snapshot_read_p64image_module(
  s: snapshot_t,
  dnr: number,
): number {
  // Match VICE drive-snapshot.c:1060-1064 — if the module isn't present,
  // VICE returns 0 silently. We honour that contract since drive_snapshot_
  // read_module always probes the module unconditionally; throwing on
  // absence would break the read path for any non-P64 snapshot.
  const snap_module_name = `P64IMAGE${dnr}`;
  const open = g_hooks.snapshot_module_open(s, snap_module_name);
  if (open === null) return 0;
  // If we did find a P64IMAGE<n> chunk, P64 is genuinely required. Close
  // the module to release any host resources before throwing.
  g_hooks.snapshot_module_close(open.module);
  throw new Error(
    "PORT-STUB: drive_snapshot_read_p64image_module — P64 out of scope per Spec 612 §10.",
  );
}
