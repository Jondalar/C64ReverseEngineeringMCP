// Spec 769.5a — checkpoint thumbnails for the scrub filmstrip.
//
// A thumbnail is a downscaled copy of the ALREADY-rendered live frame
// (literalPortFbStable, via session.renderLiteralPortIndexed) taken at checkpoint
// capture time — when that frame IS the anchor's frame. Cheap: no extra render
// (the live loop renders every frame anyway), tiny storage (~96×68 indexed ≈
// 6.5 KiB), and no per-anchor framebuffer in the checkpoint (BUG-049 stays fixed).
//
// Why captured (not lazily rendered): the literal-port VIC is a per-cycle stateful
// renderer — there is no pure "snapshot → frame" function, so a past anchor's frame
// cannot be re-derived without restoring (which would thrash the live machine).
// The thumbnail is therefore grabbed at the one moment the frame is live.

export interface CheckpointThumbnail {
  width: number;
  height: number;
  /** 48-byte RGB palette (16 × 3). */
  palette: Uint8Array;
  /** width*height palette indices (0..15). */
  indices: Uint8Array;
}

interface ThumbSession {
  renderLiteralPortIndexed?(): { width: number; height: number; indices: Uint8Array; palette: Uint8Array } | null;
}

/** Build a downscaled (nearest-neighbour, 1/`factor`) thumbnail of the current
 *  live frame, or null if no frame is rendered yet. The source `indices` buffer
 *  is POOLED (reused next call) so we copy into a fresh small array. */
export function makeCheckpointThumbnail(session: ThumbSession, factor = 4): CheckpointThumbnail | null {
  const f = session.renderLiteralPortIndexed?.();
  if (!f) return null;
  const ow = Math.floor(f.width / factor);
  const oh = Math.floor(f.height / factor);
  if (ow <= 0 || oh <= 0) return null;
  const out = new Uint8Array(ow * oh);
  for (let oy = 0; oy < oh; oy++) {
    const sy = oy * factor * f.width;
    const orow = oy * ow;
    for (let ox = 0; ox < ow; ox++) out[orow + ox] = f.indices[sy + ox * factor]!;
  }
  return { width: ow, height: oh, palette: new Uint8Array(f.palette), indices: out };
}
