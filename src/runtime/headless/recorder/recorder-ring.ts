// Spec 766.1 — the runtime recorder's shared-memory handoff ring.
//
// A LOSSY single-producer / single-consumer ring over a SharedArrayBuffer. The
// emulation thread is the producer; the recorder worker thread is the consumer.
//
// Design rule (766 §1, the whole point of BUG-049): the PRODUCER NEVER BLOCKS,
// NEVER COORDINATES with the consumer, and NEVER ALLOCATES. It memcpy's a framed
// record into the next slot and bumps an Atomics write-counter — that is all. If
// the consumer has fallen behind, the producer simply overwrites the oldest
// unread slot (a benign history gap); it does not wait, cannot slow the
// emulation loop. The consumer detects it was lapped and resyncs, counting the
// gap. This is what makes the recorder structurally unable to touch fps — unlike
// the 726.B trace, whose drain/backpressure CAN stall the loop.
//
// Fixed-size slots (not a byte ring) → no record-alignment / lap-scan problem:
// slot i is at a fixed offset, the producer writes slot (w % N), the consumer
// reads (r % N), a lap is just `w - r > N`. A per-slot SEQLOCK (odd = mid-write,
// even = settled, +2 per write) lets the consumer detect a TORN read — the
// producer overwriting a slot while the consumer copied it — and count it as a
// drop instead of returning corrupt bytes.
//
// ALL typed-array views are created ONCE in the constructor; the hot `write()`
// path does only Atomics on a pre-made Int32Array + one `Uint8Array.set` memcpy —
// zero allocation, no BigInt (counters are int32 monotonic: at the recorder's
// ~2 writes/s that is a ~34-year overflow horizon; the planned firehose-on-the-
// same-ring follow-up, 766 §10, will switch to wrap-aware or 64-bit counters).

/** Per-slot header bytes (at the start of every slot). Keeps payload 4-aligned. */
const SLOT_HDR_BYTES = 16;
const OFF_SEQ = 0;   // u32 seqlock: even = settled, odd = mid-write
const OFF_LEN = 4;   // u32 payload length
const OFF_TYPE = 8;  // u32 record type
// bytes 12..16 reserved

/** Control region (int32 slots) at the head of the SAB, before the slots. */
const CTRL_I32_LEN = 16;                 // 16 × 4 = 64 control bytes
const CTRL_BYTES = CTRL_I32_LEN * 4;
const CTRL_WRITE = 0;   // i32: monotonic write index (producer owns)
const CTRL_READ = 1;    // i32: monotonic read index  (consumer owns)
const CTRL_DROPPED = 2; // i32: slots overwritten / torn before the consumer read them

export interface RecorderRingLayout {
  /** Usable payload bytes per slot (excludes the per-slot header). */
  slotPayloadBytes: number;
  /** Number of slots. */
  slotCount: number;
}

/** Total SharedArrayBuffer byte size for a layout (control + slots). */
export function recorderRingByteSize(layout: RecorderRingLayout): number {
  const slotStride = SLOT_HDR_BYTES + layout.slotPayloadBytes;
  return CTRL_BYTES + slotStride * layout.slotCount;
}

/** Allocate the SharedArrayBuffer for a layout (zero-initialized by spec). */
export function createRecorderRingSab(layout: RecorderRingLayout): SharedArrayBuffer {
  return new SharedArrayBuffer(recorderRingByteSize(layout));
}

/**
 * The producer end — held by the emulation thread. The only hot-path object;
 * every method is synchronous, allocation-free, and never blocks.
 */
export class RecorderRingProducer {
  private readonly i32: Int32Array;     // whole-SAB int32 view (control + slot headers)
  private readonly bytes: Uint8Array;   // whole-SAB byte view (payload memcpy)
  private readonly slotStride: number;
  private readonly slotCount: number;
  private readonly payloadCap: number;

  constructor(sab: SharedArrayBuffer, layout: RecorderRingLayout) {
    this.i32 = new Int32Array(sab);
    this.bytes = new Uint8Array(sab);
    this.payloadCap = layout.slotPayloadBytes;
    this.slotStride = SLOT_HDR_BYTES + layout.slotPayloadBytes;
    this.slotCount = layout.slotCount;
  }

  /**
   * Write one framed record. Returns true if written, false ONLY if the payload
   * exceeds the slot capacity (a caller sizing bug — never a transient "ring
   * full": a full ring overwrites the oldest and still writes). NEVER blocks,
   * NEVER allocates. `payload` is copied out, so the caller may reuse it after.
   */
  write(type: number, payload: Uint8Array): boolean {
    const len = payload.length;
    if (len > this.payloadCap) return false;

    const i32 = this.i32;
    const w = Atomics.load(i32, CTRL_WRITE);
    const slot = w % this.slotCount;
    const base = CTRL_BYTES + slot * this.slotStride;
    const seqIdx = (base + OFF_SEQ) >> 2;

    // Seqlock: mark mid-write (odd) BEFORE touching the body.
    const seq = Atomics.load(i32, seqIdx);
    Atomics.store(i32, seqIdx, seq + 1); // → odd

    i32[(base + OFF_LEN) >> 2] = len;
    i32[(base + OFF_TYPE) >> 2] = type;
    this.bytes.set(payload, base + SLOT_HDR_BYTES);

    Atomics.store(i32, seqIdx, seq + 2); // → even, settled
    // Publish the new write index LAST (release): a consumer that sees this index
    // is guaranteed to see the settled slot body above.
    Atomics.store(i32, CTRL_WRITE, w + 1);
    return true;
  }

  writeCount(): number { return Atomics.load(this.i32, CTRL_WRITE); }
  droppedCount(): number { return Atomics.load(this.i32, CTRL_DROPPED); }
}

/** A record handed back by the consumer. `payload` is a FRESH copy (safe to keep). */
export interface RecorderRecord {
  type: number;
  payload: Uint8Array;
}

/**
 * The consumer end — held by the recorder worker thread. Drains as fast as it
 * likes; if it was lapped it resyncs to the live window and counts the gap.
 */
export class RecorderRingConsumer {
  private readonly i32: Int32Array;
  private readonly bytes: Uint8Array;
  private readonly slotStride: number;
  private readonly slotCount: number;
  private readonly payloadCap: number;

  constructor(sab: SharedArrayBuffer, layout: RecorderRingLayout) {
    this.i32 = new Int32Array(sab);
    this.bytes = new Uint8Array(sab);
    this.payloadCap = layout.slotPayloadBytes;
    this.slotStride = SLOT_HDR_BYTES + layout.slotPayloadBytes;
    this.slotCount = layout.slotCount;
  }

  /**
   * Drain all currently-available records, oldest first, into `out`. Returns the
   * count appended. If the producer lapped us, the read cursor jumps forward to
   * the live window (the lost slots add to the dropped counter) and only the
   * still-present records are returned. A torn slot (overwritten mid-copy) is
   * skipped as a drop, never returned corrupt.
   */
  drain(out: RecorderRecord[]): number {
    const i32 = this.i32;
    const N = this.slotCount;
    let r = Atomics.load(i32, CTRL_READ);
    const w = Atomics.load(i32, CTRL_WRITE);

    // Lapped? The producer overwrote slots we never read. Resync to the oldest
    // still-present slot (= w - N) and count the gap.
    if (w - r > N) {
      Atomics.add(i32, CTRL_DROPPED, w - r - N);
      r = w - N;
    }

    let appended = 0;
    for (; r < w; r++) {
      const slot = r % N;
      const base = CTRL_BYTES + slot * this.slotStride;
      const seqIdx = (base + OFF_SEQ) >> 2;

      const seq1 = Atomics.load(i32, seqIdx);
      if (seq1 & 1) { Atomics.add(i32, CTRL_DROPPED, 1); continue; } // mid-write → torn

      const len = i32[(base + OFF_LEN) >> 2]!;
      const type = i32[(base + OFF_TYPE) >> 2]!;
      let payload: Uint8Array | null = null;
      if (len >= 0 && len <= this.payloadCap) {
        const start = base + SLOT_HDR_BYTES;
        payload = this.bytes.slice(start, start + len);
      }

      // Re-check the seqlock: if it moved, the producer overwrote this slot while
      // we copied it → torn read, drop it.
      const seq2 = Atomics.load(i32, seqIdx);
      if (seq2 !== seq1 || payload === null) { Atomics.add(i32, CTRL_DROPPED, 1); continue; }

      out.push({ type, payload });
      appended++;
    }
    Atomics.store(i32, CTRL_READ, r);
    return appended;
  }

  writeCount(): number { return Atomics.load(this.i32, CTRL_WRITE); }
  readCount(): number { return Atomics.load(this.i32, CTRL_READ); }
  droppedCount(): number { return Atomics.load(this.i32, CTRL_DROPPED); }
}
