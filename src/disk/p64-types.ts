// Spec 441 (Epic 440) — TS port of VICE `src/lib/p64/p64.h` struct types.
//
// VICE source:
//   /Users/alex/Development/C64/Tools/vice/vice/src/lib/p64/p64.h  (178 LoC)
//
// Naming retained verbatim from VICE (TP64*, PP64*) so call sites in
// rotation.ts can mirror VICE C 1:1. TypeScript has no pointer types;
// the `P*` (pointer) aliases are TS references (= same struct).
//
// Implementation lives in p64-stream.ts + p64-image.ts (Spec 441 step 2
// follow-ups). This file owns ONLY the type surface.
//
// Doctrine: Epic 440 + feedback_vice_no_alternatives. No subset.
// Every type from p64.h that is referenced anywhere in VICE rotation.c
// or by external callers is exported here.

// ----------------------------------------------------------------------------
// Constants (p64.h lines 56-65)
// ----------------------------------------------------------------------------

/** (16 MHz * 60) / 300 = 3_200_000 samples per track rotation (5 rev/sec). */
export const P64PulseSamplesPerRotation = 3_200_000;

/** First half-track index in the P64 stream array. */
export const P64FirstHalfTrack = 2;

/** Last half-track index (incl. 42.5). */
export const P64LastHalfTrack = 85;

// ----------------------------------------------------------------------------
// Header / chunk signatures (p64.h lines 80-92)
// ----------------------------------------------------------------------------

/** TP64HeaderSignature = p64_uint8_t[8] */
export type TP64HeaderSignature = Uint8Array; // length 8
export type PP64HeaderSignature = Uint8Array; // alias (= same)

/** TP64ChunkSignature = p64_uint8_t[4] */
export type TP64ChunkSignature = Uint8Array; // length 4
export type PP64ChunkSignature = Uint8Array;

// ----------------------------------------------------------------------------
// Pulse stream (p64.h lines 94-117)
// ----------------------------------------------------------------------------

/**
 * Single flux pulse. Doubly-linked list node (Previous/Next index
 * into the Pulses array). Strength = 0xFFFFFFFF for a strong pulse;
 * lesser values are probabilistic ("weak") pulses used by copy
 * protection.
 */
export interface TP64Pulse {
  Previous: number;  // p64_int32_t
  Next: number;      // p64_int32_t
  Position: number;  // p64_uint32_t (0 .. P64PulseSamplesPerRotation-1)
  Strength: number;  // p64_uint32_t
}

/** Pointer-to-pulse alias (TS: identical). */
export type PP64Pulse = TP64Pulse;

/** Pointer-to-array of pulses. */
export type PP64Pulses = TP64Pulse[];

/**
 * Per-track flux pulse stream. The Pulses array stores nodes; the
 * UsedFirst/UsedLast/FreeList indices form linked lists threaded
 * through the Previous/Next fields.
 *
 * `CurrentIndex` is the cursor used by rotation_1541_p64 to track the
 * pulse just under the read head.
 */
export interface TP64PulseStream {
  Pulses: PP64Pulses;        // backing array
  PulsesAllocated: number;   // p64_uint32_t — array capacity
  PulsesCount: number;       // p64_uint32_t — live node count
  UsedFirst: number;         // p64_int32_t — head of used list (−1 = empty)
  UsedLast: number;          // p64_int32_t — tail of used list
  FreeList: number;          // p64_int32_t — head of free list
  CurrentIndex: number;      // p64_int32_t — cursor for rotation_1541_p64
}

export type PP64PulseStream = TP64PulseStream;

/**
 * Per-image pulse stream matrix.
 *
 * VICE: `TP64PulseStreams = TP64PulseStream[2][(P64LastHalfTrack-0)+2]`
 *       = [side][half-track] where side ∈ {0,1}, half-track ∈ {0..86}
 *
 * Stock 1541 is single-sided → only [0][*] is used; [1][*] exists for
 * 1571 dual-sided images.
 */
export type TP64PulseStreams = TP64PulseStream[][]; // [2][P64LastHalfTrack+2]

export type PP64PulseStreams = TP64PulseStreams;

// ----------------------------------------------------------------------------
// Image (p64.h lines 119-128)
// ----------------------------------------------------------------------------

/**
 * Full P64 disk image. Includes the per-side pulse stream matrix
 * plus image-level flags.
 */
export interface TP64Image {
  PulseStreams: TP64PulseStreams;  // [2][P64LastHalfTrack+2]
  WriteProtected: number;          // p64_uint32_t (boolean as uint)
  noSides: number;                 // p64_int32_t (1 = single-sided)
}

export type PP64Image = TP64Image;

// ----------------------------------------------------------------------------
// Memory stream (p64.h lines 130-138)
// ----------------------------------------------------------------------------

/**
 * Random-access byte stream used by P64ImageRead/WriteFromStream
 * for the .p64 file format I/O.
 */
export interface TP64MemoryStream {
  Data: Uint8Array | null;   // p64_uint8_t*
  Allocated: number;         // p64_uint32_t — buffer capacity
  Size: number;              // p64_uint32_t — valid bytes
  Position: number;          // p64_uint32_t — read/write cursor
}

export type PP64MemoryStream = TP64MemoryStream;

// ----------------------------------------------------------------------------
// Sentinel values (VICE uses -1 to mean "null pointer" in the index lists)
// ----------------------------------------------------------------------------

/** Sentinel "no node" index used in Previous/Next/UsedFirst/UsedLast/FreeList/CurrentIndex. */
export const P64_NULL_INDEX = -1;
