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
| BUG-023 | Custom true-drive (drive-side GCR) writes not persisted to D64-backed image (Wasteland Utils Copy + Scramble HighScore) | runtime | high | fixed (snapshot/dump writeback-all hook was no-op; wired to real `drive_gcr_data_writeback_all`; `smoke:023-snapshot-flush` 4/4) |
| BUG-024 | Code-derived disk loads (no CBM dir / no on-disk LUT) can't be registered as rich payloads — `save_entity` makes thin records | mcp-tool | medium | open |
