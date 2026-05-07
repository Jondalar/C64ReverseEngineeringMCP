// Spec 200 — Sync strategy interface.
//
// Concrete strategies:
//   - LockstepStrategy   : Spec 200, wraps the existing
//                          CycleLockstepSchedulerImpl. Diagnostic.
//   - EventCatchupStrategy : Spec 202, becomes the production default.
//
// Strategies are kernel-internal. They are never callable from outside
// `src/runtime/headless/kernel/` — enforced by audit:no-peer-tick.

import type { CLOCK } from "../util/uint.js";

export interface SyncRunResult {
  c64CyclesAdvanced: number;
}

export interface SyncStrategy {
  readonly mode: "debug-lockstep" | "true-drive";
  runCycles(n: number): SyncRunResult;
  runInstructions(n: number): SyncRunResult;
  /**
   * Spec 202: cross-domain catch-up entry point. Kernel calls this
   * before any C64-side IEC access; strategy advances the drive
   * clock to `targetClock`. Lockstep strategy treats this as a
   * no-op (drive ticks per-cycle in lockstep). Event-catch-up
   * strategy invokes `drive.executeToClock(targetClock)`.
   */
  catchUpDrive(device: number, targetClock: CLOCK): void;
}
