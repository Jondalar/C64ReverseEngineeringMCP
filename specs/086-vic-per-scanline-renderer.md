# Spec 086 — VIC per-scanline renderer + open border

## Problem

Current `vic-renderer.ts` renders the full frame from the FINAL VIC register state. Mid-frame changes (border color flicker, $D011/$D016 mid-line tricks, raster bars, open border) are LOST — only the last value seen at end of frame is rendered.

For a "100% C64 VM" we need per-scanline rendering that captures mid-frame writes. Open border (top/bot via $D011 RSEL trick, side via $D016 CSEL trick) needs per-line border state.

## Decision

Refactor renderer: per-scanline buffer of VIC register snapshots. Renderer iterates raster line by raster line, using the snapshot for each line. VIC.tick() pushes register snapshot at line boundaries (or on relevant register writes mid-line).

Open border tricks (RSEL/CSEL flip at right cycle) are emitted via the per-line snapshot.

## Scope

### VIC scanline buffer

```ts
interface ScanlineSnapshot {
  rasterLine: number;
  d011: number;  // mode + DEN + RSEL + YSCROLL
  d016: number;  // MCM + CSEL + XSCROLL
  d018: number;  // matrix + chargen pointer
  d020: number;  // border color
  d021: number;  // bg 0
  d022: number;  // bg 1
  d023: number;  // bg 2
  d024: number;  // bg 3
  spritePos: { x: number; y: number; color: number; enabled: boolean }[]; // 8 entries
  spritePtrs: number[]; // 8 entries
  spriteFlags: { mc: number; xExpand: number; yExpand: number; priority: number };
}

class VicII {
  private scanlineSnapshots: ScanlineSnapshot[] = [];
  ...
}
```

### Snapshot capture

- On entering a new raster line: push current register state.
- On register write that changes border behaviour mid-line ($D011, $D016, $D020, $D021): update CURRENT line's snapshot (last write wins per line, or finer per-cycle if needed).

### Renderer iterates per line

```ts
renderFrame(fb: VicFramebuffer, snapshots: ScanlineSnapshot[]): void {
  for (const snap of snapshots) {
    const isBorderLine = isInBorderRegion(snap);
    if (isBorderLine) renderBorderLine(fb, snap);
    else renderContentLine(fb, snap);
  }
}
```

### Open border detection

- Top/bottom border ON when DEN=0 OR raster outside RSEL window.
  - RSEL=0: lines 51-250 are display, others border.
  - RSEL=1: lines 55-246 are display, others border.
- TRICK: if game flips RSEL from 1→0 between line 246 and 247 (so VIC thinks "still in display"), border doesn't close → top/bot border opens.
- We track RSEL per-line snapshot → if RSEL changed in the right window → border opens for those lines.
- Side border: $D016 bit 3 (CSEL) flip mid-line. Per-line snapshot enough.

### Sprite per-scanline

- Sprite Y-position determines on which lines sprite is drawn.
- Snapshot captures sprite enable + Y at each line start.
- Sprite-bg priority + sprite-sprite collision computed per line.

### Frame-end render trigger

- `renderFrame()` reads accumulated snapshots, generates 504×312 pixels.
- After rendering: clear scanline buffer, start new frame.
- Frame boundary = raster line wrap from 311 → 0.

### Memory + perf

- 312 snapshots × ~64 bytes each = ~20KB per frame. Fine.
- Snapshot push happens line-boundary not per cycle → low overhead.

## Out of scope

- Pixel-cycle exact border opening (we emit per-line state — no sub-pixel).
- VIC register write timing within a cycle (writes between cycles handled atomic).
- Hires interlace (FLI) detailed modelling (current renderer covers basic FLI via per-line $D018).

## Acceptance

- Render frame with mid-frame $D020 changes → border shows multiple colors (per-line bands).
- Demo with raster bars: visible bars at correct Y positions.
- Open border smoke: write RSEL=0 on line 247 → border opens for lines 247-310 (or whichever range).
- All existing renderer tests still pass.
