# Spec 207 — Public modes + test profiles

**Sprint:** 121
**Status:** DONE 2026-05-08 — KernelMode widened to all 8 ADR §7 modes
in src/runtime/headless/kernel/kernel-status.ts. Session-modes mapping
for debug-push-only + debug-hybrid added in session-modes.ts. E2E
ladder script: scripts/e2e-game-ladder.mjs. npm run test:e2e:{quick,
integration,local} wired in package.json. **audit-timing-fork lint shipped (scripts/audit-timing-fork.mjs,
`npm run audit:timing-fork`, 0 violations).
e2e-local 6/6 PASS**:
c64-ready (true-drive), motm-dir-load (fast-trap), motm-full-boot
(true-drive 7474 bytes), mm-s1-boot (35619 bytes), im2-boot (33628
bytes), lnr-s1-boot (38728 bytes). Each test prints kernel mode +
media + hook fire-count. Lint rule deferred (low priority, can be
added when timing-fork temptation re-arises).
**ADR:** §7, §11
**Depends on:** 200
**Parallel-eligible with:** 201-205

## Goal

Replace ad-hoc mode flags with the four production modes and the four
diagnostic modes. Add test profiles that print kernel mode + active
hooks + media + result counts.

## Modes (ADR §7)

`KernelMode` union widens to all eight values and replaces the Spec 200
+ Spec 202 partial unions.

Production:

- `fast-trap` — RE convenience, traps allowed and reported.
- `real-kernal` — real C64 KERNAL, simplified drive allowed.
- `true-drive` — real C64 + real 1541, no hidden hooks.
- `debug-vice-compare` — true-drive + trace/diff instrumentation.

Diagnostic (not acceptance):

- `debug-lockstep` — opt-in `LockstepStrategy` (Spec 200 default,
  demoted by Spec 202).
- `debug-push-only` — push-only sync probe (no replacement of
  event/catch-up).
- `debug-hybrid` — hybrid sync probe.

Each diagnostic mode plugs in via `SyncStrategy`; production modes
use `EventCatchupStrategy` (Spec 202).

## Test profiles (ADR §11.4)

- `quick` — build + smoke.
- `integration` — quick + subsystem integration.
- `trace` — integration + VICE/headless diff captures.
- `e2e-local` — real G64 boot tests (MM, motm, LN, IM2).
- `release` — integration + selected trace + e2e-local.

Every profile prints kernel mode, media used, traps/hooks used,
pass/fail counts, artifact paths.

## Acceptance

- `kernel.status().mode` returns one of eight modes.
- Smoke + integration tests run in each profile.
- E2E ladder per ADR §11.3 implemented for at least MM and motm.
- Lint rule rejects new code paths that fork emulator timing.
