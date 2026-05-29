# Debug-mode prune audit (Spec 723.7)

**Date:** 2026-05-29. Audit-only — input for the 723.7 prune. No code change in
this commit except this file.

Two jobs in 723.7:
1. Delete unused debug `SessionMode`s (D2).
2. Delete the VIC residue deferred from 723.5c — but it is reachable ONLY via
   `debug-lockstep`, so its fate is tied to the mode decision below.

## SessionMode inventory

`SessionMode = true-drive | debug-vice-compare | debug-lockstep |
debug-push-only | debug-hybrid | custom` (session-modes.ts). They differ only by
trace channels + `useCycleLockstep`:

| mode | useCycleLockstep | traceIec | traceDrive | real consumer | verdict |
|------|------------------|----------|------------|---------------|---------|
| `true-drive` | false | – | – | product default | **KEEP** |
| `custom` | (caller) | (caller) | (caller) | override escape-hatch (`resolveSessionFlags`) | **KEEP** |
| `debug-vice-compare` | false | ✓ | ✓ | oracle compare (event-catchup + trace) | **KEEP** (spec mandates) |
| `debug-lockstep` | **true** | – | – | `diagnose_mm` tool + smoke-kernel-facade | **DECISION** (see fork) |
| `debug-push-only` | false | ✓ | – | none — only the kernel-status label list + presetFlags | **DELETE (dead)** |
| `debug-hybrid` | false | ✓ | ✓ | none — label only; flags duplicate `debug-vice-compare`; the "$DD00 cycle-step" behavior has NO wiring | **DELETE (dead)** |

- `debug-push-only` + `debug-hybrid` appear only in `presetFlags`,
  `identifyMode`, and the `kernel-status.ts` doc/label union — no functional
  branch keys off them. `debug-hybrid`'s flags are byte-identical to
  `debug-vice-compare`, so `identifyMode` could never even return it. Safe
  delete.

## VIC residue deferred from 723.5c — reachable only via debug-lockstep

All of the following is gated behind `if (this.useCycleLockstep)` /
`usePerCycleBusStealing` (= the `LockstepStrategy` / `CycleLockstepSchedulerImpl`
path). None is reachable on the product event-catchup path:

- `VicIIVice.computeLineSteal()` + `stealCpuCycles` (vic-ii-vice.ts) — also
  primes badline state for the lockstep `VicCycled` wrapper, so it cannot be
  removed while lockstep's `vic.tick()` path lives.
- `usePerCycleBusStealing` (option + `VicIIVice.usePerCycleBusStealing` field +
  the integrated-session lockstep bus-stall wiring).
- `useLiteralPortVicStall` (option + field + lockstep `busStallForNextC64Cycle`).
- `src/runtime/headless/vic/bus-owner-table.ts` (+ `getBusStallForCycle`).
- `CycleLockstepSchedulerImpl`, `LockstepStrategy`, the `*Cycled` wrappers
  (`VicCycled`/`SidCycled`/`KeyboardCycled`/`AlarmContextCycled`).
- Smokes: `smoke-bus-stealing.mjs`, `smoke-vic-302-sprite-stall.mjs`,
  `smoke-vic-302-badline-stall.mjs`.

## The fork (debug-lockstep)

**Option A — keep `debug-lockstep`.** 723.7 deletes only `debug-push-only` +
`debug-hybrid`. The VIC residue stays behind lockstep indefinitely. *Breaks the
5c promise that the residue is "deleted in 723.7, not kept forever."* Smallest
change.

**Option B — kill `debug-lockstep` (recommended).** Delete
`CycleLockstepSchedulerImpl` + `LockstepStrategy` + the `*Cycled` wrappers + the
entire VIC residue above + the 3 smokes. Event-catchup becomes the ONLY
scheduler. Move the `diagnose_mm` tool to event-catchup (or retire its
lockstep-specific assertions) and drop the lockstep arm of
smoke-kernel-facade. Fulfills the 5c promise; single scheduler. Cost: loses the
cycle-exact lockstep debug oracle (the event-catchup `debug-vice-compare` oracle
remains).

**Option C — keep mode, strip per-cycle bus-stealing only.** REJECTED: the
lockstep `VicCycled` path depends on `computeLineSteal()` for badline state, so
the residue cannot be cleanly stripped while the mode lives.

## Tool-surface

- `useCycleLockstep` is not a public tool/UI input (probe checks 2/3/11). The
  only setter is the internal `diagnose_mm` tool hard-coding
  `mode: "debug-lockstep"`.
- Under Option B the `diagnose_mm` lockstep coupling must be re-pointed or the
  tool retired.

## STATUS (2026-05-29): 7a + 7b + 7c DONE

- **7a** (`639d105`) — deleted dead `debug-push-only` + `debug-hybrid`.
- **7b.1** (`f53f2cb`) — unwired cycle-lockstep from the runtime.
- **7b.2** (`5f01687`) — deleted the 6 lockstep/bus-owner files + 5 smokes;
  dropped `usePerCycleBusStealing` / `getBusStallForCycle` / `CycleSteppable`.
- **7c** — Spec 723 + this doc updated. Gates: build + probe-single-path 23/23
  + runtime:proof 7/7.
- **Deferred (dead, own cleanup):** the legacy batched `VicIIVice.tick()` +
  `computeLineSteal()` + `stealCpuCycles` remain — reachable only off the
  product per-cycle literal path. Removing them touches the VIC chip's
  raster/IRQ machinery, so it needs its own verification, not this slice.
- **Pre-existing (NOT 7b):** `smoke-kernel-facade` has 3 Spec 704 §11
  legacy-drive fails (kernel.drive removed) — RED before 7b.

## DECISION (2026-05-29): Option B — kill debug-lockstep (user-approved)

debug-lockstep + the whole lockstep scheduler + the 5c-deferred VIC residue are
deleted. Event-catchup becomes the only scheduler. diagnose_mm re-points to
event-catchup (or its lockstep assertion is retired).

### 723.7b execution surface (build-checked sub-steps; runtime:proof at end)

This is the largest-blast-radius slice of Spec 723 — it edits the central
session step-loop and the product CPU, not just a dead branch. Touchpoints:

- **integrated-session.ts** — remove: import of `CycleLockstepSchedulerImpl` +
  `cycle-wrappers` (`AlarmContextCycled`/`VicCycled`/`SidCycled`/
  `KeyboardCycled`); the `scheduler?` field; the `useCycleLockstep` opt+field;
  the entire `if (this.useCycleLockstep)` block (scheduler construction +
  bus-stall wiring); the `if (this.scheduler)` branch in `stepC64Instruction`
  (968-983 → event-catchup only); `useCycleLockstep` in the status-runtime
  object + serialize (343/377/386/456/1185/1219).
- **session-modes.ts** — drop `debug-lockstep` from `SessionMode` + `presetFlags`
  + `identifyMode`; remove `useCycleLockstep` from `SessionModeFlags` +
  `flagsEqual`; `makeModeReport` drops `lockstep`.
- **kernel-status.ts** — drop `debug-lockstep` from `KernelMode`;
  `DIAGNOSTIC_MODES` becomes empty (or remove).
- **kernel** — `headless-machine-kernel.ts` + `index.ts` + `sync-strategy.ts`:
  remove the `LockstepStrategy` arm (SyncStrategy = EventCatchupStrategy only);
  delete `lockstep-strategy.ts`.
- **cpu65xx-vice.ts** — remove `implements CycleSteppable` + the lockstep-only
  `step()` shim. KEEP `executeCycle()` + `isAtInstructionBoundary()` (product
  event-catchup path uses them directly).
- **vic-ii-vice.ts** — remove `computeLineSteal()` + `stealCpuCycles` backend
  hook + `getBusStallForCycle()` + `usePerCycleBusStealing` field; keep the
  per-cycle `vicii_cycle` literal path. Verify badline state the literal port
  needs is owned by the literal core, not computeLineSteal.
- **delete files**: `scheduler/cycle-lockstep-scheduler.ts`,
  `scheduler/cycle-wrappers.ts`, `scheduler/cycle-steppable.ts` (if no other
  implementer needs the interface), `kernel/lockstep-strategy.ts`,
  `vic/bus-owner-table.ts`, `vic/ba-aec.ts` (if lockstep-only).
- **diagnostic-mm.ts + the `diagnose_mm` tool (server-tools/headless.ts)** —
  re-point off `mode:"debug-lockstep"` to event-catchup, or retire the
  `tool-config-not-lockstep` gate + the lockstep-only assertions.
- **smokes** — delete `smoke-bus-stealing.mjs`,
  `smoke-vic-302-sprite-stall.mjs`, `smoke-vic-302-badline-stall.mjs`; drop the
  lockstep arm of `smoke-kernel-facade.mjs`.
- **probe-single-path.mjs** — checks 1a/2/3 reference `useCycleLockstep`;
  rework to assert the symbol is gone entirely (no scheduler, no flag) rather
  than "default false".

## Proposed slices (after the fork is chosen)

- **723.7a** — delete the dead modes `debug-push-only` + `debug-hybrid`
  (session-modes.ts + kernel-status.ts). Gate: build + probe.
- **723.7b** *(Option B only)* — kill `debug-lockstep`: scheduler + strategy +
  `*Cycled` wrappers + VIC residue (`computeLineSteal`/`stealCpuCycles`/
  `usePerCycleBusStealing`/`useLiteralPortVicStall`/bus-owner-table) + 3 smokes;
  re-point/retire `diagnose_mm`; drop facade-smoke lockstep arm. Gate: build +
  probe (extended: no `CycleLockstepScheduler`/`useCycleLockstep` setter) +
  relevant VIC smokes + runtime:proof once.
- **723.7c** — probe guard extension + doc.
