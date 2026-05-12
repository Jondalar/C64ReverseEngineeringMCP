// Spec 293 — VIC-II light pen $D013/$D014.
//
// Mirrors VICE vicii.c:702 vicii_trigger_light_pen + light_pen_x/y
// latching. Functional impl replaces stub returning 0.
//
// Real-HW behavior:
// - Light gun connector trigger sets $D013 = X / 2 (= 9-bit raster X
//   shifted to 8-bit), $D014 = raster Y, asserts $D019 bit 3 (LP IRQ).
// - One latch per frame: subsequent triggers ignored until the next
//   raster wrap.
// - Reading $D013/$D014 returns the latched values; reading does NOT
//   clear the latch.

import { setLightPenIrq, type VicIrqState } from "./vic-irq.js";

export interface LightPenState {
  /** Latched X coordinate ($D013 raw value). */
  x: number;
  /** Latched Y coordinate ($D014 raw value). */
  y: number;
  /** True if a light-pen trigger has fired this frame (= latch held). */
  triggered: boolean;
}

export function createLightPenState(): LightPenState {
  return { x: 0, y: 0, triggered: false };
}

/**
 * Trigger light pen. Per VICE: the first trigger of the frame
 * latches X / Y and asserts the LP IRQ bit. Subsequent triggers
 * within the same frame are ignored.
 *
 * @param state    light pen state
 * @param irqState VIC IRQ state (Spec 292) — LP bit 3 asserted on trigger
 * @param rasterX  raw raster X (0..503 PAL); will be /2 + 0x20 per VICE
 *                 vicii.c:702 formula `VICII_RASTER_X(mclk%cycles_per_line)
 *                 - screen_leftborderwidth + 0x20`. We accept the final
 *                 X value pre-divided by caller; for direct use pass X/2.
 * @param rasterY  raster line (= $D014 byte; truncated to 8 bits)
 */
export function triggerLightPen(
  state: LightPenState,
  irqState: VicIrqState,
  rasterX: number,
  rasterY: number,
): boolean {
  if (state.triggered) return false;  // one-shot per frame
  state.x = rasterX & 0xff;
  state.y = rasterY & 0xff;
  state.triggered = true;
  setLightPenIrq(irqState);
  return true;
}

/** Reset latch at frame start (= per VICE vsync handler). */
export function resetLightPenLatch(state: LightPenState): void {
  state.triggered = false;
}

/** Read $D013 (light pen X). Returns latched value, no clear. */
export function readD013(state: LightPenState): number {
  return state.x & 0xff;
}

/** Read $D014 (light pen Y). Returns latched value, no clear. */
export function readD014(state: LightPenState): number {
  return state.y & 0xff;
}
