# Spec 202 — Drive catch-up private to kernel

**Sprint:** 117
**Status:** DONE 2026-05-06 — c1-c5 complete
**ADR:** Decision A, Decision D, §8 Step 3
**Depends on:** 201
**Blocks:** 203, 212, 213

## Commit chain

- **c1 ✓ 2026-05-06** — `SyncStrategy` interface gains
  `catchUpDrive(device, targetClock)`. `LockstepStrategy` (no-op)
  and `EventCatchupStrategy` (calls `drive.executeToClock`) ship as
  classes. `kernel.catchUpDrive` is the public-on-kernel entry point.
- **c2 ✓ 2026-05-06** — All five `drive.executeToClock` callsites in
  IntegratedSession replaced with `kernel.catchUpDrive(8, ...)`,
  then the legacy `IecBus.beforeC64Read` hook was removed from the
  production path. `$DD00` read/write now performs catch-up at the
  `KernelBus` boundary. ADR §10 criterion 4 structurally satisfied:
  every external drive-clock advance goes through the kernel.
- **c3 ✓ 2026-05-06** — `true-drive` and `debug-vice-compare`
  presets now run microcoded CPU with `useCycleLockstep=false`.
  Microcoded C64 stepping was decoupled from the lockstep scheduler
  and runs through an event/catch-up instruction loop; `$DD00`
  accesses still push-flush the drive through the kernel-owned
  catch-up path. Production smokes now report `mode: 'true-drive'`
  and `useCycleLockstep=false`.
- **c4 ✓ 2026-05-06** — `EventCatchupStrategy` owns the true-drive
  `runCycles` / `runInstructions` loop. `HeadlessMachineKernel`
  routes through `SyncStrategy`: `EventCatchupStrategy` for
  true-drive, `LockstepStrategy` only when a diagnostic lockstep
  scheduler is explicitly present.
- **c5 ✓ 2026-05-06** — `audit:no-peer-tick` now fails on any
  production `.executeToClock(...)` invocation outside kernel strategy
  code and `DriveCpu` internals. This enforces the public contract even
  though TypeScript visibility remains public for the kernel strategy.

## Goal

`DriveCpu.executeToClock` becomes private to kernel. Drive cannot be
ticked from session, bus classes, or chip backends. Only the kernel's
catch-up entry point advances the drive.

This spec also **flips the production sync default** from
`debug-lockstep` (Spec 200 default) to `true-drive` (event/catch-up).
`LockstepStrategy` stays in the codebase as an opt-in diagnostic
strategy per ADR §3 Decision C and ADR §7.

## Scope

- `DriveCpu.executeToClock` visibility lowered (TS `internal` /
  module-private). **Enforced by audit in c5; TS visibility remains
  public for strategy access.**
- Kernel adds `kernel.catchUpDrive(targetClock, device)` used by
  cross-domain access points. **Done.**
- Search audit: zero production callers of `executeToClock` outside
  kernel. **Done.**
- New `EventCatchupStrategy implements SyncStrategy`, becomes default.
  **Done.**
- `LockstepStrategy` (from Spec 200) stays selectable as
  `debug-lockstep` mode for ablation. **Done.**
- `KernelMode` union includes `'true-drive'` as production mode.
  **Done.**

## Acceptance

- ADR §10 criterion 4: no production path calls
  `drive.executeToClock` except kernel.
- Cycle-lockstep can still be selected as `debug-lockstep` mode for
  ablation.
- New default `kernel.status().mode === 'true-drive'`.
- C64 KERNAL `LOAD` smokes green under `true-drive`.
- motm/MM custom-loader trace shows one authoritative drive-clock
  source per access window.
- Smoke test verifies `mode: 'debug-lockstep'` opt-in still works
  byte-identical to pre-202 behavior.

## Out of scope

- Hook removal → 204.
- Chip cycle audit → 212.
- GCR rotation correctness → 213.
