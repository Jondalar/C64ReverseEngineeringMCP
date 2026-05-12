# Spec 201 — IEC behind KernelBus

**Sprint:** 116
**Status:** DONE 2026-05-06 (c1-c5)
**ADR:** Decision E, §4.4, §8 Step 2
**Maps from:** legacy 140 (vice-compatible-iec-core) — superseded
**Depends on:** 200
**Blocks:** 202, 211 (VIA port)

## Commit chain

- **c1 ✓ 2026-05-06** — `HeadlessKernelBus` lands as `kernel.bus`,
  routes $DD00 / $1800 to IecBus methods. CIA2 and VIA1 still call
  iecBus directly at this point.
- **c2 ✓ 2026-05-06** — CIA2 PA store/read goes through
  `kernel.bus.c64Write/Read(0xDD00, …)`. `BusAccessContext.ddrMask`
  added so DDR survives the bus hop. CIA2 install no longer takes an
  IecBus reference.
- **c3 ✓ 2026-05-06** — Drive VIA1 PB store goes through
  `kernel.bus.driveWrite(8, 0x1800, …)`. `Via1d1541Options` /
  `DriveCpuOptions` thread an optional `iecStorePb` callback; kernel
  supplies the bus-routed version, fixtures keep the direct path.
- **c4 ✓ 2026-05-06** — Live bus-routing smoke. Hit-counter wraps
  `kernel.bus.c64Write` / `.driveWrite`, runs a normal boot, asserts
  both 0xDD00 and 0x1800 writes are observed. 12/12 PASS.
- **c5 ✓ 2026-05-06** — `audit:no-peer-tick` extended to flag direct
  IecBus mutation calls (`setC64Output`, `setDriveOutput`,
  `drive_store_pb`, `beforeC64Read=`, `releaseDriveClk/Data`) outside
  the allowlist. Chip-internal modules (`via/`, `cia/`) added to
  allowlist alongside kernel/, scheduler/, and drive internals.
  Production paths now report 0 violations. Spec 202 later removed the
  legacy `beforeC64Read` hook entirely; `$DD00` catch-up now happens at
  the `KernelBus` boundary.

## Live routing verification (smoke:kernel-facade)

`kernel-facade.smoke` wraps `kernel.bus.c64Write` and
`kernel.bus.driveWrite` and asserts that during a normal boot run
both `0xDD00` writes (CIA2) and `0x1800` writes (drive VIA1) reach
the bus. As of 2026-05-06 the smoke reports 12/12 PASS — routing is
live, not just installed.

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
- `IecBus.beforeC64Read` removed from production runtime.

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
