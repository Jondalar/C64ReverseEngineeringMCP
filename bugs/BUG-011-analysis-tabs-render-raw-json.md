# Bug: Analysis tabs render raw JSON instead of usable UI views

- **ID:** BUG-011
- **Date:** 2026-05-30
- **Reporter:** human
- **Area:** ui-v3
- **Severity:** high
- **Status:** fixed

## Environment

- Branch / commit: b65943c
- Surface: ui-v3
- Project dir: `/Users/alex/Development/C64/Cracking/Die Dunkle Dimension`
- Tool / endpoint / tab: Analysis group — Memory Map, Payloads, Annotated Listing, Flow Graph

## What happened

The migrated Analysis tabs render raw JSON text directly on the page instead of usable human UI. In the screenshot, selecting Memory Map shows a JSON blob beginning with `MEMORY MAP (BUILD_MEMORY_MAP)` and fields like `id`, `kind`, `title`, `cells`, etc.

This means the v1 → v3 migration only exposed the backing data, not a product-quality UI for these analysis views.

Regression clarification: this is not merely a styling issue. The actual visual/product views appear to be missing from the migrated Analysis tabs. The human workbench needs the graphical/structured representations, not JSON dumps.

## Expected

Analysis tabs should render structured, readable UI views:

- Memory Map: grouped memory regions/cells with addresses, labels, confidence, entity links, and inspector selection.
- Payloads: payload list/cards/table with file/medium origin, size, load address, stage, status.
- Annotated Listing: readable annotated assembly/listing view, not raw JSON.
- Flow Graph: visual or at least structured graph/list view with nodes/edges, not raw JSON.

Raw JSON may be available behind an explicit debug/details toggle, but must not be the default product UI.

## Repro steps

1. Open the v3 UI for the DDD project.
2. Click the Analysis group tabs: Memory Map, Payloads, Annotated Listing, Flow Graph.
3. Observe that the content is raw JSON text instead of a usable view.

Minimal command / call:

```text
UI action: click Memory Map / Payloads / Annotated Listing / Flow Graph in the v3 Analysis group.
```

## Evidence

- Error / output (verbatim):

```text
zeigt alles nur json text an, kein UI
```

- Browser evidence:

```text
Current URL: http://127.0.0.1:4310/
Selected section: ANALYSIS MEMORY MAP PAYLOADS ANNOTATED LISTING FLOW GRAPH
Visible content: raw JSON text starting with "MEMORY MAP (BUILD_MEMORY_MAP)".
```

- Artifacts: user-provided marked browser screenshot in Codex thread, 2026-05-30.

## Scope guess (optional)

v3 analysis tab rendering components. The tabs likely reuse a generic JSON/preformatted view instead of dedicated renderers for the view-models returned by `/api/workspace`.

## Notes / follow-up

- This invalidates the claim that all v1 viewing screens are migrated as product UI.
- Fix must restore real product views/visualizations for Analysis, not just prettify JSON.
- Required minimum: Memory Map, Payloads, Annotated Listing, and Flow Graph each need a human-readable structured/visual renderer.
- Raw JSON may remain only behind an explicit debug/details toggle.

---

## Resolution

- **Root cause:** the 724B.2 migration wired the Analysis tabs to a generic `ViewJson` renderer that `JSON.stringify`'d the view model. (First pass `9c4da85` replaced the dump with plain tables — still NOT the real visualizations the human workbench needs.)
- **Fix:** the REAL v1 visualizations were extracted from the monolithic `ui/src/App.tsx` into a shared module `ui/src/components/workspace-panels.tsx` (+ shared CSS `workspace-panels.css`), reused by BOTH v1 and v3:
  - Memory Map → `MemoryMapPanel` 16×16 heatmap grid
  - Flow Graph → `FlowPanel` SVG lane/node/edge graph
  - (Disk/Cartridge under BUG-012.) Payloads + Annotated Listing keep structured lists (text is the right shape there). Raw JSON stays a per-panel debug toggle.
- **Fix commits:** `52b595d` (extract panels), `635b398` (share CSS), `4c4fdc7` (wire v3). v3 imports the panels from the shared module, never from `App.tsx`.
- **Gate proving the fix:** `npm run smoke:ui-project-trace` 33/33 — checks 27-31: v3 renders the shared panels, imports from the shared module (not App.tsx), and the BUILT v3 bundle + CSS contain the viz markers (`memory-grid-table` / `flow-svg` / `memory-cell`). ui:v3:build clean; v3 typecheck 0 new errors.
- **Regression risk:** low — extraction is verbatim; v1 build/typecheck unchanged (13 pre-existing errors); data source unchanged.
