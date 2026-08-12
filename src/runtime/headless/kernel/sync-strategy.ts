// ════════════════════════════════════════════════════════════════════════════
//  DEPRECATED — TypeScript runtime.  THE PRODUCT RUNTIME IS TRX64.
//
//  This file is part of the in-process TS emulator. It is reachable ONLY with
//  C64RE_RUNTIME_TS=1 and is never on the default path: every runtime_* tool,
//  the workspace UI and the MCP surface route to the TRX64 daemon (Spec 771).
//
//  Do not extend it, do not fix forward in it, and do not cite it as current
//  behaviour — "how the runtime works" means TRX64, in ../TRX64.
//  Its remaining job is to be a parity oracle for the port; when that is no
//  longer needed it goes. See DOCTRINE.md.
// ════════════════════════════════════════════════════════════════════════════
// Spec 200 — Sync strategy interface.
//
// Concrete strategies:
//   - EventCatchupStrategy : Spec 202, the production default.
//     (Spec 723.7b: LockstepStrategy removed — event-catchup is the only one.)
//
// Strategies are kernel-internal. They are never callable from outside
// `src/runtime/headless/kernel/` — enforced by audit:no-peer-tick.

import type { CLOCK } from "../util/uint.js";

export interface SyncRunResult {
  c64CyclesAdvanced: number;
}

export interface SyncStrategy {
  readonly mode: "true-drive";
  runCycles(n: number): SyncRunResult;
  runInstructions(n: number): SyncRunResult;
  /**
   * Spec 202: cross-domain catch-up entry point. Kernel calls this
   * before any C64-side IEC access; strategy advances the drive
   * clock to `targetClock`. Lockstep strategy treats this as a
   * no-op (drive ticks per-cycle in lockstep). Event-catch-up
   * strategy invokes `drive.executeToClock(targetClock)`.
   */
  catchUpDrive(device: number, targetClock: CLOCK, cycleStepped?: boolean): void;
}
