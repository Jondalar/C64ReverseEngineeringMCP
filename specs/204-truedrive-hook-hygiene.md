# Spec 204 — TrueDrive hook hygiene

**Sprint:** 119
**Status:** PROPOSED
**ADR:** §6, §8 Step 5
**Maps from:** legacy 144 (truedrive-mode-hygiene) — superseded
**Depends on:** 203
**Blocks:** 206

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
