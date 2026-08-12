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
// Spec 200 — Kernel status shape.
// Spec 207 (2026-05-08) — KernelMode widened to all 8 ADR §7 modes.

import type { VideoSystem } from "./clock-domains.js";
import type { HookStatus } from "./kernel-hooks.js";

/**
 * KernelMode.
 *
 * Production modes (acceptance-gated):
 *   - true-drive         — real KERNAL + real 1541, no hidden hooks.
 *   - debug-vice-compare — true-drive + trace/diff instrumentation.
 *
 * (Spec 723.7b: debug-lockstep removed with the cycle-lockstep scheduler.)
 */
// Spec 723.3: fast-trap / real-kernal removed.
// Spec 723.7a: debug-push-only / debug-hybrid removed (dead label-only modes).
// Spec 723.7b: debug-lockstep removed.
export type KernelMode =
  | "true-drive"
  | "debug-vice-compare";

export const PRODUCTION_MODES: readonly KernelMode[] = [
  "true-drive", "debug-vice-compare",
] as const;
export const DIAGNOSTIC_MODES: readonly KernelMode[] = [] as const;

export function isProductionMode(m: KernelMode): boolean {
  return PRODUCTION_MODES.includes(m);
}

export interface KernelMediaSlotStatus {
  device: number;
  mounted: boolean;
  imagePath?: string;
}

export interface KernelStatus {
  mode: KernelMode;
  c64Clock: number;
  driveClocks: Record<number, number>;
  // Spec 204: every legacy rescue hook with last-fire clock.
  // In `true-drive` mode every entry must have fireCount 0 (audit
  // criterion: hook fire = test FAIL).
  hooks: HookStatus[];
  mediaSlots: KernelMediaSlotStatus[];
  video: VideoSystem;
}
