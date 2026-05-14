# Spec 447 — `memiec.c` + `driverom.c` literal port

**Status:** OPEN
**Priority:** HIGH
**Parent:** Epic 440
**Depends on:** Spec 441-446
**Doctrine:** Claude-self literal audit. No subagents.

**Anchors:**
- `docs/vice-1541-arch.md` §4 (drive memory map), §4.1 (1541 layout)
- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/iec/memiec.c` (281 LoC)
- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/driverom.c` (544 LoC)

## Klartext

Sprint 430 chip-matrix flags `memiec.c` + `driverom.c` als TEIL.
Spec 447 schließt für 1541-V1 scope: 1541 memory dispatch table +
ROM file IO + trap-patch + init.

## VICE source of truth

| File | LoC | Functions / scope |
|---|---|---|
| `drive/iec/memiec.c` | 281 | 11 static read/write/peek helpers + `memiec_init` (1541/1571/1581/4000/CMDHD) |
| `drive/driverom.c` | 544 | `driverom_test_load`, `driverom_load`, `driverom_load_images`, `driverom_initialize_traps`, `driverom_snapshot_write/read`, `driverom_init` |

## Headless target

- `src/runtime/headless/drive/drive-cpu.ts` — DriveBus owns readTab /
  storeTab / peekTab dispatch + RAM/ROM buffers.
- `src/runtime/headless/kernel/headless-machine-kernel.ts` — ROM
  load path (filesystem or bundled).
- `src/runtime/headless/drive/drive-rom.ts` (if separate) — ROM IO.

## Scope (1541 V1 only)

In scope:
- `memiec_init` 1541 branch (memiec.c:137-177): address-range dispatch
  + RAM expansion gates (drive_ram2/4/6/8/a).
- 11 static helpers: drive_read_rom, drive_peek_rom,
  drive_read_ram, drive_peek_ram, drive_store_ram,
  drive_read_1541ram, drive_peek_1541ram, drive_store_1541ram,
  drive_read_zero, drive_peek_zero, drive_store_zero.
- `driverom_load` (file IO + length check 16K/64K + checksum log).
- `driverom_load_images` (loop).
- `driverom_initialize_traps` (KERNAL trap-patch table).
- `driverom_init` (subsystem init).

Out of scope (other specs / OUT V1):
- `memiec_init` 1571 / 1571CR / 1581 / 2000 / 4000 / CMDHD branches
  — OUT V1 per Spec 440.
- `drive_read_rom_ds1216` / `drive_peek_rom_ds1216` — 4000-series.
- `driverom_test_load` — UI/monitor only.
- `driverom_snapshot_write/read` — DEFER → Spec 451 (VSF).

## Acceptance

1. `docs/spec-447-memiec-driverom-mapping.md` mapping matrix.
2. Each BUG / MISSING → port-patch.
3. 1541 memory map literal vs VICE `memiec_init` 1541 branch.
4. ROM load path matches VICE `driverom_load`.
5. `tests/unit/drive/memiec-conformance.test.ts` PASS:
   - Zero page R/W
   - Stack/RAM $0100-$07FF R/W
   - VIA1 dispatch $1800-$1BFF
   - VIA2 dispatch $1C00-$1FFF
   - VIA mirror at $3800-$3FFF (drive_ram2 default-disabled)
   - ROM read at $C000-$FFFF
6. `npm run canary:spec-430` 5/5 PASS.
7. `tests/integration/drivecpu-vs-vice-baseline.test.mjs` 9999/9999
   no regression.
8. `docs/spec-447-production-proof.md` committed.
9. No subagent verdicts.

## Do Not

- Do not delegate audit to subagent.
- Do not port non-1541 dispatch branches.
- Do not implement DS1216 RTC.
- Do not start Spec 448 before 447 DONE.

## Workflow gates

7-step per [[feedback_1541_port_workflow]].
