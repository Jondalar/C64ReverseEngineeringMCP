# Spec 200 — MachineKernel facade and status

**Sprint:** 115
**Status:** PROPOSED
**ADR:** `docs/adr-headless-machine-kernel.md` (Decision A, §8 Step 1)
**Depends on:** none
**Blocks:** 201, 202, 203, 204, 205, 206, 207, 215, 216

## Goal

Create the kernel facade with no behavior change. Establish the single
production owner of time. Existing chip wiring keeps working through
delegation.

## Scope

Add:

- `src/runtime/headless/kernel/machine-kernel.ts` — `MachineKernel`
  interface from ADR §3 Decision A.
- `src/runtime/headless/kernel/kernel-bus.ts` — `KernelBus` +
  `BusAccessContext` shape (consumers wire up in 201).
- `src/runtime/headless/kernel/clock-domains.ts` — `c64Clock`,
  `driveClock[device]`, fractional accumulator, PAL/NTSC ratio.
- `src/runtime/headless/kernel/kernel-trace.ts` — placeholder event
  ring (filled by 205).
- `src/runtime/headless/kernel/kernel-status.ts` — `status()` returns
  mode, clocks, active hooks (always `[]` until 204), media slots.

`IntegratedSession` becomes a delegating facade where possible. No
chip removal. No mode rename (yet — that comes in 207).

## Acceptance

- Build green.
- Existing smoke load (`MM`, `LOAD"$",8`, synthetic D64) green.
- `kernel.status()` exposes mode, c64Clock, driveClock, hooks list.
- `IntegratedSession` API surface unchanged for external callers.
- New module has unit-level smoke test for facade pass-through.

## Out of scope

- IEC behind kernel bus → 201.
- Drive catch-up ownership → 202.
- Alarm dispatch ownership → 203.
- Any hook removal → 204.

## Notes

ADR §10 acceptance criteria 1-2 are partially staged here (kernel
exists, can answer time queries). Full "owner of time" enforcement
lands across 201-204.
