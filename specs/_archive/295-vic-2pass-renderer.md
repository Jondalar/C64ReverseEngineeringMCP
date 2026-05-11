# Spec 295 — VIC-II 2-pass renderer (background + foreground split)

**Sprint:** 144  **Status:** RESOLVED 2026-05-09  **Depends:** 281, 289

**Resolved:** Full 2-pass split (= ALLES); test = regression
byte-identical.

## Goal

Refactor renderer to VICE's explicit 2-pass pattern: background
pass writes bg colors, foreground pass overdraws fg pixels per
mode. Today our renderer merges into one mode emitter. Refactor
mirrors VICE structure for parity introspection + clean Spec 290
cache integration.

## VICE source

- `vicii-draw.c` — `draw_*_background` + `draw_*_foreground` pair
  per mode (5 modes × 2 = 10 functions).

## Plan

- 295a: Extract `draw_*_background` + `draw_*_foreground` per
  mode (std-text, mc-text, std-bitmap, mc-bitmap, ext-text).
  Illegal modes 5/6/7 already use 2-pass-style (fillSpan + mask).
- 295b: Renderer renders bg pass over full segment, then fg pass
  over the overlap with active gfx window.
- 295c: Output must remain byte-identical to current 1-pass impl.
  Regression smokes are the gate.

## Acceptance

- [ ] All 5 legal modes split into bg + fg pass functions
- [ ] Renderer runs bg-pass-then-fg-pass per segment
- [ ] Spec 281 4/4 + 282 35/35 + 283 24/24 + 284 9/9 + 285..291
  smokes byte-identical
