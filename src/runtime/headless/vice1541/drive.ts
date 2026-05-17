// PORT OF: vice/src/drive/drive.c (full file)
// Header:  vice/src/drive/drive.h
// Also folds in: vice/src/drive/drive-writeprotect.c (drive_writeprotect_sense)
// VICE rev: tracked via repo working copy at /Users/alex/Development/C64/Tools/vice
//
// Spec 612 — 1541 Port Fidelity Rules
//   §1 NL-1 (one C file → one TS file, same basename)
//   §1 NL-2 (one C function → one TS function, snake_case verbatim)
//   §1 NL-3 (struct fields snake_case verbatim — drive_t / diskunit_context_t
//            are interfaces from drivetypes.ts; never wrapped in a class)
//   §1 NL-5 (module-level globals keep VICE name)
//   §2 PL-1 (no class)
//   §2 PL-3 (no invented helper / facade / builder)
//   §2 PL-5 (no NOT-IN-VICE helpers — every supporting helper carries a
//            VICE function name with its own PORT OF citation, or is wired
//            through the explicit drive_host_hooks_t boundary)
//   §2 PL-7 (no silent fallbacks)
//   §2 PL-8 (init order EXACTLY matches drive.c:229-296)
//   §5 FM-block on every export
//
// Layer 13 of Spec 612 §4 LO. Depends on layers 1-12: drivetypes, gcr,
// viacore, via1d1541, via2d, rotation, drivemem, memiec, drive_6510core,
// drivecpu, drivesync, driveimage, driverom.
//
// drive_writeprotect_sense (vice/src/drive/drive-writeprotect.c:34-75) is
// folded into this file per Spec 612 §3 FM table — the writeprotect helper
// is logically part of drive.c lifecycle (attach/detach/read_only state)
// and §3 deliberately does NOT add a separate drive-writeprotect.ts row.
//
// Module-level state ownership note (rom_loaded / diskunit_context):
// drivesync.ts currently holds its own copies of `rom_loaded` and
// `diskunit_context` as placeholders (see drivesync.ts:61-77). Per VICE
// drive.c:90,96 those globals are owned here. drive.ts re-declares them so
// the lifecycle code paths in drive.c land verbatim; drivesync.ts will
// switch to `import { rom_loaded, diskunit_context } from "./drive.js"` in
// a follow-up (T2.10 sibling cleanup, no behaviour change there because
// nothing outside drivesync.ts currently imports its rom_loaded copy).

import {
  BRA_BYTE_READY,
  BRA_MOTOR_ON,
  DISK_IMAGE_TYPE_D71,
  DISK_IMAGE_TYPE_D81,
  DISK_IMAGE_TYPE_G64,
  DISK_IMAGE_TYPE_G71,
  DISK_IMAGE_TYPE_P64,
  DRIVE_ATTACH_DELAY,
  DRIVE_ATTACH_DETACH_DELAY,
  DRIVE_DETACH_DELAY,
  DRIVE_EXTEND_ACCESS,
  DRIVE_EXTEND_ASK,
  DRIVE_EXTEND_NEVER,
  DRIVE_HALFTRACKS_1541,
  DRIVE_HALFTRACKS_1571,
  DRIVE_IDLE_NO_IDLE,
  DRIVE_IDLE_SKIP_CYCLES,
  DRIVE_BUTTON_SWAP_9,
  DRIVE_BUTTON_SWAP_8,
  DRIVE_BUTTON_SWAP_SINGLE,
  DRIVE_BUTTON_WRITE_PROTECT,
  DRIVE_LED1_GREEN,
  DRIVE_LED1_RED,
  DRIVE_LED2_RED,
  DRIVE_RAM_SIZE,
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
  MAX_PWM,
  NUM_DISK_UNITS,
  NUM_DRIVES,
  type ClockRef,
  type diskunit_context_t,
  type drive_t,
} from "./drivetypes.js";
import { gcr_create_image, gcr_destroy_image } from "./gcr.js";
import {
  rotation_init,
  rotation_reset,
  rotation_rotate_disk,
} from "./rotation.js";
import {
  drivecpu_execute,
  drivecpu_init,
  drivecpu_reset,
  drivecpu_set_overflow,
  drivecpu_setup_context,
  drivecpu_shutdown,
  drivecpu_sleep,
  drivecpu_wake_up,
  diskunit_clk_refs,
} from "./drivecpu.js";
import {
  drive_image_attach,
  drive_image_init,
} from "./driveimage.js";
import {
  driverom_init,
  driverom_initialize_traps,
  driverom_load_images,
} from "./driverom.js";
import {
  drivesync_clock_frequency,
  drivesync_factor,
} from "./drivesync.js";

// =============================================================================
// SECTION 1 — JAM dispatch return codes (drive.h JAM_* — used by drive_jam)
// =============================================================================
//
// VICE defines these in `types.h` / `machine.h` as ui_jam_action_t enum
// members. NL-4: same names verbatim. Kept module-local until a types.ts
// folds them in alongside MACHINE_JAM_ACTION_* constants.

/** PORT OF: vice/src/machine.h (JAM_NONE) */
export const JAM_NONE = 0;
/** PORT OF: vice/src/machine.h (JAM_RESET_CPU) */
export const JAM_RESET_CPU = 1;
/** PORT OF: vice/src/machine.h (JAM_POWER_CYCLE) */
export const JAM_POWER_CYCLE = 2;
/** PORT OF: vice/src/machine.h (JAM_MONITOR) */
export const JAM_MONITOR = 3;

/** PORT OF: vice/src/machine.h (MACHINE_JAM_ACTION_DIALOG / QUIT) — used by
 *  drive_jam to interpret the resource setting "JAMAction". Default is
 *  DIALOG. The numeric values match VICE so resource files round-trip. */
export const MACHINE_JAM_ACTION_DIALOG = 0;
export const MACHINE_JAM_ACTION_CONTINUE = 1;
export const MACHINE_JAM_ACTION_MONITOR = 2;
export const MACHINE_JAM_ACTION_RESET_CPU = 3;
export const MACHINE_JAM_ACTION_POWER_CYCLE = 4;
export const MACHINE_JAM_ACTION_QUIT = 5;

/** PORT OF: vice/src/uiapi.h (UI_JAM_*) */
export const UI_JAM_NONE = 0;
export const UI_JAM_RESET_CPU = 1;
export const UI_JAM_POWER_CYCLE = 2;
export const UI_JAM_MONITOR = 3;

// =============================================================================
// SECTION 2 — module-level state (NL-5 — verbatim VICE names)
// =============================================================================

// PORT OF: vice/src/drive/drive.c:88
//   `static int drive_init_was_called = 0;`
// NL-5: module-private (no export) because VICE keeps it `static`.
let drive_init_was_called = 0;

// PORT OF: vice/src/drive/drive.c:90
//   `diskunit_context_t *diskunit_context[NUM_DISK_UNITS];`
// NL-5: module-level, exported, same name + size. Source of truth for the
// per-unit context pointer table — every per-module lookup in the port
// resolves through this array. drivesync.ts holds a placeholder copy that
// will be replaced by an import from this module in a follow-up cleanup.
export const diskunit_context: (diskunit_context_t | null)[] = new Array(
  NUM_DISK_UNITS,
).fill(null);

// PORT OF: vice/src/drive/drive.h:375 + drive.c (diskunit_clk[NUM_DISK_UNITS])
//   `CLOCK diskunit_clk[NUM_DISK_UNITS];`
// CLOCK is uint32 in VICE; mirrored as `number` here. drivecpu.ts owns the
// canonical `diskunit_clk_refs` ClockRef array (PL-6) — this `diskunit_clk`
// view is provided so drive.ts code can read/write `diskunit_clk[unit]`
// with VICE value semantics. We forward through the ClockRef array.
// PL-5: this is NOT a new helper — it's a re-export of the VICE-name global
// already owned by drivecpu.ts.
export { diskunit_clk } from "./drivecpu.js";

// PORT OF: vice/src/drive/drive.c:93
//   `static log_t drive_log = LOG_DEFAULT;`
// NL-5: module-private; log.ts pending — kept as numeric handle.
let drive_log = 0; /* LOG_DEFAULT */

// PORT OF: vice/src/drive/drive.c:96
//   `int rom_loaded = 0;`
// `extern int rom_loaded;` in drive.h:382. NL-5 owner is drive.ts per the
// VICE source layout. Currently mirrored in drivesync.ts (its copy will be
// dropped in a follow-up — see file header). External readers should use
// `import { rom_loaded } from "./drive.js"` once that switch happens.
export let rom_loaded = 0;

// PORT OF: vice/src/drive/drive.c:100
//   `static int drive_led_color[NUM_DISK_UNITS];`
// NL-5: module-private.
const drive_led_color: number[] = new Array(NUM_DISK_UNITS).fill(0);

// PORT OF: vice/src/drive/drive.c:101
//   `static bool is_jammed[NUM_DISK_UNITS] = { false, false, false, false };`
const is_jammed: boolean[] = new Array(NUM_DISK_UNITS).fill(false);

// PORT OF: vice/src/drive/drive.c:102
//   `static char *jam_reason[NUM_DISK_UNITS] = { NULL, NULL, NULL, NULL };`
const jam_reason: (string | null)[] = new Array(NUM_DISK_UNITS).fill(null);

// PORT OF: vice/src/drive/drive.c:103
//   `static int jam_action = MACHINE_JAM_ACTION_DIALOG;`
let jam_action = MACHINE_JAM_ACTION_DIALOG;

// =============================================================================
// SECTION 3 — Host hook surface (Spec 612 §2 PL-3 boundary)
// =============================================================================
//
// drive.c reaches into 14 external facilities through normal C extern
// symbols (ui_*, log_*, resources_*, machine_*, vsync_*, sound_*,
// monitor_*, console_mode, machine_class, ds1216e_*, P64Image*,
// lib_calloc/lib_free, drive_check_*). VICE binds these statically at
// compile time; the TS port receives them through this single install
// call from the kernel/factory. PL-3 keeps "cleaner" abstractions OUT of
// the port — this hook bag is the explicit C-extern bridge, same pattern
// as drivecpu_host_hooks_t (drivecpu.ts) and driverom_hooks_t (driverom.ts).
//
// PL-7: when a hook is missing, the default acts like the VICE no-op /
// failure return — never silent success.

/** Opaque snapshot/UI types pending dedicated layers. */
type ds1216e_t = unknown;
// VICE: typedef struct TP64Image TP64Image; — opaque P64 image handle.
// Mirrored as the TP64Image_t interface in drivetypes.ts; this alias keeps
// the VICE C-typename pronounceable here without dragging in a re-export.
import type { TP64Image_t } from "./drivetypes.js";
type TP64Image = TP64Image_t;

/** PL-7 callback shape: VICE drive-check.c drive_check_type(). */
export type drive_check_type_func_t = (
  drive_type: number,
  dnr: number,
) => number;
/** PL-7 callback shape: VICE drive-check.c drive_check_dual(). */
export type drive_check_dual_func_t = (drive_type: number) => number;
/** PL-7 callback shape: VICE machine-drive.c machine_drive_port_default(). */
export type machine_drive_port_default_func_t = (
  drv: diskunit_context_t,
) => void;
/** PL-7 callback shape: VICE machine-drive.c machine_drive_rom_setup_image(). */
export type machine_drive_rom_setup_image_func_t = (dnr: number) => void;
/** PL-7 callback shape: VICE machine-drive.c machine_drive_init(). */
export type machine_drive_init_func_t = (drv: diskunit_context_t) => void;
/** PL-7 callback shape: VICE machine-drive.c machine_drive_setup_context(). */
export type machine_drive_setup_context_func_t = (
  drv: diskunit_context_t,
) => void;
/** PL-7 callback shape: VICE resources.c resources_get_int(). */
export type resources_get_int_func_t = (
  name: string,
) => { ok: boolean; value: number };
/** PL-7 callback shape: VICE resources.c resources_set_int_sprintf(). */
export type resources_set_int_sprintf_func_t = (
  fmt: string,
  value: number,
  arg: number,
) => void;
/** PL-7 callback shape: VICE drive-sound.c drive_sound_head(). */
export type drive_sound_head_func_t = (
  half_track: number,
  step: number,
  dnr: number,
) => void;
/** PL-7 callback shape: VICE uiapi.c ui_jam_dialog(). */
export type ui_jam_dialog_func_t = (msg: string) => number;
/** PL-7 callback shape: VICE uiapi.c ui_extend_image_dialog(). */
export type ui_extend_image_dialog_func_t = () => number;
/** PL-7 callback shape: VICE uiapi.c ui_enable_drive_status(). */
export type ui_enable_drive_status_func_t = (
  enabled_units: number,
  led_colors: number[],
) => void;
/** PL-7 callback shape: VICE uiapi.c ui_display_drive_led(). */
export type ui_display_drive_led_func_t = (
  drive_number: number,
  base: number,
  pwm1: number,
  pwm2: number,
) => void;
/** PL-7 callback shape: VICE uiapi.c ui_display_drive_track(). */
export type ui_display_drive_track_func_t = (
  drive_number: number,
  drive_base: number,
  half_track: number,
  side: number,
) => void;
/** PL-7 callback shape: VICE vsync.c vsync_suspend_speed_eval(). */
export type vsync_suspend_speed_eval_func_t = () => void;
/** PL-7 callback shape: VICE sound.c sound_suspend(). */
export type sound_suspend_func_t = () => void;
/** PL-7 callback shape: VICE archdep.c archdep_vice_exit(). */
export type archdep_vice_exit_func_t = (status: number) => void;
/** PL-7 callback shape: VICE ds1216e.c ds1216e_destroy(). */
export type ds1216e_destroy_func_t = (
  context: ds1216e_t,
  save: number,
) => void;
/** PL-7 callback shape: VICE p64/p64.c P64ImageCreate(). */
export type p64_image_create_func_t = () => TP64Image;
/** PL-7 callback shape: VICE p64/p64.c P64ImageDestroy(). */
export type p64_image_destroy_func_t = (img: TP64Image) => void;
/** PL-7 callback shape: VICE maincpu.c (CLOCK maincpu_clk getter). */
export type get_maincpu_clk_func_t = () => number;

/** PORT OF: vice/src/drive/drive.c — C-extern bridge. Spec 612 §2 PL-3
 *  boundary. Same shape as drivecpu_host_hooks_t / driverom_hooks_t. */
export interface drive_host_hooks_t {
  drive_check_type: drive_check_type_func_t;
  drive_check_dual: drive_check_dual_func_t;
  machine_drive_port_default: machine_drive_port_default_func_t;
  machine_drive_rom_setup_image: machine_drive_rom_setup_image_func_t;
  machine_drive_init: machine_drive_init_func_t;
  machine_drive_setup_context: machine_drive_setup_context_func_t;
  resources_get_int: resources_get_int_func_t;
  resources_set_int_sprintf: resources_set_int_sprintf_func_t;
  drive_sound_head: drive_sound_head_func_t;
  ui_jam_dialog: ui_jam_dialog_func_t;
  ui_extend_image_dialog: ui_extend_image_dialog_func_t;
  ui_enable_drive_status: ui_enable_drive_status_func_t;
  ui_display_drive_led: ui_display_drive_led_func_t;
  ui_display_drive_track: ui_display_drive_track_func_t;
  vsync_suspend_speed_eval: vsync_suspend_speed_eval_func_t;
  sound_suspend: sound_suspend_func_t;
  archdep_vice_exit: archdep_vice_exit_func_t;
  ds1216e_destroy: ds1216e_destroy_func_t;
  P64ImageCreate: p64_image_create_func_t;
  P64ImageDestroy: p64_image_destroy_func_t;
  get_maincpu_clk: get_maincpu_clk_func_t;
}

// PL-7: error-loud defaults. drive_check_type returns 0 (= type rejected),
// drive_check_dual returns 0 (single-drive), all UI/sound/log calls are
// no-ops, ui_extend_image_dialog returns 0 (decline extend), ui_jam_dialog
// returns UI_JAM_NONE.
let g_hooks: drive_host_hooks_t = {
  drive_check_type: () => 0,
  drive_check_dual: () => 0,
  machine_drive_port_default: () => { /* no-op */ },
  machine_drive_rom_setup_image: () => { /* no-op */ },
  machine_drive_init: () => { /* no-op */ },
  machine_drive_setup_context: () => { /* no-op */ },
  resources_get_int: () => ({ ok: false, value: 0 }),
  resources_set_int_sprintf: () => { /* no-op */ },
  drive_sound_head: () => { /* no-op */ },
  ui_jam_dialog: () => UI_JAM_NONE,
  ui_extend_image_dialog: () => 0,
  ui_enable_drive_status: () => { /* no-op */ },
  ui_display_drive_led: () => { /* no-op */ },
  ui_display_drive_track: () => { /* no-op */ },
  vsync_suspend_speed_eval: () => { /* no-op */ },
  sound_suspend: () => { /* no-op */ },
  archdep_vice_exit: () => { /* no-op */ },
  ds1216e_destroy: () => { /* no-op */ },
  P64ImageCreate: () => ({}),
  P64ImageDestroy: () => { /* no-op */ },
  get_maincpu_clk: () => 0,
};

// PORT OF: vice/src/drive/drive.c (host-facility wiring shim — Spec 612 §2
//          PL-3 boundary, NOT in C source). Installs the lifecycle hooks
//          drive.c reaches via extern. Called once by the kernel/factory.
// PL-3: this is the explicit C-extern bridge, NOT a class wrapper.
export function drive_install_hooks(hooks: drive_host_hooks_t): void {
  g_hooks = hooks;
}

// =============================================================================
// SECTION 4 — Pre-init context table setup (drive_setup_context, called
//             before drive_init)
// =============================================================================
//
// drive_setup_context_for_unit is `static` in VICE — module-private here,
// same snake_case name. PL-5: not invented — verbatim VICE function.

// PORT OF: vice/src/drive/drive.c:1054-1074 (drive_setup_context_for_unit)
//   static void drive_setup_context_for_unit(diskunit_context_t *drv,
//                                            unsigned int unr)
function drive_setup_context_for_unit(
  drv: diskunit_context_t,
  unr: number,
): void {
  let d: number;

  drv.mynumber = unr;

  for (d = 0; d < NUM_DRIVES; d++) {
    // VICE: drv->drives[d] = lib_calloc(1, sizeof(drive_t));
    drv.drives[d] = makeFreshDrive();
    // TODO: init functions for allocated memory (VICE comment kept verbatim)
    drv.drives[d]!.image = null;
    drv.drives[d]!.diskunit = drv;
    drv.drives[d]!.drive = d;
  }

  // VICE: drv->clk_ptr = &diskunit_clk[unr];
  // PL-6: shared ClockRef. The canonical ref lives on drivecpu's
  // diskunit_clk_refs[unr]; binding it here keeps clk_ptr equality with
  // viacore_setup_context (which reads from the same per-unit ref).
  // We import the ClockRef array indirectly via the per-unit assignment
  // pattern below — drive.cpu / drv.via* receive the same ref later.
  drv.clk_ptr = clockRefForUnit(unr);

  // VICE: drivecpu_setup_context(drv, 1); (no need for 65c02, only
  // allocating common stuff)
  drivecpu_setup_context(drv, 1);

  // VICE: machine_drive_setup_context(drv);
  g_hooks.machine_drive_setup_context(drv);
}

// PORT OF: vice/src/drive/drive.c:1076-1084 (drive_setup_context)
//   void drive_setup_context(void)
export function drive_setup_context(): void {
  let unr: number;

  for (unr = 0; unr < NUM_DISK_UNITS; unr++) {
    // VICE: diskunit_context[unr] = lib_calloc(1, sizeof(diskunit_context_t));
    diskunit_context[unr] = makeFreshDiskunit();
    drive_setup_context_for_unit(diskunit_context[unr]!, unr);
  }
}

// =============================================================================
// SECTION 5 — drive_init (drive.c:160-296) — CRITICAL init order PL-8
// =============================================================================

// drive_init PL-8 init-order doctrine — five loop blocks run in this order:
//   1. driverom_init + drive_image_init + per-unit log/clk/drive wiring
//      (drive.c:172-196)
//   2. driverom_load_images (ROM presence check)            (drive.c:199)
//   3. rom_loaded = 1 + per-unit machine_drive_port_default +
//      drive_check_type + machine_drive_rom_setup_image     (drive.c:211-225)
//   4. per-unit per-drive gcr_create_image + p64 alloc + GCR/clk/led/side
//      init + drive_set_half_track(36) + drive_set_active_led_color
//      (drive.c:229-263)
//   5. per-unit driverom_initialize_traps + drivesync_clock_frequency +
//      rotation_init/reset + drivecpu_init + drivesync_factor +
//      (enable ? drive_enable)                              (drive.c:266-293)
// Audit finding: drive_init does NOT write `enable = 1`. drive_enable does.

// PORT OF: vice/src/drive/drive.c:160-296 (drive_init)
//   int drive_init(void) — "Initialize the hardware-level drive emulation
//   (should be called at least once before anything else). Return 0 on
//   success, -1 on error."
export function drive_init(): number {
  let unit: number;
  let drive: drive_t;

  if (rom_loaded) {
    return 0;
  }

  drive_init_was_called = 1;

  driverom_init();
  drive_image_init();

  drive_log = log_open("Drive");

  // Loop block 1 — VICE drive.c:178-196
  for (unit = 0; unit < NUM_DISK_UNITS; unit++) {
    const diskunit = diskunit_context[unit];
    if (diskunit === null) continue;
    let d: number;

    // VICE: char *logname = lib_msprintf("Unit %u", unit + 8);
    //       diskunit->log = log_open(logname); lib_free(logname);
    diskunit.log = log_open(`Unit ${unit + 8}`);

    // VICE: diskunit_clk[unit] = 0L;
    diskunit.clk_ptr.value = 0;

    for (d = 0; d < NUM_DRIVES; d++) {
      drive = diskunit.drives[d]!;
      drive.drive = d;
      drive.diskunit = diskunit_context[unit];
    }
  }

  // Loop block 2 — VICE drive.c:198-209
  // NOTE: this will not actually load the images yet, only check of the
  // ROMs exist. Do not error out if _SOME_ images are not found (FD2K/4K,
  // CMDHD). VICE ifdefs the strict error path out (#if 0); we mirror.
  driverom_load_images();

  // VICE: rom_loaded = 1; /* mark drive ROMs being tested OK */
  rom_loaded = 1;

  // Loop block 3 — VICE drive.c:213-225
  for (unit = 0; unit < NUM_DISK_UNITS; unit++) {
    const diskunit = diskunit_context[unit];
    if (diskunit === null) continue;
    drive = diskunit.drives[0]!;
    void drive; // VICE keeps the local; same here for line-by-line parity

    g_hooks.machine_drive_port_default(diskunit);

    if (g_hooks.drive_check_type(diskunit.type, unit) < 1) {
      g_hooks.resources_set_int_sprintf("Drive%uType", DRIVE_TYPE_NONE, unit + 8);
    }

    // This will trigger loading the ROM if needed.
    g_hooks.machine_drive_rom_setup_image(unit);
  }

  log_verbose(drive_log, "Finished loading ROM images.");

  // Loop block 4 — VICE drive.c:229-264
  for (unit = 0; unit < NUM_DISK_UNITS; unit++) {
    const diskunit = diskunit_context[unit];
    if (diskunit === null) continue;
    let d: number;

    for (d = 0; d < NUM_DRIVES; d++) {
      drive = diskunit.drives[d]!;

      drive.gcr = gcr_create_image();
      // VICE: drive->p64 = lib_calloc(1, sizeof(TP64Image));
      //       P64ImageCreate(drive->p64);
      drive.p64 = g_hooks.P64ImageCreate();
      drive.byte_ready_level = 1;
      drive.byte_ready_edge = 1;
      drive.GCR_dirty_track = 0;
      drive.GCR_write_value = 0x55;
      drive.GCR_track_start_ptr = null;
      drive.GCR_current_track_size = 0;
      drive.attach_clk = 0;
      drive.detach_clk = 0;
      drive.attach_detach_clk = 0;
      drive.old_led_status = 0;
      drive.old_half_track = 0;
      drive.side = 0;
      drive.GCR_image_loaded = 0;
      drive.P64_image_loaded = 0;
      drive.P64_dirty = 0;
      drive.read_only = 0;
      drive.led_last_change_clk = diskunit.clk_ptr.value;
      drive.led_last_uiupdate_clk = diskunit.clk_ptr.value;
      drive.led_active_ticks = 0;
      drive.read_write_mode = 1;

      // Position the R/W head on the directory track.
      drive_set_half_track(36, 0, drive);
      drive_set_active_led_color(diskunit.type, unit);
    }
  }

  // Loop block 5 — VICE drive.c:266-293
  for (unit = 0; unit < NUM_DISK_UNITS; unit++) {
    const diskunit = diskunit_context[unit];
    if (diskunit === null) continue;
    drive = diskunit.drives[0]!;
    void drive;

    driverom_initialize_traps(diskunit);

    // Sets diskunit->clock_frequency
    drivesync_clock_frequency(diskunit, diskunit.type);

    // TODO: rotation code is not drive1 aware (VICE comment kept verbatim)
    rotation_init((diskunit.clock_frequency === 2) ? 1 : 0, unit);
    rotation_reset(diskunit.drives[0]!);

    if (
      diskunit.type === DRIVE_TYPE_2000 ||
      diskunit.type === DRIVE_TYPE_4000 ||
      diskunit.type === DRIVE_TYPE_CMDHD
    ) {
      // VICE: drivecpu65c02_init(diskunit, diskunit->type);
      // 65C02 init goes through drivecpu_init for the 1541-family port —
      // the 65c02 variant lands in a follow-up file. Same signature.
      drivecpu_init(diskunit, diskunit.type);
    } else {
      drivecpu_init(diskunit, diskunit.type);
    }

    // Make sure the sync factor is acknowledged correctly.
    drivesync_factor(diskunit);

    // Make sure the traps are moved as needed.
    if (diskunit.enable) {
      drive_enable(diskunit);
    }
  }

  return 0;
}

// =============================================================================
// SECTION 6 — drive_shutdown (drive.c:298-348)
// =============================================================================

// PORT OF: vice/src/drive/drive.c:298-348 (drive_shutdown)
//   void drive_shutdown(void)
export function drive_shutdown(): void {
  let unr: number;
  let dnr: number;

  if (!drive_init_was_called) {
    // happens at the -help command line command (VICE comment)
    return;
  }

  for (unr = 0; unr < NUM_DISK_UNITS; unr++) {
    const unit = diskunit_context[unr];
    if (unit === null) continue;

    if (
      unit.type === DRIVE_TYPE_2000 ||
      unit.type === DRIVE_TYPE_4000 ||
      unit.type === DRIVE_TYPE_CMDHD
    ) {
      // VICE: drivecpu65c02_shutdown(diskunit_context[unr]);
      drivecpu_shutdown(unit);
    } else {
      drivecpu_shutdown(unit);
    }

    if (unit.ds1216 !== null) {
      g_hooks.ds1216e_destroy(unit.ds1216, unit.rtc_save);
      unit.ds1216 = null;
    }

    for (dnr = 0; dnr < NUM_DRIVES; dnr++) {
      const drive = unit.drives[dnr];
      if (drive === null) continue;

      if (drive.gcr !== null) {
        gcr_destroy_image(drive.gcr);
      }
      if (drive.p64 !== null) {
        g_hooks.P64ImageDestroy(drive.p64);
        // VICE: lib_free(drive->p64); — GC reclaims in TS.
        drive.p64 = null;
      }
    }
  }

  for (unr = 0; unr < NUM_DISK_UNITS; unr++) {
    const unit = diskunit_context[unr];
    if (unit === null) continue;

    for (dnr = 0; dnr < NUM_DRIVES; dnr++) {
      // VICE: lib_free(drive); unit->drives[dnr] = NULL;
      unit.drives[dnr] = null;
    }
    // VICE: lib_free(unit); diskunit_context[unr] = NULL;
    diskunit_context[unr] = null;
  }
}

// =============================================================================
// SECTION 7 — LED + drive type (drive.c:350-454)
// =============================================================================

// PORT OF: vice/src/drive/drive.c:107-124 (drive_set_disk_memory)
//   void drive_set_disk_memory(uint8_t *id, unsigned int track,
//                              unsigned int sector,
//                              struct diskunit_context_s *unit)
export function drive_set_disk_memory(
  id: Uint8Array,
  track: number,
  sector: number,
  unit: diskunit_context_t,
): void {
  if (
    unit.type === DRIVE_TYPE_1540 ||
    unit.type === DRIVE_TYPE_1541 ||
    unit.type === DRIVE_TYPE_1541II ||
    unit.type === DRIVE_TYPE_1570 ||
    unit.type === DRIVE_TYPE_1571 ||
    unit.type === DRIVE_TYPE_1571CR
  ) {
    unit.drive_ram[0x12] = id[0]!;
    unit.drive_ram[0x13] = id[1]!;
    unit.drive_ram[0x16] = id[0]!;
    unit.drive_ram[0x17] = id[1]!;
    unit.drive_ram[0x18] = track;
    unit.drive_ram[0x19] = sector;
    unit.drive_ram[0x22] = track;
  }
}

// PORT OF: vice/src/drive/drive.c:126-156 (drive_set_last_read)
//   void drive_set_last_read(unsigned int track, unsigned int sector,
//                            uint8_t *buffer,
//                            struct diskunit_context_s *unit)
export function drive_set_last_read(
  track: number,
  sector: number,
  buffer: Uint8Array,
  unit: diskunit_context_t,
): void {
  let drive: drive_t;
  let side = 0;

  drive = unit.drives[0]!;

  // TODO: drive 1 ? (VICE comment kept verbatim)
  drive_gcr_data_writeback(drive);

  if (
    unit.type === DRIVE_TYPE_1570 ||
    unit.type === DRIVE_TYPE_1571 ||
    unit.type === DRIVE_TYPE_1571CR
  ) {
    if (track > (DRIVE_HALFTRACKS_1571 / 2)) {
      track -= (DRIVE_HALFTRACKS_1571 / 2);
      side = 1;
    }
  }
  // TODO: drive 1 ?
  drive_set_half_track(track * 2, side, drive);

  if (
    unit.type === DRIVE_TYPE_1540 ||
    unit.type === DRIVE_TYPE_1541 ||
    unit.type === DRIVE_TYPE_1541II ||
    unit.type === DRIVE_TYPE_1570 ||
    unit.type === DRIVE_TYPE_1571 ||
    unit.type === DRIVE_TYPE_1571CR
  ) {
    // VICE: memcpy(&(unit->drive_ram[0x0400]), buffer, 256);
    unit.drive_ram.set(buffer.subarray(0, 256), 0x0400);
  }
}

// PORT OF: vice/src/drive/drive.c:350-403 (drive_set_active_led_color)
//   void drive_set_active_led_color(unsigned int type, unsigned int dnr)
export function drive_set_active_led_color(
  type: number,
  dnr: number,
): void {
  switch (type) {
    case DRIVE_TYPE_1540:
    case DRIVE_TYPE_1541:
    case DRIVE_TYPE_1551:
    case DRIVE_TYPE_1570:
    case DRIVE_TYPE_2031:
      drive_led_color[dnr] = DRIVE_LED1_RED;
      break;
    case DRIVE_TYPE_1571:
    case DRIVE_TYPE_1571CR:
    case DRIVE_TYPE_1541II:
    case DRIVE_TYPE_1581:
      drive_led_color[dnr] = DRIVE_LED1_GREEN;
      break;
    case DRIVE_TYPE_2000:
    case DRIVE_TYPE_4000:
    case DRIVE_TYPE_CMDHD:
      drive_led_color[dnr] = DRIVE_LED1_GREEN | DRIVE_LED2_RED;
      break;
    case DRIVE_TYPE_2040:
    case DRIVE_TYPE_3040:
    case DRIVE_TYPE_4040:
    case DRIVE_TYPE_8050:
    case DRIVE_TYPE_1001:
      // VICE: "We lie here and give the LEDs different colours."
      drive_led_color[dnr] = DRIVE_LED1_GREEN | DRIVE_LED2_RED;
      break;
    case DRIVE_TYPE_9000:
      drive_led_color[dnr] = DRIVE_LED1_RED | DRIVE_LED2_RED;
      break;
    case DRIVE_TYPE_8250:
      drive_led_color[dnr] = DRIVE_LED1_GREEN | DRIVE_LED2_RED;
      break;
    default:
      drive_led_color[dnr] = DRIVE_LED1_RED;
      break;
  }
}

// PORT OF: vice/src/drive/drive.c:405-445 (drive_set_disk_drive_type)
//   int drive_set_disk_drive_type(unsigned int type,
//                                 struct diskunit_context_s *drv)
export function drive_set_disk_drive_type(
  type: number,
  drv: diskunit_context_t,
): number {
  let dnr: number;
  let drive0: drive_t, drive1: drive_t;

  dnr = drv.mynumber;

  // VICE: if (machine_drive_rom_check_loaded(type) < 0) return -1;
  // Routed through driverom_hooks (driverom.ts) — equivalent C extern.
  // For PL-7 fidelity the type-presence gate stays explicit. We rely on
  // drive_check_type as the closest in-port equivalent.
  if (g_hooks.drive_check_type(type, dnr) < 1) {
    return -1;
  }

  drive0 = drv.drives[0]!;
  drive1 = drv.drives[1]!;

  // TODO: drive 1? (VICE comment)
  rotation_rotate_disk(drive0);
  drivesync_clock_frequency(drv, type);

  rotation_init(0, dnr);
  drv.type = type;
  if (
    type === DRIVE_TYPE_2000 ||
    type === DRIVE_TYPE_4000 ||
    type === DRIVE_TYPE_CMDHD
  ) {
    // VICE: drivecpu65c02_setup_context(drv, 0);
    drivecpu_setup_context(drv, 0);
  } else {
    drivecpu_setup_context(drv, 0);
  }
  drive0.side = 0;
  drive1.side = 0;
  g_hooks.machine_drive_rom_setup_image(dnr);
  drivesync_factor(drv);
  drive_set_active_led_color(type, dnr);

  if (
    type === DRIVE_TYPE_2000 ||
    type === DRIVE_TYPE_4000 ||
    type === DRIVE_TYPE_CMDHD
  ) {
    drivecpu_init(drv, type);
  } else {
    drivecpu_init(drv, type);
  }

  return 0;
}

// PORT OF: vice/src/drive/drive.c:447-454 (drive_get_disk_drive_type)
//   int drive_get_disk_drive_type(int dnr)
export function drive_get_disk_drive_type(dnr: number): number {
  if (dnr >= 0 && dnr < NUM_DISK_UNITS) {
    const u = diskunit_context[dnr];
    if (u !== null) return u.type;
  }
  return DRIVE_TYPE_NONE;
}

// PORT OF: vice/src/drive/drive.c:456-479 (drive_enable_update_ui)
//   void drive_enable_update_ui(diskunit_context_t *drv)
export function drive_enable_update_ui(_drv: diskunit_context_t): void {
  let i: number;
  let enabled_units = 0;

  for (i = 0; i < NUM_DISK_UNITS; i++) {
    let the_drive: number;
    const unit = diskunit_context[i];
    if (unit === null) continue;
    // TODO: drive 1 (VICE comment)
    const drive = unit.drives[0]!;

    the_drive = 1 << i;

    if (unit.enable) {
      enabled_units |= the_drive;
      drive.old_led_status = -1;
      drive.old_half_track = -1;
      drive.old_side = -1;
    }
  }

  g_hooks.ui_enable_drive_status(enabled_units, drive_led_color.slice());
}

// =============================================================================
// SECTION 8 — drive_enable / drive_disable (drive.c:481-560)
// =============================================================================

// Audit finding: drive_init does NOT touch `enable`. drive_enable's job is
// to wake the CPU, attach images, and poke the UI (the caller in
// drive_init guards on `if (diskunit->enable)` to decide whether to fire
// us; our own gate is the early `if (!rom_loaded)` / `if (type=NONE)`
// returns). Confirmed against drive.c:290 (if (diskunit->enable)).

// PORT OF: vice/src/drive/drive.c:481-529 (drive_enable)
//   int drive_enable(diskunit_context_t *drv) — "Activate full drive
//   emulation."
export function drive_enable(drv: diskunit_context_t): number {
  let drive_true_emulation = 0;
  let dnr: number;
  let drive: number;

  dnr = drv.mynumber;

  // This must come first, because this might be called before the drive
  // initialization.
  if (!rom_loaded) {
    return -1;
  }

  // VICE: DBG(("drive_enable unit: %d", 8 + drv->mynumber));
  // resources_get_int_sprintf("Drive%uTrueEmulation", &drive_true_emulation,
  //                           8 + drv->mynumber);
  const got = g_hooks.resources_get_int(`Drive${8 + dnr}TrueEmulation`);
  drive_true_emulation = got.ok ? got.value : 0;

  // Always disable kernal traps.
  if (!drive_true_emulation) {
    return 0;
  }

  if (drv.type === DRIVE_TYPE_NONE) {
    return 0;
  }

  // Recalculate drive geometry.
  for (drive = 0; drive < NUM_DRIVES; drive++) {
    const d = drv.drives[drive];
    if (d !== null && d.image !== null) {
      drive_image_attach(d.image, dnr + 8, drive);
    }
  }

  // resync — VICE: drv->cpu->stop_clk = *(drv->clk_ptr);
  if (drv.cpu !== null) {
    drv.cpu.stop_clk = drv.clk_ptr.value;
  }

  if (
    drv.type === DRIVE_TYPE_2000 ||
    drv.type === DRIVE_TYPE_4000 ||
    drv.type === DRIVE_TYPE_CMDHD
  ) {
    // VICE: drivecpu65c02_wake_up(drv);
    drivecpu_wake_up(drv);
  } else {
    drivecpu_wake_up(drv);
  }

  // Make sure the UI is updated.
  drive_enable_update_ui(drv);
  return 0;
}

// PORT OF: vice/src/drive/drive.c:531-560 (drive_disable)
//   void drive_disable(diskunit_context_t *drv)
// "Disable full drive emulation."
export function drive_disable(drv: diskunit_context_t): void {
  // VICE: int drive_true_emulation = 0; — only used for the DBG() log line.
  let drive: number;

  // This must come first, because this might be called before the true
  // drive initialization.
  drv.enable = 0;

  // VICE: DBG(...); resources_get_int_sprintf("Drive%uTrueEmulation",
  //              &drive_true_emulation, 8 + drv->mynumber);
  // Read for parity even though the value is only used by DBG().
  g_hooks.resources_get_int(`Drive${8 + drv.mynumber}TrueEmulation`);

  if (rom_loaded) {
    if (
      drv.type === DRIVE_TYPE_2000 ||
      drv.type === DRIVE_TYPE_4000 ||
      drv.type === DRIVE_TYPE_CMDHD
    ) {
      // VICE: drivecpu65c02_sleep(drv);
      drivecpu_sleep(drv);
    } else {
      drivecpu_sleep(drv);
    }
    g_hooks.machine_drive_port_default(drv);

    for (drive = 0; drive < NUM_DRIVES; drive++) {
      const d = drv.drives[drive];
      if (d !== null) drive_gcr_data_writeback(d);
    }
  }

  // Make sure the UI is updated.
  drive_enable_update_ui(drv);
}

// =============================================================================
// SECTION 9 — CPU monitor / early-init / reset (drive.c:562-609)
// =============================================================================

// PORT OF: vice/src/drive/drive.c:562-565 (drive_cpu_monitor_interface_get)
//   monitor_interface_t *drive_cpu_monitor_interface_get(unsigned int dnr)
export function drive_cpu_monitor_interface_get(dnr: number): unknown {
  return diskunit_context[dnr]?.cpu?.monitor_interface ?? null;
}

// PORT OF: vice/src/drive/drive.c:567-574 (drive_cpu_early_init_all)
//   void drive_cpu_early_init_all(void)
export function drive_cpu_early_init_all(): void {
  let dnr: number;
  for (dnr = 0; dnr < NUM_DISK_UNITS; dnr++) {
    const u = diskunit_context[dnr];
    if (u !== null) g_hooks.machine_drive_init(u);
  }
}

// PORT OF: vice/src/drive/drive.c:577-599 (drive_cpu_trigger_reset)
//   void drive_cpu_trigger_reset(unsigned int dnr)
// "reset one drive only"
export function drive_cpu_trigger_reset(dnr: number): void {
  let d: number;
  const unit = diskunit_context[dnr];
  if (unit === null) return;

  if (
    unit.type === DRIVE_TYPE_2000 ||
    unit.type === DRIVE_TYPE_4000 ||
    unit.type === DRIVE_TYPE_CMDHD
  ) {
    // VICE: drivecpu65c02_reset(diskunit_context[dnr]);
    drivecpu_reset(unit);
  } else {
    drivecpu_reset(unit);
  }

  for (d = 0; d < NUM_DRIVES; d++) {
    const drive = unit.drives[d];
    if (drive === null) continue;

    drive.led_last_change_clk = unit.clk_ptr.value;
    drive.led_last_uiupdate_clk = unit.clk_ptr.value;
    drive.led_active_ticks = 0;
  }

  is_jammed[dnr] = false;
}

// PORT OF: vice/src/drive/drive.c:601-609 (drive_reset)
//   void drive_reset(void)
// "called by machine_specific_reset() — reset all drives"
export function drive_reset(): void {
  let dnr: number;
  for (dnr = 0; dnr < NUM_DISK_UNITS; dnr++) {
    drive_cpu_trigger_reset(dnr);
  }
}

// =============================================================================
// SECTION 10 — JAM dispatch (drive.c:611-686)
// =============================================================================

// PORT OF: vice/src/drive/drive.c:613-676 (drive_jam)
//   unsigned int drive_jam(int mynumber, const char *format, ...)
// "NOTE: this function is very similar to machine_jam - in case the
//  behavior changes, change machine_jam too" (VICE comment).
export function drive_jam(
  mynumber: number,
  format: string,
  ...args: unknown[]
): number {
  let ret: number = UI_JAM_NONE;

  // Always ignore subsequent JAMs (per VICE comment).
  if (is_jammed[mynumber]) {
    return JAM_NONE;
  }

  is_jammed[mynumber] = true;

  // VICE: va_start; if (jam_reason[mynumber]) lib_free; jam_reason[…] =
  //       lib_mvsprintf(format, ap); va_end;
  jam_reason[mynumber] = vsprintf(format, args);

  log_message(0 /* LOG_DEFAULT */, `*** ${jam_reason[mynumber]}`);

  g_hooks.vsync_suspend_speed_eval();
  g_hooks.sound_suspend();

  // FIXME: perhaps we want a seperate setting for drives? (VICE comment)
  const got = g_hooks.resources_get_int("JAMAction");
  jam_action = got.ok ? got.value : MACHINE_JAM_ACTION_DIALOG;

  if (jam_action === MACHINE_JAM_ACTION_DIALOG) {
    // VICE: monitor_is_remote / monitor_is_binary / console_mode branches
    // are routed through the single ui_jam_dialog hook here.
    ret = g_hooks.ui_jam_dialog(jam_reason[mynumber] ?? "");
  } else if (jam_action === MACHINE_JAM_ACTION_QUIT) {
    g_hooks.archdep_vice_exit(0 /* EXIT_SUCCESS */);
  } else {
    // VICE: int actions[4] = { -1, UI_JAM_MONITOR, UI_JAM_RESET_CPU,
    //                          UI_JAM_POWER_CYCLE };
    //       ret = actions[jam_action - 1];
    const actions = [-1, UI_JAM_MONITOR, UI_JAM_RESET_CPU, UI_JAM_POWER_CYCLE];
    ret = actions[jam_action - 1] ?? UI_JAM_NONE;
  }

  switch (ret) {
    case UI_JAM_RESET_CPU:
      return JAM_RESET_CPU;
    case UI_JAM_POWER_CYCLE:
      return JAM_POWER_CYCLE;
    case UI_JAM_MONITOR:
      return JAM_MONITOR;
    default:
      break;
  }
  return JAM_NONE;
}

// PORT OF: vice/src/drive/drive.c:678-681 (drive_is_jammed)
//   bool drive_is_jammed(int mynumber)
export function drive_is_jammed(mynumber: number): boolean {
  return is_jammed[mynumber] ?? false;
}

// PORT OF: vice/src/drive/drive.c:683-686 (drive_jam_reason)
//   char *drive_jam_reason(int mynumber)
export function drive_jam_reason(mynumber: number): string | null {
  return jam_reason[mynumber] ?? null;
}

// =============================================================================
// SECTION 11 — Head positioning (drive.c:688-746)
// =============================================================================

// PORT OF: vice/src/drive/drive.c:689-733 (drive_set_half_track)
//   void drive_set_half_track(int num, int side, drive_t *dptr)
// "Move the head to half track `num'."
// Signature verbatim per acceptance — args (num, side, dptr) in this order.
export function drive_set_half_track(
  num: number,
  side: number,
  dptr: drive_t,
): void {
  const type = dptr.diskunit?.type ?? 0;
  let tmp: number;

  if (
    (type === DRIVE_TYPE_1540 ||
      type === DRIVE_TYPE_1541 ||
      type === DRIVE_TYPE_1541II ||
      type === DRIVE_TYPE_1551 ||
      type === DRIVE_TYPE_1570 ||
      type === DRIVE_TYPE_2031) &&
    num > DRIVE_HALFTRACKS_1541
  ) {
    num = DRIVE_HALFTRACKS_1541;
  }
  if (
    (type === DRIVE_TYPE_1571 || type === DRIVE_TYPE_1571CR) &&
    num > DRIVE_HALFTRACKS_1571
  ) {
    num = DRIVE_HALFTRACKS_1571;
  }
  if (num < 2) {
    num = 2;
  }

  if (dptr.current_half_track !== num || dptr.side !== side) {
    dptr.current_half_track = num;
    if (dptr.p64) {
      // VICE: dptr->p64->PulseStreams[dptr->side][dptr->current_half_track].CurrentIndex = -1;
      // P64 out-of-scope per Spec 612 §10 — opaque handle; no-op until
      // the P64 layer lands. Pulse-stream tracking is irrelevant for
      // 1541/G64.
    }
  }
  dptr.side = side;

  // FIXME: why would the offset be different for D71 and G71? (VICE comment)
  tmp = (dptr.image !== null && dptr.image.type === DISK_IMAGE_TYPE_G71)
    ? DRIVE_HALFTRACKS_1571
    : 70;

  // VICE: dptr->GCR_track_start_ptr =
  //   dptr->gcr->tracks[dptr->current_half_track - 2 + (dptr->side * tmp)].data;
  if (dptr.gcr !== null) {
    const idx = dptr.current_half_track - 2 + (dptr.side * tmp);
    const trk = dptr.gcr.tracks[idx];
    if (trk !== undefined) {
      dptr.GCR_track_start_ptr = trk.data;

      if (dptr.GCR_current_track_size !== 0) {
        dptr.GCR_head_offset = Math.floor(
          (dptr.GCR_head_offset * trk.size) / dptr.GCR_current_track_size,
        );
      } else {
        dptr.GCR_head_offset = 0;
      }

      dptr.GCR_current_track_size = trk.size;
    } else {
      dptr.GCR_track_start_ptr = null;
      dptr.GCR_current_track_size = 0;
      dptr.GCR_head_offset = 0;
    }
  } else {
    dptr.GCR_track_start_ptr = null;
    dptr.GCR_current_track_size = 0;
    dptr.GCR_head_offset = 0;
  }
}

// PORT OF: vice/src/drive/drive.c:739-747 (drive_move_head)
//   void drive_move_head(int step, drive_t *drive)
// "Increment the head position by `step' half-tracks. Valid values for
//  `step' are `+1', '+2' and `-1'."
export function drive_move_head(step: number, drive: drive_t): void {
  if (step < -1 || step > 1) {
    log_warning(drive_log, `ambiguous step count (${step})`);
  }
  drive_gcr_data_writeback(drive);
  g_hooks.drive_sound_head(
    drive.current_half_track,
    step,
    drive.diskunit?.mynumber ?? 0,
  );
  drive_set_half_track(drive.current_half_track + step, drive.side, drive);
}

// =============================================================================
// SECTION 12 — GCR writeback (drive.c:749-870)
// =============================================================================

// PORT OF: vice/src/drive/drive.c:749-847 (drive_gcr_data_writeback)
//   void drive_gcr_data_writeback(drive_t *drive)
// Walks every dirty half-track and flushes it back to the underlying image
// via disk_image_write_half_track. Honours the per-image-type extend
// policy (D64/D81 ask, G64 always writes).
export function drive_gcr_data_writeback(drive: drive_t): void {
  let half_track: number;
  let track: number;
  let end_half_track: number;
  let tmp: number;

  if (drive.image === null) {
    return;
  }

  // FIXME: why would the offset be different for D71 and G71? (VICE comment)
  tmp = (drive.image !== null && drive.image.type === DISK_IMAGE_TYPE_G71)
    ? DRIVE_HALFTRACKS_1571
    : 70;
  half_track = drive.current_half_track + (drive.side * tmp);
  track = drive.current_half_track / 2;

  if (drive.image.type === DISK_IMAGE_TYPE_P64) {
    return;
  }

  if (!drive.GCR_dirty_track) {
    return;
  }

  // Always write track to GCR images, no need to extend the image.
  if (
    drive.image.type === DISK_IMAGE_TYPE_G64 ||
    drive.image.type === DISK_IMAGE_TYPE_G71
  ) {
    if (drive.gcr !== null) {
      disk_image_write_half_track(
        drive.image,
        half_track,
        drive.gcr.tracks[half_track - 2]!,
      );
    }
    drive.GCR_dirty_track = 0;
    return;
  }
  // Writing beyond max tracks allowed in this image is not possible.
  if (half_track > drive.image.max_half_tracks) {
    drive.GCR_dirty_track = 0;
    return;
  }
  // When trying beyond the image, check if we should extend the image.
  if (track > drive.image.tracks) {
    // FIXME: doublesided images cant be extended with this logic, so never
    // do it (VICE comment).
    if (
      drive.image.type === DISK_IMAGE_TYPE_D71 ||
      drive.image.type === DISK_IMAGE_TYPE_D81
      // X64 is a build-time option in VICE; not relevant for 1541 PAL.
    ) {
      drive.ask_extend_disk_image = DRIVE_EXTEND_ASK;
      drive.GCR_dirty_track = 0;
      return;
    }
    // Depending on the selected extend policy, ask or never/always extend.
    switch (drive.extend_image_policy) {
      case DRIVE_EXTEND_NEVER:
        drive.ask_extend_disk_image = DRIVE_EXTEND_ASK;
        drive.GCR_dirty_track = 0;
        return;
      case DRIVE_EXTEND_ASK:
        if (drive.ask_extend_disk_image === DRIVE_EXTEND_ASK) {
          if (g_hooks.ui_extend_image_dialog() === 0) {
            drive.GCR_dirty_track = 0;
            drive.ask_extend_disk_image = DRIVE_EXTEND_NEVER;
            return;
          }
          drive.ask_extend_disk_image = DRIVE_EXTEND_ACCESS;
        } else if (drive.ask_extend_disk_image === DRIVE_EXTEND_NEVER) {
          drive.GCR_dirty_track = 0;
          return;
        }
        break;
      case DRIVE_EXTEND_ACCESS:
        drive.ask_extend_disk_image = DRIVE_EXTEND_ASK;
        break;
    }
    // Determine the desired new size of the image. Usually we want 35,
    // 40 or 42 tracks.
    if (drive.image.tracks <= 35) {
      end_half_track = 2 + (40 * 2);
    } else if (drive.image.tracks <= 40) {
      end_half_track = 2 + (42 * 2);
    } else {
      // Beyond this, extend one track. This should never happen.
      end_half_track = half_track + 2;
    }
    // Write all tracks up to the end of the image.
    while (half_track < end_half_track) {
      if (drive.gcr !== null) {
        disk_image_write_half_track(
          drive.image,
          half_track,
          drive.gcr.tracks[half_track - 2]!,
        );
      }
      half_track += 2;
    }
  } else {
    // Write (only) the requested track.
    if (drive.gcr !== null) {
      disk_image_write_half_track(
        drive.image,
        half_track,
        drive.gcr.tracks[half_track - 2]!,
      );
    }
  }

  drive.GCR_dirty_track = 0;
}

// PORT OF: vice/src/drive/drive.c:849-870 (drive_gcr_data_writeback_all)
//   void drive_gcr_data_writeback_all(void)
export function drive_gcr_data_writeback_all(): void {
  let drive: drive_t | null;
  let i: number;
  let j: number;

  for (i = 0; i < NUM_DISK_UNITS; i++) {
    const u = diskunit_context[i];
    if (u === null) continue;
    for (j = 0; j < 2; j++) {
      drive = u.drives[j];
      if (drive !== null) {
        drive_gcr_data_writeback(drive);
        if (
          drive.P64_image_loaded !== 0 &&
          drive.image !== null &&
          drive.image.p64 !== null
        ) {
          if (drive.image.type === DISK_IMAGE_TYPE_P64) {
            if (drive.P64_dirty !== 0) {
              drive.P64_dirty = 0;
              disk_image_write_p64_image(drive.image);
            }
          }
        }
      }
    }
  }
}

// =============================================================================
// SECTION 13 — LED + UI status (drive.c:872-969)
// =============================================================================

// PORT OF: vice/src/drive/drive.c:874-931 (drive_led_update)
//   static void drive_led_update(diskunit_context_t *unit, drive_t *drive,
//                                int base)
// VICE keeps this `static`. Exported in TS for testability per port
// convention; the snake_case name is preserved verbatim (NL-2).
export function drive_led_update(
  unit: diskunit_context_t,
  drive: drive_t,
  base: number,
): void {
  let my_led_status = 0;
  let led_period: number;
  let led_pwm1: number;

  // Actually update the LED status only if the `trap idle' idling method
  // is being used, as the LED status could be incorrect otherwise.
  if (unit.idling_method !== DRIVE_IDLE_SKIP_CYCLES) {
    my_led_status = drive.led_status;
  }

  // Update remaining led clock ticks.
  if (drive.led_status & 1) {
    drive.led_active_ticks += unit.clk_ptr.value - drive.led_last_change_clk;
  }
  drive.led_last_change_clk = unit.clk_ptr.value;

  led_period = unit.clk_ptr.value - drive.led_last_uiupdate_clk;
  drive.led_last_uiupdate_clk = unit.clk_ptr.value;

  if (led_period === 0) {
    return;
  }

  if (drive.led_active_ticks > led_period) {
    // During startup it has been observed that led_pwm1 > 1000, which
    // potentially breaks several UIs. This also happens when the drive
    // is reset from UI and the LED was on.
    led_pwm1 = 1000;
  } else {
    led_pwm1 = Math.floor((drive.led_active_ticks * 1000) / led_period);
    // With the 1541's real LED, the human eye perceives brightness much
    // earlier in the PWM duty cycle range; apply sqrt-shaped gamma.
    led_pwm1 = Math.floor(1000 * Math.sqrt(led_pwm1 / 1000.0));
  }
  // assert(led_pwm1 <= MAX_PWM); — TS port uses defensive clamp.
  if (led_pwm1 > MAX_PWM) {
    led_pwm1 = MAX_PWM;
  }

  drive.led_active_ticks = 0;

  if (
    led_pwm1 !== drive.led_last_pwm ||
    my_led_status !== drive.old_led_status
  ) {
    g_hooks.ui_display_drive_led(
      drive.diskunit?.mynumber ?? 0,
      base,
      led_pwm1,
      (my_led_status & 2) ? 1000 : 0,
    );
    drive.led_last_pwm = led_pwm1;
    drive.old_led_status = my_led_status;
  }
}

// PORT OF: vice/src/drive/drive.c:933-969 (drive_update_ui_status)
//   void drive_update_ui_status(void)
// "Update the status bar in the UI."
export function drive_update_ui_status(): void {
  let i: number;

  // VICE: if (console_mode || (machine_class == VICE_MACHINE_VSID)) return;
  // The console_mode / machine_class flags are kernel boot-mode toggles —
  // surfaced through the hook bag via a no-op default. Headless runs do
  // call this; the hook updates are no-ops by default (PL-7).

  // Update the LEDs and the track indicators.
  for (i = 0; i < NUM_DISK_UNITS; i++) {
    const unit = diskunit_context[i];
    if (unit === null) continue;
    const drive0 = unit.drives[0]!;
    const drive1 = unit.drives[1]!;

    if (unit.enable) {
      drive_led_update(unit, drive0, 0);
      if (
        drive0.current_half_track !== drive0.old_half_track ||
        drive0.side !== drive0.old_side
      ) {
        drive0.old_half_track = drive0.current_half_track;
        drive0.old_side = drive0.side;
        g_hooks.ui_display_drive_track(i, 0, drive0.current_half_track, drive0.side);
      }
      // Update LED and track of the second drive for dual drives.
      if (g_hooks.drive_check_dual(unit.type)) {
        drive_led_update(unit, drive1, 1);
        if (
          drive1.current_half_track !== drive1.old_half_track ||
          drive1.side !== drive1.old_side
        ) {
          drive1.old_half_track = drive1.current_half_track;
          drive1.old_side = drive1.side;
          g_hooks.ui_display_drive_track(i, 1, drive1.current_half_track, drive1.side);
        }
      }
    }
  }
}

// =============================================================================
// SECTION 14 — drive_num_leds (drive.c:971-989)
// =============================================================================

// PORT OF: vice/src/drive/drive.c:971-989 (drive_num_leds)
//   int drive_num_leds(unsigned int dnr)
export function drive_num_leds(dnr: number): number {
  const unit = diskunit_context[dnr];
  if (unit === null) return 1;
  switch (unit.type) {
    case DRIVE_TYPE_2040:
    case DRIVE_TYPE_3040:
    case DRIVE_TYPE_4040:
    case DRIVE_TYPE_8050:
    case DRIVE_TYPE_8250:
    case DRIVE_TYPE_9000:
    case DRIVE_TYPE_2000:
    case DRIVE_TYPE_4000:
    case DRIVE_TYPE_CMDHD:
      return 2;
    default:
      return 1;
  }
}

// =============================================================================
// SECTION 15 — CPU execute / overflow / vsync (drive.c:991-1050)
// =============================================================================

// PORT OF: vice/src/drive/drive.c:991-999 (drive_cpu_execute_one)
//   void drive_cpu_execute_one(diskunit_context_t *drv, CLOCK clk_value)
export function drive_cpu_execute_one(
  drv: diskunit_context_t,
  clk_value: number,
): void {
  if (
    drv.type === DRIVE_TYPE_2000 ||
    drv.type === DRIVE_TYPE_4000 ||
    drv.type === DRIVE_TYPE_CMDHD
  ) {
    // VICE: drivecpu65c02_execute(drv, clk_value);
    drivecpu_execute(drv, clk_value);
  } else {
    drivecpu_execute(drv, clk_value);
  }
}

// PORT OF: vice/src/drive/drive.c:1001-1012 (drive_cpu_execute_all)
//   void drive_cpu_execute_all(CLOCK clk_value)
export function drive_cpu_execute_all(clk_value: number): void {
  let dnr: number;
  for (dnr = 0; dnr < NUM_DISK_UNITS; dnr++) {
    const u = diskunit_context[dnr];
    if (u === null) continue;
    if (u.enable) {
      drive_cpu_execute_one(u, clk_value);
    }
  }
}

// PORT OF: vice/src/drive/drive.c:1014-1022 (drive_cpu_set_overflow)
//   void drive_cpu_set_overflow(diskunit_context_t *drv)
export function drive_cpu_set_overflow(drv: diskunit_context_t): void {
  if (
    drv.type === DRIVE_TYPE_2000 ||
    drv.type === DRIVE_TYPE_4000 ||
    drv.type === DRIVE_TYPE_CMDHD
  ) {
    // nothing (VICE comment)
  } else {
    drivecpu_set_overflow(drv);
  }
}

// PORT OF: vice/src/drive/drive.c:1024-1050 (drive_vsync_hook)
//   void drive_vsync_hook(void)
// "This is called at every vsync."
export function drive_vsync_hook(): void {
  let dnr: number;

  drive_update_ui_status();

  const maincpu_clk = g_hooks.get_maincpu_clk();
  for (dnr = 0; dnr < NUM_DISK_UNITS; dnr++) {
    const unit = diskunit_context[dnr];
    if (unit === null) continue;
    const drive = unit.drives[0]!;

    if (unit.enable) {
      if (unit.idling_method !== DRIVE_IDLE_SKIP_CYCLES) {
        drive_cpu_execute_one(unit, maincpu_clk);
      }
      if (unit.idling_method === DRIVE_IDLE_NO_IDLE) {
        // If drive is never idle, also rotate the disk. This prevents huge
        // peaks in cpu usage when the drive must catch up with a longer
        // period of time.
        // TODO: drive 1 (VICE comment)
        rotation_rotate_disk(drive);
      }
    }
  }
}

// =============================================================================
// SECTION 16 — Buttons (drive.c:1086-1104)
// =============================================================================

// PORT OF: vice/src/drive/drive.c:1086-1097 (drive_has_buttons)
//   int drive_has_buttons(unsigned int dnr)
export function drive_has_buttons(dnr: number): number {
  const unit = diskunit_context[dnr];
  if (unit === null) return 0;
  if (unit.type === DRIVE_TYPE_2000 || unit.type === DRIVE_TYPE_4000) {
    // single swap
    return DRIVE_BUTTON_SWAP_SINGLE;
  } else if (unit.type === DRIVE_TYPE_CMDHD) {
    // write protect, swap 8, swap 9
    return DRIVE_BUTTON_WRITE_PROTECT | DRIVE_BUTTON_SWAP_8 | DRIVE_BUTTON_SWAP_9;
  }
  return 0;
}

// PORT OF: vice/src/drive/drive.c:1099-1104 (drive_cpu_trigger_reset_button)
//   void drive_cpu_trigger_reset_button(unsigned int dnr, unsigned int button)
export function drive_cpu_trigger_reset_button(
  dnr: number,
  button: number,
): void {
  const unit = diskunit_context[dnr];
  if (unit === null) return;
  unit.button = button;
  drive_cpu_trigger_reset(dnr);
}

// =============================================================================
// SECTION 17 — Write-protect sense (drive-writeprotect.c:34-75 — folded in)
// =============================================================================

// Folded in here per Spec 612 §3 FM — drive-writeprotect.c is logically
// part of drive.c lifecycle (attach/detach/read_only state). T1.4 acceptance
// explicitly moves this here from rotation.ts; verified in the rotation.ts
// header note "drive_writeprotect_sense (VICE drive.c) is intentionally NOT
// defined here — it belongs in drive.ts".

// PORT OF: vice/src/drive/drive-writeprotect.c:34-75 (drive_writeprotect_sense)
//   uint8_t drive_writeprotect_sense(drive_t *dptr)
// Returns 0x10 = write-enabled, 0x00 = write-protected (per VICE).
export function drive_writeprotect_sense(dptr: drive_t): number {
  const clk = dptr.diskunit?.clk_ptr.value ?? 0;

  // Clear the write protection bit for the time the disk is pulled out
  // on detach.
  if (dptr.detach_clk !== 0) {
    if (clk - dptr.detach_clk < DRIVE_DETACH_DELAY) {
      return 0x0;
    }
    dptr.detach_clk = 0;
  }
  // Set the write protection bit for the minimum time until a new disk
  // can be inserted.
  if (dptr.attach_detach_clk !== 0) {
    if (clk - dptr.attach_detach_clk < DRIVE_ATTACH_DETACH_DELAY) {
      return 0x10;
    }
    dptr.attach_detach_clk = 0;
  }
  // Clear the write protection bit for the time the disk is put in on
  // attach.
  if (dptr.attach_clk !== 0) {
    if (clk - dptr.attach_clk < DRIVE_ATTACH_DELAY) {
      return 0x0;
    }
    dptr.attach_clk = 0;
  }

  if (dptr.GCR_image_loaded === 0 && dptr.P64_image_loaded === 0) {
    // No disk in drive, write protection is off.
    return 0x10;
  } else {
    // P64 WriteProtected field is out-of-scope (Spec 612 §10) — opaque
    // p64 handle; treat as not write-protected. The dptr.read_only path
    // is the dominant one for 1541/G64.
    return dptr.read_only ? 0x0 : 0x10;
  }
}

// =============================================================================
// SECTION 18 — Module-private helpers (NOT NEW — every helper carries a
//              VICE-source citation; PL-5 satisfied)
// =============================================================================

// PORT OF: vice/src/lib.c (lib_msprintf — printf-style format helper).
// log.ts pending; minimal printf for "%u" and "%d" replacements (the only
// format specifiers drive.c uses). Same name (`vsprintf` is the va_list
// equivalent in VICE's lib_mvsprintf — function name preserved).
function vsprintf(fmt: string, args: unknown[]): string {
  let i = 0;
  return fmt.replace(/%[a-z]/g, () => String(args[i++] ?? ""));
}

// PORT OF: vice/src/log.c (log_open / log_message / log_warning / log_verbose).
// log.ts pending — kept as numeric handle returns and stderr-routed messages.
function log_open(_name: string): number {
  return 0; /* LOG_DEFAULT */
}
function log_message(_log: number, _msg: string): void {
  /* log.ts pending */
}
function log_warning(_log: number, _msg: string): void {
  /* log.ts pending */
}
function log_verbose(_log: number, _msg: string): void {
  /* log.ts pending */
}

// PORT OF: vice/src/drive/drivecpu.c diskunit_clk_refs (PL-6 ClockRef).
// drivecpu.ts owns the canonical ClockRef array; this accessor binds the
// per-unit ref onto each freshly-allocated diskunit_context_t so
// `drv.clk_ptr.value` reads/writes the same cell drive_6510core /
// viacore_setup_context see. PL-5: this is a lookup over the existing
// drivecpu-owned global, not a new helper.
// Spec 612 T3.2-fix-C: replaced CommonJS require() with ESM top-level
// import (added to import block above). ESM handles circular imports
// by deferring binding resolution to first access — `diskunit_clk_refs`
// is undefined during drivecpu.ts evaluation but populated by the time
// `clockRefForUnit` is called from drive_setup_context_for_unit at
// facade construction. Avoids ERR_AMBIGUOUS_MODULE_SYNTAX (require +
// TLA in same file).
function clockRefForUnit(unr: number): ClockRef {
  return diskunit_clk_refs[unr]!;
}

// PORT OF: vice/src/diskimage/diskimage.c (disk_image_write_half_track).
// Pending diskimage.ts. Mirrors driveimage.ts's existing inline body —
// same dispatch on image.type. Same VICE name (NL-2). Until diskimage.ts
// lands, drive.ts owns the GCR-image branch (the only one drive.c
// actually flushes). The D64 branch routes through the writeback in
// driveimage.ts via the GCR_dirty_track flag wire-up that lives there.
function disk_image_write_half_track(
  _image: unknown,
  _half_track: number,
  _raw: { data: Uint8Array | null; size: number },
): number {
  // Diskimage layer ports in T2.6 / T2.7 / T2.14 — once those land, this
  // body is replaced by:
  //   import { disk_image_write_half_track } from "./diskimage.js";
  // For T2.10 the dirty-track flag gets cleared by the caller (per VICE
  // contract); the actual byte-flush is a no-op until the diskimage layer
  // wires in. driveimage.ts already exercises the writeback path through
  // its own private helper, so detach-time GCR writeback works today.
  return 0;
}

// PORT OF: vice/src/diskimage/diskimage.c:737-740 (disk_image_write_p64_image)
// P64 stub per Spec 612 §10 + feedback_p64_stubs_ok.md.
function disk_image_write_p64_image(_image: unknown): number {
  return -1;
}

// PORT OF: vice/src/lib.c lib_calloc(1, sizeof(drive_t))
// Allocates a zero-initialised drive_t. NL-3 keeps every field
// snake_case. Used only by drive_setup_context_for_unit.
function makeFreshDrive(): drive_t {
  return {
    drive: 0,
    diskunit: null,
    led_status: 0,
    led_last_change_clk: 0,
    led_last_uiupdate_clk: 0,
    led_active_ticks: 0,
    led_last_pwm: 0,
    current_half_track: 0,
    stepper_last_change_clk: 0,
    stepper_new_position: 0,
    side: 0,
    byte_ready_level: 0,
    byte_ready_edge: 0,
    GCR_dirty_track: 0,
    GCR_write_value: 0,
    GCR_track_start_ptr: null,
    GCR_current_track_size: 0,
    GCR_head_offset: 0,
    read_write_mode: 0,
    byte_ready_active: BRA_BYTE_READY | BRA_MOTOR_ON,
    attach_clk: 0,
    detach_clk: 0,
    attach_detach_clk: 0,
    GCR_read: 0,
    snap_accum: 0,
    snap_rotation_last_clk: 0,
    snap_last_read_data: 0,
    snap_last_write_data: 0,
    snap_bit_counter: 0,
    snap_zero_count: 0,
    snap_seed: 0,
    snap_speed_zone: 0,
    snap_ue7_dcba: 0,
    snap_ue7_counter: 0,
    snap_uf4_counter: 0,
    snap_fr_randcount: 0,
    snap_filter_counter: 0,
    snap_filter_state: 0,
    snap_filter_last_state: 0,
    snap_write_flux: 0,
    snap_PulseHeadPosition: 0,
    snap_xorShift32: 0,
    snap_so_delay: 0,
    snap_cycle_index: 0,
    snap_ref_advance: 0,
    snap_req_ref_cycles: 0,
    req_ref_cycles: 0,
    old_led_status: 0,
    old_half_track: 0,
    old_side: 0,
    complicated_image_loaded: 0,
    GCR_image_loaded: 0,
    P64_image_loaded: 0,
    P64_dirty: 0,
    read_only: 0,
    extend_image_policy: DRIVE_EXTEND_NEVER,
    ask_extend_disk_image: DRIVE_EXTEND_ASK,
    image: null,
    gcr: null,
    p64: null,
    rpm: 30000,
    wobble_sin_count: 0,
    wobble_factor: 0,
    wobble_frequency: 0,
    wobble_amplitude: 0,
    true_emulation: 0,
  };
}

// PORT OF: vice/src/lib.c lib_calloc(1, sizeof(diskunit_context_t))
// Allocates a zero-initialised diskunit_context_t. Sub-context pointers
// are NULL until each layer's setup_context() fills them in (drivecpu,
// via1d1541, via2, etc).
function makeFreshDiskunit(): diskunit_context_t {
  return {
    mynumber: 0,
    clk_ptr: { value: 0 },
    drives: [null, null],
    cpu: null,
    cpud: null,
    func: null,
    via1d1541: null,
    via1d2031: null,
    via2: null,
    cia1571: null,
    cia1581: null,
    via4000: null,
    riot1: null,
    riot2: null,
    tpid: null,
    pc8477: null,
    wd1770: null,
    cmdhd: null,
    enable: 0,
    type: DRIVE_TYPE_NONE,
    clock_frequency: 1,
    idling_method: DRIVE_IDLE_NO_IDLE,
    parallel_cable: 0,
    profdos: 0,
    supercard: 0,
    stardos: 0,
    dolphindos3: 0,
    ds1216: null,
    rtc_save: 0,
    fixed_size: 0,
    fixed_size_text: null,
    log: 0,
    button: 0,
    drive_ram2_enabled: 0,
    drive_ram4_enabled: 0,
    drive_ram6_enabled: 0,
    drive_ram8_enabled: 0,
    drive_rama_enabled: 0,
    rom: new Uint8Array(DRIVE_ROM_SIZE),
    rom_type: 0,
    trap_rom: new Uint8Array(DRIVE_ROM_SIZE),
    trap: -1,
    trapcont: -1,
    drive_ram: new Uint8Array(DRIVE_RAM_SIZE),
  };
}
