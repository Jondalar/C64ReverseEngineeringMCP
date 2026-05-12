// Spec 200 — MachineKernel internal contract.
//
// Per-session monolithic emulator owner. Public client surface is
// IntegratedSession; this interface is the internal contract between
// the session and its kernel implementation, and lets tests substitute
// a mock kernel.

import type { KernelTraceController } from "./kernel-trace.js";
import type { KernelStatus } from "./kernel-status.js";

export interface MountedMedia {
  imagePath: string;
  bytes: Uint8Array;
}

export interface MachineSnapshot {
  // Adapter to the existing SessionSnapshot — kept opaque here so the
  // kernel module does not depend on snapshot.ts implementation. Spec
  // 200 commit chain wires the real adapter.
  readonly schemaVersion: number;
  readonly payload: unknown;
}

export interface MachineKernel {
  c64Clock(): number;
  driveClock(device: number): number;
  runCycles(n: number): void;
  runInstructions(n: number): void;
  snapshot(): MachineSnapshot;
  restore(snap: MachineSnapshot): void;
  mountMedia(device: number, media: MountedMedia): void;
  trace(): KernelTraceController;
  status(): KernelStatus;
}
