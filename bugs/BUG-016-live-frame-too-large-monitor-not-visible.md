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
- **Fix (final — viewport-bound cockpit):** the first pass capped the screen at `max-height:56vh`, which fixed the overflow but left a large empty area (the screen was small + centered). Per the follow-up user request ("inspector fixed width, monitor its current height, the rest is for the C64 screen"), the cap was replaced by binding the whole Live cockpit to the viewport — exactly like the v3 standalone shell. When the Live tab is active the product root gets `.app-root.live-mode { height:100vh; overflow:hidden; display:flex; flex-direction:column }`; the header is natural height and the workbench `main` flexes to fill the rest (`flex:1; min-height:0`), with the Live cockpit grid `auto / 1fr` (tab nav, then cockpit). `.wb-live { height:100% }` (the generated v3 rule, no longer overridden) then lets the screen row (`1fr`, `object-fit:contain`) grow to fill all space left over after the fixed-width inspector and the natural-height Monitor — no full-page scroll, no magic numbers (flexbox derives the height). The earlier `live-runtime.css` cap block was removed.
- **Fix commit:** _this commit_.
- **Gate proving the fix:** `npm run smoke:product-ui` check 4b — the built v1 bundle carries `.app-root.live-mode { height:100vh; overflow:hidden; display:flex }` (the viewport bind). 14/14 green; v1 build green. (Pixel-perfect layout verified visually by the user.)
- **Regression risk:** low — CSS + a single conditional root class, scoped to the Live tab (`live-mode`); other tabs keep the normal scrolling layout; v3 standalone untouched.
