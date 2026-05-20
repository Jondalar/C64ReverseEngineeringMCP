// Spec 202 — EventCatchupStrategy.
//
// Production sync per ADR §3 Decision B: VICE-style event/catch-up.
// C64 CPU advances in its clock domain; drive lags between
// cross-domain events; on each cross-domain access the kernel calls
// catchUpDrive(targetClock) which advances the drive to that clock.
//
// Spec 202-c4: this owns the true-drive run-loop. It advances only the
// C64 side directly; drive execution happens through catchUpDrive at
// cross-domain access points and at instruction boundaries.

import type {
  SyncStrategy,
  SyncRunResult,
} from "./sync-strategy.js";
import type { DriveCpu } from "../drive/drive-cpu.js";
import type { CLOCK } from "../util/uint.js";

export interface EventCatchupStrategyDeps {
  drive: DriveCpu;
  c64Clock: () => CLOCK;
  stepC64Instruction: () => void;
  /** Spec 612 T3.6 — when drive1541=vice, also tick vice-side drive in
   *  lockstep with legacy. Without this the vice drive only runs on
   *  $DD00 bus events (push-flush hook) and starves between events,
   *  preventing the drive 6502 from reaching the LOAD-handling code. */
  additionalCatchUp?: (targetClock: CLOCK) => void;
  /** Perf 2026-05-20 — when the vice drive is active (additionalCatchUp
   *  set), the co-resident legacy DriveCpu's `executeToClock` is pure
   *  waste: its bus contribution is overlaid away by the vice1541 bridge
   *  (gate-1b), yet it still runs the legacy drive 6502 every catch-up =
   *  ~2x drive-CPU work → headless measured 0.50x realtime. Default
   *  skips the legacy tick in vice mode. Set true (env
   *  C64RE_VICE_LEGACY_DRIVE=1) to keep ticking it for regression
   *  bisects. */
  forceLegacyDriveTick?: boolean;
}

export class EventCatchupStrategy implements SyncStrategy {
  readonly mode = "true-drive" as const;

  constructor(private readonly deps: EventCatchupStrategyDeps) {}

  /** Spec 612 T3.6 — install the vice catch-up callback after the kernel
   *  finishes constructing the Vice1541 instance (which happens after
   *  this strategy is built). */
  setAdditionalCatchUp(fn: (targetClock: CLOCK) => void): void {
    this.deps.additionalCatchUp = fn;
  }

  /** Perf 2026-05-20 — opt-in to keep ticking the co-resident legacy
   *  DriveCpu in vice mode (default false). */
  setForceLegacyDriveTick(on: boolean): void {
    this.deps.forceLegacyDriveTick = on;
  }

  runCycles(n: number): SyncRunResult {
    const before = this.deps.c64Clock();
    const target = before + Math.max(0, n);
    while (this.deps.c64Clock() < target) {
      this.deps.stepC64Instruction();
    }
    return { c64CyclesAdvanced: this.deps.c64Clock() - before };
  }

  runInstructions(n: number): SyncRunResult {
    const before = this.deps.c64Clock();
    for (let i = 0; i < Math.max(0, n); i++) {
      this.deps.stepC64Instruction();
    }
    return { c64CyclesAdvanced: this.deps.c64Clock() - before };
  }

  catchUpDrive(device: number, targetClock: CLOCK, cycleStepped: boolean = false): void {
    if (device !== 8) return;
    // Perf 2026-05-20 — in vice mode (additionalCatchUp set) the legacy
    // DriveCpu tick is pure waste (its bus output is overlaid away by the
    // vice1541 bridge). Skip it unless explicitly forced for bisects.
    const viceActive = this.deps.additionalCatchUp !== undefined;
    if (!viceActive || this.deps.forceLegacyDriveTick) {
      // Spec 202: kernel-internal drive catch-up. drive.executeToClock
      // is private to the kernel — only this strategy calls it.
      // audit-ok: kernel-internal sync-strategy drive catch-up
      this.deps.drive.executeToClock(targetClock, cycleStepped);
    }
    // Spec 612 T3.6 — vice-side per-instruction tick (the real drive in
    // vice mode).
    this.deps.additionalCatchUp?.(targetClock);
  }
}
