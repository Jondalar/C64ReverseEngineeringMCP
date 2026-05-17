// Spec 611 phase 611.7a — VICE GCR codec port.
//
// VICE source: src/gcr.c + src/gcr.h (verbatim port; 357 LOC C → TS).
// CBMDOS errors: src/cbmdos.h:105-117.
//
// Function-for-function port, including:
//   - GCR_conv_data[16]              (4-bit nybble → 5-bit GCR)
//   - From_GCR_conv_data[32]         (5-bit GCR → 4-bit nybble)
//   - gcr_convert_4bytes_to_GCR()    (4 bytes → 5 GCR bytes)
//   - gcr_convert_GCR_to_4bytes()    (5 GCR bytes → 4 bytes)
//   - gcr_convert_sector_to_GCR()    (full sector encode: sync+header+gap+sync+data+ck)
//   - gcr_find_sync()
//   - gcr_decode_block()
//   - gcr_find_sector_header()
//   - gcr_read_sector()
//   - gcr_write_sector()
//   - gcr_create_image() / gcr_destroy_image()

/** VICE gcr.h:38 — Number of bytes in one raw track for D64/D71. */
export const NUM_MAX_BYTES_TRACK = 7928;
/** VICE gcr.h:42 — Track buffer size (G64 16-bit length field). */
export const NUM_MAX_MEM_BYTES_TRACK = 65536;
/** VICE gcr.h:45 — Tracks emulated: 84 for 1541, 168 for 1571. */
export const MAX_GCR_TRACKS = 168;
/** VICE gcr.h:49 — Sector GCR size with header (no SYNC, no gap). */
export const SECTOR_GCR_SIZE_WITH_HEADER = 335;

/** VICE cbmdos.h:105-117 — FDC error enum. */
export const CBMDOS_FDC_ERR_OK = 1;
export const CBMDOS_FDC_ERR_HEADER = 2;
export const CBMDOS_FDC_ERR_SYNC = 3;
export const CBMDOS_FDC_ERR_NOBLOCK = 4;
export const CBMDOS_FDC_ERR_DCHECK = 5;
export const CBMDOS_FDC_ERR_VERIFY = 7;
export const CBMDOS_FDC_ERR_WPROT = 8;
export const CBMDOS_FDC_ERR_HCHECK = 9;
export const CBMDOS_FDC_ERR_BLENGTH = 10;
export const CBMDOS_FDC_ERR_ID = 11;
export const CBMDOS_FDC_ERR_FSPEED = 12;
export const CBMDOS_FDC_ERR_DRIVE = 15;
export const CBMDOS_FDC_ERR_DECODE = 16;

/** VICE gcr.h:51-54. */
export interface DiskTrack {
  data: Uint8Array | null;
  size: number;
}

/** VICE gcr.h:56-59. */
export interface GcrImage {
  /** length = MAX_GCR_TRACKS */
  tracks: DiskTrack[];
}

/** VICE gcr.h:61-63. */
export interface GcrHeader {
  sector: number;
  track: number;
  id2: number;
  id1: number;
}

/** VICE gcr.c:51-57 — 4-bit nybble → 5-bit GCR code. */
export const GCR_conv_data: readonly number[] = [
  0x0a, 0x0b, 0x12, 0x13,
  0x0e, 0x0f, 0x16, 0x17,
  0x09, 0x19, 0x1a, 0x1b,
  0x0d, 0x1d, 0x1e, 0x15,
];

/** VICE gcr.c:59-65 — 5-bit GCR code → 4-bit nybble (0 = invalid). */
export const From_GCR_conv_data: readonly number[] = [
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 8, 0, 1, 0, 12, 4, 5,
  0, 0, 2, 3, 0, 15, 6, 7,
  0, 9, 10, 11, 0, 13, 14, 0,
];

/** VICE gcr.c:68-85 — gcr_convert_4bytes_to_GCR(). */
export function gcr_convert_4bytes_to_GCR(
  source: Uint8Array,
  sourceOff: number,
  dest: Uint8Array,
  destOff: number,
): void {
  let tdest = 0; // at least 16 bits
  let s = sourceOff;
  let d = destOff;
  for (let i = 2; i < 10; i += 2, s++, d++) {
    tdest = (tdest << 5) & 0xffffffff;
    tdest |= GCR_conv_data[(source[s]! >> 4) & 0x0f]!;
    tdest = (tdest << 5) & 0xffffffff;
    tdest |= GCR_conv_data[source[s]! & 0x0f]!;
    dest[d] = (tdest >> i) & 0xff;
  }
  dest[d] = tdest & 0xff;
}

/** VICE gcr.c:87-110 — gcr_convert_GCR_to_4bytes(). */
export function gcr_convert_GCR_to_4bytes(
  source: Uint8Array,
  sourceOff: number,
  dest: Uint8Array,
  destOff: number,
): void {
  // at least 24 bits for shifting into bits 16..20.
  let tdest = source[sourceOff]! >>> 0;
  tdest <<= 13;
  let s = sourceOff;
  let d = destOff;
  for (let i = 5; i < 13; i += 2, d++) {
    s++;
    tdest |= ((source[s]! >>> 0) << i);
    dest[d] = (From_GCR_conv_data[(tdest >>> 16) & 0x1f]! << 4) & 0xff;
    tdest = (tdest << 5) >>> 0;
    dest[d] = (dest[d]! | From_GCR_conv_data[(tdest >>> 16) & 0x1f]!) & 0xff;
    tdest = (tdest << 5) >>> 0;
  }
}

/** VICE gcr.c:112-168 — gcr_convert_sector_to_GCR(). */
export function gcr_convert_sector_to_GCR(
  buffer: Uint8Array,
  bufferOff: number,
  data: Uint8Array,
  dataOff: number,
  header: GcrHeader,
  gap: number,
  sync: number,
  error_code: number = CBMDOS_FDC_ERR_OK,
): void {
  const buf = new Uint8Array(4);
  let chksum: number, idm: number;
  let d = dataOff;
  let b = bufferOff;

  idm = error_code === CBMDOS_FDC_ERR_ID ? 0xff : 0x00;

  // Sync (5 bytes): 0x55 if SYNC error, else 0xff
  for (let i = 0; i < 5; i++) {
    data[d + i] = error_code === CBMDOS_FDC_ERR_SYNC ? 0x55 : 0xff;
  }
  d += 5;

  chksum = error_code === CBMDOS_FDC_ERR_HCHECK ? 0xff : 0x00;
  chksum ^= (header.sector ^ header.track ^ header.id2 ^ header.id1 ^ idm) & 0xff;
  buf[0] = error_code === CBMDOS_FDC_ERR_HEADER ? 0xff : 0x08;
  buf[1] = chksum;
  buf[2] = header.sector;
  buf[3] = header.track;
  gcr_convert_4bytes_to_GCR(buf, 0, data, d);
  d += 5;

  buf[0] = header.id2;
  buf[1] = (header.id1 ^ idm) & 0xff;
  buf[2] = 0x0f;
  buf[3] = 0x0f;
  gcr_convert_4bytes_to_GCR(buf, 0, data, d);
  d += 5;

  d += gap; // Gap

  // Sync (sync bytes)
  for (let i = 0; i < sync; i++) {
    data[d + i] = error_code === CBMDOS_FDC_ERR_SYNC ? 0x55 : 0xff;
  }
  d += sync;

  chksum = error_code === CBMDOS_FDC_ERR_DCHECK ? 0xff : 0x00;
  buf[0] = error_code === CBMDOS_FDC_ERR_NOBLOCK ? 0x00 : 0x07;
  buf[1] = buffer[b]!;
  buf[2] = buffer[b + 1]!;
  buf[3] = buffer[b + 2]!;
  chksum ^= (buffer[b]! ^ buffer[b + 1]! ^ buffer[b + 2]!) & 0xff;
  gcr_convert_4bytes_to_GCR(buf, 0, data, d);
  b += 3;
  d += 5;

  for (let i = 0; i < 63; i++) {
    chksum ^= (buffer[b]! ^ buffer[b + 1]! ^ buffer[b + 2]! ^ buffer[b + 3]!) & 0xff;
    gcr_convert_4bytes_to_GCR(buffer, b, data, d);
    b += 4;
    d += 5;
  }

  buf[0] = buffer[b]!;
  buf[1] = (chksum ^ buffer[b]!) & 0xff;
  buf[2] = 0;
  buf[3] = 0;
  gcr_convert_4bytes_to_GCR(buf, 0, data, d);
}

/** VICE gcr.c:170-203 — gcr_find_sync(). Returns bit position or
 *  negative CBMDOS error code. */
export function gcr_find_sync(raw: DiskTrack, p: number, s: number): number {
  if (!raw.data || !raw.size) return -CBMDOS_FDC_ERR_SYNC;
  const data = raw.data;
  let w = 0;
  let b = (data[p >> 3]! << (p & 7)) & 0xffff;
  while (s-- > 0) {
    if (b & 0x80) {
      w = ((w << 1) | 1) & 0xffff;
    } else {
      if ((~w) & 0x3ff) {
        w = (w << 1) & 0xffff;
      } else {
        return p;
      }
    }
    if ((~p) & 7) {
      p++;
      b = (b << 1) & 0xffff;
    } else {
      p++;
      if (p >= raw.size * 8) p = 0;
      b = data[p >> 3]!;
    }
  }
  return -CBMDOS_FDC_ERR_SYNC;
}

/** VICE gcr.c:205-232 — gcr_decode_block(). Decode `num` 4-byte blocks
 *  into buf starting at raw bit position p. */
export function gcr_decode_block(raw: DiskTrack, p: number, buf: Uint8Array, num: number): void {
  if (!raw.data) return;
  const data = raw.data;
  const end = raw.size;
  const shift = p & 7;
  let offset = p >> 3;
  const gcr = new Uint8Array(5);
  let b = (data[offset]! << shift) & 0xffff;
  let bufOff = 0;
  for (let i = 0; i < num; i++, bufOff += 4) {
    for (let j = 0; j < 5; j++) {
      offset++;
      if (offset >= end) offset = 0;
      if (shift) {
        gcr[j] = (b | ((data[offset]! << shift) >> 8)) & 0xff;
        b = (data[offset]! << shift) & 0xffff;
      } else {
        gcr[j] = b & 0xff;
        b = data[offset]!;
      }
    }
    gcr_convert_GCR_to_4bytes(gcr, 0, buf, bufOff);
  }
}

/** VICE gcr.c:234-261 — gcr_find_sector_header(). */
export function gcr_find_sector_header(raw: DiskTrack, sector: number): number {
  const header = new Uint8Array(4);
  let p = 0;
  let p2 = -CBMDOS_FDC_ERR_SYNC;
  for (;;) {
    p = gcr_find_sync(raw, p, raw.size * 8);
    if (p2 === p) break;
    if (p2 < 0) p2 = p;
    gcr_decode_block(raw, p, header, 1);
    if (header[0] === 0x08 && header[2] === sector) {
      return p;
    }
  }
  if (p2 < 0) return p2;
  return -CBMDOS_FDC_ERR_HEADER;
}

/** VICE gcr.c:263-292 — gcr_read_sector(). Returns 256-byte sector data
 *  + CBMDOS_FDC_ERR_OK / DCHECK / NOBLOCK / HEADER / SYNC code via
 *  returned object. */
export function gcr_read_sector(
  raw: DiskTrack,
  data: Uint8Array,
  sector: number,
): number {
  const buffer = new Uint8Array(260);
  let p = gcr_find_sector_header(raw, sector);
  if (p < 0) return -p;
  p = gcr_find_sync(raw, p, 500 * 8);
  if (p < 0) return -p;
  gcr_decode_block(raw, p, buffer, 65);
  let b = buffer[257]!;
  for (let i = 0; i < 256; i++) {
    data[i] = buffer[i + 1]!;
    b ^= data[i]!;
  }
  if (buffer[0] !== 0x07) return CBMDOS_FDC_ERR_NOBLOCK;
  return b ? CBMDOS_FDC_ERR_DCHECK : CBMDOS_FDC_ERR_OK;
}

/** VICE gcr.c:294-346 — gcr_write_sector(). */
export function gcr_write_sector(
  raw: DiskTrack,
  data: Uint8Array,
  sector: number,
): number {
  if (!raw.data) return CBMDOS_FDC_ERR_DRIVE;
  const rdata = raw.data;
  const buffer = new Uint8Array(260);
  const gcr = new Uint8Array(5);
  let chksum: number, b: number;
  let p = gcr_find_sector_header(raw, sector);
  if (p < 0) return -p;
  p = gcr_find_sync(raw, p, 500 * 8);
  if (p < 0) return -p;
  const shift = p & 7;
  let offset = p >> 3;
  const end = raw.size;
  b = rdata[offset]! & ((0xff00 >> shift) & 0xff);
  buffer[0] = 0x07;
  for (let i = 0; i < 256; i++) buffer[i + 1] = data[i]!;
  chksum = buffer[1]!;
  for (let i = 2; i < 257; i++) chksum ^= buffer[i]!;
  buffer[257] = chksum;
  buffer[258] = 0;
  buffer[259] = 0;
  let buf = 0;
  for (let i = 0; i < 65; i++) {
    gcr_convert_4bytes_to_GCR(buffer, buf, gcr, 0);
    buf += 4;
    for (let j = 0; j < 5; j++) {
      if (shift) {
        rdata[offset] = (b | (gcr[j]! >> shift)) & 0xff;
        b = ((gcr[j]! << 8) >> shift) & 0xff;
      } else {
        rdata[offset] = gcr[j]!;
      }
      offset++;
      if (offset >= end) offset = 0;
    }
  }
  rdata[offset] = (b | (rdata[offset]! & ((0xff >> shift) & 0xff))) & 0xff;
  return CBMDOS_FDC_ERR_OK;
}

/** VICE gcr.c:348-351. */
export function gcr_create_image(): GcrImage {
  const tracks: DiskTrack[] = [];
  for (let i = 0; i < MAX_GCR_TRACKS; i++) tracks.push({ data: null, size: 0 });
  return { tracks };
}

/** VICE gcr.c:353-357. */
export function gcr_destroy_image(_gcr: GcrImage): void {
  // GC handles allocation.
}
