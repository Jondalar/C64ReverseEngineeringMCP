// Spec 297j — VIC border state machine.
//
// 1:1 model of viciisc/vicii-cycle.c border check flag handling +
// vicii-draw-cycle.c draw_border8 emission.
//
// Two flags:
//   - vertical_border (= top/bottom border): set when raster_y outside
//     RSEL window OR DEN bit clear. Resets when DEN seen at first DMA
//     line.
//   - main_border (= left/right border): toggled at ChkBrdL/ChkBrdR
//     cycles per cycle table. Tied to CSEL bit.
//
// Border pixel = $D020.
//
// State machine inputs:
//   raster_y           — current scanline
//   raster_cycle       — current cycle within line (0..62 PAL)
//   d011               — DEN (bit 4), RSEL (bit 3)
//   d016               — CSEL (bit 3)
//   first_dma_line/last — RSEL=1: 51/250; RSEL=0: 55/246
//
// Per VICE state transitions (vicii-cycle.c handle_border_check):
//   - At cycle 17 Φ2: if CSEL=1 → main_border = false (enter visible
//     left col 1). If CSEL=0 → no transition this cycle.
//   - At cycle 18 Φ2: if CSEL=0 → main_border = false (enter visible
//     left col 0). If CSEL=1 → no transition this cycle.
//   - At cycle 56 Φ2: if CSEL=0 → main_border = true (exit at right
//     col 0). If CSEL=1 → no transition.
//   - At cycle 57 Φ2: if CSEL=1 → main_border = true (exit at right
//     col 1). If CSEL=0 → no transition.

export interface BorderState {
  /** Vertical border active = top/bottom band. */
  verticalBorder: boolean;
  /** Main (horizontal) border active = left/right band. */
  mainBorder: boolean;
}

export function newBorderState(): BorderState {
  return { verticalBorder: true, mainBorder: true };
}

export function resetBorderState(s: BorderState): void {
  s.verticalBorder = true;
  s.mainBorder = true;
}

/**
 * Vertical border range per RSEL bit.
 *   RSEL=1 (25 rows): top=51 bottom=250
 *   RSEL=0 (24 rows): top=55 bottom=246
 */
export function vertBorderRange(rsel: boolean): { top: number; bottom: number } {
  return rsel ? { top: 51, bottom: 250 } : { top: 55, bottom: 246 };
}

/**
 * Update vertical border flag at start of each line.
 * Call BEFORE per-cycle main-border updates for that line.
 *
 * Mirrors vicii-cycle.c handle_check_vert_border:
 *   - At top edge: if DEN=1 → vertical_border = false
 *   - At bottom edge: vertical_border = true
 */
export function onLineStartBorder(
  s: BorderState, raster_y: number, d011: number,
): void {
  const rsel = (d011 & 0x08) !== 0;
  const den = (d011 & 0x10) !== 0;
  const { top, bottom } = vertBorderRange(rsel);

  if (raster_y === bottom) {
    s.verticalBorder = true;
  }
  if (raster_y === top) {
    if (den) s.verticalBorder = false;
  }
  // When vertical border is set, main border is also forced set
  // (= entire visible band is border color).
  if (s.verticalBorder) s.mainBorder = true;
}

/**
 * Apply per-cycle main-border check (= ChkBrdL0/L1/R0/R1 from cycle table).
 *
 * Cycle is 1-based. Phase is "phi1" or "phi2".
 */
export function applyMainBorderCheck(
  s: BorderState, cycle: number, phase: "phi1" | "phi2",
  d016: number,
): void {
  if (phase !== "phi2") return;
  // Vertical border lock — main border can't open while in vertical band.
  if (s.verticalBorder) {
    s.mainBorder = true;
    return;
  }
  const csel = (d016 & 0x08) !== 0;
  if (cycle === 17 && csel) s.mainBorder = false;
  else if (cycle === 18 && !csel) s.mainBorder = false;
  else if (cycle === 56 && !csel) s.mainBorder = true;
  else if (cycle === 57 && csel) s.mainBorder = true;
}

/**
 * Is the current pixel in border? = mainBorder OR verticalBorder.
 */
export function isInBorder(s: BorderState): boolean {
  return s.mainBorder || s.verticalBorder;
}
