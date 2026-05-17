# Spec 612 — Port Fidelity TODO List

**Spec:** `specs/612-1541-port-fidelity-rules.md`
**Status:** OPEN (2026-05-17)
**Scope:** every TODO here targets `src/runtime/headless/vice1541/**` only. LEGACY1541 is untouched.

## How agents use this file

Each task block is self-contained: TS path, VICE C path, acceptance criteria, depends-on list, suggested agent model. Agent picks the next task whose `Depends on` is all `[x]` and `Status: OPEN`. Agent must:

1. Read the linked Spec 612 sections cited.
2. Open both files side-by-side and port (or rewrite) per the rules.
3. Tick the acceptance boxes only after running the fidelity check + micro-test.
4. Update `Status:` to `DONE <date> <commit-sha>` and commit.

Halt-on-blocker: if a rule conflicts with VICE source (rare), open a question in `specs/612-1541-port-fidelity-rules.md` §discussion block instead of bending the rule.

---

## Phase 0 — Enforcement infrastructure (build first)

### T0.1 — Fidelity check script
**Status:** OPEN
**Agent:** Sonnet (mechanical)
**File:** `scripts/check-1541-port-fidelity.mjs` (new)
**Spec ref:** §6 FC-1..FC-6

**Acceptance:**
- [ ] Reads file-mapping table from `specs/612-1541-port-fidelity-rules.md` §3 (parse the markdown table).
- [ ] FC-1: every `src/runtime/headless/vice1541/*.ts` is in the map or marked `pending`.
- [ ] FC-2: for each pair, extract VICE C function names (regex on the C file) and grep for matching `export function <name>` in the TS file. Missing → list.
- [ ] FC-3: grep forbidden patterns; PASS/WARN/FAIL per rule.
- [ ] FC-4: every `export function` has `// PORT OF:` comment within 5 preceding lines.
- [ ] FC-5: line-count ratio in `[0.7, 1.6]`, warn outside.
- [ ] FC-6: no duplicate `C file → TS file` mapping.
- [ ] Exit 0 on PASS, exit 1 on FAIL. Prints summary table.
- [ ] Smoke-tested against current `vice1541/` — outputs the expected violations (used to seed Phase 2 TODOs).

**Depends on:** none.

---

### T0.2 — CI gate
**Status:** OPEN
**Agent:** Sonnet
**File:** `.github/workflows/*.yml` (whichever runs PR checks) + `package.json` script

**Acceptance:**
- [ ] `npm run check:1541-fidelity` invokes T0.1 script.
- [ ] CI workflow calls it on every PR that touches `src/runtime/headless/vice1541/**` or `specs/612-*`.
- [ ] Failure blocks merge.

**Depends on:** T0.1.

---

### T0.3 — Doctrine block in CLAUDE.md
**Status:** OPEN
**Agent:** Opus (judgment — wording matters for future sessions)
**File:** `CLAUDE.md` (project root)

**Acceptance:**
- [ ] New section `## 1541 Port Fidelity Doctrine (Spec 612, Mandatory)` added after the existing "Working Process" section.
- [ ] Cites Spec 612 §1 NL + §2 PL in 5–10 lines max.
- [ ] Explicit list of the 10 PL rules in a short table.
- [ ] States: "Any change under `src/runtime/headless/vice1541/**` must cite Spec 612 rule numbers in the commit message."
- [ ] Cross-link to `specs/612-1541-port-fidelity-rules.md`.

**Depends on:** none (can run in parallel with T0.1).

---

## Phase 1 — Quarantine + salvage

### T1.1 — Quarantine current vice1541/
**Status:** OPEN
**Agent:** Sonnet
**Action:** `git mv src/runtime/headless/vice1541 src/runtime/headless/_quarantine_vice1541_v4`

**Acceptance:**
- [ ] Directory renamed via `git mv` (preserves history).
- [ ] All import sites updated: `kernel/headless-machine-kernel.ts`, `drive1541/drive1541-factory.ts`, `media/mount.ts`, any tests. (Grep `from ".*vice1541/"` and update.)
- [ ] `npm run build` green.
- [ ] Existing `drive1541Implementation="vice"` path still constructs `Vice1541` (now from quarantine dir) without runtime error — proves the rename was mechanical.

**Depends on:** none. (T0.1+T0.3 not blocking — can be parallel.)

---

### T1.2 — Create empty new vice1541/ + drivetypes.ts skeleton
**Status:** OPEN
**Agent:** Sonnet
**File:** `src/runtime/headless/vice1541/drivetypes.ts` (new)
**VICE source:** `vice/src/drive/drivetypes.h` + `vice/src/drive/drive.h`

**Acceptance:**
- [ ] `interface drive_t` with every field from `drive.h drive_s` (snake_case verbatim).
- [ ] `interface diskunit_context_t` with every field from `drivetypes.h diskunit_context_s` (sub-context pointers typed as the corresponding TS interface, nullable).
- [ ] `interface drivecpu_context_t` with every field from `drivecpu.h`.
- [ ] `interface drivecpud_context_t` with every field from `drive/iec/cia1571d.c` adjacency (drive-specific CPU data).
- [ ] No `class`. No `factory`. No getter/setter.
- [ ] `// PORT OF:` block at top of file.
- [ ] T0.1 fidelity check FC-1/FC-3/FC-4 PASS on this file.

**Depends on:** T1.1, T0.1.

---

### T1.3 — Salvage gcr.ts
**Status:** OPEN
**Agent:** Sonnet
**Source:** `_quarantine_vice1541_v4/gcr.ts`
**Target:** `src/runtime/headless/vice1541/gcr.ts`
**VICE:** `vice/src/diskimage/gcr.c` + `gcr.h`

**Acceptance:**
- [ ] Function names renamed to snake_case verbatim VICE names (e.g. `gcrConvert4BytesToGcr` → `gcr_convert_4bytes_to_GCR`). All 11 functions present.
- [ ] `// PORT OF: vice/src/diskimage/gcr.c:<line>-<line> (<name>)` on every export.
- [ ] Interfaces use snake_case field names from `gcr.h gcr_s`.
- [ ] T0.1 fidelity check PASS.
- [ ] Micro-test MT-gcr passes (`gcr_convert_sector_to_GCR` byte-for-byte equal to VICE for a fixed input sector).

**Depends on:** T1.1, T1.2.

---

### T1.4 — Salvage rotation.ts
**Status:** OPEN
**Agent:** Sonnet
**Source:** `_quarantine_vice1541_v4/rotation.ts`
**Target:** `src/runtime/headless/vice1541/rotation.ts`
**VICE:** `vice/src/drive/rotation.c` + `rotation.h`

**Acceptance:**
- [ ] Function names renamed snake_case verbatim. All 17 ported functions kept; P64 stubs explicit `throw new Error("PORT-STUB: P64 not implemented per Spec 612 OoS")`.
- [ ] Delete invented `rotation_get_state` / `rotation_set_state` accessors — snapshot module reads fields directly per VICE pattern.
- [ ] `drive_writeprotect_sense` moved out (belongs in `drive.ts`, not `rotation.ts`).
- [ ] Signatures match VICE: `rotation_rotate_disk(dptr: drive_t)`, not `(diskunit: diskunit_context_t)`.
- [ ] `// PORT OF:` block per function.
- [ ] T0.1 FC PASS.
- [ ] Micro-test MT-rotation passes.

**Depends on:** T1.2, T1.3.

---

### T1.5 — Salvage viacore.ts (consolidate VIA core)
**Status:** OPEN
**Agent:** Sonnet
**Source:** `_quarantine_vice1541_v4/via6522.ts` (1939 LOC, lazy-T1 fallback) AND `src/runtime/headless/via/via6522-vice.ts` (1341 LOC, write_offset configurable)
**Target:** `src/runtime/headless/vice1541/viacore.ts`
**VICE:** `vice/src/core/viacore.c` + `viacore.h`

**Acceptance:**
- [ ] ONE file. Pick `via/via6522-vice.ts` as base (better write_offset handling), port to snake_case, drop the duplicate.
- [ ] No `class Via6522`. Functions take `via_context_t` first arg.
- [ ] `via_context_t` interface in `drivetypes.ts` mirrors `via.h via_context_s` field-for-field.
- [ ] `write_offset` field on `via_context_t`, not a constructor option.
- [ ] Delete `maybeFireT1AtClk` — lazy fallback is NOT-IN-VICE.
- [ ] All 30+ exported functions: `viacore_setup_context`, `viacore_init`, `viacore_reset`, `viacore_signal`, `viacore_store`, `viacore_read`, `viacore_peek`, `viacore_disable`, the 5 alarm callbacks, `viacore_set_cb1`, `viacore_set_cb2`, `viacore_set_sr`, `viacore_cache_cb12_io_status`, `viacore_shutdown`, `viacore_snapshot_write_module`, `viacore_snapshot_read_module`, `viacore_dump`.
- [ ] T0.1 FC PASS.
- [ ] MT-viacore passes (T1/T2 alarm trace diff vs VICE).
- [ ] OLD `via/via6522-vice.ts` deleted.

**Depends on:** T1.2, T1.3.

---

### T1.6 — Salvage via1d1541.ts
**Status:** OPEN
**Agent:** Sonnet
**Source:** `_quarantine_vice1541_v4/via1d.ts` + `via/via1d1541.ts`
**Target:** `src/runtime/headless/vice1541/via1d1541.ts`
**VICE:** `vice/src/drive/iec/via1d1541.c`

**Acceptance:**
- [ ] ONE file. Consolidate the two existing backends.
- [ ] Functions: `via1d1541_setup_context`, `via1d1541_init`, `store_pra`, `store_prb`, `store_pcr`, `store_acr`, `store_sr`, `store_t2l`, `undump_pra/prb/pcr/acr`, `read_pra`, `read_prb`, `set_ca2`, `set_cb2`, `set_int`, `restore_int`, `reset`, `dump`. **Note:** these are all `static` in VICE — port them as module-private TS functions, exported only the constructor + register-write entry points.
- [ ] Install `rmw_flag` pointer per VICE wiring (PL-6).
- [ ] cpu_last_data echo per VICE viacore.c:64+70 (must be ported when `drivecpu_context_t.cpu_last_data` lands in T2.5).
- [ ] OLD `via/via1d1541.ts` deleted.
- [ ] T0.1 FC PASS.

**Depends on:** T1.5, T1.2.

---

### T1.7 — Salvage via2d.ts
**Status:** OPEN
**Agent:** Sonnet
**Source:** `_quarantine_vice1541_v4/via2d.ts`
**Target:** `src/runtime/headless/vice1541/via2d.ts`
**VICE:** `vice/src/drive/iecieee/via2d.c`

**Acceptance:**
- [ ] One file (current `via/via2d1541.ts` is a stub — delete it).
- [ ] All 19 functions ported.
- [ ] `readPb` default returns `(sync_found | wps | 0x6f)`, NOT `0x10`.
- [ ] `via2d_update_pcr` ported (currently missing).
- [ ] `set_int` stamps with `rclk`, not `clk_ptr.value`.
- [ ] Closure-captured state (`poldpb`, `ledActiveTicks`, `maxHalfTrackLocal`) moved onto `drive_t` fields per VICE.
- [ ] OLD `via/via2d1541.ts` deleted.
- [ ] T0.1 FC PASS.

**Depends on:** T1.5, T1.2.

---

## Phase 2 — Layer rewrites (audit-flagged divergents)

### T2.1 — drivemem.ts (function-pointer table)
**Status:** OPEN
**Agent:** Opus (novel layout decision: how to model function-pointer-table in TS)
**Target:** `src/runtime/headless/vice1541/drivemem.ts` (new)
**VICE:** `vice/src/drive/drivemem.c` + `drivemem.h`

**Acceptance:**
- [ ] 257-entry table: `read_tab: ReadFunc[][]`, `store_tab: StoreFunc[][]`, `peek_tab`, `read_base_tab`, `read_limit_tab` per VICE.
- [ ] `drivemem_set_func(ctx, start_page, end_page, read, store, peek?, base?, limit?)` exists.
- [ ] `drive_read_free`, `drive_store_free`, `drive_peek_free`, `drive_zero_read_watch`, `drive_zero_store_watch`, `drive_read_watch`, `drive_store_watch` — all ported.
- [ ] `drivemem_toggle_watchpoints` ported.
- [ ] `drivemem_init` allocates the page tables.
- [ ] `drivemem_bank_read/_peek/_store/_poke` ported.
- [ ] `drivemem_ioreg_list_get` ported.
- [ ] T0.1 FC PASS.

**Depends on:** T1.2.

---

### T2.2 — memiec.ts (drive-1541 memory map)
**Status:** OPEN
**Agent:** Sonnet
**Target:** `src/runtime/headless/vice1541/memiec.ts` (new)
**VICE:** `vice/src/drive/iec/memiec.c`

**Acceptance:**
- [ ] `memiec_init(unit)` installs the 1541 memory map onto the drive's `drivemem` page tables.
- [ ] All RAM mirrors (0x0000-0x07FF ×4), VIA1 mirrors at 0x18xx ×4, VIA2 mirrors at 0x1Cxx ×4, ROM at 0x8000 + 0xC000.
- [ ] RAM expansion regions (`drive_ram2/4/6/8/a_enabled`) ported.
- [ ] T0.1 FC PASS.

**Depends on:** T2.1.

---

### T2.3 — drive_6510core.ts (drive-specific 6510 core)
**Status:** OPEN
**Agent:** Opus (this is the biggest single port)
**Target:** `src/runtime/headless/vice1541/drive_6510core.ts` (new)
**VICE:** `vice/src/6510core.c` (with `#define DRIVE_CPU` paths only)

**Acceptance:**
- [ ] Full 6510core.c ported as a single function `drive_6510core_execute(ctx, alarm_dispatch)` matching VICE's `#include "6510core.c"` pattern.
- [ ] JAM signal exposed: `drive_6510core_execute` returns a JAM-reason int (0=none, 1=JAM_RESET_CPU, 2=JAM_POWER_CYCLE, 3=JAM_MONITOR).
- [ ] All 256 opcodes including undocumented.
- [ ] Mid-cycle CLK updates (per-cycle `*clk_ptr++` in the VICE source) preserved.
- [ ] `last_opcode_info`, `bank_base`, `bank_limit` bookkeeping ported.
- [ ] Interrupt pipeline (`check_irq_delay`, `check_nmi_delay`) ported.
- [ ] **Cpu65xxVice is NOT reused.** PL-4.
- [ ] T0.1 FC PASS.
- [ ] Micro-test MT-drive_6510core: cold-reset + 200k cycle CPU trace diff vs VICE.

**Depends on:** T2.1, T2.2.

---

### T2.4 — drivecpu.ts (with JAM dispatch + trap handler)
**Status:** OPEN
**Agent:** Opus
**Target:** `src/runtime/headless/vice1541/drivecpu.ts` (new)
**VICE:** `vice/src/drive/drivecpu.c`

**Acceptance:**
- [ ] `drivecpu_setup_context`, `drivecpu_init`, `drivecpu_shutdown`, `drivecpu_reset`, `cpu_reset`, `drivecpu_reset_clk`, `drivecpu_trigger_reset`, `drivecpu_execute`, `drivecpu_sleep`, `drivecpu_wake_up`, `drivecpu_set_overflow`, `drivecpu_set_bank_base`.
- [ ] `drivecpu_jam` with all 4 branches: `JAM_RESET_CPU`, `JAM_POWER_CYCLE`, `JAM_MONITOR`, default-CLK++.
- [ ] `drive_trap_handler` ported — PC redirect at `unit->trap → unit->trapcont` + `alarm_context_next_pending_clk` idle-skip path.
- [ ] `drivecpu_snapshot_write_module` / `_read_module` ported (VSF chunk).
- [ ] No `EXECUTE_SAFETY_CAP`. PL-5.
- [ ] No manual reset-vector fetch — `cpu_reset()` lets the CPU pull the vector through `drive_6510core_execute`. PL-8.
- [ ] T0.1 FC PASS.
- [ ] Micro-test MT-drivecpu passes.

**Depends on:** T2.3, T1.5, T1.6, T1.7.

---

### T2.5 — drivesync.ts (full port)
**Status:** OPEN
**Agent:** Sonnet
**Target:** `src/runtime/headless/vice1541/drivesync.ts` (new)
**VICE:** `vice/src/drive/drivesync.c`

**Acceptance:**
- [ ] `drive_sync_cpu_set_factor`, `drivesync_factor`, `drive_set_machine_parameter`, `drivesync_set_1571`, `drivesync_set_4000`, `drivesync_clock_frequency`.
- [ ] `sync_factor` module-level variable (NL-5).
- [ ] `drv->clock_frequency` table per drive type.
- [ ] No `AttachClkState` helper — delete it. PL-5.
- [ ] T0.1 FC PASS.

**Depends on:** T1.2.

---

### T2.6 — fsimage_dxx.ts (D64 GCR encode)
**Status:** OPEN
**Agent:** Sonnet
**Target:** `src/runtime/headless/vice1541/fsimage_dxx.ts` (new)
**VICE:** `vice/src/diskimage/fsimage-dxx.c`

**Acceptance:**
- [ ] `fsimage_dxx_read_image`, `fsimage_dxx_write_image`, `fsimage_dxx_read_sector`, `fsimage_dxx_write_sector` etc. — list from VICE.
- [ ] GCR encode loop per VICE fsimage-dxx.c:262-304 (sector→GCR + per-track skew).
- [ ] Writeback path: `fsimage_dxx_write_half_track` decodes a dirty GCR track back into D64 sector bytes. Currently missing.
- [ ] T0.1 FC PASS.

**Depends on:** T1.3 (gcr).

---

### T2.7 — fsimage_gcr.ts (G64 parse/serialise)
**Status:** OPEN
**Agent:** Sonnet
**Target:** `src/runtime/headless/vice1541/fsimage_gcr.ts` (new)
**VICE:** `vice/src/diskimage/fsimage-gcr.c`

**Acceptance:**
- [ ] All `fsimage_gcr_*` functions ported.
- [ ] Half-track buffer alloc for empty tracks (per VICE fsimage-gcr.c:170-173).
- [ ] G64 write path (writeback).
- [ ] T0.1 FC PASS.

**Depends on:** T1.3.

---

### T2.8 — driveimage.ts (with writeback)
**Status:** OPEN
**Agent:** Sonnet
**Target:** `src/runtime/headless/vice1541/driveimage.ts` (new)
**VICE:** `vice/src/drive/driveimage.c`

**Acceptance:**
- [ ] `drive_image_attach`, `drive_image_detach`, `drive_image_type_to_drive_type`, `drive_check_image_format`, `drive_image_init`, `drive_gcr_data_writeback`, `drive_gcr_data_writeback_all`.
- [ ] `disk_image_t` struct interface in `drivetypes.ts`.
- [ ] **No** `Drive1541Media` discriminated union inside this file. PL-2.
- [ ] `drive_image_detach` calls `drive_gcr_data_writeback` BEFORE freeing the GCR buffer. CRITICAL — audit showstopper.
- [ ] T0.1 FC PASS.

**Depends on:** T2.6, T2.7, T1.4.

---

### T2.9 — driverom.ts (with traps)
**Status:** OPEN
**Agent:** Sonnet
**Target:** `src/runtime/headless/vice1541/driverom.ts` (new)
**VICE:** `vice/src/drive/driverom.c`

**Acceptance:**
- [ ] `driverom_test_load`, `driverom_load`, `driverom_load_images`, `driverom_initialize_traps`, `driverom_snapshot_write`, `driverom_snapshot_read`, `driverom_init`.
- [ ] `driverom_initialize_traps` patches the idle trap opcode into `unit->trap_rom[$EC9B - $8000]` for 1541. CRITICAL — audit showstopper.
- [ ] `driverom_load` returns -1 on missing ROM and disables the drive. PL-7 — NO zero-filled fallback.
- [ ] Per-drive-type ROM size table per VICE.
- [ ] T0.1 FC PASS.

**Depends on:** T1.2.

---

### T2.10 — drive.ts (drive_init etc.)
**Status:** OPEN
**Agent:** Opus (lifecycle ordering is subtle)
**Target:** `src/runtime/headless/vice1541/drive.ts` (new)
**VICE:** `vice/src/drive/drive.c`

**Acceptance:**
- [ ] `drive_init`, `drive_setup_context`, `drive_shutdown`, `drive_enable`, `drive_set_active_led_color`, `drive_set_disk_drive_type`, `drive_get_disk_drive_type`, `drive_set_last_read`, `drive_jam`, `drive_is_jammed`, `drive_jam_reason`, `drive_move_head`, `drive_set_half_track`, `drive_gcr_data_writeback` (delegates to T2.8), `drive_gcr_data_writeback_all`, `drive_cpu_execute_one`, `drive_cpu_execute_all`, `drive_cpu_set_overflow`, `drive_cpu_trigger_reset`, `drive_cpu_trigger_reset_button`, `drive_vsync_hook`, `drive_led_update`, `drive_update_ui_status`, `drive_has_buttons`.
- [ ] Init order EXACTLY VICE drive.c:229-296. PL-8.
- [ ] `drive_set_half_track(num, side, drive)` signature verbatim (currently TS has reordered args).
- [ ] **No** `enable = 1` write in `drive_init` — VICE writes it in `drive_enable`. Audit finding.
- [ ] T0.1 FC PASS.

**Depends on:** T2.4, T2.5, T2.8, T2.9.

---

### T2.11 — iecbus.ts (with conf2/conf3 + multi-drive)
**Status:** OPEN
**Agent:** Sonnet
**Target:** `src/runtime/headless/vice1541/iecbus.ts` (new)
**VICE:** `vice/src/iecbus/iecbus.c` + `iecbus.h`

**Acceptance:**
- [ ] All 14 non-trivial functions ported.
- [ ] `iecbus_cpu_read_conf2/_write_conf2` real implementation (not delegate).
- [ ] `iecbus_cpu_read_conf3/_write_conf3` real implementation with multi-drive loop.
- [ ] Per-unit-type drv_bus formula (1581 / 2000 / 4000 / CMDHD / 1541 default) ported.
- [ ] Per-unit-type ATN-edge dispatch (CIA flag vs VIA_SIG_CA1 vs VIA_SIG_CA2).
- [ ] OLD `src/runtime/headless/iec/iec-bus-core.ts` deleted (or kept only for LEGACY1541; gated by import-allowlist in T0.1 FC-3).
- [ ] T0.1 FC PASS.

**Depends on:** T1.6.

---

### T2.12 — c64iec.ts (replaces cia2-stub)
**Status:** OPEN
**Agent:** Sonnet
**Target:** `src/runtime/headless/vice1541/c64iec.ts` (new)
**VICE:** `vice/src/c64/c64iec.c` + relevant slice of `vice/src/c64/c64cia2.c`

**Acceptance:**
- [ ] `iec_update_cpu_bus`, `iec_update_ports`, `iec_update_ports_embedded`, `iec_drive_write`, `iec_drive_read`, `iecbus_drive_port`, `iec_available_busses`, `c64iec_init`, `c64iec_enable`, `c64iec_get_active_state`.
- [ ] Real CIA2 PA/PB/DDR/ICR slice for IEC bits (not stub).
- [ ] Reset state: DDRA = 0, NOT 0x3f. PL-7-spirit (no lying about init state).
- [ ] OLD `src/runtime/headless/iec/cia2-stub.ts` deleted.
- [ ] T0.1 FC PASS.

**Depends on:** T2.11.

---

### T2.13 — iec.ts (drive-side helpers)
**Status:** OPEN
**Agent:** Sonnet
**Target:** `src/runtime/headless/vice1541/iec.ts` (new)
**VICE:** `vice/src/drive/iec/iec.c`

**Acceptance:**
- [ ] `iec_drive_resources_init`, `iec_drive_shutdown`, `iec_drive_cmdline_options_init`, `iec_drive_init`, `iec_drive_reset`, `iec_drive_mem_init`, `iec_drive_setup_context`, `iec_drive_idling_method`, `iec_drive_rom_load`, `iec_drive_rom_setup_image`, `iec_drive_rom_check_loaded`, `iec_drive_rom_do_checksum`, `iec_drive_snapshot_read`, `iec_drive_snapshot_write`, `iec_drive_image_attach`, `iec_drive_image_detach`, `iec_drive_port_default`.
- [ ] OLD `_quarantine_vice1541_v4/iec-bus.ts` does NOT come over — it was a parallel rewrite (audit DIVERGENT). PL-10.
- [ ] T0.1 FC PASS.

**Depends on:** T2.2, T2.9, T2.10.

---

### T2.14 — drive_snapshot.ts (VSF chunks)
**Status:** OPEN
**Agent:** Sonnet
**Target:** `src/runtime/headless/vice1541/drive_snapshot.ts` (new)
**VICE:** `vice/src/drive/drive-snapshot.c`

**Acceptance:**
- [ ] `drive_snapshot_write_module`, `drive_snapshot_read_module`, `drive_snapshot_write_image_module`, `drive_snapshot_read_image_module`, `drive_snapshot_write_gcrimage_module`, `drive_snapshot_read_gcrimage_module`, `drive_snapshot_write_p64image_module` (stub), `drive_snapshot_read_p64image_module` (stub).
- [ ] Per-module name + version chunks per VICE — NOT a flat blob. PL-9.
- [ ] No `V1541SNP` magic.
- [ ] No `as unknown as Via6522Internals` casts.
- [ ] `vice1541Snapshot()` / `vice1541Restore()` are NOT in this file — they belong on the facade outside `vice1541/`.
- [ ] T0.1 FC PASS.

**Depends on:** T2.4, T2.9, T1.4, T2.8.

---

## Phase 3 — Integration

### T3.1 — Wire new vice1541 behind Drive1541 facade
**Status:** OPEN
**Agent:** Opus
**Files:** `src/runtime/headless/drive1541/drive1541-factory.ts`, `src/runtime/headless/kernel/headless-machine-kernel.ts`

**Acceptance:**
- [ ] `createDrive1541("vice")` instantiates a thin facade class (outside `vice1541/`) that calls the snake_case functions from the port.
- [ ] Facade class implements `Drive1541` interface verbatim — no extra methods.
- [ ] `installVice1541Bridge` unchanged in spirit, but reads from `iecbus.ts` getters (not closure refs).
- [ ] Runtime proof gates (Spec 600) run against `drive1541Implementation="vice"`; result documented (PASS/FAIL count) but not gating this TODO.

**Depends on:** all of Phase 2.

---

### T3.2 — Delete _quarantine_vice1541_v4
**Status:** OPEN
**Agent:** Sonnet
**Action:** `git rm -r src/runtime/headless/_quarantine_vice1541_v4`

**Acceptance:**
- [ ] All Phase 2 tasks DONE.
- [ ] Runtime proof gates with `drive1541Implementation="vice"` at LEAST match LEGACY1541 5/7 GREEN baseline.
- [ ] T0.1 fidelity check PASS on whole `vice1541/`.

**Depends on:** T3.1 + every Phase 2 task.

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
