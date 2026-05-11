# Spec 421 — IEC Phase F: Drive-side bus access

**Status:** PROPOSED
**Branch:** `vice-arch-port`
**Depends on:** 420
**Doctrine:** 1:1 VICE IEC port.

## Goal

Wire drive VIA1 PB read/write to iecbus per
`docs/vice-iec-arc42.md §15 Phase F` (steps 15–16).

## Doc anchor

- §15 Phase F
- §5.9 drive-side bus access formulas
- §16 invariant index (PB read formula)

## Canonical content (verbatim §15 Phase F)

15. VIA1 `store_prb` (drive writes $1800): update
    `iecbus.drv_data[unit]`, recompute `iecbus.drv_bus[unit]` per
    the drive-type-specific formula (§5.9), recompute `cpu_port`,
    `drv_port`. No drive flush needed — drive is already current.
16. VIA1 `read_prb` (drive reads $1800): return
    `((PRB & DDRB) | (drv_port ^ 0x85) | 0x1A | driveid) & ~DDRB`
    layered with the output bits from PRB. The cached `drv_port` is
    fresh because it was updated atomically at the last C64 PA write
    or drive PB write.

## VICE source cite

- VIA1 1541 store_prb: `src/drive/iec/via1d1541.c:212`.
- VIA1 1541 read_prb: `src/drive/iec/via1d1541.c:337`.

## Audit — current TS state

Status:

- VIA1 PB read/write working (motm boots, IEC handshake functional).
- Formula audit pending in spec 410 / 1541 Phase D.

Overlap: this spec (IEC Phase F) and spec 410 (1541 Phase D) cover
similar territory. Coordinate: spec 410 = drive-side VIA1 setup +
IRQ wiring; spec 421 = the iecbus side of PB read/write (= the
formula + the iecbus mutation). Both must agree byte-for-byte.

Deviations to verify:

1. **PB read formula** (§5.9, §16 invariant, §15 step 16):
   - Required: `((PRB & DDRB) | (drv_port ^ 0x85) | 0x1A | driveid)
     & ~DDRB`.
   - **TODO fresh session**: cite TS exact + diff vs VICE.

2. **PB write iecbus recompute** (§15 step 15):
   - Required: `drv_data[unit] = new; recompute drv_bus[unit] per
     drive-type formula; recompute cpu_port + drv_port`.
   - **TODO**: verify 4-step path.

3. **No drive flush on PB write** (§15 step 15):
   - Required: drive is already current (= it's the drive writing
     its own port). No push-flush invocation.
   - Verify TS does NOT trigger drive_cpu_execute on drive-PB-write.

## TS extras to DELETE

- Any "PB write triggers drive flush" abstraction (would be a bug
  per §15 step 15 explicit note).

## NTSC stub

- None.

## Producer changes

1. Pin PB read formula byte-for-byte.
2. Pin PB write 4-step iecbus recompute.
3. Ensure no drive_cpu_execute on drive-PB-write.

## Consumer changes

- None outside VIA1 PB handlers.

## Acceptance

- Build clean.
- VICE drive testprogs 4/4.
- New smoke `scripts/smoke-421-via1-pb-roundtrip.mjs`: drive writes
  PB → C64 reads $DD00, gets transformed-correct value. Reverse:
  C64 writes $DD00 → drive reads VIA1 PB, gets transformed-correct.
- motm + MM + Scramble loaders functional.

## Open Questions

- **OQ-421-1**: `driveid` constant for 1541 unit 8 — per arc42
  §5.7 `(diskunit_idx & 0x3) << 5`. For unit 8 (idx 0) = 0?
  Confirm.

## Files touched

- `src/runtime/headless/drive/via1d1541.ts` (PB read/write)
- `src/runtime/headless/iec/iec-bus.ts` (drv_bus recompute)
- 1 new smoke
- `specs/421-iec-phase-f-drive-bus-access.md` (this)

## Next spec

Spec 422 — IEC Phase G: Burst mode (optional).
