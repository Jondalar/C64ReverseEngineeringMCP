# Spec 007: Tool Output Contract

## Problem

Tool success messages can hide missing workflow steps. Agents then stop
early because the tool appeared done.

## Standard Output

Every project-aware tool should include:

```text
Project root: <absolute path>
Knowledge written to: <absolute path>/knowledge
Artifacts written:
- <project-relative path> (<role>, registered: yes/no)
Knowledge imported: yes/no/not-applicable
Views rebuilt: yes/no/not-applicable
Next required step: <none | command/tool name>
```

## Error Output

Errors should include:

- resolved root if available
- failing phase
- input path
- whether any files were written before failure
- recommended next action

## Acceptance Criteria

- Agents can decide the next workflow step from tool output alone.
- Low-level tools no longer report "success" without saying whether the
  project workflow is complete.
- Tool outputs are consistent enough to include in docs and prompt
  contracts.

## Tests

- Snapshot tests or smoke assertions for key tools.
- At minimum cover `project_init`, `analyze_prg`, `disasm_prg`,
  `extract_disk`, `extract_crt`, `import_analysis_report`, and
  `build_all_views`.
