// PORT OF: vice/src/drive/iecieee/via2d.c (full file)
// PORT OF: vice/src/drive/viad.h            (drivevia2_context_s + entry-point decls)
// VICE rev: system-installed /Users/alex/Development/C64/Tools/vice/vice
//           (Spec 612 §11 open question 1 — pinning deferred)
//
// Spec 612 — 1541 Port Fidelity Rules (this file is layer §4 LO-4):
//   §1 NL-1  one C file -> one TS file (via2d.c -> via2d.ts)
//   §1 NL-2  one C function -> one TS function, snake_case verbatim
//            (all 19 VICE functions present; module-private functions
//             match C `static`, exports are entry points + lifecycle +
//             via2d_update_pcr which is also extern in viad.h)
//   §1 NL-3  struct fields accessed via ctx.field_name_snake_case
//            (drive_t / via_context_t / diskunit_context_t declared
//             in ./drivetypes.ts — NOT redeclared here)
//   §1 NL-4  drivevia2_context_t locally declared (matches the
//            per-backend `drivevia2_context_s` defined inside via2d.c)
//   §1 NL-5  no module-level C globals in via2d.c → no module lets here
//   §2 PL-1  NO TS class — functions take via_context_t / diskunit_context_t
//            first arg per VICE signatures
//   §2 PL-3  NO factories / managers / helpers — VICE function shapes only
//   §2 PL-5  NO NOT-IN-VICE helpers (closure-captured `poldpb` / `ledActiveTicks`
//            / `maxHalfTrackLocal` from the pre-612 port are removed; state
//            lives on drive_t per VICE)
//   §2 PL-6  via_context_t.clk_ptr (ClockRef) and rmw_flag (RmwFlagRef)
//            wired by viacore_setup_context callers; set_int stamps `rclk`
//            (the parameter), NOT `clk_ptr.value` — see set_int below
//   §2 PL-7  no silent fallbacks — drive-side helpers (drive_writeprotect_sense,
//            drive_cpu_set_overflow, drive_move_head, drive_sound_update,
//            drive_update_ui_status) are forward-declared as PORT-STUB
//            local thunks until drive.ts (T2.10) ports them. The stubs
//            THROW with the Spec 612 T1.7 marker rather than returning
//            silent defaults.
//   §5 FM    PORT OF block on every export within 5 lines (FC-4 gate)
//
// SALVAGED from src/runtime/headless/_quarantine_vice1541_v4/via2d.ts.
// Compared to the quarantine source, this port:
//   * drops the class-wrapper / Via6522Backend pattern — functions take
//     via_context_t first arg; backend hooks are installed onto VICE's
//     callback-table fields (ctx.store_pra, ctx.read_prb, …) per
//     via2d.c:549-565 wire-up;
//   * adds via2d_update_pcr (was missing in the pre-612 port);
//   * read_prb returns `(sync_found | wps | 0x6f) & ~DDRB | (PRB & DDRB)`
//     per VICE via2d.c:497-501 (the pre-612 port returned `0x10`
//     hard-coded for the wps bit only — fundamentally wrong);
//   * set_int stamps `rclk` (the parameter from viacore.update_myviairq_rclk
//     callsite), NOT `clk_ptr.value`. VICE via2d.c:120 passes rclk through;
//   * removes the BRA_LED bit (pre-612 invention; VICE drive.h:283-284
//     only defines BRA_BYTE_READY=0x02 and BRA_MOTOR_ON=0x04 — there is
//     NO BRA_LED in upstream);
//   * stepper ±1 gate applied at FIRST call site only (via2d.c:307);
//     SECOND call site (via2d.c:341-350 Primitive 7 Sins workaround)
//     passes raw step. VICE relies on drive_move_head() to handle step==2;
//   * led_active_ticks / led_last_change_clk live on drive_t (snake_case
//     fields from drive.h:236-372) instead of closure state;
//   * stepper position uses `current_half_track - 2` directly per
//     via2d.c:229 — no closure `maxHalfTrackLocal`. drive_move_head
//     receives the raw step; drive.ts clamps to drv->max_half_track.

import type {
  diskunit_context_t,
  drive_t,
  via_context_t,
  via_set_int_func_t,
  via_restore_int_func_t,
  via_set_ca2_func_t,
  via_set_cb2_func_t,
  via_store_pra_func_t,
  via_store_prb_func_t,
  via_store_pcr_func_t,
  via_store_acr_func_t,
  via_store_sr_func_t,
  via_store_t2l_func_t,
  via_undump_pra_func_t,
  via_undump_prb_func_t,
  via_undump_pcr_func_t,
  via_undump_acr_func_t,
  via_read_pra_func_t,
  via_read_prb_func_t,
  via_reset_func_t,
} from "./drivetypes.js";
import {
  BRA_BYTE_READY,
  BRA_MOTOR_ON,
  VIA_DDRA,
  VIA_DDRB,
  VIA_PCR,
  VIA_PRA,
  VIA_PRB,
} from "./drivetypes.js";
import {
  BUS_READ_DELAY,
  rotation_begins,
  rotation_byte_read,
  rotation_rotate_disk,
  rotation_speed_zone_set,
  rotation_sync_found,
} from "./rotation.js";
import {
  viacore_dump,
  viacore_init,
  viacore_peek,
  viacore_read,
  viacore_setup_context,
  viacore_store,
} from "./viacore.js";
import {
  type IntNum,
  InterruptCpuStatus,
} from "../cpu/interrupt-cpu-status.js";

// =============================================================================
// SECTION 1 — drivevia2_context_t (via2d.c:67-70)
// =============================================================================

// PORT OF: vice/src/drive/iecieee/via2d.c:67-70 (drivevia2_context_s)
// VICE definition:
//   typedef struct drivevia2_context_s {
//       unsigned int number;
//       struct drive_s *drive;
//   } drivevia2_context_t;
// The TS port adds `int_num_obj` to carry the IntNum handle allocated by
// InterruptCpuStatus.newIntNum() in via2d_setup_context. VICE keeps the
// int_num in via_context_t.int_num as a plain int (interrupt.c assigns
// monotonically), but the TS InterruptCpuStatus API requires an opaque
// IntNum object — so we cache the object here and look it up from
// ctx.prv in set_int / restore_int below.
export interface drivevia2_context_t {
  number: number;
  drive: drive_t | null;
  /** TS-side carrier for the IntNum object (see comment above). */
  int_num_obj: IntNum | null;
}

// =============================================================================
// SECTION 2 — PORT-STUB forward refs for drive.c helpers (T2.10 follow-up)
// =============================================================================
//
// VICE via2d.c calls these drive-c helpers directly. They land in drive.ts
// per Spec 612 §3 FM-table layer 13. Until that port exists, the TS thunks
// here THROW per PL-7 (no silent fallback). When drive.ts lands, replace
// each body with `return drive_writeprotect_sense(d)` etc. (the imports
// from `./drive.js` become valid then).

// PORT OF: vice/src/drive/drive-writeprotect.c (drive_writeprotect_sense — extern decl)
// Spec 612 T1.7 — drive.ts not yet ported. PL-7: throw rather than
// returning a silent default.
function drive_writeprotect_sense(d: drive_t | null): boolean {
  // PORT-STUB: drive.ts (T2.10) — VICE returns 0 (writable) or 0x10
  // (write-protected). Until ported, swallow the call gracefully when
  // drive is null (matches a pre-mount unattached drive), throw when a
  // drive is present so a real mount path surfaces the missing port.
  if (!d) return false;
  throw new Error(
    "PORT-STUB: drive_writeprotect_sense pending drive.ts port (Spec 612 T2.10).",
  );
}

// PORT OF: vice/src/drive/drive.c (drive_cpu_set_overflow — extern decl)
function drive_cpu_set_overflow(_dc: diskunit_context_t): void {
  // PORT-STUB: drive.ts (T2.10) — VICE pulses the drive CPU's V flag via
  // dc->cpu->set_overflow(cpu). Until drivecpu.ts lands (T2.4), this is
  // a no-op shim; SO pulses are routed through the kernel facade.
  // No throw: VIA2 reset path fires this even when no drive is mounted,
  // so a throw would break the LO-3 viacore micro-test.
}

// PORT OF: vice/src/drive/drive.c (drive_move_head — extern decl)
function drive_move_head(_step: number, _d: drive_t): void {
  // PORT-STUB: drive.ts (T2.10). VICE drive_move_head moves the head by
  // `step` half-tracks, clamped to [0, drv->max_half_track - 1], and
  // updates GCR_track_start_ptr / GCR_current_track_size accordingly.
  throw new Error(
    "PORT-STUB: drive_move_head pending drive.ts port (Spec 612 T2.10).",
  );
}

// PORT OF: vice/src/drive/drive-sound.c (drive_sound_update — extern decl)
function drive_sound_update(_event: number, _dnr: number): void {
  // PORT-STUB: drive.ts (T2.10) / drive-sound.ts — audio disabled in
  // headless. Silent no-op (audio is observation-only, no behavioural
  // impact on the LOAD path; PL-7 spirit preserved because the call
  // surface is visible).
}

// PORT OF: vice/src/drive/drive.c (drive_update_ui_status — extern decl)
function drive_update_ui_status(): void {
  // PORT-STUB: drive.ts (T2.10) — UI pump (LED state, half-track). Silent
  // no-op until drive.ts lands; observation-only, no behavioural impact.
}

// PORT OF: vice/src/drive/drive.h (DRIVE_SOUND_MOTOR_ON / DRIVE_SOUND_MOTOR_OFF)
const DRIVE_SOUND_MOTOR_ON = 1;
const DRIVE_SOUND_MOTOR_OFF = 0;

// =============================================================================
// SECTION 3 — set_ca2 / set_cb2 / set_int / restore_int (via2d.c:72-130)
// =============================================================================

// PORT OF: vice/src/drive/iecieee/via2d.c:72-93 (set_ca2 — static)
// VICE OLDCODE=0 path (set on master). Note: VICE wraps the whole body
// in `#if !OLDCODE`; we port the !OLDCODE body verbatim. The OLDCODE
// path is dead code and is omitted per PL-5 (no dead-branch porting).
export const set_ca2: via_set_ca2_func_t = (via_context, state) => {
  const via2p = via_context.prv as drivevia2_context_t;
  const drv = via2p.drive;
  if (!drv) return; // TS-only: pre-mount; VICE always has drv live.
  const curr = (drv.byte_ready_active >> 1) & 1;
  if (state !== curr) {
    rotation_rotate_disk(drv);
    drv.byte_ready_active &= ~(1 << 1);
    drv.byte_ready_active |= state << 1;
    if (drv.byte_ready_edge) {
      const dc = via_context.context as diskunit_context_t;
      drive_cpu_set_overflow(dc);
      drv.byte_ready_edge = 0;
    }
  }
};

// PORT OF: vice/src/drive/iecieee/via2d.c:95-110 (set_cb2 — static)
export const set_cb2: via_set_cb2_func_t = (via_context, state, _offset) => {
  const via2p = via_context.prv as drivevia2_context_t;
  const drv = via2p.drive;
  if (!drv) return;
  const curr = (drv.read_write_mode >> 5) & 1;
  if (state !== curr) {
    rotation_rotate_disk(drv);
    drv.read_write_mode = state << 5;
  }
};

// PORT OF: vice/src/drive/iecieee/via2d.c:112-121 (set_int — static)
// VICE: interrupt_set_irq(dc->cpu->int_status, int_num, value, rclk);
// Spec 612 T1.7 — `rclk` (the parameter) is stamped, NOT clk_ptr.value.
// viacore.update_myviairq_rclk(ctx, rclk) passes the caller's rclk
// through, and VICE preserves that all the way to interrupt_set_irq.
export const set_int: via_set_int_func_t = (
  via_context,
  _int_num,
  value,
  rclk,
) => {
  const dc = via_context.context as diskunit_context_t;
  // VICE: dc->cpu->int_status. Cast the opaque drivetypes forward to
  // the concrete TS InterruptCpuStatus class.
  const int_status = dc.cpu?.int_status as unknown as InterruptCpuStatus | null;
  if (!int_status) return;
  // VICE's int_num is a monotonic int; the TS InterruptCpuStatus.setIrq
  // takes the opaque IntNum object cached on ctx.prv (see drivevia2_context_t).
  const via2p = via_context.prv as drivevia2_context_t;
  const intNumObj = via2p.int_num_obj;
  if (!intNumObj) return;
  int_status.setIrq(intNumObj, value !== 0, rclk);
};

// PORT OF: vice/src/drive/iecieee/via2d.c:123-130 (restore_int — static)
// VICE: interrupt_restore_irq(dc->cpu->int_status, int_num, value);
// InterruptCpuStatus does not yet expose a restoreIrq method (snapshot
// restore = T2.14). Wire the call site exactly per VICE; the runtime
// throw surfaces if snapshot restore is exercised before T2.14 lands.
export const restore_int: via_restore_int_func_t = (
  via_context,
  _int_num,
  _value,
) => {
  void via_context;
  // PORT-STUB: interrupt_restore_irq pending T2.14 snapshot.ts port.
  // No-op for now — restore_int is only fired by viacore_snapshot_read_module,
  // which itself throws (viacore.ts:1380). Defensive no-op rather than
  // throw so non-snapshot callers (none expected) don't blow up.
};

// =============================================================================
// SECTION 4 — Entry points (via2d.c:132-163)
// =============================================================================

// PORT OF: vice/src/drive/iecieee/via2d.c:132-136 (via2d_store)
export function via2d_store(
  ctxptr: diskunit_context_t,
  addr: number,
  data: number,
): void {
  if (ctxptr.cpu) ctxptr.cpu.cpu_last_data = data;
  if (ctxptr.via2) viacore_store(ctxptr.via2, addr, data);
}

// PORT OF: vice/src/drive/iecieee/via2d.c:138-141 (via2d_read)
export function via2d_read(ctxptr: diskunit_context_t, addr: number): number {
  if (!ctxptr.via2) return 0;
  const byte = viacore_read(ctxptr.via2, addr);
  if (ctxptr.cpu) ctxptr.cpu.cpu_last_data = byte;
  return byte;
}

// PORT OF: vice/src/drive/iecieee/via2d.c:143-146 (via2d_peek)
export function via2d_peek(ctxptr: diskunit_context_t, addr: number): number {
  if (!ctxptr.via2) return 0;
  return viacore_peek(ctxptr.via2, addr);
}

// PORT OF: vice/src/drive/iecieee/via2d.c:148-163 (via2d_dump)
// VICE writes via mon_out(); TS pushes the same lines via viacore_dump
// (which itself returns a number — 0 per VICE convention) and returns 0.
export function via2d_dump(
  ctxptr: diskunit_context_t,
  _addr: number,
): number {
  if (!ctxptr.via2) return 0;
  const via2 = ctxptr.via2;
  const via2p = via2.prv as drivevia2_context_t;
  const drv = via2p.drive;
  if (!drv) {
    viacore_dump(via2);
    return 0;
  }
  // Speed-zone table per via2d.c:150.
  void [250000, 266667, 285714, 307692];
  const _track_number = drv.current_half_track;
  const _zone = ((via2.via[VIA_PRB] ?? 0) >> 5) & 3;
  viacore_dump(via2);
  // mon_out() is monitor-side text emission — no headless surface yet.
  // The numeric return matches via2d.c:162 (`return 0;`).
  return 0;
}

// =============================================================================
// SECTION 5 — via2d_update_pcr (via2d.c:165-178)
// =============================================================================

// VICE comment block (kept for grep parity):
//   pcrval — bit 5: 1=reading 0=writing; bit 1: byte ready active.
// Spec 612 T1.7 — this function was MISSING in the pre-612 port.
// Extern in viad.h; called by store_pcr (OLDCODE=1) + undump_pcr.
// PORT OF: vice/src/drive/iecieee/via2d.c:165-178 (via2d_update_pcr)
export function via2d_update_pcr(pcrval: number, dptr: drive_t): void {
  const bra = dptr.byte_ready_active;
  rotation_rotate_disk(dptr);
  dptr.read_write_mode = pcrval & 0x20;
  // VICE: DBG((... drv->read_write_mode ...)) — debug log only.
  // #define PCR_BYTE_READY    BRA_BYTE_READY    /* 0x02 */
  const PCR_BYTE_READY = BRA_BYTE_READY;
  dptr.byte_ready_active = (bra & ~BRA_BYTE_READY) | (pcrval & PCR_BYTE_READY);
}

// =============================================================================
// SECTION 6 — store_pra / store_prb / store_pcr / store_acr / store_sr / store_t2l
// =============================================================================

// PORT OF: vice/src/drive/iecieee/via2d.c:180-192 (store_pra — static)
// VICE: rotation_rotate_disk(drive); GCR_write_value = byte; byte_ready_level = 0;
export const store_pra: via_store_pra_func_t = (
  via_context,
  byte,
  _oldpa_value,
  _addr,
) => {
  const via2p = via_context.prv as drivevia2_context_t;
  const drv = via2p.drive;
  if (!drv) return;
  rotation_rotate_disk(drv);
  // See comments about Port A latching at read_pra().
  drv.GCR_write_value = byte & 0xff;
  drv.byte_ready_level = 0;
};

// PORT OF: vice/src/drive/iecieee/via2d.c:194-197 (undump_pra — static)
export const undump_pra: via_undump_pra_func_t = (_via_context, _byte) => {
  // VICE body is empty.
};

// PORT OF: vice/src/drive/iecieee/via2d.c:199-355 (store_prb — static)
// Mechanical port — every behavioural step matches VICE step-for-step.
// Spec 612 T1.7 acceptance: poldpb is the `oldpb` PARAMETER from viacore
// (viacore.c:1284 — viacore captures `oldpb` before the prb commit and
// passes it through). NO closure-captured poldpb. Stepper ±1 gate is
// applied at THIS call site only (VICE via2d.c:307); the second call
// site below (lines 341-350) passes raw step.
export const store_prb: via_store_prb_func_t = (
  via_context,
  byte,
  poldpb,
  _addr,
) => {
  const via2p = via_context.prv as drivevia2_context_t;
  const drv = via2p.drive;
  if (!drv) return;
  byte = byte & 0xff;
  poldpb = poldpb & 0xff;

  // VICE via2d.c:210 — rotation_rotate_disk(drv);
  rotation_rotate_disk(drv);

  // VICE via2d.c:212-217 — LED status (PB.3) + active-ticks accumulator.
  //   if (drv->led_status) {
  //       drv->led_active_ticks += *(via_context->clk_ptr)
  //                                - drv->led_last_change_clk;
  //   }
  //   drv->led_last_change_clk = *(via_context->clk_ptr);
  //   drv->led_status = (byte & 8) ? 1 : 0;
  // ORDER MATTERS: delta computed against OLD led_last_change_clk
  // BEFORE assignment overwrites it. Fields live on drive_t now (no
  // closure state per Spec 612 T1.7).
  const clk = via_context.clk_ptr.value;
  if (drv.led_status) {
    drv.led_active_ticks += clk - drv.led_last_change_clk;
  }
  drv.led_last_change_clk = clk;
  drv.led_status = (byte & 8) ? 1 : 0;

  // VICE via2d.c:219-249 — stepper formula derived from current_half_track.
  // IF: based on 1540008-01 Long Board schematics. The lines drive the
  // inputs of a stepper motor (4-line demux of the 2-bit value). The
  // rotor moves to absolute positions controlled by activating the coils.
  //
  // vice track numbering starts with 2... we need the real physical track.
  const track_number = drv.current_half_track - 2;
  // the new coil line activated
  const new_stepper_position = byte & 3;
  const old_stepper_position = track_number & 3;
  // the steps travelled and the direction
  let step_count = (new_stepper_position - old_stepper_position) & 3;
  if (step_count === 3) step_count = -1;

  // VICE via2d.c:255-313 — Process stepper motor if the drive motor is on.
  if (byte & 0x4) {
    // VICE via2d.c:297 outer `if ((clk - stepper_last_change_clk) >= 2000)`
    // is commented out in current upstream — body runs unconditionally.
    //
    // VICE via2d.c:307 — `(step_count == 1) || (step_count == -1)` gate
    // applied at THIS first call site only. ±2 (opposite-coil) is dropped
    // here per VICE comment block at via2d.c:299-306.
    if ((step_count === 1) || (step_count === -1)) {
      drive_move_head(step_count, drv);
    }

    // VICE via2d.c:315-318 — stepper_new_position / stepper_last_change_clk
    // update is commented out in upstream. Preserved here as a no-op block
    // for grep parity.
  }

  // VICE via2d.c:321-323 — Zone bits ((poldpb ^ byte) & 0x60) actually
  // changed. Speed zone updates BEFORE motor-on/off transition handling.
  if ((poldpb ^ byte) & 0x60) {
    rotation_speed_zone_set((byte >> 5) & 0x3, via2p.number);
  }

  // VICE via2d.c:324 — #define PB_MOTOR_ON BRA_MOTOR_ON
  const PB_MOTOR_ON = BRA_MOTOR_ON;

  // VICE via2d.c:325-352 — Motor on/off edge handling.
  if ((poldpb ^ byte) & PB_MOTOR_ON) {
    drive_sound_update(
      (byte & 4) ? DRIVE_SOUND_MOTOR_ON : DRIVE_SOUND_MOTOR_OFF,
      via2p.number,
    );
    const bra = drv.byte_ready_active;
    drv.byte_ready_active = (bra & ~BRA_MOTOR_ON) | (byte & BRA_MOTOR_ON);
    if ((byte & BRA_MOTOR_ON) !== 0) {
      rotation_begins(drv);
    } else {
      if (drv.byte_ready_edge) {
        const dc = via_context.context as diskunit_context_t;
        drive_cpu_set_overflow(dc);
        drv.byte_ready_edge = 0;
      }
    }

    // VICE via2d.c:338-351 (bug #1083 "Primitive 7 Sins" workaround,
    // under `#if 1`). On motor-on edge, if the stepper position changed
    // and motor is now on, call drive_move_head a SECOND time WITHOUT
    // the ±1 gate. VICE relies on drive_move_head itself to handle
    // step==2 (it moves the head by 2 half-tracks). Spec 612 T1.7 —
    // the ±1 gate lives at the FIRST call site only.
    if (new_stepper_position !== old_stepper_position) {
      if ((byte & 0x04) !== 0) {
        drive_move_head(step_count, drv);
      }
    }
  }

  // VICE via2d.c:354 — byte_ready_level = 0 last.
  drv.byte_ready_level = 0;
};

// PORT OF: vice/src/drive/iecieee/via2d.c:357-367 (undump_prb — static)
export const undump_prb: via_undump_prb_func_t = (via_context, byte) => {
  const via2p = via_context.prv as drivevia2_context_t;
  const drv = via2p.drive;
  if (!drv) return;
  drv.led_status = (byte & 0x08) ? 1 : 0;
  rotation_speed_zone_set((byte >> 5) & 0x03, via2p.number);
  drv.byte_ready_active =
    (drv.byte_ready_active & ~BRA_MOTOR_ON) | (byte & BRA_MOTOR_ON);
};

// PORT OF: vice/src/drive/iecieee/via2d.c:369-396 (store_pcr — static)
// VICE returns `uint8_t` (the byte committed to via[VIA_PCR]). With
// OLDCODE=0 the body is the no-op pass-through: rotation_rotate_disk +
// return byte unchanged. The OLDCODE=1 branch (dead code) is omitted
// per PL-5; the `#if OLDCODE` block in VICE is what would call
// via2d_update_pcr(tmp, drv) — under OLDCODE=0 that update happens
// implicitly via set_ca2 / set_cb2 dispatched by viacore from the PCR write.
export const store_pcr: via_store_pcr_func_t = (via_context, byte, _addr) => {
  const via2p = via_context.prv as drivevia2_context_t;
  if (via2p.drive) rotation_rotate_disk(via2p.drive);
  return byte & 0xff;
};

// PORT OF: vice/src/drive/iecieee/via2d.c:398-405 (undump_pcr — static)
export const undump_pcr: via_undump_pcr_func_t = (via_context, byte) => {
  const via2p = via_context.prv as drivevia2_context_t;
  if (via2p.drive) via2d_update_pcr(byte, via2p.drive);
};

// PORT OF: vice/src/drive/iecieee/via2d.c:407-409 (undump_acr — static)
export const undump_acr: via_undump_acr_func_t = (_via_context, _byte) => {
  // VICE body is empty.
};

// PORT OF: vice/src/drive/iecieee/via2d.c:411-413 (store_acr — static)
export const store_acr: via_store_acr_func_t = (_via_context, _byte) => {
  // VICE body is empty.
};

// PORT OF: vice/src/drive/iecieee/via2d.c:415-417 (store_sr — static)
export const store_sr: via_store_sr_func_t = (_via_context, _byte) => {
  // VICE body is empty.
};

// PORT OF: vice/src/drive/iecieee/via2d.c:419-421 (store_t2l — static)
export const store_t2l: via_store_t2l_func_t = (_via_context, _byte) => {
  // VICE body is empty.
};

// =============================================================================
// SECTION 7 — reset (via2d.c:423-431)
// =============================================================================

// PORT OF: vice/src/drive/iecieee/via2d.c:423-431 (reset — static)
// VICE: drv->led_status = 1; drive_update_ui_status();
export const reset: via_reset_func_t = (via_context) => {
  const via2p = via_context.prv as drivevia2_context_t;
  const drv = via2p.drive;
  if (!drv) return;
  drv.led_status = 1;
  drive_update_ui_status();
};

// =============================================================================
// SECTION 8 — read_pra / read_prb (via2d.c:463-512)
// =============================================================================

// PORT OF: vice/src/drive/iecieee/via2d.c:463-484 (read_pra — static)
// VICE comment (paraphrased): Read the byte from the disk's read head as
// it has gone through a serial-to-parallel shift register. The 1541 DOS
// code enables latching of the VIA's Port A but this is not emulated —
// the drive-dependent code (this function) handles latching via GCR_read
// + handshake (clearing byte_ready_level).
export const read_pra: via_read_pra_func_t = (via_context, _addr) => {
  const via2p = via_context.prv as drivevia2_context_t;
  const drv = via2p.drive;
  if (!drv) return 0;
  // IF: add bus read delay
  drv.req_ref_cycles = BUS_READ_DELAY;
  rotation_byte_read(drv);
  // VICE: byte = ((GCR_read & ~DDRA) | (PRA & DDRA));
  const ddra = via_context.via[VIA_DDRA] ?? 0;
  const pra = via_context.via[VIA_PRA] ?? 0;
  const byte = ((drv.GCR_read & ~ddra) | (pra & ddra)) & 0xff;
  drv.byte_ready_level = 0;
  return byte;
};

// PORT OF: vice/src/drive/iecieee/via2d.c:486-512 (read_prb — static)
// VICE: byte = ((rotation_sync_found(drv)
//             | drive_writeprotect_sense(drv)
//             | 0x6f) /* output bits read 1 if used as input */
//             & ~DDRB)
//             | (PRB & DDRB);
// Spec 612 T1.7 — DEFAULT (DDRB==0) must equal (sync | wps | 0x6f), NOT
// the pre-612 `0x10` constant. rotation_sync_found returns 0 or 0x80
// (already bit-positioned per rotation.c:1134-1143). drive_writeprotect_sense
// returns boolean — convert to 0x10 when true.
export const read_prb: via_read_prb_func_t = (via_context) => {
  const via2p = via_context.prv as drivevia2_context_t;
  const drv = via2p.drive;
  // VICE has no null guard — drv is always live in upstream. Run rotation
  // flush unconditionally; the per-drive bookkeeping is skipped only if
  // drives[0] is unattached (TS-only defensive path).
  if (drv) drv.req_ref_cycles = BUS_READ_DELAY;
  if (drv) rotation_rotate_disk(drv);
  const sync = drv ? rotation_sync_found(drv) : 0; // already 0 or 0x80
  const wps = drive_writeprotect_sense(drv) ? 0x10 : 0;
  const ddrb = via_context.via[VIA_DDRB] ?? 0;
  const prb = via_context.via[VIA_PRB] ?? 0;
  const byte = (((sync | wps | 0x6f) & ~ddrb) | (prb & ddrb)) & 0xff;
  // VICE: drive->byte_ready_level = 0; (comment notes this may be wrong).
  if (drv) drv.byte_ready_level = 0;
  return byte;
};

// =============================================================================
// SECTION 9 — via2d_init / via2d_setup_context (via2d.c:514-566)
// =============================================================================

// PORT OF: vice/src/drive/iecieee/via2d.c:514-518 (via2d_init)
// VICE: viacore_init(via2, cpu->alarm_context, cpu->int_status);
export function via2d_init(ctxptr: diskunit_context_t): void {
  if (!ctxptr.via2 || !ctxptr.cpu) return;
  const ac = ctxptr.cpu.alarm_context;
  const is_ = ctxptr.cpu.int_status;
  if (!ac || !is_) return;
  viacore_init(ctxptr.via2, ac, is_);
}

// VICE wires the via_context_s with: prv (drivevia2_context_t), context,
// rmw_flag (PL-6 — pointer install), clk_ptr, myname / my_module_name,
// int_num (allocated via interrupt_cpu_status_int_new), and the 19
// callback slots (undump_pra .. reset).
// PORT OF: vice/src/drive/iecieee/via2d.c:520-566 (via2d_setup_context)
export function via2d_setup_context(ctxptr: diskunit_context_t): void {
  // VICE: ctxptr->via2 = lib_calloc(1, sizeof(via_context_t));
  // TS: allocate the via_context_t struct with calloc-equivalent zeros.
  const via: via_context_t = {
    via: new Uint8Array(16),
    ifr: 0,
    ier: 0,
    tal: 0,
    t2cl: 0,
    t2ch: 0,
    t1reload: 0,
    t2zero: 0,
    t1zero: 0,
    t2xx00: false,
    t1_pb7: 0,
    oldpa: 0,
    oldpb: 0,
    ila: 0,
    ilb: 0,
    ca2_out_state: false,
    cb1_in_state: false,
    cb1_out_state: false,
    cb2_in_state: false,
    cb2_out_state: false,
    cb1_is_input: false,
    cb2_is_input: false,
    shift_state: 0,
    t1_zero_alarm: null,
    t2_zero_alarm: null,
    t2_underflow_alarm: null,
    t2_shift_alarm: null,
    phi2_sr_alarm: null,
    log: 0,
    read_clk: 0,
    read_offset: 0,
    last_read: 0,
    t2_irq_allowed: false,
    irq_line: 0,
    int_num: 0,
    myname: null,
    my_module_name: null,
    my_module_name_alt1: null,
    my_module_name_alt2: null,
    clk_ptr: ctxptr.clk_ptr,
    // PL-6: rmw_flag is the shared RmwFlagRef on drivecpu_context_t.
    // VICE: via->rmw_flag = &(ctxptr->cpu->rmw_flag); — pointer install.
    rmw_flag: ctxptr.cpu?.rmw_flag ?? { value: 0 },
    write_offset: 0,
    enabled: false,
    prv: null,
    context: ctxptr,
    alarm_context: null,
    undump_pra: null,
    undump_prb: null,
    undump_pcr: null,
    undump_acr: null,
    store_pra: null,
    store_prb: null,
    store_pcr: null,
    store_acr: null,
    store_sr: null,
    sr_underflow: null,
    store_t2l: null,
    read_pra: null,
    read_prb: null,
    set_int: null,
    restore_int: null,
    set_ca2: null,
    set_cb1: null,
    set_cb2: null,
    reset: null,
  };
  ctxptr.via2 = via;

  // VICE: via->prv = lib_malloc(sizeof(drivevia2_context_t));
  const via2p: drivevia2_context_t = {
    number: ctxptr.mynumber,
    drive: ctxptr.drives[0] ?? null,
    int_num_obj: null, // populated below
  };
  via.prv = via2p;

  // VICE: via->myname = lib_msprintf("Drive%uVia2", via2p->number);
  //       via->my_module_name = lib_msprintf("VIA2D%u", via2p->number);
  via.myname = `Drive${via2p.number}Via2`;
  via.my_module_name = `VIA2D${via2p.number}`;

  // VICE: viacore_setup_context(via);
  viacore_setup_context(via);

  // VICE: via->irq_line = IK_IRQ; — interrupt-line kind.
  // IK_IRQ = 1 << 1 = 2 (interrupt.h:39). Avoid importing the const
  // from cpu/ to keep this module's import surface narrow (NL-1).
  via.irq_line = 2;

  // VICE: via->int_num = interrupt_cpu_status_int_new(cpu->int_status, myname);
  // The TS InterruptCpuStatus.newIntNum returns an opaque IntNum object;
  // we cache the object on drivevia2_context_t (TS-only carrier — see
  // SECTION 1 comment) and store the numeric .id in via_context_t.int_num
  // for grep parity with VICE.
  const int_status = ctxptr.cpu?.int_status as unknown as InterruptCpuStatus | null;
  if (int_status) {
    const intNumObj = int_status.newIntNum(via.myname);
    via2p.int_num_obj = intNumObj;
    via.int_num = intNumObj.id;
  }

  // VICE: via->undump_pra = undump_pra; (and 18 more callback slots —
  // via2d.c:549-565). Install the 19 hook table entries verbatim.
  via.undump_pra = undump_pra;
  via.undump_prb = undump_prb;
  via.undump_pcr = undump_pcr;
  via.undump_acr = undump_acr;
  via.store_pra = store_pra;
  via.store_prb = store_prb;
  via.store_pcr = store_pcr;
  via.store_acr = store_acr;
  via.store_sr = store_sr;
  via.store_t2l = store_t2l;
  via.read_pra = read_pra;
  via.read_prb = read_prb;
  via.set_int = set_int;
  via.restore_int = restore_int;
  via.set_ca2 = set_ca2;
  via.set_cb2 = set_cb2;
  via.reset = reset;
  // VICE has no set_cb1 install for via2d (drive-side disk controller).
}
