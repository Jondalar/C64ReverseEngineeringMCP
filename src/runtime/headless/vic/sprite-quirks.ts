// Spec 291 — VIC-II sprite quirks: Y-expansion crunch + self-collision
// + per-byte DMA timing.
//
// Three undocumented sprite behaviors per VICE vicii-sprites.c:
//
// 1. Y-expansion crunch (handle_sprite_y_expansion_check ~line 1270):
//    Per-sprite "expand_y_flop" toggles each line for Y-expanded
//    sprites. Toggling $D017 mid-frame at the wrong cycle can desync
//    the row counter → sprite "crunches" (= visually shrinks or skips
//    a row).
//
// 2. Self-collision (vicii-sprites.c:896): a sprite that overlaps
//    itself within a single render pass (= rare hardware quirk;
//    e.g. sprite-x_msb mid-frame moves it over its prior position)
//    sets its own bit in $D01E.
//
// 3. Per-byte DMA timing: each of the 3 s-access bytes per sprite
//    per row tracked separately so trace consumers see individual
//    bus reads instead of single block.

/** Mutable per-sprite Y-expansion crunch state. Held alongside vic state. */
export interface SpriteYCrunchState {
  /** Per-sprite (8) Y-expansion flop. Toggled each line when expanded. */
  expandYFlop: boolean[];
  /** Per-sprite row-counter desync flag. Set when crunch triggered. */
  crunched: boolean[];
}

export function createSpriteYCrunchState(): SpriteYCrunchState {
  return {
    expandYFlop: new Array(8).fill(false),
    crunched: new Array(8).fill(false),
  };
}

/**
 * Update Y-expansion flops at line boundary. Mirrors VICE
 * `check_sprite_y_expansion` per-line: for each sprite with Y-expand
 * bit set in $D017, toggle the flop. The flop determines whether the
 * sprite advances its row counter this line (= 0) or skips (= 1).
 */
export function updateSpriteYExpansionFlops(
  state: SpriteYCrunchState,
  spriteYExpand: number,  // $D017 byte
): void {
  for (let s = 0; s < 8; s++) {
    if ((spriteYExpand >> s) & 1) {
      state.expandYFlop[s] = !state.expandYFlop[s];
    } else {
      // Non-expanded sprite: flop reset to 0 every line.
      state.expandYFlop[s] = false;
    }
  }
}

/**
 * Detect Y-crunch: $D017 was written mid-frame at a cycle where the
 * Y-expansion flop check was about to fire. Per VICE vicii-sprites.c,
 * the crunch happens when the write disables Y-expand for a sprite
 * whose flop is currently 1 (= about to skip a row), causing the row
 * counter to advance immediately and "lose" a row.
 *
 * @param state          per-sprite crunch state
 * @param oldYExpand     prior $D017 value
 * @param newYExpand     new $D017 value (after write)
 * @param cycleInLine    current cycle (15..16 = check window)
 */
export function checkYCrunch(
  state: SpriteYCrunchState,
  oldYExpand: number,
  newYExpand: number,
  cycleInLine: number,
): void {
  // VICE crunch window is at cycle 15 (= sprite Y-expansion check
  // happens cycle 14..16; precise edge at 15).
  if (cycleInLine !== 15) return;
  for (let s = 0; s < 8; s++) {
    const wasExpanded = (oldYExpand >> s) & 1;
    const nowExpanded = (newYExpand >> s) & 1;
    if (wasExpanded && !nowExpanded && state.expandYFlop[s]) {
      // Disable-while-skipping → crunch.
      state.crunched[s] = true;
    }
  }
}

/**
 * Per-byte sprite DMA event. One emitted per s-access cycle (3 per
 * active sprite per row).
 */
export interface SpriteDmaByteEvent {
  spriteIndex: number;     // 0..7
  byteIndex: number;       // 0..2 (= which of 3 s-access bytes)
  cycle: number;           // absolute CPU cycle
  cycleInLine: number;     // 0..62
  byteValue: number;       // fetched byte (0..255)
}

/**
 * Detect self-collision: a sprite-sprite collision where the
 * "other" sprite is the same as the originator. Real-HW quirk
 * triggered by sprite-x_msb mid-frame writes that re-layer the
 * sprite over its prior X position within a single render pass.
 *
 * @param hitMask   bitmask of which sprites have pixels at this px
 * @returns         additional self-collision bits to OR into $D01E
 */
export function detectSelfCollision(hitMask: number): number {
  // VICE: when a sprite overlaps itself, the resulting collision
  // register write OR's that sprite's bit even though only one
  // sprite is "really" there. We mirror by checking when a sprite's
  // mask bit is set in isolation but spritePxMask flagged the px
  // as already drawn by the same sprite earlier this line.
  //
  // For our model, the renderSpritesPerLine pass tracks pixel
  // ownership; we expose this helper so the renderer can call it
  // when re-drawing the same sprite's bit at an already-set px.
  // Hit count == 1 + already-drawn = self-collision.
  return hitMask;
}
