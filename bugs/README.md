# Bugs

Human + LLM E2E bug log for the C64RE MCP/UI product flow.

- Copy `TEMPLATE.md` → `BUG-<NNN>-<slug>.md`, fill it in.
- One file per bug. Keep evidence verbatim (exact error / wrong output).
- `Status` lives in the file header (open / investigating / fixed / wontfix / duplicate).
- On fix, fill the **Resolution** section and name the gate proving it.

| ID | Title | Area | Severity | Status |
|----|-------|------|----------|--------|
| BUG-001 | `/v3.html` opens project dashboard instead of C64 Runtime Workbench | ui-v3 | blocker | fixed (597ad85) |
| BUG-002 | v1 legacy UI is still served as a separate product entry | workspace-ui | high | fixed (ec0a1e1) |
| BUG-003 | `extract_disk` manifest import fails on empty CBM directory filename | mcp-tool | high | fixed (17bad20) |
| BUG-004 | `build_all_views` crashes on empty manifest item title/name | knowledge | high | fixed (17bad20) |
| BUG-005 | Agent/audit recommends tools that are not exposed in MCP surface | mcp-tool | blocker | fixed (Spec 730 orchestrator + machine-readable next-step) |
| BUG-006 | `agent_onboard` reports filesystem/artifact store “in sync” for empty unverified workspace | mcp-tool | medium | fixed (ba181dc) |
| BUG-007 | BASIC PRGs at `$0801` are treated as 6502 code instead of BASIC programs | analysis | low | closed → backlog (Spec 731) |
| BUG-008 | Disk tab selection jumps back to first disk | ui-v3 | high | fixed |
| BUG-009 | Disk file list scrolls the whole page instead of the list panel | ui-v3 | medium | fixed |
| BUG-010 | Workspace UI Live tab does not start/connect Headless Runtime backend | workspace-ui | blocker | fixed (700b398) |
| BUG-011 | Analysis tabs render raw JSON instead of usable UI views | ui-v3 | high | fixed (4c4fdc7 — real viz) |
| BUG-012 | Media tabs render raw JSON instead of usable UI views | ui-v3 | high | fixed (4c4fdc7 — real viz) |
| BUG-013 | Live Drive insert menu mixes project media with C64RE dev samples | ui-v3 | medium | fixed |
| BUG-014 | Migrated workspace views lost shared Inspector and original layout | ui-v3 | high | fixed (bcbd770) |
| BUG-015 | Project init leaves media unsorted instead of placing it under typed `input/` folders | mcp-tool | medium | fixed |
| BUG-016 | Live C64 frame scales too large and pushes Monitor out of view | ui-v3 | medium | fixed |
| BUG-017 | Disk geometry lacks track/sector navigation for occupied non-directory data | ui-v3 | medium | fixed|
| BUG-018 | Product UI lacks visible runtime connection/session status for LLM-human coordination | ui-v3 | medium | fixed |
| BUG-019 | UI shows stale ASM version instead of latest/best artifact version | workspace-ui / knowledge | high | fixed (A: 8d4faf3d; B: Spec 730 §7 artifact version store) |
| BUG-020 | Header hero contains dashboard metrics and filters | workspace-ui | medium | open |
| BUG-021 | Spec 741 fixture: relocated loader is demoted to unknown instead of rendered as runtime code | analysis | high | fixed (Spec 741 A–D; smoke-741 50/50) |
| BUG-022 | `.gitignore` `analysis/` rule also ignores `pipeline/src/analysis/` source | build / repo-hygiene | medium | fixed |
| BUG-023 | Custom true-drive (drive-side GCR) writes not persisted to host .d64/.g64 file (Wasteland Utils Copy + Scramble HighScore) | runtime | high | fixed (VICE-faithful write-through: fsimage_*_write_half_track → hostFlush writes the host file at the writeback commit; `smoke:023-write-through` 7/7 re-reads file+mtime, no unmount. Doctrine: VICE fwrite must map to host writes; tests re-read FS) |
| BUG-023-cart | Writable cartridge (EasyFlash) flash writes not persisted to host .crt | runtime | medium | fixed (EasyFlash `getCrtImage` re-pack + `persistCartridgeToFile` writes host .crt on eject; `smoke:023-cart` 7/7. Spec 742) |
| BUG-024 | Code-derived disk loads (no CBM dir / no on-disk LUT) can't be registered as rich payloads — `save_entity` makes thin records | mcp-tool | medium | fixed (`register_payload` promoted to default + `source_prg_path` + ASM stem-match; `save_entity` redirects payloads; gate `e2e:024` 15/15) |
| BUG-025 | Inspector/Frozen overlay poisons Pause/Run resume with alarm-dispatch guard | runtime / live-ui / inspector | high | fixed (Spec 743 — maincpu CLOCK made monotonic, no clkguard; removed u32/0xffffffff on absolute clk across CPU+alarm+interrupt+VIC+CIA/ciat/TOD; `probe:743` 42/42 + cia-suite 16/16 + 7-game PNGs read) |
| BUG-026 | Host ESC is mapped to RUN/STOP instead of C64 ESC | runtime / live-ui / keyboard | medium | fixed (ESC→C64 ← / ^→CTRL / TAB→RUN/STOP in keymap.ts + Live.tsx; `smoke:026` 11/11) |
| BUG-027 | Cannot reach in-game from a boot: trace worker module-not-found, no workable in-disk "insert side N" swap, headless free-runs ~100% CPU when idle | runtime | high | partial (Blocker 1 trace-worker FIXED 744.2 `e2e:744-2`; Blocker 3 idle-CPU FIXED — MCP runtime is idle-bounded `probe:744-idle` 8/8 + `runtime_session_close` `probe:744-3`; shared MCP+UI authority FIXED via Runtime Daemon 744.4c (`e2e:744-4c` 9/9 — MCP+UI both clients of one stable runtime, reconnect/reload do NOT reset; 744.4a in-process `smoke:744-4` 16/16, 744.4b co-host RETIRED); Blocker 2 disk-swap OPEN — hardware-style eject→run→mount playbook shipped, but `runtime_swap_disk_and_continue` (§7.2) not implemented, needs a runtime swap trace) |
| BUG-028 | Runtime input/drive tools not daemon-routed: `runtime_type` (et al.) fail "No integrated session" on the shared daemon session while `runtime_session_status`/`runtime_render_screen` work — can read shared session, can't drive it | mcp-tool / runtime | high | fixed |
| BUG-029 | Trace-store reads (`runtime_swimlane_slice`/`trace_store_*`) fail "Could not set lock" while the daemon process is live (DuckDB cross-process lock); store reads fine once the daemon exits. Fix = route trace reads through the daemon (746.5). | trace-store / runtime daemon | medium | fixed |
