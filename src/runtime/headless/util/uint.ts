// Sprint 113 chip-level 1:1 VICE port — shared uint helpers.
//
// VICE source uses C typedefs BYTE / WORD / CLOCK with implicit
// modular arithmetic. TS uses number for everything; we model the
// VICE width semantics explicitly via these aliases + helpers so
// any TS port of a VICE source line can be mechanically adapted.
//
// Used by Spec 145 (CIA), 146 (CPU), 147 (VIA), 148 (reset),
// 149 (alarm), 150 (VIC), 151 (SID). Land first, depend everywhere.

export type BYTE = number;   // VICE BYTE  — uint8,  range 0..255
export type WORD = number;   // VICE WORD  — uint16, range 0..65535
export type CLOCK = number;  // VICE CLOCK — uint32, wrap at 2^32

export const u8 = (x: number): BYTE => x & 0xff;
export const u16 = (x: number): WORD => x & 0xffff;
export const u32 = (x: number): CLOCK => x >>> 0;

// Signed-byte / signed-word helpers for C-style int8 / int16 reads.
// VICE: `(BYTE)v` -> signed reinterpret needs explicit handling.
export const s8 = (x: number): number => (u8(x) << 24) >> 24;
export const s16 = (x: number): number => (u16(x) << 16) >> 16;

// Bit-extraction helpers (named per VICE common patterns).
export const bit = (x: number, n: number): number => (x >>> n) & 1;
export const setBit = (x: number, n: number): number => x | (1 << n);
export const clearBit = (x: number, n: number): number => x & ~(1 << n);
export const flipBit = (x: number, n: number): number => x ^ (1 << n);

// CLOCK arithmetic — VICE pattern: `clk1 - clk2` where both fit in
// uint32. Negative TS result needs explicit u32 wrap.
export const clkDelta = (a: CLOCK, b: CLOCK): CLOCK => u32(a - b);
export const clkAdd = (a: CLOCK, b: number): CLOCK => u32(a + b);
