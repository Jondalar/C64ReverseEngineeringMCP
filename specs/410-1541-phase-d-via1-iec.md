# Spec 410 — 1541 Phase D: VIA1 (IEC interface)

**Status:** PROPOSED
**Branch:** `vice-arch-port`
**Depends on:** 409
**Doctrine:** 1:1 VICE TDE port.

## Goal

Bring drive VIA1 in line with `docs/vice-1541-arch.md §13 Phase D`
(steps 11–15) and §6.

## Doc anchor

- §13 Phase D
- §6.1 pin mapping (PB)
- §6.2 open-collector wired-AND
- §6.3 PB write (drive→bus)
- §6.4 PB read (bus→drive)
- §6.5 CA1 = ATN line
- §6.6 VIA1 timers
- §14 invariants 4, 5, 6
- iec-arc42 §5.5 viacore template

## Canonical content (verbatim §13 Phase D)

11. viacore template: T1, T2, SDR, IFR, IER, PRA, PRB, DDRA, DDRB,
    PCR, ACR, CA1/CA2/CB1/CB2 state. Alarm-driven timers.
12. VIA1 PB read (`read_prb`): formula
    `(via.PRB & DDRB) | ((drv_port ^ 0x85) | 0x1A | driveid) & ~DDRB`.
    Get the masks exactly right — verify byte-for-byte against
    via1d1541.c.
13. VIA1 PB write (`store_prb`): update `iecbus.drv_data[unit]`,
    recompute `iecbus.drv_bus[unit]`, recompute `iecbus.cpu_port`,
    recompute `iecbus.drv_port`. Formula in §6.3.
14. VIA1 CA1: connect to ATN line via
    `viacore_signal(via1, CA1, edge)`. PCR & 0x01 = 0 for falling-
    edge IRQ (DOS ROM config).
15. VIA1 IRQ → drive 6502 IRQ line via
    `set_int(int_status, IK_IRQ, value, rclk)`.

## VICE source cite

- VIA core: `src/core/viacore.c`.
- VIA signal: `src/core/viacore.c:441` `viacore_signal()`.
- VIA1 1541 read PB: `src/drive/iec/via1d1541.c:337` `read_prb()`.
- VIA1 1541 write PB: `src/drive/iec/via1d1541.c:212` `store_prb()`.
- VIA1 set_int: `src/drive/iec/via1d1541.c:92`.

## Audit — current TS state

Files:

- `src/runtime/headless/via/via6522-vice.ts` (viacore port)
- `src/runtime/headless/drive/via1d1541.ts`

Status:

- VIA1 + VIA2 wired (1541 boot, motm fastloader passes per memos).
- IRQ via setInt callback exists.

Deviations to verify:

1. **PB read formula** (§6.3, §14 invariant 4):
   - Required: byte-for-byte `(PRB & DDRB) | ((drv_port ^ 0x85) |
     0x1A | driveid) & ~DDRB`.
   - **TODO fresh session**: cite `via1d1541.c:337` vs TS exact.

2. **PB write iecbus update** (§6.3, §13 step 13):
   - Required: 4-step recompute (drv_data → drv_bus → cpu_port →
     drv_port).
   - **TODO**: verify all 4 paths in TS.

3. **CA1 ATN polarity** (§14 invariant 6):
   - Required: PCR & 0x01 = 0 (falling edge) for ATN.
   - **TODO**: verify TS PCR comparison.

4. **IRQ → drive 6502** (§13 step 15):
   - Required: `set_int(IK_IRQ, value, rclk)` chokepoint.
   - Current TS: drive-cpu polling bridge via session (per current
     state). Spec 411 / Phase H equivalent migrates to chip-side
     push (= analog to Phase D' on C64).
   - **TODO**: confirm migration in this spec or defer to
     pure-drive-equivalent-of-phase-D' inside Phase H spec.

5. **Open-collector wired-AND** (§6.2, §14 invariant 5):
   - Required: bus state = AND of all driver outputs.
   - **TODO**: verify `iec_update_*` formulas.

## TS extras to DELETE

- Any drive-IRQ session polling bridge (= `drive-cpu.ts:runOneInstruction`
  per-cycle setIrq call) once chip-side push from VIA1 lands.

## NTSC stub

- VIA1 is frequency-agnostic at the chip level. Timer behavior tied
  to drive clock (1 MHz both PAL/NTSC). No NTSC stub.

## Producer changes

1. Pin PB read formula to VICE exact (cite `via1d1541.c:337`).
2. Pin PB write → iecbus recompute (cite `via1d1541.c:212`).
3. Wire CA1 ATN signal via `viacore_signal` analog.
4. Migrate VIA1 IRQ to chip-side push:
   `drive.cpuIntStatus.setIrq(via1IntNum, value, rclk)`.

## Consumer changes

- `IntegratedSession` IEC bus state update: route ATN edge into
  drive VIA1 CA1 (via1's `viacore_signal` analog).
- Drop `drive-cpu.ts` polling bridge for VIA1.

## Acceptance

- Build clean.
- `smoke:cpu-fidelity` 31/31, `smoke:cia-fidelity` 22/22.
- VICE drive testprogs 4/4 PASS (= existing baseline).
- New smoke `scripts/smoke-410-via1-pb-formula.mjs`: synthetic
  drv_port values, assert PB read returns VICE-expected byte.
- New smoke `scripts/smoke-410-via1-atn-edge.mjs`: pulse ATN
  falling, assert CA1 IFR sets + IRQ fires within INTERRUPT_DELAY.
- MM + Scramble: LOAD"*",8,1 still completes (= drive IRQ pipeline
  functional).

## Open Questions

- **OQ-410-1**: `driveid` constant — for unit 8, what value? VICE
  uses `(diskunit_idx & 0x3) << 5` per arc42 §5.7. Confirm.
- **OQ-410-2**: SDR semantics on VIA1 — used by burst mode only?
  Doc §6.6 mentions burst.

## Files touched

- `src/runtime/headless/via/via6522-vice.ts` (verify viacore)
- `src/runtime/headless/drive/via1d1541.ts` (modify)
- `src/runtime/headless/drive/drive-cpu.ts` (drop polling bridge)
- `src/runtime/headless/integrated-session.ts` (ATN edge wiring)
- 2 new smokes
- `specs/410-1541-phase-d-via1-iec.md` (this)

## Next spec

Spec 411 — 1541 Phase E: VIA2 (disk controller).
