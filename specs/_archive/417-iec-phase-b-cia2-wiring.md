# Spec 417 — IEC Phase B: CIA2 wiring

**Status:** IMPLEMENTED 2026-05-12
**Branch:** `vice-arch-port`
**Depends on:** 416
**Doctrine:** 1:1 VICE IEC port.

## Implementation

- `src/runtime/headless/iec/iecbus-callbacks.ts` (new) — VICE
  `iecbus_callback_{read,write}` function-pointer indirection +
  `iecbus_status_set` per-unit nibble + `iecbus_device_index[16]`
  lookup + `calculate_callback_index` composite key dispatcher
  selecting conf0/conf1/conf2/conf3.
- `src/runtime/headless/iec/iec-bus.ts` — owns one `IecBusCallbacks`
  instance, default-binds unit 8 to TRUEDRIVE+DRIVETYPE
  ⇒ conf1. `setC64Output` and `buildC64InputBits` route through
  `callbacks.callbackWrite` / `callbacks.callbackRead` (private
  `_performC64Write` / `_performC64Read` are the conf1 body).
- `src/runtime/headless/peripherals/cia2.ts` — `iecWriteClock` doc
  cite added (= VICE `maincpu_clk + !(write_offset)`).
- `src/runtime/headless/kernel/headless-kernel-bus.ts` — forward
  `ctx.clock` to `setC64Output` / `buildC64InputBits` so the iecbus
  callback sees the correct CIA2-supplied clock.
- `src/runtime/headless/kernel/headless-machine-kernel.ts` — pinned
  `c64CiaWriteOffset = 0` doc cite expanded with §17.2 OQ-417-1.
- `scripts/smoke-417-cia2-iecbus.mjs` (new) — 22 checks across 7
  sub-tests covering default conf-pair, status_set lookup table,
  composite key dispatch, callback dispatcher (data, clock) pass-through,
  setC64Output cpu_bus mutation, write_offset wrap formula, end-to-end
  bus-access producer wiring.

Acceptance results (2026-05-12):
- `npm run build` — clean.
- `smoke:cpu-fidelity` — 31/31.
- `smoke:cia-fidelity` — 22/22.
- `smoke:416-iecbus-formulas` — 27/27 (no regression).
- `smoke:417-cia2-iecbus` — 22/22.
- `test:drive-suite` — 4/4.

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

- **OQ-417-1**: RESOLVED 2026-05-11 — see
  `docs/vice-iec-arc42.md §17.2`. `cia2_setup_context` forces
  `cia->write_offset = 0` for `VICE_MACHINE_C64SC` /
  `VICE_MACHINE_SCPU64` (`vice/src/c64/c64cia2.c:307-310`);
  default is 1 (`vice/src/core/ciacore.c:2028`). The store wraps
  the IEC callback as
  `(*iecbus_callback_write)(tmp, maincpu_clk + !(write_offset))`
  (`vice/src/c64/c64cia2.c:162`); x64sc passes `maincpu_clk + 1`.
- **OQ-417-2**: RESOLVED 2026-05-11 — see
  `docs/vice-iec-arc42.md §17.2`. Bitmap is NOT "device 8 = bit 8".
  It is a packed per-unit nibble of four orthogonal status flags
  (TRUEDRIVE / DRIVETYPE / IECDEVICE / TRAPDEVICE — `iecbus.h:37-40`),
  mapped via `iecbus_device_index[16]` lookup to NONE/IECDEVICE/
  TRUEDRIVE, then a composite key over units 4..11 selects one of
  four `iecbus_cpu_{read,write}_confN` callback pairs
  (`vice/src/iecbus/iecbus.c:432-463`).

## Files touched

- `src/runtime/headless/iec/iec-bus.ts` (callback pointers)
- `src/runtime/headless/peripherals/cia2.ts` (call via pointer)
- `src/runtime/headless/kernel/headless-machine-kernel.ts` (registration)
- 1 new smoke
- `specs/417-iec-phase-b-cia2-wiring.md` (this)

## Next spec

Spec 418 — IEC Phase C: Push-flush model.
