// Spec 200 — Kernel status shape.
//
// Spec 207 will widen `KernelMode` to all eight ADR §7 modes.

import type { VideoSystem } from "./clock-domains.js";

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
  hooks: string[]; // populated by Spec 204; always [] until then
  mediaSlots: KernelMediaSlotStatus[];
  video: VideoSystem;
}
