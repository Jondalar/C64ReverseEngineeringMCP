# Spec 416 — IEC Phase A: IEC bus shared state

**Status:** PROPOSED
**Branch:** `vice-arch-port`
**Depends on:** 415
**Doctrine:** 1:1 VICE IEC port.

## Goal

Bring IEC bus shared state in line with
`docs/vice-iec-arc42.md §15 Phase A` (steps 1–3).

## Doc anchor

- §5.1 iecbus_t structure
- §5.2 update_cpu_bus / update_ports formulas
- §5.10 interrupt_check_irq_delay
- §11 risks (drv_port bit layout)
- §15 Phase A
- §16 invariant index

## Canonical content (verbatim §15 Phase A)

1. Allocate one global `iecbus_t` (or per-bus if multi-bus). Fields
   per §5.1: `cpu_bus`, `cpu_port`, `drv_port`, `drv_bus[16]`,
   `drv_data[16]`.
2. Provide `iec_update_cpu_bus(data)` exactly per the formula in
   `c64iec.c:123`. Mathematically equivalent expansions are OK
   (e.g. `(d<<2)&0xC0` vs `((d<<2)&0x80) | ((d<<2)&0x40)`).
3. Provide `iec_update_ports()` recomputing `cpu_port` (AND-fold)
   and `drv_port` per §5.2 formulas. No approximation: drv_port
   bit layout (ATN=7, CLK_IN=2, DATA_IN=0) is wired to VIA1 PB
   bit positions; getting it wrong corrupts every read.

## VICE source cite

- `iecbus_t`: `src/iecbus.h`.
- `iec_update_cpu_bus`: `src/c64/c64iec.c:123`.
- `iec_update_ports`: `src/c64/c64iec.c`.

## Audit — current TS state

Files:

- `src/runtime/headless/iec/iec-bus.ts`
- session-side IEC routing in `integrated-session.ts`

Status:

- IEC bus working for KERNAL LOAD + motm fastloader.
- Memo `vice-iec-arc42.md` is canonical (= already in docs).
- ADR-1 push-flush selected (per memo).

Deviations to verify:

1. **iecbus_t field layout** (§5.1, §16 invariant index):
   - Required: explicit `cpu_bus`, `cpu_port`, `drv_port`,
     `drv_bus[16]`, `drv_data[16]`.
   - **TODO fresh session**: compare TS field names + types vs §5.1.

2. **update_cpu_bus formula** (§15 step 2):
   - Required: byte transform from CIA2 PA bits → `cpu_bus` byte
     per `c64iec.c:123`.
   - **TODO**: cite + diff.

3. **update_ports AND-fold** (§15 step 3):
   - Required: `cpu_port = AND across drv_bus[*] AND cpu_bus`.
     Open-collector wired-AND.
   - **TODO**: verify TS exact.

4. **drv_port bit layout** (§15 step 3, §11):
   - Required: ATN=7, CLK_IN=2, DATA_IN=0.
   - **TODO**: cite TS positions.

## TS extras to DELETE

- Any IEC abstraction that wraps the raw byte transforms (= VICE
  inlines formulas; TS should too).

## NTSC stub

- IEC is rate-independent at signal level (clock is shared via
  drive-sync, spec 409).

## Producer changes

1. Pin `iecbus_t` shape per §5.1.
2. Pin `iec_update_cpu_bus` formula per c64iec.c:123.
3. Pin `iec_update_ports` per §5.2.

## Consumer changes

- CIA2 PA write/read paths (spec 417 / IEC Phase B) call these
  exact functions.

## Acceptance

- Build clean.
- `smoke:cpu-fidelity` 31/31, `smoke:cia-fidelity` 22/22.
- New smoke `scripts/smoke-416-iecbus-formulas.mjs`: feed known
  drv_data values; assert cpu_bus, cpu_port, drv_port outputs
  match VICE table.
- MM + Scramble unchanged (= IEC core).

## Open Questions

- **OQ-416-1**: drv_data[16] — VICE indexes by device # (0..15).
  TS may use Map. Confirm contiguous array preserves "no devices"
  bit pattern (default 0xFF = all released).
- **OQ-416-2**: cpu_bus byte transform — cite exact bit map from
  c64iec.c:123 in doc §5.2.

## Files touched

- `src/runtime/headless/iec/iec-bus.ts` (verify + modify)
- 1 new smoke
- `specs/416-iec-phase-a-shared-state.md` (this)

## Next spec

Spec 417 — IEC Phase B: CIA2 wiring.
