# Spec 210 — CIA 1:1 VICE port

**Sprint:** 118
**Status:** DONE 2026-05-08 — Cia6526Vice (1518 LOC, 1:1 VICE port) + helpers ciat.ts + cia-tod.ts + cia-sdr.ts. Existing tests: cia-icr-irq 11/11, cia-register-rw 16/16, cia-sdr 14/14, cia-tod 15/15, cia-write-offset 4/4, cia2-iec-write 3/3 = **63/63 PASS** (well beyond original 23/23 acceptance). Covers Timer A/B, TOD with alarm latch, ICR R/W-clears, SR + CNT pin, Port A/B + DDR. Plugs into kernel alarm/IRQ surface (Spec 203 DONE). No-peer-tick eslint rule enforces architectural boundary.
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
