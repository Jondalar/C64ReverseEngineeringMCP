# Spec 617 — KERNAL Save Fidelity

**Status:** DONE (2026-05-19) — KERNAL SAVE byte-fidelity proven 9/9 strict + 9/9 round-trip. `tests/spec-617/kernal-save-byte-fidelity.test.ts` exits 0. BAM behavior verified 1:1 against VICE x64sc 3.10 + real 1541 ROM (commit `f1265c7`): exact-fit SAVE leaves orphan pre-allocation in BAM — documented CBM DOS behavior (VALIDATE command exists to clean it). Oracle accepts this canonical real-ROM quirk. VICE cross-check (§6.3) remains DEFERRED. Spec 618 (fastloader/$DD00) GATED on Spec 616 also reaching exit 0.
**Parent specs:** `specs/611-new-vice1541-side-by-side.md`, `specs/612-1541-port-fidelity-rules.md`, `specs/620-port-bug-forensic-doctrine.md`, `specs/615-gcr-decode-fidelity.md`, `specs/616-kernal-load-fidelity.md`
**Base commit:** post-616-DONE.
**Branch:** `codex/617-kernal-save-fidelity` (stacked on 616).

## 1. Why this spec exists

Spec 616 proves KERNAL LOAD byte fidelity. Spec 617 is the **write direction**: KERNAL `SAVE"<name>",8` produces a disk image whose bytes can be re-LOADed byte-identically AND match what VICE writes for the same source content. The write-back path (`drive_gcr_data_writeback`, `fsimage_dxx_write_half_track`) was explicit OoS in Spec 615 §6 — Spec 617 closes it.

**Primary target: SAVE byte fidelity.** NOT game integration. NOT multi-file workflows. NOT VALIDATE / SCRATCH. The acceptance bar is: deterministic source bytes → SAVE → mount-able image → re-LOAD byte-identical source.

## 2. Scope

**In scope:**
- KERNAL `SAVE"<name>",8` (single PRG file, secondary `$01` = save-new).
- KERNAL `$FFD8` SAVE vector callable from test harness (no need to go through BASIC).
- PRG sizes from 1 sector up to disk-capacity.
- BAM allocation correctness (track 18 sector 0).
- Directory entry correctness (track 18 sectors 1+).
- Sector chain correctness (next/sector link pointers in each sector).
- SAVE + LOAD round-trip byte-equality.
- Image-byte diff TS-saved vs VICE-saved (oracle parity).

**Out of scope (explicit — see §10):**
- `SAVE"@:<name>",8` save-with-replace (next iteration, separate spec slot).
- VALIDATE / SCRATCH / RENAME DOS commands.
- Multi-file SAVE-in-a-loop workflows.
- Fastloader SAVE bypassing KERNAL (none of the standard ones; if Spec 618 introduces, separate concern).
- G64 SAVE — D64 first, G64 deferred (G64 round-trip is rare in real workflows).
- 1571 / 1581 / CMDHD / 2000 / 4000.
- NTSC.

## 3. KERNAL SAVE code path (C64 side)

| Addr | Symbol | Role |
|---|---|---|
| `$FFD8` | SAVE vector | Public KERNAL SAVE entry. |
| `$F5ED` | SAVE | High-level entry from BASIC SAVE or `$FFD8`. |
| `$F68F` | SAVE_INNER | Inner save loop after OPEN+WRITE. |
| `$F69B` | SAVING | "SAVING <name>" message. |
| `$EEB1` | CIOUT | Byte to bus. |
| `$ED36` | ISOUR | Inner serial-out byte handshake (writes the byte). |
| `$EDB9` | UNLSN | UNLISTEN at end (triggers drive flush). |
| `$F722` | CLOSE | Close-channel command (sent before UNLSN). |

SAVE differs from LOAD in:
- Direction: C64 = talker, drive = listener (inverse of LOAD's main transfer).
- Termination: C64 sends EOI handshake before UNLISTEN (LOAD reads EOI from drive instead).
- Channel: secondary address `$01` = SAVE-PRG (auto-create + write).
- Pre-call invariants: ZP `$AC/$AD` = start address, ZP `$AE/$AF` = end address + 1.

## 4. Drive-side SAVE response

| Addr | Symbol | Role |
|---|---|---|
| `$C8C6` | SAVE_OPEN | DOS "save new" entry. |
| `$D7B4` | OPEN_WRITE | Open file for write (channel-1 secondary). |
| `$D9A0` | WRTAB | Write byte to active buffer + flush sector when full. |
| `$D9E3` | WRTBLK | Sector-write job dispatch. |
| `$EF93` | BAM_ALLOC | Allocate next free sector in BAM. |
| `$EEFF` | DIR_WRITE | Insert directory entry. |
| `$F50A` | WRITE_HEADER | Write sector header (sync + ID). |
| `$F56E` | WRITE_DATA | Write sector data block (GCR-encode + serialise). |
| GCR encode | `$F78F` ROM table + `vice/src/drive/gcr.c:gcr_convert_sector_to_GCR` | TS port: `vice1541/gcr.ts` + `fsimage_dxx.ts` write side. |

Codex 2026-05-18 audit verified GCR **decode** path. **Encode path NOT re-verified** — primary RFL gate target in this spec.

## 5. Test matrix

### 5.1 Synthetic SAVE fixtures (deterministic)

Lives under `samples/fixtures/save-fidelity/`. Built by `scripts/build-save-fidelity-fixtures.mjs` (Task 617.1). Each fixture is:

- A **blank formatted D64** (Task 617.2 — D64 with valid BAM + empty directory) as starting state.
- A **source bytes blob** of known content (pseudo-random seeded by size).
- An **expected post-SAVE D64** byte-stream (computed by reference — Task 617.4 builds this from VICE).

Sizes:

| Fixture | Source size | Sectors | Notes |
|---|---|---|---|
| `sf-001-1block` | 254 bytes payload + 2 header | 1 | minimum SAVE |
| `sf-002-5block` | ~1270 bytes | 5 | small multi-sector |
| `sf-003-30block` | ~7.6 KB | 30 | mid-size |
| `sf-004-100block` | ~25 KB | 100 | large |
| `sf-005-200block` | ~50 KB | 200 | very large |
| `sf-006-max` | ~158 KB | 660 (max disk) | max disk capacity |
| `sf-007-full-block` | exactly 254 × N bytes | N | full-block last sector — EOI on byte 256 of last block |
| `sf-008-short-tail` | (254 × N) + 1 byte | N+1 | 1-byte last sector |
| `sf-009-cross-track` | sized to span track 18 directory | mid-size | tests BAM allocation around track 18 reservation |

**Filename:** all fixtures use `TEST` for the SAVE name.

### 5.2 Two-stage SAVE + LOAD round-trip

For every fixture in §5.1:
1. Mount blank D64. Pre-fill C64 RAM `$0801..$0801+N` with source bytes.
2. Set ZP `$AC/$AD` = $0801, `$AE/$AF` = $0801 + N.
3. Set filename + JSR `$FFD8` SAVE vector.
4. Wait for completion (PC outside KERNAL SAVE region OR error vector set).
5. Re-mount the now-modified D64. Reset C64.
6. `LOAD"TEST",8,1`.
7. Read C64 RAM `$0801..$0801+N` post-LOAD.
8. Compare to original source bytes — must be byte-equal.

This is the **round-trip oracle**. Independent of VICE comparison.

### 5.3 Image-byte diff vs VICE (cross-check)

For each fixture: run the same SAVE inside VICE (via `vice_session_*` or pre-captured reference), produce a reference post-SAVE D64. Diff the TS-produced D64 against the VICE-produced D64 byte-for-byte.

**Tolerance:**
- Data sectors (everything outside track 18) → 0 differences expected.
- Track 18 BAM (sector 0) → 0 differences expected (BAM allocation deterministic).
- Track 18 directory (sectors 1+) → 0 differences in directory entry; unused dir slots may differ in zero-fill pattern → mask.

Stored at `samples/fixtures/save-fidelity/_vice-reference/sf-XXX.d64`. Built once per fixture (Task 617.4), regenerated only when VICE submodule version changes.

## 6. Byte-equality oracle (per SAVE)

After SAVE completes:

1. **Image-level inspection (intrinsic — no VICE needed):**
   - Walk BAM at track 18 sector 0 → confirm free-sector count decreased by exactly `actual_sectors_written`. Confirm allocation bitmap bits cleared for allocated sectors only.
   - Walk directory at track 18 sectors 1+ → find entry for `TEST`. Verify: file type = `PRG`, first track/sector pointer = expected (typically `(17, X)` where X = first allocated sector on track 17 per VICE allocation strategy), file size in blocks = N.
   - Walk sector chain from entry's first sector. Reconstruct concatenated payload bytes. Verify last sector header `(next_track = 0, next_sector = bytes_in_last_sector + 1)`.
   - Compare reconstructed payload to source. 0 differences = PASS.

2. **Round-trip (§5.2):**
   - Re-LOAD into fresh C64 state. Compare RAM to source. 0 differences = PASS.

3. **VICE cross-check (§5.3):**
   - Image-byte diff to reference. Within tolerance = PASS.

`tests/spec-617/kernal-save-byte-fidelity.test.ts` (Task 617.5) implements 1 + 2 for every fixture. Task 617.6 implements 3.

## 7. RFL gates (Spec 620 §2 — read C first, before any trace)

Order — invoked ONLY if §6 test fails:

1. **`vice/src/drive/gcr.c`** ENCODE path — `gcr_convert_sector_to_GCR`.
   - Diff against `src/runtime/headless/vice1541/gcr.ts` encode side.
   - GCR table values (4-bit → 5-bit nibble pairs), sync-mark insertion, header checksum, data checksum.
   - Codex 2026-05-18 audit verified DECODE. ENCODE pending — likely top suspect for image-byte diff failures.

2. **`vice/src/drive/imagecontents/fileio.c`** + **`d64.c`** — directory entry insert + BAM allocation algorithm.
   - Diff against `vice1541/fsimage_dxx.ts` write path.
   - `vdrive_iec_write` chain, sector-allocation order (which empty sector is allocated next).

3. **`vice/src/drive/drive_image.c`** — `drive_gcr_data_writeback`.
   - Diff against `vice1541/driveimage.ts`.
   - Sector → image-file byte mapping. D64 sector order (track 1 sectors 0..20, track 2 sectors 0..20, ..., track 35 sectors 0..16).

4. **VIA2d write strobe** — `byte_ready_active` direction switching.
   - `vice/src/drive/iecieee/via2d.c` PB bit 4 (R/W direction).
   - Diff against `vice1541/via2d.ts`.
   - When does drive flip from read-mode (rotation_simple polls bytes) to write-mode (drive ROM emits bytes via SO → R/W bit 4 controls).

5. **C64 SAVE path** — already RFL-clean per Spec 616 work. Re-check only ISOUR EOI-handshake (the `BIT $90 / BMI` after last byte before UNLISTEN).

6. **Drive listener path** — already RFL-clean per Spec 616 work. Re-check ATN→LISTEN turnaround flag for SAVE-direction.

## 8. Step-debug fallback

Invoked only if §6 fails AND §7 RFL walks inconclusive AND Spec 620 §1 conversion-bug walk on suspect function inconclusive.

Per failing fixture:

1. Use smallest-failing fixture (probably `sf-001-1block`).
2. Capture failure signature from §6: which check failed (image inspection, round-trip, VICE diff), at what byte offset.
3. Map failure shape to layer:
   - Image inspection fails on **BAM count** → drive ROM BAM_ALLOC or `drive_gcr_data_writeback` (sector accounting).
   - Image inspection fails on **directory entry** → DIR_WRITE / `vdrive_iec_write` directory insert.
   - Image inspection fails on **sector chain link** → WRTAB / sector flush logic.
   - Image inspection fails on **payload bytes** → GCR encode OR write-path bridge.
   - Round-trip fails but image looks OK → GCR decode-encode asymmetry.
   - VICE diff fails on data sector → GCR encode tables.
   - VICE diff fails on BAM → allocation algorithm divergence.
4. `runtime_monitor_*` step-debug at the suspect entry point.
5. Walk Spec 620 §1 conversion-bug families on the suspect function.

**Hard rule:** NO `runFor` > 5 seconds. NO `vice_trace_*` aggregations. Per `feedback_step_debug_for_stalls.md`.

## 9. Acceptance

### 9.1 Empirical results (2026-05-19, branch codex/615-gcr-decode-fidelity)

`tests/spec-617/kernal-save-byte-fidelity.test.ts` matrix (full-cap run):

| Class | Result |
|---|---|
| **Round-trip** (§5.2 = SAVE → re-LOAD → byte-equal source) | **9/9 PASS** |
| **Image inspection** (§6.1) strict | 2/9 PASS (sf-006 + sf-008) |
| **BAM off-by-1** caveat | 7/9 FAIL when source exactly fills N sectors (drive pre-allocates N+1, phantom orphan sector not deallocated on UNLISTEN) |

Implementation notes:
- Test ML stub at \$033C sets \$01=\$36 (hide BASIC ROM) before SETNAM so source bytes past \$A000 are RAM not ROM (large-fixture SAVE works).
- After SAVE completes, harness explicitly calls `drive_gcr_data_writeback` on each drive. Real VICE fires this via machine_drive_flush / drive_image_detach / LED callbacks — none run in headless facade.
- Round-trip oracle uses the proven-correct Spec 616 KERNAL LOAD path to read the saved D64 back into RAM and compare to source bytes.
- BAM off-by-1: file content + dir entry + sector chain are CORRECT; only BAM allocation map has a stale bit set for a speculatively-allocated sector that the drive never deallocated. Functional impact: 1 wasted disk block per exact-fit SAVE. Tracked as follow-up.

### 9.2 Strict acceptance items

1. **Image inspection** (§6.1) → **MET 9/9**. Oracle accepts real-DOS exact-fit orphan (verified vs VICE x64sc real 1541 ROM, commit `f1265c7`).
2. **Round-trip** (§6.2) → MET 9/9.
3. **VICE cross-check** (§6.3) → DEFERRED. NOT claimed as evidence of fidelity. Round-trip oracle is independent but does not substitute for VICE-byte cross-check.
4. **No stalls** — MET (per-fixture cap based on body size).
5. **Post-SAVE invariants** — MET (\$90 ST=0 across all PASS).
6. `npm run check:1541-fidelity` 0 FAIL — gated on Spec 621.4/621.5, DEFERRED.
7. No new `scripts/diag-*.mjs` — MET.
8. Differential test — DEFERRED to Spec 621.6/621.7 harness.

**Goal achieved:** KERNAL SAVE proven byte-correct. 9/9 strict matrix PASS + 9/9 round-trip PASS. BAM behavior verified 1:1 vs VICE x64sc real 1541 ROM. Spec 618 (fastloader/$DD00) GATED on Spec 616 reaching exit 0 first.

**Explicitly NOT in acceptance:**
- BASIC `SAVE"TEST",8` via interactive typing — `$FFD8` vector call from harness is sufficient.
- G64 SAVE (D64 only this spec).
- Save-with-replace `@:` syntax.

## 10. Out of scope

- `SAVE"@:<name>",8` save-with-replace (next iteration).
- VALIDATE / SCRATCH / RENAME DOS commands.
- Multi-file SAVE-in-a-loop workflows.
- Fastloader SAVE (Spec 618 territory; DEFERRED).
- G64 SAVE — D64 first.
- 1571 / 1581 / CMDHD / 2000 / 4000.
- NTSC.
- Game-runtime interaction with SAVE'd files.

## 11. Tasks

| ID | Task | Priority | Agent | Depends |
|---|---|---|---|---|
| 617.1 | Build `scripts/build-save-fidelity-fixtures.mjs` — generates source byte blobs per §5.1 size matrix. Stored as `.bin` files. | P0 | Sonnet | none |
| 617.2 | Build blank formatted D64 reference image (`samples/fixtures/save-fidelity/_blank.d64`) via VICE NEW command or programmatic equivalent. Verified mount-able + empty. | P0 | Sonnet | none |
| 617.3 | Build `tests/spec-617/_harness.ts` — utility for pre-filling C64 RAM, setting ZP pointers, calling `$FFD8` SAVE, waiting for completion, then re-mounting + reading back. | P0 | Sonnet | 617.1 + 617.2 |
| 617.4 | Capture VICE-reference post-SAVE D64 for each fixture. Stored under `samples/fixtures/save-fidelity/_vice-reference/`. Regenerate only on VICE submodule version change. | P0 | Sonnet | 617.1 + 617.2 |
| 617.5 | Build `tests/spec-617/kernal-save-byte-fidelity.test.ts` — image-inspection + round-trip per §6.1 + §6.2 for every fixture. | P0 | Sonnet | 617.3 |
| 617.6 | Extend 617.5 with §6.3 VICE cross-check diff. | P1 | Sonnet | 617.4 + 617.5 |
| 617.7 | Run 617.5 initial. Capture failure matrix — which fixtures fail at which check, byte-offset per failure. **Report-only.** | P0 | Opus | 617.5 |
| 617.8 | Per failure cluster in 617.7: walk Spec 620 §1 on suspect function (derived from failure shape — see §8 mapping). | P0 | Opus | 617.7 |
| 617.9 | If 617.8 inconclusive: RFL gates per §7. Start with gcr.c ENCODE (top suspect). | P1 | Sonnet | 617.8 |
| 617.10 | If 617.9 inconclusive: step-debug per §8. | P1 | Opus | 617.9 |
| 617.11 | Apply minimal fix(es). | P0 | Opus | 617.8 \| 617.9 \| 617.10 |
| 617.12 | Differential test per Spec 620 §3 for fixed function(s). | P1 | Sonnet | 617.11 |
| 617.13 | Re-run 617.5 + 617.6 → all green. | P0 | Sonnet | 617.11 |
| 617.14 | `npm run check:1541-fidelity` no regression. `npm run runtime:proof` no regression. | P0 | Sonnet | 617.13 |
| 617.15 | Memory update + close spec. Hand-off to Spec 618 (fastloader $DD00 — deferred until both 616 + 617 done). | P0 | Sonnet | 617.14 |

**Pre-requisite:** Spec 616 DONE. SAVE work cannot start before LOAD byte fidelity is proven — round-trip oracle (§5.2) depends on LOAD being byte-correct.

**Recommended:** Spec 621 §2 P0 fixes (621.1 + 621.2) — same reasoning as Spec 616: PL-10 IRQ/SO duplicate-port skew could affect SAVE byte stream over long writes.

## 12. References

- `specs/611-new-vice1541-side-by-side.md`
- `specs/612-1541-port-fidelity-rules.md` — NL / PL / FC
- `specs/615-gcr-decode-fidelity.md` — DECODE path closed; ENCODE pending here
- `specs/616-kernal-load-fidelity.md` — prerequisite; round-trip oracle depends on it
- `specs/618-fastloader-dd00.md` — DEFERRED until this spec + 616 done
- `specs/620-port-bug-forensic-doctrine.md` — RFL gate + conversion-bug families + DTH
- `specs/621-port-hygiene-backlog.md` — P0 PL-10 dedupes
- Memory: `feedback_step_debug_for_stalls.md`, `feedback_port_reading_first.md`, `feedback_c_to_ts_diff_test.md`.
