// Spec 766.4 — recorder ring record framing (shared by producer + worker).
//
// Two record kinds travel through the shared-memory ring (recorder-ring.ts):
//
//   REC_ANCHOR — a full machine anchor: a small fixed header (capture cycle,
//     wall-clock ms, current disk + cart medium generations) followed by the
//     anchor codec bytes (RAM + chip state, anchor-codec.ts). NO medium bytes.
//   REC_MEDIUM — a (large) medium image: a fixed header (kind + generation +
//     wall-clock ms) followed by the raw .crt / disk image bytes. Shipped only
//     on a medium gen change (medium-source.ts), so the 1 MiB cart is NOT
//     re-sent every anchor — that per-second copy was the BUG-049 monster.
//
// The headers are FIXED-LAYOUT little-endian so the producer can fill them
// in-place into a reused scratch buffer (zero-alloc, 766.5) and the worker can
// parse them without allocation. `encode*Record` helpers (alloc) exist for the
// worker/test side; the producer fills headers in place via `write*Header`.

export const REC_ANCHOR = 1;
export const REC_MEDIUM = 2;

export const MEDIUM_KIND_DISK = 0;
export const MEDIUM_KIND_CART = 1;

// ---- anchor record header ---------------------------------------------------
// off 0  f64 cycle          (machine clock at capture; monotonic JS number, Spec 743)
// off 8  f64 wallMs         (wall-clock ms at capture, for the scrub timeline)
// off 16 i32 diskGen        (disk medium generation referenced by this anchor)
// off 20 i32 cartGen        (cart medium generation referenced by this anchor)
// off 24 i32 schemaVersion  (RuntimeCheckpoint schema — self-describing for restore)
export const ANCHOR_HEADER_BYTES = 28;

export interface AnchorHeader {
  cycle: number;
  wallMs: number;
  diskGen: number;
  cartGen: number;
  schemaVersion: number;
}

export function writeAnchorHeader(dst: Uint8Array, off: number, h: AnchorHeader): void {
  const dv = new DataView(dst.buffer, dst.byteOffset + off, ANCHOR_HEADER_BYTES);
  dv.setFloat64(0, h.cycle, true);
  dv.setFloat64(8, h.wallMs, true);
  dv.setInt32(16, h.diskGen | 0, true);
  dv.setInt32(20, h.cartGen | 0, true);
  dv.setInt32(24, h.schemaVersion | 0, true);
}

export function readAnchorHeader(src: Uint8Array, off = 0): AnchorHeader {
  const dv = new DataView(src.buffer, src.byteOffset + off, ANCHOR_HEADER_BYTES);
  return {
    cycle: dv.getFloat64(0, true),
    wallMs: dv.getFloat64(8, true),
    diskGen: dv.getInt32(16, true),
    cartGen: dv.getInt32(20, true),
    schemaVersion: dv.getInt32(24, true),
  };
}

// ---- medium record header ---------------------------------------------------
// off 0  u32 kind        (MEDIUM_KIND_DISK | MEDIUM_KIND_CART)
// off 4  i32 generation  (the medium content generation these bytes are)
// off 8  f64 wallMs      (wall-clock ms at capture)
export const MEDIUM_HEADER_BYTES = 16;

export interface MediumHeader {
  kind: number;
  generation: number;
  wallMs: number;
}

export function writeMediumHeader(dst: Uint8Array, off: number, h: MediumHeader): void {
  const dv = new DataView(dst.buffer, dst.byteOffset + off, MEDIUM_HEADER_BYTES);
  dv.setUint32(0, h.kind >>> 0, true);
  dv.setInt32(4, h.generation | 0, true);
  dv.setFloat64(8, h.wallMs, true);
}

export function readMediumHeader(src: Uint8Array, off = 0): MediumHeader {
  const dv = new DataView(src.buffer, src.byteOffset + off, MEDIUM_HEADER_BYTES);
  return {
    kind: dv.getUint32(0, true),
    generation: dv.getInt32(4, true),
    wallMs: dv.getFloat64(8, true),
  };
}

// ---- alloc helpers (worker / test side; the producer fills in place) --------

export function encodeAnchorRecord(h: AnchorHeader, codec: Uint8Array): Uint8Array {
  const out = new Uint8Array(ANCHOR_HEADER_BYTES + codec.length);
  writeAnchorHeader(out, 0, h);
  out.set(codec, ANCHOR_HEADER_BYTES);
  return out;
}

export function encodeMediumRecord(h: MediumHeader, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(MEDIUM_HEADER_BYTES + bytes.length);
  writeMediumHeader(out, 0, h);
  out.set(bytes, MEDIUM_HEADER_BYTES);
  return out;
}

/** The codec/medium body of a record (a subarray view past the header). */
export function anchorBody(rec: Uint8Array): Uint8Array { return rec.subarray(ANCHOR_HEADER_BYTES); }
export function mediumBody(rec: Uint8Array): Uint8Array { return rec.subarray(MEDIUM_HEADER_BYTES); }

// ---- cart medium bundle -----------------------------------------------------
// The cart medium carries TWO restore inputs: the constant original .crt bytes
// (cartBytes) and the mutable flash image (cartFlash, may be empty). They ride
// ONE medium record (keyed by writableGeneration) so restore gets both together.
// Layout: [u32 romLen][rom bytes][u32 flashLen][flash bytes].

export function encodeCartMedium(rom: Uint8Array, flash: Uint8Array | null): Uint8Array {
  const flashLen = flash ? flash.length : 0;
  const out = new Uint8Array(4 + rom.length + 4 + flashLen);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, rom.length, true);
  out.set(rom, 4);
  dv.setUint32(4 + rom.length, flashLen, true);
  if (flash && flashLen > 0) out.set(flash, 8 + rom.length);
  return out;
}

export function decodeCartMedium(bytes: Uint8Array): { rom: Uint8Array; flash: Uint8Array | null } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const romLen = dv.getUint32(0, true);
  const rom = bytes.slice(4, 4 + romLen);
  const flashLen = dv.getUint32(4 + romLen, true);
  const flash = flashLen > 0 ? bytes.slice(8 + romLen, 8 + romLen + flashLen) : null;
  return { rom, flash };
}
