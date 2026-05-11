# VIC-II Fidelity Notes (Spec 105 / M2.3) — v1

## v1 status

| Sub-story | Status     | Where                                                             |
|-----------|------------|-------------------------------------------------------------------|
| M2.3 per-char-row dispatch | **Covered** | `vic-renderer.ts:renderFrame` walks rows 0..24 and looks up snap-at-row-top to pick mode + screen/char base |
| M2.3 snapshot lookup math  | **Covered** | `cpu-fidelity-tests.ts` snapshot lookup, same-line last-write-wins, frame wrap clear |
| M2.3a per-cycle scanline simulator | **Gap**     | Per-pixel-y dispatch (FLI etc.) deferred to v2; v1 is per-char-row |
| M2.3b sprite Y-crunch     | **Gap**     | Y-expansion crunch toggle mid-line not modeled |
| M2.3c mid-frame register write fixtures | **Partial** | Snapshot-lookup tests pin the data path; no PRG-driven golden PNG yet |
| M2.3d open-border tricks  | **Gap**     | DEN clear at right cycle to suppress badline not modeled |
| M2.3e raster IRQ jitter   | **Gap**     | jitter measurement / ≤ 7 cyc target deferred to v2 |
| M2.3f collision lifecycle | **Existing** | Sprint 74 handles sprite-bg + sprite-sprite read-clear |
| M2.3g bank-switch visibility | **Existing** | CIA2 PA bits 0-1 → vicBankBase already wired |
| M2.3h Documentation       | **This file** | — |

`npm run smoke:vic-fidelity` — 10/10 pass.
`npm run regress` — 5/5 still green after renderer rewrite.

## v1 win: MM character-selection screen now renders

Before Spec 105 v1: full-frame renderer used `vic.regs[0x11]/[0x16]/[0x18]`
at frame-end-time. Maniac Mansion uses a raster-IRQ split:

- Upper screen: text mode, screen $0c00, custom charset $3800 (logo + START)
- Lower screen: multicolor text mode, screen $0800, custom charset $1800 (portraits)

Frame-end snapshot only captured the LAST scanline's config (lower-half
MC settings) and rendered the entire 25-row visible area with that.
Result: garbled text mode rendering of the "MANIAC MANSION" logo because
upper half was being drawn with the lower half's char base.

After Spec 105 v1: each char row (8 px tall) reads its own snapshot and
dispatches to the matching mode renderer with the right d018 base.
MM logo + portraits + START button now visible. Color palette and a few
artifacts remain for v2 polish but the boot path renders the recognisable
title screen.

## Per-char-row dispatch design

```
renderFrame(fb, ctx):
  fillBorderPerScanline (existing per-line d020)
  for row in 0..24:
    rasterTop = VISIBLE_Y + row * 8                ; = 51 + row*8
    snap = snapAtLine(scanlineSnapshots, rasterTop)
    apply snap.d011 (DEN/BMM/ECM bits) + snap.d016 (MCM)
                    + snap.d018 (screen base, char base)
                    + snap.d021..d023 (bg, mc1, mc2)
    dispatch to mode-specific *Row renderer for this row
  renderSprites
```

`snapAtLine(snaps, line)` walks `scanlineSnapshots` (already sorted by
rasterLine), returns the latest snap with `rasterLine <= line`. Falls
back to live `vic.regs` when no snapshots exist (pre-render or short
budget).

The mode renderers all gained `*Row(args, row)` variants that paint
exactly one char row using the live `vic.regs[0x18]/...` (we
temporarily swap in the snap's values, render the row, swap back).
This avoids a deeper plumb of context through every helper.

## Border per-scanline (existing, retained)

`fillBorderPerScanline` already iterates fb.height per scanline and
uses each snap's d020 — unchanged. Border + visible-area rendering
now both honour per-line VIC state.

## v1 deviations / gaps

- **Sub-char-row mode change**: if a game changes d011/d016/d018
  mid-cell (FLI, e.g. 4 colors per scanline using $D018 toggling
  every line), v1 only sees the snap at the row's top scanline. v2
  needs per-pixel-y dispatch.
- **Color RAM mid-frame change**: Color RAM at $D800 is not part of
  scanline snapshot — the renderer reads live `bus.ram[0xd800+..]`.
  Games that write color RAM mid-frame produce wrong colors.
- **Sprite per-line state**: snap captures sprite enable + position +
  flags but renderSprites uses live registers. Sprite raster
  splits (multiplexer) won't render correctly.
- **Y-crunch**: `$D017` bit toggles mid-line aren't modeled.
- **RDY (badline) tie-in**: defer per Spec 103 fallback path.
- **PAL ↔ NTSC scanline count**: maxRasterLine + cyclesPerLine
  already honoured in vic-ii.ts.

## v2 roadmap

- Per-pixel-y dispatch for FLI/FLD: snapshot d011/d016/d018 on every
  raster line entry (already happens), renderer iterates pixel-y
  rows individually.
- Sprite multiplexer support: per-line sprite snapshot read.
- Color RAM mid-frame snapshot.
- $D017 Y-crunch.
- Cycle-accurate badline → CPU RDY.
- Raster IRQ jitter ≤ 7 cycles.
- Reference goldens: 12 fixtures with VICE-captured PNG state.

## Files

- `src/runtime/headless/peripherals/vic-renderer.ts` — `renderFrame`
  rewritten for per-row dispatch; `*Row` helpers added.
- `src/runtime/headless/peripherals/vic-ii.ts` — `scanlineSnapshots`
  unchanged; `captureScanline` already covers d011/d016/d018/d020/d021.
- `src/runtime/headless/c64/vic-fidelity-tests.ts` — 10 fixture checks.
- `scripts/smoke-vic-fidelity.mjs` + `npm run smoke:vic-fidelity`.
