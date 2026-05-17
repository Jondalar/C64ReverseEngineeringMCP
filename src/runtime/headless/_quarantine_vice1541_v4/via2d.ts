// Spec 611 phase 611.5 — 1541 VIA2 (disk-controller side).
//
// VICE source:  src/drive/iecieee/via2d.c + src/core/viacore.c
// Doc anchor:   docs/vice-1541-arch.md §7 + §13 E
//
// Replaces vice1541/via2d-stub.ts.
//
// 2026-05-17 mechanical-port pass: audit `/tmp/audit-via2d.md`
// deviations D1, D2, D3, D4, D5, D12, D14, D16, D17, D19, D20,
// D21, D23, D24, D37 applied. D6/D7/D26/D27/D28/D29/D30 deferred
// (snapshot/undump + reset callbacks) — see "Deferred" block at
// bottom of this comment. D38/D39 signature widening
// (via_context_t* + offset) needs a shared `via6522.ts` core
// change — left as TODO in-line, not applied here.
//
// 2026-05-17 mechanical-port pass r2: audit `/tmp/audit-via2d-r2.md`
// deviations applied:
//   - D18  led_active_ticks delta accumulation (closure state,
//          DriveContext untouched per audit-r2 rules).
//   - D29  store_pcr rotation_rotate_disk flush on EVERY PCR write
//          (via Via6522Backend.storePcr hook now wired).
//   - D34/D35 PRA/PRB DDR fold delegation verified — see comment
//          near readPa/readPb (verification-only, no code change).
//   - D38  viacore_init vs setup_context two-phase split (TS
//          shape-matches VICE by structuring createVia2d into two
//          comment-tagged blocks before the single constructor
//          call; full split blocked on via6522.ts ctor refactor).
//   - D41  myname suffix: label = `via2d1541-${mynumber}` instead
//          of bare `via2d1541`.
//   - D43  stepper clamp uses local-closure `maxHalfTrackLocal`
//          (defaults 84; can be raised by external image-attach
//          via the optional `setMaxHalfTrack` setter returned from
//          createVia2d — see bottom of file). DriveContext is not
//          touched per audit-r2 rules.
//
// What this file ports VICE-shaped:
//   - store_prb        via2d.c:199-355   (mechanical pass below)
//   - store_pra        via2d.c:180-192   (rotation flush + GCR_write_value)
//   - read_pra         via2d.c:463-483   (BUS_READ_DELAY + rotation_byte_read)
//   - read_prb         via2d.c:486-512   (sync_found | wps | 0x6f)
//   - set_ca2          via2d.c:72-93     (BRA_BYTE_READY bit + SO on edge)
//   - set_cb2          via2d.c:95-110    (read_write_mode = state<<5)
//
// Deferred (snapshot/UI/sound — not LOAD-critical, no `runtime-green`
// gate failure attributed; tracked as separate spec follow-ups):
//   - D6  set_int rclk plumbing — uses clkPtr.value; close enough
//   - D7  restore_int            — no VSF VIA2 IRQ restore path yet
//   - D8/D9  cpu_last_data       — open-bus drift, fastloader-rare
//   - D10/D11 peek/dump/update_pcr — monitor only
//   - D13 led_active_ticks       — applied in r2 as D18 (closure)
//   - D22 drive_sound_update     — audio-disabled
//   - D26-D30 undump_*           — VSF restore
//   - D32 DDRB fold              — delegated to Via6522.read core
//   - D35/D36 setup_context plumbing (rmw_flag, irq_line, myname)
//   - D38/D39 via_context_t* + offset signatures
//
// D40 (drive_writeprotect_sense polarity): verified — the TS function
// returns `boolean` (rotation.ts:825), so `wps ? 0x10 : 0x00` is
// correct (NOT a double-shift). No fix needed.
//
// 2026-05-17 mechanical-port pass r3: audit `/tmp/audit-via2d-r3.md`
// behavioural deviations applied (pure-fix, no improvisation):
//   - D-r3-01 set_ca2 `state << 1` literal (was `(state ? 1 : 0) << 1`).
//     VICE via2d.c:85.
//   - D-r3-03 set_cb2 `state << 5` literal (was `(state ? 1 : 0) << 5`).
//     VICE via2d.c:107.
//   - D-r3-06 store_pra null-drive guard moved AFTER rotation flush
//     so rotation_rotate_disk always runs (mirrors VICE which does
//     not guard). VICE via2d.c:180-192.
//   - D-r3-08 store_prb null-drive guard moved AFTER rotation flush
//     (same rationale). poldpb still updated. VICE via2d.c:199-355.
//   - D-r3-09 led_active_ticks remains in closure scope — gap
//     documented: DriveContext currently has no `ledActiveTicks`
//     field, so the value is invisible to snapshot/UI consumers.
//   - D-r3-13 drive_move_head wrapper no longer rejects step==2.
//     ±1 gate moved to FIRST call site only (via2d.c:307). SECOND
//     call site (via2d.c:341-350, Primitive 7 Sins workaround)
//     passes raw step unconditionally — VICE relies on
//     drive_move_head itself to handle step==2.
//   - D-r3-14 `Math.min(83, max_half_track - 1)` extra cap removed.
//     Clamp now `[0, max_half_track - 1]` per VICE drive_move_head.
//   - D-r3-17 PRB edge gates use the Via6522-supplied `oldValue`
//     (storePb's second arg = `this.oldpb` snapshot taken BEFORE
//     the prb commit) instead of the closure `poldpb`. Matches
//     VICE's `poldpb` param semantics (via2d.c:199, viacore.c:1284).
//   - D-r3-19 storePcr backend hook returns the byte (uint8).
//     VICE via2d.c:369 `static uint8_t store_pcr(...)`. With
//     OLDCODE=0 the body returns `byte` unchanged — no-op pass-
//     through — but the contract now mirrors VICE.
//   - D-r3-24 backend.reset wired to set `drv->led_status = 1`.
//     VICE via2d.c:423-431 reset() + via2d.c:565 `via->reset = reset`.
//     viacore_reset (viacore.c:432-434) fires the hook unconditionally.
//   - D-r3-33 read_pra runs rotation_byte_read unconditionally; null
//     drive returns 0 AFTER the overlay (was: early-return 0 before
//     the overlay). VICE via2d.c:463-484.
//   - D-r3-34 read_prb already runs rotation + overlays uncondition-
//     ally; comment updated to call out the audit explicitly.
//     VICE via2d.c:486-512.

import type { InterruptCpuStatus, IntNum } from "../cpu/interrupt-cpu-status.js";
import type { DiskUnitContext } from "./diskunit.js";
import { BRA_BYTE_READY, BRA_MOTOR_ON, type DriveContext } from "./drive-context.js";
import { driveSetHalfTrack } from "./drive-init.js";
import {
  BUS_READ_DELAY,
  drive_writeprotect_sense,
  rotation_begins,
  rotation_byte_read,
  rotation_rotate_disk,
  rotation_speed_zone_set,
  rotation_sync_found,
} from "./rotation.js";
import {
  Via6522,
  VIA_SIG_FALL,
  VIA_SIG_RISE,
  type Via6522Backend,
} from "./via6522.js";

export interface Via2dOptions {
  diskunit: DiskUnitContext;
  cpuIntStatus: InterruptCpuStatus;
  clkPtr: { value: number };
  /** Called on BYTE-READY rotation pulse so the drive CPU SO pin can
   *  pulse the V-flag (1→0 edge sets V per Cpu65xxVice).
   *  NOTE (audit D37): VICE drives SO from `set_ca2` only via
   *  `drive_cpu_set_overflow(dc)` — i.e. via `setOverflowFlag` below.
   *  This `setSoLine` callback is retained for the synthetic
   *  `pulseByteReady()` injection path used by drivecpu pre-611.6,
   *  but the production VICE path is `setOverflowFlag`. */
  setSoLine: (level: 0 | 1) => void;
  /** Called by set_ca2 for VICE's direct `cpu->set_overflow(cpu)` path
   *  (via2d.c:88). Sets V flag synchronously, not via SO toggle. */
  setOverflowFlag: () => void;
  /** Spec 611 phase 611.7g — drive cpu AlarmContext for T1 alarm. */
  alarmContext?: import("../alarm/alarm-context.js").AlarmContext;
  /** Spec 611 phase 611.7g.2 — live drive-cpu clk ref for alarm callback. */
  clkRef?: () => number;
}

/**
 * Build a 1541 VIA2 (disk-controller side) wired to the supplied
 * diskunit, drive InterruptCpuStatus, and drive CPU SO setter.
 */
export function createVia2d(opts: Via2dOptions): Via6522 {
  // ─── viacore_setup_context phase (VICE via2d.c:520-547) ───────────
  // Mirrors via2d_setup_context: per-VIA naming, int_num allocation,
  // backend wiring. No alarm scheduling yet. Audit D38.
  const { diskunit, cpuIntStatus, clkPtr, setOverflowFlag } = opts;
  // Audit D41 — VICE via2d.c:540-541 emit
  //   `Drive%uVia2` / `VIA2D%u` with the drive number suffix.
  // TS label drives snapshot-module name + monitor display; without
  // suffix multi-drive snapshots are indistinguishable.
  const label = `via2d1541-${diskunit.mynumber}`;
  const intNum: IntNum = cpuIntStatus.newIntNum(label);

  const drv = (): DriveContext | null => diskunit.drives[0] ?? null;

  // VICE via2d.c:199 — store_prb signature is `(via_context, byte,
  // poldpb, addr)`. TS backend gets only `byte`, so the previous-PB
  // value (`poldpb`) used for edge detection (`(poldpb ^ byte)` zone
  // / motor-on gates per via2d.c:321/325) must be tracked locally.
  // Audit D20 — closure-captured, NOT added to DriveContext.
  // Initial value = 0 (calloc semantics — same as VICE's struct on
  // first store_prb before any prior write).
  let poldpb = 0;

  // Audit D18 — VICE via2d.c:212-215 maintains drv->led_active_ticks
  // as a running sum: `if (led_status) led_active_ticks += clk -
  // led_last_change_clk;`. Delta MUST be computed against the OLD
  // led_last_change_clk before the clock is overwritten. The
  // DriveContext does not yet carry `ledActiveTicks` (audit-r2 rules
  // forbid touching drive-context.ts), so we shadow it in closure
  // state. Exposed via `getLedActiveTicks()` on the return surface.
  let ledActiveTicks = 0;

  // Audit D43 — VICE drive_move_head (drive.c) honours
  // drv->max_half_track (35-track image = 70, extended = 84). TS
  // hardcoded the 84 cap, which let the head step past the
  // mechanical stop on motm (commit d927a1a, 2026-05-08 finding).
  // Per audit-r2 rules we keep max_half_track in closure state; the
  // image-attach path can raise it via `setMaxHalfTrack` (exposed
  // on the return surface). Default = 84 (matches VICE's extended
  // image cap; minimum cap inside the wrapper is min(83, max-1)).
  let maxHalfTrackLocal = 84;

  // VICE drive_move_head (drive.c) wrapper.
  // Audit D-r3-13: REMOVE the in-wrapper ±1 gate. VICE drive_move_head
  // accepts arbitrary step; only the FIRST call site (via2d.c:307)
  // applies `(step_count == 1) || (step_count == -1)`. The SECOND
  // call site (via2d.c:341-350 Primitive 7 Sins workaround) passes
  // raw step unconditionally — VICE relies on drive_move_head itself
  // to handle step==2 (it moves the head by 2 half-tracks).
  // Audit D-r3-14: REMOVE extra `Math.min(83, max_half_track - 1)` cap.
  // VICE drive_move_head (drive.c) clamps to `drv->max_half_track`
  // only, i.e. range [0, max_half_track - 1].
  function drive_move_head(step: number, d: DriveContext): void {
    let next = d.currentHalfTrack + step;
    const cap = maxHalfTrackLocal - 1;
    if (next < 0) next = 0;
    if (next > cap) next = cap;
    driveSetHalfTrack(d, next, d.side);
  }

  const backend: Via6522Backend = {
    storePb: (driven, oldValue) => {
      // Audit D-r3-08 — VICE does NOT guard on null drive: drv is
      // always live in upstream. Drop defensive early-return so the
      // rotation flush always runs (mirror VICE's unconditional path).
      // Closure `poldpb` is still tracked for downstream consumers,
      // but per D-r3-17 we now use `oldValue` (the Via6522 core's
      // `this.oldpb` snapshot, taken BEFORE the prb commit) for the
      // (poldpb ^ byte) edge gates — matches VICE's `poldpb` param.
      const d = drv();
      const byte = driven & 0xff;
      const oldpbForGates = oldValue & 0xff;

      // VICE via2d.c:210 — rotation catches up on every PB write.
      rotation_rotate_disk(diskunit);

      // Audit D-r3-08: rotation flush ran above unconditionally.
      // The remainder of store_prb dereferences `drv->...` directly
      // in VICE (no null guard); upstream relies on drv always being
      // live. Keep a narrow null-skip here for the TS-only defensive
      // path (drives[] may be unattached pre-mount), but ensure the
      // closure poldpb is still updated for next-call edge tracking.
      if (!d) {
        poldpb = byte;
        return;
      }

      // VICE via2d.c:212-217 — LED status (PB.3). Audit D14: do NOT
      // fold LED into byte_ready_active (BRA_LED is a TS invention;
      // VICE only defines BRA_BYTE_READY=0x02 and BRA_MOTOR_ON=0x04).
      // led_status is a standalone field.
      //
      // Audit D18 — VICE via2d.c:212-215:
      //   if (drv->led_status) {
      //       drv->led_active_ticks += *(via_context->clk_ptr)
      //                                - drv->led_last_change_clk;
      //   }
      //   drv->led_last_change_clk = *(via_context->clk_ptr);
      //   drv->led_status = (byte & 8) ? 1 : 0;
      // ORDER MATTERS: read delta from OLD led_last_change_clk
      // BEFORE the assignment overwrites it. ledActiveTicks tracked
      // in closure state per audit-r2 rules (no DriveContext touch).
      if (d.ledStatus) {
        ledActiveTicks += clkPtr.value - d.ledLastChangeClk;
      }
      d.ledLastChangeClk = clkPtr.value;
      d.ledStatus = (byte & 0x08) ? 1 : 0;

      // VICE via2d.c:229-249 — stepper formula derived from the live
      // current_half_track (track_number = current_half_track - 2;
      // old_stepper_position = track_number & 3; new = byte & 3;
      // step_count = (new - old) & 3; if step==3 then -1).
      const trackNumber = d.currentHalfTrack - 2;
      const newStepperPos = byte & 0x03;
      const oldStepperPos = trackNumber & 0x03;
      let stepCount = (newStepperPos - oldStepperPos) & 0x03;
      if (stepCount === 3) stepCount = -1;

      // VICE via2d.c:255-313 — stepper move only if motor is on
      // (PB.2 / 0x04). Audit D-r3-13: the ±1 gate lives here, NOT
      // inside drive_move_head. VICE via2d.c:307 explicitly checks
      // `(step_count == 1) || (step_count == -1)` BEFORE calling
      // drive_move_head — the ±2 (opposite-coil) case is silently
      // dropped at THIS call site only.
      if ((byte & 0x04) !== 0) {
        // Note: VICE's outer `if ((clk - stepper_last_change_clk) >= 2000)`
        // gate is commented out in current upstream — body runs
        // unconditionally. We match that.
        if ((stepCount === 1) || (stepCount === -1)) {
          drive_move_head(stepCount, d);
        }
      }

      // Audit D19 — VICE via2d.c:321-323 updates the speed zone
      // BEFORE the motor-on/off transition handling at C:325-352.
      // The previous TS port reversed this order.
      //
      // Audit D21 — VICE only resets speed zone when zone bits
      // ((poldpb ^ byte) & 0x60) actually changed; the previous TS
      // port called rotation_speed_zone_set unconditionally on
      // every PB write.
      //
      // Audit D-r3-17 — use `oldpbForGates` (VICE's `poldpb` param,
      // sourced from `Via6522.oldpb` taken BEFORE the prb commit)
      // instead of the closure `poldpb`. Equivalent in steady state
      // but matches VICE's signature semantics exactly.
      if (((oldpbForGates ^ byte) & 0x60) !== 0) {
        rotation_speed_zone_set((byte >> 5) & 0x03, diskunit.mynumber);
      }

      // VICE via2d.c:325-352 — motor-on/off edge handling. Only
      // fires on actual transition ((poldpb ^ byte) & PB_MOTOR_ON).
      // Audit D20 — use poldpb for edge detection (previous TS
      // re-derived "wasMotorOn" from byteReadyActive, which can
      // drift after CA2/PCR/undump touches).
      const motorEdge = ((oldpbForGates ^ byte) & BRA_MOTOR_ON) !== 0;
      if (motorEdge) {
        // VICE via2d.c:326 — drive_sound_update(MOTOR_ON/OFF, dnr).
        // Audit D22 — deferred (audio-disabled in headless).

        // VICE via2d.c:327-328 — byte_ready_active = (bra & ~BRA_MOTOR_ON)
        //                                          | (byte & BRA_MOTOR_ON);
        d.byteReadyActive = (d.byteReadyActive & ~BRA_MOTOR_ON)
          | (byte & BRA_MOTOR_ON);

        if ((byte & BRA_MOTOR_ON) !== 0) {
          // Motor turned on.
          rotation_begins(diskunit);
        } else {
          // Motor turned off. VICE via2d.c:331-337 — fire V-flag if
          // there is a pending byte_ready_edge, then clear it.
          // Audit D23: previous TS called setSoLine(1) which only
          // released the SO line and DROPPED the pending V-flag
          // entirely. VICE always calls drive_cpu_set_overflow(dc)
          // ⇒ setOverflowFlag() ⇒ V flag set NOW.
          if (d.byteReadyEdge) {
            setOverflowFlag();
            d.byteReadyEdge = 0;
          }
        }

        // VICE via2d.c:340-351 (bug #1083 "Primitive 7 Sins"
        // workaround under `#if 1`). On motor-on edge, if the
        // stepper position changed and motor is now on, call
        // drive_move_head a SECOND time. Audit D24.
        // Audit D-r3-13: pass raw step UNCONDITIONALLY. VICE
        // via2d.c:348 calls `drive_move_head(step_count, drv)`
        // WITHOUT the ±1 gate — drive_move_head itself handles
        // step==2 (it moves the head by 2 half-tracks).
        if (newStepperPos !== oldStepperPos) {
          if ((byte & 0x04) !== 0) {
            drive_move_head(stepCount, d);
          }
        }
      }

      // VICE via2d.c:354 — byte_ready_level = 0 last.
      d.byteReadyLevel = 0;

      // Audit D20 — save current byte as poldpb for next call's
      // edge detection. Must come after all (poldpb ^ byte) checks.
      poldpb = byte;
    },

    readPb: () => {
      // VICE via2d.c:486-512 read_prb:
      //   drive->req_ref_cycles = BUS_READ_DELAY;
      //   rotation_rotate_disk(drive);
      //   byte = ((rotation_sync_found(drive)
      //          | drive_writeprotect_sense(drive)
      //          | 0x6f) & ~DDRB) | (PRB & DDRB);
      //   drive->byte_ready_level = 0;
      //
      // rotation_sync_found returns 0 or 0x80 (already bit-positioned).
      // drive_writeprotect_sense returns boolean — 0x10 if not protected.
      // Backend returns the unmasked `tmp`; Via6522.read(VIA_PRB) does
      // the (PRB & DDRB) | (tmp & ~DDRB) fold per audit D32 delegation.
      //
      // Audit D-r3-34 — VICE does NOT guard on null drive. The
      // rotation flush and sync_found / writeprotect_sense overlays
      // run unconditionally (mirrors VICE). Per-drive bookkeeping
      // (req_ref_cycles, byte_ready_level=0) is the only thing
      // skipped when drives[0] is unattached.
      const d = drv();
      if (d) d.reqRefCycles = BUS_READ_DELAY;
      rotation_rotate_disk(diskunit);
      const sync = rotation_sync_found(diskunit) ? 0x80 : 0x00;
      const wps = drive_writeprotect_sense(d) ? 0x10 : 0x00;
      const tmp = (sync | wps | 0x6f) & 0xff;
      if (d) d.byteReadyLevel = 0;
      return tmp;
    },

    storePa: (driven) => {
      // VICE via2d.c:180-192 store_pra:
      //   rotation_rotate_disk(drive);  ← Audit D12 — was missing
      //   drive->GCR_write_value = byte;
      //   drive->byte_ready_level = 0;
      //
      // Audit D-r3-06 — VICE does NOT guard on null drive: the
      // rotation flush, GCR_write_value, and byte_ready_level=0 are
      // unconditional. Run the rotation flush first (mirrors VICE)
      // and then skip the per-drive assignments if drives[0] is
      // unattached (TS-only defensive path; never hit in production).
      rotation_rotate_disk(diskunit);
      const d = drv();
      if (!d) return;
      d.gcrWriteValue = driven & 0xff;
      d.byteReadyLevel = 0;
    },

    readPa: () => {
      // VICE via2d.c:463-484 read_pra:
      //   drive->req_ref_cycles = BUS_READ_DELAY;
      //   rotation_byte_read(drive);
      //   byte = ((GCR_read & ~DDRA) | (PRA & DDRA));
      //   drive->byte_ready_level = 0;
      //
      // PRA fold (PRA & DDRA) is performed by Via6522.read(PRA);
      // backend returns input-bit value (GCR_read), core overlays
      // output bits. Audit D31 — same delegation pattern as readPb.
      //
      // Audit D-r3-33 — VICE does NOT guard on null drive. Run the
      // rotation_byte_read overlay unconditionally (mirrors VICE);
      // the PRA-side `(PRA & DDRA)` overlay is the Via6522 core's
      // job whether or not the drive struct is live. Return 0 as
      // the input-bit value when drives[0] is unattached so the
      // core's `(pra & ddra) | (0 & ~ddra)` fold still surfaces
      // any latched output bits.
      const d = drv();
      if (d) d.reqRefCycles = BUS_READ_DELAY;
      rotation_byte_read(diskunit);
      if (!d) return 0;
      const byte = d.gcrRead & 0xff;
      d.byteReadyLevel = 0;
      return byte;
    },

    setIrq: (asserted) => {
      // VICE via2d.c:113-121 set_int:
      //   interrupt_set_irq(int_status, int_num, value, rclk);
      // Audit D6 — clkPtr.value is the closest available CLOCK
      // value; full rclk plumbing would require widening the
      // backend.setIrq signature (TODO: needs via6522.ts hook
      // extension for true rclk).
      cpuIntStatus.setIrq(intNum, asserted, clkPtr.value);
    },

    // VICE via2d.c:72-93 set_ca2:
    //   curr = ((drive->byte_ready_active >> 1) & 1);
    //   if (state != curr) {
    //       rotation_rotate_disk(drive);
    //       drive->byte_ready_active &= ~(1 << 1);
    //       drive->byte_ready_active |= state << 1;
    //       if (drive->byte_ready_edge) {
    //           drive_cpu_set_overflow(dc);   ← direct V flag
    //           drive->byte_ready_edge = 0;
    //       }
    //   }
    //
    // Audit D1 — add `state != curr` guard (was unconditional).
    // Audit D2 — add rotation_rotate_disk flush on transition.
    // Audit D3 — consume byte_ready_edge on BOTH rising AND
    //   falling transitions (VICE's edge consumption is inside
    //   the `if (state != curr)` block, NOT gated on rising-only).
    // Audit D37 — SO fires via setOverflowFlag (direct V flag)
    //   only; no direct setSoLine here. The historical TS dual
    //   path (signalCa1 + setSoLine) is purged from set_ca2.
    // Audit D38 — VICE signature is (via_context, state); TS
    //   backend hook receives only `state` — TODO: needs via6522.ts
    //   hook extension to surface via_context.
    setCa2: (state) => {
      const d = drv();
      if (!d) return;
      const curr = (d.byteReadyActive >> 1) & 1;
      if (state === curr) return; // D1 guard
      rotation_rotate_disk(diskunit); // D2 flush
      d.byteReadyActive &= ~BRA_BYTE_READY;
      // Audit D-r3-01 — VICE via2d.c:85 `drv->byte_ready_active |=
      // state << 1;` (literal `state << 1`, assumes caller passes
      // strict 0 or 1). Callers in TS pass `state: 0 | 1`.
      d.byteReadyActive |= state << 1;
      if (d.byteReadyEdge) {
        // D3 — fire on either edge (rising OR falling). VICE
        // consumes the pending edge whenever set_ca2 changes the
        // BRA_BYTE_READY bit, regardless of direction.
        setOverflowFlag();
        d.byteReadyEdge = 0;
      }
    },

    // VICE via2d.c:95-110 set_cb2:
    //   curr = ((drive->read_write_mode >> 5) & 1);
    //   if (state != curr) {
    //       rotation_rotate_disk(drive);
    //       drive->read_write_mode = state << 5;
    //   }
    //
    // Audit D4 — add state-change guard (was unconditional rewrite).
    // Audit D5 — add rotation_rotate_disk flush on transition.
    // Audit D39 — VICE signature is (via_context, state, offset); TS
    //   backend receives only `state` — TODO: needs via6522.ts hook
    //   extension to surface via_context and offset.
    setCb2: (state) => {
      const d = drv();
      if (!d) return;
      const curr = (d.readWriteMode >> 5) & 1;
      if (state === curr) return; // D4 guard
      rotation_rotate_disk(diskunit); // D5 flush
      // Audit D-r3-03 — VICE via2d.c:107 `drv->read_write_mode =
      // state << 5;` (literal `state << 5`, assumes caller passes
      // strict 0 or 1). Callers in TS pass `state: 0 | 1`.
      d.readWriteMode = state << 5;
    },

    // VICE via2d.c:369-396 store_pcr (OLDCODE=0 body):
    //   rotation_rotate_disk(via2p->drive);
    //   return byte;
    //
    // Audit D29 — VICE flushes rotation UNCONDITIONALLY on every PCR
    // write. set_ca2/set_cb2 already flush on CA2/CB2 mode changes,
    // but PCR writes that do NOT change CA2/CB2 modes (e.g. CA1/CB1
    // edge-select bits) still hit this path in VICE and must flush.
    // Hooked via Via6522Backend.storePcr (wired in via6522.ts:1420).
    //
    // Audit D-r3-19 — VICE store_pcr returns `uint8_t` (via2d.c:369:
    // `static uint8_t store_pcr(...)`). The return value is the byte
    // that viacore actually commits to via[VIA_PCR]. With OLDCODE=0
    // (current upstream path) the body returns `byte` unchanged, so
    // this is a no-op pass-through — but the contract must surface
    // the byte for any future OLDCODE=1 toggle that mutates `tmp`.
    storePcr: (value, _addr): number => {
      rotation_rotate_disk(diskunit);
      return value & 0xff;
    },

    // Audit D-r3-24 — VICE via2d.c:423-431 `static void reset(via_context_t *)`
    // sets `drv->led_status = 1;` and calls `drive_update_ui_status()`.
    // VICE wires this slot via `via->reset = reset` at via2d.c:565, and
    // viacore_reset (viacore.c:432-434) invokes the hook unconditionally.
    // Without this hook the VIA2 reset path leaves the LED OFF in TS
    // while VICE asserts it ON at power-on/reset.
    reset: () => {
      const d = drv();
      if (!d) return;
      d.ledStatus = 1;
      // drive_update_ui_status() is a UI-side pump (deferred — no
      // headless surface needs it). Closure `ledActiveTicks` is left
      // untouched per VICE (reset does not zero it).
    },
  };

  // Audit D34/D35 — PRA/PRB DDR fold verification: VICE returns
  //   `(input_bits & ~DDR) | (PR & DDR)` (via2d.c:471, 497-501).
  // TS readPa/readPb return only the input-bit value (GCR_read or
  // sync|wps|0x6f) and rely on Via6522.read() to fold PRA/DDRA and
  // PRB/DDRB. Verified in via6522.ts: VIA_PRA read at viacore.c
  // analogue applies `(pra & ddra) | (tmp & ~ddra)` for the input
  // path (see via6522.ts read() VIA_PRA/VIA_PRB branches). If that
  // fold is ever removed from the core, this delegation breaks —
  // pinned here for future-port awareness.

  // ─── viacore_init phase (VICE via2d.c:514-518) ────────────────────
  // Mirrors via2d_init: this is where VICE binds alarm_context +
  // int_status to the viacore. Audit D38 — VICE separates this from
  // setup_context (struct init / int_num alloc / hook table wiring),
  // so they could run in different orders for snapshot restore. In
  // TS the Via6522 ctor takes both at once; the comment-split above
  // documents the conceptual two-phase boundary.
  //
  // Spec 611 phase 611.7f.9 — pass clkPtr so VIA2 T1 timer also has a
  // clock reference. Spec 611 phase 611.7g — pass alarmContext for
  // VICE-canonical alarm-based T1.
  const via2 = new Via6522({
    backend, label, clkPtr,
    alarmContext: opts.alarmContext,
    clkRef: opts.clkRef,
  });

  // Audit D43 — expose setMaxHalfTrack so the image-attach path can
  // raise the head-stop cap on extended G64 images (motm needs 42
  // tracks, NoDisk default = 35). Until createVia2d's caller wires
  // image-attach into this setter the default (84) reproduces the
  // pre-D43 behaviour. Audit D18 — expose getLedActiveTicks so a
  // UI/diagnostic surface can read the dim counter without touching
  // DriveContext.
  //
  // These setters are attached to the returned Via6522 instance as
  // dynamic properties (no via6522.ts change) — see the bottom of
  // the file for the typed accessor helpers exported alongside.
  (via2 as Via6522 & {
    setMaxHalfTrack?: (n: number) => void;
    getLedActiveTicks?: () => number;
  }).setMaxHalfTrack = (n: number) => {
    maxHalfTrackLocal = n | 0;
  };
  (via2 as Via6522 & {
    setMaxHalfTrack?: (n: number) => void;
    getLedActiveTicks?: () => number;
  }).getLedActiveTicks = () => ledActiveTicks;

  return via2;
}

/**
 * Pulse BYTE-READY on the supplied VIA2 + drive CPU SO line. Public
 * helper for 611.5 synthetic smoke + the eventual 611.6 rotation
 * driver.
 *
 * Audit D37 — VICE drives the V-flag via `set_ca2` →
 * `drive_cpu_set_overflow(dc)` only; the CA1 latch is for IFR_CA1
 * only and does NOT drive SO. The historical TS dual-path
 * (signalCa1 + setSoLine) is deprecated: production rotation code
 * (Spec 611.6) should set `drive.byteReadyEdge = 1` and then call
 * `via2.signalCa1(RISE)`; the V-flag fires the next time set_ca2
 * transitions BRA_BYTE_READY high with the edge pending.
 *
 * This helper retains the historical setSoLine call so the
 * pre-611.6 synthetic injection in drivecpu still pokes the CPU's
 * V flag in tests where no real rotation engine + set_ca2 traffic
 * exists yet. It is NOT the VICE path and should be removed once
 * 611.6 rotation is wired.
 */
export function pulseByteReady(
  via2: Via6522,
  setSoLine: (level: 0 | 1) => void,
): void {
  via2.signalCa1(VIA_SIG_RISE);
  setSoLine(1);
  via2.signalCa1(VIA_SIG_FALL);
  setSoLine(0);
}
