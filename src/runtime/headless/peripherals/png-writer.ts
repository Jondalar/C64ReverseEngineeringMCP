// Minimal PNG writer for VIC framebuffer dumps (Spec 065 Phase 65f).
// No external deps — uses Node's built-in zlib for IDAT compression.

import { deflateSync } from "node:zlib";

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]!;
    for (let k = 0; k < 8; k++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(8 + data.length + 4);
  // Length (big-endian)
  out[0] = (data.length >>> 24) & 0xff;
  out[1] = (data.length >>> 16) & 0xff;
  out[2] = (data.length >>> 8) & 0xff;
  out[3] = data.length & 0xff;
  out.set(typeBytes, 4);
  out.set(data, 8);
  // CRC over type + data
  const crcSrc = new Uint8Array(typeBytes.length + data.length);
  crcSrc.set(typeBytes, 0);
  crcSrc.set(data, typeBytes.length);
  const crc = crc32(crcSrc);
  out[8 + data.length] = (crc >>> 24) & 0xff;
  out[8 + data.length + 1] = (crc >>> 16) & 0xff;
  out[8 + data.length + 2] = (crc >>> 8) & 0xff;
  out[8 + data.length + 3] = crc & 0xff;
  return out;
}

export function rgbaToPng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  // PNG signature
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // IHDR
  const ihdr = new Uint8Array(13);
  ihdr[0] = (width >>> 24) & 0xff; ihdr[1] = (width >>> 16) & 0xff;
  ihdr[2] = (width >>> 8) & 0xff; ihdr[3] = width & 0xff;
  ihdr[4] = (height >>> 24) & 0xff; ihdr[5] = (height >>> 16) & 0xff;
  ihdr[6] = (height >>> 8) & 0xff; ihdr[7] = height & 0xff;
  ihdr[8] = 8;     // bit depth
  ihdr[9] = 6;     // color type RGBA
  ihdr[10] = 0;    // compression
  ihdr[11] = 0;    // filter
  ihdr[12] = 0;    // interlace
  // IDAT — apply per-scanline filter byte (0 = none) then deflate
  const stride = width * 4;
  const filtered = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    filtered[y * (stride + 1)] = 0;
    filtered.set(rgba.slice(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const compressed = deflateSync(Buffer.from(filtered.buffer, filtered.byteOffset, filtered.byteLength));
  const idat = new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength);
  const iend = new Uint8Array(0);
  const ihdrChunk = chunk("IHDR", ihdr);
  const idatChunk = chunk("IDAT", idat);
  const iendChunk = chunk("IEND", iend);
  const total = sig.length + ihdrChunk.length + idatChunk.length + iendChunk.length;
  const out = new Uint8Array(total);
  let off = 0;
  out.set(sig, off); off += sig.length;
  out.set(ihdrChunk, off); off += ihdrChunk.length;
  out.set(idatChunk, off); off += idatChunk.length;
  out.set(iendChunk, off);
  return out;
}
