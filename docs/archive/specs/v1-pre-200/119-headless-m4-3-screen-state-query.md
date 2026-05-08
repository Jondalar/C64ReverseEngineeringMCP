# Spec 119 — Headless M4.3: Screen-State Query

Status: **DONE 2026-05-04 (v1).** `screen-state.ts:captureScreenState()` returns text grid (PETSCII-decoded) + color grid + 8 sprites + bitmap hash + mode + bank + colors + rasterLine. 7/7 checks; ready-screen text snippet match validates BASIC boot. Doc: `docs/visual-runtime-notes.md`.
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 4, story M4.3
Depth: light
Predecessors: Spec 105 (M2.3), Spec 117 (M4.1)

## Motivation

Agents need structured access to screen state without parsing PNGs.
Text grids, color grids, sprite positions, and bitmap state must be
queryable as JSON.

## Acceptance

- `session.screenState()` returns:
  ```
  {
    textGrid: string[][],   // PETSCII-decoded
    colorGrid: number[][],
    sprites: [{ index, x, y, active, color, expandX, expandY,
                multicolor, priority }],
    bitmapHash?: string,
    vicMode: "text" | "bitmap" | "multicolor" | "ecm",
    dirtyRegions: { rows: number[], cols: number[] }
  }
  ```
- New MCP tool `headless_screen_state` exposes it.
- Smoke fixture: known text screen → known textGrid output.

## Deliverables

- NEW `src/runtime/headless/c64/screen-state.ts`
- NEW MCP tool `headless_screen_state`
- Smoke fixtures.

## Dependencies

- Spec 105.

## Risks

- PETSCII decoding edge cases (control chars, inverse video).
  Mitigation: comprehensive PETSCII table; document non-printable
  handling.

## Out of scope

- Image-recognition queries (e.g. "is this the title screen").
- OCR.
