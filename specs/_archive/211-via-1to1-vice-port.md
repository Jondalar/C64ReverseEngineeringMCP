# Spec 211 — VIA 1:1 VICE port

**Sprint:** 116
**Status:** DONE 2026-05-08 — VIA6522Vice (1332 LOC, 1:1 VICE port) covers T1/T2/SR/IFR/IER/CA1/CB1 with VICE-style alarm scheduling. VIA1d1541 + VIA2d1541 wrappers expose IEC bus formula + GCR backend per Spec 110/213. Existing tests: via-ca-cb-handshake 10/10, via-ila-ilb-latch 5/5, via-register-rw 19/19, via-sr-modes 6/6, via-t1-pb7-toggle 8/8, via-write-offset 4/4 = 52/52 PASS. Spec 110 VIA1 IEC contract 24/24 PASS. Spec 213 closure proves VIA2 PA/CA1 wiring works for motm/MM/IM2 boot.
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
