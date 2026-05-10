# VIC-II Literal Port — Bug Report

Tracks rendering bugs in the literal VICE x64sc TS port
(`src/runtime/headless/vic/literal/`) discovered during real-game
testing in the V3 UI. Focus = pixel/cycle differences vs VICE x64sc
reference output. See also Spec 296 (= VIC real-game stress corpus).

Migration plan: `docs/vic-ii-literal-port-migration-analysis-plan-2026-05-10.md`
Implementation pulls: Specs 300-309 (= literal port made authority).

Status legend:
- `OPEN` — reproduced, not fixed
- `INVESTIGATING` — diagnosis in progress
- `FIXED` — resolved + commit ref
- `WONT_FIX` — out of scope or accepted limitation

---

## Bug V1 — Sprites in side border / open-border missing details

**Status**: OPEN — REPRODUCED 2026-05-10
**Severity**: Medium — affects title screens/games using open-border trick.
**Repro**: Scramble Infinity loader credits screen. Trace shows D015=$FF
(all 8 sprites enabled) but no mid-line CSEL toggle (D016 stays $18
during sprite-display rasters).
Probe: `samples/screenshots/vic-bugs/scramble-02-credits-180M.png`.
**Reference**: Spec 281 (= "Border geometry dynamics RSEL/CSEL
mid-frame, open-border") — completed for VicIIVice but the literal
port draw_sprites in `vicii-draw-cycle.ts` only emits sprite pixels
within the display window. Real C64 hardware: sprites render across
the full visible area including border whenever VIC has display
window enabled, regardless of CSEL/RSEL.

**Symptom**: Sprite pixels disappear when `main_border` flag is set
for that pixel column. INFINITY logo rendered as missing letters.

**Suspected fix**: in `draw_sprites8` / `draw_sprites(i)` skip the
border-suppression path. Sprite render must precede `draw_border8` so
border can OVERPAINT sprite pixels in TOP/BOTTOM-border lines but
side border (= left/right) does not suppress sprites.

---

## Bug V2 — Mid-frame raster split causes per-line tearing on title text

**Status**: OPEN — REPRODUCED 2026-05-10 via probe-scramble-stages.mjs
**Severity**: Medium — affects fancy title screens with per-line
register changes (= rainbow text, animated logo).
**Repro**: Scramble Infinity loader credits screen. Boot via mount-API,
wait 180M cyc → "Ready Joy 2" credits frame. SCRAMBLE word at top has
horizontal stripes per char-row.
Probe: `node scripts/probe-scramble-stages.mjs` →
`samples/screenshots/vic-bugs/scramble-02-credits-180M.png`.

**Trace (1 frame, credits screen)**: 76 VIC writes across 34 raster lines.
Critical mode switches:
- raster 26: `D011=$5B D015=$FF` (= text mode + DEN, sprites enable)
- raster 45: `D016=$18 D011=$3B` (= switch to BMM with MCM)
- raster 150: D019 ack (raster IRQ #2)
- raster 155-170: `D016 $17↔$18` toggled every line (= MCM + xscroll
  toggle for animation effect on bottom band)
- raster 170: D019 ack

The SCRAMBLE banner sits in raster 26-45 = text-mode region. Literal
port likely consumes D011 mode change 1-2 cycles after VICE → some
char cells in transition rows render with stale mode → visible
tearing.
**Reference**: Spec 287 (Φ1/Φ2 addressbus phase modeling) +
Spec 286 (CIA2 PA bank-switch cycle-exact) both completed for
VicIIVice. Literal port matrix fetch reads `vicii.regs[0x18]` /
`regs[0x16]` LIVE but cycle-phase alignment vs CPU writes may be
off by 1 cycle in some patterns. Migration Phase 0.2 documented
"split-raster effects may show ±1-2 raster-cycle drift vs VICE".

**Symptom**: When game writes D016/D018/D021 mid-line for
multi-color title effects, our literal port samples old value for
some columns and new value for others, producing visible stripes.

**Suspected fix**: audit cycle-phase ordering of CPU `STA $D0xx` →
literal port matrix fetch consumption. May need 1-cycle delay/latch
in `vicii_store` for matrix-fetch-affecting registers. Compare
trace vs VICE for exact write→consume cycle delta.

---

## Bug V3 — Background scroll + sprite DMA produces horizontal stripes in sky

**Status**: OPEN
**Severity**: High — affects any side-scroller with sprites flying.
**Repro**: Scramble Infinity in-game. Player flies right, level
scrolls. Blue sky region (= upper background) shows horizontal blue
stripes during scroll. Stripes intensify when sprites (rockets) are
present. Right-edge column sometimes empty.
**Reference**: Spec 291 (Sprite quirks) + Spec 283 (BA/AEC) both
completed for VicIIVice. Literal port handles BA/AEC + sprite DMA but
the interaction during ACTIVE scroll (= D016 xscroll changing per
frame + sprite DMA stealing cycles + matrix fetch) may be glitchy.

**Symptom**: Sky background = solid color region. Should render as
uniform blue. Shows alternating blue/dark-blue horizontal stripes
during scroll. Pattern intensifies when sprites active.

**Suspected fix**:
1. Audit matrix fetch byte cache when sprite DMA pre-empts a badline
   cycle (= `vbuf` partially populated → wrong colors emitted)
2. Audit `litLastRasterLine` capture race in `tickLitVic` — when
   raster wraps mid-runFor, dbuf for line N may be captured TWICE or
   missed entirely
3. Possibly literalPortFb capture timing: line N captured at start
   of line N+1, but if that line is a badline DMA stall, the capture
   happens DURING fetch → partial dbuf

Plus: right-edge missing column suggests literal port stops drawing
1-2 cycles before VICE end-of-line. Audit `cycle_table_pal` last few
entries vs VICE viciisc.

---

## Bug V4 — Default palette differs from VICE Pepto reference

**Status**: WONT_FIX (= cosmetic; user accepted)
**Severity**: Low — colors look slightly off vs VICE screenshots.
**Repro**: Any rendered frame compared to VICE screenshot.
**Symptom**: Our default palette = colodore. VICE default = Pepto
or 6569R3. Color saturation + hue noticeably different.
**Workaround**: Pass `palette: "6569r3"` or `palette: "pepto"` to
session opts when starting (Spec 282 palettes available).
**Note**: User explicitly said "egal" 2026-05-10. Documented for
later when pixel-perfect VICE-diff CI returns.

---

## Bug V5 — Rendered output may show partial frame after fast scroll

**Status**: OPEN — secondary to V3; may share root cause
**Severity**: Medium
**Repro**: TBD — observed in Scramble in-game scroll captures
**Symptom**: Some frames captured by `renderToPng` show top/bottom
mismatch (= top from frame N, bottom from frame N-1).
**Reference**: `renderToPng` calls `runUntilFrameReady` which waits
for `LIT_TYPES.vicii.raster_line >= targetVisibleEnd` (= 248 PAL).
literalPortFb captures line N at start of line N+1 via tickLitVic.
If raster wraps inside runUntilFrameReady's poll loop, fb mixes
frames.

**Suspected fix**: capture FULL frame to a separate buffer at frame
boundary (= raster wrap to 0), then render that snapshot. Avoids
mid-frame sampling.

---

## How to add a new bug

Sequence:
1. Reproduce in headless OR UI; capture screenshot in
   `samples/screenshots/vic-bugs/V<N>-<short>.png`
2. Add entry above with: status, severity, repro PRG/scenario, symptom,
   reference Specs, suspected root cause, suspected fix.
3. If fix lands: change Status to `FIXED — commit <sha>` + add a one-
   line "Resolution" note describing the actual fix.

## Relationship to main BUGREPORT.md

Main `BUGREPORT.md` tracks tooling/workflow bugs (= MCP tools,
project knowledge fragmentation, mount-swap, etc). This file is
exclusively VIC-II rendering bugs in the literal port. Migration
plan + Spec 309 fix moved literal port to authoritative status; from
now on every pixel difference vs VICE x64sc lives here.
