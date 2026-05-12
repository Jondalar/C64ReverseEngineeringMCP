// Spec 280e — badline DMA fetch logic (matrix + chargen/bitmap).
//
// Mirrors vice/src/vicii/vicii-fetch.c vicii_fetch_matrix() and
// vicii-badline.c do_matrix_fetch() detection logic.
//
// Three functions, one result type:
//   isBadline()    — VICE condition verbatim (vicii-badline.c 145-148)
//   fetchMatrix()  — read 40 vbuf + 40 cbuf bytes from screen RAM / color RAM
//   fetchChargen() — read 40 chargen bytes for a vbuf of char codes
//   fetchBitmap()  — read 40 bitmap bytes for a char row + sub-row
//
// VIC bank quirk (banks 0+2 only): addresses $1000-$1FFF within the VIC
// bank map to character ROM, not RAM.  This matches the existing renderer
// logic in src/runtime/headless/peripherals/vic-renderer.ts vicRead().
//
// VICE source references:
//   vicii-fetch.c  vicii_fetch_matrix (~57)   — memcpy from screen_base_phi2
//   vicii-fetch.c  do_matrix_fetch   (~135)   — badline condition + kick
//   vicii-badline.c line 145-148              — (current_line & 7) == ysmooth
//                                               && allow_bad_lines
//                                               && first_dma_line..last_dma_line
//   viciitypes.h   vaddr_chargen_mask/value    — ROM overlay detection
//   vicii-fetch.c  handle_fetch_sprite ~429   — chargen_mask_phi1/value_phi1

// ---------------------------------------------------------------------------
// Result type.
// ---------------------------------------------------------------------------

export interface BadlineFetchResult {
  /** 40 bytes from screen RAM — character codes for current row. */
  vbuf: Uint8Array;
  /** 40 bytes from $D800 color RAM — foreground color nibble per char. */
  cbuf: Uint8Array;
  /**
   * 40 bytes: chargen or bitmap data for the given sub-row.
   * Populated by fetchChargen() or fetchBitmap(); zero-filled if not called.
   */
  bitmapBuf: Uint8Array;
}

// ---------------------------------------------------------------------------
// Badline detection — VICE do_matrix_fetch (vicii-fetch.c 145-148).
//
// "Bad line" = the VIC steals 43 cycles and refetches screen-RAM matrix.
// Condition (verbatim from VICE vicii-badline.c / vicii-fetch.c):
//   (rasterY & 7) == ysmooth
//   && allow_bad_lines != 0
//   && rasterY >= first_dma_line
//   && rasterY <= last_dma_line
//
// `denBit` is NOT part of the per-line test (allow_bad_lines is a sticky
// flag set once DEN is seen on first_dma_line — that logic lives in
// computeLineSteal in vic-ii-vice.ts).  We receive allow_bad_lines
// already resolved, but also accept `denBit` so smoke tests can verify
// the independent guard.
// ---------------------------------------------------------------------------

/**
 * VICE: `(rasterY & 7) == ysmooth && allow_bad_lines && in_dma_range`.
 *
 * @param rasterY       Current scanline (0..311 PAL).
 * @param ysmooth       D011 low 3 bits — row scroll offset.
 * @param allowBadLines VICE allow_bad_lines sticky flag (set when DEN seen
 *                      on first_dma_line; NOT just the instantaneous DEN bit).
 * @param firstDmaLine  VICE first_dma_line (0x30 = 48 for PAL).
 * @param lastDmaLine   VICE last_dma_line  (0xf7 = 247 for PAL).
 */
export function isBadline(
  rasterY: number,
  ysmooth: number,
  allowBadLines: boolean,
  firstDmaLine: number,
  lastDmaLine: number,
): boolean {
  if (!allowBadLines) return false;
  if (rasterY < firstDmaLine || rasterY > lastDmaLine) return false;
  return (rasterY & 7) === (ysmooth & 7);
}

// ---------------------------------------------------------------------------
// Bus abstraction — minimal slice of HeadlessMemoryBus the fetcher needs.
// Kept narrow so it's easy to mock in smoke tests without importing the
// full bus type.
// ---------------------------------------------------------------------------

export interface BadlineBus {
  /** C64 main RAM — 65536 bytes. */
  ram: Uint8Array | Uint8ClampedArray;
  /** 4KB character ROM (2×2KB sets, mapped at $D000/$D800 in CPU space,
   *  but at $1000-$1FFF in VIC banks 0 and 2).  Length 4096. */
  charRom: Uint8Array | Uint8ClampedArray;
  /** $D800-$DBFF color RAM — 1024 nibbles (stored as bytes, low nibble). */
  colorRam: Uint8Array | Uint8ClampedArray;
}

// ---------------------------------------------------------------------------
// VIC bank-quirk helper — mirrors vic-renderer.ts vicRead().
//
// In VIC banks 0 (base=$0000) and 2 (base=$8000), the address range
// $1000-$1FFF within the bank is wired to char ROM instead of RAM.
// VICE uses vaddr_chargen_mask/value pairs that encode this; we replicate
// the plain form used in the renderer.
// ---------------------------------------------------------------------------

function vicBankRead(bus: BadlineBus, vicBankBase: number, bankRelAddr: number): number {
  const masked = bankRelAddr & 0x3fff;
  // Banks with char ROM overlay: base 0x0000 (bank 0) or 0x8000 (bank 2).
  const hasCharRomOverlay = (vicBankBase === 0x0000) || (vicBankBase === 0x8000);
  if (hasCharRomOverlay && masked >= 0x1000 && masked < 0x2000) {
    // Char ROM at bank-relative $1000; 4KB ROM, index = offset within $1000.
    return bus.charRom[masked - 0x1000]! & 0xff;
  }
  return bus.ram[(vicBankBase + masked) & 0xffff]! & 0xff;
}

// ---------------------------------------------------------------------------
// fetchMatrix — read 40 vbuf + 40 cbuf bytes.
//
// VICE: vicii_fetch_matrix(offs=0, num=40, num_0xff=0, cycle=VICII_FETCH_CYCLE).
//
//   vbuf[i] = screen_base_phi2[mem_counter + i]     (wraps at 0x3ff)
//   cbuf[i] = mem_color_ram_vicii[mem_counter + i]  (no bank, direct color RAM)
//
// We use `charRowStart` as the equivalent of VICE's `vicii.mem_counter`
// (= memptr at bad-line entry, which is (rasterY - first_dma_line) / 8 * 40
//  for the standard linear screen layout, but callers pass it explicitly).
//
// Color RAM is always mapped at $D800-$DBFF in CPU space — VIC bank doesn't
// apply.  We read from bus.colorRam[charRowStart + i] & 0x0f.
// ---------------------------------------------------------------------------

export function fetchMatrix(
  bus: BadlineBus,
  vicBankBase: number,
  screenBaseOffset: number,  // = vic.screen_ptr (bank-relative, e.g. 0x0000)
  charRowStart: number,       // = vicii.mem_counter (0..959)
): { vbuf: Uint8Array; cbuf: Uint8Array } {
  const vbuf = new Uint8Array(40);
  const cbuf = new Uint8Array(40);

  for (let i = 0; i < 40; i++) {
    // 10-bit counter wrap (0x3ff per VICE).
    const idx = (charRowStart + i) & 0x3ff;
    // Screen RAM = vicBankBase + screenBaseOffset + idx.
    const screenAddr = screenBaseOffset + idx;
    vbuf[i] = vicBankRead(bus, vicBankBase, screenAddr);
    // Color RAM: direct $D800 space, not banked.
    cbuf[i] = (bus.colorRam[idx]! & 0x0f);
  }

  return { vbuf, cbuf };
}

// ---------------------------------------------------------------------------
// fetchChargen — read 40 chargen bytes from the chargen ROM/RAM.
//
// For each char code in vbuf, read one byte from the chargen data:
//   addr = chargenBaseOffset + charCode * 8 + subRow
//
// Where chargenBaseOffset is vic.chargen_ptr (bank-relative, decoded from
// D018 bits 3..1).  The bank quirk applies: if the resolved address falls
// in $1000-$1FFF in banks 0/2, reads from char ROM.
//
// `subRow` = 0..7 (which of the 8 pixel rows within the 8×8 character cell).
// ---------------------------------------------------------------------------

export function fetchChargen(
  bus: BadlineBus,
  vicBankBase: number,
  chargenBaseOffset: number,  // = vic.chargen_ptr (bank-relative)
  vbuf: Uint8Array,
  subRow: number,             // 0..7
): Uint8Array {
  const bitmapBuf = new Uint8Array(40);
  const sub = subRow & 7;

  for (let i = 0; i < 40; i++) {
    const charCode = vbuf[i]! & 0xff;
    const charAddr = chargenBaseOffset + charCode * 8 + sub;
    bitmapBuf[i] = vicBankRead(bus, vicBankBase, charAddr);
  }

  return bitmapBuf;
}

// ---------------------------------------------------------------------------
// fetchBitmap — read 40 bitmap bytes for hires/multicolor bitmap modes.
//
// VICE: bitmap data starts at bitmap_low_ptr (D018 bit 3 → $0000 or $2000
// within the VIC bank).  Each character position i occupies 8 bytes at:
//   bitmapBaseOffset + charRowStart * 8 + subRow + i * 8
//
// Wait — the correct VICE formula for bitmap byte at (col=i, charRow, subRow):
//   offset = charRowStart * 8 + i * 8 + subRow
//          = (charRowStart + i) * 8 + subRow
//
// `charRowStart` = vicii.mem_counter at bad-line entry (= row×40 for a
// linear screen without scrolling).
// ---------------------------------------------------------------------------

export function fetchBitmap(
  bus: BadlineBus,
  vicBankBase: number,
  bitmapBaseOffset: number,   // = vic.bitmap_ptr (0x0000 or 0x2000)
  charRowStart: number,       // = vicii.mem_counter (0..959)
  subRow: number,             // 0..7
): Uint8Array {
  const bitmapBuf = new Uint8Array(40);
  const sub = subRow & 7;

  for (let i = 0; i < 40; i++) {
    // Each char cell occupies 8 bytes in bitmap; within a row all cells
    // run sequentially.  10-bit counter wrap per VICE doesn't apply to
    // bitmap offset (bitmap is up to 8KB, no 1KB counter) but we keep
    // a 16KB bank mask for safety.
    const bitmapAddr = bitmapBaseOffset + (charRowStart + i) * 8 + sub;
    bitmapBuf[i] = vicBankRead(bus, vicBankBase, bitmapAddr);
  }

  return bitmapBuf;
}

// ---------------------------------------------------------------------------
// Composite helper — perform a full badline DMA fetch (matrix + chargen).
// Returns a BadlineFetchResult with all three buffers populated.
// Callers that need bitmap mode call fetchBitmap separately and assign
// result.bitmapBuf after construction.
// ---------------------------------------------------------------------------

export function fetchBadlineMatrix(
  bus: BadlineBus,
  vicBankBase: number,
  screenBaseOffset: number,
  chargenBaseOffset: number,
  charRowStart: number,
  subRow: number,
): BadlineFetchResult {
  const { vbuf, cbuf } = fetchMatrix(bus, vicBankBase, screenBaseOffset, charRowStart);
  const bitmapBuf = fetchChargen(bus, vicBankBase, chargenBaseOffset, vbuf, subRow);
  return { vbuf, cbuf, bitmapBuf };
}
