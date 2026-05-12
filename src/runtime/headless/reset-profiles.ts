// Spec 100 (M1.3) — Deterministic reset profiles.
//
// Pins every state knob touched at cold reset so two reset+run pairs
// with the same input sequence produce byte-identical state at every
// cycle. Required precondition for regression diffing and VICE-vs-
// headless oracle compare.
//
// Profile names match the SessionMode preset family but cover only
// what `resetCold` controls (PAL/NTSC timing, RAM init pattern,
// neutral peripheral state, fixed VIC raster phase).

export type ResetProfile = "pal-default" | "ntsc-default" | "custom";

export interface ResetProfileSpec {
  isPal: boolean;
  // RAM init: each 64-byte block alternates between fillA and fillB
  // (real C64 power-on pattern with $00/$FF chunks). Two resets with
  // the same profile fill RAM identically.
  ramFillA: number;
  ramFillB: number;
  // Forced VIC raster phase at reset. Real hardware starts random;
  // we pin to 0 for determinism. Document the deviation in
  // docs/reset-profiles.md.
  vicRasterPhase: number;
  // Keyboard buffer guaranteed empty (we always wipe).
  // IEC lines forced released (we always reset bus).
  // Drive head start track.
  driveStartTrack: number;
}

// VICE ram.c defaults: start_value=$FF, value_invert=128.
// Algorithm (src/ram.c:298-310):
//   j = ((offset / value_invert) & 1) ? 0xff : 0x00;
//   value = start_value ^ j;
// = 128-byte chunks alternating $FF / $00, starting with $FF.
// Our prior 64-byte $00-first scheme broke games that depend on
// power-on RAM pattern (e.g. LNR depacker reads uninit ZP/RAM).
const PAL_DEFAULT: ResetProfileSpec = {
  isPal: true,
  ramFillA: 0xff,
  ramFillB: 0x00,
  vicRasterPhase: 0,
  driveStartTrack: 18,
};

const NTSC_DEFAULT: ResetProfileSpec = {
  ...PAL_DEFAULT,
  isPal: false,
};

export function getResetProfile(profile: ResetProfile): ResetProfileSpec {
  switch (profile) {
    case "pal-default": return PAL_DEFAULT;
    case "ntsc-default": return NTSC_DEFAULT;
    case "custom":
    default: return PAL_DEFAULT;
  }
}

// Apply the profile's RAM fill pattern. Block size 128 bytes
// matches VICE ram.c default `value_invert=128` (= alternate
// every 128 bytes).
export function applyRamFillPattern(ram: Uint8Array, spec: ResetProfileSpec): void {
  const blockSize = 128;
  for (let i = 0; i < ram.length; i++) {
    const block = Math.floor(i / blockSize);
    ram[i] = (block & 1) === 0 ? spec.ramFillA : spec.ramFillB;
  }
}
