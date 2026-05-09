// Spec 292 — VIC-II $D019 IRQ state machine.
//
// Mirrors VICE vicii-irq.c (~165 LOC). Edge-tracked IRQ flag state per
// source. $D019 layout:
//   bit 0: raster IRQ (= raster_y == raster_irq_line)
//   bit 1: sprite-bg collision
//   bit 2: sprite-sprite collision
//   bit 3: light pen
//   bit 7: summary (= OR of bits 0..3 masked by $D01A)
//
// Read $D019: returns latched flags + summary bit 7.
// Write $D019: bits set to 1 CLEAR the corresponding flag (write-1-clear).
// $D01A: IRQ enable mask. Only flags with mask bit set assert summary
// bit 7 + drive the CPU IRQ line.

export const VICII_IRQ_RASTER  = 0x01;
export const VICII_IRQ_SBCOLL  = 0x02;  // sprite-bg
export const VICII_IRQ_SSCOLL  = 0x04;  // sprite-sprite
export const VICII_IRQ_LIGHTPEN = 0x08;
export const VICII_IRQ_SUMMARY = 0x80;

/** Mutable IRQ state. Held alongside vic state. */
export interface VicIrqState {
  /** Combined $D019 register value (= flags + summary bit 7). */
  status: number;
  /** $D01A IRQ enable mask. Bits 0..3 = sources; bits 4..7 = unused. */
  mask: number;
  /** Whether IRQ line is currently asserted to CPU. */
  lineAsserted: boolean;
}

export function createVicIrqState(): VicIrqState {
  return { status: 0, mask: 0, lineAsserted: false };
}

/**
 * Recompute summary bit 7 + lineAsserted based on current status + mask.
 * Mirrors VICE vicii_irq_set_line().
 */
function updateLine(state: VicIrqState): void {
  if ((state.status & state.mask & 0x0f) !== 0) {
    state.status |= VICII_IRQ_SUMMARY;
    state.lineAsserted = true;
  } else {
    state.status &= 0x7f;
    state.lineAsserted = false;
  }
}

/** Raise raster IRQ flag (bit 0). */
export function setRasterIrq(state: VicIrqState): void {
  state.status |= VICII_IRQ_RASTER;
  updateLine(state);
}

/** Raise sprite-bg collision IRQ flag (bit 1). */
export function setSbCollIrq(state: VicIrqState): void {
  state.status |= VICII_IRQ_SBCOLL;
  updateLine(state);
}

/** Raise sprite-sprite collision IRQ flag (bit 2). */
export function setSsCollIrq(state: VicIrqState): void {
  state.status |= VICII_IRQ_SSCOLL;
  updateLine(state);
}

/** Raise light pen IRQ flag (bit 3). */
export function setLightPenIrq(state: VicIrqState): void {
  state.status |= VICII_IRQ_LIGHTPEN;
  updateLine(state);
}

/** Update IRQ enable mask ($D01A write). */
export function setMask(state: VicIrqState, value: number): void {
  state.mask = value & 0x0f;  // only low 4 bits valid
  updateLine(state);
}

/**
 * Read $D019: returns latched flags + summary bit 7. Open-bus high
 * nibble: VICE returns bits 4..6 = 1 (= 0x70 mask).
 */
export function readD019(state: VicIrqState): number {
  return (state.status & 0x8f) | 0x70;
}

/**
 * Write $D019: write-1-clear semantics per bit. Bits set to 1 in
 * the written value CLEAR the corresponding flag in status.
 * Mirrors VICE vicii_irq_status_clear.
 */
export function writeD019(state: VicIrqState, value: number): void {
  // Clear flagged bits (bits 0..3 only); bit 7 reflects summary.
  state.status &= ~(value & 0x0f);
  updateLine(state);
}

/** Write $D01A: update IRQ mask. Bits 4..7 forced to 1 on read. */
export function writeD01A(state: VicIrqState, value: number): void {
  setMask(state, value & 0x0f);
}

/** Read $D01A: returns mask with high nibble = 0xF (open bus). */
export function readD01A(state: VicIrqState): number {
  return (state.mask & 0x0f) | 0xf0;
}
