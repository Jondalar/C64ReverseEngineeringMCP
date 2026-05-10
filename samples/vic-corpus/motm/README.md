# motm Gold-Master References

VICE x64sc reference PNGs for Murder on the Mississippi VIC-II
behavior. Compare against literal-port renders for acceptance.

## Files

  ingame1-vice-reference.png
    In-game scene: steamboat (bitmap mode top half) + menu text
    (text mode bottom half) + hand-cursor sprite + flag/wave sprites.
    Captured from VICE x64sc PAL 6569R3 with default colodore palette.
    Demonstrates:
      - Bitmap mode in upper portion
      - Text mode + multi-line ECM/MCM in lower portion
      - Multi-color sprites (sprite-bg + sprite-spr collision active)
      - $D018 / $D016 mid-frame state changes between bitmap + text
      - Color RAM driving per-cell colors

## Use

For Spec 296 corpus / Spec 298k acceptance:
  1. Boot session with literal port + per-cycle interleave enabled
  2. Load motm, navigate to in-game state matching this reference
  3. Capture literal-port PNG via renderToPng
  4. Pixel-diff vs ingame1-vice-reference.png
  5. Acceptance = zero diff in visible band, or documented residual
     with VICE source line ref

Capture script (when available):
  node scripts/vic-corpus-capture.mjs --game motm --phase ingame1 \
       --disk samples/motm.g64 [--literal]
