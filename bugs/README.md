# Bugs

Human + LLM E2E bug log for the C64RE MCP/UI product flow.

- Copy `TEMPLATE.md` → `BUG-<NNN>-<slug>.md`, fill it in.
- One file per bug. Keep evidence verbatim (exact error / wrong output).
- `Status` lives in the file header (open / investigating / fixed / wontfix / duplicate).
- On fix, fill the **Resolution** section and name the gate proving it.

| ID | Title | Area | Severity | Status |
|----|-------|------|----------|--------|
| BUG-001 | `/v3.html` opens project dashboard instead of C64 Runtime Workbench | ui-v3 | blocker | fixed (597ad85) |
| BUG-002 | v1 legacy UI is still served as a separate product entry | workspace-ui | high | open |
| BUG-003 | `extract_disk` manifest import fails on empty CBM directory filename | mcp-tool | high | fixed (17bad20) |
| BUG-004 | `build_all_views` crashes on empty manifest item title/name | knowledge | high | fixed (17bad20) |
| BUG-005 | Agent/audit recommends tools that are not exposed in MCP surface | mcp-tool | blocker | conceptual / spec-needed |
| BUG-006 | `agent_onboard` reports filesystem/artifact store “in sync” for empty unverified workspace | mcp-tool | medium | fixed (ba181dc) |
| BUG-007 | BASIC PRGs at `$0801` are treated as 6502 code instead of BASIC programs | analysis | low | open |
| BUG-008 | Disk tab selection jumps back to first disk | ui-v3 | high | open |
| BUG-009 | Disk file list scrolls the whole page instead of the list panel | ui-v3 | medium | open |
| BUG-010 | Workspace UI Live tab does not start/connect Headless Runtime backend | workspace-ui | blocker | fixed (700b398) |
| BUG-011 | Analysis tabs render raw JSON instead of usable UI views | ui-v3 | high | open |
| BUG-012 | Media tabs render raw JSON instead of usable UI views | ui-v3 | high | open |
