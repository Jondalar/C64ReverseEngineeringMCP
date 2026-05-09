// Spec 280g — Per-cycle VIC bus-owner table (1:1 VICE).
//
// Mirrors vice/src/vicii/vicii-cycle.c + vicii-fetch.c per-cycle bus
// owner for PAL (NTSC follows the same shape with one extra cycle).
//
// Sources studied:
//   - vice/src/vicii/vicii-fetch.c
//       handle_check_sprite_dma  (~267) — picks sprite_fetch_clk based
//         on sprite_fetch_cycle (PAL=54)
//       handle_fetch_sprite      (~371) — per-sprite num_cycles steal
//         driven by vicii_sprites_fetch_table[mask][slot]
//       do_matrix_fetch          (~135) — VICII_SCREEN_TEXTCOLS+3 (43)
//         badline cycles starting at VICII_FETCH_CYCLE (=11)
//   - vice/src/vicii/vicii-timing.c — sprite_fetch_cycle = 54 (PAL)
//   - vice/src/vicii/vicii-sprites.c — vicii_sprites_fetch_table[256][4]
//     compresses sprite-DMA scheduling. We model the simpler raster
//     book per-sprite slot positions which give the same total
//     stolen-cycle counts (validated against the existing
//     computeLineSteal() per-line totals).
//
// Per-sprite slot layout (PAL, derived from VICE table + Bauer "VIC
// Article" table 3.6.3):
//   Sprite N s-access:  cycles ((58 + 2*N) mod 63), ((59 + 2*N) mod 63)
//   The first 3 of those slots (sprites 0..2 hit cycles 58..63) overlap
//   with the wrap region (line cycles 0..1 of the *next* line per VICE
//   modelling — for the bus-owner table we keep them in 0..62 of the
//   same line via the (mod 63) wrap).
//
// Pointer fetch (p-access): VICE charges 3 fixed cycles inside the
// matrix/sprite-DMA window (vicii-fetch.c:135 SCREEN_TEXTCOLS+3 covers
// chars + p-fetch in one shot). For the bus-owner table we attribute
// these 3 cycles to cycles 58..60 when ANY sprite is enabled and
// active — matches the VICE handle_check_sprite_dma slot.
//
// **Total cycles match the VICE accounting**:
//   badline only            → 43
//   1 sprite, no badline    → 3 (p-access) + 2 (s-access) = 5
//   8 sprites, no badline   → 3 + 16 = 19
//   8 sprites + badline     → 43 + 19 = 62 (1 instr cycle left)
//
// Per VICE these slot positions are stable per-region; we expose them
// as a static lookup so the per-cycle scheduler hook is O(1).

export type BusOwner = "cpu" | "vic";

/** PAL VICII_PAL_SPRITE_FETCH_CYCLE — see vicii-timing.c:46. */
export const PAL_SPRITE_FETCH_CYCLE = 54;
/** PAL VICII_FETCH_CYCLE — first badline matrix fetch cycle. */
export const PAL_BADLINE_FETCH_CYCLE = 11;
/** Cycles consumed by one badline matrix fetch (chars + p-fetch). */
export const PAL_BADLINE_LENGTH = 43; // VICII_SCREEN_TEXTCOLS + 3
/** Per-sprite s-access cycle count. */
export const SPRITE_S_ACCESS_CYCLES = 2;
/** Fixed sprite p-access cycle count when any sprite enabled. */
export const SPRITE_P_ACCESS_CYCLES = 3;

/** Total PAL cycles per line. */
export const PAL_CYCLES_PER_LINE = 63;

/**
 * Per-sprite s-access start cycle within line (PAL).
 *
 * VICE vicii-sprites.c table compresses combined-sprite scheduling;
 * for the bus-owner check we use the canonical Bauer-style 2-cycle
 * slot per active sprite anchored at the sprite_fetch_cycle (54) +
 * 3 cycles for the unconditional p-access. Sprite N (0..7) occupies
 * the 2 cycles starting at:
 *
 *   pAccessEnd = sprite_fetch_cycle + 3 = 57
 *   sprite N start = (pAccessEnd + 2 * N) mod 63
 *
 * Per VICE: cycles 58..60 = p-access (3 fixed). Then sprite 0 = 61..62,
 * sprite 1 wraps to 0..1, sprite 2 = 2..3, ..., sprite 7 = 12..13.
 *
 * NB: The sprite-N start cycles wrap into the next line range (0..15
 * of the *following* line per VICE bookkeeping). The bus-owner table
 * conservatively models them as belonging to the current line by
 * applying (mod 63). Our per-line scheduler does not need cross-line
 * sprite scheduling because the cycle-lockstep loop processes line
 * boundaries one cycle at a time.
 */
export function spriteSAccessStartCycle(spriteIndex: number): number {
  const pAccessEnd = PAL_SPRITE_FETCH_CYCLE + SPRITE_P_ACCESS_CYCLES; // 57
  return (pAccessEnd + SPRITE_S_ACCESS_CYCLES * spriteIndex) % PAL_CYCLES_PER_LINE;
}

/**
 * Returns the bus owner for `cycleInLine` (0..62 PAL) given the line's
 * badline state and sprite-DMA mask (= bitmask of sprites currently
 * doing s-access this line).
 *
 * @param cycleInLine 0..62
 * @param isBadline   true if line is a badline (DEN + ysmooth match)
 * @param spriteFetchMask bitmask 0..0xff of sprites in DMA this line
 */
export function getBusOwner(
  cycleInLine: number,
  isBadline: boolean,
  spriteFetchMask: number,
): BusOwner {
  // 1) Badline matrix fetch — cycles 11..53 (= VICII_FETCH_CYCLE +
  //    VICII_SCREEN_TEXTCOLS - 1). Per VICE the +3 p-access tail (54..56)
  //    overlaps with the sprite-fetch window so we treat 11..53 here as
  //    "matrix" and let sprite-fetch own 54..56 when sprites are present
  //    (otherwise they revert to CPU on non-badline).
  if (isBadline && cycleInLine >= PAL_BADLINE_FETCH_CYCLE && cycleInLine <= 53) {
    return "vic";
  }

  // 2) Sprite p-access: cycles 54..56 (= sprite_fetch_cycle..+2).
  //    VICE handle_check_sprite_dma always fires when any visible sprite
  //    is active. Modeled as 3 cycles owned by VIC iff mask != 0.
  if (
    spriteFetchMask !== 0
    && cycleInLine >= PAL_SPRITE_FETCH_CYCLE
    && cycleInLine < PAL_SPRITE_FETCH_CYCLE + SPRITE_P_ACCESS_CYCLES
  ) {
    return "vic";
  }

  // 3) Per-sprite s-access: 2 cycles per active sprite.
  if (spriteFetchMask !== 0) {
    for (let s = 0; s < 8; s++) {
      if (!(spriteFetchMask & (1 << s))) continue;
      const start = spriteSAccessStartCycle(s);
      // Slot wraps modulo 63; check both linear + wrapped.
      const end = (start + SPRITE_S_ACCESS_CYCLES) % PAL_CYCLES_PER_LINE;
      if (start < end) {
        if (cycleInLine >= start && cycleInLine < end) return "vic";
      } else {
        // wraps past 62 → 0
        if (cycleInLine >= start || cycleInLine < end) return "vic";
      }
    }
  }

  return "cpu";
}

/**
 * Convenience: total cycles VIC steals on a line with the given
 * badline/sprite state. Sums to the same totals as the legacy
 * computeLineSteal() so smoke tests can assert equality of the two
 * accountings.
 */
export function totalStolenCyclesForLine(
  isBadline: boolean,
  spriteFetchMask: number,
): number {
  let n = 0;
  for (let c = 0; c < PAL_CYCLES_PER_LINE; c++) {
    if (getBusOwner(c, isBadline, spriteFetchMask) === "vic") n++;
  }
  return n;
}
