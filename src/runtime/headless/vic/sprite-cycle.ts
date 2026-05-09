// Spec 297h — VIC sprite cycle multiplexer.
//
// 1:1 model of viciisc/vicii-sprites.c: per-sprite engine that
// consumes DMA bytes during sprite-fetch cycles (= cycles 1-10 and
// 58-63 per cycle_tab_pal) and emits opaque/transparent pixels
// during draw cycles 16-55 of the line on which the sprite is active.
//
// Per VICE: 8 sprite engines run in parallel. Each tracks its own
// x position, y trigger, expand-y counter, MC mode, MC colors, color,
// and 3-byte data buffer + 24-bit shift register.
//
// Pixel emit semantics:
//   - Hi-res sprite: 1 bit per pixel; opaque iff bit=1.
//   - MC sprite: 2-bit pairs from shifter; pair value:
//       00 → transparent
//       01 → \$D025 (sprite mc color 1)
//       10 → \$D027+n (per-sprite color)
//       11 → \$D026 (sprite mc color 2)
//   - X-expand: each bit (hi-res) or pair (MC) takes 2 pixels.
//
// Priority ($D01B per sprite):
//   - bit clear: sprite over bg
//   - bit set:   bg fg over sprite (sprite hidden behind fg pixels)
//
// Sprite-sprite priority: lower sprite index wins overlap.
//
// This module focuses on the per-sprite ENGINE state + emit.
// Wiring into the cycle pump (cycle table dispatch + DMA fetch
// scheduling + framebuffer write) lives in cycle-pumped-renderer.ts.

export interface SpriteEngine {
  /** Sprite index 0..7. */
  index: number;
  /** $D000+2n / $D010 — full 9-bit x position (0..511). */
  x: number;
  /** $D001+2n — Y position (0..255). */
  y: number;
  /** $D015 bit n — sprite enabled. */
  enabled: boolean;
  /** $D027+n — sprite color (4-bit). */
  color: number;
  /** $D01B bit n — priority over fg gfx (true = sprite behind fg). */
  priorityOverBg: boolean;
  /** $D01C bit n — multicolor mode. */
  multicolor: boolean;
  /** $D01D bit n — x-expand. */
  xExpand: boolean;
  /** $D017 bit n — y-expand. */
  yExpand: boolean;

  // ---- Runtime state ----
  /** True while sprite is rendering on the current line. */
  active: boolean;
  /** 24-bit shift register fed from the 3-byte data buffer. */
  shifter: number;
  /** Bits remaining in shifter (= 24 max, 0 when done). */
  shifterBits: number;
  /** X-expand half-toggle (= 1 → consume bit/pair this pixel; 0 → skip). */
  xExpandHalf: number;
  /** MC pair latch: holds the current 2-bit value across 2 (or 4 with x-expand) pixels. */
  mcPairLatch: number;
  /** MC pair phase: 0 = sample new pair, 1 = hold across companion pixel. */
  mcPairPhase: number;
  /** Y-expand line toggle (0 = next sprite-data row, 1 = repeat current). */
  yExpandToggle: number;
  /** Which sprite-data row is currently being shifted in (0..20). */
  spriteRow: number;
  /** 3 bytes loaded by sprite DMA for the current row. */
  data0: number;
  data1: number;
  data2: number;
  /** New 3 bytes being loaded this line; published to data{0..2} when row starts. */
  pendingData0: number;
  pendingData1: number;
  pendingData2: number;
}

export function newSpriteEngine(index: number): SpriteEngine {
  return {
    index,
    x: 0, y: 0, color: 0,
    enabled: false, priorityOverBg: false,
    multicolor: false, xExpand: false, yExpand: false,
    active: false,
    shifter: 0, shifterBits: 0,
    xExpandHalf: 1,
    mcPairLatch: 0, mcPairPhase: 0,
    yExpandToggle: 0, spriteRow: 0,
    data0: 0, data1: 0, data2: 0,
    pendingData0: 0, pendingData1: 0, pendingData2: 0,
  };
}

/**
 * Apply VIC register snapshot to an engine. Called whenever the
 * cycle pump samples regs.
 */
export function loadSpriteRegs(
  engine: SpriteEngine,
  d000plus2n: number, d010MsbBit: number, d001plus2n: number,
  d015EnableBit: boolean, d017YExpandBit: boolean,
  d01BPriorityBit: boolean, d01CMcBit: boolean, d01DXExpandBit: boolean,
  d027plusN: number,
): void {
  engine.x = (d000plus2n & 0xff) | ((d010MsbBit & 1) << 8);
  engine.y = d001plus2n & 0xff;
  engine.enabled = d015EnableBit;
  engine.color = d027plusN & 0x0f;
  engine.priorityOverBg = d01BPriorityBit;
  engine.multicolor = d01CMcBit;
  engine.xExpand = d01DXExpandBit;
  engine.yExpand = d017YExpandBit;
}

/**
 * Called at the start of each new raster line. Triggers the engine
 * if Y matches and sprite is enabled. Also advances Y-expand toggle.
 *
 * Mirrors viciisc/vicii-sprites.c sprite_dma_check + advance.
 */
export function onLineStart(engine: SpriteEngine, raster_y: number): void {
  if (engine.enabled && (raster_y & 0xff) === engine.y && !engine.active) {
    // Y trigger — sprite starts rendering on this line.
    engine.active = true;
    engine.spriteRow = 0;
    engine.yExpandToggle = 0;
  }
  if (engine.active) {
    if (!engine.yExpand || engine.yExpandToggle === 0) {
      // Advance to next sprite-data row.
      engine.spriteRow++;
      if (engine.spriteRow > 21) {
        engine.active = false;
        return;
      }
    }
    if (engine.yExpand) engine.yExpandToggle ^= 1;
    // Load shifter from DMA data for this row.
    engine.shifter = (engine.pendingData0 << 16)
                   | (engine.pendingData1 << 8)
                   | (engine.pendingData2);
    engine.shifterBits = 24;
    engine.xExpandHalf = 1;
    engine.mcPairLatch = 0;
    engine.mcPairPhase = 0;
  }
}

/**
 * Fetch DMA bytes for this sprite. Called by cycle pump at
 * SPR_DMA0/1/2 cycle types per cycle_tab_pal. byteIdx 0..2.
 */
export function loadSpriteDmaByte(engine: SpriteEngine, byteIdx: number, value: number): void {
  const v = value & 0xff;
  if (byteIdx === 0) engine.pendingData0 = v;
  else if (byteIdx === 1) engine.pendingData1 = v;
  else if (byteIdx === 2) engine.pendingData2 = v;
}

/**
 * Compute the per-pixel sprite color for the current pixel position.
 *
 * Returns 4-bit color index or null (= transparent / sprite not at this pixel).
 *
 * Caller advances pixelX externally; we just consume shift register
 * bits if pixelX matches sprite range.
 *
 * For a hi-res sprite covering pixels [x, x+24): each bit emits 1 pixel.
 * For x-expand: each bit emits 2 pixels.
 * For MC sprite: each 2-bit pair emits 2 (or 4 with x-expand) pixels.
 */
export function emitSpritePixel(
  engine: SpriteEngine, pixelX: number,
  d025Mc1: number, d026Mc2: number,
): number | null {
  if (!engine.active) return null;
  if (engine.shifterBits <= 0) return null;
  // Sprite covers pixels [x, x + width):
  //   hi-res = 24, x-expand = 48
  //   mc same width but pairs span 2/4 pixels.
  const width = engine.xExpand ? 48 : 24;
  if (pixelX < engine.x || pixelX >= engine.x + width) return null;

  let color: number | null = null;
  if (engine.multicolor) {
    // MC pair: top 2 bits of shifter
    if (engine.mcPairPhase === 0) {
      engine.mcPairLatch = (engine.shifter >> 22) & 0x03;
      engine.mcPairPhase = 1;
    } else {
      engine.mcPairPhase = 0;
    }
    const pair = engine.mcPairLatch;
    switch (pair) {
      case 0: color = null; break;            // transparent
      case 1: color = d025Mc1 & 0x0f; break;  // mc1
      case 2: color = engine.color; break;    // sprite color
      case 3: color = d026Mc2 & 0x0f; break;  // mc2
    }
    // Advance shifter by 2 bits when pair complete (mcPairPhase wrapped to 0)
    if (engine.mcPairPhase === 0) {
      // Already consumed — but with x-expand we use 2 emits per phase
      if (!engine.xExpand || engine.xExpandHalf === 0) {
        engine.shifter = (engine.shifter << 2) & 0xffffff;
        engine.shifterBits -= 2;
      }
      if (engine.xExpand) engine.xExpandHalf ^= 1;
    }
  } else {
    // Hi-res: top bit
    const bit = (engine.shifter >> 23) & 1;
    color = bit ? engine.color : null;
    if (!engine.xExpand || engine.xExpandHalf === 0) {
      engine.shifter = (engine.shifter << 1) & 0xffffff;
      engine.shifterBits -= 1;
    }
    if (engine.xExpand) engine.xExpandHalf ^= 1;
  }
  return color;
}

/** Build per-sprite mask of opaque pixels at this position. */
export function spriteMaskAt(
  engines: SpriteEngine[], pixelX: number,
  d025: number, d026: number,
): { mask: number; pixelByIndex: (number | null)[] } {
  const pixelByIndex: (number | null)[] = new Array(8).fill(null);
  let mask = 0;
  for (let i = 0; i < 8; i++) {
    const c = emitSpritePixel(engines[i]!, pixelX, d025, d026);
    pixelByIndex[i] = c;
    if (c !== null) mask |= (1 << i);
  }
  return { mask, pixelByIndex };
}
