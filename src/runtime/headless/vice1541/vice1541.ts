// Spec 611 phase 611.3 — VICE1541 drive bring-up.
//
// Constructor: allocate DiskUnitContext + DriveContext per
// docs/vice-1541-arch.md §2.1 + §13 A; instantiate the drive 6502 /
// memory bus / VIA stubs / ROM via Vice1541DriveCpu; run driveInit()
// to write the post-init values (byte_ready_level=1, etc.); cold-reset
// the drive CPU so its PC points at the ROM reset vector.
//
// Implemented in 611.3:
//   - constructor (allocation + driveInit() + Vice1541DriveCpu wiring)
//   - catchUpTo()  → Vice1541DriveCpu.driveCpuExecute()
//   - flush()      → no-op (push-mode model; IEC line flush lands in 611.4)
//   - reset()      → Vice1541DriveCpu.reset() + driveInit() re-apply
//   - debugProbe() → { drive_pc, head_halftrack, led }
//   - iecLineSample() still returns idle bus (no VIA-derived pulls yet;
//     wired in 611.4)
//
// Still throwing in 611.3 (each phase replaces one):
//   - iecLineDrive                                → phase 611.4
//   - attachDisk / detachDisk / setWriteProtect    → phase 611.7
//   - snapshot / restore                           → phase 611.8

import type {
  Drive1541,
  Drive1541DebugProbe,
  Drive1541IecInput,
  Drive1541IecSample,
  Drive1541Media,
} from "../drive1541/drive1541.js";
import {
  createAllocatedDiskUnitContext,
  type DiskUnitContext,
} from "./diskunit.js";
import { createAllocatedDriveContext } from "./drive-context.js";
import { driveInit } from "./drive-init.js";
import { Vice1541DriveCpu } from "./drivecpu.js";

function phaseError(phase: string, what: string): Error {
  return new Error(
    `[VICE1541] ${what} not implemented yet (Spec 611 phase ${phase}). ` +
      `Real behaviour lands incrementally per ` +
      `specs/611-new-vice1541-side-by-side.md §5.`,
  );
}

export class Vice1541 implements Drive1541 {
  /** Owning diskunit context (unit 0; 1541 single-drive). */
  readonly diskunit: DiskUnitContext;
  /** Drive CPU + memory bus + sync_factor bookkeeping. */
  readonly driveCpu: Vice1541DriveCpu;

  constructor() {
    // Step 1 — allocate diskunit + drive_t shape per §13 A.
    this.diskunit = createAllocatedDiskUnitContext(0);
    const drive0 = createAllocatedDriveContext(0);
    drive0.diskunit = this.diskunit;
    this.diskunit.drives[0] = drive0;

    // Step 2 — drive CPU + memory bus + VIA stubs + ROM.
    this.driveCpu = new Vice1541DriveCpu(this.diskunit);

    // Step 3 — drive_init() per VICE drive.c:239-261.
    driveInit(this.diskunit);

    // Step 4 — cold reset so PC points at the ROM reset vector.
    this.driveCpu.reset("cold");
  }

  /**
   * Phase 611.3: drive still doesn't sample VIA-derived pulls; VIA1
   * IEC behaviour lands in 611.4. Idle bus stays correct for the
   * pre-VIA1-port window.
   */
  iecLineSample(): Drive1541IecSample {
    return {
      drv_data_pull: false,
      drv_clk_pull: false,
      drv_atna_pull: false,
    };
  }

  iecLineDrive(_c64Side: Drive1541IecInput): void {
    throw phaseError("611.4", "iecLineDrive");
  }

  /**
   * Push-mode catch-up. Runs the drive 6502 forward until its clock
   * matches the supplied host (C64) clock.
   */
  catchUpTo(c64Clock: number): number {
    return this.driveCpu.driveCpuExecute(c64Clock);
  }

  /**
   * Push-mode flush. In phase 611.3 there is no IEC edge queue yet —
   * VIA1 + the bus producer are absent — so flush is a no-op. Phase
   * 611.4 will replace this with the real edge flush.
   */
  flush(): void {
    // Intentionally empty in 611.3.
  }

  attachDisk(_media: Drive1541Media): void {
    throw phaseError("611.7", "attachDisk");
  }

  detachDisk(): void {
    throw phaseError("611.7", "detachDisk");
  }

  setWriteProtect(_on: boolean): void {
    throw phaseError("611.7", "setWriteProtect");
  }

  reset(kind: "cold" | "warm" = "cold"): void {
    this.driveCpu.reset(kind);
    // drive_init() re-applies the post-init values after the reset
    // clears them. (VICE distinguishes drivecpu_reset() from
    // drive_init(); both run on a cold start.)
    driveInit(this.diskunit);
    // Cold-reset also re-establishes the PC at the ROM reset vector.
    if (kind === "cold") {
      const lo = this.driveCpu.mem.read(0xfffc);
      const hi = this.driveCpu.mem.read(0xfffd);
      const vec = ((hi & 0xff) << 8) | (lo & 0xff);
      this.driveCpu.cpu.reset(vec);
    }
  }

  snapshot(): Uint8Array {
    throw phaseError("611.8", "snapshot");
  }

  restore(_blob: Uint8Array): void {
    throw phaseError("611.8", "restore");
  }

  debugProbe(): Drive1541DebugProbe {
    const drive = this.diskunit.drives[0];
    return {
      drive_pc: this.driveCpu.pc & 0xffff,
      head_halftrack: drive ? drive.currentHalfTrack & 0xff : 0,
      led: drive ? drive.ledStatus & 0xff : 0,
    };
  }
}
