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

---

## Resolution

- **Root cause:** same as BUG-011 — the Media tabs (Disk, Cartridge) used the generic `ViewJson` raw-JSON renderer. (Graphics + Assets/Scrub were already structured.) The "MEMORY MAP JSON in the Media group" in the screenshot was the previously-selected Memory Map tab's raw dump; the v3 router itself switches cleanly by tab id (no stale-content bug found).
- **Fix commit:** `9c4da85` — Disk = per-disk file table (name/type/track-sector/load/size) with a STABLE disk selector keyed by `artifactId` (defaults only when nothing chosen, so it won't snap back on refresh); Cartridge = cartridge cards (name/hw/exrom/game/chips/banks). Raw JSON only behind the explicit per-panel toggle.
- **Gate proving the fix:** `npm run smoke:ui-project-trace` 31/31 — checks 27-29 (no default raw dump, structured tables, raw behind toggle). ui:v3:build clean.
- **Regression risk:** low — UI rendering only; data source unchanged. (Full Disk-tab selection-stability + list-scroll containment are tracked as BUG-008/009.)
