# Bug: Media tabs render raw JSON instead of usable UI views

- **ID:** BUG-012
- **Date:** 2026-05-30
- **Reporter:** human
- **Area:** ui-v3
- **Severity:** high
- **Status:** fixed

## Environment

- Branch / commit: b65943c
- Surface: ui-v3
- Project dir: `/Users/alex/Development/C64/Cracking/Die Dunkle Dimension`
- Tool / endpoint / tab: Media group — Disk, Cartridge, Graphics, Assets / Scrub

## What happened

The migrated Media tabs render raw JSON text or otherwise show the same raw view-model dump instead of usable human UI. In the screenshot, selecting within the Media group still shows the raw `MEMORY MAP (BUILD_MEMORY_MAP)` JSON blob rather than Disk/Cartridge/Graphics/Assets UI.

This means the v1 → v3 migration did not actually wire product UI views for these Media tabs, or tab selection/content routing is broken and keeps showing the previous raw JSON view.

Regression clarification: this is not merely a styling issue. The actual graphics/media views appear to be missing from the migrated Media tabs. The human workbench depends on visual disk/cartridge/graphics/asset views, including canvas-based preview/scrub where applicable.

## Expected

Media tabs should render structured, usable UI:

- Disk: disk list, directory/file list, geometry, sector chain details, stable disk selection.
- Cartridge: cartridge/media details and banks where present.
- Graphics: visual graphics/asset candidate gallery.
- Assets / Scrub: file picker, offset/window controls, render preview, confirm/reject/save segment authoring.

Raw JSON may be available behind an explicit debug/details toggle, but must not be the default product UI.

## Repro steps

1. Open the v3 UI for the DDD project.
2. Click the Media group tabs: Disk, Cartridge, Graphics, Assets / Scrub.
3. Observe that the content is raw JSON text or stale content from another tab instead of a usable view.

Minimal command / call:

```text
UI action: click Disk / Cartridge / Graphics / Assets / Scrub in the v3 Media group.
```

## Evidence

- Error / output (verbatim):

```text
auch hier nur json text und kein UI
```

- Browser evidence:

```text
Current URL: http://127.0.0.1:4310/
Selected section: MEDIA DISK CARTRIDGE GRAPHICS ASSETS / SCRUB
Visible content: raw JSON text starting with "MEMORY MAP (BUILD_MEMORY_MAP)".
```

- Artifacts: user-provided marked browser screenshot in Codex thread, 2026-05-30.

## Scope guess (optional)

v3 tab routing/content selection and Media tab renderers. The tab group may route multiple tabs to a generic JSON view or fail to update content when switching groups.

## Notes / follow-up

- Closely related to BUG-011, but keep separate because Analysis and Media have different expected UI components and acceptance.
- This invalidates the claim that all v1 viewing + Scrub/Reclassify tools are migrated into v3 product UI.
- Fix must restore real product views/visualizations for Media, not just prettify JSON.
- Required minimum: Disk, Cartridge, Graphics, and Assets/Scrub each need a human-readable structured/visual renderer.
- Raw JSON may remain only behind an explicit debug/details toggle.

---

## Resolution

- **Root cause:** same as BUG-011 — the Media tabs (Disk, Cartridge) used the generic `ViewJson` raw-JSON renderer. (Graphics + Assets/Scrub were already structured.) The "MEMORY MAP JSON in the Media group" in the screenshot was the previously-selected Memory Map tab's raw dump; the v3 router itself switches cleanly by tab id (no stale-content bug found).
- **Fix:** the REAL v1 Media visualizations were extracted into the shared module `ui/src/components/workspace-panels.tsx` (+ CSS) and reused by v3:
  - Disk → `DiskPanel` SVG cylindrical disk geometry (polar sector paths) + directory + file list
  - Cartridge → `CartridgePanel` bank/chip grid (`CartridgeMemoryGrid`) + boot trace
  - (Graphics + Assets/Scrub were already real visual UI.)
- **Fix commits:** `52b595d` (extract), `635b398` (share CSS), `4c4fdc7` (wire v3). Raw JSON stays a per-panel debug toggle. v3 imports from the shared module, never `App.tsx`.
- **Gate proving the fix:** `npm run smoke:ui-project-trace` 33/33 — checks 27-31 incl. the built v3 bundle/CSS containing `disk-geometry-svg` / `disk-sector` / `cart-grid-list`. ui:v3:build clean.
- **Regression risk:** low — verbatim extraction; v1 unchanged. (Disk-tab selection-stability BUG-008 + list-scroll BUG-009 are separate; the DiskPanel keeps its own internal selection.)
