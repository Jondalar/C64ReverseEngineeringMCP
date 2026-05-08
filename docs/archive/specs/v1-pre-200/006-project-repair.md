# Spec 006: Project Repair

Status: initial implementation exists as `project_repair`; dry-run is
default and safe mode is non-destructive.

## Problem

Once audit finds broken state, agents need a safe repair path. Manual
`jq` merges and ad-hoc file moves are too risky and too hard to repeat.

## Tool

Add MCP tool:

```text
project_repair(
  project_dir?: string,
  mode?: "dry-run" | "safe",
  operations?: Array<"merge-fragments" | "register-artifacts" | "import-analysis" | "build-views">
)
```

Default mode must be `dry-run`.

## Safe Operations

Safe repair may:

- merge nested knowledge stores by stable `id`
- register obvious existing artifacts without changing their contents
- import registered analysis and manifest artifacts
- rebuild views

Safe repair must not:

- invent semantic conclusions
- delete source artifacts
- overwrite newer records with older records
- move files unless explicitly requested by a future unsafe mode

## Output

Return:

- planned operations
- executed operations
- records added/updated
- files changed
- skipped items with reasons

## Acceptance Criteria

- Dry-run reports exactly what would change.
- Safe mode can repair the known nested-knowledge fragmentation case.
- Merge conflicts are reported instead of silently overwritten.
- After safe repair and `build_all_views`, dashboard counts match root
  knowledge stores.

## Tests

- Fixture with root plus nested stores.
- Fixture with registered but unimported analysis JSON.
- Fixture with stale views.
