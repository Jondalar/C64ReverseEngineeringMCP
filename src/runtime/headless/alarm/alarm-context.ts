// Spec 448 — alarm.c + alarm.h literal port (Claude-self re-audit
// 2026-05-14). Sprint 148/149 verdicts INVALIDATED under Epic-440
// doctrine; this is the canonical literal port.
//
// Source: VICE 3.7.1 src/alarm.h (187 LoC) + src/alarm.c (212 LoC).
//
// Data structure: per-context UNSORTED `pending_alarms[256]` array
// with cached `next_pending_alarm_clk` + `next_pending_alarm_idx`.
// NOT a min-heap — VICE prefers cache invalidation + linear rescan
// over heap maintenance for the small N (≤ 256) and rare reschedule
// cost. Sprint 149 header-comment falsely claimed "min-heap"; that
// claim is purged here.
//
// Tie-breaking: when multiple alarms have the same clk,
// `alarm_context_update_next_pending` (alarm.h:110-129) uses `<=`
// in the comparator, so the LAST entry in array order wins as the
// cached head. Registration order is preserved by `alarm_set`
// appending to `pending_alarms[num_pending_alarms]`.
//
// FLACH-MANDATE compliance:
//   - Top-level function exports (alarm_set, alarm_unset, ...) — no
//     class wrappers, no method-this. C-style port.
//   - VICE-verbatim snake_case identifiers for all public names.
//   - Interfaces named literally: alarm_t, alarm_context_t,
//     alarm_callback_t, pending_alarms_t.
//
// Width semantics: CLOCK is uint32 in VICE; modelled via `CLOCK`
// alias + `u32` wrap helper. Comparison uses raw `<=` against
// `CLOCK_MAX = 0xFFFFFFFF`. Larger numeric = later in time.

import { u32, type CLOCK } from "../util/uint.js";

// ---------------------------------------------------------------------------
// Constants — alarm.h:33, types.h CLOCK_MAX.
// ---------------------------------------------------------------------------

/** alarm.h:33 `#define ALARM_CONTEXT_MAX_PENDING_ALARMS 0x100`. */
export const ALARM_CONTEXT_MAX_PENDING_ALARMS = 0x100;

/** types.h `#define CLOCK_MAX (~((CLOCK)0))` — uint32 max. */
export const CLOCK_MAX: CLOCK = 0xffffffff >>> 0;

// ---------------------------------------------------------------------------
// Types — alarm.h:35-88. snake_case verbatim per FLACH-MANDATE.
// ---------------------------------------------------------------------------

/** alarm.h:35 `typedef void (*alarm_callback_t)(CLOCK offset, void *data);`. */
// eslint-disable-next-line @typescript-eslint/naming-convention
export type alarm_callback_t = (offset: CLOCK, data: unknown) => void;

/**
 * alarm.h:38-58 — `struct alarm_s` / `alarm_t`.
 *
 * `pending_idx === -1` means "not pending" (alarm_init initial state).
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
export interface alarm_t {
  /** alarm.h:40 descriptive name. */
  name: string;
  /** alarm.h:43 owning context (back-reference). */
  context: alarm_context_t;
  /** alarm.h:46 callback fired by alarm_context_dispatch. */
  callback: alarm_callback_t;
  /** alarm.h:50 index into context.pending_alarms; < 0 = not pending. */
  pending_idx: number;
  /** alarm.h:53 opaque user data passed to callback. */
  data: unknown;
  /** alarm.h:56 doubly-linked list pointers in context.alarms. */
  next: alarm_t | null;
  prev: alarm_t | null;
}

/** alarm.h:60-67 `struct pending_alarms_s` / `pending_alarms_t`. */
// eslint-disable-next-line @typescript-eslint/naming-convention
export interface pending_alarms_t {
  alarm: alarm_t;
  clk: CLOCK;
}

/** alarm.h:70-88 `struct alarm_context_s` / `alarm_context_t`. */
// eslint-disable-next-line @typescript-eslint/naming-convention
export interface alarm_context_t {
  /** alarm.h:72 descriptive name. */
  name: string;
  /** alarm.h:75 head of doubly-linked alarm registration list. */
  alarms: alarm_t | null;
  /** alarm.h:79 fixed-size (256) unsorted pending array. */
  pending_alarms: pending_alarms_t[];
  /** alarm.h:80 number of valid entries in `pending_alarms[0..num-1]`. */
  num_pending_alarms: number;
  /** alarm.h:83 cached next-fire clk (CLOCK_MAX when none pending). */
  next_pending_alarm_clk: CLOCK;
  /** alarm.h:86 cached pending-array idx of next-fire alarm (-1 when none). */
  next_pending_alarm_idx: number;
}

// ---------------------------------------------------------------------------
// Context lifecycle — alarm.c:39-77.
// ---------------------------------------------------------------------------

/**
 * alarm.c:39-47 `alarm_context_t *alarm_context_new(const char *name)`.
 * Allocates + initialises.
 */
export function alarm_context_new(name: string): alarm_context_t {
  const context: alarm_context_t = {
    name: "",
    alarms: null,
    pending_alarms: new Array(ALARM_CONTEXT_MAX_PENDING_ALARMS),
    num_pending_alarms: 0,
    next_pending_alarm_clk: CLOCK_MAX,
    next_pending_alarm_idx: -1,
  };
  alarm_context_init(context, name);
  return context;
}

/**
 * alarm.c:49-57 `alarm_context_init`. VICE leaves next_pending_alarm_idx
 * uninitialised; TS sets explicitly to -1 for determinism.
 */
export function alarm_context_init(context: alarm_context_t, name: string): void {
  context.name = name;
  context.alarms = null;
  context.num_pending_alarms = 0;
  context.next_pending_alarm_clk = CLOCK_MAX;
  context.next_pending_alarm_idx = -1;
}

/**
 * alarm.c:59-77 `alarm_context_destroy`. Walks alarm list and destroys
 * each. TS has GC; we unlink to break references.
 */
export function alarm_context_destroy(context: alarm_context_t): void {
  let ap = context.alarms;
  while (ap !== null) {
    const ap_next: alarm_t | null = ap.next;
    alarm_destroy(ap);
    ap = ap_next;
  }
  context.alarms = null;
  context.num_pending_alarms = 0;
  context.next_pending_alarm_clk = CLOCK_MAX;
  context.next_pending_alarm_idx = -1;
}

/**
 * alarm.c:79-101 `alarm_context_time_warp`. Shifts every pending
 * alarm's clk by `warp_amount` in the given direction (0 → no-op).
 */
export function alarm_context_time_warp(
  context: alarm_context_t,
  warp_amount: CLOCK,
  warp_direction: number,
): void {
  if (warp_direction === 0) return;

  for (let i = 0; i < context.num_pending_alarms; i++) {
    const slot = context.pending_alarms[i]!;
    if (warp_direction > 0) {
      slot.clk = u32(slot.clk + warp_amount);
    } else {
      slot.clk = u32(slot.clk - warp_amount);
    }
  }

  if (warp_direction > 0) {
    context.next_pending_alarm_clk = u32(context.next_pending_alarm_clk + warp_amount);
  } else {
    context.next_pending_alarm_clk = u32(context.next_pending_alarm_clk - warp_amount);
  }
}

// ---------------------------------------------------------------------------
// Alarm lifecycle — alarm.c:105-165.
// ---------------------------------------------------------------------------

/**
 * alarm.c:105-125 `alarm_init` (static) + alarm.c:127-137 `alarm_new`.
 * Prepends to context.alarms (matches VICE), sets pending_idx = -1.
 */
export function alarm_new(
  context: alarm_context_t,
  name: string,
  callback: alarm_callback_t,
  data: unknown,
): alarm_t {
  const alarm: alarm_t = {
    name,
    context,
    callback,
    pending_idx: -1,
    data,
    next: null,
    prev: null,
  };

  // alarm.c:116-124 prepend.
  if (context.alarms === null) {
    context.alarms = alarm;
    alarm.next = null;
  } else {
    alarm.next = context.alarms;
    context.alarms.prev = alarm;
    context.alarms = alarm;
  }
  alarm.prev = null;

  return alarm;
}

/**
 * alarm.c:139-165 `alarm_destroy`. Unsets if pending, unlinks from
 * context.alarms. No-op on null input (matches VICE).
 */
export function alarm_destroy(alarm: alarm_t | null | undefined): void {
  if (alarm == null) return;

  alarm_unset(alarm);

  const context = alarm.context;

  if (alarm === context.alarms) {
    context.alarms = alarm.next;
  }

  if (alarm.next !== null) alarm.next.prev = alarm.prev;
  if (alarm.prev !== null) alarm.prev.next = alarm.next;

  alarm.next = null;
  alarm.prev = null;
}

/**
 * alarm.c:167-207 `alarm_unset`. Removes from pending_alarms by
 * swap-with-last (packed array). Updates next_pending cache:
 *   - If removed alarm was cached head: full slow-path rescan.
 *   - If swap displaces cached head: patch cached idx.
 *   - Else: untouched (cached head still valid).
 */
export function alarm_unset(alarm: alarm_t): void {
  const idx = alarm.pending_idx;
  if (idx < 0) return; // Not pending.
  const context = alarm.context;

  if (context.num_pending_alarms > 1) {
    const last = --context.num_pending_alarms;

    if (last !== idx) {
      // alarm.c:184-193 copy last → idx, fix moved.pending_idx.
      const slot_idx = context.pending_alarms[idx]!;
      const slot_last = context.pending_alarms[last]!;
      slot_idx.alarm = slot_last.alarm;
      slot_idx.clk = slot_last.clk;
      slot_idx.alarm.pending_idx = idx;
    }

    if (context.next_pending_alarm_idx === idx) {
      alarm_context_update_next_pending(context);
    } else if (context.next_pending_alarm_idx === last) {
      context.next_pending_alarm_idx = idx;
    }
  } else {
    // alarm.c:200-204 last-removed reset.
    context.num_pending_alarms = 0;
    context.next_pending_alarm_clk = CLOCK_MAX;
    context.next_pending_alarm_idx = -1;
  }

  alarm.pending_idx = -1;
}

// ---------------------------------------------------------------------------
// Inline functions — alarm.h:105-185.
// ---------------------------------------------------------------------------

/** alarm.h:105-108 `alarm_context_next_pending_clk` cached peek. */
export function alarm_context_next_pending_clk(context: alarm_context_t): CLOCK {
  return context.next_pending_alarm_clk;
}

/**
 * alarm.h:110-129 `alarm_context_update_next_pending`. Slow-path
 * linear scan over `pending_alarms[0..num_pending_alarms-1]`. Uses
 * `<=` comparator so LAST entry in array order wins for same-clk
 * ties. Matches VICE 1:1.
 */
export function alarm_context_update_next_pending(context: alarm_context_t): void {
  let next_pending_alarm_clk: CLOCK = CLOCK_MAX;
  let next_pending_alarm_idx: number = context.next_pending_alarm_idx;

  for (let i = 0; i < context.num_pending_alarms; i++) {
    const pending_clk = context.pending_alarms[i]!.clk;
    if (pending_clk <= next_pending_alarm_clk) {
      next_pending_alarm_clk = pending_clk;
      next_pending_alarm_idx = i;
    }
  }

  context.next_pending_alarm_clk = next_pending_alarm_clk;
  context.next_pending_alarm_idx = next_pending_alarm_idx;
}

/**
 * alarm.h:131-144 `alarm_context_dispatch`. Fires ONE alarm — the
 * cached next-pending entry — passing `offset = cpu_clk - clk` +
 * alarm data. Does NOT remove or re-cache — callback is expected to
 * call alarm_set (reschedule) or alarm_unset (one-shot).
 *
 * TS-EXTRA-ACCEPTABLE: defensive throw on invalid index (VICE would
 * deref garbage; TS throws clear error).
 */
export function alarm_context_dispatch(
  context: alarm_context_t,
  cpu_clk: CLOCK,
): void {
  const offset: CLOCK = u32(cpu_clk - context.next_pending_alarm_clk);
  const idx = context.next_pending_alarm_idx;
  const slot = context.pending_alarms[idx];
  if (slot === undefined) {
    throw new Error(
      `alarm_context_dispatch: no pending alarm (idx=${idx}, num_pending=${context.num_pending_alarms})`,
    );
  }
  const alarm = slot.alarm;
  alarm.callback(offset, alarm.data);
}

/**
 * alarm.h:146-185 `alarm_set`. Schedule / reschedule alarm at cpu_clk.
 *   - Not pending (pending_idx < 0): append to pending_alarms;
 *     update cache if new clk < cached.
 *   - Already pending: overwrite slot's clk; rescan cache if new clk
 *     earlier OR alarm IS the cached head.
 * Capacity overflow → alarm_log_too_many_alarms + return.
 */
export function alarm_set(alarm: alarm_t, cpu_clk: CLOCK): void {
  const context = alarm.context;
  const idx = alarm.pending_idx;

  if (idx < 0) {
    const new_idx = context.num_pending_alarms;
    if (new_idx >= ALARM_CONTEXT_MAX_PENDING_ALARMS) {
      alarm_log_too_many_alarms();
      return;
    }

    context.pending_alarms[new_idx] = { alarm, clk: cpu_clk };
    context.num_pending_alarms++;

    if (cpu_clk < context.next_pending_alarm_clk) {
      context.next_pending_alarm_clk = cpu_clk;
      context.next_pending_alarm_idx = new_idx;
    }

    alarm.pending_idx = new_idx;
  } else {
    context.pending_alarms[idx]!.clk = cpu_clk;
    if (
      context.next_pending_alarm_clk > cpu_clk ||
      idx === context.next_pending_alarm_idx
    ) {
      alarm_context_update_next_pending(context);
    }
  }
}

/**
 * alarm.c:209-212 `alarm_log_too_many_alarms`. VICE log_error; TS
 * console.warn. TS-EXTRA-ACCEPTABLE.
 */
export function alarm_log_too_many_alarms(): void {
  console.warn("alarm_set(): Too many alarms set!");
}

// ---------------------------------------------------------------------------
// Spec 448 transition aliases — camelCase exports retained as
// @deprecated re-exports during caller migration. Remove in a
// follow-up commit once all 45 callers migrate to snake_case.
// ---------------------------------------------------------------------------

/** @deprecated Spec 448 — use `alarm_t` instead. */
export type Alarm = alarm_t;
/** @deprecated Spec 448 — use `alarm_context_t` instead. */
export type AlarmContext = alarm_context_t;
/** @deprecated Spec 448 — use `alarm_callback_t` instead. */
export type AlarmCallback = alarm_callback_t;
/** @deprecated Spec 448 — use `pending_alarms_t` instead. */
export type PendingAlarm = pending_alarms_t;

/** @deprecated Spec 448 — use `alarm_context_new` instead. */
export const alarmContextNew = alarm_context_new;
/** @deprecated Spec 448 — use `alarm_context_init` instead. */
export const alarmContextInit = alarm_context_init;
/** @deprecated Spec 448 — use `alarm_context_destroy` instead. */
export const alarmContextDestroy = alarm_context_destroy;
/** @deprecated Spec 448 — use `alarm_context_time_warp` instead. */
export const alarmContextTimeWarp = alarm_context_time_warp;
/** @deprecated Spec 448 — use `alarm_new` instead. */
export const alarmNew = alarm_new;
/** @deprecated Spec 448 — use `alarm_destroy` instead. */
export const alarmDestroy = alarm_destroy;
/** @deprecated Spec 448 — use `alarm_unset` instead. */
export const alarmUnset = alarm_unset;
/** @deprecated Spec 448 — use `alarm_log_too_many_alarms` instead. */
export const alarmLogTooManyAlarms = alarm_log_too_many_alarms;
/** @deprecated Spec 448 — use `alarm_context_next_pending_clk` instead. */
export const alarmContextNextPendingClk = alarm_context_next_pending_clk;
/** @deprecated Spec 448 — use `alarm_context_update_next_pending` instead. */
export const alarmContextUpdateNextPending = alarm_context_update_next_pending;
/** @deprecated Spec 448 — use `alarm_context_dispatch` instead. */
export const alarmContextDispatch = alarm_context_dispatch;
/** @deprecated Spec 448 — use `alarm_set` instead. */
export const alarmSet = alarm_set;
