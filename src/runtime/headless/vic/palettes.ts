// VIC-II palette — SINGLE SOURCE OF TRUTH.
//
// The entire system uses EXACTLY ONE palette: colodore, copied verbatim from
// VICE's data/C64/colodore.vpl (VICE 3.10). This is the palette fixed on
// 2026-06-05 (commit 5c5300a1) that renders the Wasteland intro correctly and
// is what the live UI shows now. By user mandate there is no palette suite and
// no selection: every consumer (live VIC, graphics-render decoder, UI decoder,
// fidelity tests) MUST resolve to these exact 16 RGB triples.
//
// (Was Spec 282's 8-palette selectable suite — pepto + Tobias-measured tables +
// odd/even split. All removed: a second table is a second way to be wrong.)

export type RGB = readonly [number, number, number];
export type Palette16 = ReadonlyArray<RGB>;

// 0  Black, 1  White, 2  Red, 3  Cyan, 4  Purple, 5  Green,
// 6  Blue, 7  Yellow, 8  Orange, 9  Brown, 10 Light Red,
// 11 Dark Grey, 12 Medium Grey, 13 Light Green, 14 Light Blue,
// 15 Light Grey
//
// Blue $06 = 27,24,c4 (NOT the older duller 2e,2c,9b) — the value that made
// blue-heavy screens like the Wasteland intro correct. Do NOT change these.
const COLODORE: Palette16 = [
  [0x00, 0x00, 0x00], [0xff, 0xff, 0xff], [0x96, 0x28, 0x2e],
  [0x5b, 0xd6, 0xce], [0x9f, 0x2d, 0xad], [0x41, 0xb9, 0x36],
  [0x27, 0x24, 0xc4], [0xef, 0xf3, 0x47], [0x9f, 0x48, 0x15],
  [0x5e, 0x35, 0x00], [0xda, 0x5f, 0x66], [0x47, 0x47, 0x47],
  [0x78, 0x78, 0x78], [0x91, 0xff, 0x84], [0x68, 0x64, 0xff],
  [0xae, 0xae, 0xae],
];

// The one and only palette. Kept as a single-entry map so the legacy API
// surface (getPalette / PaletteKey / DEFAULT_PALETTE_KEY) keeps compiling.
export const PALETTES = {
  colodore: COLODORE,
} as const;

export type PaletteKey = "colodore";
export const DEFAULT_PALETTE_KEY: PaletteKey = "colodore";

// All resolvers return colodore unconditionally — no key, no fallback branch,
// no way to land on a different table.
export function getPalette(_key?: PaletteKey | string | null): Palette16 {
  return COLODORE;
}

export function listPalettes(): PaletteKey[] {
  return ["colodore"];
}

// Retained for call-site compatibility (Spec 288 odd/even split is gone — one
// palette has no per-line variation). Always returns colodore.
export function paletteForLine(_key: PaletteKey | undefined, _line: number): Palette16 {
  return COLODORE;
}
