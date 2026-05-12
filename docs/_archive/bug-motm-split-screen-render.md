# Bug: motm steamboat menu split-screen render

**Date:** 2026-05-09
**Status:** OPEN
**Severity:** High (= blocks visual verification of motm ingame +
all raster-IRQ split-screen demos / games)
**Backlog task:** #81
**Renderer:** vice-rasterized (Spec 280 / 281 / 285 / 295)

## Symptom

motm bootet komplett bis zum steamboat menu (= "Start from beginning"
+ load game options). Title screen + credits rendern korrekt. Aber
steamboat menu = grey screen mit gelegentlich einer dashed line.

```
t=30s   MURDER title       ✅ rendert pixel-perfect
t=60s   transition          black (= expected)
t=90s+  steamboat menu      ❌ all-grey + dashed line
        PC stuck in motm main loop $B7BD..$B7BF
        D011=$07 (DEN bit cleared at frame end)
        D020=$0B (grey border)
```

VICE bei gleicher state: bitmap (steamboat) oben, text menu unten,
split via raster IRQ.

## Known facts

### What works
- motm code IS executing (PC = motm main loop $B7BD)
- Disk fastloader completed fully
- VIC chip state machine ticks (per-cycle log captures writes)
- Sprites rendered correctly when DEN=1
- Title screen (no split) = pixel-perfect

### What's broken
- Renderer reads `state.den` at line render time
- For motm ingame: $D011 written multiple times per frame
  (raster IRQ flips DEN mid-frame)
- Frame-end value of $D011 = $07 (DEN=0)
- Renderer treats whole frame as DEN=0 → all border color

### Code path
```
src/runtime/headless/peripherals/vic-renderer-rasterized.ts
  renderOneLine()
    updateVerticalFFAtLineStart() — sets vertical_ff
    if (state.vertical_ff && lanes empty) → fillBorder + return
    walk bg lane → applyAction → emitGfxRun
    drawBorderBands()
```

`state.den` updated by applyAction when "video_mode" lane fires (= d011
write). But the per-line walk only checks state.vertical_ff at line
start, NOT state.den.

### emitGfxRun shortcut
```ts
// src/runtime/headless/peripherals/vic-renderer-rasterized.ts ~244
if (!state.den) {
  fillSpan(fb, line, fillX0, fillX1, state.border_color);
  return;
}
```

Fills border color when DEN=0 — correct for whole-frame DEN=0 but wrong
for mid-frame DEN flip: when DEN flips back to 1 mid-line, this branch
already fired with stale DEN.

## Hypothesis tree

### H1: Frame-entry DEN sticks
**Theory:** initStateFromVic reads $D011 at frame entry. If frame-entry
$D011=$07 (DEN=0) and motm sets DEN=1 mid-frame via raster IRQ, our
renderer never sees the DEN=1 transition.

**Test:** dump frameLineLogs writes for motm steamboat frame. Look
for $11 register writes with DEN bit set per scanline.

**If H1:** wire `applyAction` for "video_mode" → set state.den from d011 bit 4.

### H2: applyAction sets state.den correctly but renderer skips
**Theory:** lane changes propagate state.den, but renderOneLine
short-circuits on early `if (state.vertical_ff)` before bg lane walk
fires the DEN-changing action.

**Test:** add per-line trace: log state.den at line entry + after each
lane action.

**If H2:** reorder — apply lane changes EARLIER (before vertical_ff
short-circuit) OR remove short-circuit when lanes non-empty.

### H3: Mid-line DEN ignored even within emitGfxRun
**Theory:** emitGfxRun checks `state.den` once per call. If DEN flips
mid-segment, emitGfxRun draws all-or-nothing.

**Test:** synthetic test — set $D011 via lane at where=160 (mid-line).
Render one line. Pixels 0..159 should respect old DEN, 160..end new
DEN.

**If H3:** split emitGfxRun at DEN-change points within bgQueue walk.

### H4: $D011 writes not in raster_changes lane
**Theory:** vic-ii-vice captureScanline doesn't trigger on $D011
writes during steamboat menu (= raster IRQ writes get suppressed).

**Test:** grep frameLineLogs for register=0x11 entries. Count per
frame.

**If H4:** add $D011 to capture-trigger list in vic-ii-vice.ts.

### H5: Raster IRQ not firing in our impl
**Theory:** motm's raster IRQ at line N (where DEN flips) isn't
firing → DEN stays at initial value → never drawn.

**Test:** dump $D019 IRQ status across frames. Check IRQ counter
delta. Compare PC trace against VICE trace at same cycle.

**If H5:** Spec 292 IRQ state machine integration needed (= currently
shipped as data + smoke, NOT wired into vic-ii-vice).

## Trace strategy

### Step 1: Snapshot motm steamboat menu state

Build a deterministic snapshot reaching the menu:

```js
// scripts/dbg-motm-menu.mjs
const session = startIntegratedSession({
  diskPath: "samples/motm.g64",
  mode: "true-drive", useMicrocodedCpu: true,
});
session.resetCold("pal-default");
session.runFor(5_000_000);
session.typeText('LOAD"*",8,1\r');
session.runFor(60_000_000);
session.typeText("RUN\r");
session.runFor(150_000_000);  // = into steamboat menu

// Save snapshot
const vsf = saveSessionVsf(session);
writeFileSync("/tmp/motm-menu-snapshot.vsf", vsf);
```

Re-load snapshot for repeated trace runs (= deterministic input,
no fastloader timing variability).

### Step 2: Per-frame $D011 write log

Instrument frameLineLogs dump:

```js
// scripts/dbg-motm-d011-trace.mjs
loadSnapshot("/tmp/motm-menu-snapshot.vsf");
session.runFor(20_000);  // ~1 frame
const frame = session.vic.frameLineLogs;
for (const line of frame) {
  for (const w of line.writes ?? []) {
    if (w.reg === 0x11) {
      console.log(`line ${line.rasterLine} cyc ${w.cycleInLine} d011=$${w.value.toString(16)} DEN=${(w.value>>4)&1}`);
    }
  }
}
```

Expected (per H4 / H5): multiple $D011 writes per frame at specific
raster lines. If no writes → H5 (IRQ not firing). If writes present
but render still grey → H1/H2/H3.

### Step 3: VICE comparison

Run motm in VICE x64sc with same snapshot point:

```bash
# In VICE monitor:
io     # show $D011, $D012, $D019 current
break $B7BD
g
# When break hits, dump VIC state per scanline
```

Compare $D011 write timing. If VICE has same writes at same cycles
but renders correctly → render bug. If VICE has DIFFERENT writes →
upstream chip-state bug.

### Step 4: Per-line render diff

Synthetic minimal test: build a fake `frameLineLogs` with known
$D011 mid-frame DEN flip → render → compare each scanline's
expected pixel pattern.

```js
// scripts/dbg-vic-mid-frame-den.mjs
const fb = new VicFramebuffer(true);
const ctx = {
  vic: {
    regs: new Uint8Array(64),
    frameLineLogs: [
      { rasterLine: 100, writes: [
        { cycleInLine: 0, reg: 0x11, value: 0x10 }, // DEN=1 at line start
      ]},
      { rasterLine: 150, writes: [
        { cycleInLine: 0, reg: 0x11, value: 0x00 }, // DEN=0 mid-frame
      ]},
    ],
  },
  bus: minimalBus,
  initialCia2PaByte: 3,
};
renderFrameRasterized(fb, ctx);
// Verify: line 100..149 = bg, line 150..251 = border
```

This decouples motm code execution from render correctness.

### Step 5: Bisect

If render works on synthetic mid-DEN-flip test but fails on motm:
- Capture motm frameLineLogs to JSON
- Replay against renderer in isolation
- Find which write doesn't propagate

If render fails on synthetic too: render bug → fix renderer first.

## Specific instrumentation to add

### A. RasterState debug snapshot per line

Add optional callback to `renderOneLine`:

```ts
function renderOneLine(..., debugHook?: (state, line) => void) {
  updateVerticalFFAtLineStart(state, line);
  debugHook?.(state, line);
  // ...
}
```

Test invokes with snapshot DEN/mode/raster_mode per line → diff vs
expected.

### B. Lane apply trace

```ts
export function applyAction(state, action, debugHook?) {
  const before = { ...state };
  // ... existing apply ...
  debugHook?.(action, before, state);
}
```

Test prints "at line N cyc C: d011 $00 → DEN 1→0".

### C. Mid-cycle render boundary

If H3: split emitGfxRun:

```ts
function emitGfxRun(...) {
  // Walk lane.background between [xStart, xEnd]
  // At each DEN-changing action, finish current sub-segment
  // and start fresh with new DEN.
  // ... per-segment fillSpan + mode draw ...
}
```

## Acceptance criteria for fix

1. **Synthetic mid-frame DEN flip smoke** (`scripts/smoke-mid-frame-den.mjs`):
   - Set $D011 DEN=1 at line 100, DEN=0 at line 150 → render → lines
     100..149 show bg color, lines 150..251 show border color.
2. **motm steamboat menu** renders bitmap top + text menu bottom
   instead of all-grey.
3. **Static-frame regression intact** — title screen + MM character
   select still pixel-equal.
4. **All 207 VIC parity smokes pass.**

## Related specs / past notes

- Spec 280 (raster_changes architecture): captures $D011 writes per
  cycle. ✓ data layer.
- Spec 281 (border geometry): vertical FF state — interacts with
  DEN at display_ystart. Possible interaction with mid-frame DEN.
- Spec 292 (D019 IRQ state machine): NOT wired into vic-ii-vice yet.
  If H5, this needs wiring.
- Conversation memory `project_motm_via1_ca1`: motm fastloader fixed
  (commit d927a1a). Boot path works, render the open issue.
- Conversation memory `feedback_vic_per_frame`: "VIC frame = per-
  scanline state — render whole frame from per-scanline register
  snapshots; never render from a mid-frame single state". Renderer
  must apply per-scanline state, not frame-end.

## Next concrete actions

1. Build snapshot at motm steamboat menu (`scripts/dbg-motm-menu.mjs`)
2. Dump per-frame $D011 write log → confirm presence + timing
3. Write synthetic mid-frame DEN smoke
4. If smoke FAILS → fix renderer per H1/H2/H3
5. If smoke PASSES → upstream issue → Spec 292 IRQ wire-up
   (Hypothesis H5)
6. Re-render motm steamboat menu → verify visual match against
   VICE PNG
