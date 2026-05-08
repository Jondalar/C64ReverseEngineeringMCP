// Spec 133 (M8.1) v1 — run-budget unit + helpers.
//
// Budget kinds: cycles | instructions | frames | wallSeconds.
// Returns { exitReason, ...elapsed } so callers can detect partial
// completion vs hit-condition.

export type BudgetUnit = "cycles" | "instructions" | "frames" | "wallSeconds";

export interface RunBudget {
  unit: BudgetUnit;
  amount: number;
}

export interface BudgetTracker {
  budget: RunBudget;
  startedAtCycles: number;
  startedAtInstructions: number;
  startedAtWallMs: number;
  cyclesPerFrame: number;
}

export function makeBudgetTracker(budget: RunBudget, startCycles: number, startInstructions: number, cyclesPerFrame = 19656): BudgetTracker {
  return {
    budget,
    startedAtCycles: startCycles,
    startedAtInstructions: startInstructions,
    startedAtWallMs: Date.now(), // audit-ok: wall-clock budget tracker; does not affect emulator state
    cyclesPerFrame,
  };
}

export interface BudgetCheck {
  exhausted: boolean;
  elapsed: number;     // in budget units
  remaining: number;   // negative when exhausted
}

export function checkBudget(t: BudgetTracker, currentCycles: number, currentInstructions: number): BudgetCheck {
  let elapsed = 0;
  switch (t.budget.unit) {
    case "cycles":       elapsed = currentCycles - t.startedAtCycles; break;
    case "instructions": elapsed = currentInstructions - t.startedAtInstructions; break;
    case "frames":       elapsed = (currentCycles - t.startedAtCycles) / t.cyclesPerFrame; break;
    case "wallSeconds":  elapsed = (Date.now() - t.startedAtWallMs) / 1000; break; // audit-ok: wall-clock budget check; does not affect emulator state
  }
  return {
    exhausted: elapsed >= t.budget.amount,
    elapsed,
    remaining: t.budget.amount - elapsed,
  };
}
