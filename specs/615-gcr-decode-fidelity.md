# Spec 615 — GCR Decode Fidelity

**Status:** OPEN (2026-05-18)
**Parent specs:** `specs/611-new-vice1541-side-by-side.md`, `specs/612-1541-port-fidelity-rules.md`, `specs/620-port-bug-forensic-doctrine.md`, `specs/614-drive-per-cycle-scheduling.md`
**Base commit:** `7f3f151` on `codex/614-drive-cycle-scheduler` (tag `spec-614-scheduler-architectural-closure`).
**Branch:** `codex/615-gcr-decode-fidelity` (stacked on `codex/614-drive-cycle-scheduler`).

> **Update 2026-05-18: see §9 Post-Mortem — root cause was legacy
> provider, not port.**

## 1. Why this spec exists

Spec 614 closed the C64 ↔ Drive serial byte-handshake and the per-cycle scheduler. Observable on `codex/614-drive-cycle-scheduler` HEAD:

- ✅ C64 ↔ Drive serial byte transfer works (drive responds with status).
- ✅ Drive ATN handler + ATNA / T1 alarm (commit `378bd68`).
- ✅ Drive command parser interprets `$` / `*` filename requests.
- ❌ Drive cannot read directory sectors. `LOAD"$",8` and `LOAD"*",8,1` both return `?FILE NOT FOUND`.

### 2026-05-18 Codex audit refines diagnose

Initial hypothesis "GCR codec broken" is **NOT supported by evidence**. Codex audit run against VICE found:

- `fsimage_read_dxx_image()` + `gcr_read_sector()` decode POLARBEAR.d64 directly. Track 18 / sectors 0 + 1 return `CBMDOS_FDC_ERR_OK`. → **GCR sectors in the image are decodable. `gcr.ts` + `fsimage_dxx.ts` encode/decode are functional.**
- For D64, VICE does NOT use the complicated G64 rotation path. D64 → `complicated_image_loaded = 0` → runtime read goes through `rotation_1541_simple()`, **NOT** `gcr_read_sector()`. The static test path (works) and the runtime path (broken) are **different code paths**.
- Drive head sits at halftrack 37 / GCR slot 35 after boot. Directory track 18 = halftrack 36 / slot 34. Off-by-one. NOT just a single HT-fix — symptom of broader stepper / attach init wrong.
- **Shadow `drive_set_half_track` lives in `driveimage.ts`** as a local minimal version while the full port exists in `drive.ts`. Same bug-class as the `drive_cpu_set_overflow` shadow fixed in commit `5744cd6` (Spec 612 FC-7 P0). Third occurrence of the shadow-stub pattern in `vice1541/`-internal scope.
- `fsimage_dxx.ts` stubs `drive_get_disk_drive_type → 0` while real impl exists in `drive.ts:844`. Shadow. Probably not the LOAD$ blocker but PL-10 violation.

### Real bug location

The bug sits between **head/track selection, VIA2 stepper/motor writes, `rotation_1541_simple` byte stream, and byte-ready / overflow flag interaction** — NOT in the GCR codec. Relevant files (in priority order — see §2):

- `src/runtime/headless/vice1541/rotation.ts` — `rotation_1541_simple` runtime byte stream.
- `src/runtime/headless/vice1541/via2d.ts` — VIA2 PB stepper / motor / speed-zone writes.
- `src/runtime/headless/vice1541/drive.ts` — `drive_set_half_track` full port.
- `src/runtime/headless/vice1541/driveimage.ts` — `drive_image_attach` call-chain + local shadow `drive_set_half_track` to be removed.

VICE references:

- `vice/src/drive/rotation.c` (`rotation_1541_simple`, `rotation_rotate_disk` D64 branch)
- `vice/src/drive/iecieee/via2d.c` (stepper / motor / SO)
- `vice/src/drive/drive.c` (`drive_set_half_track`, `drive_move_head`)
- `vice/src/drive/driveimage.c` (`drive_image_attach` invokes `drive_set_half_track` from drive.c)

## 2. Suspect priority (2026-05-18 update per Codex audit)

| Prio | File | Why |
|---|---|---|
| **P0** | `rotation.ts` — `rotation_1541_simple` D64 runtime byte stream | Runtime path for D64 (`complicated_image_loaded=0`). NOT exercised by the codex-verified static `gcr_read_sector` test. Suspect #1. |
| **P0** | `driveimage.ts` shadow `drive_set_half_track` — local minimal stub | Real impl in `drive.ts:1xxx`. `drive_image_attach` likely calls the local shadow instead of the full version → wrong halftrack repoint / GCR_track_start_ptr / GCR_current_track_size after attach. PL-10 violation, identical pattern to the via2d.ts `drive_cpu_set_overflow` shadow already fixed. |
| **P0** | `drive_image_attach` call-chain — `current_half_track` / `side` / `GCR_track_start_ptr` / `GCR_current_track_size` init | Off-by-one HT37 vs expected HT36 = init bug. Check VICE driveimage.c sequence verbatim. |
| **P1** | `via2d.ts` — VIA2 PB stepper / motor / speed-zone writes | If stepper writes are wrong, head ends up at wrong HT. Codex flagged this layer. |
| **P1** | `rotation.ts` — `byte_ready_edge` / `byte_ready_level` / overflow (SO) flag interaction | Drive ROM uses BVS/BVC on SO to detect byte-ready. Wrong edge timing → drive misses bytes during the simple-rotation runtime path. |
| **P2** | `fsimage_dxx.ts` shadow `drive_get_disk_drive_type → 0` | Probably not LOAD$ blocker but same PL-10 pattern, fix opportunistically. |
| **CLEARED** | `gcr.ts`, `fsimage_dxx.ts` encode path | Codex audit verified `gcr_read_sector` works on POLARBEAR.d64. Do NOT spend RFL cycles here. |

## 3. Investigation plan (2026-05-18 — Codex-refined)

GCR-codec RFL is SKIPPED — Codex audit cleared `gcr.ts` + `fsimage_dxx.ts` encode path by direct call to `gcr_read_sector` on POLARBEAR.d64. Focus is the D64 **runtime** read path.

### 3.1. Shadow-stub sweep (FIRST — same bug-class struck 3× now)

Re-run the PL-10 / FC-7 audit but with scope `src/runtime/headless/vice1541/*.ts` (intra-directory shadows), not just the kernel-side scope from 2026-05-18.

Look for: same function name (snake_case) exported from ≥2 vice1541 files where ≥1 body is a stub / minimal / return-only.

Already-known hits (port + remove):
- `driveimage.ts` `drive_set_half_track` — minimal shadow; real impl `drive.ts`.
- `fsimage_dxx.ts` `drive_get_disk_drive_type` — returns 0 shadow; real impl `drive.ts:844`.

Action per hit:
- Remove shadow.
- Import from the file that owns the full port.
- Verify caller-site (`drive_image_attach` etc.) gets the full impl.
- Commit each fix separately, cite Spec 612 PL-10 + amendment FC-7.

### 3.2. RFL gates — runtime D64 path (Spec 620 §2)

After 3.1. Order:

1. **`drive.ts` `drive_set_half_track` + `drive_move_head`** vs `vice/src/drive/drive.c`.
   - Halftrack invariants: `current_half_track`, `max_half_track`, `GCR_track_start_ptr`, `GCR_current_track_size`.
   - Compare against VICE drive.c verbatim. Does TS set ALL the same fields in the same order?

2. **`driveimage.ts` `drive_image_attach`** vs `vice/src/drive/driveimage.c`.
   - Sequence: log → P64/GCR alloc → `drive_set_half_track(36, 0, drv)` at line ~? → `complicated_image_loaded` set.
   - For D64: must set `complicated_image_loaded = 0` (Codex finding — drives simple-rotation path).

3. **`rotation.ts` `rotation_1541_simple`** + `rotation_1541_simple_cycle` (or `rotation_rotate_disk` D64 branch) vs `vice/src/drive/rotation.c`.
   - **AUDIT FINDING**: base commit `7f3f151` exports 17 rotation fns but missing `rotation_do_wobble`, `rotation_1541_gcr` (separate from `rotate_disk`), `rotation_1541_simple`. If `rotation_1541_simple` is absent or stubbed, that IS the LOAD$ blocker by construction (Codex finding: D64 runtime uses this fn).
   - Read VICE `rotation_rotate_disk` D64 branch (the `complicated_image_loaded=0` path). Diff TS.
   - Read VICE `read_next_bit` / `write_next_bit` byte-ready edge generation. Diff TS.

4. **`via2d.ts` PB stepper / motor / speed-zone writes** vs `vice/src/drive/iecieee/via2d.c` `store_prb`.
   - Stepper bits 0-1 → `drive_move_head` invocation.
   - Motor bit 2 → `drv.byte_ready_active` toggle.
   - LED bit 3.
   - Speed-zone bits 5-6 → `rotation_speed_zone_set`.
   - SO pin (CA2 set-overflow) — Codex flag.

State per file:
```
[RFL-CHECK src/runtime/headless/vice1541/<file>:<focus>]
  read: [x] diff: [x] macros: [x]
  findings:
    - <bullet>
  verdict: clean | suspect | bug-found
```

### 3.3. Step-debug (Spec `feedback_step_debug_for_stalls.md`)

After 3.1 + 3.2. Concrete scenario for LOAD"$",8 on POLARBEAR.d64:

1. Boot + mount POLARBEAR.d64. State head halftrack BEFORE issuing LOAD.
   - Expected after attach: HT 36 (= track 18 × 2).
   - Codex observed: HT 37.
   - → Confirm with `runtime_monitor_memory` / drive ctx dump.

2. Issue LOAD"$",8. Set breakpoint at drive sector-read entry.
   - Likely `$F510` (job loop) or `$F556` (controller dispatch).
   - `runtime_monitor_breakpoint_add { pc: 0xF510, side: "drive" }`.

3. Step drive ROM through:
   - First read from `$1C01` (GCR byte latch).
   - Header-search loop.
   - Identify first PC where drive bails out.

4. At bail-out:
   - Dump `drv.current_half_track`, `drv.GCR_track_start_ptr` (which buffer?), `drv.GCR_current_track_size`.
   - Compare to what VICE would have.
   - Identify whether bug is HT-positioning, byte-stream content, or byte-ready timing.

5. Hypothesis-then-fix per finding. NO trace until step-debug exhausted.

### 3.4. First-divergence (only if 3.1-3.3 inconclusive)

Spec 620.T1 (`vice1541_first_divergence`) not yet built. Fallback: ad-hoc DuckDB SQL-join on drive `cycle` between VICE trace + our trace. ONE record (first divergence + window), not buckets (Spec 620 §5+§6). Routes through `vice_trace_runtime_start` + `trace_store_*` (memory `feedback_trace_into_duckdb.md`). NO new `scripts/diag-*.mjs`.

## 4. Acceptance

Spec is DONE when ALL of:

1. `LOAD"$",8` against `samples/POLARBEAR.d64` shows the disk's directory listing on screen (real filenames, not `?FILE NOT FOUND`).
2. `LOAD"<first-prg-name>",8,1` against POLARBEAR.d64 transfers bytes into c64 RAM (verify by reading `$801..$80F` post-load and matching the D64 raw sector bytes).
3. The 6-game screenshot tests (`feedback_game_screenshot_test_set.md`) — `motm`, `MM`, `IM2`, `LNR`, `Scramble`, `Pawn` — pass in `drive1541="vice"` mode with their canonical in-game visual assertion.
4. `npm run runtime:proof` ≥ LEGACY1541 baseline (`5/7` GREEN per `specs/_archive/601-baseline-truth-table.md`) when `drive1541Implementation="vice"`.
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

## 7. Tasks (2026-05-18 — Codex-refined)

| ID | Task | Agent | Depends |
|---|---|---|---|
| 615.0 | Cleanup `scripts/diag-614-*.mjs` (quarantine or delete) | Sonnet | none |
| 615.1 | Shadow-stub sweep intra-`vice1541/`: list all same-name multi-file exports where ≥1 is stub. Tab + verdict per hit. NO fix yet. | Sonnet | 615.0 |
| 615.2 | Fix `driveimage.ts` shadow `drive_set_half_track` (remove, import from `drive.ts`) | Sonnet | 615.1 |
| 615.3 | Fix `fsimage_dxx.ts` shadow `drive_get_disk_drive_type` (remove, import from `drive.ts:844`) | Sonnet | 615.1 |
| 615.4 | Fix all OTHER shadows found in 615.1 (one commit per fix) | Sonnet | 615.1 |
| 615.5 | RFL gate `drive.ts` `drive_set_half_track` + `drive_move_head` vs `vice/src/drive/drive.c` | Sonnet | 615.2 |
| 615.6 | RFL gate `driveimage.ts` `drive_image_attach` vs `vice/src/drive/driveimage.c` (D64 path; verify `complicated_image_loaded=0`) | Sonnet | 615.2 |
| 615.7 | RFL gate `rotation.ts` `rotation_1541_simple` + identify missing fns (`rotation_do_wobble`, `rotation_1541_gcr` split, `rotation_1541_simple_cycle`) vs `vice/src/drive/rotation.c` | Sonnet | 615.5 |
| 615.8 | Port missing rotation fns if 615.7 finds gaps | Sonnet | 615.7 |
| 615.9 | RFL gate `via2d.ts` `store_prb` stepper/motor/speed-zone/SO vs `vice/src/drive/iecieee/via2d.c` | Sonnet | 615.7 |
| 615.10 | Step-debug LOAD"$",8 against POLARBEAR.d64. Identify drive bail-out PC + HT/byte state at bail | Opus | 615.5-615.9 |
| 615.11 | Apply minimal fix (scope from 615.10) | Opus | 615.10 |
| 615.12 | Verify acceptance §4 #1–#5 | Sonnet | 615.11 |
| 615.13 | Memory update + commit messages cite rule numbers + spec phase | Sonnet | 615.12 |

## 8. References

- `specs/611-new-vice1541-side-by-side.md` — side-by-side architecture.
- `specs/612-1541-port-fidelity-rules.md` — NL / PL / FC rules (esp. PL-11, FC-7 amendments).
- `specs/620-port-bug-forensic-doctrine.md` — RFL gate, taxonomy, first-divergence shape.
- `specs/614-drive-per-cycle-scheduling.md` — base / dependency.
- Memory: `feedback_port_reading_first.md`, `feedback_step_debug_for_stalls.md`, `feedback_trace_into_duckdb.md`, `feedback_trace_step_not_stats.md`, `feedback_c_to_ts_diff_test.md`, `feedback_screenshot_gate_mandatory.md`, `feedback_game_screenshot_test_set.md`, `feedback_vice_no_alternatives.md`.

## 9. Post-Mortem (2026-05-18, after acceptance §4 #1 GREEN)

§§1-3 above narrate the diagnostic hypothesis chain that ran from
2026-05-17 through 2026-05-18 morning: GCR codec → simple-rotation
runtime → drive_set_half_track shadow → byte_ready timing →
rotation_1541_gcr → speed-zone. All wrong. Kept verbatim as historical
record; do not rewrite. Actual root cause + fix below.

### 9.1. Actual root cause

`src/runtime/headless/media/mount.ts` ran the legacy `DiskProvider`
host-side CBM-DOS validation BEFORE the vice1541 `attachDisk()` path,
both inside the same `try { … } catch { errors.push(...) }` block.

```ts
const newProvider = DiskProvider.fromImagePath(path);   // ← throws on pawn
const files = newProvider.listFiles();
…
kernelAny.drive1541.attachDisk({ kind, bytes, readOnly });  // never reached
```

`DiskProvider.fromImagePath` (`src/runtime/headless/providers.ts` →
`src/disk/d64-parser.ts` / `src/disk/g64-parser.ts`) does its own BAM
read + directory walk. `samples/the_pawn_s1.g64` is Magnetic Scrolls
copy-protected: the BAM sector at T18/S0 is intentionally malformed,
the legacy parser throws `"Cannot read BAM sector (18/0)"`, the
enclosing `try` catches → `errors.push(...)` → `mountMedia` returns
"success" with a non-fatal error string → `drive1541.attachDisk` was
**never invoked** → `drive.GCR_image_loaded = 0` → drive ROM sees no
disk → `LOAD"$",8` returns `?FILE NOT FOUND`.

POLARBEAR.d64 worked because POLARBEAR has a valid BAM. motm.g64 etc.
worked for the same reason. Pawn was the only disk in the suite that
exercised the bug class. Real VICE has no equivalent host-side
validation pass — VICE reads raw GCR bits and lets the drive ROM
decide what to do.

### 9.2. Active runtime port was clean

RFL re-verification on 2026-05-18 (commit `3208958` + preceding
investigation) cleared every `vice1541/` file that §2 flagged P0/P1:

| File / function | Verdict | Evidence |
|---|---|---|
| `rotation.ts:rotation_begins` ↔ `rotation.c:295-305` | clean | 2-line body, verbatim port |
| `rotation.ts:rotation_1541_gcr` (READ + WRITE branches) ↔ `rotation.c:339-570` | clean | RFL SCHRITT 4 line-by-line |
| `rotation.ts:rotation_1541_gcr_cycle` ↔ `rotation.c:572-610` | clean | one_rotation / ref_cycles / req_ref_cycles all match |
| `rotation.ts:read_next_bit` + `write_next_bit` ↔ `rotation.c:227-278` | clean | `bit = (~off) & 7` MSB-first |
| byte_ready propagation 4-path chain (rotation set, BVC/BVS/PHP, VIA2 set_ca2, VIA2 store_prb motor edge) | clean | no shadow stubs, all paths land in drivecpu_set_overflow / reg_p \|= P_OVERFLOW |
| `fsimage_gcr.ts:fsimage_read_gcr_image` + `fsimage_gcr_read_half_track` ↔ `fsimage-gcr.c` | clean | runtime GCR bytes byte-identical to G64 file at every probed HT |
| `driveimage.ts:drive_image_attach` ↔ `driveimage.c:168-227` | clean | sequence verbatim |
| `drive.ts:drive_set_half_track` ↔ `drive.c:689-733` | clean | TS adds null/undefined guards; behaviour-equivalent |
| `dos1541-325302-01+901229-05.bin` | md5 a0ce8439…, byte-identical to VICE `data/DRIVES/` |

Suspect priority §2 P0-P1 entries are CLEARED. The CMP/CPX/CPY
unsigned-compare fix (commit `7727e8e`, Spec 615.14) and the
lifecycle reinit fix (commit `427f660`, Spec 615.15) WERE genuine port
bugs and remain valid — those are unrelated to the Pawn LOAD issue.

### 9.3. Fix

Commit `3208958` (Spec 615.16):

- `src/runtime/headless/media/mount.ts`: in vice mode, wrap legacy
  `DiskProvider.fromImagePath` + `listFiles` in their own try/catch.
  On failure record a non-fatal warning and continue to
  `drive1541.attachDisk` with `newProvider=null`. Legacy-mode behavior
  unchanged.
- Guard `kernel.diskProvider` / `kernalFileIo.diskProvider` assignments
  on `newProvider !== null`. In vice mode the drive ROM serves LOAD
  via IEC; the KERNAL trap path that consumes diskProvider is dormant
  for vice mode, so a null provider is functionally harmless.
- `tests/spec-615/load-dollar-all-disks.test.ts`: drop pawn
  `expectError` flag; pawn now expected GREEN (`LOADING/READY.`).
- `tests/spec-615/pawn-baseline-symmetry.test.ts`: removed (LEGACY1541
  symmetry is not the success oracle).

The fix REMOVES legacy validation from the active vice runtime path.
It does NOT add tolerance to the parser. The vice1541 active runtime
(`drive_image_attach → fsimage_read_gcr_image → rotation_1541_gcr →
drive ROM`) is byte-for-byte unchanged.

### 9.4. Lessons

**L1. PL-10 / shadow-stub scope is not confined to `vice1541/`-internal.**
The shadow rule (one function = one impl, no stubbed sibling) must be
read as cross-module: any code on the LOAD critical path that
host-side-validates state that the drive ROM is supposed to evaluate
is a shadow of the drive ROM, even if it lives in
`src/runtime/headless/media/` or `src/runtime/headless/providers.ts`.
The legacy `DiskProvider.fromImagePath` was a host-side shadow of the
drive's BAM walk.

**L2. Bridge code that swallows errors silently hides root causes.**
The `try/catch { errors.push(...) }` block was non-fatal by design (so
mountMedia could keep returning a useful result), but it also hid the
fact that vice1541 attachDisk was being skipped. Future bridge code
must isolate each step in its own try/catch and log at the boundary,
not at the outermost level.

**L3. Suspect priorities should be falsifiable cheaply BEFORE deep
RFL.** §2 listed `rotation.ts`, `via2d.ts`, `drive_set_half_track`,
`drive_image_attach` as P0 / P1 without a falsifying probe. A 10-line
test (mount pawn standalone, dump `drive.GCR_image_loaded`) would have
ruled them out in 30 seconds and pointed at the legacy provider
immediately. Add this kind of "did the drive even see the disk?"
sanity check to §3 of future load-path specs as step 0.

**L4. LEGACY1541 symmetry is not a success oracle.** The earlier
attempt to gate pawn as "PASS-if-legacy-also-errors" matched a
broken-on-both-sides outcome and treated it as expected. The success
oracle for vice1541 is the VICE-runtime behaviour, not the legacy
emulator's. This is codified in
`feedback_game_screenshot_test_set.md` but bears repeating: vice mode
disagrees with legacy mode, that is the entire point of the
side-by-side port.

### 9.5. Acceptance §4 #1 evidence

`tests/spec-615/load-dollar-all-disks.test.ts` (post-`3208958`):

```
GREEN  samples/POLARBEAR.d64                                  PC=$e5cf  | … LOADING | READY.
GREEN  samples/motm.g64                                       PC=$e5d1  | … LOADING | READY.
GREEN  samples/maniac_mansion_s1[…].g64                       PC=$e5cd  | … LOADING | READY.
GREEN  samples/impossible_mission_ii[…].g64                   PC=$e5cd  | … LOADING | READY.
GREEN  samples/last_ninja_remix_s1[…].g64                     PC=$e5d4  | … LOADING | READY.
GREEN  samples/scramble_infinity.d64                          PC=$e5cd  | … LOADING | READY.
GREEN  samples/synthetic/blank.d64                            PC=$e5d4  | … LOADING | READY.
GREEN  samples/the_pawn_s1.g64                                PC=$e5cf  | … LOADING | READY.
Summary: 8/8 disks loaded directory successfully
```

`tests/spec-615/multi-session-lifecycle.test.ts` (post-`427f660`):
3/3 GREEN.

§4 #2-#6 remain open — see follow-up commits on this branch.
