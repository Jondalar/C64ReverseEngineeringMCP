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
import { driveInit, driveSetHalfTrack } from "./drive-init.js";
import { Vice1541DriveCpu } from "./drivecpu.js";
import { rotation_init, rotation_reset } from "./rotation.js";
import { encodeD64ToGcrTracks, probeD64 } from "./drive-image-d64.js";
import { g64ToGcrTracks, parseG64Image } from "./drive-image-g64.js";
import { MAX_GCR_TRACKS, type GcrImage } from "./gcr.js";

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

    // Step 3.5 — rotation_init/reset per VICE rotation.c:93/111.
    // Phase 611.6: 1541 runs at 1 MHz (frequency = 0 = 1x).
    rotation_init(0, this.diskunit.mynumber);
    if (drive0) rotation_reset(drive0);

    // Step 4 — cold reset so PC points at the ROM reset vector.
    this.driveCpu.reset("cold");
  }

  /**
   * Phase 611.4: derive drive-side pulls from the live IEC bus model.
   * `*_pull` is the inverse of `*Released` (released = not pulling).
   */
  iecLineSample(): Drive1541IecSample {
    const bus = this.driveCpu.iecBus;
    return {
      drv_data_pull: !bus.drvDataReleased,
      drv_clk_pull: !bus.drvClkReleased,
      drv_atna_pull: !bus.drvAtnaReleased,
    };
  }

  /**
   * Phase 611.4: write the C64-driven IEC lines into the drive's IEC
   * bus model and signal the VIA1 CA1 (ATN) edge handler if ATN flips.
   */
  iecLineDrive(c64Side: Drive1541IecInput): void {
    this.driveCpu.setC64IecLines(
      c64Side.bus_atn,
      c64Side.bus_clk,
      c64Side.bus_data,
    );
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

  /**
   * Phase 611.7d: parse media → VICE-shaped 168-slot gcr_t.tracks[] →
   * wire to drive_t.gcr + GCR_image_loaded + attach_clk. Re-point
   * head via driveSetHalfTrack so rotation_1541_simple reads real
   * GCR bytes from the current track.
   */
  attachDisk(media: Drive1541Media): void {
    const drive = this.diskunit.drives[0];
    if (!drive) throw new Error("[VICE1541] attachDisk: drive slot 0 unallocated");

    let tracks: Array<{ data: Uint8Array | null; size: number }>;
    if (media.kind === "d64") {
      probeD64(media.bytes); // throws on bad size
      tracks = encodeD64ToGcrTracks(media.bytes);
    } else if (media.kind === "g64") {
      const img = parseG64Image(media.bytes);
      tracks = g64ToGcrTracks(img);
    } else {
      // P64 = throwing stub per Spec 611 §2 P64 policy.
      throw new Error(
        "[VICE1541] attachDisk(p64): P64 image format not implemented (Spec 611 §2 P64 stub).",
      );
    }

    if (tracks.length !== MAX_GCR_TRACKS) {
      throw new Error(
        `[VICE1541] attachDisk: tracks array length ${tracks.length} ≠ MAX_GCR_TRACKS ${MAX_GCR_TRACKS}`,
      );
    }

    const gcr: GcrImage = { tracks };
    drive.gcr = gcr;
    drive.gcrImageLoaded = 1;
    drive.readOnly = media.readOnly ? 1 : 0;
    // VICE attach_clk decay: drive sees no data until DRIVE_ATTACH_DELAY
    // drive cycles have elapsed from the attach.
    drive.attachClk = this.diskunit.clkPtr.value;
    drive.attachDetachClk = 0;
    // Re-point head: triggers gcrTrackStartPtr / gcrCurrentTrackSize update.
    driveSetHalfTrack(drive, drive.currentHalfTrack, drive.side);
  }

  detachDisk(): void {
    const drive = this.diskunit.drives[0];
    if (!drive) return;
    drive.gcr = null;
    drive.gcrImageLoaded = 0;
    drive.complicatedImageLoaded = 0;
    drive.p64ImageLoaded = 0;
    drive.gcrTrackStartPtr = null;
    drive.gcrCurrentTrackSize = 0;
    drive.attachDetachClk = this.diskunit.clkPtr.value;
    drive.attachClk = 0;
  }

  setWriteProtect(on: boolean): void {
    const drive = this.diskunit.drives[0];
    if (!drive) return;
    drive.readOnly = on ? 1 : 0;
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
