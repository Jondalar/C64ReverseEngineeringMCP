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
// VICE CLOCK is 64-bit (uint64_t) in modern source. Spec 743: our runtime models
// absolute emulator time as a MONOTONIC JS number (exact to 2^53), NOT a uint32
// that wraps at 2^32. Only hardware register/bitfield widths wrap (use u8/u16).
export type CLOCK = number;  // absolute runtime time — monotonic, do NOT u32 it

// Spec 743 — the one disabled/never absolute-clock sentinel. A real maincpu clk
// can exceed 2^32 over a long run, so 0xffffffff is NOT a safe "never" marker.
// MAX_SAFE_INTEGER is always greater than any reachable clk and survives JSON +
// checkpoint round-trips as a finite number.
export const CLOCK_NEVER: CLOCK = Number.MAX_SAFE_INTEGER;

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

// CLOCK arithmetic. Spec 743: absolute runtime time is monotonic — clk++ must NOT
// wrap at 2^32. clkAdd is the maincpu CLK_INC increment; keep it a plain add.
export const clkAdd = (a: CLOCK, b: number): CLOCK => a + b;
// clkDelta = `clk1 - clk2`. Callers use it for a SHORT non-negative span between
// two absolute clks (e.g. cycles since the last I-flag clear), so the result fits
// well under 2^32 and the u32 fold is a harmless no-op that also guards a tiny
// transient negative during pipeline setup. Absolute clks themselves stay
// monotonic; this only narrows a small delta.
export const clkDelta = (a: CLOCK, b: CLOCK): CLOCK => u32(a - b);
