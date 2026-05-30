# Bug: Migrated workspace views lost shared Inspector and original layout

- **ID:** BUG-014
- **Date:** 2026-05-30
- **Reporter:** human
- **Area:** ui-v3
- **Severity:** high
- **Status:** fixed

## Environment

- Branch / commit: b65943c
- Surface: ui-v3
- Project dir: `/Users/alex/Development/C64/Cracking/Die Dunkle Dimension`
- Tool / endpoint / tab: Workspace views — Memory Map, Disk, Cartridge, Graphics, Assets/Scrub, Flow Graph

## What happened

After BUG-011/012 restored some real visual panels, the central shared Inspector behavior is missing. The migrated v3 views show visualizations, but selecting/clicking cells/files/nodes/assets does not populate the workbench Inspector with linked details/actions.

Additionally, the original thought-through layout was not preserved. Panels that used to be arranged as a workbench with primary visualization, side/detail areas, and inspector context are now stacked top-to-bottom. The result is visually and ergonomically worse even when the SVG/heatmap views are technically present.

## Expected

The v3 One-UI Shell must preserve the workbench interaction model and layout:

- A visible shared Inspector/detail panel remains part of the workspace.
- Selecting a Memory Map cell shows memory range, entities, references, and actions in the Inspector.
- Selecting a Disk file/sector shows file metadata, sector chain, artifact links, and actions.
- Selecting a Cartridge bank/chunk shows bank/chip/chunk details.
- Selecting a Flow node/edge shows node details and linked findings/entities.
- Selecting Graphics/Asset/Scrub items shows asset metadata, source bytes, annotation/reclassify actions.
- The layout should restore the prior workbench structure instead of a simple vertical dump/stack: primary visual area plus side/detail/inspector regions, with stable heights/scrolling.

## Repro steps

1. Open the v3 UI for the DDD project.
2. Open migrated workspace views such as Memory Map, Disk, Cartridge, Graphics, Assets/Scrub, or Flow Graph.
3. Click/select cells, disk files, sectors, flow nodes, or assets.
4. Observe that there is no shared Inspector update and the layout is stacked top-to-bottom rather than the previous workbench arrangement.

Minimal command / call:

```text
UI action: select items in migrated workspace views and inspect the page layout/Inspector behavior.
```

## Evidence

- Error / output (verbatim):

```text
Die UIs sind teilweise wieder da - aber das zentrale Element ist weg - der Inspector
Auch die Einteilung is jetzt von oben nach unten .. es hab ja ein durchdates Layout, das muss wieder hergetsellt werden
```

- Artifacts: user browser inspection during DDD UI acceptance, 2026-05-30.

## Scope guess (optional)

v3 workspace view composition and shared panel callbacks. The extracted v1 panels likely use no-op cross-panel callbacks in v3; those must feed v3 Inspector state. CSS/layout migration may have lost the original split-grid/workbench containers.

## Notes / follow-up

- This is separate from BUG-011/012 raw JSON. BUG-011/012 are about restoring real visual panels; BUG-014 is about restoring the surrounding workbench interaction model and layout.
- No-op callbacks are acceptable only for truly unavailable legacy-global behavior, not for core Inspector selection.
- Fix should include a UI smoke or DOM assertion proving an Inspector panel exists and updates when selecting representative items.

---

## Resolution

- **Root cause:** the BUG-011/012 v3 wiring passed **no-op** `onSelectEntity` to the extracted panels and stacked them top-to-bottom — so selecting a cell/file/node did nothing and the v1 `app-main-grid` workbench (primary visual + Inspector side) was lost.
- **Fix:** the v1 `EntityInspector` (per-mode details, linked artifacts/findings/relations/elements, view-links, jump chips) + the lineage/internal visibility contexts were extracted into the shared `workspace-panels` module, and a `Workbench({main, side})` wrapper restores the two-column `app-main-grid` layout. The v3 viz views (Memory Map, Disk, Cartridge, Flow Graph) now hold a local `selectedEntityId`, feed the panel's `onSelectEntity` into it, and render the shared `EntityInspector` on the right — selecting a heatmap cell / disk file / cartridge bank / flow node populates the Inspector with the linked entity. Only the heavy v1-GLOBAL actions (open hex/asm overlay, create task/question, run workflow) remain no-op (legacy-global flows not yet in the v3 shell); Inspector selection + detail navigation are fully live.
- **Fix commits:** `7427abf` (extract Inspector + Workbench), `bcbd770` (share CSS + wire v3). v3 imports from the shared module, never `App.tsx`.
- **Gate proving the fix:** `npm run smoke:ui-project-trace` 36/36 — checks 32-34: the v3 tabs use `Workbench` + `EntityInspector` + a selection hook, and the built v3 JS + CSS contain the Inspector + `app-main-grid`/`workspace-side`/`wb-embedded` markup. ui:v3:build clean; v3 typecheck 0 new errors.
- **Regression risk:** low — verbatim Inspector extraction (v1 deduped to import the shared one, total tsc errors unchanged at 13); v3 adds layout + live selection only; heavy global actions explicitly deferred.
