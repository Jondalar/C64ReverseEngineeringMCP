# Spec 417 — IEC Phase B: CIA2 wiring

**Status:** PROPOSED
**Branch:** `vice-arch-port`
**Depends on:** 416
**Doctrine:** 1:1 VICE IEC port.

## Goal

Wire CIA2 PA store/load callbacks to IEC bus per
`docs/vice-iec-arc42.md §15 Phase B` (steps 4–6).

## Doc anchor

- §15 Phase B
- §5.5 viacore template + iecbus callbacks
- §5.7 write_offset_correction

## Canonical content (verbatim §15 Phase B)

4. CIA2 PA store callback → `iecbus_cpu_write_conf1(data,
   maincpu_clk + write_offset_correction)`.
5. CIA2 PA read callback → `iecbus_cpu_read_conf1(maincpu_clk)`.
6. Both callbacks are registered via function pointer
   (`iecbus_callback_read/write`) indirected through
   `iecbus_status_set(devices_bitmap)`.

## VICE source cite

- `iecbus_cpu_write_conf1` / `iecbus_cpu_read_conf1`:
  `src/iecbus.c`.
- `iecbus_status_set`: `src/iecbus.c`.
- CIA2 PA store: `src/c64/c64cia2.c:148-162`.

## Audit — current TS state

Files:

- `src/runtime/headless/peripherals/cia2.ts`
- `src/runtime/headless/iec/iec-bus.ts`
- `src/runtime/headless/kernel/headless-machine-kernel.ts` (CIA2
  install + iecWrite callback)

Status:

- CIA2 PA store calls kernel-supplied `iecWrite(or, ddr,
  effectiveClock)` (already passes effectiveClock = write_offset
  applied).
- TS uses callback registration but not via `iecbus_callback_*`
  indirection.

Deviations to verify:

1. **write_offset_correction** (§5.7, §15 step 4):
   - Required: `maincpu_clk + write_offset` where write_offset
     depends on CIA core variant (0 for C64SC/SCPU64, else 1).
   - Current TS: `c64CiaWriteOffset` exists, passed to CIA install.
     Verify it propagates to iecbus write.
   - **TODO**: cite VICE write_offset selection logic.

2. **Late-binding via `iecbus_status_set`** (§15 step 6):
   - Required: callback registration via bitmap of active devices.
     Allows switching to virtual-drive mode at runtime.
   - Current TS: direct closure registration. Per refinement Q11,
     restructure to bitmap-indexed callback table.

## TS extras to DELETE

- Direct closure passing CIA2→IEC; replace with VICE
  `iecbus_callback_*` indirection.

## NTSC stub

- write_offset is CIA-variant specific, not NTSC/PAL.

## Producer changes

1. Implement `iecbus_callback_read` / `iecbus_callback_write`
   function pointers.
2. Implement `iecbus_status_set(devicesBitmap)` to switch which
   read/write callback runs.
3. CIA2 PA store → `iecbus_cpu_write_conf1` via pointer.
4. CIA2 PA load → `iecbus_cpu_read_conf1` via pointer.

## Consumer changes

- CIA2 install in kernel: register callbacks via bitmap, not direct
  closure.

## Acceptance

- Build clean.
- `smoke:cia-fidelity` 22/22, drive testprogs 4/4.
- New smoke `scripts/smoke-417-cia2-iecbus.mjs`: write to $DD00,
  assert iecbus.cpu_bus updated at correct clock (= maincpu_clk +
  write_offset).
- MM + Scramble unchanged.

## Open Questions

- **OQ-417-1**: VICE x64sc uses CIA write_offset = 0 (= C64SC)?
  Confirm in `c64cia2.c`.
- **OQ-417-2**: `iecbus_status_set` bitmap — what bits mean?
  Device 8 = bit 8? Cite.

## Files touched

- `src/runtime/headless/iec/iec-bus.ts` (callback pointers)
- `src/runtime/headless/peripherals/cia2.ts` (call via pointer)
- `src/runtime/headless/kernel/headless-machine-kernel.ts` (registration)
- 1 new smoke
- `specs/417-iec-phase-b-cia2-wiring.md` (this)

## Next spec

Spec 418 — IEC Phase C: Push-flush model.
