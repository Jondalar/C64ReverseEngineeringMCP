// Minimal PNG encoder: emits an 8-bit RGBA PNG using uncompressed
// (BTYPE=00) deflate inside a zlib wrapper. Hand-rolled so we don't
// pull in a binary native dep. Adequate for the small previews the
// graphics-render tool produces.

import { deflateRawSync } from "node:zlib";

const PNG_MAGIC = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    a = (a + bytes[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function writeUInt32BE(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  buf[0] = (value >>> 24) & 0xff;
  buf[1] = (value >>> 16) & 0xff;
  buf[2] = (value >>> 8) & 0xff;
  buf[3] = value & 0xff;
  return buf;
}

function chunk(type: string, payload: Uint8Array): Uint8Array {
  const length = writeUInt32BE(payload.length);
  const typeBytes = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) typeBytes[i] = type.charCodeAt(i);
  const crcInput = new Uint8Array(typeBytes.length + payload.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(payload, typeBytes.length);
  const crc = writeUInt32BE(crc32(crcInput));
  const out = new Uint8Array(length.length + typeBytes.length + payload.length + crc.length);
  out.set(length, 0);
  out.set(typeBytes, 4);
  out.set(payload, 8);
  out.set(crc, 8 + payload.length);
  return out;
}

function buildIHDR(width: number, height: number): Uint8Array {
  const payload = new Uint8Array(13);
  payload.set(writeUInt32BE(width), 0);
  payload.set(writeUInt32BE(height), 4);
  payload[8] = 8;     // bit depth
  payload[9] = 6;     // colour type: RGBA
  payload[10] = 0;    // compression
  payload[11] = 0;    // filter
  payload[12] = 0;    // interlace
  return payload;
}

function buildFilteredScanlines(rgba: Uint8Array, width: number, height: number): Uint8Array {
  // Use filter type 0 (None) on every scanline. Simple and produces an
  // image roughly the same size as raw RGBA which is fine for previews.
  const stride = width * 4;
  const out = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    out[y * (stride + 1)] = 0;
    out.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return out;
}

function buildIDAT(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const filtered = buildFilteredScanlines(rgba, width, height);
  // zlib wrapper around raw deflate.
  const deflated = deflateRawSync(filtered);
  const cmf = 0x78; // CINFO=7 (32 KB window), CM=8 (deflate)
  const flg = 0x9c; // FCHECK chosen so (cmf<<8|flg) % 31 == 0
  const adler = adler32(filtered);
  const out = new Uint8Array(2 + deflated.length + 4);
  out[0] = cmf;
  out[1] = flg;
  out.set(deflated, 2);
  out.set(writeUInt32BE(adler), 2 + deflated.length);
  return out;
}

export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodePng: pixel buffer length ${rgba.length} does not match ${width}x${height} RGBA.`);
  }
  const ihdr = chunk("IHDR", buildIHDR(width, height));
  const idat = chunk("IDAT", buildIDAT(rgba, width, height));
  const iend = chunk("IEND", new Uint8Array(0));
  const total = PNG_MAGIC.length + ihdr.length + idat.length + iend.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  out.set(PNG_MAGIC, cursor); cursor += PNG_MAGIC.length;
  out.set(ihdr, cursor); cursor += ihdr.length;
  out.set(idat, cursor); cursor += idat.length;
  out.set(iend, cursor);
  return out;
}
