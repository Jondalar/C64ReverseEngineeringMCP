# Bug: A deleted source file stays registered, can win the "current" tie, and opens as a bare HTTP 404

- **ID:** BUG-047
- **Date:** 2026-08-14
- **Reporter:** human (opening a disassembly from the Disk view while taking README screenshots)
- **Area:** knowledge / artifact version store + workbench UI
- **Severity:** medium (the UI offers a source that cannot exist, and says nothing useful when it fails)
- **Status:** open <!-- open | investigating | fixed | wontfix | duplicate -->

## What happened

Disk view → `block2_engine_0200` → **`.asm/.tass`** ("Open best available source"). The
viewer opened `block2_engine_0200_disasm.tass`, labelled **Current (auto)**, with the
note *"Needs decision — two sources tie on rank. Pick one as current."*

The body was `HTTP 404`. Switching to the **KickAss** tab loaded the `.asm` fine.

## Measured

In the project store, both versions carry `versionRank = 0` — hence the tie — and one of
them has no file behind it:

```
block2_engine_0200_disasm.tass    exists=False   rank=0  label=V0
block2_engine_0200_disasm.asm     exists=True    rank=0  label=V0
```

It is not one stray record. Across the project:

| | |
|---|---|
| `.tass` paths registered in the store | **184** |
| `.tass` files actually on disk | **2** |

Many of the registered paths point outside the project entirely
(`../../../../../../tmp/…`), so they were transient from the start.

## Likely cause of the deletions — which makes it worse, not better

The owner's recollection: at some point in that project the decision was *"tass weg, wir
machen nur kickass"*. That is a perfectly good decision, and it is exactly the case the
store handles badly: a **deliberate** format retirement leaves ~180 dead registrations
behind, and any one of them can still be picked as the current source.

## Root cause

The demotion machinery exists and is correct. `service.ts:3931`
`markArtifactVersionStatus(subjectId, artifactId, "missing")` marks the version and, when
the missing one *was* current, re-picks the best non-missing candidate:

```ts
const candidates = versions
  .filter((v) => v.status !== "stale" && v.status !== "missing")
  .sort((a, b) => b.rank - a.rank || a.artifactId.localeCompare(b.artifactId));
```

**Nothing ever calls it for a file that disappeared.** Its only callers are the manual
verbs — `mark_artifact_version_stale` (artifact-version-tools.ts:114) and the UI's own
button (workspace-ui/server.ts:687). Both need a human to notice first.

And selection never asks the filesystem: `computeArtifactVersionGroup` ranks candidates
from the artifact list alone, so presence is not part of the ordering. A missing file with
an equal rank can therefore win a tie and be published as `current`.

BUG-033 built the other half of this — `reconcileArtifactVersionGroups` clears a `missing`
flag when the file reappears. The flag is never *set* by the same reconcile pass.

## Expected

1. A registered version whose file is gone is marked `missing` by the reconcile pass, not
   by a human noticing a 404.
2. Presence beats rank when picking `current`. A file that is not there is never the best
   available source, whatever it ranks.
3. Opening a missing version says so — "the file this version points at is gone" plus the
   path — instead of `HTTP 404`.

## Scope guess

- `src/project-knowledge/service.ts` — `reconcileArtifactVersionGroups` (~3990) should
  `existsSync` each candidate and mark the absent ones; `computeArtifactVersionGroup`
  (~3955) should treat absence as disqualifying rather than as a tiebreak input.
- `src/workspace-ui/server.ts` — the source-fetch route should distinguish "not registered"
  from "registered, file gone".

## Notes

Found while screenshotting the README, which is its own small lesson: the defect had been
sitting in a view nobody had reason to open, on a project with 196 payloads. A tie between
two versions is exactly where "best available" stops being obvious, and that is where the
store should have been strictest.

Related: BUG-033 (the `missing`/`stale` flag was sticky in the other direction — not
cleared when a file reappeared).
