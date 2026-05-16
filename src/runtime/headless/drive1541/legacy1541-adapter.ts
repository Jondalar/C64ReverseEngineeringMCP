// Spec 611 phase 611.7e.1 — LEGACY1541 → Drive1541 adapter.
//
// READ-ONLY view over the existing LEGACY1541 stack (DriveCpu + IecBus
// + Via1d1541 + drive head-position state). The adapter does NOT
// mutate legacy behavior — it just exposes the Drive1541 surface so a
// C64-side caller can talk to "the active drive" through one
// interface, regardless of whether `drive1541` is "legacy" or "vice".
//
// Scope per Codex 18:39 UTC 611.7e clearance:
//   - Wires C64-side Drive1541 surface for the legacy path.
//   - DOES NOT change CIA2 semantics, IEC line semantics, loader
//     traps, GCR / rotation / VIA2 / DriveCPU logic.
//   - Existing kernel↔legacy wiring (attachDriveRam, driveClockSource,
//     pushFlush, hook recorders) untouched.
//
// What 611.7e.1 implements:
//   - `iecLineSample()` → derived from legacy `IecBus.core.drv_data[8]`
//     (bit 1 = data, bit 3 = clk, bit 4 = atna; 1 = released).
//   - `debugProbe()` → drive PC + head half-track + LED.
//
// Honest-stub throws for the rest (with adapter-phase markers). Real
// routing of attachDisk / catchUpTo / flush / reset / snapshot through
// LEGACY1541's existing mount/step machinery lands when end-to-end
// gates need it (611.7f+). The legacy *direct* path remains the C64's
// runtime backbone for the default `drive1541="legacy"` choice; this
// adapter is a *read* surface in 611.7e.

import type { DriveCpu } from "../drive/drive-cpu.js";
import type { IecBus } from "../iec/iec-bus.js";
import type {
  Drive1541,
  Drive1541DebugProbe,
  Drive1541IecInput,
  Drive1541IecSample,
  Drive1541Media,
} from "./drive1541.js";

function adapterStub(method: string): Error {
  return new Error(
    `[Legacy1541Adapter] ${method} not wired in 611.7e (read-only ` +
      `adapter; full routing lands in 611.7f+ when gate-lift demands ` +
      `it). For default drive1541="legacy" the C64 side keeps using ` +
      `the legacy DriveCpu direct path.`,
  );
}

export interface Legacy1541AdapterDeps {
  drive: DriveCpu;
  iecBus: IecBus;
}

/**
 * Adapter exposing the Drive1541 interface over the existing
 * LEGACY1541 stack. Constructed by `createDrive1541("legacy", ...)`
 * via `Legacy1541AdapterDeps`.
 */
export class Legacy1541Adapter implements Drive1541 {
  readonly drive: DriveCpu;
  readonly iecBus: IecBus;

  constructor(deps: Legacy1541AdapterDeps) {
    this.drive = deps.drive;
    this.iecBus = deps.iecBus;
  }

  iecLineSample(): Drive1541IecSample {
    // Legacy iecBus.core.drv_data[8] convention (per
    // src/runtime/headless/iec/iec-bus.ts:206-221):
    //   bit 1 = DATA  (1 = released, 0 = pulled)
    //   bit 3 = CLK   (1 = released, 0 = pulled)
    //   bit 4 = ATNA  (1 = released, 0 = pulled / asserted)
    // Drive1541 convention (Spec 611 §3a): *_pull = inverse of
    // released, so flip the bits.
    const core = (this.iecBus as unknown as {
      core: { drv_data: Record<number, number> };
    }).core;
    const dd8 = core.drv_data[8] ?? 0xff;
    return {
      drv_data_pull: (dd8 & 0x02) === 0,
      drv_clk_pull: (dd8 & 0x08) === 0,
      drv_atna_pull: (dd8 & 0x10) === 0,
    };
  }

  iecLineDrive(_c64Side: Drive1541IecInput): void {
    throw adapterStub("iecLineDrive");
  }

  catchUpTo(_c64Clock: number): number {
    throw adapterStub("catchUpTo");
  }

  flush(): void {
    throw adapterStub("flush");
  }

  attachDisk(_media: Drive1541Media): void {
    throw adapterStub("attachDisk");
  }

  detachDisk(): void {
    throw adapterStub("detachDisk");
  }

  setWriteProtect(_on: boolean): void {
    throw adapterStub("setWriteProtect");
  }

  reset(_kind: "cold" | "warm"): void {
    throw adapterStub("reset");
  }

  snapshot(): Uint8Array {
    throw adapterStub("snapshot");
  }

  restore(_blob: Uint8Array): void {
    throw adapterStub("restore");
  }

  /**
   * Debug probe: returns drive 6502 PC + half-track + LED. Reads
   * legacy state via known accessors; no mutation.
   */
  debugProbe(): Drive1541DebugProbe {
    const cpu = (this.drive as unknown as { cpu: { pc: number } }).cpu;
    const headPos = (this.drive as unknown as {
      headPosition?: { currentHalfTrack?: number };
    }).headPosition;
    const led = (this.drive as unknown as {
      ledMonitor?: { ledStatus?: number };
    }).ledMonitor;
    return {
      drive_pc: (cpu?.pc ?? 0) & 0xffff,
      head_halftrack: (headPos?.currentHalfTrack ?? 0) & 0xff,
      led: (led?.ledStatus ?? 0) & 0xff,
    };
  }
}
