// BWC raw chunk format (uncompressed payload).
//
// Layout:
//   off 0   dest_lo
//   off 1   dest_hi
//   off 2   skip       — read but unused (round-trip preserves it)
//   off 3   length_pages — copy length_pages * 256 bytes
//   off 4..  body       — length_pages * 256 bytes copied verbatim
//
// The engine dispatches between bitstream and raw via the first 2 bytes:
// "70 75" → bitstream; otherwise raw. So a raw payload that happens to
// start with $70 $75 would be misinterpreted; the packer rejects such
// inputs unless the caller forces it.

export interface BwcRawHeader {
  dest: number;
  skip: number;
  lengthPages: number;
}

export interface BwcRawChunk {
  header: BwcRawHeader;
  body: Uint8Array;
}

export class BwcRawError extends Error {}

export function parseRaw(buffer: Uint8Array, offset = 0): BwcRawChunk {
  if (offset + 4 > buffer.length) {
    throw new BwcRawError(`buffer too short for raw header at offset $${offset.toString(16)}`);
  }
  const destLo = buffer[offset]!;
  const destHi = buffer[offset + 1]!;
  const skip = buffer[offset + 2]!;
  const lengthPages = buffer[offset + 3]!;
  const bodyLen = lengthPages * 256;
  const bodyStart = offset + 4;
  if (bodyStart + bodyLen > buffer.length) {
    throw new BwcRawError(
      `buffer too short for raw body: need ${bodyLen} bytes from offset $${bodyStart.toString(16)}, have ${buffer.length - bodyStart}`,
    );
  }
  return {
    header: { dest: destLo | (destHi << 8), skip, lengthPages },
    body: buffer.slice(bodyStart, bodyStart + bodyLen),
  };
}

export interface PackRawOptions {
  dest: number;
  skipByte?: number; // default 0
}

export function packRaw(input: Uint8Array, opts: PackRawOptions): Uint8Array {
  // Refuse a body that starts with "pu" magic — the engine would route it
  // to the bitstream path. Caller must promote to bitstream or pad first.
  if (input.length >= 2 && input[0] === 0x70 && input[1] === 0x75) {
    throw new BwcRawError(
      `input starts with 'pu' magic ($70 $75); engine would dispatch as bitstream. Pad or use bitstream packer.`,
    );
  }
  // Pad body to a multiple of 256 bytes (engine copies whole pages).
  const pages = Math.ceil(input.length / 256);
  const bodyLen = pages * 256;
  const out = new Uint8Array(4 + bodyLen);
  out[0] = opts.dest & 0xff;
  out[1] = (opts.dest >> 8) & 0xff;
  out[2] = (opts.skipByte ?? 0) & 0xff;
  out[3] = pages & 0xff;
  out.set(input, 4);
  // Tail bytes already zero-initialized by Uint8Array.
  return out;
}

// Dispatch on the engine's discriminator: bytes 0..1 == "pu" → bitstream,
// otherwise raw. Mirrors the test at engine $0D79.
export function isBitstreamMagic(buffer: Uint8Array, offset = 0): boolean {
  return buffer.length > offset + 1 && buffer[offset] === 0x70 && buffer[offset + 1] === 0x75;
}
