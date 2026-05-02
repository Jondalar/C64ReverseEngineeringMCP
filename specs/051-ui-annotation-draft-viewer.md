# Spec 051: UI Annotation Draft Viewer

## Problem

Sprint 38 (Spec 042) shipped `propose_annotations` and writes
`*_annotations.draft.json`. The agent / human still has to read
the draft JSON by hand and merge into final
`*_annotations.json`. UI surface fully missing.

## Goal

Side-panel inside the Listing tab that shows the draft alongside
the disasm. Per-suggestion accept / reject / edit. In-memory
pending state — user can click freely; "Save All" persists merged
state to `*_annotations.json` as one durable action.

## Approach

### Layout

Listing tab grows a right-hand side panel:

```
[ disasm listing | annotation draft side panel ]
```

When a draft is loaded for the active artifact (auto-detected by
file naming convention), the side panel is visible. Otherwise
collapsed with a "Run propose_annotations" button that calls the
MCP tool inline.

### Draft panel content

Three sections:

1. **Segments** — per-row card with kind, address range, label,
   confidence badge, reason. Action buttons: ✓ Accept · ✗ Reject ·
   ✎ Edit.
2. **Labels** — per-address candidate with proposed name,
   confidence, reason. Same buttons.
3. **Routines** — per-address candidate with name + summary +
   confidence. Same buttons.
4. **Open Questions** — separate sub-panel. ✓ Persist (calls
   `save_open_question` with `source: "static-analysis"` per Spec
   036) · ✗ Skip.

### State machine

- Each suggestion has a local `decision` state: `pending` |
  `accepted` | `rejected` | `edited`.
- `Accept all (high confidence ≥0.8)` button bulk-accepts.
- `Save All` button:
  1. Builds the merged `*_annotations.json` from accepted /
     edited entries.
  2. Confirms via modal: "Write N segments, M labels, K routines
     to <path>?"
  3. POSTs to a new `/api/annotations/save` endpoint that
     writes the file.
  4. On success, deletes the draft (or moves to
     `*_annotations.draft.archived.json`).

### Endpoint

`POST /api/annotations/save` (workspace-ui server):

```ts
{
  projectDir: string;
  draftPath: string;
  finalPath: string;
  payload: { segments: ..., labels: ..., routines: ... };
}
```

Server validates the payload against the existing annotations
schema (`pipeline/src/lib/annotations.ts`) and writes the file.
Optionally re-runs `disasm_prg` with the new annotations.

### Edit flow

✎ Edit opens an inline form for the suggestion's label /
comment / routine summary. Confidence not editable.

## Acceptance Criteria

- Listing tab on the fixture project shows an empty side panel
  when no draft exists, with a "Run propose_annotations" button
  that produces the draft and refreshes.
- After loading a draft with 5 segment + 3 label + 2 routine
  suggestions, all 10 accept-buttons work and Save All produces a
  valid `*_annotations.json` with the accepted entries.
- Re-running the disasm with the new annotations succeeds.

## Tests

- Smoke: server endpoint takes a sample payload and writes the
  file; subsequent disasm rebuild is byte-identical.
- UI: snapshot of the draft panel rendering the fixture sample.

## Out Of Scope

- Multi-PRG draft batch.
- Diff view between two draft versions.
- Auto-edit suggestions via LLM.

## Dependencies

- Sprint 38 (Spec 042) annotation helper data layer.
- Sprint 18 knowledge tabs framework (existing tab UI patterns).
- Existing Listing tab / annotated-listing view in
  `ui/src/App.tsx`.
