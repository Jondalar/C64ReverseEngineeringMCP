# Spec 117 — Headless M4.1: Stable Framebuffer API

Status: **DONE 2026-05-04 (v1).** `session.renderDescriptor()` returns `{ width, height, mode, ranges }` with mode ∈ {text, bitmap, multicolor, ecm}. 5/5 checks. Doc: `docs/visual-runtime-notes.md`.
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 4, story M4.1
Depth: light
Predecessors: Spec 105 (M2.3 VIC fidelity)

## Render geometry oracle (added 2026-05-06)

Output proportions MUST match VICE PAL render pixel-exact. Visual
oracle + binding requirements: [`refs/vic-render-proportions.md`](./refs/vic-render-proportions.md).
A PR that ships a render whose border/background ratios disagree
with the reference image fails this spec irrespective of which
inner-area pixels are correct.

## Motivation

Render output exists in several places. Agents need one stable
contract: PNG plus the VIC mode metadata and the source memory ranges
that produced the frame.

## Acceptance

- `headless_render_screen` returns
  `{ png, width, height, mode: "text" | "bitmap" | "multicolor" |
    "ecm", ranges: { screen, color, charset?, bitmap? } }`.
- Implementation centralised in one module.
- All existing render call sites migrated.
- Smoke test asserts shape on a known fixture.

## Deliverables

- EDIT `src/runtime/headless/c64/render.ts`
- EDIT `src/server-tools/headless.ts` (`headless_render_screen` schema)
- Smoke fixture.

## Dependencies

- Spec 105 (mode detection accurate enough to populate `mode`).

## Risks

- Existing render call sites bypass the new API. Mitigation: migrate
  during this spec; keep a brief deprecation shim if needed.

## Out of scope

- Sprite-only renders.
- Animated GIF / video output.
