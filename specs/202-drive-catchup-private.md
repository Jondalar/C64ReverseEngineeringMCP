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

## Scope

- `DriveCpu.executeToClock` visibility lowered (TS `internal` /
  module-private).
- Kernel adds `kernel.catchUpDrive(targetClock, device)` used only by
  `KernelBus` cross-domain access points.
- Search audit: zero production callers of `executeToClock` outside
  kernel.
- Cycle-lockstep scheduler is mode-tagged `debug-lockstep`; the
  production `true-drive` mode uses event/catch-up only.

## Acceptance

- ADR §10 criterion 4: no production path calls
  `drive.executeToClock` except kernel.
- Cycle-lockstep can still be selected as `debug-lockstep` mode for
  ablation.
- C64 KERNAL `LOAD` smokes green.
- motm/MM custom-loader trace shows one authoritative drive-clock
  source per access window.

## Out of scope

- Hook removal → 204.
- Chip cycle audit → 212.
- GCR rotation correctness → 213.
