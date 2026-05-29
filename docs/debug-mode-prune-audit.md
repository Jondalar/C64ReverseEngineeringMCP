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
