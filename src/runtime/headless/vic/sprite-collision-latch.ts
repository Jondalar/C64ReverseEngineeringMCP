// Spec 296c — VIC sprite collision latches + IRQ timing.
//
// 1:1 model of viciisc/vicii-draw-cycle.c:342-430 + vicii-mem.c:537-558
// for $D01E (sprite-sprite) and $D01F (sprite-background) latches.
//
// Semantics (from VICE source):
//
//   During pixel draw:
//     - For each visible pixel:
//       - sprite mask = bit-OR of sprite indices whose pixel is opaque here
//       - if popcount(spriteMask) >= 2: sprite_sprite_collisions |= spriteMask
//       - if spriteMask != 0 AND foreground graphics pixel here:
//             sprite_background_collisions |= spriteMask
//
//   Read $D01E: returns sprite_sprite_collisions; schedules clear via
//     clear_collisions = 0x1e (NOT cleared immediately).
//   Read $D01F: returns sprite_background_collisions; schedules clear via
//     clear_collisions = 0x1f.
//
//   The actual clear happens on the NEXT VIC cycle after the read
//   (vicii-cycle.c:413-425). This delay matters for raster-IRQ-timed
//   collision polling.
//
//   Writes to $D01E / $D01F are IGNORED.
//
//   IRQ timing (vicii-cycle.c:407-432):
//     snapshot = (sprite_sprite_collisions == 0)
//     ... draw cycle (may set bits) ...
//     if snapshot && (sprite_sprite_collisions != 0):
//       raise IRQ source IRQ_SPRITE_SPRITE
//     same shape for sprite_background_collisions / IRQ_SPRITE_BACKGROUND.
//   Side effect: IRQ raises ONLY on the 0 → non-0 edge, not while latch
//   is already non-zero.
//
//   peek (debug read): returns latch WITHOUT scheduling clear.
//
// Note: actual sprite pixel mask generation lives in the sprite renderer
// (existing code). This module only provides the LATCH STATE + per-pixel
// update + read-clear scheduler. Wiring into the cycle-driven renderer
// is a separate subspec when we drive from the cycle-pump (296a-5).

/** IRQ source bits (VICE: VICII_IRQ_SPRITE_*). */
export const IRQ_SPRITE_SPRITE = 0x04;
export const IRQ_SPRITE_BACKGROUND = 0x02;

export interface SpriteCollisionState {
  /** $D01E latch: per-sprite bit set if 2+ sprites collide. */
  sprite_sprite_collisions: number;
  /** $D01F latch: per-sprite bit set if sprite pixel hits fg gfx. */
  sprite_background_collisions: number;
  /** Bit 0x1e set = $D01E read pending clear; bit 0x1f set = $D01F. */
  clear_collisions: number;
}

export function newSpriteCollisionState(): SpriteCollisionState {
  return {
    sprite_sprite_collisions: 0,
    sprite_background_collisions: 0,
    clear_collisions: 0,
  };
}

export function resetSpriteCollisionState(s: SpriteCollisionState): void {
  s.sprite_sprite_collisions = 0;
  s.sprite_background_collisions = 0;
  s.clear_collisions = 0;
}

/** popcount helper. */
function popcount8(v: number): number {
  v = v & 0xff;
  v = v - ((v >> 1) & 0x55);
  v = (v & 0x33) + ((v >> 2) & 0x33);
  return (v + (v >> 4)) & 0x0f;
}

/**
 * Per-pixel collision update.
 *
 * spriteMask: bit n = sprite n has an OPAQUE pixel at this position.
 *             (= multicolor sprite "11" pattern, hi-res sprite "1",
 *             after sprite priority + transparency selection).
 * fgGfxPixel: 1 if the current background graphics pixel is FOREGROUND
 *             (= drawn from gbuf with priority over sprite, or just
 *             "non-bg" depending on mode/priority register).
 *
 * Returns IRQ-edge bits (= which IRQ sources transitioned 0 → non-0).
 *
 * Mirrors vicii-draw-cycle.c:342-430.
 */
export function pixelCollisionUpdate(
  s: SpriteCollisionState,
  spriteMask: number,
  fgGfxPixel: 0 | 1,
): number {
  const m = spriteMask & 0xff;
  let edge = 0;

  // Sprite-sprite collision: 2+ sprite bits set.
  if (popcount8(m) >= 2) {
    const wasZero = s.sprite_sprite_collisions === 0;
    s.sprite_sprite_collisions |= m;
    if (wasZero && s.sprite_sprite_collisions !== 0) edge |= IRQ_SPRITE_SPRITE;
  }

  // Sprite-bg collision: any sprite bit set AND fg gfx pixel.
  if (m !== 0 && fgGfxPixel === 1) {
    const wasZero = s.sprite_background_collisions === 0;
    s.sprite_background_collisions |= m;
    if (wasZero && s.sprite_background_collisions !== 0) edge |= IRQ_SPRITE_BACKGROUND;
  }

  return edge;
}

/**
 * Read $D01E (sprite-sprite collision latch).
 * Returns current latch value AND schedules clear on next cycle.
 *
 * VICE: vicii-mem.c:537-548.
 */
export function readD01E(s: SpriteCollisionState): number {
  const v = s.sprite_sprite_collisions & 0xff;
  s.clear_collisions |= 0x1e;   // request clear
  return v;
}

/**
 * Read $D01F (sprite-background collision latch).
 * Returns current latch value AND schedules clear on next cycle.
 *
 * VICE: vicii-mem.c:548-558.
 */
export function readD01F(s: SpriteCollisionState): number {
  const v = s.sprite_background_collisions & 0xff;
  s.clear_collisions |= 0x1f;   // request clear
  return v;
}

/**
 * peek $D01E without scheduling clear (debug only).
 */
export function peekD01E(s: SpriteCollisionState): number {
  return s.sprite_sprite_collisions & 0xff;
}

/**
 * peek $D01F without scheduling clear (debug only).
 */
export function peekD01F(s: SpriteCollisionState): number {
  return s.sprite_background_collisions & 0xff;
}

/**
 * Apply pending read-clears. Call once per VIC cycle AFTER any reads.
 * Mirrors vicii-cycle.c:413-425.
 */
export function applyDeferredCollisionClear(s: SpriteCollisionState): void {
  if (s.clear_collisions & 0x1e) {
    s.sprite_sprite_collisions = 0;
  }
  if (s.clear_collisions & 0x1f) {
    s.sprite_background_collisions = 0;
  }
  s.clear_collisions = 0;
}

/**
 * Writes to $D01E / $D01F are IGNORED in real hardware.
 * Provide a write hook anyway so memory bus can call it without branching.
 * No-op by design — DO NOT modify the latches here.
 */
export function writeD01E(_s: SpriteCollisionState, _value: number): void {
  // ignored
}
export function writeD01F(_s: SpriteCollisionState, _value: number): void {
  // ignored
}
