# Spec 202 — Drive catch-up private to kernel

**Sprint:** 117
**Status:** PROPOSED
**ADR:** Decision A, Decision D, §8 Step 3
**Depends on:** 201
**Blocks:** 203, 212, 213

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
  module-private).
- Kernel adds `kernel.catchUpDrive(targetClock, device)` used only by
  `KernelBus` cross-domain access points.
- Search audit: zero production callers of `executeToClock` outside
  kernel.
- New `EventCatchupStrategy implements SyncStrategy`, becomes default.
- `LockstepStrategy` (from Spec 200) stays selectable as
  `debug-lockstep` mode for ablation.
- `KernelMode` union widens to include `'true-drive'` as default
  production mode.

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
