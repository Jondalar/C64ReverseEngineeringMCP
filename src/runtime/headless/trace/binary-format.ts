// Spec 726.B — Trace V2 binary timeline format.
//
// The authoritative runtime trace timeline is an append-only `.c64retrace`
// binary log. DuckDB is a DERIVED query index rebuilt from this log
// (binary-log-indexer.ts), never the hot-path authority (§2b/§2c).
//
// Wire shape (one file = one run):
//
//   FILE  := FileHeader  Event*
//   FileHeader := MAGIC(8) version(u16) flags(u16) metaLen(u32) metaJson(metaLen)
//   Event := opcode(u8) payload(opcode-specific, self-delimiting)
//
// Events are self-delimiting: fixed opcodes have a static payload size; the
// few variable opcodes (MARK label, MEDIA_WRITE bytes) embed a u16 length.
// A decoder can therefore stream the file sequentially and skip unknown
// opcodes via the size table — forward-compatible across a version bump.
//
// Hot-path contract (§2c): the emulator thread only fills a preallocated
// ArrayBuffer via these encoders (no JS object alloc for the record itself, no
// JSON.stringify, no SQL). All multi-byte fields are little-endian. Cycle
// counts use f64 to hold the full 2^53 safe-integer range (a PAL session far
// exceeds u32 cycles).

export const C64RETRACE_MAGIC = new Uint8Array([0x43, 0x36, 0x34, 0x52, 0x45, 0x54, 0x52, 0x31]); // "C64RETR1"
export const C64RETRACE_FORMAT_VERSION = 1;
export const MAGIC_LEN = 8;
export const FILE_HEADER_FIXED = MAGIC_LEN + 2 /*version*/ + 2 /*flags*/ + 4 /*metaLen*/;

/** Event opcodes. 0x10/0x11/0x12 = C64-side core (hot). 0x30/0x31 = drive-side.
 *  0x20-0x23 + 0x32/0x33/0x40 are channel-specific; those without a live
 *  producer today are RESERVED (schema present, encoder defined, never emitted)
 *  per Spec 726.B Phase 2. */
export enum TraceOp {
  MARK = 0x01,
  CPU_STEP = 0x10,        // C64 CPU instruction retire
  RAM_WRITE = 0x11,       // C64 memory bus access (op byte = read/write)
  IO_WRITE = 0x12,        // C64 IO bus access  (op byte = read/write)
  VIC_REG_WRITE = 0x20,   // VIC raster/mode event
  CIA_EVENT = 0x21,       // RESERVED (no live producer)
  SID_REG_WRITE = 0x22,   // SID register write
  IEC_LINE_CHANGE = 0x23, // IEC line transition
  DRIVE_CPU_STEP = 0x30,  // 1541 CPU instruction retire
  DRIVE_RAM_WRITE = 0x31, // 1541 memory bus access (op byte = read/write)
  VIA_REG_WRITE = 0x32,   // RESERVED (no live producer)
  GCR_EVENT = 0x33,       // RESERVED (no live producer)
  MEDIA_WRITE = 0x40,     // RESERVED (no live producer)
}

/** op byte for memory/io access records. */
export const ACCESS_READ = 0;
export const ACCESS_WRITE = 1;

// Fixed payload sizes (excluding the 1-byte opcode). Variable opcodes are -1.
const SIZE: Record<number, number> = {
  [TraceOp.MARK]: -1,             // f64 cycle + u16 len + label
  [TraceOp.CPU_STEP]: 18,         // see encodeCpuStep
  [TraceOp.DRIVE_CPU_STEP]: 18,
  [TraceOp.RAM_WRITE]: 15,        // see encodeMemAccess (Spec 753: +1 old_value byte)
  [TraceOp.IO_WRITE]: 15,
  [TraceOp.DRIVE_RAM_WRITE]: 15,
  [TraceOp.VIC_REG_WRITE]: 12,
  [TraceOp.SID_REG_WRITE]: 11,
  [TraceOp.IEC_LINE_CHANGE]: 10,
  [TraceOp.CIA_EVENT]: 12,        // reserved
  [TraceOp.VIA_REG_WRITE]: 12,    // reserved
  [TraceOp.GCR_EVENT]: 12,        // reserved
  [TraceOp.MEDIA_WRITE]: -1,      // reserved (variable)
};

/** Max bytes any single event can occupy (used to size the safety margin when
 *  deciding whether a record fits the current chunk). Variable records cap their
 *  label/data length, see encodeMark. */
export const MAX_EVENT_BYTES = 1 + 8 + 2 + 255; // opcode + cycle + len + max label

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ---------------------------------------------------------------------------
// File header
// ---------------------------------------------------------------------------

export interface TraceFileMeta {
  runId: string;
  defId: string;
  defVersion: number;
  defName: string;
  defJson: string;          // full RuntimeTraceDefinition (for rebuild)
  domains: string[];
  cycleStart: number;
  mediaSha?: string;
  mediaName?: string;
  startCheckpointId?: string;
  createdAt: string;
}

/** Encode the file header into a fresh Uint8Array. Low-volume (once per run). */
export function encodeFileHeader(meta: TraceFileMeta): Uint8Array {
  const metaJson = textEncoder.encode(JSON.stringify(meta));
  const buf = new Uint8Array(FILE_HEADER_FIXED + metaJson.length);
  const dv = new DataView(buf.buffer);
  buf.set(C64RETRACE_MAGIC, 0);
  let o = MAGIC_LEN;
  dv.setUint16(o, C64RETRACE_FORMAT_VERSION, true); o += 2;
  dv.setUint16(o, 0, true); o += 2; // flags
  dv.setUint32(o, metaJson.length, true); o += 4;
  buf.set(metaJson, o);
  return buf;
}

export interface ParsedFileHeader { meta: TraceFileMeta; version: number; headerLen: number; }

export function decodeFileHeader(buf: Uint8Array): ParsedFileHeader {
  if (buf.length < FILE_HEADER_FIXED) throw new Error("c64retrace: truncated header");
  for (let i = 0; i < MAGIC_LEN; i++) {
    if (buf[i] !== C64RETRACE_MAGIC[i]) throw new Error("c64retrace: bad magic");
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const version = dv.getUint16(MAGIC_LEN, true);
  const metaLen = dv.getUint32(MAGIC_LEN + 4, true);
  const metaStart = FILE_HEADER_FIXED;
  if (buf.length < metaStart + metaLen) throw new Error("c64retrace: truncated meta");
  const metaJson = textDecoder.decode(buf.subarray(metaStart, metaStart + metaLen));
  return { meta: JSON.parse(metaJson) as TraceFileMeta, version, headerLen: metaStart + metaLen };
}

// ---------------------------------------------------------------------------
// Event encoders — write into `dv` at `off`, return next offset, or -1 if the
// record does not fit (caller flips to a fresh chunk and retries). NEVER drops.
// ---------------------------------------------------------------------------

function fits(off: number, need: number, cap: number): boolean { return off + need <= cap; }

export function encodeCpuStep(
  dv: DataView, off: number, cap: number, op: TraceOp.CPU_STEP | TraceOp.DRIVE_CPU_STEP,
  cycle: number, pc: number, opcode: number, a: number, x: number, y: number,
  sp: number, p: number, b1: number, b2: number,
): number {
  if (!fits(off, 1 + 18, cap)) return -1;
  dv.setUint8(off, op); off += 1;
  dv.setFloat64(off, cycle, true); off += 8;
  dv.setUint16(off, pc & 0xffff, true); off += 2;
  dv.setUint8(off, opcode & 0xff); off += 1;
  dv.setUint8(off, a & 0xff); off += 1;
  dv.setUint8(off, x & 0xff); off += 1;
  dv.setUint8(off, y & 0xff); off += 1;
  dv.setUint8(off, sp & 0xff); off += 1;
  dv.setUint8(off, p & 0xff); off += 1;
  dv.setUint8(off, b1 & 0xff); off += 1;
  dv.setUint8(off, b2 & 0xff); off += 1;
  return off;
}

export function encodeMemAccess(
  dv: DataView, off: number, cap: number,
  op: TraceOp.RAM_WRITE | TraceOp.IO_WRITE | TraceOp.DRIVE_RAM_WRITE,
  cycle: number, addr: number, value: number, pc: number, access: number,
  oldValue?: number,
): number {
  if (!fits(off, 1 + 15, cap)) return -1;
  dv.setUint8(off, op); off += 1;
  dv.setFloat64(off, cycle, true); off += 8;
  dv.setUint16(off, addr & 0xffff, true); off += 2;
  dv.setUint8(off, value & 0xff); off += 1;
  dv.setUint16(off, pc & 0xffff, true); off += 2;
  // Spec 753 — access byte: bit0 = read/write; bit7 = oldValue-present. The
  // trailing byte holds the pre-write value (the mutation surface); absent for
  // reads + I/O-window writes (where a pre-read would have side effects).
  const hasOld = oldValue !== undefined && oldValue !== null;
  dv.setUint8(off, (access & 0x7f) | (hasOld ? 0x80 : 0)); off += 1;
  dv.setUint8(off, hasOld ? (oldValue & 0xff) : 0); off += 1;
  return off;
}

/** IEC line states packed into a u16 (9 meaningful bits, see binary-format
 *  decode). All booleans → bits. */
export function encodeIecLine(
  dv: DataView, off: number, cap: number, cycle: number, lines: number,
): number {
  if (!fits(off, 1 + 10, cap)) return -1;
  dv.setUint8(off, TraceOp.IEC_LINE_CHANGE); off += 1;
  dv.setFloat64(off, cycle, true); off += 8;
  dv.setUint16(off, lines & 0xffff, true); off += 2;
  return off;
}

export function encodeVicEvent(
  dv: DataView, off: number, cap: number, cycle: number, rasterY: number,
  kindCode: number, value: number,
): number {
  if (!fits(off, 1 + 12, cap)) return -1;
  dv.setUint8(off, TraceOp.VIC_REG_WRITE); off += 1;
  dv.setFloat64(off, cycle, true); off += 8;
  dv.setUint16(off, rasterY & 0xffff, true); off += 2;
  dv.setUint8(off, kindCode & 0xff); off += 1;
  dv.setUint8(off, value & 0xff); off += 1;
  return off;
}

export function encodeSidWrite(
  dv: DataView, off: number, cap: number, cycle: number, reg: number, value: number,
): number {
  if (!fits(off, 1 + 11, cap)) return -1;
  dv.setUint8(off, TraceOp.SID_REG_WRITE); off += 1;
  dv.setFloat64(off, cycle, true); off += 8;
  dv.setUint16(off, reg & 0xffff, true); off += 2;
  dv.setUint8(off, value & 0xff); off += 1;
  return off;
}

/** MARK label is capped at 200 bytes (UTF-8) to keep MAX_EVENT_BYTES bounded. */
export function encodeMark(
  dv: DataView, off: number, cap: number, cycle: number, label: string,
): number {
  let bytes = textEncoder.encode(label);
  if (bytes.length > 200) bytes = bytes.subarray(0, 200);
  const need = 1 + 8 + 2 + bytes.length;
  if (!fits(off, need, cap)) return -1;
  dv.setUint8(off, TraceOp.MARK); off += 1;
  dv.setFloat64(off, cycle, true); off += 8;
  dv.setUint16(off, bytes.length, true); off += 2;
  new Uint8Array(dv.buffer, dv.byteOffset + off, bytes.length).set(bytes);
  off += bytes.length;
  return off;
}

// ---------------------------------------------------------------------------
// Decoder — sequential, for the indexer + smokes.
// ---------------------------------------------------------------------------

export interface DecodedEvent {
  op: TraceOp;
  cycle: number;
  // present per-op
  pc?: number; opcode?: number; a?: number; x?: number; y?: number; sp?: number; p?: number;
  b1?: number; b2?: number;
  addr?: number; value?: number; access?: number; oldValue?: number;
  lines?: number; rasterY?: number; kindCode?: number; reg?: number;
  label?: string;
}

/** Decode one event at `off`. Returns the event + next offset, or null at EOF. */
export function decodeEvent(buf: Uint8Array, off: number): { ev: DecodedEvent; next: number } | null {
  if (off >= buf.length) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const op = buf[off] as TraceOp;
  let o = off + 1;
  // Bounds gate (Spec 746.x streaming): return null if the FULL event does not fit
  // in `buf` — it straddles a streaming-window boundary (caller carries + reads
  // more) OR is a truncated final record (aborted trace). Without this the field
  // reads below throw "offset is out of bounds". SIZE[op] = bytes after the opcode.
  const szb = SIZE[op];
  if (szb !== undefined && szb >= 0) {
    if (off + 1 + szb > buf.length) return null;
  } else if (op === TraceOp.MARK) {
    if (off + 11 > buf.length) return null;            // opcode + f64 cycle + u16 len
    const labelLen = dv.getUint16(off + 9, true);
    if (off + 11 + labelLen > buf.length) return null; // + label bytes
  }
  const cycle = dv.getFloat64(o, true); o += 8;
  switch (op) {
    case TraceOp.CPU_STEP:
    case TraceOp.DRIVE_CPU_STEP: {
      const pc = dv.getUint16(o, true); o += 2;
      const opcode = buf[o++]; const a = buf[o++]; const x = buf[o++]; const y = buf[o++];
      const sp = buf[o++]; const p = buf[o++]; const b1 = buf[o++]; const b2 = buf[o++];
      return { ev: { op, cycle, pc, opcode, a, x, y, sp, p, b1, b2 }, next: o };
    }
    case TraceOp.RAM_WRITE:
    case TraceOp.IO_WRITE:
    case TraceOp.DRIVE_RAM_WRITE: {
      const addr = dv.getUint16(o, true); o += 2;
      const value = buf[o++];
      const pc = dv.getUint16(o, true); o += 2;
      const accByte = buf[o++];
      const access = accByte & 0x7f;
      const oldRaw = buf[o++];
      const oldValue = (accByte & 0x80) !== 0 ? oldRaw : undefined;
      return { ev: { op, cycle, addr, value, pc, access, oldValue }, next: o };
    }
    case TraceOp.IEC_LINE_CHANGE: {
      const lines = dv.getUint16(o, true); o += 2;
      return { ev: { op, cycle, lines }, next: o };
    }
    case TraceOp.VIC_REG_WRITE: {
      const rasterY = dv.getUint16(o, true); o += 2;
      const kindCode = buf[o++]; const value = buf[o++];
      return { ev: { op, cycle, rasterY, kindCode, value }, next: o };
    }
    case TraceOp.SID_REG_WRITE: {
      const reg = dv.getUint16(o, true); o += 2;
      const value = buf[o++];
      return { ev: { op, cycle, reg, value }, next: o };
    }
    case TraceOp.MARK: {
      const len = dv.getUint16(o, true); o += 2;
      const label = textDecoder.decode(buf.subarray(o, o + len)); o += len;
      return { ev: { op, cycle, label }, next: o };
    }
    default: {
      // Unknown opcode: skip via the size table (forward-compat). Variable
      // unknown opcodes cannot be skipped safely → stop.
      const sz = SIZE[op];
      if (sz === undefined || sz < 0) throw new Error(`c64retrace: cannot skip opcode 0x${op.toString(16)} at ${off}`);
      return { ev: { op, cycle }, next: off + 1 + sz };
    }
  }
}

/** Decode an entire event stream (after the file header). */
export function decodeEventStream(buf: Uint8Array, start: number): DecodedEvent[] {
  const out: DecodedEvent[] = [];
  let off = start;
  for (;;) {
    const r = decodeEvent(buf, off);
    if (!r) break;
    out.push(r.ev);
    off = r.next;
  }
  return out;
}

// ---------------------------------------------------------------------------
// IEC line bit-pack helpers (shared by encoder + indexer).
// ---------------------------------------------------------------------------

export const IEC_BIT = {
  atn: 1 << 0, clk: 1 << 1, data: 1 << 2,
  c64_atn: 1 << 3, c64_clk: 1 << 4, c64_data: 1 << 5,
  drv_clk: 1 << 6, drv_data: 1 << 7, drv_atn_ack: 1 << 8,
} as const;
