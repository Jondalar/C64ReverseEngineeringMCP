// Spec 092 — CycleSteppable wrappers around existing chips.
//
// Pragmatic Sprint 92.1 approach: keep existing chip implementations
// (Cpu6510 instruction-based, VicII tick(N)) and wrap each in a per-
// cycle adapter. Wrapper runs one chip cycle at a time when scheduler
// ticks.
//
// Sprint 113 Phase 2 (Spec 146): the legacy CiaCycled wrapper is gone.
// CIA1/CIA2 are now alarm-driven (Cia6526Vice); a single
// AlarmContextCycled dispatches all maincpu alarms per cycle, mirroring
// the VICE CPU loop's PROCESS_ALARMS macro for the lockstep path.
//
// Cpu6510Cycled tracks "cycles owed" — when 0, fetches+executes next
// instruction (which adds N to owed). Each executeCycle() decrements
// owed by 1. Bus access happens at instruction-start (limitation),
// other cycles are "no-op pass-throughs". Drive sees CIA/VIC progress
// per cycle even if CPU bus fires only at instruction start.
//
// True per-cycle bus access (Sprint 92.7+) requires Cpu6510 rewrite
// as state machine consuming microcode. Deferred for now.

import type { CycleSteppable } from "./cycle-steppable.js";
import type { Cpu6510 } from "../cpu6510.js";
import {
  alarm_context_dispatch,
  alarm_context_next_pending_clk,
  type AlarmContext,
} from "../alarm/alarm-context.js";
import type { CLOCK } from "../util/uint.js";
import type { VicIIVice } from "../vic/vic-ii-vice.js";
import type { Sid6581 } from "../sid/sid.js";
import type { DriveCpu } from "../drive/drive-cpu.js";
import { rotation_rotate_disk } from "../drive/rotation.js";
import {
  makeDiffSniffer,
  installShifterSniffer,
  compareAfterTick,
  summarizeDivergence,
  type DiffSniffer,
} from "../drive/rotation-diff-harness.js";

const ROTATION_DIFF_ENABLED = process.env.C64RE_ROTATION_DIFF === "1";

export class Cpu6510Cycled implements CycleSteppable {
  // Cycles still owed for the current instruction. 0 = at boundary.
  private cyclesOwed = 0;
  // Optional pre-step interrupt check callback.
  public preInstructionCheck?: () => void;
  // Optional per-cycle observer (for trace).
  public onCycle?: (atBoundary: boolean) => void;

  constructor(public readonly cpu: Cpu6510) {}

  executeCycle(): void {
    if (this.cyclesOwed === 0) {
      // At instruction boundary — IRQ check, fetch + execute next.
      this.preInstructionCheck?.();
      const before = this.cpu.cycles;
      this.cpu.step();
      const consumed = this.cpu.cycles - before;
      // The cpu.step() already incremented cycles by `consumed`. We
      // still want the scheduler to tick `consumed - 1` more times for
      // this instruction, so set cyclesOwed = consumed - 1.
      this.cyclesOwed = Math.max(0, consumed - 1);
      this.onCycle?.(true);
    } else {
      this.cyclesOwed--;
      this.onCycle?.(false);
    }
  }

  cycle(): number { return this.cpu.cycles; }
  isAtInstructionBoundary(): boolean { return this.cyclesOwed === 0; }
  reset(): void { this.cyclesOwed = 0; }
}

/**
 * Sprint 113 Phase 2 (Spec 146) — AlarmContextCycled.
 *
 * Drains every alarm in the given context whose `pending_clk` has
 * been reached or passed by the current CPU clock. This is the
 * scheduler-level analogue of VICE's PROCESS_ALARMS macro
 * (6510core.c:139-143) for paths where the CPU itself doesn't
 * dispatch alarms (legacy `Cpu6510` instruction-based core).
 */
export class AlarmContextCycled implements CycleSteppable {
  private static readonly DISPATCH_GUARD = 0x1000;
  constructor(
    public readonly context: AlarmContext,
    public readonly clkPtr: () => CLOCK,
  ) {}
  executeCycle(): void {
    const clk = this.clkPtr();
    let guard = 0;
    while (clk >= alarm_context_next_pending_clk(this.context)) {
      alarm_context_dispatch(this.context, clk);
      if (++guard > AlarmContextCycled.DISPATCH_GUARD) {
        throw new Error(
          `AlarmContextCycled: dispatch guard tripped at clk=${clk} (ctx=${this.context.name})`,
        );
      }
    }
  }
}

export class VicCycled implements CycleSteppable {
  constructor(public readonly vic: VicIIVice) {}
  // VicIIVice.tick returns { stolenCycles } — we ignore stolen for now;
  // bad-line stealing handled via CPU pause logic in the wrapper later.
  executeCycle(): void { this.vic.tick(1); }
}

export class SidCycled implements CycleSteppable {
  constructor(public readonly sid: Sid6581) {}
  executeCycle(): void { this.sid.tick(1); }
}

export class DriveCpuCycled implements CycleSteppable {
  private cyclesOwed = 0;
  private diffSniffer: DiffSniffer | null = null;
  constructor(public readonly drive: DriveCpu) {}
  executeCycle(): void {
    // Spec 441 A/B verify — lazy-init shifter sniffer on first
    // executeCycle. Env-gated to keep production path fast.
    if (ROTATION_DIFF_ENABLED && !this.diffSniffer) {
      this.diffSniffer = makeDiffSniffer();
      if (this.drive.gcrShifter) {
        installShifterSniffer(
          this.diffSniffer,
          this.drive.gcrShifter,
          () => (this.drive.cpu as { cycles: number }).cycles,
        );
      }
    }
    // Spec 153 / Sprint 114: 1:1 VICE GcrShifter tick path.
    //
    // When the standalone GcrShifter is wired, tick it BEFORE running
    // the drive CPU cycle so any byte-ready edge (V-flag set) is visible
    // to the very next CPU instruction. The byte-ready callback in
    // DriveCpu directly sets V on the microcoded CPU's reg_p (matches
    // VICE drivecpu_set_overflow which does `cpu_regs.p |= P_OVERFLOW`).
    // No SO-pin pulse shaping needed.
    // Spec 441 step 4e-flip retry — VIA2 backend now does literal
    // VICE rotation_byte_read / rotation_rotate_disk + byte_ready_level
    // clear + req_ref_cycles + WPS. gcrShifter ticks ONLY for harness
    // diff comparison (C64RE_ROTATION_DIFF=1).
    if (ROTATION_DIFF_ENABLED && this.drive.gcrShifter) {
      this.drive.gcrShifter.tick(1);
    }
    {
      const { drive } = this.drive;
      // Spec 441 step 4e-flip — clear attach delays after their
      // window elapses. VICE handles this inside rotation_byte_read
      // (rotation.c:1147-1167) which is called from VIA2 PA read.
      // We do it inline per cycle so rotation_sync_found stops
      // returning 0x80 once the disk is "settled".
      //
      // Perf (Spec 441 perf): both fields are 0n in steady state.
      // Single short-circuit `!== 0n` per cycle on the fast path
      // (no clk_ptr call, no BigInt math) → measurable Lorenz speedup.
      const ac = drive.attach_clk;
      const adc = drive.attach_detach_clk;
      if (ac !== 0n || adc !== 0n) {
        const clk = drive.diskunit.clk_ptr();
        if (ac !== 0n && (clk - ac) >= 1_800_000n) drive.attach_clk = 0n;
        if (adc !== 0n && (clk - adc) >= 1_200_000n) drive.attach_detach_clk = 0n;
      }
      rotation_rotate_disk(drive);
      // A/B verify (env-gated) — compare per-cycle rotation vs
      // shifter outputs. On first divergence: throw with full
      // context so canary halts at the failure point.
      if (this.diffSniffer && this.drive.gcrShifter) {
        const diverged = compareAfterTick(
          this.diffSniffer,
          drive,
          this.drive.gcrShifter,
          () => (this.drive.cpu as { cycles: number }).cycles,
        );
        if (diverged) {
          throw new Error(
            "[rotation-diff] " + summarizeDivergence(this.diffSniffer),
          );
        }
      }
      // Spec 441 step 4e-flip — consume drive.byte_ready_edge. When
      // rotation_1541_simple latches a byte at byte boundary, fire
      // VICE drivecpu_set_overflow analog (V flag + CA1 falling
      // edge + onSoEdge trace).
      if (drive.byte_ready_edge) {
        drive.byte_ready_edge = 0;
        this.drive.fireByteReady?.();
      }
    }
    if (this.drive.microcoded) {
      // Microcoded path (Sprint 96 part 6): per-cycle bus access.
      // Refresh IRQ line every cycle (VICE maincpu_int_status pattern);
      // microcoded CPU samples it at instruction boundary.
      const cpu = this.drive.cpu as any;
      cpu.irqLine = this.drive.bus.via1.irqAsserted() || this.drive.bus.via2.irqAsserted();
      cpu.executeCycle();
      return;
    }
    if (this.cyclesOwed === 0) {
      // Legacy whole-instruction path. IRQ check before instruction.
      const cpu = this.drive.cpu as any;
      if (!cpu.interruptsDisabled()) {
        const irq = this.drive.bus.via1.irqAsserted() || this.drive.bus.via2.irqAsserted();
        if (irq) cpu.serviceInterrupt(0xfffe, false);
      }
      const before = cpu.cycles;
      cpu.step();
      const consumed = cpu.cycles - before;
      this.cyclesOwed = Math.max(0, consumed - 1);
    } else {
      this.cyclesOwed--;
    }
  }
  cycle(): number { return this.drive.cpu.cycles; }
}

// ViaCycled — DELETED in Sprint 113 Phase 2 (Spec 147 migration).
// VIA1 + VIA2 are now alarm-driven (Via1d1541 / Via2d1541). Per-cycle
// tick() is replaced by AlarmContextCycled(drivecpuAlarmContext) in
// the driveComponents list — mirrors the same pattern as the CIA
// migration (CiaCycled → AlarmContextCycled for maincpu). Kept as
// exported no-op stub for 1-2 cycles to avoid import errors in
// drive-session.ts during transition; will be removed in next sprint.

// Convenience: keyboard cycle ticker. Doesn't need separate class but
// kept for symmetry.
export interface KeyboardLike { advance(cycles: number): void; }

export class KeyboardCycled implements CycleSteppable {
  constructor(public readonly kb: KeyboardLike) {}
  executeCycle(): void { this.kb.advance(1); }
}
