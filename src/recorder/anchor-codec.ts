// Spec 766.2 — generic compact-binary codec for a recorder anchor payload.
//
// Why generic (not hand-laid byte-exact per struct): the anchor carries the
// subsystems' OWN snapshot objects (vicii_snapshot_write → a ~40-field +
// regs[64]/dbuf[520]/color_ram[1024]/sprite[8]/drawCycle monster; cia/sid; etc.).
// Those shapes are LIVING ports — they change as the VIC/CIA are improved. A
// hand-laid parallel byte layout would need lockstep maintenance forever + a big
// Spec-620 bug surface. This codec instead FOLLOWS the actual object shape: it
// walks the value and emits a compact self-describing BINARY stream (tag + value,
// NOT JSON, NOT gzip). Byte-exact round-trip (gated by probe-766-codec), and it
// auto-tracks shape changes — no lockstep.
//
// Hot-path discipline (766 §1): the producer encodes into a REUSED scratch buffer
// (grown once, then reused — zero allocation per anchor after warmup) and the
// ring write is a plain memcpy of the encoded bytes. Encoding runs ~2×/s (the
// 0.5 s anchor cadence), never per frame.

// Value tags.
const T_NULL = 0;
const T_UNDEF = 1;
const T_FALSE = 2;
const T_TRUE = 3;
const T_DOUBLE = 4;   // f64
const T_STRING = 5;   // u32 byteLen + utf8
const T_ARRAY = 6;    // u32 count + values
const T_OBJECT = 7;   // u32 keyCount + (string key, value)*
const T_TYPED = 8;    // u8 ctorId + u32 byteLen + raw bytes

// Typed-array constructors we round-trip (id → ctor), mirroring native-snapshot.
const TYPED_CTORS = [
  Uint8Array, Int8Array, Uint8ClampedArray,
  Uint16Array, Int16Array, Uint32Array, Int32Array,
  Float32Array, Float64Array,
] as const;
function typedCtorId(v: ArrayBufferView): number {
  for (let i = 0; i < TYPED_CTORS.length; i++) if (v instanceof TYPED_CTORS[i]!) return i;
  return -1;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Encoder with a reused, growable scratch buffer — zero allocation per encode
 * after the buffer has grown to the working size. NOT thread-shared: one per
 * producer.
 */
export class AnchorEncoder {
  private buf: Uint8Array;
  private dv: DataView;
  private off = 0;

  constructor(initialBytes = 1 << 17 /* 128 KiB */) {
    this.buf = new Uint8Array(initialBytes);
    this.dv = new DataView(this.buf.buffer);
  }

  /** Encode `value` into the scratch buffer; returns a subarray view of the
   *  encoded bytes (valid until the next encode()). Copy it out (the ring does). */
  encode(value: unknown): Uint8Array {
    this.off = 0;
    this.writeValue(value);
    return this.buf.subarray(0, this.off);
  }

  /** Like encode(), but leaves `reserve` bytes free at the front for a fixed
   *  record header the caller fills in place (e.g. writeAnchorHeader). Returns a
   *  subarray view of [0, reserve + encodedLen). Zero-alloc after warmup — the
   *  whole [header | codec] record is contiguous in the scratch, ready for one
   *  ring memcpy. */
  encodeWithReserve(reserve: number, value: unknown): Uint8Array {
    this.ensure(reserve);
    this.off = reserve;
    this.writeValue(value);
    return this.buf.subarray(0, this.off);
  }

  private ensure(extra: number): void {
    const need = this.off + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < need) cap <<= 1;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.off));
    this.buf = next;
    this.dv = new DataView(this.buf.buffer);
  }

  private u8(v: number): void { this.ensure(1); this.buf[this.off++] = v & 0xff; }
  private u32(v: number): void { this.ensure(4); this.dv.setUint32(this.off, v >>> 0, true); this.off += 4; }
  private f64(v: number): void { this.ensure(8); this.dv.setFloat64(this.off, v, true); this.off += 8; }

  private writeValue(v: unknown): void {
    if (v === null) { this.u8(T_NULL); return; }
    if (v === undefined) { this.u8(T_UNDEF); return; }
    const t = typeof v;
    if (t === "boolean") { this.u8(v ? T_TRUE : T_FALSE); return; }
    if (t === "number") { this.u8(T_DOUBLE); this.f64(v as number); return; }
    if (t === "string") {
      this.u8(T_STRING);
      const bytes = textEncoder.encode(v as string);
      this.u32(bytes.length);
      this.ensure(bytes.length); this.buf.set(bytes, this.off); this.off += bytes.length;
      return;
    }
    if (ArrayBuffer.isView(v)) {
      const id = typedCtorId(v as ArrayBufferView);
      if (id < 0) throw new Error(`anchor-codec: unsupported typed array ${(v as object).constructor?.name}`);
      const view = v as ArrayBufferView;
      const raw = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      this.u8(T_TYPED); this.u8(id); this.u32(raw.byteLength);
      this.ensure(raw.byteLength); this.buf.set(raw, this.off); this.off += raw.byteLength;
      return;
    }
    if (Array.isArray(v)) {
      this.u8(T_ARRAY); this.u32(v.length);
      for (let i = 0; i < v.length; i++) this.writeValue(v[i]);
      return;
    }
    if (t === "object") {
      const keys = Object.keys(v as object);
      this.u8(T_OBJECT); this.u32(keys.length);
      for (const k of keys) {
        const kb = textEncoder.encode(k);
        this.u32(kb.length);
        this.ensure(kb.length); this.buf.set(kb, this.off); this.off += kb.length;
        this.writeValue((v as Record<string, unknown>)[k]);
      }
      return;
    }
    throw new Error(`anchor-codec: cannot encode value of type ${t}`);
  }
}

/** Decode a binary anchor payload back to its value graph. Allocates (consumer
 *  / worker side — off the hot path). */
export function decodeAnchor(bytes: Uint8Array): unknown {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0;
  const u8 = (): number => bytes[off++]!;
  const u32 = (): number => { const v = dv.getUint32(off, true); off += 4; return v; };
  const f64 = (): number => { const v = dv.getFloat64(off, true); off += 8; return v; };
  const str = (): string => { const n = u32(); const s = textDecoder.decode(bytes.subarray(off, off + n)); off += n; return s; };

  function readValue(): unknown {
    const tag = u8();
    switch (tag) {
      case T_NULL: return null;
      case T_UNDEF: return undefined;
      case T_FALSE: return false;
      case T_TRUE: return true;
      case T_DOUBLE: return f64();
      case T_STRING: return str();
      case T_ARRAY: { const n = u32(); const a = new Array(n); for (let i = 0; i < n; i++) a[i] = readValue(); return a; }
      case T_OBJECT: {
        const n = u32(); const o: Record<string, unknown> = {};
        for (let i = 0; i < n; i++) { const k = str(); o[k] = readValue(); }
        return o;
      }
      case T_TYPED: {
        const id = u8(); const n = u32();
        const Ctor = TYPED_CTORS[id];
        if (!Ctor) throw new Error(`anchor-codec: unknown typed-array id ${id}`);
        // Copy the raw bytes into a fresh buffer (detached from the ring slot).
        const raw = bytes.slice(off, off + n); off += n;
        return new Ctor(raw.buffer, 0, n / (Ctor as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT);
      }
      default: throw new Error(`anchor-codec: bad tag ${tag} at off ${off - 1}`);
    }
  }
  return readValue();
}
