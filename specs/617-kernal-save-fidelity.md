# Spec 617 — KERNAL Save Fidelity

**Status:** DRAFT (2026-05-19)
**Parent specs:** `specs/611-new-vice1541-side-by-side.md`, `specs/612-1541-port-fidelity-rules.md`, `specs/620-port-bug-forensic-doctrine.md`, `specs/615-gcr-decode-fidelity.md`, `specs/616-kernal-load-fidelity.md`
**Base commit:** post-616-DONE (TBD).
**Branch:** `codex/617-kernal-save-fidelity` (stacked on 616).

## 1. Why this spec exists

Spec 616 closes the read direction (LOAD"<name>",8,1). The write direction (SAVE"<name>",8) is the **inverse byte-handshake plus a drive-side sector write through the GCR encode + writeback chain**. Write-back was explicitly out of scope in Spec 615 §6.

Open until acceptance:

- ❌ `SAVE"<name>",8` from BASIC → disk image bytes match VICE.
- ❌ Subsequent `LOAD"<name>",8` returns identical bytes.
- ❌ BAM allocation tracks correctly.
- ❌ Directory entry inserted with correct sector chain.

## 2. KERNAL SAVE code path (C64 side)

| Addr | Symbol | Role |
|---|---|---|
| `$F5ED` | SAVE | High-level entry from BASIC. |
| `$F68F` | SAVE_INNER | Inner save loop after OPEN+WRITE. |
| `$F69B` | SAVING | "SAVING <name>" message. |
| `$EEB1` | CIOUT | Byte to bus. |
| `$ED36` | ISOUR | Inner serial-out handshake. |
| `$EDB9` | UNLSN | UNLISTEN at end. |
| `$F722` | CLOSE | Close-channel command. |

SAVE differs from LOAD in:

- Direction: C64 talks, drive listens (inverse of LOAD's main transfer).
- Termination: C64 sends EOI handshake before UNLISTEN (LOAD reads it from drive).
- Channel: secondary address `$01` = SAVE-PRG (auto-create + write).

## 3. Drive-side SAVE response

| Addr | Symbol | Role |
|---|---|---|
| `$C8C6` | SAVE_OPEN | DOS "save with replace" / "save new" entry. |
| `$D7B4` | OPEN_WRITE | Open file for write. |
| `$D9A0` | WRTAB | Write to active buffer + flush sector when full. |
| `$D9E3` | WRTBLK | Sector-write job dispatch. |
| `$EF93` | BAM_ALLOC | Allocate next free sector in BAM. |
| `$EEFF` | DIR_WRITE | Insert directory entry. |
| `$F50A` | WRITE_HEADER | Write sector header (sync + ID). |
| `$F56E` | WRITE_DATA | Write sector data block (GCR-encode + serialise). |
| `$1C00` PB bit 3 | LED | (no role here, but indicator) |

GCR encode happens in drive ROM (`$F78F` GCR_ENCODE table) AND in `vice/src/drive/gcr.c` `gcr_convert_sector_to_GCR`. TS port lives in `src/runtime/headless/vice1541/gcr.ts` + `fsimage_dxx.ts`.

## 4. RFL gates (Spec 620 §2)

Order:

1. **C64 SAVE path** — `vice/src/c64/c64iec.c` already done in Spec 616. Re-check ISOUR EOI-handshake path (the bit `BIT $90 / BMI` after last byte before UNLISTEN).

2. **`vice/src/drive/iec/iec.c`** + **iecbus.c** — receive path. Already done in 616 — re-check ATN→LISTEN turnaround flag.

3. **`vice/src/drive/gcr.c`** — GCR encode entry `gcr_convert_sector_to_GCR`.
   - Diff against `src/runtime/headless/vice1541/gcr.ts`.
   - GCR table values, 4-to-5 bit nibble pairs, sync-mark insertion.
   - Codex 2026-05-18 audit verified DECODE path. ENCODE not yet re-verified.

4. **`vice/src/drive/imagecontents/fileio.c`** + **`vice/src/drive/imagecontents/d64.c`** — directory entry insert + BAM allocation.
   - Diff against `src/runtime/headless/vice1541/fsimage_dxx.ts` write path.
   - Check `vdrive_iec_write` chain.

5. **`vice/src/drive/drive_image.c`** — `drive_gcr_data_writeback`.
   - Diff against `src/runtime/headless/vice1541/driveimage.ts`.
   - Sector → image-file byte mapping. Disk-format byte layout (D64 sector ordering).

6. **VIA2d write strobe** — `byte_ready_active` direction switching.
   - Read `vice/src/drive/iecieee/via2d.c` PB bit 4 (R/W direction).
   - Diff against `src/runtime/headless/vice1541/via2d.ts`.

## 5. Step-debug recipe

Pre-checklist gate per `feedback_step_debug_for_stalls.md`:
- [ ] konkrete PC wo stall / wo wrong byte?
- [ ] konkrete polled / written memory addr?
- [ ] <30s runtime reachable?

Scenario:

1. Boot empty D64 (formatted blank). Type:
   ```
   10 PRINT "HELLO"
   SAVE "TEST",8
   ```
2. Watch SAVE complete.
3. Reset C64, mount same image, `LOAD"TEST",8`, `LIST`.
4. Expected: identical BASIC line.
5. Failure modes:
   - SAVE stalls → step-debug at C64 ISOUR or drive WRTAB.
   - SAVE completes but LOAD fails → BAM / directory entry corrupt → inspect raw D64 image bytes at track 18 sector 0+1.
   - LOAD returns garbage → GCR encode wrong → diff against VICE-saved image bytes.

## 6. Acceptance

Spec is DONE when ALL of:

1. `SAVE"<name>",8` from BASIC on blank-formatted D64 completes without stall.
2. Image inspection: BAM track 18 sector 0 allocation count = pre-save - actual_sectors_written.
3. Directory track 18 sector 1+ contains entry for `<name>` with correct first track/sector pointer.
4. `LOAD"<name>",8` post-save returns byte-identical BASIC program.
5. Image-byte diff (TS-saved vs VICE-saved with same BASIC program) = 0 differences in data sectors.
6. `npm run check:1541-fidelity` 0 FAIL.
7. No new `scripts/diag-*.mjs`.

## 7. Out of scope

- Multi-file SAVE chain (single file first).
- SAVE-with-replace `SAVE"@:<name>",8` (next iteration).
- VALIDATE / SCRATCH DOS commands.
- 1571 / 1581 / CMDHD.
- NTSC.

## 8. Tasks

| ID | Task | Agent | Depends |
|---|---|---|---|
| 617.0 | Reproduce SAVE on blank D64. Status: works / stalls / silent fail. | Opus | 616 DONE |
| 617.1 | RFL gate gcr.ts ENCODE path vs vice/src/drive/gcr.c | Sonnet | 617.0 |
| 617.2 | RFL gate fsimage_dxx.ts write path vs vice/src/drive/imagecontents/d64.c | Sonnet | 617.0 |
| 617.3 | RFL gate driveimage.ts gcr_data_writeback vs vice/src/drive/drive_image.c | Sonnet | 617.0 |
| 617.4 | RFL gate via2d.ts PB R/W direction + byte_ready_active write side vs vice/src/drive/iecieee/via2d.c | Sonnet | 617.0 |
| 617.5 | Step-debug at first failure point (scenario §5) | Opus | 617.1-617.4 |
| 617.6 | Apply minimal fix | Opus | 617.5 |
| 617.7 | Differential test: TS-encoded sector bytes == VICE-encoded sector bytes (per Spec 620 §3) | Sonnet | 617.6 |
| 617.8 | Round-trip test: SAVE → LOAD → byte-identical | Sonnet | 617.6 |
| 617.9 | Image-diff test: TS-saved vs VICE-saved blank-image | Sonnet | 617.6 |
| 617.10 | runtime:proof + fidelity check | Sonnet | 617.9 |
| 617.11 | Memory update + close spec | Sonnet | 617.10 |

## 9. References

- `specs/615-gcr-decode-fidelity.md` — decode path (DONE)
- `specs/616-kernal-load-fidelity.md` — read direction
- `specs/611-new-vice1541-side-by-side.md`
- `specs/612-1541-port-fidelity-rules.md`
- `specs/620-port-bug-forensic-doctrine.md`
- Memory: `feedback_step_debug_for_stalls.md`, `feedback_port_reading_first.md`, `feedback_c_to_ts_diff_test.md`.
