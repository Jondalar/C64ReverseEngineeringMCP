// Spec 705.A step 3 — native C64RE RuntimeCheckpoint.
//
// The canonical, native C64RE container for a complete restorable runtime
// state of the ACTIVE machine path. NOT a VSF file: VSF is exchange/compat
// only (Spec 705 §3.2). Sub-payloads:
//   - VICE1541 drive: opaque, already VICE-shaped snapshot-module byte blob
//     (drive1541.snapshot(), Spec 705.A steps 2.3/2.4). Stored verbatim.
//   - active literal VIC: VICE-shaped structured capture per viciisc/
//     vicii-snapshot.c (LiteralVicSnapshot) + the presentation seam fields.
//   - CIA / SID: each chip's own snapshot()/restore() structured state.
//   - everything else: typed core-domain fields.
//
// Capture/restore CONTRACT: only at an atomic CPU instruction boundary, with
// the RuntimeController paused and no half C64/drive/VIC event step open.
// Cpu65xxVice mid-instruction `inst` state is private; at a boundary it is
// null, so capturing the register/clk state is sufficient and deterministic.
//
// reSID PCM continuation state is NOT part of this container — it is the
// explicit PENDING follow-on (Spec 705.A step 4). SID software-visible
// registers ARE captured (sid.snapshot()).

import type { Cia6526ViceSnapshot } from "../cia/cia6526-vice.js";
import type { SidSnapshot } from "../sid/sid.js";
import type { LiteralVicSnapshot } from "../vic/literal/vicii-snapshot.js";
import type { AlarmScheduleEntry } from "../alarm/alarm-context.js";

export const RUNTIME_CHECKPOINT_SCHEMA_VERSION = 1 as const;

export interface RuntimeCheckpointCpu {
  pc: number; a: number; x: number; y: number; sp: number; flags: number;
  cycles: number;
  /** Cpu65xxVice continuation extras (absent on the simple Cpu6510). */
  maincpu_ba_low_flags?: number;
  soLine?: number;
  jammed?: boolean;
}

/** Public-field capture of InterruptCpuStatus (shared CPU/chip IRQ/NMI state). */
export interface RuntimeCheckpointIntStatus {
  pendingInt: number[];
  intNames: string[];
  nirq: number;
  nnmi: number;
  irqClk: number;
  nmiClk: number;
  irqDelayCycles: number;
  nmiDelayCycles: number;
  irqPendingClk: number;
  globalPendingInt: number;
  lastStolenCyclesClk: number;
}

/** Full VICE iecbus_t shadow (IecBus.core) — continuation-complete. */
export interface RuntimeCheckpointIec {
  cpu_bus: number;
  cpu_port: number;
  drv_port: number;
  iec_old_atn: number;
  drv_bus: number[];   // [16]
  drv_data: number[];  // [16]
}

/** Joystick line state (5 booleans). */
export interface RuntimeCheckpointJoystick {
  up: boolean; down: boolean; left: boolean; right: boolean; fire: boolean;
}

/**
 * Literal-VIC presentation seam (Spec 705 §4). VICE carries the visible
 * raster continuation in `raster_t` (not ported to TS); here it is the
 * IntegratedSession render fields. `literalPortFb` (mid-frame accumulator) IS
 * continuation-relevant — without it the first frame completed after a
 * mid-frame restore is stitched from stale/missing lines. `literalPortFbStable`
 * is the immediately-visible freeze image. `litLastRasterLine` drives which
 * line is copied next + frame-wrap detection. `litStableFrameCount` is pure
 * statistics (single increment site; no controller/UI/evidence dependency) —
 * restored for presentation continuity, excluded from machine comparison.
 */
export interface RuntimeCheckpointVicPresentation {
  literalPortFb: Uint8Array | null;
  literalPortFbStable: Uint8Array | null;
  litLastRasterLine: number;
  lastLitBaLow: 0 | 1;
  litStableFrameCount: number;
}

export interface RuntimeCheckpointMedia {
  diskPath: string;
  imageFormat: string;
  /**
   * Spec 709.7 — attached cartridge medium identity + the mapper's bank-switching
   * continuation state. Absent when no cartridge is attached.
   * Spec 714.5 — the LARGE byte payloads (original .crt bytes, mutable flash
   * image) moved OUT to top-level `RuntimeCheckpoint.cartBytes` / `cartFlash` so
   * the 705.B ring content-addresses + dedups them (the .crt is identical across
   * checkpoints → one stored copy; flash dedups across non-write checkpoints).
   */
  cartridge?: {
    name: string;
    sha256: string;
    mapperType: string;
    state: unknown; // HeadlessCartridgeState (opaque here to avoid a cartridge import)
  };
}

export interface RuntimeCheckpoint {
  schemaVersion: typeof RUNTIME_CHECKPOINT_SCHEMA_VERSION;
  /** Contract marker: captured at an atomic CPU instruction boundary. */
  atInstructionBoundary: true;

  cpu: RuntimeCheckpointCpu;
  ram: Uint8Array;            // 64K copy
  cpuPortDirection: number;   // $00 latch
  cpuPortValue: number;       // $01 latch

  cia1: Cia6526ViceSnapshot;
  cia2: Cia6526ViceSnapshot;
  sid: SidSnapshot;           // software-visible registers + voice state (no PCM)
  iec: RuntimeCheckpointIec;
  cpuIntStatus: RuntimeCheckpointIntStatus;
  /**
   * maincpu alarm-context pending schedule (CIA1/CIA2 timer/TOD/SDR/idle
   * alarms). Continuation-critical: CIA restore() reloads timer fields but does
   * not re-arm alarms, so the schedule must be captured + re-armed. The drive's
   * VIA alarms live on the drive's own context and are re-armed by the opaque
   * drive blob (viacore_snapshot_read_module), so they are not captured here.
   */
  alarmsMaincpu: AlarmScheduleEntry[];

  keyboard: { livePressed: string[] };
  joystick1: RuntimeCheckpointJoystick;
  joystick2: RuntimeCheckpointJoystick;
  paddles: number[];          // [4]

  vic: LiteralVicSnapshot;    // active literal-port VIC (VICE-shaped)
  vicPresentation: RuntimeCheckpointVicPresentation;

  /** Opaque VICE-shaped VICE1541 snapshot-module byte blob (null = no drive).
   *  Spec 714.4: CORE state only (save_disks=0) — the mutable disk image is the
   *  separate `driveDiskImage` field so the ring can content-address/dedup it. */
  drive1541: Uint8Array | null;
  /** Spec 714.4 — the attached disk's mutable GCRIMAGE payload (null when no
   *  disk). Captured apart from the core blob; in the 705.B ring it is stored
   *  content-addressed (once per identity, refcounted); embedded verbatim in
   *  `.c64re`. On restore it overlays the live GCR buffer (mutable-wins, §6.1). */
  driveDiskImage?: Uint8Array | null;
  /** Spec 714.5 — attached cartridge's original .crt bytes (constant across a
   *  session → the ring dedups to one stored copy). Null when no cartridge. */
  cartBytes?: Uint8Array | null;
  /** Spec 714.5 — attached cartridge's mutable device image (flash low+high
   *  concatenated), content-addressed + deduped in the ring; null when the
   *  cartridge has no writable state. */
  cartFlash?: Uint8Array | null;
  media: RuntimeCheckpointMedia;

  /**
   * Spec 705.A step 4 — OPTIONAL reSID audio-checkpoint slice (the recorder's
   * SidAudioRecorderSnapshot: VICE-shaped reSID synthesis state + cadence).
   * null when no live audio session is registered — the core checkpoint then
   * works without audio. The PCM ring / WS / worklet FIFO are NOT here
   * (transport state, flushed + re-buffered on restore).
   */
  audio: unknown | null;
}
