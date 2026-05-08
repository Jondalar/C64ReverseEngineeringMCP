# Spec 212 — Drive 6502 cycle audit

**Sprint:** 117
**Status:** DONE 2026-05-08 — `npm run smoke:drive-equiv` passes (equiv walk + coverage + SO pin + bus traces). Cpu65xxVice (= Cpu6510 microcoded port from VICE 6510core.c) covers all 256 opcodes incl illegals, dummy reads/writes, page-cross, RMW, branch timing. Recent BCD ADC/SBC fix (commit f250645) verified via Lorenz Disk1 100% PASS. ExecuteToClock callers exclusively from kernel (Spec 202 DONE). Audit doc: `docs/drive-cpu-fidelity-notes.md`.
**Maps from:** legacy 146 (drive-6502-cycle-audit) — superseded
**Depends on:** 202 (catch-up private)
**Write scope:** `src/runtime/headless/drive/drive-cpu.ts` only

## Goal

Audit drive 6502 implementation for cycle-exact correctness against
VICE `src/drive/drivecpu.c`. Document and close the remaining
opcode/timing gaps that surfaced during Sprint 113.

## Scope

- Per-opcode cycle-count audit vs VICE.
- Dummy-read / dummy-write phases reported through `BusAccessContext`.
- RDY / RMW / branch-page-cross timing.
- Reset state byte-exact handoff (overlaps 215 — coordinate).

## Acceptance

- Drive CPU equivalence harness passes against VICE drivecpu trace
  on at least: idle loop, M-W upload, custom fastloader byte-pump.
- All `executeToClock` callers come exclusively from kernel
  (preserves 202).
- Cycle audit document committed under `docs/drive-cpu-audit.md`.
