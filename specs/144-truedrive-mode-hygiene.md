# Spec 144 — TrueDrive Mode Hygiene

**Sprint**: 112 (core sync refactor)
**Phase**: implementation
**Status**: proposed
**Depends on**: Spec 139

## Why

TrueDrive acceptance must not be satisfied by hidden shortcuts. The
runtime still contains useful debug/fallback mechanisms such as KERNAL
traps, synthetic IEC line releases, and the drive RAM `$7C` ATN-pending
poke. Those must be visible and mode-guarded.

## Scope

In scope:

- mode guards around all non-hardware rescue paths
- session summary listing every shortcut used
- TrueDrive tests asserting no shortcut fired
- debug/fallback modes remain available and explicit

Out of scope:

- deleting useful debug tools
- changing RE convenience modes
- full UI redesign

## Acceptance

- TrueDrive pass/fail cannot be accidentally satisfied by traps or
  rescue hooks
- session output reports whether the run was hardware-pure,
  trap-assisted, or debug-assisted
- existing fast-trap workflows still work when explicitly selected

