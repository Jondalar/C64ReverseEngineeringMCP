# Bug: Live C64 frame scales too large and pushes Monitor out of view

- **ID:** BUG-016
- **Date:** 2026-05-30
- **Reporter:** human
- **Area:** ui-v3
- **Severity:** medium
- **Status:** fixed

## Environment

- Branch / commit: 6809cef
- Surface: ui-v3 / Live tab embedded in product UI
- Project dir: current project UI acceptance session
- Tool / endpoint / tab: Live tab, C64 frame + Monitor section

## What happened

In the v1-integrated product UI, the Live C64 frame scales to almost the full available width/height. This makes the emulator screen too large and pushes the Monitor section below the fold. The user cannot see the C64 screen and monitor together without scrolling.

The standalone v3 Live UI already had the desired layout: bounded C64 screen on the left, runtime inspector on the right, and the Monitor section still visible underneath. That v3 layout is the reference for this bug.

## Expected

The C64 frame should have a bounded, stable size so that the Monitor section remains visible underneath in the default Live layout.

Expected layout behavior:

- C64 screen keeps correct aspect ratio.
- It does not scale to full page width.
- It is sized so the Monitor panel below remains visible in the viewport.
- Inspector/status panel can remain on the right.
- The layout should favor debugging ergonomics: screen + monitor visible together.
- The v1-integrated Live tab should match the old/standalone v3 Live layout proportions.

## Repro steps

1. Open the product UI.
2. Go to the Live tab.
3. Observe the C64 frame size and the Monitor section below.
4. Monitor is pushed out of visible area because the C64 frame is too large.

Minimal command / call:

```text
Open Live tab in the browser.
```

## Evidence

- Error / output (verbatim):

```text
Ok, der C64 Frame sollte so gross sein, dass unten drunter noch die monitor sektion angezeigt wird und nicht auf die volle Breite skalieren.
```

- Artifacts: user-provided browser screenshot in Codex thread, 2026-05-30.
- Reference artifact: user-provided Safari screenshot of the standalone v3 UI (`Bildschirmfoto 2026-05-30 um 16.23.27.png`) shows the desired layout. It is not evidence that the v1-integrated Live tab is fixed.

## Scope guess (optional)

v1-integrated Live tab CSS/layout. The C64 framebuffer container likely uses width-based scaling without max-height / viewport-aware bounds. Compare against the standalone v3 Live CSS/layout and port the sizing constraints like-for-like.

## Notes / follow-up

- This is a layout/ergonomics bug, not emulator behavior.
- Fix should be checked at the current desktop viewport and ideally with responsive constraints.

---

## Resolution

- **Root cause:** the Live screen (`.wb-screen`) is styled `width:100%; height:100%; object-fit:contain` — correct ONLY when an ancestor bounds the height. The standalone v3 shell does that (`.wb-main { flex:1; min-height:0; overflow:hidden }` inside a `100vh` column). The v1 product shell (`.app-main-grid` / `.workspace-main`) is NOT viewport-height-bounded, so `height:100%` collapsed to content and the canvas grew to full page width, pushing the Monitor below the fold.
- **Fix:** the Live CSS file `ui/src/components/live-runtime.css` is imported ONLY by the v1 product entry (v3 uses its own `style.css`), so a v1-only override is safe. Appended a marked BUG-016 block that re-bounds the Live tab without depending on the parent height: `.wb-screen` → `width:auto; height:auto; max-width:100%; max-height:56vh; aspect-ratio:384/272`, `.wb-screen-wrap` → `max-height:56vh`, `.wb-live` → `height:auto`. The frame now keeps its 384×272 aspect, caps at 56vh tall (never full page width), and the Monitor section stays visible underneath — matching the v3 Live proportions.
- **Fix commit:** _this commit_.
- **Gate proving the fix:** `npm run smoke:product-ui` check 4b — the built v1 bundle's winning (last) `.wb-live .wb-screen` rule carries `aspect-ratio: 384/272` + `max-height: 56vh`. 14/14 green; v1 build green. (Pixel-perfect layout is verified visually by the user.)
- **Regression risk:** low — CSS only, v1-only file; v3 standalone Live layout untouched. `56vh` is a sensible desktop default; could be made responsive later.
