// Spec 898 D3 -- the SECOND source. Registers the ROM source never names (it reaches
// them only as `vicreg+N` / `ted+N`, or by a bare address) take their name from
// Commodore's own published reference material instead of staying unnamed.
//
// Every row here is marked: its `source` starts with "secondary: " and cites the
// document and page. A secondary row only fills an address that has no ROM-source row;
// extensions.ts folds these in BEFORE the source rows (a source label always wins) and
// check:platform-kb fails when a secondary address is also a source address.
//
// Symbol rule (one rule, no invented semantics):
//   - the reference's own register mnemonic when it gives one: the MOS 6560 data sheet
//     calls the sixteen VIC registers CR0..CRF, so $9001-$900F are VIC_CR1..VIC_CRF
//     (hex index, as the sheet prints it); $9000 is already VICREG in the source.
//   - the reference's own PLA/chip-select output name when it names one ($FD30 is the
//     PLA output KEYPORT, $FD20 SPEECH, both from the "$FD3X" / "$FD2X" decode chart).
//   - otherwise chip prefix + the register number as the reference numbers it: the 7360
//     TED data sheet numbers its registers in DECIMAL ("Register 20"), so $FF14 is
//     TED_R20 -- the number is NOT the address low byte. Description repeats both.
//   The description is the reference's own wording, shortened, then "(name not in the ROM
//   source)". Page numbers are the scan order of the reference as obtained
//   (6560-NN.gif / pNN.gif), plus the printed sheet number where the page prints one.
//
// Not covered because no Commodore reference names them: VIC-20 / Plus-4 hardware vectors
// $FFFA-$FFFF (the VIC-20 Programmer's Reference Guide and the Plus/4 Hardware Manual
// describe the NMI and RESET pins and the RAM vectors at $0314, never the $FFFA-$FFFF
// ROM words); TED $FF20-$FF3D (the data sheet describes registers 0-31 and 62/63 only).
import type { SeedRow } from "./types.js";

const VIC = "secondary: MOS 6560/6561 VIC data sheet (Commodore 2/80) p.3 (VIC control registers)";
const NOTE = " (name not in the ROM source)";

export const VIC20_SECONDARY_ROWS: SeedRow[] = [
  [0x9001, "VIC_CR1", "VIC_CR1", "CR1: screen origin Y-coordinate" + NOTE, VIC],
  [0x9002, "VIC_CR2", "VIC_CR2", "CR2: number of video matrix columns" + NOTE, VIC],
  [0x9003, "VIC_CR3", "VIC_CR3", "CR3: number of video matrix rows" + NOTE, VIC],
  [0x9004, "VIC_CR4", "VIC_CR4", "CR4: raster value" + NOTE, VIC],
  [0x9005, "VIC_CR5", "VIC_CR5", "CR5: base address control" + NOTE, VIC],
  [0x9006, "VIC_CR6", "VIC_CR6", "CR6: light pen horizontal" + NOTE, VIC],
  [0x9007, "VIC_CR7", "VIC_CR7", "CR7: light pen vertical" + NOTE, VIC],
  [0x9008, "VIC_CR8", "VIC_CR8", "CR8: pot X" + NOTE, VIC],
  [0x9009, "VIC_CR9", "VIC_CR9", "CR9: pot Y" + NOTE, VIC],
  [0x900a, "VIC_CRA", "VIC_CRA", "CRA: F_IN(1), sound oscillator 1" + NOTE, VIC],
  [0x900b, "VIC_CRB", "VIC_CRB", "CRB: F_IN(2), sound oscillator 2" + NOTE, VIC],
  [0x900c, "VIC_CRC", "VIC_CRC", "CRC: F_IN(3), sound oscillator 3" + NOTE, VIC],
  [0x900d, "VIC_CRD", "VIC_CRD", "CRD: F_IN(4), noise" + NOTE, VIC],
  [0x900e, "VIC_CRE", "VIC_CRE", "CRE: amplitude; auxiliary colour" + NOTE, VIC],
  [0x900f, "VIC_CRF", "VIC_CRF", "CRF: colour control (background, exterior border, invert)" + NOTE, VIC],
];

const TED = (page: string) => `secondary: Plus/4 Hardware Manual, 7360 TED data sheet ${page}`;
const R = (n: number) => `TED_R${String(n).padStart(2, "0")}`;

export const PLUS4_SECONDARY_ROWS: SeedRow[] = [
  [0xfd20, "SPEECH", "SPEECH", "PLA output SPEECH, chip select for $FD2X" + NOTE, "secondary: Plus/4 Hardware Manual 7.6 PLA program chart p.39"],
  [0xfd30, "KEYPORT", "KEYPORT", "PLA output KEYPORT, chip select for $FD3X (6529 keyboard port)" + NOTE, "secondary: Plus/4 Hardware Manual 7.6 PLA program chart p.39"],
  [0xff07, R(7), R(7), "Register 7: bits 0-2 horizontal scroll, bit 3 38/40 column, bit 4 multicolor, bit 5 freeze, bit 6 PAL/NTSC, bit 7 reverse video off" + NOTE, TED("sheet 13-14 (p.63-64)")],
  [0xff0b, R(11), R(11), "Register 11: raster compare, low 8 bits (bit 8 is in register 10)" + NOTE, TED("sheet 14 (p.64)")],
  [0xff0f, R(15), R(15), "Register 15: voice 2 frequency base, low 8 bits (square wave or white noise)" + NOTE, TED("sheet 15 (p.65)")],
  [0xff12, R(18), R(18), "Register 18: bit map address base (bits 3-5), ROM/RAM bank bit 2, 2 MSB of voice 1 frequency base" + NOTE, TED("sheet 16 (p.66)")],
  [0xff14, R(20), R(20), "Register 20: video matrix base (bits 3-7)" + NOTE, TED("sheet 16 (p.66)")],
  [0xff15, R(21), R(21), "Register 21: background register 0, 3-bit luminance and 4-bit colour" + NOTE, TED("sheet 16 (p.66)")],
  [0xff16, R(22), R(22), "Register 22: background register 1, luminance and colour" + NOTE, TED("sheet 16 (p.66)")],
  [0xff17, R(23), R(23), "Register 23: background register 2" + NOTE, TED("sheet 17 (p.67)")],
  [0xff18, R(24), R(24), "Register 24: background register 3, luminance and colour" + NOTE, TED("sheet 17 (p.67)")],
  [0xff19, R(25), R(25), "Register 25: exterior (border) register, luminance and colour" + NOTE, TED("sheet 17 (p.67)")],
  [0xff1a, R(26), R(26), "Register 26: 2 MSB of the character position reload register (bits 0-1)" + NOTE, TED("sheet 17 (p.67)")],
  [0xff1b, R(27), R(27), "Register 27: character position reload register, low byte" + NOTE, TED("sheet 18 (p.68)")],
  [0xff1c, R(28), R(28), "Register 28: MSB of the vertical line register" + NOTE, TED("sheet 18 (p.68)")],
  [0xff1d, R(29), R(29), "Register 29: vertical line register, low byte" + NOTE, TED("sheet 18 (p.68)")],
  [0xff1e, R(30), R(30), "Register 30: horizontal position register, upper 8 of 9 bits" + NOTE, TED("sheet 18 (p.68)")],
  [0xff1f, R(31), R(31), "Register 31: blink rate (4 bits) and vertical subaddress (3 bits)" + NOTE, TED("sheet 18 (p.68)")],
];
