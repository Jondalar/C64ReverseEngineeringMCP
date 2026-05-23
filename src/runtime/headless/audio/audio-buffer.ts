// Spec 263 — audio ring buffer for streaming PCM samples.
//
// Producer side: SID engine emits Int16 samples (mono).
// Consumer side: WebSocket sender (binary frame BIN_TYPE_AUDIO_BUFFER)
//                 + WAV file writer.
//
// Single-producer / multi-consumer fan-out via consumer cursors. The ring
// is power-of-two sized (default 64 KiB samples ≈ 1.5s @ 44.1kHz) to
// allow bitwise modulo. Overflow policy: oldest unread samples are
// overwritten (drop-oldest); each consumer learns of the drop via
// `lastReadOverflowed`.
//
// Stereo handling: SID is mono. Helpers `monoToStereoLR()` duplicate
// each mono sample into L+R for stereo PCM consumers (WAV / WebAudio
// expects stereo for the V3 protocol).

export interface AudioBufferOptions {
  /** Capacity in mono samples. Rounded up to next power of two. */
  capacitySamples?: number;
  /** Sample rate (Hz) — informational only. */
  sampleRate?: number;
}

export class AudioRingBuffer {
  public readonly capacity: number;
  public readonly mask: number;
  public readonly sampleRate: number;
  private buf: Int16Array;
  private writePos = 0;            // total samples written (monotonic)
  private consumers = new Map<string, { readPos: number; overflowed: boolean }>();

  constructor(opts: AudioBufferOptions = {}) {
    const requested = opts.capacitySamples ?? 65536;
    let cap = 1;
    while (cap < requested) cap <<= 1;
    this.capacity = cap;
    this.mask = cap - 1;
    this.sampleRate = opts.sampleRate ?? 44100;
    this.buf = new Int16Array(cap);
  }

  /** Total samples written by producer since construction. */
  get totalWritten(): number { return this.writePos; }

  /** Producer: append samples. */
  write(samples: Int16Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.buf[(this.writePos + i) & this.mask] = samples[i]!;
    }
    this.writePos += samples.length;
    // Mark consumers whose read window has been overrun.
    for (const c of this.consumers.values()) {
      if (this.writePos - c.readPos > this.capacity) {
        c.overflowed = true;
        c.readPos = this.writePos - this.capacity;
      }
    }
  }

  /** Register a consumer cursor (start at current write position). */
  attach(id: string): void {
    if (this.consumers.has(id)) throw new Error(`consumer ${id} already attached`);
    this.consumers.set(id, { readPos: this.writePos, overflowed: false });
  }

  detach(id: string): void { this.consumers.delete(id); }

  /**
   * Spec 705.A step 4 — discard all currently-buffered (unconsumed) samples.
   * Used on RuntimeCheckpoint restore: pre-restore PCM is presentation/transport
   * state, not machine state, so it is dropped and re-buffered from the restored
   * reSID synthesis state. Advances every consumer to the write head (available
   * = 0) and clears overflow flags; the monotonic writePos is preserved.
   */
  clear(): void {
    for (const c of this.consumers.values()) {
      c.readPos = this.writePos;
      c.overflowed = false;
    }
  }

  /** Consumer: how many samples are available since last read. */
  available(id: string): number {
    const c = this.consumers.get(id);
    if (!c) throw new Error(`unknown consumer ${id}`);
    return this.writePos - c.readPos;
  }

  /**
   * Consumer: read up to `max` samples. Returns the actually-read slice
   * (may be shorter than max) and advances the cursor. Overflow flag
   * reset on read.
   */
  read(id: string, max: number): { samples: Int16Array; overflowed: boolean } {
    const c = this.consumers.get(id);
    if (!c) throw new Error(`unknown consumer ${id}`);
    const avail = this.writePos - c.readPos;
    const n = Math.min(max, avail);
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = this.buf[(c.readPos + i) & this.mask]!;
    }
    c.readPos += n;
    const ov = c.overflowed;
    c.overflowed = false;
    return { samples: out, overflowed: ov };
  }

  /** True if last read for this consumer dropped samples. */
  lastReadOverflowed(id: string): boolean {
    const c = this.consumers.get(id);
    if (!c) throw new Error(`unknown consumer ${id}`);
    return c.overflowed;
  }
}

/** Mono Int16 → stereo (interleaved L/R) Int16. */
export function monoToStereoLR(mono: Int16Array): Int16Array {
  const out = new Int16Array(mono.length * 2);
  for (let i = 0; i < mono.length; i++) {
    out[i * 2] = mono[i]!;
    out[i * 2 + 1] = mono[i]!;
  }
  return out;
}

/** Convert Int16Array to little-endian byte buffer for binary transport. */
export function int16ToLeBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    dv.setInt16(i * 2, samples[i]!, true);
  }
  return out;
}
