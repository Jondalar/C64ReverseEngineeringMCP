# Spec 204 — TrueDrive hook hygiene

**Sprint:** 119
**Status:** c1+c2+c3 DONE — hook registry + IEC release gating + KERNAL trap recording landed; smoke 9/9 PASS. c4 = follow-up smoke widening (deferred).
**ADR:** §6, §8 Step 5
**Maps from:** legacy 144 (truedrive-mode-hygiene) — superseded
**Depends on:** 203
**Blocks:** 206

## Status (2026-05-06)

- **c1 ✓** `src/runtime/headless/kernel/kernel-hooks.ts` — `HookRegistry`,
  `HookForbiddenError`, `HookName` union, `HookStatus`. Mode-aware
  `recordFire`. `KernelStatus.hooks` widened from `string[]` to
  `HookStatus[]`. Kernel exposes `setMode/getMode`,
  `recordHookFire(name, description?)`, `hooks: HookRegistry`.
- **c2 ✓** `IecBus.releaseDriveClk` / `releaseDriveData` route through
  kernel-injected hook recorder. In `true-drive` mode any call throws
  `HookForbiddenError` BEFORE mutating bus state. `attachDriveRam`
  registered as `atn-poke-7c` for future poke callsites (no callsite
  in tree yet).
- **c3 ✓** `IntegratedSession.checkAndHandleTraps` records hook fires
  for `kernal-fileio-trap`, `kernal-serial-trap`, `kernal-io-trap` —
  on actual fire only, not per check. Legacy non-scheduler step path
  reuses the same helper so both paths are equally audited.
- **c4 ✓** `scripts/smoke-hook-hygiene.mjs` — 9/9 PASS. Asserts
  registry contents + zero-at-construction + record-on-fire +
  HookForbiddenError in `true-drive` + reset on mode flip back.

## Smoke + audit

| Check | Result |
|---|---|
| `npm run build:mcp` | green |
| `npm run audit:no-peer-tick` | 0 violations |
| `npm run smoke:kernel-facade` | 14/14 PASS |
| `npm run smoke:hook-hygiene` | 9/9 PASS |
| `npm run smoke:load` (L2/L3/L7 incl. MM 38KB) | 3/3 PASS |

## Goal

`true-drive` mode runs with `hooks: []`. All compatibility hooks are
mode-gated and traceable.

## Scope

Disable in `true-drive`:

- `$7C` ATN-pending poke into drive RAM.
- Synthetic IEC line release methods.
- KERNAL serial/file traps.
- Forced PC jumps.
- Fake disk byte delivery.

Hooks still allowed in `fast-trap` and `debug-*` modes, but each
firing emits a kernel trace event; `kernel.status().hooks` lists every
active hook.

Acceptance tests fail if any hook fires while mode = `true-drive`.

## Acceptance

- ADR §10 criterion 5: no hidden hook can fire in `true-drive`.
- Test suite exercises each hook in `fast-trap` (allowed, traced) and
  `true-drive` (must fail loud).
- `kernel.status()` exposes hook list with last-fire clock per hook.

## Out of scope

- Mode definitions → 207.
- Trace ring schema → 205.
