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
// Spec 200 — Clock domain constants and helpers.
//
// Centralizes C64 / 1541 clock rates per ADR §4.1. Existing constants
// in integrated-session.ts will alias these in commit 200-c2/c3.

export const C64_PHI2_PAL_HZ = 985_248;
export const C64_PHI2_NTSC_HZ = 1_022_727;
export const DRIVE_1541_HZ = 1_000_000;

export type VideoSystem = "PAL" | "NTSC";

export function c64ClockHz(video: VideoSystem): number {
  return video === "PAL" ? C64_PHI2_PAL_HZ : C64_PHI2_NTSC_HZ;
}

export function driveCyclesPerC64Cycle(video: VideoSystem): number {
  return DRIVE_1541_HZ / c64ClockHz(video);
}
