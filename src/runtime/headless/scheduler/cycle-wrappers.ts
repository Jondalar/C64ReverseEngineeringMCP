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
// Spec 723.4a: Cpu6510Cycled (the legacy-CPU lockstep wrapper) removed — the
// product CPU is the microcoded Cpu65xxVice, which steps itself per cycle.

import type { CycleSteppable } from "./cycle-steppable.js";
import {
  alarmContextDispatch,
  alarmContextNextPendingClk,
  type AlarmContext,
} from "../alarm/alarm-context.js";
import type { CLOCK } from "../util/uint.js";
import type { VicIIVice } from "../vic/vic-ii-vice.js";
import type { Sid6581 } from "../sid/sid.js";
// Spec 704 §11 R3 — DriveCpu import removed (DriveCpuCycled deleted).

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
    while (clk >= alarmContextNextPendingClk(this.context)) {
      alarmContextDispatch(this.context, clk);
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

// Spec 704 §11 R3 — DriveCpuCycled DELETED. The legacy DriveCpu is gone;
// the vice drive advances via EventCatchupStrategy → drive1541.catchUpTo,
// not as a scheduler cycle-component.

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
