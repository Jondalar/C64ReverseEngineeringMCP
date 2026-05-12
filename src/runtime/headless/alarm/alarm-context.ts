// Spec 149 — Alarm system 1:1 VICE port (FOUNDATION).
//
// Spec 401 audit (= docs/vice-c64-arch.md §12 Phase A step 2): the
// public API + on-disk shape already match VICE alarm.h/alarm.c
// (min-heap-by-clock, alarm_set / alarm_unset / alarm_context_dispatch /
// alarm_context_next_pending_clk). The CPU's per-cycle CLK_INC tick
// (cpu/cpu65xx-vice.ts:tick) calls into this module; no changes were
// required for spec 401. Drain ordering is owned by the CPU (= drain
// BEFORE clk++ per §11 step 1.a, §13 invariant 1).
//
// Source: VICE 3.7.1 src/alarm.h (187 LOC) + src/alarm.c (212 LOC).
// This is a faithful translation of the VICE alarm primitive: a per-
// context unsorted "pending alarms" array (cap 256) with a cached
// next-pending head. Chip code (CIA / VIA / CPU / VIC) ported in later
// steps will call into this module using the VICE-equivalent function
// names verbatim, so the API surface here is greppable against
// alarm.c. Hybrid naming: internal struct fields keep VICE names
// (snake_case, e.g. `pending_idx`, `num_pending_alarms`) so chip ports
// can mechanically transcribe `alarm->pending_idx = -1;` etc. Public
// function exports use camelCase TS conventions (alarmSet,
// alarmContextDispatch...).
//
// Scope: alarm primitives + unit tests only. Chip integration (CIA
// timer underflow, VIA T1/T2, VIC raster, TOD, SDR) lands in
// subsequent steps. The CPU dispatch loop wiring is also out of scope
// for this foundation step.
//
// Width semantics: CLOCK is uint32 in VICE; we model that explicitly
// via the `CLOCK` alias and `u32` helper from `../util/uint.ts`. Note
// that VICE pending-alarm comparison is done with raw `<=` against
// CLOCK_MAX = 0xFFFFFFFF — i.e. larger numeric value = later in time.
// In TS-number land this still holds for unsigned uint32 quantities,
// so the comparators below mirror VICE 1:1 without any wrap handling
// (matches VICE semantics: the CPU loop is expected to never let
// pending clks exceed UINT32_MAX without an explicit time-warp).

import { u32, type CLOCK } from "../util/uint.js";

// ---------------------------------------------------------------------------
// Constants — alarm.h lines 33, types.h CLOCK_MAX = ~(CLOCK)0.
// ---------------------------------------------------------------------------

/** alarm.h line 33: `#define ALARM_CONTEXT_MAX_PENDING_ALARMS 0x100`. */
export const ALARM_CONTEXT_MAX_PENDING_ALARMS = 0x100;

/** types.h: `#define CLOCK_MAX (~((CLOCK)0))` — uint32 max. */
export const CLOCK_MAX: CLOCK = 0xffffffff >>> 0;

// ---------------------------------------------------------------------------
// Types — alarm.h lines 35-88.
// ---------------------------------------------------------------------------

/** alarm.h line 35: `typedef void (*alarm_callback_t)(CLOCK offset, void *data);`. */
export type AlarmCallback = (offset: CLOCK, data: unknown) => void;

/**
 * alarm.h lines 38-58 — `struct alarm_s` / `alarm_t`.
 *
 * Field names match VICE verbatim. `pending_idx === -1` means "not
 * pending" (matches VICE init in alarm_init).
 */
export interface Alarm {
  /** Descriptive name. alarm.h line 40. */
  name: string;
  /** Owning context. alarm.h line 43. */
  context: AlarmContext;
  /** Callback. alarm.h line 46. */
  callback: AlarmCallback;
  /** Index into context.pending_alarms; < 0 means not pending. alarm.h line 50. */
  pending_idx: number;
  /** Opaque user data passed to callback. alarm.h line 53. */
  data: unknown;
  /** Doubly-linked list pointers in context.alarms. alarm.h line 56. */
  next: Alarm | null;
  prev: Alarm | null;
}

/** alarm.h lines 60-67 — `struct pending_alarms_s`. */
export interface PendingAlarm {
  alarm: Alarm;
  clk: CLOCK;
}

/** alarm.h lines 70-88 — `struct alarm_context_s`. */
export interface AlarmContext {
  /** Descriptive name. alarm.h line 72. */
  name: string;
  /** Head of doubly-linked alarm list (all registered alarms). alarm.h line 75. */
  alarms: Alarm | null;
  /** Pending alarm array (statically sized in VICE; we size-fix at 256). alarm.h line 79. */
  pending_alarms: PendingAlarm[];
  /** Number of valid entries in pending_alarms[0..num_pending_alarms-1]. alarm.h line 80. */
  num_pending_alarms: number;
  /** Cached next-fire clk (CLOCK_MAX when none). alarm.h line 83. */
  next_pending_alarm_clk: CLOCK;
  /** Cached pending_alarms[] index of the next-fire alarm (-1 when none). alarm.h line 86. */
  next_pending_alarm_idx: number;
}

// ---------------------------------------------------------------------------
// Context lifecycle — alarm.c lines 39-77.
// ---------------------------------------------------------------------------

/**
 * alarm.c lines 39-47 — `alarm_context_t *alarm_context_new(const char *name)`.
 *
 * In VICE this allocates the context struct then calls
 * alarm_context_init. In TS we collapse the two: the constructor
 * initialises a fresh AlarmContext.
 */
export function alarmContextNew(name: string): AlarmContext {
  const context: AlarmContext = {
    name: "", // overwritten by alarmContextInit
    alarms: null,
    pending_alarms: new Array(ALARM_CONTEXT_MAX_PENDING_ALARMS),
    num_pending_alarms: 0,
    next_pending_alarm_clk: CLOCK_MAX,
    next_pending_alarm_idx: -1,
  };
  alarmContextInit(context, name);
  return context;
}

/**
 * alarm.c lines 49-57 — `alarm_context_init`.
 *
 * VICE leaves `next_pending_alarm_idx` uninitialised here (-1 is the
 * convention used by alarm_unset / alarm_init); we set it explicitly
 * for determinism. Pending array is zeroed implicitly by JS array
 * allocation (slots are `undefined` until `alarm_set` writes them).
 */
export function alarmContextInit(context: AlarmContext, name: string): void {
  context.name = name;
  context.alarms = null;
  context.num_pending_alarms = 0;
  context.next_pending_alarm_clk = CLOCK_MAX;
  context.next_pending_alarm_idx = -1;
}

/**
 * alarm.c lines 59-77 — `alarm_context_destroy`.
 *
 * Walks the per-context alarm list and destroys each. In TS we don't
 * have manual frees; we just unlink everything to break references so
 * the GC can collect.
 */
export function alarmContextDestroy(context: AlarmContext): void {
  let ap = context.alarms;
  while (ap !== null) {
    const apNext: Alarm | null = ap.next;
    alarmDestroy(ap);
    ap = apNext;
  }
  context.alarms = null;
  context.num_pending_alarms = 0;
  context.next_pending_alarm_clk = CLOCK_MAX;
  context.next_pending_alarm_idx = -1;
  // We leave context.name in place; mirrors lib_free in VICE which is
  // a no-op for our purposes. Caller drops the reference.
}

/**
 * alarm.c lines 79-101 — `alarm_context_time_warp`.
 *
 * Shifts every pending alarm's clk by `warp_amount` in the given
 * direction. Direction 0 → no-op (matches VICE early-return). Positive
 * → add, negative → subtract. We fold through `u32` so wrap matches
 * VICE uint32 semantics.
 */
export function alarmContextTimeWarp(
  context: AlarmContext,
  warpAmount: CLOCK,
  warpDirection: number,
): void {
  if (warpDirection === 0) {
    return;
  }

  for (let i = 0; i < context.num_pending_alarms; i++) {
    const slot = context.pending_alarms[i]!;
    if (warpDirection > 0) {
      slot.clk = u32(slot.clk + warpAmount);
    } else {
      slot.clk = u32(slot.clk - warpAmount);
    }
  }

  if (warpDirection > 0) {
    context.next_pending_alarm_clk = u32(
      context.next_pending_alarm_clk + warpAmount,
    );
  } else {
    context.next_pending_alarm_clk = u32(
      context.next_pending_alarm_clk - warpAmount,
    );
  }
}

// ---------------------------------------------------------------------------
// Alarm lifecycle — alarm.c lines 105-165.
// ---------------------------------------------------------------------------

/**
 * alarm.c lines 105-125 — `alarm_init` (static helper) + 127-137
 * `alarm_new`.
 *
 * Allocates an Alarm, links it at the HEAD of context.alarms (matches
 * VICE prepend), sets pending_idx = -1.
 */
export function alarmNew(
  context: AlarmContext,
  name: string,
  callback: AlarmCallback,
  data: unknown,
): Alarm {
  const alarm: Alarm = {
    name,
    context,
    callback,
    pending_idx: -1,
    data,
    next: null,
    prev: null,
  };

  // alarm.c lines 116-124 — prepend to context.alarms.
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
 * alarm.c lines 139-165 — `alarm_destroy`.
 *
 * Unsets the alarm if pending, then unlinks from context.alarms.
 * Mirrors VICE behavior of being a no-op on null input.
 */
export function alarmDestroy(alarm: Alarm | null | undefined): void {
  if (alarm == null) {
    return;
  }

  alarmUnset(alarm);

  const context = alarm.context;

  if (alarm === context.alarms) {
    context.alarms = alarm.next;
  }

  if (alarm.next !== null) {
    alarm.next.prev = alarm.prev;
  }
  if (alarm.prev !== null) {
    alarm.prev.next = alarm.next;
  }

  // Help GC.
  alarm.next = null;
  alarm.prev = null;
}

/**
 * alarm.c lines 167-207 — `alarm_unset`.
 *
 * Removes the alarm from pending_alarms by swap-with-last (preserves
 * packed array). Updates next_pending cache: if the alarm being
 * removed was the cached head, full slow-path re-scan; if the swap
 * displaces the cached head, just patch the cached idx.
 */
export function alarmUnset(alarm: Alarm): void {
  const idx = alarm.pending_idx;

  if (idx < 0) {
    return; // Not pending.
  }
  const context = alarm.context;

  if (context.num_pending_alarms > 1) {
    const last = --context.num_pending_alarms;

    if (last !== idx) {
      // alarm.c lines 184-193 — copy last → idx, fix moved alarm's
      // pending_idx.
      const slotIdx = context.pending_alarms[idx]!;
      const slotLast = context.pending_alarms[last]!;
      slotIdx.alarm = slotLast.alarm;
      slotIdx.clk = slotLast.clk;
      slotIdx.alarm.pending_idx = idx;
    }

    if (context.next_pending_alarm_idx === idx) {
      alarmContextUpdateNextPending(context);
    } else if (context.next_pending_alarm_idx === last) {
      // The cached head was the entry we just moved; patch the cached
      // index to its new home.
      context.next_pending_alarm_idx = idx;
    }
  } else {
    // alarm.c lines 200-204 — last pending alarm removed; reset.
    context.num_pending_alarms = 0;
    context.next_pending_alarm_clk = CLOCK_MAX;
    context.next_pending_alarm_idx = -1;
  }

  alarm.pending_idx = -1;
}

// ---------------------------------------------------------------------------
// Inline functions — alarm.h lines 105-185.
// ---------------------------------------------------------------------------

/**
 * alarm.h lines 105-108 — `alarm_context_next_pending_clk`.
 *
 * Cached peek. Returns CLOCK_MAX when no alarms pending.
 */
export function alarmContextNextPendingClk(context: AlarmContext): CLOCK {
  return context.next_pending_alarm_clk;
}

/**
 * alarm.h lines 110-129 — `alarm_context_update_next_pending`.
 *
 * Slow-path linear scan over pending_alarms[0..num_pending_alarms-1].
 * Note VICE uses `<=` (not `<`) when comparing — so among multiple
 * entries with the SAME clk, the LAST one in array order wins as the
 * cached head. Matches VICE 1:1.
 */
export function alarmContextUpdateNextPending(context: AlarmContext): void {
  let nextPendingAlarmClk: CLOCK = CLOCK_MAX;
  let nextPendingAlarmIdx: number = context.next_pending_alarm_idx;

  for (let i = 0; i < context.num_pending_alarms; i++) {
    const pendingClk = context.pending_alarms[i]!.clk;

    if (pendingClk <= nextPendingAlarmClk) {
      nextPendingAlarmClk = pendingClk;
      nextPendingAlarmIdx = i;
    }
  }

  context.next_pending_alarm_clk = nextPendingAlarmClk;
  context.next_pending_alarm_idx = nextPendingAlarmIdx;
}

/**
 * alarm.h lines 131-144 — `alarm_context_dispatch`.
 *
 * Fires ONE alarm — the cached next-pending entry — passing
 * `offset = cpu_clk - clk` and the alarm's data. Does NOT remove the
 * alarm; the callback is expected to call alarmSet (reschedule) or
 * alarmUnset (one-shot) itself. After the callback returns, callers
 * (typically the CPU loop) will call this again until
 * alarmContextNextPendingClk(context) > current clk.
 *
 * CRITICAL: VICE does NOT update next_pending after dispatch — that's
 * the callback's responsibility (since it must alarmSet/alarmUnset
 * which both maintain the cache). We mirror that 1:1. If the callback
 * neither reschedules nor unsets, the cache becomes stale; the next
 * dispatch will re-fire the same alarm.
 *
 * Throws if called with no pending alarms — matches VICE which would
 * deref an invalid index. Callers are expected to peek-check first.
 */
export function alarmContextDispatch(
  context: AlarmContext,
  cpuClk: CLOCK,
): void {
  const offset: CLOCK = u32(cpuClk - context.next_pending_alarm_clk);
  const idx = context.next_pending_alarm_idx;
  const slot = context.pending_alarms[idx];
  if (slot === undefined) {
    // Defensive: VICE would crash here; we throw a clear error so
    // misuse is caught immediately rather than producing silent UB.
    throw new Error(
      `alarmContextDispatch: no pending alarm (idx=${idx}, num_pending=${context.num_pending_alarms})`,
    );
  }
  const alarm = slot.alarm;
  alarm.callback(offset, alarm.data);
}

/**
 * alarm.h lines 146-185 — `alarm_set`.
 *
 * Schedule (or reschedule) an alarm to fire at `cpu_clk`.
 *
 *  - If not currently pending (pending_idx < 0): append to
 *    pending_alarms; if the new clk is earlier than the cached head,
 *    update the cache cheaply.
 *  - If already pending: overwrite the slot's clk; if the new clk is
 *    earlier than the cached head, OR the alarm being modified IS the
 *    cached head, run the slow-path rescan to re-find the head.
 *
 * Capacity overflow (256 already pending) calls
 * alarm_log_too_many_alarms and returns without scheduling — matches
 * VICE.
 */
export function alarmSet(alarm: Alarm, cpuClk: CLOCK): void {
  const context = alarm.context;
  const idx = alarm.pending_idx;

  if (idx < 0) {
    // Not pending yet: add.
    const newIdx = context.num_pending_alarms;
    if (newIdx >= ALARM_CONTEXT_MAX_PENDING_ALARMS) {
      alarmLogTooManyAlarms();
      return;
    }

    context.pending_alarms[newIdx] = { alarm, clk: cpuClk };
    context.num_pending_alarms++;

    if (cpuClk < context.next_pending_alarm_clk) {
      context.next_pending_alarm_clk = cpuClk;
      context.next_pending_alarm_idx = newIdx;
    }

    alarm.pending_idx = newIdx;
  } else {
    // Already pending: modify.
    context.pending_alarms[idx]!.clk = cpuClk;
    if (
      context.next_pending_alarm_clk > cpuClk ||
      idx === context.next_pending_alarm_idx
    ) {
      alarmContextUpdateNextPending(context);
    }
  }
}

// ---------------------------------------------------------------------------
// alarm.c line 209-212 — `alarm_log_too_many_alarms`.
//
// VICE logs via log_error(LOG_DEFAULT, ...). We use console.warn
// (per spec 149: "use a TS console.warn"). Exported so chip code /
// tests can spy on it via mocking if needed in later steps.
// ---------------------------------------------------------------------------
export function alarmLogTooManyAlarms(): void {
  console.warn("alarm_set(): Too many alarms set!");
}
