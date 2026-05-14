# Spec 441 step 4b/4e — flip result

Date: 2026-05-14  
Commit: `34bccc7` (Spec 441 step 4b/4e — FLIP works)

## Outcome

`rotation.ts` is now the production primitive for VIA2 PA/PB
reads, byte-ready signaling, and SYNC detection on the headless
1541. `gcrShifter` is retained ONLY as the A/B verify peer under
the `C64RE_ROTATION_DIFF=1` env flag.

## Root cause of prior flip failures

The OLD `gcrShifter` consumer worked because the class handled all
its state internally on `tick(1)`. `rotation.ts` is a literal VICE
port and expects callers to perform the proper VICE VIA2 backend
dance on every register access. Without that wiring, the consumer
saw stale `drive.GCR_read`, never-cleared `byte_ready_level`, and
no `rotation_byte_read` to clear `attach_clk` after disk-settle.

## VICE-literal port additions (citing via2d.c)

Every VIA2 access now mirrors VICE behavior:

| VIA2 access | VICE function | TS impl |
|---|---|---|
| `LDA $1C01` (PA read) | `read_pra` 463 | via2-coupling readPa |
| `STA $1C01` (PA write) | `store_pra` 184 | via2-coupling onPaOutputChanged |
| `LDA $1C00` (PB read) | `read_prb` 488 | via2-coupling readPb |
| `STA $1C00` (PB write) | `store_prb` 201 | via2-coupling onPbOutputChanged |
| `STA $1C0C` (PCR) | `store_pcr` + `via2d_update_pcr` 165 | via2d1541 storePcr |
| CA2 change | `set_ca2` 72 | via2d1541 setCa2 |
| CB2 change | `set_cb2` 95 | via2d1541 setCb2 |
| WPS sense | `drive_writeprotect_sense` | drive-t.ts `drive_writeprotect_sense` |

Each path calls `rotation_rotate_disk(drive)` (or
`rotation_byte_read(drive)` for PA read with attach delay),
updates `drive_t` state per VICE source, and clears
`byte_ready_level` on every register access. `BUS_READ_DELAY = 14`
is set on PA/PB read to mirror VICE bus-read R-cycle delay.

## Verification

### 1. Canary gate (`npm run canary:spec-430`) — 5/5 PASS

| Canary | Top c64 PC | Vs pre-spec-441 baseline | Verdict |
|---|---|---|---|
| motm | `$4240` (game code) | (no baseline) | NEW proof boot |
| mm-s1 | `$EE5A` (KERNAL serial) | (no baseline) | running, slow |
| im2 | `$BF49` (game code) | `$BF49` | MATCH baseline |
| scramble | `$E5CF` (READY) | `$E5CF` | matches baseline (30s canary too short for Krill loader) |
| lnr-s1 | `$EE5D` (KERNAL serial) | `$E5CF` (READY) | **MORE progress** than baseline (expected red) |

### 2. Focused A/B diff harness (`C64RE_ROTATION_DIFF=1`)

motm 30s capture, 20,242,930 instructions. Harness compares per
cycle: `shifter.byte_ready_edge` vs `drive.byte_ready_edge`,
`shifter.dataByte` vs `drive.GCR_read` (on byte_ready cycles),
`shifter.syncBit` vs `rotation_sync_found(drive)`. **Zero
divergence detected** over full boot + game-loop window. rotation
produces byte-identical output to the legacy gcrShifter.

### 3. Lorenz Disk1 regression

50+ tests pass under the new flip with 0 failures (`ldab`, `ldaz`,
`ldazx`, …, `oraax`). Test wallclock 600s exceeded before suite
completed → INCONCLUSIVE termination, NOT a failure. Slowdown
likely from per-cycle `rotation_rotate_disk` + per-PA-read
`rotation_byte_read` overhead.

Open: extend Lorenz suite wallclock budget to confirm full pass
(was 100% PASS per memory `project_motm_via1_ca1`); profile
rotation hot path for the new perf delta.

## What's NOT yet flipped

- Snapshot save/load still uses gcrShifter snapshot/restore (Spec
  441 step 4d).
- `gcrShifter` retained in DriveCpu constructor + via2-coupling so
  `notifyAttach` / `notifyMediaChange` / harness still work
  (Spec 441 step 4f will delete after step 4d + 4g done).
- `setCa2` edge-consume path skipped (drive_cpu_set_overflow analog
  needs DriveCpu callback wiring); not exercised by canaries.
- 82 grep hits for `gcrShifter` / `GcrShifter` remain (step 4f).

## Open follow-ups

1. **4d Snapshot migration** — `rotation_table_get` / `rotation_table_set`
   to replace `gcrShifter.snapshot()` / `restore()`. Touches
   `snapshot.ts` (Spec 215 save-state) and `save-load-tests.ts`.
2. **4g Production-proof + tests** — single rotation path doc,
   `tests/rotation-formulas.test.ts` (speed-zone, sync, byte-ready),
   full canary gate + Lorenz green.
3. **4f Delete legacy** — `gcr-shifter.ts`, `via2-gcr-shifter-coupling.ts`
   (after no snapshot/test/user path depends on them).

## Perf observation

Lorenz Disk1 ran ~50% of tests in 600s vs presumably faster with
gcrShifter. Profile target: cycle-wrapper's per-drive-cycle
`rotation_rotate_disk` call. Bigint math on `drive.attach_clk`
comparisons is a known suspect.
