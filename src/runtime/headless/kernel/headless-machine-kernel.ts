// Spec 200 — HeadlessMachineKernel skeleton.
//
// Commit 200-c1 lands the type surface only. Subsequent commits move
// real ownership in:
//   200-c2 — alarm contexts
//   200-c3 — C64 chips (CPU, CIA1/2, VIC, SID, memory bus, ROMs)
//   200-c4 — drive + IEC chips
//   200-c5 — session shrinks to wrapper, ESLint enforced
//   200-c6 — smoke and acceptance
//
// Until those commits land this class is a thin facade backed by an
// IntegratedSession reference, which is acceptable per ADR §8 Step 1
// "no behavior change yet".

import type { IntegratedSession } from "../integrated-session.js";
import type { VideoSystem } from "./clock-domains.js";
import type { MachineKernel, MachineSnapshot, MountedMedia } from "./machine-kernel.js";
import type { KernelStatus, KernelMode } from "./kernel-status.js";
import type { KernelTraceController } from "./kernel-trace.js";
import { KernelTraceStub } from "./kernel-trace.js";

export interface HeadlessMachineKernelDeps {
  session: IntegratedSession;
  video: VideoSystem;
}

export class HeadlessMachineKernel implements MachineKernel {
  private readonly session: IntegratedSession;
  private readonly traceStub: KernelTraceController = new KernelTraceStub();
  readonly video: VideoSystem;

  constructor(deps: HeadlessMachineKernelDeps) {
    this.session = deps.session;
    this.video = deps.video;
  }

  c64Clock(): number {
    return this.session.c64Cpu.cycles;
  }

  driveClock(device: number): number {
    if (device !== 8) {
      throw new Error(
        `[kernel] driveClock(${device}) — only device 8 mounted in this session`,
      );
    }
    return this.session.drive.cpu.cycles;
  }

  runCycles(n: number): void {
    // Commit 200-c2/c3 will route this through SyncStrategy. For now
    // delegate to the existing scheduler if present, else fall through
    // to instruction-based stepping.
    const sched = this.session.scheduler;
    if (sched) {
      sched.runCycles(n);
      return;
    }
    // Coarse fallback for non-lockstep sessions: advance one C64
    // instruction at a time until we have consumed at least n cycles.
    const target = this.session.c64Cpu.cycles + n;
    while (this.session.c64Cpu.cycles < target) {
      this.session.stepC64Instruction();
    }
  }

  runInstructions(n: number): void {
    for (let i = 0; i < n; i++) this.session.stepC64Instruction();
  }

  snapshot(): MachineSnapshot {
    // Real adapter lands in commit 200-c5. Return a placeholder shape
    // that is round-trippable at the kernel level via restore().
    return { schemaVersion: 0, payload: null };
  }

  restore(_snap: MachineSnapshot): void {
    // Placeholder; real adapter lands in commit 200-c5.
  }

  mountMedia(device: number, _media: MountedMedia): void {
    if (device !== 8) {
      throw new Error(
        `[kernel] mountMedia(${device}) — only device 8 supported in Spec 200`,
      );
    }
    // Wiring lands in commit 200-c4 once disk parser ownership moves.
  }

  trace(): KernelTraceController {
    return this.traceStub;
  }

  status(): KernelStatus {
    const mode: KernelMode = this.session.useCycleLockstep
      ? "debug-lockstep"
      : "debug-lockstep"; // Spec 200 always reports debug-lockstep; 202 widens.
    return {
      mode,
      c64Clock: this.c64Clock(),
      driveClocks: { 8: this.driveClock(8) },
      hooks: [], // populated by Spec 204
      mediaSlots: [
        { device: 8, mounted: true, imagePath: this.session.diskPath },
      ],
      video: this.video,
    };
  }
}
