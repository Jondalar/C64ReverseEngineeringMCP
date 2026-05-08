// Spec 200 — Kernel status shape.
// Spec 207 (2026-05-08) — KernelMode widened to all 8 ADR §7 modes.

import type { VideoSystem } from "./clock-domains.js";
import type { HookStatus } from "./kernel-hooks.js";

/**
 * KernelMode — all 8 ADR §7 modes.
 *
 * Production modes (acceptance-gated):
 *   - fast-trap          — KERNAL traps allowed; RE convenience.
 *   - real-kernal        — real KERNAL ROM, simplified drive.
 *   - true-drive         — real KERNAL + real 1541, no hidden hooks.
 *   - debug-vice-compare — true-drive + trace/diff instrumentation.
 *
 * Diagnostic modes (NOT acceptance-gated):
 *   - debug-lockstep   — opt-in `LockstepStrategy` (Spec 200 default,
 *                        demoted by Spec 202).
 *   - debug-push-only  — push-only sync probe; no event/catch-up.
 *   - debug-hybrid     — hybrid sync probe (= cycle-step on $DD00 in
 *                        userland PC range; legacy elsewhere).
 */
export type KernelMode =
  | "fast-trap"
  | "real-kernal"
  | "true-drive"
  | "debug-vice-compare"
  | "debug-lockstep"
  | "debug-push-only"
  | "debug-hybrid";

export const PRODUCTION_MODES: readonly KernelMode[] = [
  "fast-trap", "real-kernal", "true-drive", "debug-vice-compare",
] as const;
export const DIAGNOSTIC_MODES: readonly KernelMode[] = [
  "debug-lockstep", "debug-push-only", "debug-hybrid",
] as const;

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
