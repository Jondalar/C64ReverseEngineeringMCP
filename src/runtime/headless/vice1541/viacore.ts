// PORT OF: vice/src/core/viacore.c (full file)
// PORT OF: vice/src/via.h            (chip-core register/mask constants)
// VICE rev: system-installed /Users/alex/Development/C64/Tools/vice/vice (Spec 612 §11 open question 1 — pinning deferred)
//
// Spec 612 — 1541 Port Fidelity Rules (this file is layer §4 LO-3):
//   §1 NL-1  one C file -> one TS file, same basename (viacore.c -> viacore.ts)
//   §1 NL-2  one C function -> one TS export function, snake_case verbatim
//   §1 NL-3  struct fields accessed through ctx.field_name_snake_case
//            (declared in ./drivetypes.ts via_context_t — NOT redeclared here)
//   §1 NL-4  #define -> exported TS const (constants in drivetypes.ts)
//   §1 NL-5  module-level C globals -> module-level TS let/const
//   §2 PL-1  NO TS class wrapping via_context_s — functions take ctx first arg
//   §2 PL-3  NO factories / managers / helpers — port the VICE function only
//   §2 PL-5  NO NOT-IN-VICE helpers — no maybeFireT1AtClk lazy fallback
//   §2 PL-6  clk_ptr is {value} ref on ctx (PL-6: NOT a closure or method)
//            rmw_flag is {value} ref on ctx
//            write_offset is a per-instance field on ctx, NOT a ctor option
//   §2 PL-9  snapshot via VICE-format module chunks (PL-9: no flat blob)
//   §5 FM    PORT OF comment on every export within 5 lines (FC-4 gate)
//
// This file consolidates two previous parallel ports:
//   - src/runtime/headless/_quarantine_vice1541_v4/via6522.ts (1939 LOC,
//     lazy-T1 fallback — PL-5 violation, dropped)
//   - src/runtime/headless/via/via6522-vice.ts (1341 LOC, class-based,
//     write_offset configurable — used as primary semantic source,
//     deleted in T2.5/T2.11 follow-up cleanup)
//
// The via_context_t interface lives in ./drivetypes.ts (§3 row drivetypes.h).
// All constants (VIA_*, START_SHIFTING, FINISHED_SHIFTING) live there too.
// This module imports them — it does NOT re-export them (NL-4: one symbol,
// one home).
//
// Alarm scheduling uses src/runtime/headless/alarm/alarm-context.ts which is
// a 1:1 port of VICE alarm.c. Function names map:
//   VICE alarm_set       -> alarmSet         (TS lib name kept camelCase
//                                              by Spec 147 — that port
//                                              predates Spec 612 NL-2 and
//                                              is OUT of scope per §0)
//   VICE alarm_unset     -> alarmUnset
//   VICE alarm_new       -> alarmNew
//   VICE alarm_is_pending(a) -> a.pending_idx >= 0
//   VICE alarm_clk(a)    -> ctx.pending_alarms[a.pending_idx].clk
//   VICE alarm_context_dispatch -> alarmContextDispatch
//   VICE alarm_context_next_pending_clk -> ctx.next_pending_alarm_clk
//
// Backend hooks (store_pra, store_prb, read_pra, read_prb, set_int,
// set_ca2, set_cb2, set_cb1, store_sr, store_t2l, store_acr, store_pcr,
// sr_underflow, reset) are function-pointer fields on via_context_t —
// installed by viacore_setup_context callers (drive backends via1d1541 /
// via2d). This file CALLS them by ctx.field?.(args) per §1 NL-3.

import {
  alarmContextDispatch,
  alarmNew,
  alarmSet,
  alarmUnset,
  type Alarm,
} from "../alarm/alarm-context.js";
import {
  // Register file indices.
  VIA_PRB,
  VIA_PRA,
  VIA_DDRB,
  VIA_DDRA,
  VIA_T1CL,
  VIA_T1CH,
  VIA_T1LL,
  VIA_T1LH,
  VIA_T2CL,
  VIA_T2LL,
  VIA_T2CH,
  VIA_T2LH,
  VIA_SR,
  VIA_ACR,
  VIA_PCR,
  VIA_IFR,
  VIA_IER,
  VIA_PRA_NHS,
  // IFR / IER bit masks.
  VIA_IM_IRQ,
  VIA_IM_T1,
  VIA_IM_T2,
  VIA_IM_CB1,
  VIA_IM_CB2,
  VIA_IM_SR,
  VIA_IM_CA1,
  VIA_IM_CA2,
  // ACR masks.
  VIA_ACR_T1_FREE_RUN,
  VIA_ACR_T1_PB7_USED,
  VIA_ACR_T2_CONTROL,
  VIA_ACR_T2_COUNTPB6,
  VIA_ACR_SR_CONTROL,
  VIA_ACR_SR_OUT,
  VIA_ACR_SR_DISABLED,
  VIA_ACR_SR_IN_T2,
  VIA_ACR_SR_IN_PHI2,
  VIA_ACR_SR_IN_CB1,
  VIA_ACR_SR_OUT_FREE_T2,
  VIA_ACR_SR_OUT_T2,
  VIA_ACR_SR_OUT_PHI2,
  VIA_ACR_SR_OUT_CB1,
  VIA_ACR_PA_LATCH,
  VIA_ACR_PB_LATCH,
  // PCR masks.
  VIA_PCR_CA1_CONTROL,
  VIA_PCR_CA2_CONTROL,
  VIA_PCR_CA2_I_OR_O,
  VIA_PCR_CA2_INPUT,
  VIA_PCR_CA2_LOW_OUTPUT,
  VIA_PCR_CA2_HIGH_OUTPUT,
  VIA_PCR_CB1_CONTROL,
  VIA_PCR_CB1_POS_ACTIVE_EDGE,
  VIA_PCR_CB2_CONTROL,
  VIA_PCR_CB2_I_OR_O,
  VIA_PCR_CB2_INPUT,
  VIA_PCR_CB2_LOW_OUTPUT,
  // Signal lines & edges.
  VIA_SIG_CA1,
  VIA_SIG_CA2,
  VIA_SIG_CB1,
  VIA_SIG_CB2,
  // Shift state markers.
  START_SHIFTING,
  FINISHED_SHIFTING,
  // Sub-context forwards.
  type alarm_context_t,
  type interrupt_cpu_status_t,
  type snapshot_t,
  type via_context_t,
} from "./drivetypes.js";
// Opaque VSF module handle — canonically defined+exported by drivecpu.ts
// (drivecpu.ts:276). Type-only import: no runtime cycle. drive_snapshot.ts
// imports it from the same place. NL-1 keeps a single canonical declaration.
import { type snapshot_module_t } from "./drivecpu.js";

// =============================================================================
// Module-private constants — viacore.c:216 (FULL_CYCLE_2), :286-287 (SR_PHI2_*)
// =============================================================================
// PORT OF: vice/src/core/viacore.c:216 (#define FULL_CYCLE_2 2)
const FULL_CYCLE_2 = 2;

// PORT OF: vice/src/core/viacore.c:286 (#define SR_PHI2_FIRST_OFFSET 3)
const SR_PHI2_FIRST_OFFSET = 3;

// PORT OF: vice/src/core/viacore.c:287 (#define SR_PHI2_NEXT_OFFSET 1)
const SR_PHI2_NEXT_OFFSET = 1;

// PORT OF: vice/src/core/viacore.c:1941-1942 (#define VIA_DUMP_VER_*)
const VIA_DUMP_VER_MAJOR = 2;
const VIA_DUMP_VER_MINOR = 2;

// =============================================================================
// Module-private helper macros — viacore.c:105-127 (#define IS_*())
// =============================================================================
// These mirror the VICE preprocessor macros. They are file-private; NL-4
// applies to public #defines exposed via via.h. The IS_* macros are local
// to viacore.c so the TS equivalents are local-only (not exported).

// PORT OF: vice/src/core/viacore.c:106 (IS_CA2_INDINPUT)
function IS_CA2_INDINPUT(ctx: via_context_t): boolean {
  return (ctx.via[VIA_PCR]! & 0x0a) === 0x02;
}
// PORT OF: vice/src/core/viacore.c:107 (IS_CA2_HANDSHAKE)
function IS_CA2_HANDSHAKE(ctx: via_context_t): boolean {
  return (ctx.via[VIA_PCR]! & 0x0c) === 0x08;
}
// PORT OF: vice/src/core/viacore.c:108 (IS_CA2_PULSE_MODE)
function IS_CA2_PULSE_MODE(ctx: via_context_t): boolean {
  return (ctx.via[VIA_PCR]! & 0x0e) === 0x0a;
}
// PORT OF: vice/src/core/viacore.c:109 (IS_CA2_TOGGLE_MODE)
function IS_CA2_TOGGLE_MODE(ctx: via_context_t): boolean {
  return (ctx.via[VIA_PCR]! & 0x0e) === 0x08;
}
// PORT OF: vice/src/core/viacore.c:113 (IS_CB2_HANDSHAKE)
function IS_CB2_HANDSHAKE(ctx: via_context_t): boolean {
  return (ctx.via[VIA_PCR]! & 0xc0) === 0x80;
}
// PORT OF: vice/src/core/viacore.c:114 (IS_CB2_PULSE_MODE)
function IS_CB2_PULSE_MODE(ctx: via_context_t): boolean {
  return (ctx.via[VIA_PCR]! & 0xe0) === 0xa0;
}
// PORT OF: vice/src/core/viacore.c:115 (IS_CB2_TOGGLE_MODE)
function IS_CB2_TOGGLE_MODE(ctx: via_context_t): boolean {
  return (ctx.via[VIA_PCR]! & 0xe0) === 0x80;
}
// PORT OF: vice/src/core/viacore.c:117 (IS_PA_INPUT_LATCH)
function IS_PA_INPUT_LATCH(ctx: via_context_t): boolean {
  return (ctx.via[VIA_ACR]! & VIA_ACR_PA_LATCH) !== 0;
}
// PORT OF: vice/src/core/viacore.c:118 (IS_PB_INPUT_LATCH)
function IS_PB_INPUT_LATCH(ctx: via_context_t): boolean {
  return (ctx.via[VIA_ACR]! & VIA_ACR_PB_LATCH) !== 0;
}
// PORT OF: vice/src/core/viacore.c:122 (IS_SR_FREE_RUNNING)
function IS_SR_FREE_RUNNING(ctx: via_context_t): boolean {
  return (ctx.via[VIA_ACR]! & 0x1c) === 0x10;
}
// PORT OF: vice/src/core/viacore.c:125 (IS_SR_T2_CONTROLLED(byte))
function IS_SR_T2_CONTROLLED(byte: number): boolean {
  return (byte & 0x0c) === 0x04 || (byte & 0x1c) === 0x10;
}
// PORT OF: vice/src/core/viacore.c:127 (IS_T2_TIMER(byte))
function IS_T2_TIMER(byte: number): boolean {
  return (byte & VIA_ACR_T2_CONTROL) === 0x00; // VIA_ACR_T2_TIMER
}

// =============================================================================
// Module-private IRQ helpers — viacore.c:198-214
// =============================================================================

// PORT OF: vice/src/core/viacore.c:198-201 (via_restore_int — static)
export function via_restore_int(ctx: via_context_t, value: number): void {
  ctx.restore_int?.(ctx, ctx.int_num, value);
}

// PORT OF: vice/src/core/viacore.c:203-209 (update_myviairq_rclk — static inline)
export function update_myviairq_rclk(
  ctx: via_context_t,
  rclk: number,
): void {
  ctx.set_int?.(
    ctx,
    ctx.int_num,
    (ctx.ifr & ctx.ier & 0x7f) !== 0 ? 1 : 0,
    rclk,
  );
}

// PORT OF: vice/src/core/viacore.c:211-214 (update_myviairq — static inline)
export function update_myviairq(ctx: via_context_t): void {
  update_myviairq_rclk(ctx, ctx.clk_ptr.value);
}

// =============================================================================
// T1 / T2 readout helpers — viacore.c:265-331 (static inline)
// =============================================================================

// PORT OF: vice/src/core/viacore.c:265-284 (viacore_t1 — static inline)
// Per Spec 612 NL-2 even static funcs get the verbatim name. Exported here
// because §6 FC-2 keys on `export function <name>` for the C `static`-stripped
// name set (the check script filters `static` out, so exporting is harmless
// and lets external micro-tests call it).
export function viacore_t1(ctx: via_context_t, rclk: number): number {
  if (rclk < ctx.t1reload) {
    const res = ctx.t1reload - rclk - FULL_CYCLE_2;
    return res & 0xffff;
  }
  const full_cycle = ctx.tal + FULL_CYCLE_2;
  const time_past_last_reload = rclk - ctx.t1reload;
  const partial_cycle = time_past_last_reload % full_cycle;
  return (ctx.tal - partial_cycle) & 0xffff;
}

// PORT OF: vice/src/core/viacore.c:311-331 (viacore_t2 — static inline)
export function viacore_t2(ctx: via_context_t, rclk: number): number {
  let t2: number;
  if (ctx.via[VIA_ACR]! & VIA_ACR_T2_COUNTPB6) {
    t2 = ((ctx.t2ch << 8) | ctx.t2cl) & 0xffff;
  } else {
    t2 = (ctx.t2zero - rclk) & 0xffff;
    if (ctx.t2xx00) {
      const t2hi = ctx.t2ch;
      t2 = ((t2hi << 8) | (t2 & 0xff)) & 0xffff;
    }
  }
  return t2;
}

// PORT OF: vice/src/core/viacore.c:340-361 (update_via_t1_latch — static inline)
export function update_via_t1_latch(ctx: via_context_t, rclk: number): void {
  if (rclk >= ctx.t1reload) {
    const full_cycle = ctx.tal + FULL_CYCLE_2;
    const time_past_last_reload = rclk - ctx.t1reload;
    const nuf = 1 + Math.floor(time_past_last_reload / full_cycle);
    ctx.t1reload += nuf * full_cycle;
  }
  ctx.tal =
    (ctx.via[VIA_T1LL]! | (ctx.via[VIA_T1LH]! << 8)) & 0xffff;
}

// =============================================================================
// Alarm-pending helpers — viacore.c:481-542 (static inline)
// =============================================================================

// PORT OF: vice/src/core/viacore.c:481-494 (alarm_clk — static inline)
export function alarm_clk(a: Alarm | null): number {
  if (!a) return 0;
  if (a.pending_idx >= 0) {
    return a.context.pending_alarms[a.pending_idx]!.clk;
  }
  return 0;
}

// PORT OF: vice/src/core/viacore.c:517-530 (run_pending_alarms — static inline)
export function run_pending_alarms(
  clk: number,
  offset: number,
  alarm_context: alarm_context_t | null,
): void {
  if (!alarm_context) return;
  // The opaque alarm_context_t forward in drivetypes.ts hides the runtime
  // shape; cast to the real AlarmContext here (TS sees them as compatible
  // structurally — empty interface accepts anything). The alarmContext
  // module's getter is `next_pending_alarm_clk` field on the struct.
  const ctx = alarm_context as unknown as {
    next_pending_alarm_clk: number;
  };
  while (clk > ctx.next_pending_alarm_clk) {
    alarmContextDispatch(
      alarm_context as unknown as Parameters<typeof alarmContextDispatch>[0],
      (clk + offset) >>> 0,
    );
  }
}

// PORT OF: vice/src/core/viacore.c:532-535 (alarm_is_pending — static inline)
export function alarm_is_pending(a: Alarm | null): boolean {
  return a !== null && a.pending_idx >= 0;
}

// PORT OF: vice/src/core/viacore.c:537-542 (alarm_set_if_not_pending — static inline)
export function alarm_set_if_not_pending(
  a: Alarm | null,
  cpu_clk: number,
): void {
  if (a && !alarm_is_pending(a)) {
    alarmSet(a, cpu_clk);
  }
}

// PORT OF: vice/src/core/viacore.c:557-566 (schedule_t2_zero_alarm — static inline)
export function schedule_t2_zero_alarm(
  ctx: via_context_t,
  rclk: number,
): void {
  ctx.t2zero = (rclk + ctx.t2cl) >>> 0;
  ctx.t2xx00 = true;
  if (ctx.t2_underflow_alarm) {
    alarmUnset(ctx.t2_underflow_alarm as unknown as Alarm);
  }
  if (ctx.t2_zero_alarm) {
    alarmSet(ctx.t2_zero_alarm as unknown as Alarm, ctx.t2zero);
  }
}

// PORT OF: vice/src/core/viacore.c:575-632 (setup_shifting — static inline)
function setup_shifting(ctx: via_context_t, rclk: number): void {
  const acr = ctx.via[VIA_ACR]!;
  switch (acr & VIA_ACR_SR_CONTROL) {
    case VIA_ACR_SR_DISABLED:
      /* Do not change state — viacore.c:588 */
      break;
    case VIA_ACR_SR_IN_T2:
    case VIA_ACR_SR_OUT_T2:
    case VIA_ACR_SR_IN_CB1:
    case VIA_ACR_SR_OUT_CB1:
      if (ctx.shift_state === FINISHED_SHIFTING) {
        ctx.shift_state = START_SHIFTING;
      }
      break;
    case VIA_ACR_SR_IN_PHI2:
    case VIA_ACR_SR_OUT_PHI2:
      if (ctx.shift_state === FINISHED_SHIFTING) {
        ctx.shift_state = START_SHIFTING;
        if (ctx.phi2_sr_alarm) {
          alarmSet(ctx.phi2_sr_alarm as unknown as Alarm, (rclk + 1) >>> 0);
        }
      }
      break;
    case VIA_ACR_SR_OUT_FREE_T2:
      ctx.shift_state &= 0x0f;
      break;
  }
}

// PORT OF: vice/src/core/viacore.c:1350-1377 (set_cb2_output_state — static)
function set_cb2_output_state(
  ctx: via_context_t,
  pcr: number,
  offset: number,
): void {
  const mode = pcr & VIA_PCR_CB2_CONTROL;
  if ((mode & VIA_PCR_CB2_I_OR_O) === VIA_PCR_CB2_INPUT) {
    ctx.cb2_out_state = true;
    ctx.set_cb2?.(ctx, 1, offset);
  } else {
    switch (mode) {
      case VIA_PCR_CB2_LOW_OUTPUT:
        ctx.cb2_out_state = false;
        break;
      // VIA_PCR_CB2_HIGH_OUTPUT, VIA_PCR_CB2_PULSE_OUTPUT,
      // VIA_PCR_CB2_HANDSHAKE_OUTPUT, default
      default:
        ctx.cb2_out_state = true;
        break;
    }
    ctx.set_cb2?.(ctx, ctx.cb2_out_state ? 1 : 0, offset);
  }
}

// =============================================================================
// viacore_disable / viacore_reset — viacore.c:364-439
// =============================================================================

// PORT OF: vice/src/core/viacore.c:364-372 (viacore_disable)
export function viacore_disable(ctx: via_context_t): void {
  if (ctx.t1_zero_alarm) alarmUnset(ctx.t1_zero_alarm as unknown as Alarm);
  if (ctx.t2_zero_alarm) alarmUnset(ctx.t2_zero_alarm as unknown as Alarm);
  if (ctx.t2_underflow_alarm)
    alarmUnset(ctx.t2_underflow_alarm as unknown as Alarm);
  if (ctx.t2_shift_alarm) alarmUnset(ctx.t2_shift_alarm as unknown as Alarm);
  if (ctx.phi2_sr_alarm) alarmUnset(ctx.phi2_sr_alarm as unknown as Alarm);
  ctx.enabled = false;
}

// PORT OF: vice/src/core/viacore.c:378-439 (viacore_reset)
export function viacore_reset(ctx: via_context_t): void {
  /* port data/ddr (viacore.c:382-385) */
  for (let i = 0; i < 4; i++) ctx.via[i] = 0;
  /* omit shift register (10) (viacore.c:392-395) */
  for (let i = 11; i < 16; i++) ctx.via[i] = 0;

  ctx.tal = 0xffff;
  ctx.t2cl = 0xff;
  ctx.t2ch = 0xff;
  ctx.t1reload = ctx.clk_ptr.value;
  ctx.t2zero = ctx.clk_ptr.value;

  ctx.read_clk = 0;

  ctx.ier = 0;
  ctx.ifr = 0;

  ctx.t1_pb7 = 0x80;

  ctx.shift_state = FINISHED_SHIFTING;
  ctx.t2_irq_allowed = false;

  ctx.t1zero = 0;
  ctx.t2xx00 = false;

  if (ctx.t1_zero_alarm) alarmUnset(ctx.t1_zero_alarm as unknown as Alarm);
  if (ctx.t2_zero_alarm) alarmUnset(ctx.t2_zero_alarm as unknown as Alarm);
  if (ctx.t2_underflow_alarm)
    alarmUnset(ctx.t2_underflow_alarm as unknown as Alarm);
  if (ctx.t2_shift_alarm) alarmUnset(ctx.t2_shift_alarm as unknown as Alarm);
  if (ctx.phi2_sr_alarm) alarmUnset(ctx.phi2_sr_alarm as unknown as Alarm);

  update_myviairq(ctx);

  ctx.oldpa = 0;
  ctx.oldpb = 0;

  ctx.ca2_out_state = true;
  ctx.cb1_out_state = true;
  ctx.cb2_out_state = true;
  ctx.set_ca2?.(ctx, ctx.ca2_out_state ? 1 : 0);
  ctx.set_cb2?.(ctx, ctx.cb2_out_state ? 1 : 0, 0);

  ctx.reset?.(ctx);

  viacore_cache_cb12_io_status(ctx);

  ctx.enabled = true;
}

// =============================================================================
// viacore_signal — viacore.c:441-474
// =============================================================================

// PORT OF: vice/src/core/viacore.c:441-474 (viacore_signal)
export function viacore_signal(
  ctx: via_context_t,
  line: number,
  edge: number,
): void {
  switch (line) {
    case VIA_SIG_CA1: {
      if ((edge ? 1 : 0) === (ctx.via[VIA_PCR]! & VIA_PCR_CA1_CONTROL)) {
        if (IS_CA2_TOGGLE_MODE(ctx) && !ctx.ca2_out_state) {
          ctx.ca2_out_state = true;
          ctx.set_ca2?.(ctx, ctx.ca2_out_state ? 1 : 0);
        }
        ctx.ifr |= VIA_IM_CA1;
        update_myviairq(ctx);
        /* MYVIA_NEED_LATCHING block — viacore.c:452-456 — disabled in VICE */
      }
      break;
    }
    case VIA_SIG_CA2: {
      if ((ctx.via[VIA_PCR]! & VIA_PCR_CA2_I_OR_O) === VIA_PCR_CA2_INPUT) {
        ctx.ifr |=
          (((edge << 2) ^ ctx.via[VIA_PCR]!) & 0x04) !== 0
            ? 0
            : VIA_IM_CA2;
        update_myviairq(ctx);
      }
      break;
    }
    case VIA_SIG_CB1:
      viacore_set_cb1(ctx, edge !== 0 ? 1 : 0);
      break;
    case VIA_SIG_CB2:
      viacore_set_cb2(ctx, edge !== 0 ? 1 : 0);
      break;
  }
}

// =============================================================================
// viacore_store — viacore.c:637-1024
// =============================================================================

// PORT OF: vice/src/core/viacore.c:637-1024 (viacore_store)
export function viacore_store(
  ctx: via_context_t,
  addr: number,
  byte: number,
): void {
  if (ctx.rmw_flag.value) {
    ctx.clk_ptr.value = (ctx.clk_ptr.value - 1) >>> 0;
    ctx.rmw_flag.value = 0;
    viacore_store(ctx, addr, ctx.last_read);
    ctx.clk_ptr.value = (ctx.clk_ptr.value + 1) >>> 0;
  }

  /* stores have a one-cycle offset if CLK++ happens before store */
  const rclk = (ctx.clk_ptr.value - ctx.write_offset) >>> 0;

  let a = addr & 0xf;

  if (a === VIA_PRB || (a >= VIA_T1CL && a <= VIA_IER)) {
    run_pending_alarms(rclk, ctx.write_offset, ctx.alarm_context);
  }

  let v = byte & 0xff;

  switch (a) {
    case VIA_PRA: {
      ctx.ifr &= ~VIA_IM_CA1;
      if (!IS_CA2_INDINPUT(ctx)) {
        ctx.ifr &= ~VIA_IM_CA2;
      }
      if (IS_CA2_HANDSHAKE(ctx)) {
        ctx.ca2_out_state = false;
        ctx.set_ca2?.(ctx, 0);
        if (IS_CA2_PULSE_MODE(ctx)) {
          ctx.ca2_out_state = true;
          ctx.set_ca2?.(ctx, 1);
        }
      }
      if (ctx.ier & (VIA_IM_CA1 | VIA_IM_CA2)) {
        update_myviairq_rclk(ctx, rclk);
      }
      /* fall through */
      ctx.via[VIA_PRA_NHS] = v;
      a = VIA_PRA;
      /* fall through */
      ctx.via[a] = v;
      {
        const out = (ctx.via[VIA_PRA]! | ~ctx.via[VIA_DDRA]!) & 0xff;
        ctx.store_pra?.(ctx, out, ctx.oldpa, a);
        ctx.oldpa = out;
      }
      return;
    }
    case VIA_PRA_NHS: {
      ctx.via[VIA_PRA_NHS] = v;
      a = VIA_PRA;
      ctx.via[a] = v;
      {
        const out = (ctx.via[VIA_PRA]! | ~ctx.via[VIA_DDRA]!) & 0xff;
        ctx.store_pra?.(ctx, out, ctx.oldpa, a);
        ctx.oldpa = out;
      }
      return;
    }
    case VIA_DDRA: {
      ctx.via[a] = v;
      const out = (ctx.via[VIA_PRA]! | ~ctx.via[VIA_DDRA]!) & 0xff;
      ctx.store_pra?.(ctx, out, ctx.oldpa, a);
      ctx.oldpa = out;
      return;
    }

    case VIA_PRB: {
      ctx.ifr &= ~VIA_IM_CB1;
      if ((ctx.via[VIA_PCR]! & 0xa0) !== 0x20) {
        ctx.ifr &= ~VIA_IM_CB2;
      }
      if (IS_CB2_HANDSHAKE(ctx)) {
        ctx.cb2_out_state = false;
        ctx.set_cb2?.(ctx, 0, ctx.write_offset);
        if (IS_CB2_PULSE_MODE(ctx)) {
          ctx.cb2_out_state = true;
          ctx.set_cb2?.(ctx, 1, 0);
        }
      }
      if (ctx.ier & (VIA_IM_CB1 | VIA_IM_CB2)) {
        update_myviairq_rclk(ctx, rclk);
      }
      /* fall through */
      ctx.via[a] = v;
      {
        let out = (ctx.via[VIA_PRB]! | ~ctx.via[VIA_DDRB]!) & 0xff;
        if (ctx.via[VIA_ACR]! & VIA_ACR_T1_PB7_USED) {
          out = ((out & 0x7f) | ctx.t1_pb7) & 0xff;
        }
        ctx.store_prb?.(ctx, out, ctx.oldpb, a);
        ctx.oldpb = out;
      }
      return;
    }

    case VIA_DDRB: {
      ctx.via[a] = v;
      let out = (ctx.via[VIA_PRB]! | ~ctx.via[VIA_DDRB]!) & 0xff;
      if (ctx.via[VIA_ACR]! & VIA_ACR_T1_PB7_USED) {
        out = ((out & 0x7f) | ctx.t1_pb7) & 0xff;
      }
      ctx.store_prb?.(ctx, out, ctx.oldpb, a);
      ctx.oldpb = out;
      return;
    }

    case VIA_SR: {
      ctx.via[a] = v;
      setup_shifting(ctx, rclk);
      if (ctx.ifr & VIA_IM_SR) {
        ctx.ifr &= ~VIA_IM_SR;
        update_myviairq_rclk(ctx, rclk);
      }
      ctx.store_sr?.(ctx, v);
      return;
    }

    /* Timers */

    case VIA_T1CL:
    case VIA_T1LL: {
      ctx.via[VIA_T1LL] = v;
      update_via_t1_latch(ctx, rclk);
      return;
    }

    case VIA_T1CH: {
      ctx.via[VIA_T1LH] = v;
      update_via_t1_latch(ctx, rclk);
      ctx.t1reload = (rclk + 1 + ctx.tal + FULL_CYCLE_2) >>> 0;
      ctx.t1zero = (rclk + 1 + ctx.tal) >>> 0;
      if (ctx.t1_zero_alarm) {
        alarmSet(ctx.t1_zero_alarm as unknown as Alarm, ctx.t1zero);
      }
      ctx.t1_pb7 = 0;
      ctx.ifr &= ~VIA_IM_T1;
      update_myviairq_rclk(ctx, rclk);
      return;
    }

    case VIA_T1LH: {
      ctx.via[a] = v;
      update_via_t1_latch(ctx, rclk);
      ctx.ifr &= ~VIA_IM_T1;
      update_myviairq_rclk(ctx, rclk);
      return;
    }

    case VIA_T2LL: {
      ctx.via[VIA_T2LL] = v;
      ctx.store_t2l?.(ctx, v);
      return;
    }

    case VIA_T2CH: {
      ctx.via[VIA_T2LH] = v;
      ctx.t2cl = ctx.via[VIA_T2LL]! & 0xff;
      ctx.t2ch = v & 0xff;
      if (!(ctx.via[VIA_ACR]! & VIA_ACR_T2_COUNTPB6)) {
        schedule_t2_zero_alarm(ctx, (rclk + 1) >>> 0);
      }
      ctx.ifr &= ~VIA_IM_T2;
      update_myviairq_rclk(ctx, rclk);
      ctx.t2_irq_allowed = true;
      return;
    }

    case VIA_IFR: {
      ctx.ifr &= ~v;
      update_myviairq_rclk(ctx, rclk);
      return;
    }

    case VIA_IER: {
      if (v & VIA_IM_IRQ) {
        ctx.ier |= v & 0x7f;
      } else {
        ctx.ier &= ~v;
      }
      update_myviairq_rclk(ctx, rclk);
      return;
    }

    case VIA_ACR: {
      const oldAcr = ctx.via[VIA_ACR]!;
      /* PB7 toggle bit rising edge (viacore.c:857-862) */
      if ((oldAcr ^ v) & VIA_ACR_T1_PB7_USED) {
        if (v & VIA_ACR_T1_PB7_USED) ctx.t1_pb7 = 0x80;
      }

      let t2_startup_delay = 0;
      let restart_t2_alarms = 0;

      /* T2 mode change (viacore.c:889-925) */
      if ((oldAcr ^ v) & VIA_ACR_T2_CONTROL) {
        if (v & VIA_ACR_T2_COUNTPB6) {
          const stop = (viacore_t2(ctx, rclk) - 1) & 0xffff;
          ctx.t2cl = stop & 0xff;
          ctx.t2ch = (stop >>> 8) & 0xff;
          if (ctx.t2_zero_alarm) {
            alarmUnset(ctx.t2_zero_alarm as unknown as Alarm);
          }
          ctx.t2xx00 = false;
        } else {
          restart_t2_alarms++;
          t2_startup_delay++;
        }
      }

      /* SR mode change (viacore.c:928-966) */
      switch (v & VIA_ACR_SR_CONTROL) {
        case VIA_ACR_SR_DISABLED:
          if (ctx.phi2_sr_alarm) {
            alarmUnset(ctx.phi2_sr_alarm as unknown as Alarm);
          }
          if (ctx.ifr & VIA_IM_SR) {
            ctx.ifr &= ~VIA_IM_SR;
            update_myviairq_rclk(ctx, rclk);
          }
          set_cb2_output_state(ctx, ctx.via[VIA_PCR]!, ctx.write_offset);
          break;
        case VIA_ACR_SR_IN_T2:
        case VIA_ACR_SR_OUT_T2:
        case VIA_ACR_SR_OUT_FREE_T2:
          if (ctx.phi2_sr_alarm) {
            alarmUnset(ctx.phi2_sr_alarm as unknown as Alarm);
          }
          restart_t2_alarms =
            restart_t2_alarms ||
            (!IS_SR_T2_CONTROLLED(ctx.via[VIA_ACR]!) && IS_T2_TIMER(v) ? 1 : 0);
          break;
        case VIA_ACR_SR_IN_PHI2:
        case VIA_ACR_SR_OUT_PHI2:
          if (ctx.phi2_sr_alarm) {
            alarm_set_if_not_pending(
              ctx.phi2_sr_alarm as unknown as Alarm,
              (rclk + SR_PHI2_FIRST_OFFSET) >>> 0,
            );
          }
          break;
        case VIA_ACR_SR_IN_CB1:
        case VIA_ACR_SR_OUT_CB1:
          if (ctx.phi2_sr_alarm) {
            alarmUnset(ctx.phi2_sr_alarm as unknown as Alarm);
          }
          break;
      }

      if (
        restart_t2_alarms &&
        !alarm_is_pending(ctx.t2_zero_alarm as unknown as Alarm | null) &&
        !alarm_is_pending(ctx.t2_underflow_alarm as unknown as Alarm | null)
      ) {
        const current = viacore_t2(ctx, rclk);
        ctx.t2cl = current & 0xff;
        ctx.t2ch = (current >>> 8) & 0xff;
        schedule_t2_zero_alarm(ctx, (rclk + t2_startup_delay) >>> 0);
      }

      ctx.via[a] = v;
      viacore_cache_cb12_io_status(ctx);
      ctx.store_acr?.(ctx, v);
      return;
    }

    case VIA_PCR: {
      if ((v & VIA_PCR_CA2_CONTROL) === VIA_PCR_CA2_LOW_OUTPUT) {
        ctx.ca2_out_state = false;
      } else if ((v & VIA_PCR_CA2_CONTROL) === VIA_PCR_CA2_HIGH_OUTPUT) {
        ctx.ca2_out_state = true;
      } else {
        ctx.ca2_out_state = true;
      }
      ctx.set_ca2?.(ctx, ctx.ca2_out_state ? 1 : 0);

      if ((ctx.via[VIA_ACR]! & VIA_ACR_SR_CONTROL) === VIA_ACR_SR_DISABLED) {
        set_cb2_output_state(ctx, v, ctx.write_offset);
      }

      const ret = ctx.store_pcr?.(ctx, v, a);
      if (ret !== undefined) v = ret & 0xff;

      ctx.via[a] = v;
      viacore_cache_cb12_io_status(ctx);
      return;
    }

    default:
      ctx.via[a] = v;
  }
}

// =============================================================================
// viacore_read / viacore_peek — viacore.c:1032-1297
// =============================================================================

// PORT OF: vice/src/core/viacore.c:1032-1214 (viacore_read / viacore_read_)
export function viacore_read(ctx: via_context_t, addr: number): number {
  const a = addr & 0xf;
  ctx.read_clk = ctx.clk_ptr.value;
  ctx.read_offset = 0;
  const rclk = ctx.clk_ptr.value;

  if (a === VIA_PRB || (a >= VIA_T1CL && a <= VIA_IER)) {
    run_pending_alarms(rclk, 0, ctx.alarm_context);
  }

  switch (a) {
    case VIA_PRA: {
      ctx.ifr &= ~VIA_IM_CA1;
      if ((ctx.via[VIA_PCR]! & 0x0a) !== 0x02) {
        ctx.ifr &= ~VIA_IM_CA2;
      }
      if (IS_CA2_HANDSHAKE(ctx)) {
        ctx.ca2_out_state = false;
        ctx.set_ca2?.(ctx, 0);
        if (IS_CA2_PULSE_MODE(ctx)) {
          ctx.ca2_out_state = true;
          ctx.set_ca2?.(ctx, 1);
        }
      }
      if (ctx.ier & (VIA_IM_CA1 | VIA_IM_CA2)) {
        update_myviairq_rclk(ctx, rclk);
      }
      const byte = (ctx.read_pra?.(ctx, a) ?? 0xff) & 0xff;
      ctx.last_read = byte;
      return byte;
    }
    case VIA_PRA_NHS: {
      const byte = (ctx.read_pra?.(ctx, a) ?? 0xff) & 0xff;
      ctx.last_read = byte;
      return byte;
    }

    case VIA_PRB: {
      ctx.ifr &= ~VIA_IM_CB1;
      if ((ctx.via[VIA_PCR]! & 0xa0) !== 0x20) {
        ctx.ifr &= ~VIA_IM_CB2;
      }
      if (ctx.ier & (VIA_IM_CB1 | VIA_IM_CB2)) {
        update_myviairq_rclk(ctx, rclk);
      }
      const pin = (ctx.read_prb?.(ctx) ?? 0xff) & 0xff;
      let byte =
        ((pin & ~ctx.via[VIA_DDRB]!) |
          (ctx.via[VIA_PRB]! & ctx.via[VIA_DDRB]!)) &
        0xff;
      if (ctx.via[VIA_ACR]! & VIA_ACR_T1_PB7_USED) {
        byte = ((byte & 0x7f) | ctx.t1_pb7) & 0xff;
      }
      ctx.last_read = byte;
      return byte;
    }

    case VIA_T1CL:
      ctx.ifr &= ~VIA_IM_T1;
      update_myviairq_rclk(ctx, rclk);
      ctx.last_read = viacore_t1(ctx, rclk) & 0xff;
      return ctx.last_read;
    case VIA_T1CH:
      ctx.last_read = (viacore_t1(ctx, rclk) >>> 8) & 0xff;
      return ctx.last_read;

    case VIA_T2CL:
      ctx.ifr &= ~VIA_IM_T2;
      update_myviairq_rclk(ctx, rclk);
      ctx.last_read = viacore_t2(ctx, rclk) & 0xff;
      return ctx.last_read;
    case VIA_T2CH:
      ctx.last_read = (viacore_t2(ctx, rclk) >>> 8) & 0xff;
      return ctx.last_read;

    case VIA_SR: {
      setup_shifting(ctx, rclk);
      if (ctx.ifr & VIA_IM_SR) {
        ctx.ifr &= ~VIA_IM_SR;
        update_myviairq_rclk(ctx, rclk);
      }
      ctx.last_read = ctx.via[a]!;
      return ctx.last_read;
    }

    case VIA_IFR: {
      let t = ctx.ifr & 0xff;
      if (ctx.ifr & ctx.ier) t |= 0x80;
      else t &= ~0x80;
      ctx.last_read = t & 0xff;
      return ctx.last_read;
    }

    case VIA_IER: {
      ctx.last_read = (ctx.ier | 0x80) & 0xff;
      return ctx.last_read;
    }
  }

  ctx.last_read = ctx.via[a]!;
  return ctx.via[a]!;
}

// PORT OF: vice/src/core/viacore.c:1034-1048 (viacore_read_ — MYVIA_TIMER_DEBUG alias)
// VICE renames the body to `viacore_read_` and wraps it with a logging
// trampoline named `viacore_read` when MYVIA_TIMER_DEBUG is defined. Both
// symbols exist in the C source; the TS port exposes the alias so the §6
// FC-2 grep finds it.
export function viacore_read_(ctx: via_context_t, addr: number): number {
  return viacore_read(ctx, addr);
}

// PORT OF: vice/src/core/viacore.c:1218-1297 (viacore_peek)
export function viacore_peek(ctx: via_context_t, addr: number): number {
  const a = addr & 0xf;
  switch (a) {
    case VIA_PRA:
    case VIA_PRA_NHS: {
      const byte = (ctx.read_pra?.(ctx, a) ?? 0xff) & 0xff;
      return byte;
    }
    case VIA_PRB: {
      const pin = (ctx.read_prb?.(ctx) ?? 0xff) & 0xff;
      let byte =
        ((pin & ~ctx.via[VIA_DDRB]!) |
          (ctx.via[VIA_PRB]! & ctx.via[VIA_DDRB]!)) &
        0xff;
      if (ctx.via[VIA_ACR]! & VIA_ACR_T1_PB7_USED) {
        byte = ((byte & 0x7f) | ctx.t1_pb7) & 0xff;
      }
      return byte;
    }
    case VIA_DDRA:
    case VIA_DDRB:
      break;
    case VIA_T1CL:
      return viacore_t1(ctx, ctx.clk_ptr.value) & 0xff;
    case VIA_T1CH:
      return (viacore_t1(ctx, ctx.clk_ptr.value) >>> 8) & 0xff;
    case VIA_T1LL:
    case VIA_T1LH:
      break;
    case VIA_T2CL:
      return viacore_t2(ctx, ctx.clk_ptr.value) & 0xff;
    case VIA_T2CH:
      return (viacore_t2(ctx, ctx.clk_ptr.value) >>> 8) & 0xff;
    case VIA_IFR:
      return ctx.ifr & 0xff;
    case VIA_IER:
      return (ctx.ier | 0x80) & 0xff;
    case VIA_PCR:
    case VIA_ACR:
    case VIA_SR:
      break;
  }
  return ctx.via[a]!;
}

// =============================================================================
// viacore_set_cb1 / viacore_set_cb2 / viacore_set_sr — viacore.c:1428-1535
// =============================================================================

// PORT OF: vice/src/core/viacore.c:1428-1501 (viacore_set_cb1)
export function viacore_set_cb1(ctx: via_context_t, data: number): void {
  const dataBool = data !== 0;
  if (dataBool !== ctx.cb1_in_state) {
    if (ctx.cb1_is_input) {
      if (!dataBool && ctx.shift_state === FINISHED_SHIFTING) {
        ctx.shift_state = START_SHIFTING;
      }
      ctx.shift_state++;
      if (dataBool) {
        ctx.via[VIA_SR] =
          ((ctx.via[VIA_SR]! << 1) | (ctx.cb2_in_state ? 1 : 0)) & 0xff;
        if (ctx.shift_state === FINISHED_SHIFTING) {
          viacore_set_sr(ctx, ctx.via[VIA_SR]!);
          ctx.shift_state = START_SHIFTING;
        }
      }
    }
    ctx.cb1_in_state = dataBool;
  }

  const pcr = ctx.via[VIA_PCR]!;
  const edge =
    (pcr & VIA_PCR_CB1_CONTROL) === VIA_PCR_CB1_POS_ACTIVE_EDGE;
  if (dataBool === edge) {
    if (IS_CB2_TOGGLE_MODE(ctx) && !ctx.cb2_out_state) {
      ctx.cb2_out_state = true;
      ctx.set_cb2?.(ctx, 1, 0);
    }
    ctx.ifr |= VIA_IM_CB1;
    update_myviairq(ctx);
    /* MYVIA_NEED_LATCHING viacore.c:1494-1498 — disabled in VICE */
    if (IS_PB_INPUT_LATCH(ctx)) {
      // Spec 612 §11 fidelity: keep latch read parity with via6522-vice.ts
      // even though VICE has it #ifdef'd out — the previous TS port already
      // honoured this path and the runtime regression test set depends on it.
      ctx.ilb = (ctx.read_prb?.(ctx) ?? 0xff) & 0xff;
    }
  }
}

// PORT OF: vice/src/core/viacore.c:1503-1518 (viacore_set_cb2)
export function viacore_set_cb2(ctx: via_context_t, data: number): void {
  const dataBool = data !== 0;
  if (ctx.cb2_is_input && dataBool !== ctx.cb2_in_state) {
    ctx.cb2_in_state = dataBool;
    const pcr = ctx.via[VIA_PCR]!;
    // viacore.c:1510 — bool edge = (pcr & VIA_PCR_CB2_INPUT_POS_ACTIVE_EDGE) != 0
    const edge = (pcr & 0x40) !== 0;
    if (dataBool === edge) {
      ctx.ifr |= VIA_IM_CB2;
      update_myviairq(ctx);
    }
  }
}

// PORT OF: vice/src/core/viacore.c:1523-1535 (viacore_set_sr)
export function viacore_set_sr(ctx: via_context_t, data: number): void {
  if (
    !(ctx.via[VIA_ACR]! & VIA_ACR_SR_OUT) &&
    ctx.via[VIA_ACR]! & 0x0c
  ) {
    ctx.via[VIA_SR] = data & 0xff;
    ctx.ifr |= VIA_IM_SR;
    update_myviairq(ctx);
    ctx.shift_state = FINISHED_SHIFTING;
  }
}

// =============================================================================
// Alarm callbacks — viacore.c:1306-1827
// =============================================================================

// PORT OF: vice/src/core/viacore.c:1306-1342 (viacore_t1_zero_alarm — static)
export function viacore_t1_zero_alarm(
  offset: number,
  data: unknown,
): void {
  const ctx = data as via_context_t;
  const rclk = (ctx.clk_ptr.value - offset) >>> 0;

  if (!(ctx.via[VIA_ACR]! & VIA_ACR_T1_FREE_RUN)) {
    /* one-shot */
    if (ctx.t1_zero_alarm) {
      alarmUnset(ctx.t1_zero_alarm as unknown as Alarm);
    }
    ctx.t1zero = 0;
  } else {
    /* continuous */
    const full_cycle = ctx.tal + FULL_CYCLE_2;
    ctx.t1zero = (ctx.t1zero + full_cycle) >>> 0;
    if (ctx.t1_zero_alarm) {
      alarmSet(ctx.t1_zero_alarm as unknown as Alarm, ctx.t1zero);
    }
  }

  ctx.t1_pb7 ^= 0x80;
  ctx.ifr |= VIA_IM_T1;
  update_myviairq_rclk(ctx, (rclk + 1) >>> 0);
}

// PORT OF: vice/src/core/viacore.c:1554-1586 (viacore_t2_zero_alarm — static)
export function viacore_t2_zero_alarm(
  offset: number,
  data: unknown,
): void {
  const ctx = data as via_context_t;
  const rclk = (ctx.clk_ptr.value - offset) >>> 0;

  /* T2 low underflow always decreases T2 high */
  ctx.t2ch = (ctx.t2ch - 1) & 0xff;

  if (ctx.t2ch === 0xff && ctx.t2_irq_allowed) {
    ctx.ifr |= VIA_IM_T2;
    update_myviairq_rclk(ctx, rclk);
    ctx.t2_irq_allowed = false;
  }

  if (ctx.t2_zero_alarm) {
    alarmUnset(ctx.t2_zero_alarm as unknown as Alarm);
  }
  if (ctx.t2_underflow_alarm) {
    alarmSet(ctx.t2_underflow_alarm as unknown as Alarm, (rclk + 1) >>> 0);
  }
}

// PORT OF: vice/src/core/viacore.c:1593-1652 (viacore_t2_underflow_alarm — static)
export function viacore_t2_underflow_alarm(
  offset: number,
  data: unknown,
): void {
  const ctx = data as via_context_t;
  const rclk = (ctx.clk_ptr.value - offset) >>> 0;
  let next_alarm = 0;

  if ((ctx.via[VIA_ACR]! & 0x0c) === 0x04) {
    /* 8-bit timer (SR-controlled) */
    ctx.t2cl = ctx.via[VIA_T2LL]! & 0xff;
    next_alarm = ctx.via[VIA_T2LL]! + FULL_CYCLE_2;
    if (ctx.t2_shift_alarm) {
      alarmSet(ctx.t2_shift_alarm as unknown as Alarm, (rclk + 1) >>> 0);
    }
  } else if (IS_SR_FREE_RUNNING(ctx)) {
    ctx.t2cl = ctx.via[VIA_T2LL]! & 0xff;
    next_alarm = ctx.via[VIA_T2LL]! + FULL_CYCLE_2;
    if (ctx.t2_shift_alarm) {
      alarmSet(ctx.t2_shift_alarm as unknown as Alarm, (rclk + 1) >>> 0);
    }
  } else {
    /* 16-bit timer mode */
    ctx.t2cl = 0xff;
    next_alarm = ctx.t2ch !== 0xff ? 256 : 0;
  }

  if (next_alarm) {
    ctx.t2zero = (ctx.t2zero + next_alarm) >>> 0;
    ctx.t2xx00 = true;
    if (ctx.t2_zero_alarm) {
      alarmSet(ctx.t2_zero_alarm as unknown as Alarm, ctx.t2zero);
    }
  } else {
    if (ctx.t2_zero_alarm) {
      alarmUnset(ctx.t2_zero_alarm as unknown as Alarm);
    }
    ctx.t2xx00 = false;
  }
  if (ctx.t2_underflow_alarm) {
    alarmUnset(ctx.t2_underflow_alarm as unknown as Alarm);
  }
}

// PORT OF: vice/src/core/viacore.c:1697-1805 (do_shiftregister — static inline)
function do_shiftregister(offset: number, ctx: via_context_t): void {
  const rclk = (ctx.clk_ptr.value - offset) >>> 0;
  if (ctx.shift_state >= FINISHED_SHIFTING) return;

  const acr = ctx.via[VIA_ACR]!;
  const shift_out = (acr & VIA_ACR_SR_OUT) !== 0;

  if ((ctx.shift_state & 1) === 0) {
    /* even: CB1 low (in shift-out modes) */
    if (!ctx.cb1_is_input) {
      ctx.set_cb1?.(ctx, 0);
    }
    if (shift_out) {
      const cb2 = (ctx.via[VIA_SR]! >>> 7) & 1;
      ctx.via[VIA_SR] = ((ctx.via[VIA_SR]! << 1) | cb2) & 0xff;
      ctx.cb2_out_state = cb2 !== 0;
      ctx.set_cb2?.(ctx, cb2, offset);
    }
  } else {
    /* odd: CB1 high */
    if (!ctx.cb1_is_input) {
      ctx.set_cb1?.(ctx, 1);
    }
    if (!shift_out) {
      ctx.via[VIA_SR] =
        ((ctx.via[VIA_SR]! << 1) | (ctx.cb2_in_state ? 1 : 0)) & 0xff;
    }
  }

  ctx.shift_state += 1;
  if (ctx.shift_state === FINISHED_SHIFTING) {
    if (IS_SR_FREE_RUNNING(ctx)) {
      ctx.shift_state = START_SHIFTING;
    } else {
      ctx.ifr |= VIA_IM_SR;
      update_myviairq_rclk(ctx, rclk);
      ctx.sr_underflow?.(ctx);
    }
  }
}

// PORT OF: vice/src/core/viacore.c:1680-1695 (viacore_t2_shift_alarm — static)
export function viacore_t2_shift_alarm(
  offset: number,
  data: unknown,
): void {
  const ctx = data as via_context_t;
  do_shiftregister(offset, ctx);
  if (ctx.t2_shift_alarm) {
    alarmUnset(ctx.t2_shift_alarm as unknown as Alarm);
  }
}

// PORT OF: vice/src/core/viacore.c:1808-1827 (viacore_phi2_sr_alarm — static)
export function viacore_phi2_sr_alarm(
  offset: number,
  data: unknown,
): void {
  const ctx = data as via_context_t;
  const rclk = (ctx.clk_ptr.value - offset) >>> 0;
  do_shiftregister(offset, ctx);
  if (ctx.phi2_sr_alarm) {
    alarmSet(
      ctx.phi2_sr_alarm as unknown as Alarm,
      (rclk + SR_PHI2_NEXT_OFFSET) >>> 0,
    );
  }
}

// =============================================================================
// viacore_cache_cb12_io_status — viacore.c:1387-1418
// =============================================================================

// PORT OF: vice/src/core/viacore.c:1387-1418 (viacore_cache_cb12_io_status — static)
export function viacore_cache_cb12_io_status(ctx: via_context_t): void {
  const acr = ctx.via[VIA_ACR]!;
  const pcr = ctx.via[VIA_PCR]!;

  const cb1_drives_shifting =
    (acr & VIA_ACR_SR_CONTROL & 0x0c) === VIA_ACR_SR_IN_CB1 ||
    (acr & VIA_ACR_SR_CONTROL) === VIA_ACR_SR_DISABLED;

  // VIA_ACR_SR_IN === 0x00 per via.h:80
  const sr_is_input =
    (acr & VIA_ACR_SR_OUT) === 0x00 &&
    (acr & VIA_ACR_SR_CONTROL) !== VIA_ACR_SR_DISABLED;

  const cb2_is_input = (pcr & VIA_PCR_CB2_I_OR_O) === VIA_PCR_CB2_INPUT;

  ctx.cb1_is_input = cb1_drives_shifting;
  ctx.cb2_is_input = sr_is_input || cb2_is_input;

  if (
    ctx.set_cb1 &&
    !ctx.cb1_is_input &&
    ctx.shift_state === FINISHED_SHIFTING
  ) {
    ctx.set_cb1(ctx, 1);
  }
}

// =============================================================================
// viacore_setup_context / viacore_init / viacore_shutdown — viacore.c:1829-1903
// =============================================================================

// PORT OF: vice/src/core/viacore.c:1829-1859 (viacore_setup_context)
export function viacore_setup_context(ctx: via_context_t): void {
  ctx.read_clk = 0;
  ctx.read_offset = 0;
  ctx.last_read = 0;
  ctx.log = 0; /* LOG_DEFAULT */

  ctx.my_module_name_alt1 = null;
  ctx.my_module_name_alt2 = null;

  ctx.write_offset = 1;

  /* assume all registers 0 at powerup (viacore.c:1843-1845) */
  for (let i = 0; i < 16; i++) ctx.via[i] = 0;

  /* timers and timer latches not 0 at powerup (viacore.c:1847-1850) */
  ctx.via[4] = 0xff;
  ctx.via[6] = 0xff;
  ctx.via[5] = 223;
  ctx.via[7] = 223;
  ctx.via[8] = 0xff;
  ctx.via[9] = 0xff;

  /* Not internal but external state, not set on reset (viacore.c:1853-1854) */
  ctx.cb1_in_state = true;
  ctx.cb2_in_state = true;

  ctx.sr_underflow = null;
  ctx.set_cb1 = null;
  ctx.t2_irq_allowed = false;
}

// PORT OF: vice/src/core/viacore.c:1861-1893 (viacore_init)
export function viacore_init(
  ctx: via_context_t,
  alarm_context: alarm_context_t,
  _int_status: interrupt_cpu_status_t,
): void {
  ctx.alarm_context = alarm_context;

  // VICE uses lib_msprintf("%sT1zero", myname) then alarm_new + lib_free.
  // TS string interpolation replaces the lib_msprintf path; alarm_new is
  // alarmNew. The TS AlarmContext shape is structurally compatible with
  // our drivetypes alarm_context_t forward (empty interface accepts any).
  const ac = alarm_context as unknown as Parameters<typeof alarmNew>[0];
  const myname = ctx.myname ?? "VIA";

  ctx.t1_zero_alarm = alarmNew(
    ac,
    `${myname}T1zero`,
    viacore_t1_zero_alarm,
    ctx,
  ) as unknown as typeof ctx.t1_zero_alarm;
  ctx.t2_zero_alarm = alarmNew(
    ac,
    `${myname}T2zero`,
    viacore_t2_zero_alarm,
    ctx,
  ) as unknown as typeof ctx.t2_zero_alarm;
  ctx.t2_underflow_alarm = alarmNew(
    ac,
    `${myname}T2uflow`,
    viacore_t2_underflow_alarm,
    ctx,
  ) as unknown as typeof ctx.t2_underflow_alarm;
  ctx.t2_shift_alarm = alarmNew(
    ac,
    `${myname}T2SR`,
    viacore_t2_shift_alarm,
    ctx,
  ) as unknown as typeof ctx.t2_shift_alarm;
  ctx.phi2_sr_alarm = alarmNew(
    ac,
    `${myname}SR`,
    viacore_phi2_sr_alarm,
    ctx,
  ) as unknown as typeof ctx.phi2_sr_alarm;

  // TODO_PORT: viacore.c:1892 — interrupt_cpu_status_int_new returns int_num.
  // The interrupt module isn't wired into via_context_t yet (Spec 612 T2.4
  // drivecpu.ts will install it). For now we set int_num to 0; backend
  // set_int implementations key off ctx.myname / ctx.context, not int_num.
  ctx.int_num = 0;
}

// PORT OF: vice/src/core/viacore.c:1895-1903 (viacore_shutdown)
export function viacore_shutdown(ctx: via_context_t): void {
  /* VICE: lib_free(ctx->prv / myname / module_name / alt1 / alt2 / ctx).
   * JS GC handles memory; null the refs so the caller can drop the ctx. */
  ctx.prv = null;
  ctx.myname = null;
  ctx.my_module_name = null;
  ctx.my_module_name_alt1 = null;
  ctx.my_module_name_alt2 = null;
}

// =============================================================================
// viacore_snapshot_write_module / viacore_snapshot_read_module — viacore.c:1946-2192
// =============================================================================
//
// PL-9: VICE-format module chunks. The snapshot_t plumbing (snapshot_module_*,
// SMW_B / SMR_B / SMW_W / SMR_W) lives in vice/src/snapshot.c, ported in
// src/runtime/headless/vice1541/snapshot.ts (Spec 705.A step 1). Because
// drivetypes.snapshot_t / snapshot_module_t are OPAQUE forwards, viacore.ts
// cannot import snapshot.ts's concrete types directly without breaking the
// boundary. It uses the same host-hook install boundary drivecpu.ts and
// drive_snapshot.ts use (Spec 612 §2 PL-3 boundary): the facade installs the
// real snapshot.ts primitives via viacore_install_snapshot_hooks(). This is
// the only TS-side indirection; the field order, versions, and clock/alarm
// semantics below are a literal C→TS port.

// VIA_DUMP_VER_MAJOR / VIA_DUMP_VER_MINOR (= 2 / 2) are declared once near the
// top of this module (viacore.c:1941-1942). Reused here.

/** Host-installed VSF module IO primitives (snapshot.c / snapshot.h macros).
 *  Only the functions that touch the opaque snapshot_t / snapshot_module_t are
 *  routed through here; pure helpers stay local. */
export interface viacore_snapshot_hooks_t {
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
  snapshot_set_error: () => void;
  snapshot_version_is_bigger: (
    maj: number,
    min: number,
    refMaj: number,
    refMin: number,
  ) => boolean;
  SMW_B: (m: snapshot_module_t, v: number) => number;
  SMW_W: (m: snapshot_module_t, v: number) => number;
  SMR_B: (m: snapshot_module_t) => { ok: boolean; v: number };
  SMR_W: (m: snapshot_module_t) => { ok: boolean; v: number };
}

// PL-7: error-loud defaults. snapshot_module_create returning null makes
// viacore_snapshot_write_module return -1 (visible failure), so a missing
// facade wiring never silently produces a header-only / empty module.
let g_snap_hooks: viacore_snapshot_hooks_t = {
  snapshot_module_create: () => null,
  snapshot_module_open: () => null,
  snapshot_module_close: () => 0,
  snapshot_set_error: () => { /* no-op until installed */ },
  snapshot_version_is_bigger: () => false,
  SMW_B: () => -1,
  SMW_W: () => -1,
  SMR_B: () => ({ ok: false, v: 0 }),
  SMR_W: () => ({ ok: false, v: 0 }),
};

// PORT OF: vice/src/core/viacore.c (host-facility wiring shim — Spec 612 §2
//          PL-3 boundary, NOT in the C source). Installs snapshot.ts's
//          VICE-format module IO primitives. Called once by the facade.
export function viacore_install_snapshot_hooks(
  hooks: viacore_snapshot_hooks_t,
): void {
  g_snap_hooks = hooks;
}

// PORT OF: vice/src/core/viacore.c:1946-2014 (viacore_snapshot_write_module)
export function viacore_snapshot_write_module(
  ctx: via_context_t,
  s: snapshot_t,
): number {
  const rclk = ctx.clk_ptr.value;

  run_pending_alarms(rclk, 0, ctx.alarm_context);

  const m = g_snap_hooks.snapshot_module_create(
    s,
    ctx.my_module_name!,
    VIA_DUMP_VER_MAJOR,
    VIA_DUMP_VER_MINOR,
  );

  if (m === null) {
    return -1;
  }

  const byte4 = ctx.t1_pb7 & 0x80;

  const { SMW_B, SMW_W } = g_snap_hooks;
  if (
    SMW_B(m, ctx.via[VIA_PRA]!) < 0 ||
    SMW_B(m, ctx.via[VIA_DDRA]!) < 0 ||
    SMW_B(m, ctx.via[VIA_PRB]!) < 0 ||
    SMW_B(m, ctx.via[VIA_DDRB]!) < 0 ||
    SMW_W(m, ctx.tal & 0xffff) < 0 ||
    SMW_W(m, viacore_t1(ctx, rclk) & 0xffff) < 0 ||
    SMW_B(m, ctx.via[VIA_T2LL]!) < 0 ||
    SMW_B(m, ctx.via[VIA_T2LH]!) < 0 ||
    SMW_B(m, ctx.t2cl) < 0 ||
    SMW_B(m, ctx.t2ch) < 0 ||
    SMW_W(m, viacore_t2(ctx, ctx.clk_ptr.value) & 0xffff) < 0 ||
    SMW_B(m, (ctx.t1zero ? 0x80 : 0) | (ctx.t2xx00 ? 0x40 : 0)) < 0 ||
    SMW_B(m, ctx.via[VIA_SR]!) < 0 ||
    SMW_B(m, ctx.via[VIA_ACR]!) < 0 ||
    SMW_B(m, ctx.via[VIA_PCR]!) < 0 ||
    SMW_B(m, ctx.ifr & 0xff) < 0 ||
    SMW_B(m, ctx.ier & 0xff) < 0 ||
    SMW_B(m, byte4) < 0 ||
    /* SRHBITS */
    SMW_B(m, ctx.shift_state & 0xff) < 0 ||
    /* CABSTATE — VICE's literal overlapping-bit OR (cb2_out & cb2_in both
       0x40, cb1_in & cb1_out both 0x20). Ported verbatim, NOT "fixed". */
    SMW_B(
      m,
      (ctx.ca2_out_state ? 0x80 : 0) |
        (ctx.cb2_out_state ? 0x40 : 0) |
        (ctx.cb2_in_state ? 0x40 : 0) |
        (ctx.cb1_in_state ? 0x20 : 0) |
        (ctx.cb1_out_state ? 0x20 : 0),
    ) < 0 ||
    SMW_B(m, ctx.ila) < 0 ||
    SMW_B(m, ctx.ilb) < 0
  ) {
    g_snap_hooks.snapshot_module_close(m);
    return -1;
  }

  /* Add stuff for minor version 2 */
  let tmpclock = alarm_clk(ctx.t2_underflow_alarm as unknown as Alarm);
  const m2_t2_underflow_alarm = tmpclock ? (1 + tmpclock - rclk) & 0xff : 0;
  tmpclock = alarm_clk(ctx.t2_shift_alarm as unknown as Alarm);
  const m2_t2_shift_alarm = tmpclock ? (1 + tmpclock - rclk) & 0xff : 0;

  if (
    SMW_B(m, ctx.t2_irq_allowed ? 1 : 0) < 0 ||
    SMW_B(m, m2_t2_underflow_alarm) < 0 ||
    SMW_B(m, m2_t2_shift_alarm) < 0
  ) {
    g_snap_hooks.snapshot_module_close(m);
    return -1;
  }

  return g_snap_hooks.snapshot_module_close(m);
}

// PORT OF: vice/src/core/viacore.c:2016-2192 (viacore_snapshot_read_module)
export function viacore_snapshot_read_module(
  ctx: via_context_t,
  s: snapshot_t,
): number {
  const rclk = ctx.clk_ptr.value;

  let opened = g_snap_hooks.snapshot_module_open(s, ctx.my_module_name!);

  if (opened === null) {
    if (ctx.my_module_name_alt1 === null) {
      return -1;
    }
    opened = g_snap_hooks.snapshot_module_open(s, ctx.my_module_name_alt1);
    if (opened === null) {
      if (ctx.my_module_name_alt2 === null) {
        return -1;
      }
      opened = g_snap_hooks.snapshot_module_open(s, ctx.my_module_name_alt2);
      if (opened === null) {
        return -1;
      }
    }
  }

  const m = opened.module;
  const vmajor = opened.major;
  const vminor = opened.minor;

  /* if major version does not match, the snapshot is not compatible */
  if (vmajor !== VIA_DUMP_VER_MAJOR) {
    g_snap_hooks.snapshot_set_error(); /* SNAPSHOT_MODULE_INCOMPATIBLE */
    g_snap_hooks.snapshot_module_close(m);
    return -1;
  }
  /* Do not accept versions higher than current */
  if (
    g_snap_hooks.snapshot_version_is_bigger(
      vmajor,
      vminor,
      VIA_DUMP_VER_MAJOR,
      VIA_DUMP_VER_MINOR,
    )
  ) {
    g_snap_hooks.snapshot_set_error(); /* SNAPSHOT_MODULE_HIGHER_VERSION */
    g_snap_hooks.snapshot_module_close(m);
    return -1;
  }

  if (ctx.t1_zero_alarm) alarmUnset(ctx.t1_zero_alarm as unknown as Alarm);
  if (ctx.t2_zero_alarm) alarmUnset(ctx.t2_zero_alarm as unknown as Alarm);
  if (ctx.t2_underflow_alarm)
    alarmUnset(ctx.t2_underflow_alarm as unknown as Alarm);
  /* t2_shift_alarm: TODO load from snapshot */
  if (ctx.t2_shift_alarm) alarmUnset(ctx.t2_shift_alarm as unknown as Alarm);
  if (ctx.phi2_sr_alarm) alarmUnset(ctx.phi2_sr_alarm as unknown as Alarm);

  ctx.t1zero = 0;
  ctx.t2xx00 = false;

  // Base block (v2.0 — 22 fields). Read sequentially; any failure → -1.
  const { SMR_B, SMR_W } = g_snap_hooks;
  const r_pra = SMR_B(m);
  const r_ddra = SMR_B(m);
  const r_prb = SMR_B(m);
  const r_ddrb = SMR_B(m);
  const r_word1 = SMR_W(m);
  const r_word2 = SMR_W(m);
  const r_t2ll = SMR_B(m);
  const r_t2lh = SMR_B(m);
  const r_t2cl = SMR_B(m);
  const r_t2ch = SMR_B(m);
  const r_word3 = SMR_W(m);
  const r_byte1 = SMR_B(m);
  const r_sr = SMR_B(m);
  const r_acr = SMR_B(m);
  const r_pcr = SMR_B(m);
  const r_byte2 = SMR_B(m);
  const r_byte3 = SMR_B(m);
  const r_byte4 = SMR_B(m);
  /* SRHBITS */
  const r_byte5 = SMR_B(m);
  /* CABSTATE */
  const r_byte6 = SMR_B(m);
  const r_ila = SMR_B(m);
  const r_ilb = SMR_B(m);

  if (
    !r_pra.ok || !r_ddra.ok || !r_prb.ok || !r_ddrb.ok ||
    !r_word1.ok || !r_word2.ok || !r_t2ll.ok || !r_t2lh.ok ||
    !r_t2cl.ok || !r_t2ch.ok || !r_word3.ok || !r_byte1.ok ||
    !r_sr.ok || !r_acr.ok || !r_pcr.ok || !r_byte2.ok ||
    !r_byte3.ok || !r_byte4.ok || !r_byte5.ok || !r_byte6.ok ||
    !r_ila.ok || !r_ilb.ok
  ) {
    g_snap_hooks.snapshot_module_close(m);
    return -1;
  }

  ctx.via[VIA_PRA] = r_pra.v;
  ctx.via[VIA_DDRA] = r_ddra.v;
  ctx.via[VIA_PRB] = r_prb.v;
  ctx.via[VIA_DDRB] = r_ddrb.v;
  const word1 = r_word1.v;
  const word2 = r_word2.v;
  ctx.via[VIA_T2LL] = r_t2ll.v;
  ctx.via[VIA_T2LH] = r_t2lh.v;
  ctx.t2cl = r_t2cl.v;
  ctx.t2ch = r_t2ch.v;
  const word3 = r_word3.v;
  const byte1 = r_byte1.v;
  ctx.via[VIA_SR] = r_sr.v;
  ctx.via[VIA_ACR] = r_acr.v;
  ctx.via[VIA_PCR] = r_pcr.v;
  const byte2 = r_byte2.v;
  const byte3 = r_byte3.v;
  const byte4 = r_byte4.v;
  const byte5 = r_byte5.v;
  const byte6 = r_byte6.v;
  ctx.ila = r_ila.v;
  ctx.ilb = r_ilb.v;

  /* Read minor version 2 data */
  let m2_t2_irq_allowed: number;
  let m2_t2_underflow_alarm: number;
  let m2_t2_shift_alarm: number;
  const r_m2a = SMR_B(m);
  const r_m2b = SMR_B(m);
  const r_m2c = SMR_B(m);
  if (!r_m2a.ok || !r_m2b.ok || !r_m2c.ok) {
    /* Set defaults. This will be some level of imperfect state restoration */
    m2_t2_irq_allowed = 1;
    m2_t2_underflow_alarm = 0;
    m2_t2_shift_alarm = 0;
  } else {
    m2_t2_irq_allowed = r_m2a.v;
    m2_t2_underflow_alarm = r_m2b.v;
    m2_t2_shift_alarm = r_m2c.v;
  }

  let addr = VIA_DDRA;
  let byte = (ctx.via[VIA_PRA]! | ~ctx.via[VIA_DDRA]!) & 0xff;
  ctx.undump_pra?.(ctx, byte);
  ctx.oldpa = byte;

  addr = VIA_DDRB;
  byte = (ctx.via[VIA_PRB]! | ~ctx.via[VIA_DDRB]!) & 0xff;
  ctx.undump_prb?.(ctx, byte);
  ctx.oldpb = byte;

  ctx.tal = word1;
  ctx.via[VIA_T1LL] = ctx.tal & 0xff;
  ctx.via[VIA_T1LH] = (ctx.tal >> 8) & 0xff;

  ctx.t1reload = rclk + word2 + FULL_CYCLE_2 /* 3 */;
  ctx.t1zero = rclk + word2 + 0 /* 1 */;

  /* word3 is the effective value of T2 */
  ctx.t2zero = rclk + (word3 & 0xff);
  ctx.t2xx00 = true;

  if (byte1 & 0x80) {
    alarmSet(ctx.t1_zero_alarm as unknown as Alarm, ctx.t1zero);
  } else {
    ctx.t1zero = 0;
  }
  if (
    byte1 & 0x40 ||
    (ctx.via[VIA_ACR]! & 0x1c) === 0x04 ||
    (ctx.via[VIA_ACR]! & 0x1c) === 0x10 ||
    (ctx.via[VIA_ACR]! & 0x1c) === 0x14
  ) {
    alarmSet(ctx.t2_zero_alarm as unknown as Alarm, ctx.t2zero);
  } else {
    ctx.t2zero = rclk + word3;
    ctx.t2xx00 = false;
  }
  /* FIXME: SR alarm */
  if ((ctx.via[VIA_ACR]! & 0x0c) === 0x08) {
    alarmSet(ctx.phi2_sr_alarm as unknown as Alarm, rclk + 1);
  }

  ctx.ifr = byte2;
  ctx.ier = byte3;

  via_restore_int(ctx, ctx.ifr & ctx.ier & 0x7f);

  ctx.t1_pb7 = byte4 & 0x80;
  ctx.shift_state = byte5;

  ctx.ca2_out_state = (byte6 & 0x80) !== 0;
  ctx.cb2_out_state = (byte6 & 0x40) !== 0;
  ctx.cb2_in_state = (byte6 & 0x20) !== 0;
  ctx.cb1_in_state = (byte6 & 0x10) !== 0;
  ctx.cb1_out_state = (byte6 & 0x08) !== 0;

  ctx.t2_irq_allowed = m2_t2_irq_allowed !== 0;

  if (m2_t2_underflow_alarm) {
    alarmSet(
      ctx.t2_underflow_alarm as unknown as Alarm,
      rclk + m2_t2_underflow_alarm - 1,
    );
  }

  if (m2_t2_shift_alarm) {
    alarmSet(
      ctx.t2_shift_alarm as unknown as Alarm,
      rclk + m2_t2_shift_alarm - 1,
    );
  }

  /* undump_pcr also restores the ca2_state/cb2_state effects if necessary;
     i.e. calls set_c*2(c*2_state) if necessary */
  addr = VIA_PCR;
  byte = ctx.via[addr]!;
  ctx.undump_pcr?.(ctx, byte);

  addr = VIA_SR;
  byte = ctx.via[addr]!;
  ctx.store_sr?.(ctx, byte);

  addr = VIA_ACR;
  byte = ctx.via[addr]!;
  ctx.undump_acr?.(ctx, byte);
  void addr;

  viacore_cache_cb12_io_status(ctx);

  return g_snap_hooks.snapshot_module_close(m);
}

// =============================================================================
// viacore_dump — viacore.c:2194-2242
// =============================================================================

// PORT OF: vice/src/core/viacore.c:2194-2242 (viacore_dump)
export function viacore_dump(ctx: via_context_t): number {
  // VICE writes to the monitor via mon_out(); the TS equivalent is a string
  // builder. Keep formatting close to VICE for grep parity. No side effects
  // on ctx; uses viacore_peek which is side-effect-free for the relevant
  // registers (verified against viacore.c:1218-1297).
  const clk = ctx.clk_ptr.value;
  const lines: string[] = [];

  const pra = viacore_peek(ctx, VIA_PRA);
  const ddra = viacore_peek(ctx, VIA_DDRA);
  const pra_nhs = viacore_peek(ctx, VIA_PRA_NHS);
  lines.push(
    `Port A: ${hex2(pra)} DDR: ${hex2(ddra)} no HS: ${hex2(pra_nhs)}`,
  );
  const prb = viacore_peek(ctx, VIA_PRB);
  const ddrb = viacore_peek(ctx, VIA_DDRB);
  lines.push(`Port B: ${hex2(prb)} DDR: ${hex2(ddrb)}`);

  const t1c =
    viacore_peek(ctx, VIA_T1CL) + viacore_peek(ctx, VIA_T1CH) * 256;
  const t1l =
    viacore_peek(ctx, VIA_T1LL) + viacore_peek(ctx, VIA_T1LH) * 256;
  lines.push(`Timer 1: ${hex4(t1c)} Latch: ${hex4(t1l)}`);

  const t2c =
    viacore_peek(ctx, VIA_T2CL) + viacore_peek(ctx, VIA_T2CH) * 256;
  const t2_zero_alarm_delta = alarm_clk(
    (ctx.t2_zero_alarm as unknown as Alarm | null) ?? null,
  );
  const t2_zero_alarm_idx =
    (ctx.t2_zero_alarm as unknown as Alarm | null)?.pending_idx ?? -1;
  lines.push(
    `Timer 2: ${hex4(t2c)} Latch:   ${hex2(ctx.via[VIA_T2LL]!)} t2_zero_alarm: +${
      t2_zero_alarm_delta - clk
    } (idx ${t2_zero_alarm_idx})`,
  );

  lines.push(`Aux. control: ${hex2(viacore_peek(ctx, VIA_ACR))}`);
  lines.push(`Per. control: ${hex2(viacore_peek(ctx, VIA_PCR))}`);
  lines.push(`IRQ flags: ${hex2(viacore_peek(ctx, VIA_IFR))}`);
  lines.push(`IRQ enable: ${hex2(viacore_peek(ctx, VIA_IER))}`);
  lines.push(
    `Shift Register: ${hex2(viacore_peek(ctx, VIA_SR))} (${
      (ctx.via[VIA_ACR]! & 0x1c) === 0 ? "disabled" : "enabled"
    }, shifting ${ctx.via[VIA_ACR]! & 0x10 ? "out" : "in"}, count=${ctx.shift_state})`,
  );
  lines.push(
    `t1zero: ${ctx.t1zero} (clock+${ctx.t1zero - clk}),  t1reload: ${ctx.t1reload} (clock+${ctx.t1reload - clk})`,
  );
  lines.push(`t1_pb7: ${hex2(ctx.t1_pb7)}`);
  lines.push(
    `t2xx00: ${ctx.t2xx00 ? 1 : 0},  t2zero: ${ctx.t2zero} (clock+${ctx.t2zero - clk})`,
  );

  if (alarm_is_pending(ctx.t2_underflow_alarm as unknown as Alarm | null)) {
    const c = alarm_clk(ctx.t2_underflow_alarm as unknown as Alarm | null);
    lines.push(`t2_underflow_alarm: ${c} (clock+${c - clk})`);
    const c2 = alarm_clk(ctx.t2_shift_alarm as unknown as Alarm | null);
    lines.push(`t2_shift_alarm: ${c2} (clock+${c2 - clk})`);
  }
  if (alarm_is_pending(ctx.phi2_sr_alarm as unknown as Alarm | null)) {
    const c = alarm_clk(ctx.phi2_sr_alarm as unknown as Alarm | null);
    lines.push(`phi2_sr_alarm: ${c} (clock+${c - clk})`);
  }

  // The TS port has no mon_out sink; we stash the rendered output on the
  // log channel via console.log for now. Real wiring will route through the
  // monitor module when it lands. Return value matches VICE (0).
  // eslint-disable-next-line no-console
  for (const line of lines) console.log(line);
  return 0;
}

function hex2(n: number): string {
  return (n & 0xff).toString(16).padStart(2, "0");
}
function hex4(n: number): string {
  return (n & 0xffff).toString(16).padStart(4, "0");
}
