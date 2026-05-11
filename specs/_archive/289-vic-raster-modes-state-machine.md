# Spec 289 — VIC-II raster_modes_t state machine refactor

**Sprint:** 144  **Status:** RESOLVED 2026-05-09  **Depends:** 281

**Resolved:** OQ1=(a) full extract refactor (= ALLES), OQ2=regression
sufficient (output unchanged).

## Goal

Explicit `RasterMode` enum (idle / display / border) + state
machine with per-cycle transition callbacks. Mirrors VICE's
`raster-modes.h`. Currently we have implicit per-cycle mode checks
scattered through `vic-renderer-rasterized.ts`. Refactor exposes
the state machine for inspection (= valuable for debugging
mid-frame mode-switch tools and Spec 290 raster cache).

## VICE source

- `raster/raster-modes.h` — `raster_modes_t` enum + transition
  table.
- `raster/raster-modes.c` — `raster_modes_set` per-mode dispatcher.
- `vicii/vicii.c:1180+` — per-cycle mode transitions wired into
  raster.

## Plan

- 289a: Add `RasterMode = "idle" | "display" | "border"` enum +
  `RasterModeTransition` (when, from, to).
- 289b: Add `raster_mode` field to RasterState. Updated by
  `updateVerticalFFAtLineStart` (border) + DEN check (idle/display).
- 289c: Renderer reads `state.raster_mode` instead of recomputing.
  Hooks ready for Spec 290 cache key.

## OQs

- **OQ1:** Refactor scope. (a) Full extract — touches existing
  drawn paths. (b) Add enum + tracker, leave existing code
  unchanged. Default (a) — matches "ALLES" goal.
- **OQ2:** Test gate: (a) regression intact (= sufficient since
  refactor changes structure not output). Default (a).

## Acceptance

- [ ] RasterMode enum exposed
- [ ] RasterState carries current `raster_mode`
- [ ] Transition events traceable
- [ ] All previous smokes still pass byte-identical
