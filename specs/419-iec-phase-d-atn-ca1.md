# Spec 419 — IEC Phase D: ATN edge + CA1

**Status:** PROPOSED
**Branch:** `vice-arch-port`
**Depends on:** 418
**Doctrine:** 1:1 VICE IEC port.

## Goal

Wire ATN edge detection → drive VIA1 CA1 signal per
`docs/vice-iec-arc42.md §15 Phase D` (steps 10–12).

## Doc anchor

- §15 Phase D
- §5.5 viacore_signal
- §5.6 update_myviairq_rclk
- §11 polarity risks

## Canonical content (verbatim §15 Phase D)

10. After `iec_update_cpu_bus`, compare new `(cpu_bus & 0x10)` with
    `iec_old_atn`. If changed, call
    `viacore_signal(via1d1541[unit], VIA_SIG_CA1, edge)` where
    `edge = (new_atn_released ? VIA_SIG_RISE : 0)`. Note: `0` ==
    `VIA_SIG_FALL`; the polarity tag is compared to `PCR & 0x01`.
11. `viacore_signal` sets IFR_CA1 iff polarity matches PCR config.
    DOS 1541 ROM configures PCR for falling-edge (`PCR & 0x01 == 0`).
12. After IFR_CA1 set, `update_myviairq_rclk(via, *clk_ptr)` stamps
    the drive clock and calls `set_int(..., rclk = drive_clk)`.

## VICE source cite

- `viacore_signal`: `src/core/viacore.c:441`.
- ATN edge detect: `src/c64/c64iec.c` (search for `iec_old_atn`).

## Audit — current TS state

Status:

- ATN edge detection: works (memo `motm-via1-ca1` confirms motm
  fastloader boots, which depends on CA1 falling edge).
- VIA1 CA1 polarity = falling-edge for DOS ROM PCR config.

Deviations to verify:

1. **ATN edge compare formula** (§15 step 10):
   - Required: `(cpu_bus & 0x10)` mask, compare to `iec_old_atn`.
   - **TODO fresh session**: cite TS exact mask.

2. **Edge → polarity tag** (§15 step 10):
   - VICE: VIA_SIG_RISE = 1, VIA_SIG_FALL = 0; PCR & 0x01 compared.
   - **TODO**: verify TS constants.

3. **rclk stamping** (§15 step 12):
   - Required: `update_myviairq_rclk(via, *clk_ptr)` stamps drive
     clock; `set_int` called with rclk.
   - **TODO**: verify TS via1.setInt call includes rclk arg.

## TS extras to DELETE

- Any non-VICE "ATN bridge" abstraction.

## NTSC stub

- None.

## Producer changes

1. Pin ATN edge detection per §15 step 10.
2. Pin `viacore_signal` polarity compare per §15 step 11.
3. Pin rclk stamping per §15 step 12.

## Consumer changes

- IEC bus update after CIA2 PA write triggers ATN edge check; if
  changed, signal VIA1 CA1.

## Acceptance

- Build clean.
- VICE drive testprogs 4/4.
- New smoke `scripts/smoke-419-atn-edge.mjs`: program CIA2 PA to
  pulse ATN low; assert drive VIA1 CA1 IFR set at correct drive
  clock.
- motm fastloader boots (= existing).

## Open Questions

- **OQ-419-1**: `iec_old_atn` storage location — global or
  per-bus? Cite.
- **OQ-419-2**: VIA_SIG_RISE vs VIA_SIG_FALL constant values —
  pin in doc.

## Files touched

- `src/runtime/headless/iec/iec-bus.ts` (ATN edge logic)
- `src/runtime/headless/drive/via1d1541.ts` (CA1 signal)
- `src/runtime/headless/via/via6522-vice.ts` (signal API)
- 1 new smoke
- `specs/419-iec-phase-d-atn-ca1.md` (this)

## Next spec

Spec 420 — IEC Phase E: Drive 6502 IRQ delivery.
