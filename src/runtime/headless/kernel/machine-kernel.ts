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
  // Spec 765 — `shallow` returns LIVE big-buffer refs (RAM + VIC framebuffers)
  // instead of detached `.slice()` copies, for the checkpoint ring's zero-alloc
  // capture path (the ring copies them into its flat slab immediately, before
  // the loop runs again). Default (detached) is required for any caller that
  // retains the snapshot beyond the capture call (e.g. an out-of-band dump).
  snapshot(opts?: { shallow?: boolean }): MachineSnapshot;
  restore(snap: MachineSnapshot): void;
  mountMedia(device: number, media: MountedMedia): void;
  trace(): KernelTraceController;
  status(): KernelStatus;
}
