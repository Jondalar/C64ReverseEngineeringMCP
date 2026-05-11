# Spec 284 — VIC-II illegal video modes 5/6/7 (chargen/bitmap-mask black)

**Sprint:** 144 (V3.1 VICE-parity series)
**Status:** RESOLVED 2026-05-09 — OQs answered, ready to implement
**Depends on:** Spec 281 (renderer mode dispatch)
**Sister specs:** 282, 283, 285..292

## Goal

Implement VIC-II illegal modes 5, 6, 7 the way VICE does:
- ALL visible pixels = black (color 0), NOT background_color
- GFX mask still computed from chargen/bitmap data (so sprite-bg
  collision detection sees the implied "shape")

Today our renderer falls back to `drawIdleSeg` which fills
`background_color` (= wrong color, also no collision mask).

## Why

Gap #3 in the parity audit. Real C64 hardware: when ECM+BMM,
ECM+MCM, or all-three are set in $D011/$D016, the VIC outputs
solid black for the gfx region. Sprite-bg collision STILL works
because the chip continues to fetch chargen/bitmap data and feed
it to the collision logic — the OUTPUT path goes to "all zero"
(black) but the COLLISION path doesn't.

Standard games don't deliberately use illegal modes, but some
demos / intros / loaders flip them briefly for effect (e.g.
"black flash" via mode-7 toggle). Without this spec we'd render
the bg color where VICE renders black — visible diff.

## VICE source (canonical reference)

### Files

```
/Users/alex/Development/C64/Tools/vice/vice/src/vicii/vicii-draw.c
  draw_illegal_text              line 1091  ← mode 5 (ECM+MCM)
  draw_illegal_bitmap_mode1      line 1187  ← mode 6 (ECM+BMM)
  draw_illegal_bitmap_mode2      line 1278  ← mode 7 (ECM+BMM+MCM)
```

### Key behavior (extracted)

All three illegal-mode draw routines do:

```c
memset(p + 8 * xs, 0, (xe - xs + 1) * 8);  // ← all visible pixels = 0
// then fill gfx mask with implied chargen/bitmap pattern for
// sprite-bg collision detection.
```

So the visual output is **always black** in illegal modes. The
collision mask uses:
- Mode 5: chargen[(vbuf[i] & 0x3f) * 8 + ycounter]
- Mode 6: bitmap_low / bitmap_high based on (memptr+i)<<3+ycounter,
  via `j & 0x1000` switch
- Mode 7: same as mode 6 but mc-mask-table applied

## Our current state

### Where we are wrong

```ts
// src/runtime/headless/peripherals/vic-renderer-rasterized.ts:260
switch (state.video_mode) {
  case 0: drawStdTextSeg(...);    break;
  case 1: drawMcTextSeg(...);     break;
  case 2: drawStdBitmapSeg(...);  break;
  case 3: drawMcBitmapSeg(...);   break;
  case 4: drawExtTextSeg(...);    break;
  default: drawIdleSeg(fb, line, a0, a1, state.background_color); break;
  //       ^^^^^^^^^^^ wrong — fills bg color, should be black + mask
}
```

`drawIdleSeg` fills `background_color`. For modes 5/6/7 we should
fill **color 0 (black)** AND populate the gfx mask from
chargen/bitmap.

### What works

- `video_mode` derivation from $D011/$D016 (already 0..7)
- Per-segment draw dispatch in renderer

### What's missing

- 3 illegal-mode draw routines
- Distinct dispatch for modes 5/6/7 (currently merged into idle)
- Sprite-bg collision mask population for illegal modes (= chargen
  or bitmap data lands in fgMask even though pixels stay black)

## Plan

### Phase 284a — Illegal-mode draw routines

Add 3 functions in `vic-renderer-rasterized.ts`:

```ts
// Mode 5: illegal-text. Visible = black. Mask = chargen pattern
// indexed by (vbuf[col] & 0x3f) * 8 + ycounter.
function drawIllegalTextSeg(fb, bus, state, line, x0, x1, fgMask) {
  // 1. Fill visible pixels with color 0 (black).
  fillSpan(fb, line, x0, x1, 0);
  // 2. Walk chars in segment, fetch chargen byte, populate mask.
  const charRow = (line - VISIBLE_Y) >> 3;
  const charY = (line - VISIBLE_Y) & 7;
  for (let x = x0; x <= x1; x++) {
    const xIn = x - VISIBLE_X;
    if (xIn < 0 || xIn >= VISIBLE_W) continue;
    const col = xIn >> 3;
    const charCode = vicRead(bus, state.vic_bank_base,
      state.screen_base_ptr + charRow * 40 + col) & 0x3f;
    const charByte = vicRead(bus, state.vic_bank_base,
      state.chargen_base_ptr + charCode * 8 + charY);
    const bit = (charByte >> (7 - (xIn & 7))) & 1;
    if (bit) fgMask[(line - VISIBLE_Y) * VISIBLE_W + xIn] = 1;
  }
}

// Mode 6: illegal-bitmap-mode1. Visible = black. Mask = bitmap byte
// indexed by (memptr + col) << 3 + ycounter, with j & 0x1000 switch.
function drawIllegalBitmapMode1Seg(fb, bus, state, line, x0, x1, fgMask) {
  fillSpan(fb, line, x0, x1, 0);
  // ... bitmap-fetch + mask population (mirror VICE inline logic)
}

// Mode 7: illegal-bitmap-mode2. Visible = black. Mask = bitmap with
// MC-mask-table applied (= 2-bit pixel pairs).
function drawIllegalBitmapMode2Seg(fb, bus, state, line, x0, x1, fgMask) {
  fillSpan(fb, line, x0, x1, 0);
  // ... bitmap-fetch + mc-mask population
}
```

### Phase 284b — Renderer dispatch

```ts
switch (state.video_mode) {
  case 0: drawStdTextSeg(fb, bus, state, line, a0, a1, fgMask); break;
  case 1: drawMcTextSeg(fb, bus, state, line, a0, a1, fgMask); break;
  case 2: drawStdBitmapSeg(fb, bus, state, line, a0, a1, fgMask); break;
  case 3: drawMcBitmapSeg(fb, bus, state, line, a0, a1, fgMask); break;
  case 4: drawExtTextSeg(fb, bus, state, line, a0, a1, fgMask); break;
  case 5: drawIllegalTextSeg(fb, bus, state, line, a0, a1, fgMask); break;
  case 6: drawIllegalBitmapMode1Seg(fb, bus, state, line, a0, a1, fgMask); break;
  case 7: drawIllegalBitmapMode2Seg(fb, bus, state, line, a0, a1, fgMask); break;
}
```

(Idle case is unreachable now — all 8 modes handled. Remove
default + `drawIdleSeg` if no other caller.)

### Phase 284c — Tests

Synthetic smoke `scripts/smoke-illegal-modes.mjs`:
1. Set $D011/$D016 to mode 5 → render frame → verify gfx region
   = solid black (= color 0 = palette[0] = (0,0,0)).
2. Same for modes 6, 7.
3. Verify sprite over illegal-mode background still triggers
   collision when overlapping with implied chargen/bitmap pixels.

Plus regression: motm/MM/LNR/IM2 baselines unchanged (they don't
use illegal modes).

## Open Questions — RESOLVED

### OQ1 — Color 0 source  ✅ (a) palette[0]

VICE always uses palette index 0 (= absolute black) for illegal
mode pixels, NOT $D021 background color. Confirm we mirror this:

- (a) Always palette[0] (= black, 1:1 VICE)
- (b) Use background_color (= our current behavior, wrong)

**Resolved:** (a) — always palette index 0 (= absolute black) for
illegal-mode visible pixels. NOT $D021. 1:1 VICE.

### OQ2 — Sprite-bg collision in illegal modes  ✅ (a) populate fgMask

Real HW: collision detection still runs on chargen/bitmap pattern
even though visible pixels are all black. Mirror this:

- (a) Populate fgMask in illegal-mode draw routines (= sprite-bg
  collision works)
- (b) Skip mask population (= no collision in illegal modes; wrong
  but cheaper)

**Resolved:** (a) — populate fgMask in illegal-mode draw routines
so sprite-bg collision works against implied chargen/bitmap
pattern. 1:1 VICE.

### OQ3 — Mode 7 mc-mask logic  ✅ (a) port mcmsktable

Mode 7 (ECM+BMM+MCM) uses a multicolor-mask table (`mcmsktable`)
that converts 2-bit pixel pairs to mask bits. Port the table?

- (a) Port mcmsktable (256-entry lookup) + use in mode 7
- (b) Skip mc-mask in mode 7, use plain bitmap mask

**Resolved:** (a) — port mcmsktable (256-entry lookup) and use
in mode 7 fgMask population. Full parity.

### OQ4 — Test corpus for gate  ✅ (a) + (c)

What proves illegal-mode parity?

- (a) Synthetic per-mode smoke (set $D011/$D016, render, check
  pixels = palette[0])
- (b) Lorenz testsuite (does it cover illegal modes?)
- (c) Regression motm/MM/LNR/IM2 (don't use illegal modes; pure
  regression)

**Resolved:** (a) + (c).
- (a) Synthetic scripts/smoke-illegal-modes.mjs: set
  $D011/$D016 to mode 5/6/7 → render → verify gfx region all black
  + sprite-bg collision triggers on implied chargen pattern.
- (c) motm/MM/LNR/IM2 regression remains 4/4 pass (no illegal
  mode usage; pure regression check).
- (b) Lorenz illegal-mode tests deferred — not all Lorenz disks
  cover illegal modes, follow-up if regression observed.

### OQ5 — Performance  ✅ (b) bulk memcpy + table lookup

3 new draw routines × per-line per-mode = same cost as existing
text/bitmap routines. Negligible. No batching needed.

- (a) Naive per-pixel draw (cleanest)
- (b) Optimize via memcpy + table lookup like VICE inline does

**Resolved:** (b) — match VICE inline impl: bulk pixel zero
(`fillSpan(fb, line, x0, x1, 0)` ≡ memset 0) + per-char fetch loop
that ONLY populates fgMask (skip per-pixel setPixel since pixels
are already 0). Existing mode 0..4 routines stay per-pixel
(unchanged); illegal modes use the leaner VICE pattern from day 1.

## Acceptance criteria (gate)

- [ ] Modes 5/6/7 render solid black (palette[0]) in gfx region
- [ ] Sprite-bg collision works on top of illegal-mode background
- [ ] mcmsktable ported for mode 7
- [ ] Spec 281 + 282 + 283 smokes still pass
- [ ] motm/MM/LNR/IM2 regression smoke still 4/4 pass
- [ ] New smoke `scripts/smoke-illegal-modes.mjs` 3+ tests pass

## Files touched

- `src/runtime/headless/peripherals/vic-renderer-rasterized.ts` —
  add 3 illegal-mode draw routines, update mode dispatch
- `src/runtime/headless/vic/mc-mask-table.ts` — new (256-entry
  multicolor mask lookup)
- `scripts/smoke-illegal-modes.mjs` — new
