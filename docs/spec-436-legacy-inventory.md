# Spec 436 — Legacy wrapper inventory

Date: 2026-05-13  
Commit: `4ac150d` (post Specs 432–435).

This document records the status of every legacy IEC/VIA/drive
helper named in Spec 430 §4 and the Spec 436 grep targets.

## Helpers from Spec 430 §4

| Helper | Status | Notes |
|---|---|---|
| `IecBusCore.drive_read_pb` | deleted (Spec 432) | Production uses `via1d1541.readPb`. |
| Synthetic IEC release hooks at attach | deleted (Spec 432) | `IecBus.attachDriveVia1` no longer emits CA1 seed. |
| `Via1d1541.signalAtnEdge(boolean)` | **production** | VICE edge-tag form. |
| `Via1d1541.pulseCa1(level)` | **test-only** | `@deprecated`; called only from `scripts/sprint61-smoke.mjs` + `scripts/smoke-419-atn-edge.mjs`. |
| `Via1d1541.reevaluateCa1Level` | deleted (Spec 433) | No callers. |
| `Via1d1541._lastCa1` | test-only | Used only by `pulseCa1`. |
| `Via1d1541.onCa1IerEnabled` | deleted (Spec 433) | Property removed. |
| `IecBus._performC64Write` level-based path | deleted (Spec 432) | Edge-tag only. |
| `IecBus._performC64Read` level-based path | n/a | Always was edge-state read; no level path existed. |
| `IecBusCore` cycleStepped hint | passthrough only | Always `false` post-Spec-435; field threading remains in `IecBus`/`KernelBus`/`HeadlessMachineKernel`/`EventCatchupStrategy` until parameter-purge follow-up. |
| `HeadlessKernelBus.computeCycleStepped` | deleted (Spec 435) | pc < 0xa000 heuristic gone. |
| `vice-whole-instruction` dispatch fallback | KEPT (Spec 428) | Default per Spec 428 Phase D; Spec 435 amendment defers purge. |

## Spec 436 §1 grep target results

| Token | src/ matches | Action |
|---|---|---|
| `LikeVice` / `likeVice` | 3 files (`disk/g64-parser.ts`, `disk/gcr.ts`, `server-tools/disk-g64.ts`) | **Deferred to Spec 437 (Phase G)** — GCR literal port renames + reshapes these helpers. |
| `pulseCa1` | 1 method def (`via1d1541.ts:350`) | test-only, `@deprecated`. ✅ |
| `reevaluateCa1Level` | 1 file-header reference | comment only. ✅ |
| `_lastCa1` | 3 lines in `via1d1541.ts` (inside `pulseCa1`) | test-only. ✅ |
| `cycleStepped` / `_cycleStepped` | parameter threading across iec-bus, kernel-machine-kernel, sync-strategy, event-catchup-strategy, lockstep-strategy | always-false plumbing; **parameter-purge deferred** to a post-port cleanup spec. Behaviour is inert. |
| `whole-instruction` / `WHOLE_INSTRUCTION` | drive-cpu.ts (Spec 428 dispatch) | KEPT per Spec 428. |
| `hybrid sync` / `HYBRID_SYNC` | 1 probe label (`kernel-status.ts:20`) + 0 in iec-bus.ts (Spec 435 cleaned) | probe-only. ✅ |
| `legacy fallback` | 1 comment (`iec-bus.ts:399 buildDrivePbInputBits`) | helper kept for trace/snapshot inspection, not production. ✅ |
| `vice-inspired` | 0 | ✅ |

## Production path verification

See `docs/spec-436-production-path.md` for the file:line-cited
single production trace.

## Open follow-ups

1. **cycleStepped parameter purge** — remove the dead `cycleStepped`
   arg from `IecBus.setC64Output`, `IecBus.buildC64InputBits`,
   `IecBus.pushFlush.{one,all}`, `KernelBus`, `HeadlessMachineKernel.catchUpDrive`,
   `SyncStrategy.catchUpDrive`, `EventCatchupStrategy.catchUpDrive`,
   `LockstepStrategy.catchUpDrive`, `DriveCpu.executeToClock`. The
   parameter is always `false` after Spec 435; the threading remains
   only because it touches many files.

2. **GCR LikeVice rename** — owned by Spec 437 (Phase G).

3. **Dispatch-mode unification** — `driveDispatchMode` ("cycle-stepped"
   vs "vice-whole-instruction") was made default whole-instruction by
   Spec 428 Phase D. Once IM2 + motm timing is fully aligned (Phases
   E+G), Spec 435's strict-port mandate to drop the fallback should be
   revisited.
