# Spec 001: Project Audit

Status: done for the initial integrity pass. Follow-up repair behavior
lives in Spec 006.

## Problem

Agents and tools can leave a project in a state that looks successful in
tool output but is incomplete in the UI. Known failure modes include
nested knowledge stores, unregistered files, unimported analysis JSON,
stale views, and artifact paths that are relative to the wrong working
directory.

## Tool

Add MCP tool:

```text
project_audit(project_dir?: string, include_file_scan?: boolean)
```

`project_dir` resolves through the same project-root helper used by the
other tools. The output must include the resolved root.

## Checks

- nested `knowledge/` directories below the resolved root
- registered artifacts whose files do not exist
- files under `analysis/`, `artifacts/`, `media/`, and `views/` that
  look important but are not registered
- analysis or manifest artifacts that are registered but not imported
- views older than their source knowledge files
- artifact paths that escape the project root or point into nested CWD
  locations

## Output Shape

Return a human-readable summary and machine-readable JSON with:

- `root`
- `severity`
- `findings[]`
- `suggestedActions[]`
- `safeRepairAvailable`

Each finding includes:

- `id`
- `severity`
- `title`
- `paths[]`
- `whyItMatters`
- `suggestedFix`

## Acceptance Criteria

- Running audit on a clean project reports no high-severity findings.
- Running audit on a project with `media/knowledge/entities.json`
  reports the nested store and the root it should merge into.
- Running audit after editing knowledge but before rebuilding views
  reports stale views.
- The tool never mutates project files.

## Tests

- Extend `scripts/project-knowledge-smoke.mjs`.
- Add fixtures for nested knowledge and stale views.
- Verify audit output includes absolute paths for diagnosis and
  project-relative paths for UI/reporting.
