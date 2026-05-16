// Spec 611 phase 611.2 — port of VICE drive_t shape.
//
// VICE source:  src/drive/drive.h drive_s
// Doc anchor:   docs/vice-1541-arch.md §2.1 + §13 A (1–2)
//
// Data-shape only. Image / GCR / P64 backing structs are not ported
// yet; phase 611.7 brings them in. Snapshot fields (snap_*) are
// reserved for phase 611.8.

import type { DiskUnitContext } from "./diskunit.js";

/**
 * BYTE-READY-active flags (drive.h BRA_*). Source-verified against
 * `/Users/alex/Development/C64/Tools/vice/vice/src/drive/drive.h`
 * lines 283-285.
 *
 * Bit values are *chosen to match the corresponding VIA2 register
 * positions* in VICE — do not renumber:
 *   BRA_BYTE_READY = 0x02 — bit in the VIA2 PCR register
 *   BRA_MOTOR_ON   = 0x04 — bit in the VIA2 PB  register
 *   BRA_LED        = 0x08
 */
export const BRA_BYTE_READY = 0x02;
export const BRA_MOTOR_ON = 0x04;
export const BRA_LED = 0x08;

/** Read/write mode for the head (drive.h). */
export const RW_MODE_WRITE = 0;
export const RW_MODE_READ = 1;

/** Nominal RPM × 100 (drive.h: rpm = 30000 ⇒ 300 rpm). */
export const NOMINAL_RPM = 30_000;

/**
 * Direct port of `drive_t` from `src/drive/drive.h`. Fields with
 * unported backing types are typed `null` and tightened per phase.
 *
 * 1541 specifics:
 *   - `currentHalfTrack` 0..83 (84 half-tracks = 42 tracks)
 *   - `side` always 0 (1571-only)
 *   - `image` / `gcr` / `p64` stay null until phase 611.7
 */
export interface DriveContext {
  drive: number;                       // slot index within unit (0 or 1)
  diskunit: DiskUnitContext | null;    // back-pointer to owning unit

  ledStatus: number;
  ledLastChangeClk: number;

  currentHalfTrack: number;            // 0..83 for 1541
  side: number;                        // 0/1 (1571 only)

  byteReadyLevel: number;              // CA1 line state (0/1)
  byteReadyEdge: number;               // latched edge → CPU SO line

  gcrDirtyTrack: number;
  gcrWriteValue: number;
  gcrTrackStartPtr: Uint8Array | null;
  gcrCurrentTrackSize: number;
  gcrHeadOffset: number;               // in bits, from start of current track
  gcrRead: number;
  readWriteMode: number;               // 0 = write, 1 = read

  byteReadyActive: number;             // BRA_BYTE_READY | BRA_MOTOR_ON

  attachClk: number;
  detachClk: number;
  attachDetachClk: number;

  image: null;                         // disk_image_s → phase 611.7
  gcr: null;                           // gcr_s → phase 611.7
  // P64 intentionally omitted — Spec 611 §2 P64 throwing-stub policy.

  /** VICE drive_t flag: GCR image attached. 0 = no track. */
  gcrImageLoaded: number;
  /** VICE drive_t flag: needs complex rotation path (gcr/p64 cycle). */
  complicatedImageLoaded: number;
  /** VICE drive_t flag: P64 image attached (always 0 — P64 stub). */
  p64ImageLoaded: number;

  rpm: number;                         // 30000 nominal
  wobbleFactor: number;
  wobbleFrequency: number;
  wobbleAmplitude: number;

  trueEmulation: number;               // 0/1
  readOnly: number;                    // 0/1 (write-protect)

  reqRefCycles: number;
  // Snapshot fields (snap_*) reserved for phase 611.8 snapshot port.
}

/**
 * Build an **allocation + resource-default** DriveContext for slot
 * `driveSlot` (1541 uses slot 0). This corresponds to VICE's drive_t
 * **after** `lib_calloc()` but **before** `drive_init()` has run.
 *
 * Strict calloc semantics would zero everything, but two kinds of
 * fields are non-zero here on purpose:
 *
 *   1. **TypeScript-required resource defaults.** TS interfaces cannot
 *      hold `undefined` numeric fields; the calloc-equivalent is the
 *      minimal-correct constant default for the field type. The
 *      following are *not* drive_init() writes — they are resource
 *      defaults established by the surrounding code (drive type table,
 *      resource registration) at object-allocation time and would be
 *      present in VICE's struct before `drive_init()` runs anyway:
 *        rpm            = 30000  (NOMINAL_RPM; from drive type table)
 *        readWriteMode  = 1      (RW_MODE_READ; head defaults to read)
 *        trueEmulation  = 1      (TDE on; matches VICE TRUE_DRIVE_EMU=1)
 *
 *   2. **drive_init() post-init writes are NOT performed here.** VICE's
 *      `drive_init()` (src/drive/drive.c:239-261) then writes:
 *        byte_ready_level = 1
 *        byte_ready_edge  = 1
 *        GCR_write_value  = 0x55
 *        drive_set_half_track(36, 0, drive)   (currentHalfTrack = 36)
 *      Those land in the phase that ports `drive_init()` — currently
 *      scheduled with the drivecpu bring-up (Spec 611 phase 611.3).
 *      Until then, `createAllocatedDriveContext()` is the source-of-
 *      truth pre-init shape; any caller that needs the post-init
 *      values must run the init step explicitly.
 *
 * Caller is also responsible for wiring `.diskunit` back-pointer
 * after inserting the returned object into
 * `DiskUnitContext.drives[driveSlot]`.
 */
export function createAllocatedDriveContext(driveSlot = 0): DriveContext {
  return {
    drive: driveSlot,
    diskunit: null,

    ledStatus: 0,
    ledLastChangeClk: 0,

    currentHalfTrack: 0,
    side: 0,

    byteReadyLevel: 0,
    byteReadyEdge: 0,

    gcrDirtyTrack: 0,
    gcrWriteValue: 0,
    gcrTrackStartPtr: null,
    gcrCurrentTrackSize: 0,
    gcrHeadOffset: 0,
    gcrRead: 0,
    readWriteMode: RW_MODE_READ,

    byteReadyActive: 0,

    attachClk: 0,
    detachClk: 0,
    attachDetachClk: 0,

    image: null,
    gcr: null,
    gcrImageLoaded: 0,
    complicatedImageLoaded: 0,
    p64ImageLoaded: 0,

    rpm: NOMINAL_RPM,
    wobbleFactor: 0,
    wobbleFrequency: 0,
    wobbleAmplitude: 0,

    trueEmulation: 1,
    readOnly: 0,

    reqRefCycles: 0,
  };
}
