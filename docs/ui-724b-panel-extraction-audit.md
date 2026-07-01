# BUG-011/012 — v1 visualization panel extraction audit

> **Historical (record).** The v1/v3 UI split was retired (Spec 757); the UI is now
> the Spec 773 workflow cockpit. The extracted shared visualization panels (MemoryMap
> / Cartridge / Disk / Flow) persist, but the v1/v3 import framing below is provenance
> only.

Goal: extract the real v1 SVG/heatmap/grid visualizations from the monolithic
`ui/src/App.tsx` into shared components both v1 and v3 import. Variant A
(extraction). No runtime/backend/VICE change.

## Panels to extract

| Panel | App.tsx lines | Visualization |
|---|---|---|
| `MemoryMapPanel` | 2243–2610 | 16×16 heatmap grid (`memory-grid-table` / `memory-cell category-*`) + highlights + selected-cell detail |
| `CartridgePanel` | 2612–2717 | bank/chip grid via `CartridgeMemoryGrid` (already external) + `BootTracePanel` + `MediumPanelShell` |
| `DiskPanel` | 2721–3149 | SVG cylindrical disk geometry (`disk-geometry-svg`, polar `sectorPath`) + file list |
| `FlowPanel` | 3325–3576 | SVG lane/node/edge graph (`flow-svg`, `flow-node-rect`, `flow-arrow` marker) |

## Per-panel dependencies

### MemoryMapPanel
- props: `snapshot: WorkspaceUiSnapshot`, `selectedEntityId?`, `onSelectEntity`
- helpers (module-level): `hex`, `pct`, `artifactMediaClass`
- types: `MediaFilter` (local), `MemoryMapView`
- snapshot fields: `views.memoryMap` (cells/regions/highlights/cellSize/rowStride),
  `views.loadSequence.items`, `entities`, `artifacts`
- CSS: `memory-grid-panel`, `memory-grid-table`, `memory-cell`, `category-*`,
  `memory-legend*`, `memory-filter*`, `cart-lut-filter*`, `legend-swatch`,
  `split-columns`, `detail-card`, `record-*`, `data-table`
- side effects: 2× `useEffect` (sync selected cell/entity) — pure UI state, keep.

### CartridgePanel
- props: `snapshot`, `onSelectEntity`, `onSelectChunk`, `onOpenHex`
- subcomponents (ALREADY external in `ui/src/components/`): `MediumPanelShell`,
  `BootTracePanel`, `CartridgeMemoryGrid`
- types: `CartridgeLutChunk` (from `../types`)
- snapshot fields: `views.cartridgeLayout.cartridges`, `artifacts`, `entities`
- CSS: `cart-grid-list` + CartridgeMemoryGrid's own classes (already shipped)
- side effects: none (pure render).

### DiskPanel
- props: `snapshot`, `selectedDiskFile?`, `onSelectEntity`, `onSelectDiskFile`, `onOpenHex`
- helpers: `hex`, `pct`, `d64SectorOffset`, `d64SectorsInTrack`
- types: `DiskOriginFilter` (local), `DiskFileSelection`
- snapshot fields: `views.diskLayout.disks` (sectors/files/trackCount), `entities`
- CSS: `disk-geometry-svg`, `disk-center-hole`, disk sector classes, file-list classes,
  `split-columns`, `detail-card`
- side effects: 2× `useEffect` (selection sync) — keep.

### FlowPanel
- props: `flowGraph: FlowGraphView`, `entities: EntityRecord[]`, `relations: RelationRecord[]`,
  `selectedEntityId?`, `onSelectEntity`
- helpers: none module-level (all layout local)
- types: `FlowGraphView`, `EntityRecord`, `RelationRecord`
- snapshot fields: consumes `flowGraph` + entities/relations directly
- CSS: `flow-svg`, `flow-node-rect`, `graph-canvas-wrap`, `inspector-chip*`, `split-columns`
- side effects: 1× `useEffect` (mode reset) — keep.

## Shared helpers to extract alongside

`hex`, `pct`, `artifactMediaClass`, `d64SectorOffset`, `d64SectorsInTrack` — small,
pure, no further deps. Move to `ui/src/components/workspace-panels.tsx` (or a tiny
`workspace-format.ts`).

NOT needed by the panels (App-routing only, leave in App.tsx): `tabHasEntity`,
`firstEntityForTab`, `diskFileSelectionForEntity`, `firstDiskFileSelection`,
`diskSelectionEntityId` (these pull `TabId` and the global inspector pipeline).

## CSS

The visualization CSS lives in `ui/src/style.css` (v1) — used by App.tsx. v3 has
`ui/src/v3/style.css`. To share without duplication: the panels reference plain
class names, so v3 must load the same CSS rules. Plan: move the panel-visual CSS
blocks into a shared `ui/src/components/workspace-panels.css` imported by BOTH
v1 entry and the v3 shell (or `@import` it from both style.css files). No rule
duplication.

## v3 callbacks (no-op safe)

v3 has no global inspector pipeline. Pass no-op callbacks:
`onSelectEntity = () => {}`, `onOpenHex = () => {}`, `onSelectDiskFile = () => {}`,
`onSelectChunk = () => {}`. The panels stay fully functional as visualizations;
the cross-panel inspector navigation is a v1-only nicety, out of scope here.

## Extraction shape

`ui/src/components/workspace-panels.tsx` exports `MemoryMapPanel`, `CartridgePanel`,
`DiskPanel`, `FlowPanel` (+ the shared format helpers). `App.tsx` imports them
(removing the inline copies). v3 `ProjectViews.tsx` imports the same components and
renders them with no-op callbacks + the snapshot from `/api/workspace`. v3 NEVER
imports from `App.tsx`.
