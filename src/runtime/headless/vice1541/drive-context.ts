// Spec 611 phase 611.2 — port of VICE drive_t shape.
//
// VICE source:  src/drive/drive.h drive_s
// Doc anchor:   docs/vice-1541-arch.md §2.1 + §13 A (1–2)
//
// Data-shape only. Image / GCR / P64 backing structs are not ported
// yet; phase 611.7 brings them in. Snapshot fields (snap_*) are
// reserved for phase 611.8.

import type { DiskUnitContext } from "./diskunit.js";

/** BYTE-READY-active flags (drive.h BRA_*). */
export const BRA_BYTE_READY = 0x01;
export const BRA_MOTOR_ON = 0x02;

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
 * Build an idle DriveContext for slot `driveSlot` (1541 uses slot 0).
 * Caller is responsible for wiring `.diskunit` back-pointer after
 * inserting into a `DiskUnitContext.drives[driveSlot]`.
 */
export function createIdleDriveContext(driveSlot = 0): DriveContext {
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

    rpm: NOMINAL_RPM,
    wobbleFactor: 0,
    wobbleFrequency: 0,
    wobbleAmplitude: 0,

    trueEmulation: 1,
    readOnly: 0,

    reqRefCycles: 0,
  };
}
