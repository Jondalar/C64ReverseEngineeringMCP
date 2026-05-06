# Spec 210 — CIA 1:1 VICE port

**Sprint:** 118
**Status:** PROPOSED (parallel-eligible)
**Maps from:** legacy 145 (cia-full-vice-port) — superseded
**Depends on:** 203 (alarm + IRQ timestamp surface)
**Write scope:** `src/runtime/headless/cia/*` only (chip-internal)

## Goal

Port CIA1/CIA2 register and timer behavior 1:1 from VICE
`src/c64/cia*.c`. Plug into kernel alarm and IRQ surface from 203.

## Scope

- Timer A/B latch, run, count-down, underflow.
- TOD R/W with alarm latch and HR-latch semantics.
- ICR latch + read-clears.
- CNT pin + SR shift register.
- Port A/B registers + DDR.

Chip code is pure: schedules alarms, reports IRQ line edges. Does not
own time, does not call peer chips.

## Acceptance

- VICE register-trace fixtures pass byte-exact.
- 23/23 existing CIA fidelity tests stay green.
- New tests for previously documented gaps: CNT pin, SR shifting,
  TOD-tick edge, ICR-latch.
- No `executeToClock` or peer-tick calls from CIA module.
