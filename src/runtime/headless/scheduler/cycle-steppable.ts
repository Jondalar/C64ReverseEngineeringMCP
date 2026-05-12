// Spec 092 — Cycle-lockstep architecture.
//
// Every component (CPU, CIA, VIC, SID, drive CPU, drive VIA1/VIA2)
// implements CycleSteppable. Main scheduler ticks all components per
// cycle in lockstep. Bit-accurate by construction (matches virtualc64
// reference).
//
// Reference: github.com/dirkwhoffmann/virtualc64

export interface CycleSteppable {
  // Advance one cycle of this component's clock. Bus accesses fire at
  // the exact cycle they happen on real hardware.
  executeCycle(): void;

  // Optional: report this component's current internal cycle counter.
  // Useful for debug + cycle-budget tests.
  cycle?(): number;
}

// Convenience for components that need an explicit reset to cycle 0
// (most do).
export interface CycleSteppableWithReset extends CycleSteppable {
  resetCycle(): void;
}
