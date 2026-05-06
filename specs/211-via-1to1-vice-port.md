# Spec 211 — VIA 1:1 VICE port

**Sprint:** 116
**Status:** PROPOSED (parallel-eligible)
**Maps from:** legacy 147 (via-full-vice-port) — superseded
**Depends on:** 201 (KernelBus surface for `$1800`)
**Write scope:** `src/runtime/headless/via/*` only

## Goal

Port VIA1 + VIA2 (1541) 1:1 from VICE `src/drive/iec/via*d1541.c`.
VIA1 hosts IEC `$1800` bus formula. VIA2 hosts GCR backend reads
(actual GCR rotation in 213).

## Scope

- Timer T1/T2 latch + run + alarm scheduling via 203 surface.
- Shift register + CB1/CB2 handshake.
- IFR / IER + IRQ line.
- Port A/B + DDR with VIA-specific quirks (T1 PB7 toggle).
- VIA1 PA/PB IEC line composition matches VICE bus formula.
- VIA2 PA exposes GCR data (backend filled by 213).

## Acceptance

- VICE register-trace fixtures pass byte-exact.
- VIA1 IEC contract passes Spec 110 24/24 plus new bus-formula
  fixtures from `docs/vice-iec-arc42.md`.
- VIA2 PA/CA1 wiring ready for 213 GCR backend without further VIA
  changes.
- No timing-path writes outside VIA module.
