# Spec 447 — memiec.c + driverom.c ↔ TS mapping

**Status:** DONE (2026-05-14, 1541 V1 scope)
**VICE sources:**
- `drive/iec/memiec.c` (281 LoC)
- `drive/driverom.c` (544 LoC)
**TS targets:**
- `src/runtime/headless/drive/drive-cpu.ts` (DriveBus dispatch)
- `src/runtime/headless/drive/drive-rom.ts` (ROM IO)
**Doctrine:** Claude-self, no subagents.

---

## A. memiec.c — 1541 memory dispatch (memiec_init lines 137-177)

| VICE address range | VICE handler | TS counterpart | Verdict |
|---|---|---|---|
| `$0000-$00FF` zero page | drive_read_zero / store_zero / peek_zero (line 141) | `ramRead` / `ramStore` / `ramPeek` for page 0 (drive-cpu.ts:391-394) | **MATCH** (TS unifies zero-page with RAM read; observable equivalent) |
| `$0100-$07FF` RAM | drive_read_1541ram (line 142) | pages 1-7 same handlers | **MATCH** |
| `$1800-$1BFF` VIA1 | via1d1541_read/store/peek (line 143) | `via1Read`/`via1Store`/`via1Peek` pages $18-$1B (drive-cpu.ts:399-417) | **MATCH** (`addr & 0xf` register mirror) |
| `$1C00-$1FFF` VIA2 | via2d_read/store/peek (line 144) | pages $1C-$1F (drive-cpu.ts:421-435) | **MATCH** |
| `$2000-$27FF` RAM mirror (drive_ram2 off) | drive_read_1541ram (line 148) | pages $20-$27 (drive-cpu.ts:442-446) | **MATCH** |
| `$3800-$3BFF` VIA1 mirror (drive_ram2 off) | via1d1541 (line 149) | pages $38-$3B (drive-cpu.ts:447-451) | **MATCH** |
| `$3C00-$3FFF` VIA2 mirror | via2d (line 150) | pages $3C-$3F (drive-cpu.ts:452-456) | **MATCH** |
| `$40-$47, $58-$5B, $5C-$5F` (drive_ram4 off) | RAM + VIA mirrors (lines 155-157) | pages $40-$47, $58-$5B, $5C-$5F (drive-cpu.ts:460-474) | **MATCH** |
| `$60-$67, $78-$7B, $7C-$7F` (drive_ram6 off) | RAM + VIA mirrors (lines 162-164) | pages $60-$67, $78-$7B, $7C-$7F (drive-cpu.ts:478-492) | **MATCH** |
| `$8000-$9FFF` ROM low (drive_ram8 off) | drive_read_rom from trap_rom[0..$1FFF] (line 169) | `romReadLow` from rom[0..$1FFF] (drive-cpu.ts post-Spec-447) | **PORTED-LITERAL** (Spec 447 patch) — stock 1541 mirror semantics |
| `$A000-$BFFF` ROM mid (drive_rama off) | drive_read_rom from trap_rom[$2000..$3FFF] (line 174) | `romReadMid` from rom[$2000..$3FFF] (Spec 447 patch) | **PORTED-LITERAL** |
| `$C000-$FFFF` ROM canonical | drive_read_rom from trap_rom[$4000..$7FFF] (line 176) | `romReadCanonical` from rom[0..$3FFF] (drive-cpu.ts:517-521) | **MATCH** |
| `drive_ram2/4/6/8/a_enabled` flags (RAM expansion) | conditional dispatch | not modelled — V1 stock 1541 has no RAM expansion | OUT (V1) |
| `drive_ram2_enabled=1` RAM at $2000-$3FFF | drive_read_ram (line 146) | — | OUT V1 |
| `drive_ram4/6_enabled=1` RAM at $4000-$5FFF / $6000-$7FFF | drive_read_ram (lines 153, 160) | — | OUT V1 |
| `drive_ram8/a_enabled=1` RAM at $8000-$BFFF | drive_read_ram (lines 167, 172) | — | OUT V1 |
| memiec_init cases for 1571 / 1571CR / 1581 / 2000 / 4000 / CMDHD | (lines 178-end) | — | OUT V1 (Spec 440 carve-out) |

### A.1 Static helpers (memiec.c:54-128)

| VICE function | Lines | TS counterpart | Verdict |
|---|---|---|---|
| `drive_read_rom` | 54-58 | inlined into `romReadCanonical`/`romReadLow`/`romReadMid` (drive-cpu.ts) | **MATCH-INLINED** |
| `drive_peek_rom` | 60-63 | inlined into `romPeek*` | **MATCH-INLINED** |
| `drive_read_rom_ds1216` | 66-69 | — | OUT V1 (4000-series RTC) |
| `drive_peek_rom_ds1216` | 71-74 | — | OUT V1 |
| `drive_read_ram` | 76-79 | inlined into `ramRead` for V1 base RAM | MATCH-INLINED |
| `drive_peek_ram` | 82-85 | inlined into `ramPeek` | MATCH-INLINED |
| `drive_store_ram` | 88-92 | inlined into `ramStore` (sets `lastBusValue` = VICE `cpu_last_data`) | **MATCH-INLINED** |
| `drive_read_1541ram` | 94-98 | inlined into `ramRead` (= same behavior on 1541) | MATCH-INLINED |
| `drive_peek_1541ram` | 100-104 | inlined into `ramPeek` | MATCH-INLINED |
| `drive_store_1541ram` | 106-110 | inlined into `ramStore` | MATCH-INLINED |
| `drive_read_zero` | 112-115 | inlined into `ramRead` for page 0 | MATCH-INLINED |
| `drive_peek_zero` | 117-120 | inlined into `ramPeek` | MATCH-INLINED |
| `drive_store_zero` | 123-128 | inlined into `ramStore` | MATCH-INLINED |

---

## B. driverom.c — ROM file IO + trap-patch + init

| VICE function | Lines | TS counterpart | Verdict |
|---|---|---|---|
| `driverom_test_load` | 78-146 | — | OMIT (UI/monitor only, V1 OUT) |
| `driverom_load` | 148-218 | `loadDriveRom()` (drive-rom.ts:38-58) | **PORTED-WRAPPER** — V1 simpler: 16K stock only, env-path override, bundled fallback, zero-fill safety net. VICE has sysfile_load + 16K/32K alignment + multi-drive reset loop. TS V1 single-drive doesn't need the multi-drive loop. |
| `driverom_load_images` | 220-235 | implicit — `loadDriveRom()` called once during DriveCpu construction | MATCH-IMPLICIT |
| `driverom_initialize_traps` | 236-309 | — | **TS-EXTRA-NOT-PORTED** — VICE idle-loop trap-patch optimization (replaces opcode at $EC9B with TRAP_OPCODE so emulator skips ahead during IDLE wait). TS executes the wait-loop natively (slower but correct). Documented; not load-bearing. |
| `driverom_snapshot_write` | 326-426 | — | DEFER → Spec 451 (VSF) |
| `driverom_snapshot_read` | 427-540 | — | DEFER → Spec 451 |
| `driverom_init` | 541-end | implicit (TS module-init via import) | MATCH-IMPLICIT |

---

## C. Summary

memiec.c: **17 rows** (13 dispatch ranges + 13 static helpers; some collapsed).

| Verdict | Count |
|---|---|
| MATCH / MATCH-INLINED | 22 (11 1541 dispatch ranges + 11 static helpers inlined) |
| PORTED-LITERAL (Spec 447 patch) | 2 ($80-$9F + $A0-$BF ROM mirrors) |
| OUT V1 | 5 (RAM expansion flags + non-1541 cases + DS1216) |
| DEFER → Spec 451 | 2 (snapshot R/W) |
| TS-EXTRA-NOT-PORTED | 1 (driverom_initialize_traps; optimization only) |
| OMIT (UI) | 1 (driverom_test_load) |
| **BUG / load-bearing MISSING** | **0** |

## D. Spec 447 patches

1. `drive-cpu.ts:511-575` — added literal port of memiec.c:169 +
   memiec.c:174: `$80-$9F` and `$A0-$BF` dispatch to `romReadLow` /
   `romReadMid` with proper rom buffer offset. Stock 1541 16K split-ROM
   mirrors the canonical at $C0-$FF (= what VICE iecrom.c:175-178
   memcpy-duplicates into both halves of trap_rom).

## E. Tests

`tests/unit/drive/memiec-conformance.test.ts` (NEW, 16 tests):
- Zero page + stack + RAM R/W round-trip.
- VIA1 + VIA2 dispatch + 1KB mirror.
- VIA1 + VIA2 mirrors at $3800-$3FFF (drive_ram2 disabled).
- RAM mirror at $2000-$27FF.
- ROM read at $C000 + $FFFF + write-ignored RO.
- Spec 447 patches: ROM mirror $8000=$C000, $A000=$E000, $9FFF=$DFFF,
  $BFFF=$FFFF (stock 1541 split-ROM mirror).
- Open-bus at $1000 (drive_read_free).

All 16 PASS.
