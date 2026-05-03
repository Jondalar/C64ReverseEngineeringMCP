// Spec 089 — VICE-style alarm-context scheduler.
//
// Each peripheral registers an Alarm. An Alarm is a callback to fire
// at a specific clock cycle. The AlarmContext maintains a list of
// pending alarms + the next-pending-clk for fast O(1) check.
//
// Main loop after each instruction (or after each cycle when Spec 091
// lands):
//   while (ctx.hasPending(currentClk)) ctx.dispatch(currentClk);
//
// Source: vice/src/alarm.h, vice/src/alarm.c.

export type AlarmCallback = (offsetCycles: number) => void;

const NOT_PENDING = -1;
const NEVER = Number.MAX_SAFE_INTEGER;

export class Alarm {
  // Index in context.pending[] when pending, else -1.
  public pendingIdx = NOT_PENDING;
  // The clk at which this alarm should fire (when pending). Stored
  // separately so VSF can serialise it without dereferencing pending[].
  public pendingClk = -1;

  constructor(
    public readonly name: string,
    public readonly callback: AlarmCallback,
    public readonly ctx: AlarmContext,
  ) {
    ctx.registerAlarm(this);
  }

  // Schedule this alarm to fire at the given clock cycle.
  set(clk: number): void {
    this.ctx.set(this, clk);
  }

  unset(): void {
    this.ctx.unset(this);
  }

  isPending(): boolean {
    return this.pendingIdx !== NOT_PENDING;
  }
}

interface PendingEntry {
  alarm: Alarm;
  clk: number;
}

export class AlarmContext {
  private readonly allAlarms: Alarm[] = [];
  private readonly pending: PendingEntry[] = [];
  // Cached min-clk + index for fast hasPending() check.
  public nextPendingClk = NEVER;
  private nextPendingIdx = -1;

  constructor(public readonly name: string) {}

  // Internal — called from Alarm constructor.
  registerAlarm(alarm: Alarm): void {
    this.allAlarms.push(alarm);
  }

  // True iff any alarm should fire at or before currentClk.
  hasPending(currentClk: number): boolean {
    return currentClk >= this.nextPendingClk;
  }

  // Dispatch the next pending alarm (must be called only when
  // hasPending() returns true). Removes the alarm from pending list,
  // recomputes next-pending-clk, fires callback. Callback may
  // re-arm the alarm (e.g. continuous timer).
  dispatch(currentClk: number): void {
    if (this.nextPendingIdx < 0) return;
    const offset = currentClk - this.nextPendingClk;
    const entry = this.pending[this.nextPendingIdx]!;
    const alarm = entry.alarm;
    // Remove this entry from pending[].
    this.pending.splice(this.nextPendingIdx, 1);
    alarm.pendingIdx = NOT_PENDING;
    alarm.pendingClk = -1;
    // Re-index remaining alarms (their pendingIdx may have shifted).
    for (let i = this.nextPendingIdx; i < this.pending.length; i++) {
      this.pending[i]!.alarm.pendingIdx = i;
    }
    this.recomputeNextPending();
    alarm.callback(offset);
  }

  // Schedule alarm to fire at clk. If already pending, reschedules.
  set(alarm: Alarm, clk: number): void {
    if (alarm.pendingIdx === NOT_PENDING) {
      const idx = this.pending.length;
      this.pending.push({ alarm, clk });
      alarm.pendingIdx = idx;
      alarm.pendingClk = clk;
      if (clk < this.nextPendingClk) {
        this.nextPendingClk = clk;
        this.nextPendingIdx = idx;
      }
    } else {
      const entry = this.pending[alarm.pendingIdx]!;
      entry.clk = clk;
      alarm.pendingClk = clk;
      // If we changed the current next-min, or rescheduled the
      // current next-min entry, recompute.
      if (clk < this.nextPendingClk || alarm.pendingIdx === this.nextPendingIdx) {
        this.recomputeNextPending();
      }
    }
  }

  // Unschedule alarm. No-op if not pending.
  unset(alarm: Alarm): void {
    if (alarm.pendingIdx === NOT_PENDING) return;
    const idx = alarm.pendingIdx;
    this.pending.splice(idx, 1);
    alarm.pendingIdx = NOT_PENDING;
    alarm.pendingClk = -1;
    for (let i = idx; i < this.pending.length; i++) {
      this.pending[i]!.alarm.pendingIdx = i;
    }
    this.recomputeNextPending();
  }

  private recomputeNextPending(): void {
    let minClk = NEVER;
    let minIdx = -1;
    for (let i = 0; i < this.pending.length; i++) {
      const c = this.pending[i]!.clk;
      if (c < minClk) {
        minClk = c;
        minIdx = i;
      }
    }
    this.nextPendingClk = minClk;
    this.nextPendingIdx = minIdx;
  }

  // Time-warp: shift all pending alarms by delta cycles. Used when
  // the clock counter wraps to keep numbers small (VICE pattern).
  timeWarp(delta: number): void {
    for (const entry of this.pending) {
      entry.clk += delta;
      entry.alarm.pendingClk = entry.clk;
    }
    if (this.nextPendingClk !== NEVER) this.nextPendingClk += delta;
  }

  // Snapshot for VSF persistence.
  snapshot(): AlarmContextSnapshot {
    return {
      name: this.name,
      pending: this.pending.map((e) => ({ name: e.alarm.name, clk: e.clk })),
    };
  }

  // Restore from VSF — re-arms alarms by name. Alarms must already
  // be registered (constructed via `new Alarm(name, cb, ctx)`).
  restore(snap: AlarmContextSnapshot): void {
    // Clear current pending state.
    for (const entry of this.pending) {
      entry.alarm.pendingIdx = NOT_PENDING;
      entry.alarm.pendingClk = -1;
    }
    this.pending.length = 0;
    this.nextPendingClk = NEVER;
    this.nextPendingIdx = -1;
    // Re-arm each saved alarm by name.
    for (const sp of snap.pending) {
      const alarm = this.allAlarms.find((a) => a.name === sp.name);
      if (!alarm) {
        throw new Error(`AlarmContext.restore: alarm "${sp.name}" not registered in ctx "${this.name}"`);
      }
      this.set(alarm, sp.clk);
    }
  }

  // Diagnostic.
  pendingNames(): string[] {
    return this.pending.map((e) => `${e.alarm.name}@${e.clk}`);
  }
}

export interface AlarmContextSnapshot {
  name: string;
  pending: { name: string; clk: number }[];
}
