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
}

export class EventCatchupStrategy implements SyncStrategy {
  readonly mode = "true-drive" as const;

  constructor(private readonly deps: EventCatchupStrategyDeps) {}

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
    // Spec 202: kernel-internal drive catch-up. drive.executeToClock
    // is private to the kernel — only this strategy calls it.
    // audit-ok: kernel-internal sync-strategy drive catch-up
    this.deps.drive.executeToClock(targetClock, cycleStepped);
  }
}
