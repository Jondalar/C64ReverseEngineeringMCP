// GCR encoder for Commodore 1541. Inverse of `gcr.ts` decoder. Used to
// build synthetic G64 images for headless smoke fixtures (Spec 094 / 097).

const GCR_ENCODE: number[] = [
  0x0a, 0x0b, 0x12, 0x13, 0x0e, 0x0f, 0x16, 0x17,
  0x09, 0x19, 0x1a, 0x1b, 0x0d, 0x1d, 0x1e, 0x15,
];

export function encodeGCRNybble(nybble: number): number {
  return GCR_ENCODE[nybble & 0x0f]!;
}

// Encode 4 raw bytes (8 nybbles) into 5 GCR bytes (8 × 5 = 40 bits).
export function encodeGCRGroup(raw: Uint8Array, offset = 0): Uint8Array {
  const n0 = encodeGCRNybble(raw[offset]! >> 4);
  const n1 = encodeGCRNybble(raw[offset]!);
  const n2 = encodeGCRNybble(raw[offset + 1]! >> 4);
  const n3 = encodeGCRNybble(raw[offset + 1]!);
  const n4 = encodeGCRNybble(raw[offset + 2]! >> 4);
  const n5 = encodeGCRNybble(raw[offset + 2]!);
  const n6 = encodeGCRNybble(raw[offset + 3]! >> 4);
  const n7 = encodeGCRNybble(raw[offset + 3]!);

  const out = new Uint8Array(5);
  // 8 nybbles × 5 bits = 40 bits, packed into 5 bytes MSB-first.
  out[0] = ((n0 << 3) | (n1 >> 2)) & 0xff;
  out[1] = ((n1 << 6) | (n2 << 1) | (n3 >> 4)) & 0xff;
  out[2] = ((n3 << 4) | (n4 >> 1)) & 0xff;
  out[3] = ((n4 << 7) | (n5 << 2) | (n6 >> 3)) & 0xff;
  out[4] = ((n6 << 5) | n7) & 0xff;
  return out;
}

// Encode N raw bytes (must be multiple of 4) into N*5/4 GCR bytes.
export function encodeGCRBytes(raw: Uint8Array): Uint8Array {
  if (raw.length % 4 !== 0) {
    throw new Error(`encodeGCRBytes: length ${raw.length} must be multiple of 4`);
  }
  const out = new Uint8Array((raw.length / 4) * 5);
  for (let i = 0; i < raw.length; i += 4) {
    const grp = encodeGCRGroup(raw, i);
    out.set(grp, (i / 4) * 5);
  }
  return out;
}

// Build the 8-byte raw header block for a sector.
// Header layout per VICE / 1541 ROM: $08 H_CHK SEC TRK ID2 ID1 $0F $0F.
// Checksum = SEC ^ TRK ^ ID2 ^ ID1.
export function buildSectorHeaderRaw(track: number, sector: number, id1: number, id2: number): Uint8Array {
  const checksum = (sector ^ track ^ id2 ^ id1) & 0xff;
  return new Uint8Array([0x08, checksum, sector & 0xff, track & 0xff, id2 & 0xff, id1 & 0xff, 0x0f, 0x0f]);
}

// Build the 260-byte raw data block for a sector.
// Layout: $07 <256 data bytes> D_CHK $00 $00.
// Checksum = XOR of all 256 data bytes.
export function buildSectorDataRaw(data: Uint8Array): Uint8Array {
  if (data.length !== 256) {
    throw new Error(`buildSectorDataRaw: data must be 256 bytes, got ${data.length}`);
  }
  let checksum = 0;
  for (let i = 0; i < 256; i++) checksum ^= data[i]!;
  const out = new Uint8Array(260);
  out[0] = 0x07;
  out.set(data, 1);
  out[257] = checksum & 0xff;
  out[258] = 0x00;
  out[259] = 0x00;
  return out;
}

// Encode a full sector's GCR stream:
//   SYNC (5 × $ff) + header (10 GCR) + gap (9 × $55) +
//   SYNC (5 × $ff) + data (325 GCR) + tail gap.
// Returns: { gcr, length } where length is the byte count emitted.
export function encodeSectorGCR(
  track: number,
  sector: number,
  id1: number,
  id2: number,
  data: Uint8Array,
  tailGapBytes = 8,
): Uint8Array {
  const headerRaw = buildSectorHeaderRaw(track, sector, id1, id2);
  const dataRaw = buildSectorDataRaw(data);
  const headerGcr = encodeGCRBytes(headerRaw);   // 10 bytes
  const dataGcr = encodeGCRBytes(dataRaw);       // 325 bytes
  const SYNC = 5;
  const HDR_GAP = 9;
  const out = new Uint8Array(SYNC + 10 + HDR_GAP + SYNC + 325 + tailGapBytes);
  let p = 0;
  out.fill(0xff, p, p + SYNC); p += SYNC;
  out.set(headerGcr, p); p += 10;
  out.fill(0x55, p, p + HDR_GAP); p += HDR_GAP;
  out.fill(0xff, p, p + SYNC); p += SYNC;
  out.set(dataGcr, p); p += 325;
  out.fill(0x55, p, p + tailGapBytes); p += tailGapBytes;
  return out.slice(0, p);
}
