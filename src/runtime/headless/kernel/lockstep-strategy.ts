// Spec 200/202 — LockstepStrategy.
//
// Wraps the existing CycleLockstepSchedulerImpl behind the
// SyncStrategy interface. Diagnostic only; true-drive uses
// EventCatchupStrategy.
//
// catchUpDrive is a no-op: in lockstep the drive ticks per cycle
// alongside the c64, so there is no lag to catch up on.

import type {
  SyncStrategy,
  SyncRunResult,
} from "./sync-strategy.js";
import type { CycleLockstepSchedulerImpl } from "../scheduler/cycle-lockstep-scheduler.js";
import type { CLOCK } from "../util/uint.js";

export class LockstepStrategy implements SyncStrategy {
  readonly mode = "debug-lockstep" as const;

  constructor(
    private readonly scheduler: CycleLockstepSchedulerImpl,
    private readonly clkPtr: () => number,
  ) {}

  runCycles(n: number): SyncRunResult {
    const before = this.clkPtr();
    this.scheduler.runCycles(n);
    return { c64CyclesAdvanced: this.clkPtr() - before };
  }

  runInstructions(n: number): SyncRunResult {
    const before = this.clkPtr();
    this.scheduler.runInstructions(n);
    return { c64CyclesAdvanced: this.clkPtr() - before };
  }

  catchUpDrive(_device: number, _targetClock: CLOCK, _cycleStepped: boolean = false): void {
    // No-op: lockstep mode advances drive every C64 cycle.
  }
}
