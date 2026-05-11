# Spec 200 — MachineKernel facade and status

**Sprint:** 115
**Status:** DONE 2026-05-08 — `npm run smoke:kernel-facade` 18/18 PASS. All required files present: machine-kernel.ts, headless-machine-kernel.ts, kernel-bus.ts, clock-domains.ts, kernel-trace.ts, kernel-status.ts, sync-strategy.ts, lockstep-strategy.ts, event-catchup-strategy.ts. CIA2/VIA1 routing + IRQ events + trace controller + catchUpDrive all wired. Downstream specs 201-205 + 213 + 218 closed on top.
**ADR:** `docs/adr-headless-machine-kernel.md` (Decision A, §8 Step 1)
**Depends on:** none
**Blocks:** 201, 202, 203, 204, 205, 206, 207, 215, 216

## Goal

Establish the kernel facade and the per-session monolithic emulator
ownership contract. No production sync change. Lockstep stays as the
active sync strategy until Spec 202 flips the default to event/catch-up.

This spec is **structural ground-truthing**: builds the cage so 201-204
can fix timing bugs without finding new structural surprises. It does
not fix any timing bug itself.

## Refinement Locks (2026-05-06)

| #  | Decision                                                                 |
|----|--------------------------------------------------------------------------|
| Q1 | `interface MachineKernel` (internal contract) + `class HeadlessMachineKernel`. One instance per `IntegratedSession`. Monolithic — owns CPU, all chips, drive, IEC, GCR, alarms, clocks, trace. No process-global singleton. |
| Q2 | State ownership moves to kernel (chips constructed inside kernel). Session calls `kernel.runCycles(n)`; existing scheduler stays as the sync strategy. `session.cpu.step()` and direct peer-tick callsites are removed in this spec. |
| Q3 | Constructor option `{ video: 'PAL' \| 'NTSC' }`, default `'PAL'`. VICE constants in `clock-domains.ts`: `C64_PHI2_PAL_HZ = 985_248`, `C64_PHI2_NTSC_HZ = 1_022_727`, `DRIVE_1541_HZ = 1_000_000`. |
| Q4 | `kernel.status().mode` returns `'debug-lockstep'` from day 1. Schema starts as union `'debug-lockstep' \| 'true-drive'`; Spec 207 widens to all eight ADR modes. |
| Q5 | `IntegratedSession` constructor builds the kernel internally. Public lifecycle: `new IntegratedSession()` → client connects via session API → `session.stop()` shuts kernel down. No external code creates a kernel directly. |
| Q6 | New smoke test `kernel-facade.smoke.test.ts`. Existing smokes (`LOAD"$",8`, `LOAD"MM",8,1`, C64 cold-boot, drive cold-boot) stay green. Forbidden direct-tick patterns enforced via ESLint custom rule `no-peer-tick`. |
| Q7 | `kernel.trace()` returns a stub `KernelTraceController` with no-op `subscribe()` and empty `read()`. Full schema + producers land in Spec 205. |
| Q8 | `kernel.driveClock(device: number)` with `Map<number, number>` internal store. Slots created lazily via `mountMedia()`. Throws on unmounted device. |
| Q9 | Strategy pattern: `interface SyncStrategy { runCycles(n): RunResult }`. `LockstepStrategy` is default and wraps the existing scheduler. `EventCatchupStrategy` arrives in Spec 202. Strategy methods are kernel-internal — never callable from outside the kernel module. |

## Files

Add:

- `src/runtime/headless/kernel/machine-kernel.ts` — `interface MachineKernel`.
- `src/runtime/headless/kernel/headless-machine-kernel.ts` — `class HeadlessMachineKernel`.
- `src/runtime/headless/kernel/kernel-bus.ts` — `KernelBus` + `BusAccessContext` shapes (consumers wire up in Spec 201).
- `src/runtime/headless/kernel/clock-domains.ts` — PAL/NTSC ratios, drive clock, fractional accumulator.
- `src/runtime/headless/kernel/kernel-trace.ts` — stub `KernelTraceController` (filled by Spec 205).
- `src/runtime/headless/kernel/kernel-status.ts` — `KernelStatus` shape and builder.
- `src/runtime/headless/kernel/sync-strategy.ts` — `interface SyncStrategy` + `LockstepStrategy` wrapper around the existing cycle-lockstep scheduler.
- `eslint-rules/no-peer-tick.js` — custom rule.
- `tests/runtime/headless/kernel/kernel-facade.smoke.test.ts` — facade smokes.

Modify:

- `src/runtime/headless/integrated-session.ts` — constructor now builds `HeadlessMachineKernel`; chip wiring moves into kernel; session-level `cpu`/`cia*`/`via*`/`vic`/`sid`/`drive` fields removed or made kernel-internal; public methods delegate to `kernel.runCycles(n)` etc.
- `.eslintrc*` — register `eslint-rules/` plugin path and enable `no-peer-tick` rule.
- Existing chip-construction call sites that lived in `integrated-session.ts` — relocate verbatim into the kernel constructor.

## MachineKernel interface (Spec 200 surface)

```ts
export interface MachineKernel {
  c64Clock(): number;
  driveClock(device: number): number;
  runCycles(n: number): RunResult;
  snapshot(): MachineSnapshot;
  restore(snap: MachineSnapshot): void;
  mountMedia(slot: MediaSlot, media: MountedMedia): void;
  trace(): KernelTraceController;
  status(): KernelStatus;
}

export type KernelMode = 'debug-lockstep' | 'true-drive';
// Spec 207 widens to: 'fast-trap' | 'real-kernal' | 'true-drive' |
//                     'debug-vice-compare' | 'debug-lockstep' |
//                     'debug-push-only' | 'debug-hybrid'

export interface KernelStatus {
  mode: KernelMode;
  c64Clock: number;
  driveClocks: Record<number, number>;
  hooks: string[];        // always [] until Spec 204 puts hook reporting in
  mediaSlots: MediaSlotStatus[];
  video: 'PAL' | 'NTSC';
}
```

`runUntil`, `stepInstruction`, `stepFrame`, `queueInput` from the ADR §3
shape are deferred to Spec 206 (V2/V3 client API). Spec 200 covers only
what the existing session API needs.

## ESLint rule `no-peer-tick`

Forbidden: any call to `step | tick | executeToClock | runCycles` on
properties accessed from a `Session` / `IntegratedSession` reference,
e.g. `session.cpu.step()`, `session.drive.executeToClock(...)`,
`session.cia1.tick(...)`.

Allow-listed:

- Files under `src/runtime/headless/kernel/**` (kernel internals).
- Lines with `// eslint-disable-next-line no-peer-tick — <reason>` (reason text required, enforced by rule).

CI fails on any violation outside the allow list.

## Acceptance

- Build green.
- All listed existing smokes green.
- `kernel-facade.smoke.test.ts` green:
  - `kernel.status()` returns valid `KernelStatus` with `mode === 'debug-lockstep'`, `hooks === []`, `video === 'PAL'` by default.
  - `kernel.c64Clock()` advances after `kernel.runCycles(N)`.
  - `kernel.driveClock(8)` advances when drive media is mounted; throws for `device=10` if unmounted.
  - `kernel.snapshot()` round-trips via `kernel.restore()` (state-equal byte check on a fixed boot run).
- `eslint-rules/no-peer-tick.js` registered; CI fails if any production file outside `kernel/**` calls peer-tick patterns.
- Audit search proves zero direct chip access on `session.*` outside kernel internals.

## Out of scope

- IEC behind kernel bus → 201.
- Drive catch-up ownership change → 202 (also flips default sync mode).
- Alarm dispatch ownership → 203.
- Hook removal → 204.
- Trace event production → 205.
- Public V2/V3 API surface → 206.
- Mode catalogue + test profiles → 207.

## Notes

ADR §10 acceptance criteria 1 (one owner of time) is structurally
staged here; full enforcement lands across 201-204. Criterion 2 (Session
cannot tick chips directly) is fully achieved in this spec via the
ESLint rule plus the chip-relocation refactor.
