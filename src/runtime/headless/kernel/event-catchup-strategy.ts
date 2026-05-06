// Spec 202 — EventCatchupStrategy.
//
// Production sync per ADR §3 Decision B: VICE-style event/catch-up.
// C64 CPU advances in its clock domain; drive lags between
// cross-domain events; on each cross-domain access the kernel calls
// catchUpDrive(targetClock) which advances the drive to that clock.
//
// Spec 202-c1 ships the class as a stub that delegates to LockstepStrategy
// for run/runInstructions while exposing the new mode tag and a working
// catchUpDrive that calls drive.executeToClock. Subsequent commits in
// the spec chain replace the run-loop with a true event/catch-up loop.

import type {
  SyncStrategy,
  SyncRunResult,
} from "./sync-strategy.js";
import type { LockstepStrategy } from "./lockstep-strategy.js";
import type { DriveCpu } from "../drive/drive-cpu.js";
import type { CLOCK } from "../util/uint.js";

export interface EventCatchupStrategyDeps {
  /**
   * Lockstep delegate used while the event/catch-up run-loop is
   * being implemented. After the cross-domain bus events are
   * scheduled inside the run-loop, this delegate goes away.
   */
  delegate: LockstepStrategy;
  drive: DriveCpu;
}

export class EventCatchupStrategy implements SyncStrategy {
  readonly mode = "true-drive" as const;

  constructor(private readonly deps: EventCatchupStrategyDeps) {}

  runCycles(n: number): SyncRunResult {
    return this.deps.delegate.runCycles(n);
  }

  runInstructions(n: number): SyncRunResult {
    return this.deps.delegate.runInstructions(n);
  }

  catchUpDrive(device: number, targetClock: CLOCK): void {
    if (device !== 8) return;
    // Spec 202: kernel-internal drive catch-up. drive.executeToClock
    // is private to the kernel — only this strategy calls it.
    // audit-ok: kernel-internal sync-strategy drive catch-up
    this.deps.drive.executeToClock(targetClock);
  }
}
