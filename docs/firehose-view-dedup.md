# Firehose View-Layer Content-Dedup

**Status:** shipped (branch `feature/firehose-view-dedup`, 2026-07-02).
**Scope:** UI display only. The knowledge store is never touched.

## Problem

Every re-analysis run mints fresh run-token ids (base36-ms timestamp embedded
in the artifact id; all derived entity/finding/question ids inherit it) and there
is **no content-hash field**, so identical content re-lands under new ids on every
run. The store accumulates ~5-6× duplicates. Wasteland_EF measured:

| record | raw | distinct | key |
|---|---|---|---|
| entities | 22814 | 4817 | `(kind, name)` |
| findings | 9652 | 1437 | `title` |
| open questions | 3647 | 355 | `title` |

The list panels + counts showed the raw firehose (`Triage (3647)`), burying the
actionable set.

## Why view-layer, not a store GC (the parity contract)

A previous attempt collapsed duplicates by treating dedup as **delete**, which
orphaned every id reference the views/relations/lookups hold → the disk view went
blank ("the data basis was gone"). The reference-site audit found the snapshot
arrays and every view are built from **raw store dumps**, and **every count is
`len(raw)`**; dozens of sites resolve entity/finding/question ids against the full
arrays (inspector select, cross-nav `tabHasEntity`, relation endpoints, view
`entityId` fields, `finding.entityIds`, `question.findingIds`).

So the dedup is **display-only**:

- The store, the snapshot arrays, and all views are **unchanged** — every
  id-lookup and view cross-ref still resolves against the full list.
- Only the three list panels (Entities / Findings / Triage), the Payloads list,
  and the Triage badge render a **deduped view** of the same arrays.
- Mirrors the existing `LineageVisibilityContext` / `InternalVisibilityContext`
  precedent ("lookups by id stay against the full list").
- A **`duplicates`** header toggle reveals the raw records; counts read
  `N of <distinct> · <raw> raw`.

**Survivor = the best real member of a content group** (not a synthetic merge, so
clicking a row opens exactly that record, and no id is fabricated): terminal
status first (answered > open; active > archived), then max confidence, then
newest. This preserves the answer on a question that a later re-run re-opened, and
the highest confidence across runs — the two cases where blind newest-wins loses
real signal.

## Where

- `ui/src/lib/dedupe.ts` — `dedupeByContentKey` + `dedupeEntities/Findings/Questions`.
- `ui/src/components/workspace-panels.tsx` — `ContentDedupContext` (default ON).
- `ui/src/App.tsx` — provider, `duplicates` toggle, the three panel memos, the
  Payloads list, the Triage badge.
- `scripts/e2e-firehose-dedupe.mjs` (`npm run e2e:firehose-dedupe`) — helper
  contract + the parity property (output ⊆ input by id).

## Not covered (deliberate)

- **No store GC.** The duplicates stay on disk; this only cleans the display. A
  persisted merge (union of cross-ref arrays with an id-remap applied to every
  reference site) is a separate, heavier slice and was not needed to make the UI
  usable.
- **MCP list tools** (`list_entities` etc.) read storage directly, bypass the
  snapshot, and are unaffected.
