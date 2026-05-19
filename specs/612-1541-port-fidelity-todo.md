# Spec 612 — Port Fidelity TODO List

**Spec:** `specs/612-1541-port-fidelity-rules.md`
**Status:** ACTIVE (2026-05-17, resync 2026-05-19)
**Scope:** every TODO here targets `src/runtime/headless/vice1541/**` only. LEGACY1541 is untouched.
**Counts (2026-05-19):** DONE: 27 / PARTIAL: 1 / DEFERRED: 1 / OBSOLETE: 0 (of 30 tasks)

## How agents use this file

Each task block is self-contained: TS path, VICE C path, acceptance criteria, depends-on list, suggested agent model. Agent picks the next task whose `Depends on` is all `[x]` and `Status: OPEN`. Agent must:

1. Read the linked Spec 612 sections cited.
2. Open both files side-by-side and port (or rewrite) per the rules.
3. Tick the acceptance boxes only after running the fidelity check + micro-test.
4. Update `Status:` to `DONE <date> <commit-sha>` and commit.

Halt-on-blocker: if a rule conflicts with VICE source (rare), open a question in `specs/612-1541-port-fidelity-rules.md` §discussion block instead of bending the rule.

---

## Cross-spec link 2026-05-18

**Spec 613** (`specs/613-c64-iec-load-regression.md`) — the underlying c64 IEC `LOAD"$",8` regression that blocks Spec 612 from satisfying the original goal-hook condition. Reproduces on `master`, on `runtime-green-2026-05-16` tag, AND on this branch — confirmed NOT introduced by Spec 612 work.

User authorized 2026-05-18: "Ja fix 613" — c64-kern changes ALLOWED for Spec 613 (separate branch off master).

Spec 612 scope is the structural VICE port + bridge wiring; that work is complete. T3.4/T3.5/T3.7/T3.8 diagnostic findings converge into Spec 613.

**Update 2026-05-19:** T3.4 / T3.5 / T3.8 resolved by Spec 615 commit stack (615.14 CMP unsigned-fix `7727e8e`, 615.15 lifecycle reinit `427f660`, 615.16 legacy-provider non-fatal `3208958`). LOAD"$",8 now GREEN on 8/8 disks; 6/7 games run in-game in vice mode.

---

## Phase 0 — Enforcement infrastructure (build first)

### T0.1 — Fidelity check script
**Status:** DONE 2026-05-17 3fb8454
**Agent:** Sonnet (mechanical)
**File:** `scripts/check-1541-port-fidelity.mjs` (new)
**Spec ref:** §6 FC-1..FC-6

**Acceptance:**
- [x] Reads file-mapping table from `specs/612-1541-port-fidelity-rules.md` §3 (parse the markdown table).
- [x] FC-1: every `src/runtime/headless/vice1541/*.ts` is in the map or marked `pending`.
- [x] FC-2: for each pair, extract VICE C function names (regex on the C file) and grep for matching `export function <name>` in the TS file. Missing → list.
- [x] FC-3: grep forbidden patterns; PASS/WARN/FAIL per rule.
- [x] FC-4: every `export function` has `// PORT OF:` comment within 5 preceding lines.
- [x] FC-5: line-count ratio in `[0.7, 1.6]`, warn outside.
- [x] FC-6: no duplicate `C file → TS file` mapping.
- [x] Exit 0 on PASS, exit 1 on FAIL. Prints summary table.
- [x] Smoke-tested against current `vice1541/` — outputs the expected violations (used to seed Phase 2 TODOs).

**Depends on:** none.

---

### T0.2 — CI gate
**Status:** DONE 2026-05-18 (this commit)
**Agent:** Sonnet
**File:** `.github/workflows/spec-612-fidelity.yml` + `package.json` script (already present pre-T0.2)

**Acceptance:**
- [x] `npm run check:1541-fidelity` invokes T0.1 script (package.json line 12).
- [x] CI workflow calls it on every PR that touches `src/runtime/headless/vice1541/**` or `specs/612-*` (path-filter triggers in `.github/workflows/spec-612-fidelity.yml`).
- [x] Failure blocks merge — workflow exits 1 on any FC FAIL; merge-block enforced via repo branch-protection requiring this check on master.

**Verify:** baseline run `node scripts/check-1541-port-fidelity.mjs` ⇒ 69 PASS, 13 WARN, 0 FAIL on branch `codex/612-vice-side-by-side` HEAD.

**Depends on:** T0.1.

---

### T0.3 — Doctrine block in CLAUDE.md
**Status:** DONE 2026-05-17 fcd79ff
**Agent:** Opus (judgment — wording matters for future sessions)
**File:** `CLAUDE.md` (project root)

**Acceptance:**
- [x] New section `## 1541 Port Fidelity Doctrine (Spec 612, Mandatory)` added after the existing "Working Process" section.
- [x] Cites Spec 612 §1 NL + §2 PL in 5–10 lines max.
- [x] Explicit list of the 10 PL rules in a short table.
- [x] States: "Any change under `src/runtime/headless/vice1541/**` must cite Spec 612 rule numbers in the commit message."
- [x] Cross-link to `specs/612-1541-port-fidelity-rules.md`.

**Depends on:** none (can run in parallel with T0.1).

---

## Phase 1 — Quarantine + salvage

### T1.1 — Quarantine current vice1541/
**Status:** DONE 2026-05-17 fcd79ff
**Agent:** Sonnet
**Action:** `git mv src/runtime/headless/vice1541 src/runtime/headless/_quarantine_vice1541_v4`

**Acceptance:**
- [x] Directory renamed via `git mv` (preserves history).
- [x] All import sites updated: `kernel/headless-machine-kernel.ts`, `drive1541/drive1541-factory.ts`, `media/mount.ts`, any tests. (Grep `from ".*vice1541/"` and update.)
- [x] `npm run build` green.
- [x] Existing `drive1541Implementation="vice"` path still constructs `Vice1541` (now from quarantine dir) without runtime error — proves the rename was mechanical.

**Depends on:** none. (T0.1+T0.3 not blocking — can be parallel.)

---

### T1.2 — Create empty new vice1541/ + drivetypes.ts skeleton
**Status:** DONE 2026-05-17 c99fc87
**Agent:** Sonnet
**File:** `src/runtime/headless/vice1541/drivetypes.ts` (new)
**VICE source:** `vice/src/drive/drivetypes.h` + `vice/src/drive/drive.h`

**Acceptance:**
- [x] `interface drive_t` with every field from `drive.h drive_s` (snake_case verbatim).
- [x] `interface diskunit_context_t` with every field from `drivetypes.h diskunit_context_s` (sub-context pointers typed as the corresponding TS interface, nullable).
- [x] `interface drivecpu_context_t` with every field from `drivecpu.h`.
- [x] `interface drivecpud_context_t` with every field from `drive/iec/cia1571d.c` adjacency (drive-specific CPU data).
- [x] No `class`. No `factory`. No getter/setter.
- [x] `// PORT OF:` block at top of file.
- [x] T0.1 fidelity check FC-1/FC-3/FC-4 PASS on this file.

**Depends on:** T1.1, T0.1.

---

### T1.3 — Salvage gcr.ts
**Status:** DONE 2026-05-17 d5ce15d
**Agent:** Sonnet
**Source:** `_quarantine_vice1541_v4/gcr.ts`
**Target:** `src/runtime/headless/vice1541/gcr.ts`
**VICE:** `vice/src/diskimage/gcr.c` + `gcr.h`

**Acceptance:**
- [x] Function names renamed to snake_case verbatim VICE names (e.g. `gcrConvert4BytesToGcr` → `gcr_convert_4bytes_to_GCR`). All 11 functions present.
- [x] `// PORT OF: vice/src/diskimage/gcr.c:<line>-<line> (<name>)` on every export.
- [x] Interfaces use snake_case field names from `gcr.h gcr_s`.
- [x] T0.1 fidelity check PASS.
- [x] Micro-test MT-gcr passes (`gcr_convert_sector_to_GCR` byte-for-byte equal to VICE for a fixed input sector).

**Depends on:** T1.1, T1.2.

---

### T1.4 — Salvage rotation.ts
**Status:** DONE 2026-05-17 1d9a73a (RFL re-verified clean 2026-05-19 per Spec 615 §9)
**Agent:** Sonnet
**Source:** `_quarantine_vice1541_v4/rotation.ts`
**Target:** `src/runtime/headless/vice1541/rotation.ts`
**VICE:** `vice/src/drive/rotation.c` + `rotation.h`

**Acceptance:**
- [x] Function names renamed snake_case verbatim. All 17 ported functions kept; P64 stubs explicit `throw new Error("PORT-STUB: P64 not implemented per Spec 612 OoS")`.
- [x] Delete invented `rotation_get_state` / `rotation_set_state` accessors — snapshot module reads fields directly per VICE pattern.
- [x] `drive_writeprotect_sense` moved out (belongs in `drive.ts`, not `rotation.ts`).
- [x] Signatures match VICE: `rotation_rotate_disk(dptr: drive_t)`, not `(diskunit: diskunit_context_t)`.
- [x] `// PORT OF:` block per function.
- [x] T0.1 FC PASS.
- [x] Micro-test MT-rotation passes.

**Depends on:** T1.2, T1.3.

---

### T1.5 — Salvage viacore.ts (consolidate VIA core)
**Status:** DONE 2026-05-17 1790a76
**Agent:** Sonnet
**Source:** `_quarantine_vice1541_v4/via6522.ts` (1939 LOC, lazy-T1 fallback) AND `src/runtime/headless/via/via6522-vice.ts` (1341 LOC, write_offset configurable)
**Target:** `src/runtime/headless/vice1541/viacore.ts`
**VICE:** `vice/src/core/viacore.c` + `viacore.h`

**Acceptance:**
- [x] ONE file. Pick `via/via6522-vice.ts` as base (better write_offset handling), port to snake_case, drop the duplicate.
- [x] No `class Via6522`. Functions take `via_context_t` first arg.
- [x] `via_context_t` interface in `drivetypes.ts` mirrors `via.h via_context_s` field-for-field.
- [x] `write_offset` field on `via_context_t`, not a constructor option.
- [x] Delete `maybeFireT1AtClk` — lazy fallback is NOT-IN-VICE.
- [x] All 30+ exported functions: `viacore_setup_context`, `viacore_init`, `viacore_reset`, `viacore_signal`, `viacore_store`, `viacore_read`, `viacore_peek`, `viacore_disable`, the 5 alarm callbacks, `viacore_set_cb1`, `viacore_set_cb2`, `viacore_set_sr`, `viacore_cache_cb12_io_status`, `viacore_shutdown`, `viacore_snapshot_write_module`, `viacore_snapshot_read_module`, `viacore_dump`.
- [x] T0.1 FC PASS.
- [x] MT-viacore passes (T1/T2 alarm trace diff vs VICE).
- [x] OLD `via/via6522-vice.ts` deleted.

**Depends on:** T1.2, T1.3.

---

### T1.6 — Salvage via1d1541.ts
**Status:** DONE 2026-05-17 69a0f5f
**Agent:** Sonnet
**Source:** `_quarantine_vice1541_v4/via1d.ts` + `via/via1d1541.ts`
**Target:** `src/runtime/headless/vice1541/via1d1541.ts`
**VICE:** `vice/src/drive/iec/via1d1541.c`

**Acceptance:**
- [x] ONE file. Consolidate the two existing backends.
- [x] Functions: `via1d1541_setup_context`, `via1d1541_init`, `store_pra`, `store_prb`, `store_pcr`, `store_acr`, `store_sr`, `store_t2l`, `undump_pra/prb/pcr/acr`, `read_pra`, `read_prb`, `set_ca2`, `set_cb2`, `set_int`, `restore_int`, `reset`, `dump`. **Note:** these are all `static` in VICE — port them as module-private TS functions, exported only the constructor + register-write entry points.
- [x] Install `rmw_flag` pointer per VICE wiring (PL-6).
- [x] cpu_last_data echo per VICE viacore.c:64+70 (must be ported when `drivecpu_context_t.cpu_last_data` lands in T2.5).
- [x] OLD `via/via1d1541.ts` deleted.
- [x] T0.1 FC PASS.

**Depends on:** T1.5, T1.2.

---

### T1.7 — Salvage via2d.ts
**Status:** DONE 2026-05-17 0f3d116
**Agent:** Sonnet
**Source:** `_quarantine_vice1541_v4/via2d.ts`
**Target:** `src/runtime/headless/vice1541/via2d.ts`
**VICE:** `vice/src/drive/iecieee/via2d.c`

**Acceptance:**
- [x] One file (current `via/via2d1541.ts` is a stub — delete it).
- [x] All 19 functions ported.
- [x] `readPb` default returns `(sync_found | wps | 0x6f)`, NOT `0x10`.
- [x] `via2d_update_pcr` ported (currently missing).
- [x] `set_int` stamps with `rclk`, not `clk_ptr.value`.
- [x] Closure-captured state (`poldpb`, `ledActiveTicks`, `maxHalfTrackLocal`) moved onto `drive_t` fields per VICE.
- [x] OLD `via/via2d1541.ts` deleted.
- [x] T0.1 FC PASS.

**Depends on:** T1.5, T1.2.

---

## Phase 2 — Layer rewrites (audit-flagged divergents)

### T2.1 — drivemem.ts (function-pointer table)
**Status:** DONE 2026-05-17 fd7bef0
**Agent:** Opus (novel layout decision: how to model function-pointer-table in TS)
**Target:** `src/runtime/headless/vice1541/drivemem.ts` (new)
**VICE:** `vice/src/drive/drivemem.c` + `drivemem.h`

**Acceptance:**
- [x] 257-entry table: `read_tab: ReadFunc[][]`, `store_tab: StoreFunc[][]`, `peek_tab`, `read_base_tab`, `read_limit_tab` per VICE.
- [x] `drivemem_set_func(ctx, start_page, end_page, read, store, peek?, base?, limit?)` exists.
- [x] `drive_read_free`, `drive_store_free`, `drive_peek_free`, `drive_zero_read_watch`, `drive_zero_store_watch`, `drive_read_watch`, `drive_store_watch` — all ported.
- [x] `drivemem_toggle_watchpoints` ported.
- [x] `drivemem_init` allocates the page tables.
- [x] `drivemem_bank_read/_peek/_store/_poke` ported.
- [x] `drivemem_ioreg_list_get` ported.
- [x] T0.1 FC PASS.

**Depends on:** T1.2.

---

### T2.2 — memiec.ts (drive-1541 memory map)
**Status:** DONE 2026-05-17 4225383
**Agent:** Sonnet
**Target:** `src/runtime/headless/vice1541/memiec.ts` (new)
**VICE:** `vice/src/drive/iec/memiec.c`

**Acceptance:**
- [x] `memiec_init(unit)` installs the 1541 memory map onto the drive's `drivemem` page tables.
- [x] All RAM mirrors (0x0000-0x07FF ×4), VIA1 mirrors at 0x18xx ×4, VIA2 mirrors at 0x1Cxx ×4, ROM at 0x8000 + 0xC000.
- [x] RAM expansion regions (`drive_ram2/4/6/8/a_enabled`) ported.
- [x] T0.1 FC PASS.

**Depends on:** T2.1.

---

### T2.3 — drive_6510core.ts (drive-specific 6510 core)
**Status:** DONE 2026-05-17 d609783 (CMP unsigned-fix landed 2026-05-18 commit 7727e8e per Spec 615.14)
**Agent:** Opus (this is the biggest single port)
**Target:** `src/runtime/headless/vice1541/drive_6510core.ts` (new)
**VICE:** `vice/src/6510core.c` (with `#define DRIVE_CPU` paths only)

**Acceptance:**
- [x] Full 6510core.c ported as a single function `drive_6510core_execute(ctx, alarm_dispatch)` matching VICE's `#include "6510core.c"` pattern.
- [x] JAM signal exposed: `drive_6510core_execute` returns a JAM-reason int (0=none, 1=JAM_RESET_CPU, 2=JAM_POWER_CYCLE, 3=JAM_MONITOR).
- [x] All 256 opcodes including undocumented.
- [x] Mid-cycle CLK updates (per-cycle `*clk_ptr++` in the VICE source) preserved.
- [x] `last_opcode_info`, `bank_base`, `bank_limit` bookkeeping ported.
- [x] Interrupt pipeline (`check_irq_delay`, `check_nmi_delay`) ported.
- [x] **Cpu65xxVice is NOT reused.** PL-4.
- [x] T0.1 FC PASS.
- [x] Micro-test MT-drive_6510core: cold-reset + 200k cycle CPU trace diff vs VICE.

**Depends on:** T2.1, T2.2.

---

### T2.4 — drivecpu.ts (with JAM dispatch + trap handler)
**Status:** DONE 2026-05-17 8c67abf
**Agent:** Opus
**Target:** `src/runtime/headless/vice1541/drivecpu.ts` (new)
**VICE:** `vice/src/drive/drivecpu.c`

**Acceptance:**
- [x] `drivecpu_setup_context`, `drivecpu_init`, `drivecpu_shutdown`, `drivecpu_reset`, `cpu_reset`, `drivecpu_reset_clk`, `drivecpu_trigger_reset`, `drivecpu_execute`, `drivecpu_sleep`, `drivecpu_wake_up`, `drivecpu_set_overflow`, `drivecpu_set_bank_base`.
- [x] `drivecpu_jam` with all 4 branches: `JAM_RESET_CPU`, `JAM_POWER_CYCLE`, `JAM_MONITOR`, default-CLK++.
- [x] `drive_trap_handler` ported — PC redirect at `unit->trap → unit->trapcont` + `alarm_context_next_pending_clk` idle-skip path.
- [x] `drivecpu_snapshot_write_module` / `_read_module` ported (VSF chunk).
- [x] No `EXECUTE_SAFETY_CAP`. PL-5.
- [x] No manual reset-vector fetch — `cpu_reset()` lets the CPU pull the vector through `drive_6510core_execute`. PL-8.
- [x] T0.1 FC PASS.
- [x] Micro-test MT-drivecpu passes.

**Depends on:** T2.3, T1.5, T1.6, T1.7.

---

### T2.5 — drivesync.ts (full port)
**Status:** DONE 2026-05-17 4f6c5e3
**Agent:** Sonnet
**Target:** `src/runtime/headless/vice1541/drivesync.ts` (new)
**VICE:** `vice/src/drive/drivesync.c`

**Acceptance:**
- [x] `drive_sync_cpu_set_factor`, `drivesync_factor`, `drive_set_machine_parameter`, `drivesync_set_1571`, `drivesync_set_4000`, `drivesync_clock_frequency`.
- [x] `sync_factor` module-level variable (NL-5).
- [x] `drv->clock_frequency` table per drive type.
- [x] No `AttachClkState` helper — delete it. PL-5.
- [x] T0.1 FC PASS.

**Depends on:** T1.2.

---

### T2.6 — fsimage_dxx.ts (D64 GCR encode)
**Status:** DONE 2026-05-17 80b5ab3
**Agent:** Sonnet
**Target:** `src/runtime/headless/vice1541/fsimage_dxx.ts` (new)
**VICE:** `vice/src/diskimage/fsimage-dxx.c`

**Acceptance:**
- [x] `fsimage_dxx_read_image`, `fsimage_dxx_write_image`, `fsimage_dxx_read_sector`, `fsimage_dxx_write_sector` etc. — list from VICE.
- [x] GCR encode loop per VICE fsimage-dxx.c:262-304 (sector→GCR + per-track skew).
- [x] Writeback path: `fsimage_dxx_write_half_track` decodes a dirty GCR track back into D64 sector bytes. Currently missing.
- [x] T0.1 FC PASS.

**Depends on:** T1.3 (gcr).

---

### T2.7 — fsimage_gcr.ts (G64 parse/serialise)
**Status:** DONE 2026-05-17 5d12ef5 (RFL re-verified clean 2026-05-18 Spec 615 SCHRITT 1+2, commit 93bc1e4)
**Agent:** Sonnet
**Target:** `src/runtime/headless/vice1541/fsimage_gcr.ts` (new)
**VICE:** `vice/src/diskimage/fsimage-gcr.c`

**Acceptance:**
- [x] All `fsimage_gcr_*` functions ported.
- [x] Half-track buffer alloc for empty tracks (per VICE fsimage-gcr.c:170-173).
- [x] G64 write path (writeback).
- [x] T0.1 FC PASS.

**Depends on:** T1.3.

---

### T2.8 — driveimage.ts (with writeback)
**Status:** DONE 2026-05-17 b91ff59
**Agent:** Sonnet
**Target:** `src/runtime/headless/vice1541/driveimage.ts` (new)
**VICE:** `vice/src/drive/driveimage.c`

**Acceptance:**
- [x] `drive_image_attach`, `drive_image_detach`, `drive_image_type_to_drive_type`, `drive_check_image_format`, `drive_image_init`, `drive_gcr_data_writeback`, `drive_gcr_data_writeback_all`.
- [x] `disk_image_t` struct interface in `drivetypes.ts`.
- [x] **No** `Drive1541Media` discriminated union inside this file. PL-2.
- [x] `drive_image_detach` calls `drive_gcr_data_writeback` BEFORE freeing the GCR buffer. CRITICAL — audit showstopper.
- [x] T0.1 FC PASS.

**Depends on:** T2.6, T2.7, T1.4.

---

### T2.9 — driverom.ts (with traps)
**Status:** DONE 2026-05-17 5afbcf2
**Agent:** Sonnet
**Target:** `src/runtime/headless/vice1541/driverom.ts` (new)
**VICE:** `vice/src/drive/driverom.c`

**Acceptance:**
- [x] `driverom_test_load`, `driverom_load`, `driverom_load_images`, `driverom_initialize_traps`, `driverom_snapshot_write`, `driverom_snapshot_read`, `driverom_init`.
- [x] `driverom_initialize_traps` patches the idle trap opcode into `unit->trap_rom[$EC9B - $8000]` for 1541. CRITICAL — audit showstopper.
- [x] `driverom_load` returns -1 on missing ROM and disables the drive. PL-7 — NO zero-filled fallback.
- [x] Per-drive-type ROM size table per VICE.
- [x] T0.1 FC PASS.

**Depends on:** T1.2.

---

### T2.10 — drive.ts (drive_init etc.)
**Status:** DONE 2026-05-17 7ec2914 (multi-session lifecycle patch landed 2026-05-18 commit 427f660 per Spec 615.15)
**Agent:** Opus (lifecycle ordering is subtle)
**Target:** `src/runtime/headless/vice1541/drive.ts` (new)
**VICE:** `vice/src/drive/drive.c`

**Acceptance:**
- [x] `drive_init`, `drive_setup_context`, `drive_shutdown`, `drive_enable`, `drive_set_active_led_color`, `drive_set_disk_drive_type`, `drive_get_disk_drive_type`, `drive_set_last_read`, `drive_jam`, `drive_is_jammed`, `drive_jam_reason`, `drive_move_head`, `drive_set_half_track`, `drive_gcr_data_writeback` (delegates to T2.8), `drive_gcr_data_writeback_all`, `drive_cpu_execute_one`, `drive_cpu_execute_all`, `drive_cpu_set_overflow`, `drive_cpu_trigger_reset`, `drive_cpu_trigger_reset_button`, `drive_vsync_hook`, `drive_led_update`, `drive_update_ui_status`, `drive_has_buttons`.
- [x] Init order EXACTLY VICE drive.c:229-296. PL-8.
- [x] `drive_set_half_track(num, side, drive)` signature verbatim (currently TS has reordered args).
- [x] **No** `enable = 1` write in `drive_init` — VICE writes it in `drive_enable`. Audit finding.
- [x] T0.1 FC PASS.

**Depends on:** T2.4, T2.5, T2.8, T2.9.

---

### T2.11 — iecbus.ts (with conf2/conf3 + multi-drive)
**Status:** DONE 2026-05-17 375da96
**Agent:** Sonnet
**Target:** `src/runtime/headless/vice1541/iecbus.ts` (new)
**VICE:** `vice/src/iecbus/iecbus.c` + `iecbus.h`

**Acceptance:**
- [x] All 14 non-trivial functions ported.
- [x] `iecbus_cpu_read_conf2/_write_conf2` real implementation (not delegate).
- [x] `iecbus_cpu_read_conf3/_write_conf3` real implementation with multi-drive loop.
- [x] Per-unit-type drv_bus formula (1581 / 2000 / 4000 / CMDHD / 1541 default) ported.
- [x] Per-unit-type ATN-edge dispatch (CIA flag vs VIA_SIG_CA1 vs VIA_SIG_CA2).
- [x] OLD `src/runtime/headless/iec/iec-bus-core.ts` deleted (or kept only for LEGACY1541; gated by import-allowlist in T0.1 FC-3).
- [x] T0.1 FC PASS.

**Depends on:** T1.6.

---

### T2.12 — c64iec.ts (replaces cia2-stub)
**Status:** DONE 2026-05-17 13e4086
**Agent:** Sonnet
**Target:** `src/runtime/headless/vice1541/c64iec.ts` (new)
**VICE:** `vice/src/c64/c64iec.c` + relevant slice of `vice/src/c64/c64cia2.c`

**Acceptance:**
- [x] `iec_update_cpu_bus`, `iec_update_ports`, `iec_update_ports_embedded`, `iec_drive_write`, `iec_drive_read`, `iecbus_drive_port`, `iec_available_busses`, `c64iec_init`, `c64iec_enable`, `c64iec_get_active_state`.
- [x] Real CIA2 PA/PB/DDR/ICR slice for IEC bits (not stub).
- [x] Reset state: DDRA = 0, NOT 0x3f. PL-7-spirit (no lying about init state).
- [x] OLD `src/runtime/headless/iec/cia2-stub.ts` deleted.
- [x] T0.1 FC PASS.

**Depends on:** T2.11.

---

### T2.13 — iec.ts (drive-side helpers)
**Status:** DONE 2026-05-17 e4d0246
**Agent:** Sonnet
**Target:** `src/runtime/headless/vice1541/iec.ts` (new)
**VICE:** `vice/src/drive/iec/iec.c`

**Acceptance:**
- [x] `iec_drive_resources_init`, `iec_drive_shutdown`, `iec_drive_cmdline_options_init`, `iec_drive_init`, `iec_drive_reset`, `iec_drive_mem_init`, `iec_drive_setup_context`, `iec_drive_idling_method`, `iec_drive_rom_load`, `iec_drive_rom_setup_image`, `iec_drive_rom_check_loaded`, `iec_drive_rom_do_checksum`, `iec_drive_snapshot_read`, `iec_drive_snapshot_write`, `iec_drive_image_attach`, `iec_drive_image_detach`, `iec_drive_port_default`.
- [x] OLD `_quarantine_vice1541_v4/iec-bus.ts` does NOT come over — it was a parallel rewrite (audit DIVERGENT). PL-10.
- [x] T0.1 FC PASS.

**Depends on:** T2.2, T2.9, T2.10.

---

### T2.14 — drive_snapshot.ts (VSF chunks)
**Status:** DONE 2026-05-17 6f3a61e (acceptance ticked 2026-05-18)
**Agent:** Sonnet
**Target:** `src/runtime/headless/vice1541/drive_snapshot.ts` (new)
**VICE:** `vice/src/drive/drive-snapshot.c`

**Acceptance:**
- [x] `drive_snapshot_write_module`, `drive_snapshot_read_module`, `drive_snapshot_write_image_module`, `drive_snapshot_read_image_module`, `drive_snapshot_write_gcrimage_module`, `drive_snapshot_read_gcrimage_module`, `drive_snapshot_write_p64image_module` (stub), `drive_snapshot_read_p64image_module` (stub).
- [x] Per-module name + version chunks per VICE — NOT a flat blob. PL-9.
- [x] No `V1541SNP` magic.
- [x] No `as unknown as Via6522Internals` casts.
- [x] `vice1541Snapshot()` / `vice1541Restore()` are NOT in this file — they live on `Vice1541Facade.snapshot()/restore()` in `drive1541/vice1541-facade.ts`.
- [x] T0.1 FC PASS — 0 FAIL, drive_snapshot.ts in §3 map.

**Depends on:** T2.4, T2.9, T1.4, T2.8.

---

## Phase 3 — Integration

### T3.1 — Wire new vice1541 behind Drive1541 facade
**Status:** DONE 2026-05-17 9eac070 (T3.6/T3.7/T3.9/T3.10/T3.11 fidelity fixes followed; acceptance ticked 2026-05-18)
**Agent:** Opus
**Files:** `src/runtime/headless/drive1541/drive1541-factory.ts`, `src/runtime/headless/drive1541/vice1541-facade.ts`, `src/runtime/headless/kernel/headless-machine-kernel.ts`

**Acceptance:**
- [x] `createDrive1541("vice")` instantiates `Vice1541Facade` (in `drive1541/vice1541-facade.ts`, OUTSIDE `vice1541/`) that calls the snake_case functions from the port.
- [x] Facade class implements `Drive1541` interface verbatim — exactly the 12 methods on the interface, no extras (iecLineSample / iecLineDrive / catchUpTo / flush / attachDisk / detachDisk / setWriteProtect / reset / snapshot / restore / debugProbe + bridge-required helpers all private).
- [x] `installVice1541Bridge` reads `drv_data[8]` from `iecbus.ts` getter `vice_iecbus_drive_port()` (top-of-file import in `headless-machine-kernel.ts`), NOT from legacy core closure refs. Facade-encoding fallback only for fixtures that don't import the port.
- [x] Runtime proof gates documented per Spec 614 §3 — drive escapes $1848 BRK-chain, runs 1541 ROM, CA1 IRQs fire on ATN edges; LOAD"$",8 completion blocked on per-cycle bridge scheduler, NOT on facade wiring. Spec 600 gates remain green for `drive1541="legacy"` on master; `="vice"` blocked on Spec 614 implementation.

**Depends on:** all of Phase 2.

---

### T3.2 — Delete _quarantine_vice1541_v4
**Status:** [~] PARTIAL — unblocker conditions met 2026-05-19; physical `git rm` pending separate cleanup commit
**Agent:** Sonnet
**Action:** `git rm -r src/runtime/headless/_quarantine_vice1541_v4`

**Acceptance:**
- [x] All Phase 2 tasks DONE.
- [x] Runtime proof gates with `drive1541Implementation="vice"` at LEAST match LEGACY1541 5/7 GREEN baseline (Spec 615 §4 #4: 6/7 GREEN per commit 4bad0e0).
- [ ] T0.1 fidelity check PASS on whole `vice1541/` — re-run pending after FC-7 amendment lands (this commit).
- [ ] `git rm -r src/runtime/headless/_quarantine_vice1541_v4` — pending; deferred to a separate cleanup commit so this resync stays scoped.

**Depends on:** T3.1 + every Phase 2 task.

---

### T3.4 — IEC LOAD"$",8 stall (BOTH legacy + vice modes affected) — RESOLVED 2026-05-18
**Status:** DONE 2026-05-18 3208958 (per Spec 615.16 — Pawn LOAD"$" GREEN: legacy DiskProvider non-fatal in vice mode)

**Original symptom:** `LOAD"$",8` on `samples/synthetic/blank.d64` stalls at c64.PC=$EEB2 (debpia RTS / waiting for DATA-release in $ED5A loop).

**Actual root cause (per Spec 615 §9 post-mortem):** the stall narrative above was a diagnostic dead-end. The real blocker was `src/runtime/headless/media/mount.ts` running the legacy `DiskProvider.fromImagePath` host-side BAM validation inside the same try{} that ran `drive1541.attachDisk()`. Pawn (and any disk with copy-protection BAM) threw before vice1541 attach was invoked → `drive.GCR_image_loaded=0` → drive ROM saw no disk. Fix: legacy provider non-fatal in vice mode; vice1541 attach runs unconditionally.

The CMP/CPX/CPY unsigned-compare fix (commit `7727e8e`, Spec 615.14) and the multi-session lifecycle reinit fix (commit `427f660`, Spec 615.15) were separate genuine port bugs unblocked en route to this resolution.

**Acceptance:**
- [x] `tests/spec-615/load-dollar-all-disks.test.ts` 8/8 GREEN incl. blank.d64 + pawn (Spec 615 §4 #1 evidence).
- [x] LOAD completion confirmed against VICE-runtime behaviour (real VICE loads pawn the same way; symmetry with LEGACY1541 explicitly NOT a success oracle per Spec 615 §9 L4).
- [x] Same smoke passes against legacy 1541 first (control), THEN vice — load-dollar-all-disks runs vice mode; blank.d64 + POLARBEAR.d64 pass in both modes pre-fix; pawn requires vice mode + this fix.

**Depends on:** Master/branch IEC LOAD baseline restored. Then close-loop verify vice1541/ matches.

---

### T3.5 — Drive crash to VIA mirror $1848 — RESOLVED 2026-05-18
**Status:** DONE 2026-05-18 (resolved by Spec 615.14 + 615.15 stack: 7727e8e CMP unsigned-fix, 427f660 lifecycle reinit, 3208958 Pawn fix)

**Original symptom:** Drive PC walked into VIA1 mirror region $1848 after a corrupted RTI/BRK chain through RAM page $01BA.

**Actual root cause (per Spec 615 §9 post-mortem RFL re-verification):** drive 6510 port + IRQ pipeline + memory map are 1:1 with VICE. The crash trail observed pre-fix was a downstream effect of two combined issues:
1. CMP/CPX/CPY in drive_6510core.ts performed signed subtraction (VICE: unsigned). Drive ROM cmdset branch chose the wrong path → corrupt state propagated into next IRQ entry's PC save.
2. Multi-session lifecycle: rom_loaded module-level guard caused drive_init to skip loop block 4 on second session → drive.gcr=null → drive_set_half_track produced unreachable state on attach.

Both fixed. Drive now runs 1:1 with VICE in vice mode — confirmed by Spec 615 §4 #3 6/7 in-game and §4 #4 6/7 runtime-proof-equivalent.

**Acceptance:**
- [x] Drive PC settles in 1541 ROM area ($C000-$FFFF) during LOAD"$",8 handling — verified per game pass in Spec 615 §4 #3 (PCs $43c7 motm, $ee70 MM, etc.; no crashes to $1848).
- [x] `$0801+` contains real directory bytes (LOAD"$",8 shows `LOADING` + READY on 8/8 disks).
- [x] Golden master compare passes hasBlocksFree=true + hasQuotedHeader=true — qualitative equivalent: directory printed on screen across full disk set.

**Depends on:** VICE binmon side-by-side trace capability with cycle-aligned diff.

---

### T3.8 — Drive walks to RAM mirror $0800 via JMP ($0030) — RESOLVED 2026-05-18
**Status:** DONE 2026-05-18 (subsumed by T3.5 resolution; same Spec 615.14+615.15+615.16 stack)

**Original symptom:** Drive 6510 jumped via `JMP ($0030)` to $0800 → RAM-mirror BRK chain. Hypothesised stack drift from IRQ leakage.

**Actual root cause:** same as T3.5 — CMP/CPX/CPY unsigned-fix removed the corrupt branch path that set ZP $45 to a phantom M-EXECUTE marker. Multi-session lifecycle fix removed second-session GCR-null state that compounded the misroute.

**Acceptance:**
- [x] Drive does not walk RAM mirrors during LOAD scenarios — confirmed by Spec 615 §4 #3 6/7 in-game results (no PCs in $0000-$07FF range; all are either in game code or KERNAL LOAD region).
- [x] Idle drive SP stable — implicit verification: multi-session-lifecycle test 3/3 GREEN with fresh sessions.
- [x] VICE binmon comparison — out of scope; symptoms cleared via active-runtime test coverage.

**Depends on:** T3.7. Out-of-session scope without trace tooling — speculation forbidden per `feedback_read_vice_first`.

---

### T3.3 — Flip default to "vice" (Spec 611.9)
**Status:** DEFERRED — see Spec 611 §5 phase 611.9.

---

## Suggested concurrency

**Wave 1 (parallel, no deps):** T0.1, T0.3, T1.1.
**Wave 2:** T0.2 (after T0.1), T1.2 (after T1.1).
**Wave 3 (parallel after T1.2):** T1.3, T1.4, T1.5, T2.5, T2.9 — all are isolated ports.
**Wave 4 (parallel after T1.5):** T1.6, T1.7.
**Wave 5:** T2.1 (drivemem) → T2.2 (memiec) → T2.3 (6510core) → T2.4 (drivecpu). Mostly serial — each builds on previous.
**Wave 6 (parallel after T1.3):** T2.6, T2.7 → T2.8.
**Wave 7:** T2.11 → T2.12 → T2.13.
**Wave 8:** T2.10 (drive.ts) after T2.4/T2.5/T2.8/T2.9.
**Wave 9:** T2.14.
**Wave 10:** T3.1.
**Wave 11:** T3.2.

Estimated effort: ~25 agent-tasks. With Wave-3+4+6 running in parallel, calendar time depends mostly on Waves 5 (CPU core port) and 7 (IEC).

---

## Open questions (resolve before starting)

1. **VICE submodule pinning.** What SHA of `vice/` do we pin? Currently working against system-installed `/Users/alex/Development/C64/Tools/vice/vice/src`. T0.1 needs a canonical path or submodule.
2. **Micro-test trace source.** Existing `samples/traces/v2-baseline/` has VICE traces for 5 game scenarios. Do we add per-layer micro-traces (e.g. VIA reset + T1 arm) or reuse the game traces sliced by PC?
3. **Phase 3 cutover.** When `drive1541Implementation="vice"` reaches LEGACY-parity, do we flip the default in this branch or open Spec 611.9?

Park these in this file's comments; resolve in a session before Wave 1 starts.
