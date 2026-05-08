# Spec 054 — Bug 24: latest version per lineage as default UI rule

## Problem

Spec 025 introduced artifact lineage (`derivedFrom`, `lineageRoot`,
`versionRank`, `versionLabel`). Each PRG that goes through `analyze_prg`
twice, or any artifact that gets re-disassembled / re-extracted /
re-imported, generates a new V(n+1) entry sharing a `lineageRoot` with
its predecessors. Until now only the Scrub picker filtered to
latest-per-lineage; every other UI surface listed all V0..Vn entries
side-by-side.

Live evidence (Murder, screenshot 2026-05-03 10.44.09): MotM64 Flow
Graph tab shows 98 nodes / 87 edges with multiple repeated nodes per
lineage root (`entry_xxxx` V0 + V1 + V2 in the same graph).

## Default rule

> Every UI surface that LISTS artifacts shows the highest `versionRank`
> per `lineageRoot ?? id`. Lookups by id stay against the full list so
> older-version references continue to resolve.

A header toggle `[ ] Show all versions` overrides the default for
debugging. The toggle is React-context driven so nested panels respect
it without prop drilling.

## Surfaces patched in v1

Client (`ui/src/App.tsx`):

1. `WorkflowRunnerPanel.prgArtifacts` — workflow runner picker.
2. `buildDocs(...)` — both call sites (initial load + re-derive).
3. `EntityInspector.linkedArtifacts` — entity inspector card.
4. `QuestionInspector.linkedArtifacts` — question inspector card.
5. `DiskFileInspector` ASM/PRG pairing (`asmSources`, `payloadBinaryArtifact`).
6. `CartChunkInspector.fallbackAsm` — cartridge chip ASM fallback.
7. `ScrubPanel` — refactored to use the shared helper, now respects toggle.
8. Inspector "Linked Artifacts" rows — render `+(N-1) older` badge when
   a lineage has >1 version, so the user can see history exists even
   though the older entries are filtered out of the list.

Server (`src/project-knowledge/service.ts`):

9. `getPerArtifactStatus` — collapse to latest per lineage so the
   per-artifact status table doesn't list V0/V1/V2 as separate rows.

## Helper

New `ui/src/lib/lineage.ts`:

- `latestArtifactsByLineage(artifacts)` — keep highest versionRank per root.
- `lineageChain(artifact, all)` — V0..Vn ordered by rank.
- `lineageVersionCount(artifact, all)` — N for badge text.
- `isLatestInLineage(artifact, all)` — predicate.

`LineageVisibilityContext` exposes `{ showAllVersions, latest(items) }`.
Nested panels call `useLineageVisibility().latest(items)` instead of
filtering inline.

## Out of scope (followups)

- **Inspector history pane (Sprint 24.5)**: clicking the `+N older`
  badge expands a stacked V0..Vn list; each row clicks open in a sibling
  inspector with a "read-only — older version" banner.
- **Flow graph dedup (Sprint 24.6)**: server-side
  `buildFlowGraphView` collapses entity/relation nodes whose underlying
  artifacts share a lineage root. Bigger surface — affects flow imports.
- **`/api/findings`, `/api/entities`, `/api/flows`, `/api/relations`**:
  these don't list artifacts directly; their inspector views inherit the
  filter from EntityInspector / QuestionInspector. If new server-side
  artifact-list endpoints are added, default to latest-per-lineage.

## Cross-reference

- Spec 025 (`025-artifact-lineage-and-versions.md`) — schema.
- Sprint 22 (lineage chain UI in inspector) — the V0..Vn stack the
  followup history pane will reuse.
- Bug 23 — duplicate listing in Graphics tab caused by Bug 10
  (registration dup), not lineage. Different cause, different fix.
