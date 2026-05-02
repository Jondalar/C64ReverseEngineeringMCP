# Spec 025: Artifact Lineage And Versions

## Problem

A reverse-engineering effort on a single binary produces a chain of
related artifacts, e.g.:

| Label | Path | Kind | Relation |
|-------|------|------|----------|
| V0 | `extracted/sample.bin` | raw | binary extract |
| V1 | `analysis/sample_disasm.asm` | listing | non-semantic disasm of V0 |
| V2 | `analysis/sample_disasm.asm` | listing | semantic disasm 1.0 (overwrites V1 same path) |
| V3 | `analysis/sample_disasm_v15.asm` | listing | semantic 1.5 with cross-refs |
| V4 | `analysis/sample_disasm_v15_mod.asm` | listing | hand-modified from V3 |

Today the workspace UI shows five independent rows with no
relationship. Users lose track of which artifact supersedes which,
and same-path overwrites silently destroy the prior content.

## Goal

Express two orthogonal kinds of "version":

1. **Lineage chain** across paths — V0 → V1 → ... → Vn linked by
   `derivedFrom`. UI groups by lineage root.
2. **Same-path history** — V1 and V2 share a path; the second save
   appends a content-hash entry to `versions[]` and snapshots the
   prior bytes so V1 is recoverable without git.

Snapshots default ON because c64re binaries are small (KB to a few
MB) and runtime traces already dwarf any artifact storage.

## Approach

### Schema

Extend `ArtifactRecord` (in `src/project-knowledge/types.ts`):

```ts
lineageRoot?: string;        // id of V0; rooted via derivedFrom walk
derivedFrom?: string;        // direct parent artifact id
versionLabel?: string;       // free-form, user-renameable (default "V<rank>")
versionRank?: number;        // 0 for root, parent.rank + 1 otherwise
versions?: Array<{           // same-path history; latest = current bytes
  contentHash: string;       // sha256 hex
  capturedAt: string;
  snapshotPath?: string;     // <root>/snapshots/<artifact-id>/<hash>.bin
}>;
```

`derivedFrom` reuses the existing convention; `sourceArtifactIds`
stays for many-to-one relations and is not part of the linear chain.

### Auto-lineage on save

In `service.saveArtifact`:

1. If `derivedFrom` is set, look up the parent. Compute
   `lineageRoot = parent.lineageRoot ?? parent.id` and
   `versionRank = parent.versionRank + 1` (or 1 if the parent has no
   rank yet).
2. Else `lineageRoot = self.id`, `versionRank = 0`.
3. `versionLabel` defaults to `V${versionRank}` when not supplied.

### Same-path history

In `service.saveArtifact`:

1. Resolve `absPath` from `input.path`.
2. If the file exists on disk and a record with the same `path`
   already exists, compute the sha256 of the new file content.
3. If the new hash differs from the latest entry in `versions[]`:
   - Snapshot the *prior* on-disk file (before overwrite) to
     `<root>/snapshots/<artifact-id>/<priorHash>.bin`.
   - Append `{contentHash: priorHash, capturedAt, snapshotPath}` to
     `versions[]` of the existing record.
   - The current record's "current bytes" pointer is implicitly the
     on-disk file at `path` (no separate field).
4. If the hash matches, skip — no new version entry.

The save tool itself receives an `enable_snapshot?: boolean` arg
(default `true`); set to `false` for ephemeral one-off saves.

### Rename

New MCP tool `rename_artifact_version(artifact_id, version_label)`
that updates `versionLabel` only. Idempotent.

### Lineage helper

`service.getLineage(artifactId): ArtifactRecord[]` — walks
`derivedFrom` chain root-down and returns the list ordered by
`versionRank`.

### UI grouping

In the Artifacts / Findings / Entities tabs (Sprint 18):

1. Default group = `lineageRoot`. One card per lineage with V0 title.
2. Card header shows `V0 title (5 versions, latest = V4 "mod")` with
   the latest version highlighted.
3. Expand → ordered list `V0 → V1 → V2 → V3 → V4`. Click a row →
   opens the artifact detail panel for that version.
4. Same-path history (the `versions[]` of any single artifact) is
   shown as a sub-list under that artifact's detail.
5. Rename label inline.

### Snapshot directory

Snapshots live under `<projectRoot>/snapshots/<artifact-id>/<hash>.bin`.
The dir is gitignored by default (template `.gitignore` adds
`snapshots/`). `project_audit` reports total snapshot size and the
artifact with the most snapshots so the human can prune if wanted.

## Acceptance Criteria

- A V0→V4 chain (5 saveArtifact calls with `derivedFrom`) yields
  one lineage in the UI with 5 expandable rows in V0..V4 order.
- Re-running `disasm_prg` with new content overwrites the file but
  preserves the prior bytes in `snapshots/<id>/<hash>.bin` and
  appends to `versions[]`.
- `rename_artifact_version` updates the label without touching
  bytes or hash.
- `project_audit` reports snapshot disk usage.

## Tests

- Smoke: build a V0→V3 chain on the fixture project; assert
  `getLineage(V3.id)` returns 4 records ordered by rank.
- Smoke: save the same path twice with different content; assert
  one snapshot file and one `versions[]` entry.
- Smoke: snapshots dir excluded from artifact registration globs.

## Out Of Scope

- Branching (model D from the design discussion). Defer until a
  cracker workflow needs parallel patches.
- Diff UI between two versions. The data is in place; UI diff comes
  later if asked.
- Auto-pruning old snapshots; manual or audit-suggested for now.

## Dependencies

- Sprint 21 (Bug 10 dedup must already merge instead of duplicate).
- Sprint 18 (knowledge tabs surface) — UI lineage grouping lands as
  part of Sprint 18 row rendering once Spec 025 schema exists.
