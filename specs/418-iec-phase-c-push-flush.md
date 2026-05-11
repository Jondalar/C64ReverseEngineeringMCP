# Spec 418 — IEC Phase C: Push-flush model

**Status:** PROPOSED
**Branch:** `vice-arch-port`
**Depends on:** 417
**Doctrine:** 1:1 VICE IEC port.

## Goal

Implement push-flush invariant per
`docs/vice-iec-arc42.md §15 Phase C` (steps 7–9).

## Doc anchor

- §15 Phase C
- §5.11 complete call-site enumeration
- §6 sequence diagrams
- §9 ADR-1 push-flush

## Canonical content (verbatim §15 Phase C)

7. On C64 PA write/read, **before** doing anything else, call
   `drive_cpu_execute_all(clock)` (write) or
   `drive_cpu_execute_one(unit, clock)` (write target). This is the
   push-flush invariant. Cf. §5.11 for the complete site list.
8. `drive_cpu_execute_one/all` converts host cycles to drive cycles
   via the 16.16 sync_factor (cf. §5.12) and runs the drive's 6502
   until it catches up.
9. After flush, the drive is *guaranteed* at an instruction
   boundary. Subsequent bus state mutation atomically updates
   `cpu_bus`, `drv_bus[unit]`, `cpu_port`, `drv_port` (via
   `iec_update_cpu_bus` + `iec_update_ports`) so the drive's next
   instruction observes the new state.

## VICE source cite

- `drive_cpu_execute_all`: `src/drive/drive.c:1001`.
- `drive_cpu_execute_one`: `src/drive/drive.c:991`.
- Call sites: per §5.11 enumeration (CIA2 PA store/load,
  flip-flop mode change, etc.).

## Audit — current TS state

Status:

- Push-flush concept: implemented (drive catches up before C64 PA
  access). But exact call-site set vs §5.11 not verified.
- 16.16 sync_factor: pinned in spec 409.

Deviations to verify:

1. **Call-site enumeration** (§5.11, §15 step 7):
   - Required: full set of C64-side IEC mutation sites trigger
     push-flush before mutating.
   - Current TS: probably hits the obvious ones (CIA2 PA
     write/read). Verify completeness vs §5.11.

2. **Atomic mutation after flush** (§15 step 9):
   - Required: flush → update cpu_bus / drv_bus[*] / cpu_port /
     drv_port all in one go, no intermediate read by drive.
   - Verify ordering in TS.

## TS extras to DELETE

- Any "pull-mode" drive lockstep that runs drive per C64 cycle (=
  observably different per §14 invariant 12).

## NTSC stub

- None.

## Producer changes

1. Enumerate VICE §5.11 call sites; ensure TS hits each before
   mutating IEC state.
2. Wrap mutations in atomic update function (read all old → update
   all new → no interleaving).

## Consumer changes

- Every C64-side IEC mutation site routes through this wrapper.

## Acceptance

- Build clean.
- VICE drive testprogs 4/4.
- New smoke `scripts/smoke-418-push-flush-coverage.mjs`: instrument
  IEC writes; assert each site calls `drive_cpu_execute_all` before
  mutating.
- MM + Scramble unchanged.

## Open Questions

- **OQ-418-1**: §5.11 call-site enumeration — pin exact list in
  doc. Currently §5.11 referenced but list not explicit in TS audit.

## Files touched

- `src/runtime/headless/iec/iec-bus.ts` (atomic update wrapper)
- `src/runtime/headless/integrated-session.ts` (call sites)
- `src/runtime/headless/kernel/headless-machine-kernel.ts` (CIA2
  callbacks already adjusted in 417)
- 1 new smoke
- `specs/418-iec-phase-c-push-flush.md` (this)

## Next spec

Spec 419 — IEC Phase D: ATN edge + CA1.
