# Spec 058 — Bug 26: hide infrastructure files from user-facing UI

## Problem

Manifest indexes, analysis JSONs, annotations files, run-event-logs,
rebuild-check binaries, and the auto-generated FACTS reports are
infrastructure for the LLM and the UI itself. They were leaking into
user-facing surfaces:

- Graphics tab segment list pulled from `manifest.json` (Bug 26 main
  evidence, screenshot 2026-05-03 11.25.42).
- **Load Sequence tab** (screenshot 11.45.39): each PRG appears 3x —
  "Murder", "Murder Annotations", "Murder Disasm Rebuild Check" — as
  separate payloads, because each annotations file / rebuild-check
  binary got registered as its own entity.

These are NOT lineage versions (Bug 24), so the latest-per-lineage
filter doesn't collapse them. They are independent artifacts /
entities that should be marked internal and hidden by default.

## Schema

`ArtifactRecord` and `EntityRecord` gain `internal?: boolean`.

`true` means infrastructure: hide from picker, payload list, flow
graph, scrub picker, docs list, inspector linked-artifacts. Findings
+ relations don't list artifacts directly so no schema change there.

`false` and `undefined` are equivalent for filtering ("not internal"),
but `false` lets a caller force-show something the heuristic would
hide. `undefined` triggers auto-classification on save.

## Auto-classification

`classifyArtifactInternal({ path, role?, kind? })` (exported from
`src/project-knowledge/service.ts`):

- **Internal roles**: `annotations`, `annotations-draft`, `rebuild-check`,
  `manifest`, `analysis-json`, `run-event-log`.
- **Internal path patterns** (case-insensitive):
  - `manifest.json`, `*_manifest.json`
  - `*_analysis.json`, `*_annotations.json`, `*_annotations.draft.json`
  - `analysis/runs/*.json`
  - `knowledge/*.json`, `session/*.json`
  - `*_RAM_STATE_FACTS.md`, `*_POINTER_TABLE_FACTS.md`
  - `*_disasm_rebuild_check.prg`
- **Internal kinds**: `analysis-run`.

`saveArtifact` invokes the classifier when `input.internal` is
undefined. `saveEntity` derives from the primary linked artifact
(`payloadSourceArtifactId` first, else `artifactIds[0]`) when
`input.internal` is undefined. Explicit set always wins.

## View-builder filters (server-side)

- `buildLoadSequenceView`: `for (artifact of context.artifacts) if
  (artifact.internal === true) continue;` — single guard at the top of
  the artifact iteration, so each PRG no longer triples.
- `buildFlowGraphView` / `buildStructureFlowMode`: filter
  `context.entities` to non-internal before building the entity-id map.
- `buildAnnotatedListingView`: filter `entityByAddress` to
  non-internal. Analysis-JSON artifacts STAY in the iteration (they
  are the data source) — only entity rendering drops internals.

`buildGraphicsView` already narrows analysis-JSON artifacts by
`*_analysis.json` suffix (Bug 22 fix), so manifest.json doesn't
contribute segments. No further change needed there.

## UI

New helper `ui/src/lib/internal.ts`:
- `isInternalArtifact(artifact)`: respects persisted flag, falls back
  to the same heuristic for legacy projects whose artifacts.json
  predates the schema field.
- `isInternalEntity(entity, artifactsById)`: same; falls back to
  primary linked artifact's classification.

New context `InternalVisibilityContext` exposes `{ showInternal,
visibleArtifacts(items), visibleEntities(items, byId) }`. Header
toggle `[ ] Show internal files` (next to Bug 24's Show all
versions). Default off.

Surfaces patched: WorkflowRunnerPanel, buildDocs, EntityInspector
linkedArtifacts, QuestionInspector linkedArtifacts, DiskFileInspector
ASM/PRG pairing, CartChunkInspector fallbackAsm, ScrubPanel.

## Smoke

`classifyArtifactInternal`:
- `manifest.json` → true
- `a.prg` → false
- `a_analysis.json` → true
- `a_annotations.json` → true
- `a_disasm.asm` → false
- `a_disasm_rebuild_check.prg` → true
- `role=annotations` → true

`saveArtifact` auto-classifies; `saveEntity` derives from primary.

## Out of scope

- Server-side `MemoryMapView` / `DiskLayoutView` / `CartridgeLayoutView`
  filters — they iterate concrete medium structures, not generic
  artifact lists, and shouldn't surface internals incidentally.
- Migration: existing projects don't get a one-shot rewrite of their
  artifacts.json. Old records lacking `internal` fall through the UI
  helper's heuristic on every read; that's cheap and avoids a
  destructive backfill.
- Per-tag explicit override exposed in MCP tools — not needed yet,
  callers of `save_artifact` / `save_entity` can pass `internal: false`
  if they want to force-show a normally-hidden artifact.

## Cross-reference

- Bug 26: parent.
- Bug 24 (Spec 054): latest-per-lineage default; the toggle for THIS
  spec lives next to that one in the header strip.
- Bug 23 (Stage 2 — `buildGraphicsView` dedupe by `_analysis.json`
  suffix): complementary infrastructure-leak fix on the graphics view.
- Bug 14: rebuild-check filter — the Scrub panel's `role !==
  "rebuild-check"` predicate predates this spec; both layered now.
- Bug 4: doc-registration scoping — same internal-vs-user-facing
  family.
