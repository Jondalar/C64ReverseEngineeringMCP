// Spec 768.1 — SID write-stream ring (emu thread → reSID worker).
//
// Carries the exact input the reSID render needs, off the emulation thread: every
// SID register write (in CPU execution order) plus a per-frame BOUNDARY record
// carrying that frame's elapsed cycle count (dCycles → resid.emit). The worker
// replays writes-then-emit per boundary, reproducing today's inline flush()
// byte-for-byte (Spec 703 model: writeTrace applies writes, flush emits dCycles).
//
// Unlike the 766 recorder ring (LOSSY — drops are a benign history gap), the audio
// stream is NO-DROP: a lost gate/freq write = a stuck note / wrong pitch (audible).
// A single-producer/single-consumer SAB ring of fixed u32-pair records; the
// producer advances `head` (release), the worker advances `tail`. The producer
// NEVER blocks the emu thread — if the ring is full (only possible if the worker
// stalled for ~seconds, never in practice given its ~2.1 ms/20 ms headroom) it
// drops + counts, surfaced as an explicit underrun rather than a silent gap.
//
// Record = 2 × u32 (8 bytes), fixed:
//   WRITE:    word0 = (TYPE_WRITE<<24) | (addr & 0x1f),  word1 = value & 0xff
//   BOUNDARY: word0 = (TYPE_BOUNDARY<<24),               word1 = dCycles (u32)

export const SID_REC_TYPE_WRITE = 1;
export const SID_REC_TYPE_BOUNDARY = 2;

// Control region (Int32) at the head of the SAB, before the record slots.
const CTRL_I32_LEN = 8;
const CTRL_BYTES = CTRL_I32_LEN * 4;
const CTRL_HEAD = 0;    // producer write cursor (monotonic record index)
const CTRL_TAIL = 1;    // consumer read cursor
const CTRL_DROPPED = 2; // records the producer could not enqueue (ring full)

const WORDS_PER_REC = 2;

export interface SidWriteRingLayout {
  /** Number of records the ring holds (power-of-two not required). */
  recordCount: number;
}

export function sidWriteRingByteSize(layout: SidWriteRingLayout): number {
  return CTRL_BYTES + layout.recordCount * WORDS_PER_REC * 4;
}

export function createSidWriteRingSab(layout: SidWriteRingLayout): SharedArrayBuffer {
  return new SharedArrayBuffer(sidWriteRingByteSize(layout));
}

export interface SidWriteRecord { type: number; addr: number; value: number; dCycles: number; }

/** Producer end — held by the emulation thread. Allocation-free, never blocks. */
export class SidWriteRingProducer {
  private readonly i32: Int32Array;
  private readonly recBase: number; // i32 index where records start
  private readonly cap: number;

  constructor(sab: SharedArrayBuffer, layout: SidWriteRingLayout) {
    this.i32 = new Int32Array(sab);
    this.recBase = CTRL_I32_LEN;
    this.cap = layout.recordCount;
  }

  private push(word0: number, word1: number): void {
    const head = Atomics.load(this.i32, CTRL_HEAD);
    const tail = Atomics.load(this.i32, CTRL_TAIL);
    if (head - tail >= this.cap) { Atomics.add(this.i32, CTRL_DROPPED, 1); return; } // full (worker stalled)
    const slot = head % this.cap;
    const o = this.recBase + slot * WORDS_PER_REC;
    this.i32[o] = word0;
    this.i32[o + 1] = word1;
    Atomics.store(this.i32, CTRL_HEAD, head + 1); // publish (release)
  }

  /** Record a SID register write (addr = $D4xx offset & 0x1f). */
  write(addr: number, value: number): void {
    this.push((SID_REC_TYPE_WRITE << 24) | (addr & 0x1f), value & 0xff);
  }

  /** Mark a frame boundary: emit `dCycles` of samples after the writes so far. */
  boundary(dCycles: number): void {
    this.push(SID_REC_TYPE_BOUNDARY << 24, dCycles >>> 0);
  }

  droppedCount(): number { return Atomics.load(this.i32, CTRL_DROPPED); }
  headCount(): number { return Atomics.load(this.i32, CTRL_HEAD); }
}

/** Consumer end — held by the reSID worker. Drains all available records in order. */
export class SidWriteRingConsumer {
  private readonly i32: Int32Array;
  private readonly recBase: number;
  private readonly cap: number;

  constructor(sab: SharedArrayBuffer, layout: SidWriteRingLayout) {
    this.i32 = new Int32Array(sab);
    this.recBase = CTRL_I32_LEN;
    this.cap = layout.recordCount;
  }

  /** Drain all available records, in order, into `out`. Returns count appended. */
  drain(out: SidWriteRecord[]): number {
    const head = Atomics.load(this.i32, CTRL_HEAD); // acquire
    let tail = Atomics.load(this.i32, CTRL_TAIL);
    let n = 0;
    for (; tail < head; tail++) {
      const o = this.recBase + (tail % this.cap) * WORDS_PER_REC;
      const w0 = this.i32[o]!;
      const w1 = this.i32[o + 1]!;
      const type = (w0 >>> 24) & 0xff;
      out.push(type === SID_REC_TYPE_WRITE
        ? { type, addr: w0 & 0x1f, value: w1 & 0xff, dCycles: 0 }
        : { type, addr: 0, value: 0, dCycles: w1 >>> 0 });
      n++;
    }
    Atomics.store(this.i32, CTRL_TAIL, tail);
    return n;
  }

  tailCount(): number { return Atomics.load(this.i32, CTRL_TAIL); }
  droppedCount(): number { return Atomics.load(this.i32, CTRL_DROPPED); }
}
