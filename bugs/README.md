# Bugs

Human + LLM E2E bug log for the C64RE MCP/UI product flow.

- Copy `TEMPLATE.md` → `BUG-<NNN>-<slug>.md`, fill it in.
- One file per bug. Keep evidence verbatim (exact error / wrong output).
- `Status` lives in the file header (open / investigating / fixed / wontfix / duplicate).
- On fix, fill the **Resolution** section and name the gate proving it.

| ID | Title | Area | Severity | Status |
|----|-------|------|----------|--------|
| BUG-001 | `/v3.html` opens project dashboard instead of C64 Runtime Workbench | ui-v3 | blocker | fixed (597ad85) |
