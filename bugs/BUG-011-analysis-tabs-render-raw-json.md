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
- Fix should render at least basic structured tables/cards for each Analysis tab and keep raw JSON only as an explicit debug option.

---

## Resolution

- **Root cause:** the 724B.2 migration wired the Analysis tabs to a generic `ViewJson` renderer that `JSON.stringify`'d the view model — data exposed, no product UI.
- **Fix commit:** `9c4da85` — structured renderers off the typed view models: Memory Map = region table (range/title/kind/status/confidence), Payloads = table (kind/title/status/path), Annotated Listing = address-range listing lines, Flow Graph = nodes list + resolved edges. `ViewJson` removed; raw JSON only behind an explicit per-panel "raw JSON" toggle.
- **Gate proving the fix:** `npm run smoke:ui-project-trace` 31/31 — checks 27-29: no default `ViewJson` dump, ≥3 structured tables, raw JSON behind the toggle. ui:v3:build clean.
- **Regression risk:** low — UI rendering only; data source (`/api/workspace`) unchanged; raw JSON still reachable for debugging.
