// Spec 200 — Sync strategy interface.
//
// Concrete strategies:
//   - LockstepStrategy   : Spec 200, wraps the existing
//                          CycleLockstepSchedulerImpl. Production
//                          default until Spec 202 flips it.
//   - EventCatchupStrategy : Spec 202, becomes the production default.
//
// Strategies are kernel-internal. They are never callable from outside
// `src/runtime/headless/kernel/` — enforced by ESLint `no-peer-tick`.

export interface SyncRunResult {
  c64CyclesAdvanced: number;
}

export interface SyncStrategy {
  readonly mode: "debug-lockstep" | "true-drive";
  runCycles(n: number): SyncRunResult;
  runInstructions(n: number): SyncRunResult;
}
