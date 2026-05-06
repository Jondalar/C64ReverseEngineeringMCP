# Spec 201 — IEC behind KernelBus

**Sprint:** 116
**Status:** IN PROGRESS — c1 done 2026-05-06
**ADR:** Decision E, §4.4, §8 Step 2
**Maps from:** legacy 140 (vice-compatible-iec-core) — superseded
**Depends on:** 200
**Blocks:** 202, 211 (VIA port)

## Commit chain

- **c1 ✓ 2026-05-06** — `HeadlessKernelBus` class lands as
  `kernel.bus`. `c64Read/c64Write` route $DD00 to
  `iecBus.buildC64InputBits` / `setC64Output`; `driveRead/driveWrite`
  route $1800 to `setDriveOutput`; other addresses fall through to
  the local memory bus. CIA2 and VIA1 still call iecBus directly —
  bus exists as a target, not yet the path.
- **c2** — CIA2 backend `storePa` and `readPa` call
  `kernel.bus.c64Write/Read` instead of `iec.setC64Output` /
  `iec.buildC64InputBits`.
- **c3** — Drive VIA1 `$1800` write/read goes through
  `kernel.bus.driveWrite/Read`.
- **c4** — Replace IecBus released-flag model with VICE-style cached
  state (`cpu_bus`, `cpu_port`, `drv_bus[unit]`, `drv_data[unit]`,
  `drv_port`, `iec_old_atn`) — already present via
  `IecBusCore`; verify production code never bypasses it.
- **c5** — Smoke + audit; remove `IecBus.beforeC64Read` from the
  production path (keep only kernel-internal usage).

## Goal

Move every cross-domain IEC access (`$DD00` C64-side, `$1800`
drive-side) behind `KernelBus` entry points. Remove
`IecBus.beforeC64Read` from production paths.

## Scope

- `KernelBus.c64Read/c64Write/driveRead/driveWrite` carry
  `BusAccessContext { side, device, clock, pc, opcode, phase, addr,
  access }`.
- C64 `$DD00` access goes through `kernelBus.c64Read/Write`.
- Drive `$1800` access goes through `kernelBus.driveRead/Write`.
- IEC core uses VICE-style cached state: `cpu_bus`, `cpu_port`,
  `drv_bus[unit]`, `drv_data[unit]`, `drv_port`, `iec_old_atn`.
- Removed from production: parallel "released flag" bus model.
- `IecBus.beforeC64Read` becomes private to kernel; external callers
  fail compile.

## Acceptance

- Search proves no production code calls `IecBus.beforeC64Read`.
- C64 KERNAL `LOAD` smokes still green.
- Bus-access trace (placeholder 200, full 205) captures `$DD00` and
  `$1800` with full `BusAccessContext`.
- VICE/headless diff (205-B) can align first receive window.
- Spec 211 (VIA 1:1 port) can land cleanly because chip surface is
  defined.

## Out of scope

- Drive catch-up ownership → 202.
- Hook removal → 204.
- Trace ring/JSONL → 205.
