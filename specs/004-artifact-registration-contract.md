# Spec 004: Artifact Registration Contract

## Problem

Agents can use MCP logic locally or through low-level tools and leave
files behind without artifact records. Later UI and workflow tools then
cannot find or explain those files.

## Contract

Any tool that creates or materially updates a project file must either:

- register the artifact itself, or
- return a blocking warning that the artifact must be registered before
  the workflow is complete.

Artifact paths must always be relative to the resolved project root.

## Required Fields

Artifact records must include:

- stable id
- role/kind
- project-relative path
- source tool
- created/updated timestamp
- optional source input id/path
- optional import status for knowledge-bearing artifacts

## Low-Level Tool Behavior

Low-level tools remain callable, but their output must say:

```text
Knowledge written to: <root>/knowledge
Artifacts written:
- <relative path> (registered: yes/no)
Next required step: import/build/none
```

## Acceptance Criteria

- No project tool writes an artifact path relative to process CWD.
- Analysis JSON and manifests are immediately registered.
- Tools that do not import their own output clearly say which import
  tool should run next.
- `project_audit` can detect contract violations.

## Tests

- Nested CWD artifact save test.
- Tool-run output snapshot for at least `analyze_prg`, `disasm_prg`,
  `extract_disk`, and `extract_crt`.
