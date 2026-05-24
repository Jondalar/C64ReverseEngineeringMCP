# Spec 421 — IEC Phase F: Drive-side bus access

**Status:** RESOLVED 2026-05-12 — verification-only landing.
**Branch:** `vice-arch-port`
**Depends on:** 420
**Doctrine:** 1:1 VICE IEC port.

## Resolution summary (2026-05-12)

All three spec-421 producer primitives were already in place from
prior specs:

1. **PB read formula** — `src/runtime/headless/via/via1d1541.ts:103-109`
   matches VICE `src/drive/iec/via1d1541.c:347-350` byte-for-byte:
   `((PRB & DDRB) | ((drv_port ^ 0x85) | 0x1A | driveid) & ~DDRB)`.
   Driveid encoding `((deviceId-8) << 5) & 0x60` matches
   `via1d1541.c:345` `(via1p->number << 5) & 0x60`.
2. **PB write 4-step recompute** —
   `src/runtime/headless/iec/iec-bus-core.ts:124-128`
   (`drive_store_pb`) matches VICE `via1d1541.c:226-241`: `drv_data = ~byte`
   → `recompute_drv_bus(unit)` → `iec_update_ports()` (= cpu_port +
   drv_port).
3. **No drive flush on PB write** — verified by Sub-test 3 of new
   smoke `scripts/smoke-421-via1-pb-roundtrip.mjs`: drive PB writes
   never invoke `pushFlush.{all,one}` nor `flushAuditor`. C64-side
   PA write does invoke `pushFlush.one` (= sanity).

Acceptance achieved:

- `npm run build` zero errors.
- `smoke:cpu-fidelity` 31/31, `smoke:cia-fidelity` 22/22, drive
  testprogs 4/4.
- IEC phase smokes (416/417/418/419/420) all green; new
  smoke-421-via1-pb-roundtrip 23/23.
- MM s1 LOAD"*",8,1 reaches PC=$65f (= character select baseline
  pre-spec-421); Scramble LOAD"*",8,1 reaches PC=$9709 area.

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

- **OQ-421-1**: RESOLVED 2026-05-11 — see
  `docs/vice-iec-arc42.md §17.6` and updated §15 step 16. VICE
  `vice/src/drive/iec/via1d1541.c:345`:
  `driveid = (via1p->number << 5) & 0x60;` where
  `via1p->number` = drive index 0..3 (not the device number).
  For unit 8 → `number = 0` → driveid = 0. Other units:
  9→0x20, 10→0x40, 11→0x60. Mask 0x60 = `3 << 5` covers PB5/PB6
  (device-address-preset switches read by ROM $EBE7).

## Files touched

- `src/runtime/headless/drive/via1d1541.ts` (PB read/write)
- `src/runtime/headless/iec/iec-bus.ts` (drv_bus recompute)
- 1 new smoke
- `specs/421-iec-phase-f-drive-bus-access.md` (this)

## Next spec

Spec 422 — IEC Phase G: Burst mode (optional).
