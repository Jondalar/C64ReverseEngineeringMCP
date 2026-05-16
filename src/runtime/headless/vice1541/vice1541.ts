// Spec 611 phase 611.2 — VICE1541 idle construction.
//
// Constructor now builds an idle DiskUnitContext + DriveContext per
// docs/vice-1541-arch.md §2.1 + §13 A. `iecLineSample()` returns the
// idle-bus shape (all lines released; VICE polarity convention
// `1` = released per Spec 611 §3a).
//
// All other methods still throw — each phase replaces one throw with
// real behaviour:
//   - catchUpTo / flush / reset / debugProbe → phase 611.3 (drivecpu)
//   - iecLineDrive                            → phase 611.4 (VIA1)
//   - attachDisk / detachDisk / setWriteProtect → phase 611.7 (image)
//   - snapshot / restore                      → phase 611.8

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

function phaseError(phase: string, what: string): Error {
  return new Error(
    `[VICE1541] ${what} not implemented yet (Spec 611 phase ${phase}). ` +
      `611.2 only builds the idle data-context shape; real behaviour ` +
      `lands incrementally per specs/611-new-vice1541-side-by-side.md §5.`,
  );
}

export class Vice1541 implements Drive1541 {
  /** Owning diskunit context (unit 0; 1541 single-drive). */
  readonly diskunit: DiskUnitContext;

  constructor() {
    // Per docs/vice-1541-arch.md §13 A step 1-2: allocate diskunit,
    // attach drives[0] as the 1541's only physical drive, wire the
    // back-pointer. 1541 leaves slot 1 unused and `cia1571 = NULL`.
    this.diskunit = createAllocatedDiskUnitContext(0);
    const drive0 = createAllocatedDriveContext(0);
    drive0.diskunit = this.diskunit;
    this.diskunit.drives[0] = drive0;
  }

  /**
   * Phase 611.2: drive idle — all IEC lines released.
   * VICE polarity per Spec 611 §3a: `true` = released, `false` = pulled.
   * On a fresh session with no drive activity, the drive does not
   * pull DATA, CLK, or ATNA — it lets all lines float (released).
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

  catchUpTo(_c64Clock: number): number {
    throw phaseError("611.3", "catchUpTo");
  }

  flush(): void {
    throw phaseError("611.3", "flush");
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

  reset(_kind: "cold" | "warm"): void {
    throw phaseError("611.3", "reset");
  }

  snapshot(): Uint8Array {
    throw phaseError("611.8", "snapshot");
  }

  restore(_blob: Uint8Array): void {
    throw phaseError("611.8", "restore");
  }

  debugProbe(): Drive1541DebugProbe {
    throw phaseError("611.3", "debugProbe");
  }
}
