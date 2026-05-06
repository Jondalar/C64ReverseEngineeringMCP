# VIC render proportions — VICE oracle

Status: **REQUIREMENT** (added 2026-05-06)

Visual reference: [`vice-c64-ready-proportions.png`](./vice-c64-ready-proportions.png)

## Statement

The headless VIC framebuffer + every consumer of `headless_render_screen`
(MCP tool, UI preview, smoke fixtures) MUST reproduce the VICE PAL
output ratio exactly: outer light-blue border, inner dark-blue
background, text in upper-left, bottom border thicker than top.

The reference image is a VICE PAL render of the Commodore 64
power-on `READY.` screen at default boot. It is the visual oracle.
Render output that does not match its proportions, border colors,
text position, or aspect is **wrong** — even if the inner 320×200
pixel content is byte-identical.

## Why

We cannot ship a "C64 VM" whose render disagrees with VICE on the
fundamentals (PAL frame size, border ratios, where the text area
sits inside the border). Every downstream feature — sprite/bitmap
preview, frame diff, swimlane, UI scope readouts — assumes VICE-equal
geometry. Drift here cascades: a UI preview that crops the border
differently than VICE makes per-line border-trick comparison
impossible (Spec 086 raster-bar / open-border tricks lose meaning
without the matching frame).

## Acceptance (binding for any VIC render PR)

- PAL frame width × height matches VICE's exported PNG for the same
  boot state (typically 384×272 for visible-overscan output, but the
  exact dims used by VICE's `screenshot save` of the ready screen
  are the canonical numbers — see image).
- Border / background pixel counts on each side match VICE within
  ±0 pixels at $D016=0/$D011=0x1B (default) — i.e. the boot ready
  screen renders pixel-identical.
- Border thickness asymmetry preserved: bottom border > top border
  (visible in reference image), left/right symmetric.
- Light-blue (color 14, $0E) border + dark-blue (color 6, $06)
  background — the two C64 cold-boot defaults — render with the
  exact CRT-like palette VICE ships (no auto-adjusted vibrancy).
- Aspect ratio per VICE's PAL pixel-aspect-correct output (~5:6
  pixel AR for PAL); a non-corrected 1:1 output is acceptable only
  when explicitly labeled "raw" — UI preview defaults to corrected.

## What this is NOT

- This is not a permission to fudge ratios "for legibility" in
  small UI thumbnails. Thumbnails resize the same canonical render;
  they don't crop or restretch differently from VICE.
- This is not just a power-on-screen rule. Same proportions apply
  to every frame: title screens, in-game frames, raster-bar tricks.
  The reference image happens to be the boot screen because that's
  the cheapest oracle.

## Cross-references

- Spec 065 — VIC framebuffer render (Phase A foundation)
- Spec 086 — VIC per-scanline renderer + open border (mid-frame
  changes; needs the same outer geometry to make sense)
- Spec 105 — VIC-II fidelity headless milestone
- Spec 117 — Stable framebuffer API (`headless_render_screen` shape)
- Spec 118 — VIC timing baseline
