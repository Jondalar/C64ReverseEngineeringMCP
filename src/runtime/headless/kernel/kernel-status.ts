// Spec 200 — Kernel status shape.
//
// Spec 207 will widen `KernelMode` to all eight ADR §7 modes.

import type { VideoSystem } from "./clock-domains.js";
import type { HookStatus } from "./kernel-hooks.js";

export type KernelMode = "debug-lockstep" | "true-drive";
// Spec 207 widening:
//   | "fast-trap" | "real-kernal" | "true-drive" | "debug-vice-compare"
//   | "debug-lockstep" | "debug-push-only" | "debug-hybrid"

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
