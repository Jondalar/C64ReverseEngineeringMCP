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
  // C64 components (tick at C64 clock). Index 0 is treated as the CPU —
  // its `cycles` field is the wall-clock authority. Other components
  // are ticked by the cycle delta the CPU produced (so multi-cycle
  // operations like IRQ servicing or branch page-cross don't desync).
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
  // Sprint 93.1 / Spec 093 §6: per-cycle interrupt pin update. Called
  // BEFORE C64 components tick each cycle, so the CPU samples up-to-
  // date IRQ/NMI state at instruction boundary. Mirrors the VICE
  // maincpu_int_status pin model.
  updateInterruptLines?: () => void;
  // Sprint 96 / Bug 39: read CPU cycle counter (the wall-clock
  // authority). When set, scheduler ticks peripherals + drive by
  // (newCycles - prevCycles) per CPU step rather than by 1, so any
  // instant `this.cycles += N` inside the CPU (IRQ service, branch
  // taken + page-cross, illegal opcode burn) advances peripherals
  // and drive by the same N.
  cpuCycleCounter?: () => number;
  // Spec 138 probe variant B: tick drive BEFORE c64 each cycle.
  // Default false (= c64 first).
  tickDriveFirst?: boolean;
  // Spec 138 probe variant C: disable per-cycle drive tick. Drive
  // advances ONLY via push-flush (drive.executeToClock at IEC access).
  // Default false (= lockstep tick on).
  disableLockstepDriveTick?: boolean;
  // Spec 138: hook called once per scheduler cycle AFTER lockstep
  // ticks. Used to inform drive.executeToClock that the drive is
  // "synced to c64Cycle X" so the push-flush hook becomes a no-op
  // when drive is already current. Without this hook, push-flush
  // double-counts cycles in variants A/B (lockstep already ticked
  // drive, then flush re-ticks from lastClk=0).
  afterCycleSync?: (c64Cycle: number, driveCycle: number) => void;
  // Spec 280g: per-cycle bus-stall query. When set and returns true,
  // the C64 CPU is NOT stepped this cycle (VIC owns the bus for
  // matrix/sprite DMA). Peripherals + drive still tick — master clock
  // advances normally so drive lockstep stays consistent. Mirrors VICE
  // BA-low CPU stalling. When undefined or returns false, CPU steps as
  // normal.
  busStallForNextC64Cycle?: () => boolean;
  // Spec 280g: optional hook to advance the c64Cpu.cycles counter when
  // the CPU is stalled by VIC. Required so peripherals downstream of
  // the cpu cycle counter (cpuCycleCounter) keep ticking. If not
  // provided, master clock still advances via cycleCount but the CPU
  // counter stays put.
  advanceC64CpuCycleOnStall?: () => void;
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
    // VICE pattern: refresh IRQ/NMI pin state each cycle BEFORE the CPU
    // ticks. CPU samples line at instruction-boundary fetch.
    if (this.deps.updateInterruptLines) this.deps.updateInterruptLines();

    const driveFirst = this.deps.tickDriveFirst ?? false;        // probe B
    const skipDriveTick = this.deps.disableLockstepDriveTick ?? false; // probe C

    // Spec 138 probe B: tick drive ahead of c64 cycle.
    if (driveFirst && !skipDriveTick) {
      this.driveCycleAccumulator16dot16 += this.driveRatio16dot16;
      while (this.driveCycleAccumulator16dot16 >= 0x10000) {
        for (const c of this.deps.driveComponents) c.executeCycle();
        this.driveCycleCount++;
        this.driveCycleAccumulator16dot16 -= 0x10000;
      }
    }

    // Sprint 96: track cpu cycle delta so peripherals/drive stay in
    // sync when CPU bursts cycles for IRQ service, branch+pgcross, or
    // illegal-opcode burn.
    const cpuBefore = this.deps.cpuCycleCounter ? this.deps.cpuCycleCounter() : this.cycleCount;
    // Spec 280g: per-cycle VIC bus stealing. If VIC owns the bus this
    // cycle, the CPU does NOT step. Master clock still advances (via
    // cycleCount + drive tick + alarm context) so drive lockstep is
    // unaffected. Mirrors VICE BA-low stalling.
    const stalled = this.deps.busStallForNextC64Cycle?.() ?? false;
    if (!stalled) {
      // Tick the CPU first.
      this.deps.c64Components[0]!.executeCycle();
    } else if (this.deps.advanceC64CpuCycleOnStall) {
      // Even though CPU did not step, bump its cycle counter so the
      // cpuCycleCounter delta + downstream wall-clock peripherals
      // (CIA timers, SID) keep ticking at the right rate.
      this.deps.advanceC64CpuCycleOnStall();
    }
    const cpuAfter = this.deps.cpuCycleCounter ? this.deps.cpuCycleCounter() : (cpuBefore + 1);
    const delta = Math.max(1, cpuAfter - cpuBefore);
    // Tick remaining C64 chips by `delta` so peripherals advance with
    // the CPU's actual cycle consumption.
    for (let k = 0; k < delta; k++) {
      for (let i = 1; i < this.deps.c64Components.length; i++) {
        this.deps.c64Components[i]!.executeCycle();
      }
      this.cycleCount++;
      // Variant default: tick drive AFTER c64 each cycle.
      if (!driveFirst && !skipDriveTick) {
        this.driveCycleAccumulator16dot16 += this.driveRatio16dot16;
        while (this.driveCycleAccumulator16dot16 >= 0x10000) {
          for (const c of this.deps.driveComponents) c.executeCycle();
          this.driveCycleCount++;
          this.driveCycleAccumulator16dot16 -= 0x10000;
        }
      } else if (skipDriveTick) {
        // Probe C: still advance the drive cycle counter for clock
        // accounting (so cycle_drive in trace events keeps incrementing),
        // but DO NOT tick driveComponents. Drive only advances when
        // explicitly flushed via drive.executeToClock from IEC hook.
        this.driveCycleAccumulator16dot16 += this.driveRatio16dot16;
        while (this.driveCycleAccumulator16dot16 >= 0x10000) {
          this.driveCycleCount++;
          this.driveCycleAccumulator16dot16 -= 0x10000;
        }
      }
      // Spec 138: notify integrated-session per-cycle so it can sync
      // drive.lastClk in lockstep-with-flush variants.
      this.deps.afterCycleSync?.(this.cycleCount, this.driveCycleCount);
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
