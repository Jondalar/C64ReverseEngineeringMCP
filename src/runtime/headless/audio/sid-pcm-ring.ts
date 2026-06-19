// Spec 768.2 — PCM ring (reSID worker → emu/main thread), over a SharedArrayBuffer.
//
// The worker renders Int16 PCM (resid.emit output, verbatim) and writes it here;
// the main thread (the WS audio ship) reads it and broadcasts. Single-producer
// (worker) / single-consumer (main). Drop-OLDEST on overflow (like AudioRingBuffer
// — if the consumer stalls, the freshest audio wins; the 706 worklet cushion +
// the worker's huge headroom mean this never happens in practice), counted so an
// underrun is visible rather than silent.
//
// Layout: [control Int32 ×8][Int16 sample slab]. HEAD/TAIL are sample counts
// (monotonic); the physical slot is index % capacity.

const CTRL_I32_LEN = 8;
const CTRL_BYTES = CTRL_I32_LEN * 4;
const CTRL_HEAD = 0;     // worker write cursor (total samples written)
const CTRL_TAIL = 1;     // main read cursor
const CTRL_DROPPED = 2;  // samples overwritten before the consumer read them

export interface SidPcmRingLayout {
  /** Capacity in Int16 samples (rounded up to a power of two). */
  capacitySamples: number;
}

function pow2(n: number): number { let c = 1; while (c < n) c <<= 1; return c; }

export function createSidPcmRingSab(layout: SidPcmRingLayout): SharedArrayBuffer {
  const cap = pow2(layout.capacitySamples);
  return new SharedArrayBuffer(CTRL_BYTES + cap * 2); // 2 bytes/sample
}

/** Worker end — writes rendered PCM. */
export class SidPcmRingProducer {
  private readonly i32: Int32Array;
  private readonly samples: Int16Array;
  private readonly cap: number;
  private readonly mask: number;

  constructor(sab: SharedArrayBuffer, layout: SidPcmRingLayout) {
    this.i32 = new Int32Array(sab, 0, CTRL_I32_LEN);
    this.cap = pow2(layout.capacitySamples);
    this.mask = this.cap - 1;
    this.samples = new Int16Array(sab, CTRL_BYTES, this.cap);
  }

  write(src: Int16Array): void {
    const head = Atomics.load(this.i32, CTRL_HEAD);
    for (let i = 0; i < src.length; i++) this.samples[(head + i) & this.mask] = src[i]!;
    const newHead = head + src.length;
    Atomics.store(this.i32, CTRL_HEAD, newHead);
    // Drop-oldest: if we lapped the consumer, advance tail + count the loss.
    const tail = Atomics.load(this.i32, CTRL_TAIL);
    if (newHead - tail > this.cap) {
      Atomics.add(this.i32, CTRL_DROPPED, (newHead - tail) - this.cap);
      Atomics.store(this.i32, CTRL_TAIL, newHead - this.cap);
    }
  }

  headCount(): number { return Atomics.load(this.i32, CTRL_HEAD); }
}

/** Main end — reads PCM to ship over the WS. */
export class SidPcmRingConsumer {
  private readonly i32: Int32Array;
  private readonly samples: Int16Array;
  private readonly cap: number;
  private readonly mask: number;

  constructor(sab: SharedArrayBuffer, layout: SidPcmRingLayout) {
    this.i32 = new Int32Array(sab, 0, CTRL_I32_LEN);
    this.cap = pow2(layout.capacitySamples);
    this.mask = this.cap - 1;
    this.samples = new Int16Array(sab, CTRL_BYTES, this.cap);
  }

  available(): number { return Atomics.load(this.i32, CTRL_HEAD) - Atomics.load(this.i32, CTRL_TAIL); }

  /** Fill `out` with up to min(max, available, out.length) samples; advance. */
  readInto(max: number, out: Int16Array): number {
    const head = Atomics.load(this.i32, CTRL_HEAD);
    let tail = Atomics.load(this.i32, CTRL_TAIL);
    const n = Math.min(max, head - tail, out.length);
    for (let i = 0; i < n; i++) out[i] = this.samples[(tail + i) & this.mask]!;
    Atomics.store(this.i32, CTRL_TAIL, tail + n);
    return n;
  }

  /** Spec 705.A — drop all buffered PCM (restore/scrub transport flush). */
  clear(): void { Atomics.store(this.i32, CTRL_TAIL, Atomics.load(this.i32, CTRL_HEAD)); }

  droppedCount(): number { return Atomics.load(this.i32, CTRL_DROPPED); }
}
