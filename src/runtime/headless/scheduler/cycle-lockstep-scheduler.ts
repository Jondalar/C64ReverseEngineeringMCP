// Spec 092 — Cycle-lockstep main scheduler.
//
// Ticks all components per cycle in lockstep. C64 components run at
// the C64 clock (985.248kHz PAL). Drive components run at 1MHz
// (slightly faster, ratio 1.0149) — handled via fixed-point.
//
// Reference: virtualc64 (Hoffmann, MIT). Each chip = executeCycle()
// method, scheduler ticks all per cycle. Bit-accurate.

import type { CycleSteppable } from "./cycle-steppable.js";

const DRIVE_RATIO_PAL_16dot16 = Math.round(1.014773 * 0x10000); // 1MHz / 985.248kHz
const DRIVE_RATIO_NTSC_16dot16 = Math.round(1.0 * 0x10000);     // 1MHz / 1.022727MHz ≈ 0.978

export interface CycleLockstepScheduler {
  // Run for N C64 cycles (precise wall-clock).
  runCycles(n: number): void;
  // Run for N completed C64 instructions.
  runInstructions(n: number, opts?: { breakpoints?: Set<number>; cycleBudget?: number }): { instructionsExecuted: number; lastPc: number; aborted?: 'breakpoint' | 'cycle-budget' };
  // Single-cycle step.
  executeCycle(): void;
  // Current C64 cycle count.
  c64Cycle(): number;
  // Drive cycle count.
  driveCycle(): number;
}

export interface CycleLockstepDeps {
  // C64 components (tick at C64 clock).
  c64Components: CycleSteppable[];
  // Drive components (tick at drive clock — ratio 1.0149× C64 PAL).
  driveComponents: CycleSteppable[];
  // True iff C64 CPU is currently at instruction boundary (just
  // finished or just started — used for runInstructions counting).
  c64IsAtInstructionBoundary: () => boolean;
  // Current C64 PC (for breakpoints).
  c64Pc: () => number;
  // PAL or NTSC.
  isPal: boolean;
}

export class CycleLockstepSchedulerImpl implements CycleLockstepScheduler {
  private cycleCount = 0;
  private driveCycleCount = 0;
  private driveCycleAccumulator16dot16 = 0;
  private readonly driveRatio16dot16: number;

  constructor(private readonly deps: CycleLockstepDeps) {
    this.driveRatio16dot16 = deps.isPal ? DRIVE_RATIO_PAL_16dot16 : DRIVE_RATIO_NTSC_16dot16;
  }

  executeCycle(): void {
    // Tick all C64 chips by 1 cycle.
    for (const c of this.deps.c64Components) c.executeCycle();
    this.cycleCount++;
    // Tick drive chips by their share. Most C64 cycles tick drive 1×;
    // some tick drive 2× (because drive runs slightly faster).
    this.driveCycleAccumulator16dot16 += this.driveRatio16dot16;
    while (this.driveCycleAccumulator16dot16 >= 0x10000) {
      for (const c of this.deps.driveComponents) c.executeCycle();
      this.driveCycleCount++;
      this.driveCycleAccumulator16dot16 -= 0x10000;
    }
  }

  runCycles(n: number): void {
    for (let i = 0; i < n; i++) this.executeCycle();
  }

  runInstructions(maxN: number, opts?: { breakpoints?: Set<number>; cycleBudget?: number }): { instructionsExecuted: number; lastPc: number; aborted?: 'breakpoint' | 'cycle-budget' } {
    const breakpoints = opts?.breakpoints;
    const cycleBudget = opts?.cycleBudget ?? Infinity;
    const startCycles = this.cycleCount;
    let executed = 0;
    while (executed < maxN) {
      if (breakpoints && breakpoints.has(this.deps.c64Pc())) {
        return { instructionsExecuted: executed, lastPc: this.deps.c64Pc(), aborted: 'breakpoint' };
      }
      if (this.cycleCount - startCycles >= cycleBudget) {
        return { instructionsExecuted: executed, lastPc: this.deps.c64Pc(), aborted: 'cycle-budget' };
      }
      // Run one C64 instruction = run cycles until boundary again.
      const wasAtBoundary = this.deps.c64IsAtInstructionBoundary();
      do {
        this.executeCycle();
      } while (!this.deps.c64IsAtInstructionBoundary());
      // If we started AT a boundary, the do-while ran at least 1 cycle.
      // Increment instruction count regardless.
      executed++;
      void wasAtBoundary;
    }
    return { instructionsExecuted: executed, lastPc: this.deps.c64Pc() };
  }

  c64Cycle(): number { return this.cycleCount; }
  driveCycle(): number { return this.driveCycleCount; }

  reset(): void {
    this.cycleCount = 0;
    this.driveCycleCount = 0;
    this.driveCycleAccumulator16dot16 = 0;
  }
}
