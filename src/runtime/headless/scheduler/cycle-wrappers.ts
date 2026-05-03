// Spec 092 — CycleSteppable wrappers around existing chips.
//
// Pragmatic Sprint 92.1 approach: keep existing chip implementations
// (Cpu6510 instruction-based, Cia6526 tick(N), VicII tick(N)) and wrap
// each in a per-cycle adapter. Wrapper runs one chip cycle at a time
// when scheduler ticks.
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
import type { Cia6526 } from "../cia/cia6526.js";
import type { VicII } from "../peripherals/vic-ii.js";
import type { Sid6581 } from "../peripherals/sid.js";
import type { DriveCpu } from "../drive/drive-cpu.js";
import type { Via6522 } from "../drive/via6522.js";

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

export class CiaCycled implements CycleSteppable {
  constructor(public readonly cia: Cia6526) {}
  executeCycle(): void { this.cia.tick(1); }
}

export class VicCycled implements CycleSteppable {
  constructor(public readonly vic: VicII) {}
  // VicII.tick returns { stolenCycles } — we ignore stolen for now;
  // bad-line stealing handled via CPU pause logic in the wrapper later.
  executeCycle(): void { this.vic.tick(1); }
}

export class SidCycled implements CycleSteppable {
  constructor(public readonly sid: Sid6581) {}
  executeCycle(): void { this.sid.tick(1); }
}

export class DriveCpuCycled implements CycleSteppable {
  private cyclesOwed = 0;
  constructor(public readonly drive: DriveCpu) {}
  executeCycle(): void {
    if (this.cyclesOwed === 0) {
      // IRQ check before instruction.
      if (!this.drive.cpu.interruptsDisabled()) {
        const irq = this.drive.bus.via1.irqAsserted() || this.drive.bus.via2.irqAsserted();
        if (irq) this.drive.cpu.serviceInterrupt(0xfffe, false);
      }
      const before = this.drive.cpu.cycles;
      this.drive.cpu.step();
      const consumed = this.drive.cpu.cycles - before;
      this.cyclesOwed = Math.max(0, consumed - 1);
    } else {
      this.cyclesOwed--;
    }
  }
  cycle(): number { return this.drive.cpu.cycles; }
}

export class ViaCycled implements CycleSteppable {
  constructor(public readonly via: Via6522) {}
  executeCycle(): void { this.via.tick(1); }
}

// Convenience: keyboard cycle ticker. Doesn't need separate class but
// kept for symmetry.
export interface KeyboardLike { advance(cycles: number): void; }

export class KeyboardCycled implements CycleSteppable {
  constructor(public readonly kb: KeyboardLike) {}
  executeCycle(): void { this.kb.advance(1); }
}
