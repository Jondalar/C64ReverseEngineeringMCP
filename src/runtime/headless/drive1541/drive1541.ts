// Spec 723.6a: the legacy drive was removed (Spec 704 §11); the only drive
// implementation is the VICE1541 facade. The "legacy" arm is gone.
export type Drive1541Implementation = "vice";

export interface Drive1541IecSample {
  drv_data_pull: boolean;
  drv_clk_pull: boolean;
  drv_atna_pull: boolean;
}

export interface Drive1541IecInput {
  bus_atn: boolean;
  bus_clk: boolean;
  bus_data: boolean;
}

export interface Drive1541Media {
  kind: "d64" | "g64" | "p64";
  bytes: Uint8Array;
  readOnly: boolean;
  /** BUG-023 — host backing file path. When set and not readOnly, the drive's
   *  disk-image write points (fsimage_*_write_half_track) write through to this
   *  file immediately, matching VICE's fd-backed fwrite. */
  backingPath?: string;
}

export interface Drive1541DebugProbe {
  drive_pc: number;
  // Spec 704 §11 R3 — full drive-CPU register snapshot so callers that
  // formerly read the legacy `drive.cpu.{pc,a,x,y,sp,flags,cycles}` can
  // redirect to the vice drive (mos6510_regs_t: pc/ac/xr/yr/sp/flags +
  // diskunit clk). Used by snapshot / VSF / status / trace surfaces.
  drive_a: number;
  drive_x: number;
  drive_y: number;
  drive_sp: number;
  drive_flags: number;
  drive_clk: number;
  head_halftrack: number;
  current_track: number;
  led: number;
  // Spec 754 §3.3i (Block I) — side-effect-free read of the 1541 CPU address
  // space (drive RAM/ROM/VIA via the drivemem PEEK page table = VICE
  // drivemem_bank_peek), so the monitor `m`/`d` can inspect the drive while
  // `device drive8` is selected. Optional: a stub drive returns undefined.
  peek?(addr: number): number;
}

export interface Drive1541 {
  iecLineSample(): Drive1541IecSample;
  // Spec 611 phase 611.7f.24 — optional `clk` arg for IRQ stamp.
  // Bridge passes the host write clk so CA1 setIrq timestamp matches
  // the canonical write-time, not post-catchUpTo overrun drive clk.
  iecLineDrive(c64Side: Drive1541IecInput, clk?: number): void;
  catchUpTo(c64Clock: number): number;
  /**
   * Spec 614 §3.2 — per-clock tick entry for the CycleSchedulerVice
   * rebuild. Advances the drive until its internal clock reaches
   * `target_clk`, running drive instructions one at a time and
   * dispatching drive-side alarms in VICE order.
   *
   * VICE equivalence: src/drive/drivecpu.c:drive_cpu_execute_one —
   * the "run drive to target c64 clock" primitive that
   * maincpu_mainloop calls every c64 cycle when a 1541 is attached.
   *
   * Unlike `catchUpTo` (which returns the post-execution drive
   * clock), this is a void primitive — the scheduler does not need
   * the post-clock for its per-cycle loop, only the contract that
   * "after this call, drive.clk >= target_clk".
   */
  tickToClock(target_clk: number): void;
  flush(): void;
  attachDisk(media: Drive1541Media): void;
  detachDisk(): void;
  setWriteProtect(on: boolean): void;
  reset(kind: "cold" | "warm"): void;
  snapshot(): Uint8Array;
  restore(blob: Uint8Array): void;
  // Spec 714.4 — the mutable disk image is captured SEPARATELY from the drive
  // core blob so the ring can content-address + dedup it (stored once per disk
  // identity, refcounted, pin/evict-aware). `snapshot()` is core-only
  // (save_disks=0); `snapshotDiskImage()` is the GCRIMAGE-only payload (or null
  // when no GCR image is loaded); `restoreDiskImage()` overlays it back onto the
  // live GCR buffer after `restore()` rebuilds the core.
  snapshotDiskImage?(): Uint8Array | null;
  restoreDiskImage?(bytes: Uint8Array): void;
  debugProbe?(): Drive1541DebugProbe;
  // Spec 707 — native-snapshot media persistence (read-only; no port change).
  /** The currently attached media (re-attachable source bytes), or null. */
  getAttachedMedia?(): { kind: string; bytes: Uint8Array; readOnly: boolean } | null;
  /** True if the in-memory GCR image was written since attach (dirty guard). */
  isMediaDirty?(): boolean;
  /** BUG-023 — flush all dirty GCR tracks into the in-RAM media bytes (no
   *  detach) so the bridge can write them back to the host backing file. */
  persistDirtyTracks?(): void;
}
