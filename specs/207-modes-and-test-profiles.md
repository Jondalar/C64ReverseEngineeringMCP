# Spec 207 — Public modes + test profiles

**Sprint:** 121
**Status:** PROPOSED
**ADR:** §7, §11
**Depends on:** 200
**Parallel-eligible with:** 201-205

## Goal

Replace ad-hoc mode flags with the four production modes and the four
diagnostic modes. Add test profiles that print kernel mode + active
hooks + media + result counts.

## Modes (ADR §7)

Production:

- `fast-trap` — RE convenience, traps allowed and reported.
- `real-kernal` — real C64 KERNAL, simplified drive allowed.
- `true-drive` — real C64 + real 1541, no hidden hooks.
- `debug-vice-compare` — true-drive + trace/diff instrumentation.

Diagnostic (not acceptance):

- `debug-lockstep`
- `debug-push-only`
- `debug-hybrid`

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
