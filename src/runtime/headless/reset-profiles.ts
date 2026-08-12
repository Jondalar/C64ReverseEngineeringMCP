// ════════════════════════════════════════════════════════════════════════════
//  DEPRECATED — TypeScript runtime.  THE PRODUCT RUNTIME IS TRX64.
//
//  This file is part of the in-process TS emulator. It is reachable ONLY with
//  C64RE_RUNTIME_TS=1 and is never on the default path: every runtime_* tool,
//  the workspace UI and the MCP surface route to the TRX64 daemon (Spec 771).
//
//  Do not extend it, do not fix forward in it, and do not cite it as current
//  behaviour — "how the runtime works" means TRX64, in ../TRX64.
//  Its remaining job is to be a parity oracle for the port; when that is no
//  longer needed it goes. See DOCTRINE.md.
// ════════════════════════════════════════════════════════════════════════════
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

const PAL_DEFAULT: ResetProfileSpec = {
  isPal: true,
  ramFillA: 0x00,
  ramFillB: 0xff,
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

// Apply the profile's RAM fill pattern. Block size 64 bytes (real
// C64 power-on pattern alternates roughly per 64-byte block).
export function applyRamFillPattern(ram: Uint8Array, spec: ResetProfileSpec): void {
  const blockSize = 64;
  for (let i = 0; i < ram.length; i++) {
    const block = Math.floor(i / blockSize);
    ram[i] = (block & 1) === 0 ? spec.ramFillA : spec.ramFillB;
  }
}
