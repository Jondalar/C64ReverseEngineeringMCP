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
import type { CLOCK } from "../util/uint.js";

export interface EventCatchupStrategyDeps {
  c64Clock: () => CLOCK;
  stepC64Instruction: () => void;
  /** Spec 612 T3.6 — advance the vice-side drive in lockstep so the drive
   *  6502 runs between $DD00 bus events (otherwise it only runs on the
   *  push-flush hook and starves, never reaching the LOAD-handling code).
   *  Wired by the kernel after the Vice1541 instance is constructed
   *  (setAdditionalCatchUp). Spec 704 §11 R3: this is now the ONLY drive
   *  catch-up path — the legacy DriveCpu.executeToClock tick is gone. */
  additionalCatchUp?: (targetClock: CLOCK) => void;
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

  catchUpDrive(device: number, targetClock: CLOCK, _cycleStepped: boolean = false): void {
    if (device !== 8) return;
    // Spec 704 §11 R3 — vice-only: advance the vice drive to targetClock.
    this.deps.additionalCatchUp?.(targetClock);
  }
}
