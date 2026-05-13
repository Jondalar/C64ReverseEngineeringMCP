// Spec 441 (Epic 440) — TS port of VICE `src/lib/p64/p64.c` (1211 LoC).
//
// Mirrors VICE 3.7.1 implementation 1:1. Module-level functions match
// VICE C function names verbatim. Structs (TP64*) live in p64-types.ts.
//
// Doctrine: Epic 440 + feedback_vice_no_alternatives.
// - All functions ported, no subset.
// - VICE function names verbatim.
// - No TS-OO wrappers; top-level functions taking PP64* args.
//
// Build pieces (Spec 441 step 2b):
//   - P64MemoryStream*  (12 fns)  — file I/O abstraction
//   - P64PulseStream*   (17 fns)  — pulse list management + GCR convert + serialize
//   - P64Image*         (5 fns)   — top-level image lifecycle
//   - P64CRC32          (1 fn)    — IEEE CRC32 for image integrity
//   - P64RangeCoder*    (~15 fns) — LZ-style range coder for compressed pulses
//
// VICE source paths:
//   /Users/alex/Development/C64/Tools/vice/vice/src/lib/p64/p64.c
//   /Users/alex/Development/C64/Tools/vice/vice/src/lib/p64/p64.h
//
// This file currently ports:
//   - P64MemoryStream*   ✅ (step 2b — this commit)
//   - P64PulseStream*    ⏳ (step 2c follow-up)
//   - P64Image*          ⏳ (step 2d follow-up)
//   - P64RangeCoder*     ⏳ (step 2d follow-up)
//   - P64CRC32           ⏳ (step 2d follow-up)
//
// "Allocated" semantics: VICE doubles capacity on overflow; TS port
// mirrors that pattern using Uint8Array re-allocation. JS GC handles
// `p64_free`; TS port nulls out the Data field to match VICE's
// post-destroy state.

import type {
  PP64MemoryStream,
  TP64MemoryStream,
} from "./p64-types.js";

// ============================================================================
// TP64MemoryStream — random-access byte stream
// ----------------------------------------------------------------------------
// VICE: p64.c lines 228-397
// ============================================================================

/** VICE p64.c:228. Initialize fields to zero (memset). */
export function P64MemoryStreamCreate(Instance: PP64MemoryStream): void {
  Instance.Data = null;
  Instance.Allocated = 0;
  Instance.Size = 0;
  Instance.Position = 0;
}

/** VICE p64.c:232. Free buffer, reset fields. */
export function P64MemoryStreamDestroy(Instance: PP64MemoryStream): void {
  Instance.Data = null; // JS GC; mirrors p64_free
  Instance.Allocated = 0;
  Instance.Size = 0;
  Instance.Position = 0;
}

/** VICE p64.c:239. Same as Destroy (same body). */
export function P64MemoryStreamClear(Instance: PP64MemoryStream): void {
  Instance.Data = null;
  Instance.Allocated = 0;
  Instance.Size = 0;
  Instance.Position = 0;
}

/**
 * VICE p64.c:246.
 *   if Position < Size: Instance.Position = Position
 *   return Instance.Position
 */
export function P64MemoryStreamSeek(
  Instance: PP64MemoryStream,
  Position: number,
): number {
  if (Position < Instance.Size) {
    Instance.Position = Position >>> 0;
  }
  return Instance.Position;
}

/**
 * VICE p64.c:253. Read up to Count bytes into `Data` from current
 * Position. Advances Position by bytes-actually-read. Returns count
 * actually read.
 */
export function P64MemoryStreamRead(
  Instance: PP64MemoryStream,
  Data: Uint8Array,
  Count: number,
): number {
  let ToDo = 0;
  if (Count > 0 && Instance.Position < Instance.Size) {
    ToDo = Instance.Size - Instance.Position;
    if (ToDo > Count) {
      ToDo = Count;
    }
    // memmove(Data, Instance->Data + Instance->Position, ToDo)
    if (Instance.Data) {
      Data.set(Instance.Data.subarray(Instance.Position, Instance.Position + ToDo));
    }
    Instance.Position = (Instance.Position + ToDo) >>> 0;
  }
  return ToDo;
}

/**
 * VICE p64.c:266. Write Count bytes from `Data` at current Position.
 * Grows allocated buffer by doubling when needed. Updates Size if
 * Position exceeds it.
 */
export function P64MemoryStreamWrite(
  Instance: PP64MemoryStream,
  Data: Uint8Array,
  Count: number,
): number {
  if (Count) {
    if ((Instance.Position + Count) >= Instance.Allocated) {
      if (Instance.Allocated < 16) {
        Instance.Allocated = 16;
      }
      while ((Instance.Position + Count) >= Instance.Allocated) {
        Instance.Allocated += Instance.Allocated;
      }
      const next = new Uint8Array(Instance.Allocated);
      if (Instance.Data) {
        next.set(Instance.Data.subarray(0, Instance.Size));
      }
      Instance.Data = next;
    }
    // memmove(Data + Position, Data, Count)
    Instance.Data!.set(
      Data.subarray(0, Count),
      Instance.Position,
    );
    Instance.Position = (Instance.Position + Count) >>> 0;
    if (Instance.Size < Instance.Position) {
      Instance.Size = Instance.Position;
    }
    return Count;
  }
  return 0;
}

/**
 * VICE p64.c:292. Read one byte. Returns 1 on success, 0 on EOF.
 * Output via OUT parameter — TS uses a 1-byte buffer.
 */
export function P64MemoryStreamReadByte(
  Instance: PP64MemoryStream,
  Data: Uint8Array, // length 1
): number {
  return P64MemoryStreamRead(Instance, Data, 1) ? 1 : 0;
}

/**
 * VICE p64.c:296. Read 16-bit LE word.
 *   b[0], b[1] = bytes; *Data = b[0] | (b[1] << 8)
 * TS: Data is a Uint16Array of length 1.
 */
export function P64MemoryStreamReadWord(
  Instance: PP64MemoryStream,
  Data: Uint16Array, // length 1
): number {
  const b = new Uint8Array(2);
  const b0 = b.subarray(0, 1);
  const b1 = b.subarray(1, 2);
  if (!P64MemoryStreamReadByte(Instance, b0)) return 0;
  if (!P64MemoryStreamReadByte(Instance, b1)) return 0;
  Data[0] = (b[0]! | (b[1]! << 8)) & 0xffff;
  return 1;
}

/**
 * VICE p64.c:308. Read 32-bit LE dword.
 */
export function P64MemoryStreamReadDWord(
  Instance: PP64MemoryStream,
  Data: Uint32Array, // length 1
): number {
  const w = new Uint16Array(2);
  const w0 = w.subarray(0, 1);
  const w1 = w.subarray(1, 2);
  if (!P64MemoryStreamReadWord(Instance, w0)) return 0;
  if (!P64MemoryStreamReadWord(Instance, w1)) return 0;
  Data[0] = ((w[0]! | (w[1]! << 16)) >>> 0);
  return 1;
}

/** VICE p64.c:320. */
export function P64MemoryStreamWriteByte(
  Instance: PP64MemoryStream,
  Data: Uint8Array, // length 1
): number {
  return P64MemoryStreamWrite(Instance, Data, 1) ? 1 : 0;
}

/**
 * VICE p64.c:324. Write 16-bit LE word.
 *   b[0] = *Data & 0xff
 *   b[1] = (*Data >> 8) & 0xff
 */
export function P64MemoryStreamWriteWord(
  Instance: PP64MemoryStream,
  Data: Uint16Array, // length 1
): number {
  const b = new Uint8Array(2);
  const v = Data[0]! & 0xffff;
  b[0] = v & 0xff;
  b[1] = (v >> 8) & 0xff;
  if (!P64MemoryStreamWriteByte(Instance, b.subarray(0, 1))) return 0;
  if (!P64MemoryStreamWriteByte(Instance, b.subarray(1, 2))) return 0;
  return 1;
}

/** VICE p64.c:337. Write 32-bit LE dword. */
export function P64MemoryStreamWriteDWord(
  Instance: PP64MemoryStream,
  Data: Uint32Array, // length 1
): number {
  const w = new Uint16Array(2);
  const v = Data[0]! >>> 0;
  w[0] = v & 0xffff;
  w[1] = (v >>> 16) & 0xffff;
  if (!P64MemoryStreamWriteWord(Instance, w.subarray(0, 1))) return 0;
  if (!P64MemoryStreamWriteWord(Instance, w.subarray(1, 2))) return 0;
  return 1;
}

/**
 * VICE p64.c:350. Copy FromInstance into Instance (deep copy of
 * the entire buffer). Resets Instance.Position to 0.
 */
export function P64MemoryStreamAssign(
  Instance: PP64MemoryStream,
  FromInstance: PP64MemoryStream,
): number {
  Instance.Data = null; // p64_free + memset 0
  Instance.Size = 0;
  Instance.Allocated = 0;
  Instance.Position = 0;
  if (FromInstance.Allocated > 0) {
    Instance.Data = new Uint8Array(FromInstance.Allocated);
  }
  Instance.Size = FromInstance.Size;
  Instance.Allocated = FromInstance.Allocated;
  Instance.Position = 0;
  if (Instance.Size && FromInstance.Data && Instance.Data) {
    Instance.Data.set(FromInstance.Data.subarray(0, Instance.Size));
  }
  return Instance.Size;
}

/**
 * VICE p64.c:365. Append entire FromInstance buffer to Instance at
 * Instance.Position. Sets FromInstance.Position to its Size.
 */
export function P64MemoryStreamAppend(
  Instance: PP64MemoryStream,
  FromInstance: PP64MemoryStream,
): number {
  if (FromInstance.Size && FromInstance.Data) {
    FromInstance.Position = FromInstance.Size;
    return P64MemoryStreamWrite(Instance, FromInstance.Data, FromInstance.Size);
  }
  return 0;
}

/**
 * VICE p64.c:373. Append the remaining (from current Position) of
 * FromInstance into Instance.
 */
export function P64MemoryStreamAppendFrom(
  Instance: PP64MemoryStream,
  FromInstance: PP64MemoryStream,
): number {
  if (
    FromInstance.Size > 0 &&
    FromInstance.Position < FromInstance.Size &&
    FromInstance.Data
  ) {
    const tail = FromInstance.Data.subarray(FromInstance.Position, FromInstance.Size);
    if (P64MemoryStreamWrite(Instance, tail, FromInstance.Size - FromInstance.Position)) {
      FromInstance.Position = FromInstance.Size;
      return 1;
    }
    FromInstance.Position = FromInstance.Size;
  }
  return 0;
}

/**
 * VICE p64.c:384. Append up to `Count` bytes from FromInstance
 * (starting at FromInstance.Position) into Instance.
 */
export function P64MemoryStreamAppendFromCount(
  Instance: PP64MemoryStream,
  FromInstance: PP64MemoryStream,
  Count: number,
): number {
  let ToDo = 0;
  if (
    Count > 0 &&
    FromInstance.Position < FromInstance.Size &&
    FromInstance.Data
  ) {
    ToDo = FromInstance.Size - FromInstance.Position;
    if (ToDo > Count) {
      ToDo = Count;
    }
    if (ToDo > 0) {
      const slice = FromInstance.Data.subarray(
        FromInstance.Position,
        FromInstance.Position + ToDo,
      );
      ToDo = P64MemoryStreamWrite(Instance, slice, ToDo);
      FromInstance.Position = (FromInstance.Position + ToDo) >>> 0;
    }
  }
  return ToDo;
}
