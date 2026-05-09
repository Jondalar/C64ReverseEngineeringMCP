// Spec 284 — multicolor mask lookup table.
//
// Mirrors VICE's mcmsktable in vicii-draw.c:1503:
//
//   mcmsktable[i] = (i & 0xaa) | ((i & 0xaa) >> 1);
//
// Used by multicolor + illegal-mode draw routines to convert an 8-bit
// pixel pattern into a sprite-collision mask where each 2-bit pixel
// pair becomes 2 set bits if either bit was set. Pre-computed once
// for O(1) lookup during per-line render.

const TABLE = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  TABLE[i] = (i & 0xaa) | ((i & 0xaa) >> 1);
}

export const MC_MASK_TABLE: Readonly<Uint8Array> = TABLE;
export function mcMask(byte: number): number {
  return TABLE[byte & 0xff]!;
}
