# Spec 024: Mechanics And Cleanup

## Problem

Six small but compounding hygiene issues block clean Sprint 16-20
work:

- Sprint 9 left several MCP tool families unwrapped by `safeHandler`,
  so failures in `payloads.ts`, `compression.ts`, `sandbox.ts`,
  `headless.ts`, `vice.ts`, and the listing/save tools in
  `project-knowledge/mcp-tools.ts` still escape as unhandled
  rejections.
- Bug 9: `register_existing_files` silently reports zero matches
  with no diagnostic on the resolved walk root.
- Bug 10: same path can be registered twice as different artifacts
  (no `relativePath` dedup).
- Bug 14: `*_disasm_rebuild_check.prg` artifacts pollute the
  disk-layout view as if they were source PRGs.
- R4: agents have to enumerate every c64re-produced extension
  manually because `register_existing_files` has no built-in default
  pattern set.

## Goal

Close the housekeeping debt in one focused sprint so subsequent
quality / visibility / platform work does not have to re-touch the
same surface area.

## Approach

### safeHandler completion (Sprint 9 closeout)

Wrap remaining handlers in:

- `src/server-tools/payloads.ts`
- `src/server-tools/compression.ts`
- `src/server-tools/sandbox.ts`
- `src/server-tools/headless.ts`
- `src/server-tools/vice.ts`
- `src/project-knowledge/mcp-tools.ts`

Each wrap is mechanical; preserve return shapes, only the error
path changes per Spec 007.

### Bug 9 — glob diagnostics

In `register_existing_files`:

1. Document glob semantics in the tool description (relative to
   `project_dir`, supports `*` `**` minimatch).
2. When `Candidates scanned: 0`, include the resolved walk root,
   the patterns expanded, and a list of subdirectories observed at
   the root in the response payload.
3. Add an explicit `dry_run: true` flag that lists matches without
   registering anything.

### Bug 10 — path dedup

In `save_artifact` and `register_existing_files`:

1. Index artifacts by `relativePath` on load.
2. On save, if `relativePath` already exists, default to
   `update existing record` (merge title/role/kind if newer is
   non-empty) and increment a `Skipped (duplicate path)` counter.
3. Add a `dedup_strategy: "update" | "skip" | "reject"` arg, default
   `update`.

### Bug 14 — rebuild-check classification

In `disasm_prg`:

1. When the rebuild verification step writes
   `<basename>_disasm_rebuild_check.prg`, register it via
   `save_artifact(kind: "report", role: "rebuild-check", derivedFrom:
   <original-id>)` instead of leaving it for blanket registration.
2. `register_existing_files` default globs (R4) exclude
   `*_disasm_rebuild_check.prg`.
3. Disk-layout / payloads view filters artifacts with `role:
   "rebuild-check"` by default; adds an "Include rebuild checks"
   toggle.

### R4 — default glob set

`register_existing_files()` with no `patterns` runs a built-in
default glob set. Map per REQUIREMENTS R4 table:

```ts
const DEFAULT_PATTERNS = [
  { glob: "input/disk/*.{d64,g64}", kind: "d64", scope: "input", role: "source-disk" },
  // ... full table from R4
];
```

Document in the tool description that no-arg invocation runs this
set.

## Acceptance Criteria

- A deliberately failing handler in any of the six wrapped files
  returns the Spec 007 error envelope and the stdio process keeps
  running.
- `register_existing_files` with a non-matching pattern returns the
  walk root and observed subdirs in the response.
- Re-registering the BWC project produces zero new duplicate
  artifacts; the existing duplicate `motm.g64` rows merge on next
  save.
- Disk-layout view on the Murder project no longer shows
  `*_disasm_rebuild_check.prg` rows by default.
- `register_existing_files()` with no args registers all c64re
  extensions on a fresh project end to end.

## Tests

- Smoke: induce a failure in one handler per wrapped file, assert
  Spec 007 envelope.
- Smoke: zero-match `register_existing_files` reports walk root.
- Smoke: double-save same artifact path, assert single entry in
  `artifacts.json`.
- Smoke: bootstrap fixture, run no-arg `register_existing_files`,
  assert it covers every produced file.

## Out Of Scope

- Re-architecting tool registration.
- Garbage-collecting orphan rebuild-check PRG files on disk.

## Dependencies

- None. Run first, parallel to all other sprints.
