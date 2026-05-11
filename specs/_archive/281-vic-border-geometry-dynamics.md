# Spec 281 — VIC-II border geometry dynamics (RSEL/CSEL mid-frame, open-border)

**Sprint:** 144 (V3.1 VICE-parity series)
**Status:** RESOLVED 2026-05-09 — OQs answered, ready to implement
**Depends on:** Spec 280 (raster_changes lanes already capture
$D011/$D016 writes; this spec wires the geometry side-effects)
**Replaces:** hardcoded `VISIBLE_X=32, VISIBLE_Y=51, 320×200` in
`vic-renderer-rasterized.ts`
**Sister specs:** 282..292 (full VICE parity series)

## Goal

100% pixel-equal output to VICE for **any** mid-frame change of
RSEL ($D011 bit 3) or CSEL ($D016 bit 3), including the
demo-scene "open border" trick. Today our renderer assumes
RSEL=1 + CSEL=1 statically (= 25-row, 40-col); VICE computes the
display window dynamically per cycle and toggles the border
flip-flop accordingly.

## Why

Gap #1 in the parity audit. Highest visual impact — any demo or
intro that opens top/bottom or L/R border (classic effect since
1986) renders wrong. Standard games (motm/MM/LNR/IM2) don't use
the trick, but the gate-3 (Spec 280 OQ4) target was explicitly
"silikon-equivalent for demos too" once V3 ships. Required for
Scramble Infinity (Mirage) which uses border tricks heavily
(backlog task #64).

## VICE source (canonical reference)

### Files

```
/Users/alex/Development/C64/Tools/vice/vice/src/vicii/
  vicii-mem.c           ← d011_store + d016_store
                          + check_lower_upper_border (vertical FF)
                          + check_left_right_border    (horizontal FF)
  vicii.c               ← raster.geometry init
                          + display_xstart/xstop/ystart/ystop
  vicii-draw.c          ← border draw uses raster.blank_enabled
```

### Border flip-flop (canonical model from vicii-mem.c)

Two flip-flops drive border rendering:

1. **Vertical FF** (`raster.blank_enabled`):
   - SET when entering `display_ystop+1` (= last visible line + 1)
     OR when DEN=0 at line `display_ystart`
   - CLEARED when entering `display_ystart` AND DEN=1

2. **Horizontal FF** (per-cycle, drives L/R border):
   - SET when reaching `display_xstop` (cycle 56 / pixel 344 in
     40-col mode, cycle 55 / pixel 335 in 38-col)
   - CLEARED when reaching `display_xstart` AND vertical FF cleared
     (cycle 17 / pixel 32 in 40-col, cycle 18 / pixel 39 in 38-col)

Both FFs are visible in `vicii.raster.blank_enabled` and the
per-line border-on counter inside `vicii-draw.c`.

### Display window constants (VICE PAL)

| RSEL | display_ystart | display_ystop |
|------|----------------|---------------|
| 1 (25-row, default) | 51 | 250 |
| 0 (24-row) | 55 | 246 |

| CSEL | display_xstart | display_xstop |
|------|----------------|---------------|
| 1 (40-col, default) | 24 | 343 (= 24+320-1) |
| 0 (38-col) | 31 | 334 (= 31+304-1) |

### Open-border trick

```
Top/bottom: at line `display_ystop`, write D011 with RSEL=0 BEFORE
            cycle 0 of next line. The vertical FF set-event sees
            display_ystop changed, so set-condition not met. Border
            stays off through what would have been bottom border.

L/R: at cycle 55 (= 38-col stop), flip CSEL 1→0. At cycle 56
     (= 40-col stop), CSEL is 0 so the 40-col set-event doesn't
     fire. Horizontal FF stays cleared. Border open until next
     cycle 18+ (next line's FF clear).
```

The trick requires CYCLE-EXACT register-write timing. Our spec 280
already captures cycle-resolution writes; this spec adds the
flip-flop semantics on top.

## Our current state

### Where we are wrong

```ts
// src/runtime/headless/peripherals/vic-renderer-rasterized.ts
// Hardcoded constants (assume RSEL=1, CSEL=1 always):
const VISIBLE_X = 32;        // hardcoded — ignores CSEL
const VISIBLE_Y = 51;        // hardcoded — ignores RSEL
const VISIBLE_W = 320;       // hardcoded — ignores CSEL
const VISIBLE_H = 200;       // hardcoded — ignores RSEL
```

```ts
// src/runtime/headless/vic/raster-state.ts
// rsel/csel ARE captured in state but never consumed for geometry:
export interface RasterState {
  rsel: boolean;          // ← captured, unused
  csel: boolean;          // ← captured, unused
  den: boolean;           // ← consumed for blanking, but border
                          //    flip-flop semantics not modeled
  // ...
}
```

### What works

- $D011 + $D016 writes captured per-cycle (Spec 280a + 262 Phase A)
- DEN=0 → entire visible area = border color (just-shipped fix)
- Mid-line border-color changes via border lane

### What's missing

- Geometry recompute on RSEL/CSEL flip
- Per-line vertical-FF state machine (set/clear conditions)
- Per-cycle horizontal-FF state machine (set/clear conditions)
- Renderer consults FFs instead of hardcoded VISIBLE_X/Y

## Plan

### Phase 281a — RasterState extension

Add to `raster-state.ts`:

```ts
export interface RasterState {
  // ... existing ...

  // Geometry (re-computed on every RSEL/CSEL write).
  display_ystart: number;     // 51 (RSEL=1) or 55 (RSEL=0)
  display_ystop: number;      // 250 or 246
  display_xstart_cycle: number; // 17 (CSEL=1) or 18 (CSEL=0)
  display_xstop_cycle: number;  // 56 or 55
  display_xstart_pixel: number; // 24 or 31 (cycleToPixelX(start))
  display_xstop_pixel: number;  // 343 or 334

  // Border flip-flops.
  vertical_ff: boolean;     // set = top/bottom border ON
  horizontal_ff: boolean;   // set = L or R border ON

  // State for FF transition checks (VICE row_24/25_start/stop_line).
  row_24_start_line: number;  // = 55  (PAL)
  row_24_stop_line: number;   // = 247
  row_25_start_line: number;  // = 51
  row_25_stop_line: number;   // = 251
}
```

`initStateFromVic` populates VICE PAL constants. NTSC offsets
deferred to a later spec (currently V3 ships PAL only).

### Phase 281b — Vertical FF logic

Mirror VICE `check_lower_upper_border`. Called on every RSEL flip
AND on every line transition.

```ts
export function updateVerticalBorderFF(
  state: RasterState,
  newRsel: boolean,
  line: number,
  cycleInLine: number,
): void {
  const oldRsel = state.rsel;
  if (oldRsel === newRsel) return;

  if (newRsel) {
    // 24 → 25 row mode switch
    state.display_ystart = state.row_25_start_line;
    state.display_ystop = state.row_25_stop_line;

    if (line === state.row_24_stop_line && cycleInLine > 0) {
      state.vertical_ff = true;
    } else {
      // Still on first row-24 line OR first row-25 line: a 24→25 flip
      // *kills* the about-to-set FF.
      if (!state.vertical_ff && line === state.row_24_start_line && cycleInLine > 0) {
        state.vertical_ff = false;
      }
      if (line === state.display_ystart && cycleInLine > 0 && !state.vertical_ff) {
        state.vertical_ff = false;
      }
    }
  } else {
    // 25 → 24 row mode switch
    state.display_ystart = state.row_24_start_line;
    state.display_ystop = state.row_24_stop_line;

    if (!state.vertical_ff && line === state.row_25_start_line && cycleInLine > 0) {
      state.vertical_ff = false;  // open-top trick
    } else {
      if (line === state.row_25_stop_line && cycleInLine > 0) {
        state.vertical_ff = true;
      }
    }
  }
  state.rsel = newRsel;
}

export function checkLineBoundaryFF(state: RasterState, line: number): void {
  // Run at start of each line BEFORE per-cycle changes.
  if (line === state.display_ystop + 1 || (line === state.display_ystart && !state.den)) {
    state.vertical_ff = true;
  }
  if (line === state.display_ystart && state.den) {
    state.vertical_ff = false;
  }
}
```

### Phase 281c — Horizontal FF logic

```ts
export function updateHorizontalBorderFF(
  state: RasterState,
  newCsel: boolean,
  cycleInLine: number,
): void {
  const oldCsel = state.csel;
  if (oldCsel === newCsel) return;
  state.csel = newCsel;
  state.display_xstart_cycle = newCsel ? 17 : 18;
  state.display_xstop_cycle  = newCsel ? 56 : 55;
  state.display_xstart_pixel = newCsel ? 24 : 31;
  state.display_xstop_pixel  = newCsel ? 343 : 334;
  // FF state itself NOT changed by CSEL flip — depends purely on
  // whether we cross the (new) start/stop boundaries during the
  // remainder of the line. The per-cycle line walk handles it.
}

export function checkHorizontalFFAtCycle(state: RasterState, cycleInLine: number): void {
  // Set on stop boundary.
  if (cycleInLine === state.display_xstop_cycle) state.horizontal_ff = true;
  // Clear on start boundary AND vertical FF off.
  if (cycleInLine === state.display_xstart_cycle && !state.vertical_ff) {
    state.horizontal_ff = false;
  }
}
```

### Phase 281d — Renderer integration (VICE batched structure)

`vic-renderer-rasterized.ts` — mirror VICE `raster-line.c`:

```ts
// REMOVE:
const VISIBLE_X = 32, VISIBLE_Y = 51, VISIBLE_W = 320, VISIBLE_H = 200;

// REPLACE with per-line FF state machine + batched span draw:
function renderLine(line: number, state: RasterState, lanes: LaneSet) {
  // 1. Vertical FF transition at line boundary (cheap, runs once).
  checkLineBoundaryFF(state, line);

  // 2. Walk RSEL/CSEL/border-color changes by `where`-sorted queue
  //    only (NOT per-cycle naive). Update FF state at each entry.
  computeOpenLeftRightFlags(state, lanes);

  // 3. Background fill: 1 memset call (or 2 if border-color flips).
  fillBackgroundLine(state, lanes);

  // 4. Render gfx (text/bitmap/sprites) into the gfx region (= VICE
  //    gfx_position.x..gfx_position.x+gfx_size.width).
  renderGfxLine(state, line, lanes);

  // 5. Sprites: render where horizontal_ff && vertical_ff both off
  //    (not just inside display window).
  renderSpritesLine(state, line, lanes);

  // 6. Borders: 2-span draw, skip on open_left_border /
  //    open_right_border / border_disable. Mid-line border-color
  //    via `border_changes` queue (often 0..2 entries).
  drawBordersLine(state, lanes);
}
```

Mirror of VICE `raster_line.c:204 raster_line_draw_borders` —
NO per-pixel FF check, instead 2 batched memset spans gated by
`open_left_border` / `open_right_border` / `border_disable` flags
that the FF state machine sets.

### Phase 281e — Tests (regression + real-demo only)

1. **Regression** (`scripts/smoke-vic-static-border-regression.mjs`):
   motm/MM/LNR/IM2 frames must remain pixel-identical to pre-281
   baseline. No demo trick, just verify static RSEL=1 path
   unchanged.

2. **Scramble Infinity (Mirage)** ingestion + frame-diff vs VICE.
   Depends on backlog #64 (corpus ingest). Once available:
   `scripts/smoke-scramble-infinity-vs-vice.mjs` renders ~2 frames
   from intro (border-trick zone) + diffs vs pre-captured VICE
   frames.

Synthetic open-top + open-L/R smokes intentionally **skipped** —
real demo + regression suite is enough proof.

### Phase 281f — Cleanup + documentation

- Delete the hardcoded VISIBLE_* constants
- Update `docs/re-phases.md` border-render section
- Update `EPIC_ROADMAP.md` parity matrix

## Open Questions — RESOLVED

### OQ1 — Border color source on open-border  ✅ YES (bg-color)

When border is OPEN (FF off) in what would normally be border
zone, what color do we draw? VICE draws **background color**
(`bg_color` from $D021). Our current code draws border color in
that zone. For open-border to look right we MUST switch to
bg_color. Confirm: `draw bg_color (not border color) when both FFs
off, even outside the nominal display window`.

**Resolved:** YES — when both FFs off, draw `bg_color` ($D021),
not `border_color` ($D020). 1:1 VICE.

### OQ2 — Sprite handling in open-border zone  ✅ YES (FF-gated)

When sprites are positioned OUTSIDE nominal display window (e.g.
border sprites for split-screen tricks), do they render? VICE: yes
if the FF is off at sprite-X. So sprite rendering must consult
horizontal FF, not the hardcoded display_xstart/stop.

**Resolved:** YES — sprite visibility = `!horizontal_ff &&
!vertical_ff`. Border-sprites for split-screen tricks render.

### OQ3 — NTSC support  ✅ DEFER

NTSC has different `row_24_*` and `row_25_*` line numbers:
- NTSC row_25: 51..250 (same as PAL — coincidence)
- NTSC row_24: 55..246 (same)
- BUT NTSC has 65 cycles/line + 263 lines, so vertical FF
  transitions differ.

**Resolved:** PAL only this spec. NTSC own follow-up spec when
needed (not currently used in V3, all gate-targets are PAL).

### OQ4 — Test corpus for gate  ✅ (a) + (c)

Which programs must look pixel-equal vs VICE before promoting
this fix?
- (a) motm/MM/LNR/IM2 (static borders, regression check)
- (b) Synthetic open-top + open-L/R smoke PRGs (must work)
- (c) Real demo with border tricks — Scramble Infinity (Mirage)
  recommended via backlog task #64
- (d) all of the above

**Resolved:** (a) + (c) only.
- (a) motm/MM/LNR/IM2 regression: must remain identical (static
  border, no demo trick).
- (c) Scramble Infinity (Mirage): must render pixel-equal to VICE
  (real-world demo with border tricks).
- Synthetic smokes (b) skipped — not worth the maintenance.

### OQ5 — Performance budget  ✅ (b) batched/segmented from start

Per-line FF check + per-cycle horizontal FF check adds 63 cycles
of overhead per scanline × 312 lines × 50 fps = ~1M extra ticks/s.
Estimate: <0.5% renderer overhead. If unacceptable, we'd need to
batch FF transitions into segments. Default: don't optimize until
measured.

**Resolved:** (b) — mirror VICE structure from day 1. Per-line
`draw_borders()` draws 2 spans `[0..display_xstart-1]` and
`[display_xstop..end]`, NOT per-cycle walk. Mid-line border-color
changes via `border_changes` queue (often 0..2 entries).
`open_left_border` / `open_right_border` flags from FF state
machine. `border_disable` global skip. Hooks ready for Spec 290
raster cache later.

Reference: `/Users/alex/Development/C64/Tools/vice/vice/src/raster/raster-line.c`
`raster_line_draw_borders` (~line 204) + `fill_background` + the
`border_changes` queue handling above (~line 130).

## Acceptance criteria (gate)

- [ ] All 9 existing Spec 280 smokes still PASS
- [ ] motm/MM/LNR/IM2 frame snapshots identical to pre-281 baseline
  (no regression on static-border games)
- [ ] Scramble Infinity (Mirage) renders pixel-equal to VICE
  (opens border at intro). Backlog task #64 ingests it as test
  corpus first.
- [ ] No frame drop in vice-rasterized renderer (< 0.5% overhead
  measured via existing perf smoke)
- [ ] Border-rendering structure mirrors VICE: per-line 2-span
  `draw_borders` + `border_changes` queue + open_left/right flags +
  border_disable global skip — ready for Spec 290 raster cache
  hooks.

## Files touched

- `src/runtime/headless/vic/raster-state.ts` — geometry fields,
  FF state, line/row constants
- `src/runtime/headless/vic/raster-changes-builder.ts` — emit
  RSEL/CSEL transitions per cycle
- `src/runtime/headless/peripherals/vic-renderer-rasterized.ts` —
  remove hardcoded VISIBLE_*, add per-line/per-cycle FF walk
- `scripts/smoke-vic-static-border-regression.mjs` — new
- `scripts/smoke-scramble-infinity-vs-vice.mjs` — new (depends #64)
- `docs/re-phases.md` — border-render section update
- `EPIC_ROADMAP.md` — parity matrix update
