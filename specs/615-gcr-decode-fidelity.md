# Spec 615 — GCR Decode Fidelity

**Status:** OPEN (2026-05-18)
**Parent specs:** `specs/611-new-vice1541-side-by-side.md`, `specs/612-1541-port-fidelity-rules.md`, `specs/613-port-bug-forensic-doctrine.md`, `specs/614-drive-per-cycle-scheduling.md`
**Base commit:** `7f3f151` on `codex/614-drive-cycle-scheduler` (tag `spec-614-scheduler-architectural-closure`).
**Branch:** `codex/615-gcr-decode-fidelity` (stacked on `codex/614-drive-cycle-scheduler`).

## 1. Why this spec exists

Spec 614 closed the C64 ↔ Drive serial byte-handshake and the per-cycle scheduler. Observable on `codex/614-drive-cycle-scheduler` HEAD:

- ✅ C64 ↔ Drive serial byte transfer works (drive responds with status).
- ✅ Drive ATN handler + ATNA / T1 alarm (commit `378bd68`).
- ✅ Drive command parser interprets `$` / `*` filename requests.
- ❌ Drive cannot read directory sectors. `LOAD"$",8` and `LOAD"*",8,1` both return `?FILE NOT FOUND`.

Drive ROM reaches the disk-sector-read stage, then fails to find any sector header / sync mark / matching ID on the GCR bitstream. No file matches the search → error returned. Confirmed against `samples/POLARBEAR.d64` (real disk with directory).

The bug therefore sits in one or more of:

- `src/runtime/headless/vice1541/rotation.ts` — bitstream rotation / `gcr_read` / sync edge detection.
- `src/runtime/headless/vice1541/gcr.ts` — 4-byte ↔ GCR codec, `gcr_find_sync`, `gcr_decode_block`, `gcr_convert_sector_to_GCR`.
- `src/runtime/headless/vice1541/fsimage_dxx.ts` — D64 → in-memory GCR encode at attach (`gcr_convert_sector_to_GCR` driver, per-track skew, header / data block formatting).
- `src/runtime/headless/vice1541/fsimage_gcr.ts` — G64 parse + writeback half-track buffers.
- `src/runtime/headless/vice1541/driveimage.ts` — `drive_image_attach` glue, half-track repoint, `complicated_image_loaded` wiring.

## 2. Suspect priority (initial — refine after RFL)

| Prio | File | Why |
|---|---|---|
| P0 | `fsimage_dxx.ts` — `gcr_convert_sector_to_GCR` driver loop + per-track skew + header / sync / gap byte sequence | Wrong encode → drive sees garbage on disk. Most likely failure mode given POLARBEAR.d64 also fails (real disk, would work on VICE). |
| P0 | `gcr.ts` — `gcr_convert_4bytes_to_GCR`, `gcr_convert_sector_to_GCR`, `From_GCR_conv_data`, `GCR_conv_data` tables | Tables verbatim? Bit-pack order? 5-bit nibble mapping? |
| P1 | `rotation.ts` — `rotation_byte_read`, `rotation_sync_found`, `read_next_bit`, byte-ready edge generation | If the encode is right but rotation produces wrong byte boundaries, drive sees scrambled bytes. |
| P1 | `rotation.ts` — fidelity gap (audit found 17 of ~20 VICE rotation.c functions exported) | Missing `rotation_do_wobble`, `rotation_1541_gcr` separation, `rotation_1541_simple`, `rotation_1541_simple_cycle`? Confirm + port if missing. |
| P2 | `driveimage.ts` — `drive_image_attach` GCR wiring | If `drv.gcr` is the wrong allocation or repointed wrong, drive reads the wrong buffer. |
| P2 | `fsimage_gcr.ts` — G64 parse | G64 not on the LOAD"$",8 path against POLARBEAR.d64 (D64). Only matters for separate G64 LOAD tests. |

## 3. Investigation plan

### 3.1. RFL gate — Spec 613 §2

Before any trace / step-debug:

1. Read `vice/src/gcr.c` end-to-end. Diff against `src/runtime/headless/vice1541/gcr.ts`. Special attention:
   - `GCR_conv_data` + `From_GCR_conv_data` tables byte-for-byte equal.
   - `gcr_convert_4bytes_to_GCR` bit-pack order (4×8 bit → 5×8 bit GCR).
   - `gcr_convert_sector_to_GCR` per-block sequence: 5 sync bytes, header block (5 raw bytes encoded → 10 GCR), header gap, 5 sync bytes, data block (260 raw → 325 GCR), data gap.
2. Read `vice/src/diskimage/fsimage-dxx.c` `fsimage_dxx_write_half_track` + the read path that loads sectors into the GCR buffer at mount. Diff against `fsimage_dxx.ts`.
3. Read `vice/src/drive/rotation.c` `rotation_byte_read`, `rotation_sync_found`, `rotation_1541_gcr`, `rotation_1541_gcr_cycle`. Diff against `rotation.ts`. Note: the audit at base commit `7f3f151` showed only 17 exports — VICE rotation.c has more non-static functions. Identify the missing ones.

State results in chat as:
```
[RFL-CHECK <ts-file>:<focus>]
  read: [x] diff: [x] macros: [x]
  conclusion: <one sentence>
  trace reason: <why reading insufficient>  (or "n/a — bug found")
```

### 3.2. Step-debug (Spec `feedback_step_debug_for_stalls.md`)

After RFL, step the drive ROM through the first sector-read attempt against POLARBEAR.d64:

1. `runtime_monitor_breakpoint_add { pc: <drive_rom_sector_read_entry>, side: "drive" }` (VICE: `$F50A` `LED_OFF` / `$F510` `JOB_LOOP` / `$F556` controller dispatch — pick the entry that fires before the first half-track sync hunt).
2. `runtime_until` + `runtime_step_into × N` watching:
   - drive `$1C01` reads (latched GCR byte from `gcr_read`)
   - drive head halftrack
   - drive ROM PC walk through header-search loop
   - first-divergence point where drive ROM bails out (no sync / header CRC fail / ID mismatch)
3. Dump the in-memory GCR track buffer at the current halftrack. Compare a few bytes against what `gcr_convert_sector_to_GCR` SHOULD produce for the corresponding D64 sector. Manual VICE-side spot check on the same disk image.

### 3.3. First-divergence (only if step-debug inconclusive)

Spec 613.T1 (`vice1541_first_divergence`) is not yet built. Fallback: ad-hoc lockstep — capture VICE drive `cpuhistory` for the same POLARBEAR.d64 LOAD"$",8 scenario into the trace store, and our drive `cpuhistory`. SQL-join on drive `cycle`, find first PC divergence inside the sector-read region. One record, no buckets (Spec 613 §5+§6).

VICE side-by-side trace capture only if step-debug + RFL fail to localise.

## 4. Acceptance

Spec is DONE when ALL of:

1. `LOAD"$",8` against `samples/POLARBEAR.d64` shows the disk's directory listing on screen (real filenames, not `?FILE NOT FOUND`).
2. `LOAD"<first-prg-name>",8,1` against POLARBEAR.d64 transfers bytes into c64 RAM (verify by reading `$801..$80F` post-load and matching the D64 raw sector bytes).
3. The 6-game screenshot tests (`feedback_game_screenshot_test_set.md`) — `motm`, `MM`, `IM2`, `LNR`, `Scramble`, `Pawn` — pass in `drive1541="vice"` mode with their canonical in-game visual assertion.
4. `npm run runtime:proof` ≥ LEGACY1541 baseline (`5/7` GREEN per `specs/601-baseline-truth-table.md`) when `drive1541Implementation="vice"`.
5. `npm run check:1541-fidelity` 0 FAIL.
6. Spec 612 FC-7 amendment + PL-11 amendment land in this branch if not already on `codex/612`. Re-run scan, all hits classified.

## 5. Cleanup (mandatory before any new debug script lands)

The base commit `7f3f151` carries **20 `scripts/diag-614-*.mjs`** files. These are the exact anti-pattern that memory `feedback_trace_into_duckdb.md` forbids: one-off JSONL / state-dump scripts that should have routed through the trace store + DuckDB. They were tolerated during Spec 614 emergency debugging; they MUST NOT proliferate.

**Cleanup task (Spec 615.0 — runs FIRST):**

- `git mv scripts/diag-614-*.mjs scripts/_quarantine_diag_614/` (preserve history) OR `git rm` them entirely.
- If any single diag script captured a finding worth preserving as a regression test → port to `tests/vice1541-diff/` or `tests/spec-615/` proper test file with assertions. Otherwise drop.
- New debug primitives are written ONLY as:
  - `runtime_monitor_*` MCP tool calls in chat (step-debug — `feedback_step_debug_for_stalls.md`),
  - or `trace_store_query` SQL against DuckDB (`feedback_trace_into_duckdb.md`),
  - or proper test files under `tests/` with assertions.
- Commit: `Spec 615.0 — diag-614 quarantine / removal (no more one-off scripts)`.

## 6. Out of scope

- G64-specific bugs (only D64-attach + D64-encode path on the LOAD"$",8 critical path for POLARBEAR.d64).
- Write-back path (`drive_gcr_data_writeback`) — read-only LOAD$ tests acceptance.
- P64 — stays explicit throwing stub per memory `feedback_p64_stubs_ok.md`.
- 1571 / 1581 / CMDHD / 2000 / 4000 — separate specs.
- NTSC — PAL first per `feedback_pal_first_ntsc_later.md`.
- JiffyDOS / burst-mode — `iec-fast.ts` stays stub per Spec 422.
- Spec 612 plumbing (T2.10 / T2.13 / T2.14 / T0.2 / T3.1) — those land on `codex/612-vice-side-by-side` in parallel.
- New diag scripts — see §5.

## 7. Tasks

| ID | Task | Agent | Depends |
|---|---|---|---|
| 615.0 | Cleanup `scripts/diag-614-*.mjs` (quarantine or delete) | Sonnet | none |
| 615.1 | RFL gate on `gcr.ts` vs `vice/src/gcr.c` | Sonnet | 615.0 |
| 615.2 | RFL gate on `fsimage_dxx.ts` D64-encode path vs `vice/src/diskimage/fsimage-dxx.c` | Sonnet | 615.0 |
| 615.3 | RFL gate on `rotation.ts` vs `vice/src/drive/rotation.c` (identify missing exports vs VICE non-static fn list) | Sonnet | 615.0 |
| 615.4 | Step-debug LOAD"$",8 against POLARBEAR.d64 — first drive-side divergence | Opus | 615.1-3 |
| 615.5 | Apply fix (file + scope determined by 615.4) | Opus | 615.4 |
| 615.6 | Verify acceptance §4 #1–#5 | Sonnet | 615.5 |
| 615.7 | Memory update + commit messages cite rule numbers + spec phase | Sonnet | 615.6 |

## 8. References

- `specs/611-new-vice1541-side-by-side.md` — side-by-side architecture.
- `specs/612-1541-port-fidelity-rules.md` — NL / PL / FC rules (esp. PL-11, FC-7 amendments).
- `specs/613-port-bug-forensic-doctrine.md` — RFL gate, taxonomy, first-divergence shape.
- `specs/614-drive-per-cycle-scheduling.md` — base / dependency.
- Memory: `feedback_port_reading_first.md`, `feedback_step_debug_for_stalls.md`, `feedback_trace_into_duckdb.md`, `feedback_trace_step_not_stats.md`, `feedback_c_to_ts_diff_test.md`, `feedback_screenshot_gate_mandatory.md`, `feedback_game_screenshot_test_set.md`, `feedback_vice_no_alternatives.md`.
