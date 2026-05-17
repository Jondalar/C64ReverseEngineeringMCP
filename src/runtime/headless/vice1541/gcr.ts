// PORT OF: vice/src/gcr.c (full file)
// Header:  vice/src/gcr.h
// Spec:    specs/612-1541-port-fidelity-rules.md §1 NL, §2 PL, §5 FM-block
//
// VICE GCR codec. One C file → one TS file (NL-1). One C function → one TS
// function with verbatim snake_case name (NL-2). One C struct → one TS
// interface (NL-3); interfaces (`disk_track_t`, `gcr_t`, `gcr_header_t`) and
// the `NUM_MAX_*` / `MAX_GCR_TRACKS` / `SECTOR_GCR_SIZE_WITH_HEADER`
// constants live in `drivetypes.ts` per the FM table and are imported here.
//
// CBMDOS FDC error codes mirror `vice/src/cbmdos.h:105-117` and are kept in
// this file because gcr.c is the only consumer in the layer-2 port surface.
//
// Translation notes (do not introduce new abstractions per PL-3/PL-5):
//   - VICE uses raw `uint8_t *` pointer arithmetic for `source`, `dest`,
//     `buffer`, `data`. TS gets explicit `<name>Off: number` offset
//     parameters on the codec helpers. This is the minimum mechanical
//     translation of C pointer math, not an invented helper.
//   - `register` / `static const` arrays become module-level `const`
//     `Uint8Array` (NL-5).

import type { disk_track_t, gcr_t, gcr_header_t } from "./drivetypes.js";
import { MAX_GCR_TRACKS } from "./drivetypes.js";

// -----------------------------------------------------------------------------
// CBMDOS FDC error codes — mirror of vice/src/cbmdos.h:105-117
// -----------------------------------------------------------------------------

/** PORT OF: vice/src/cbmdos.h:105 */
export const CBMDOS_FDC_ERR_OK = 1;
/** PORT OF: vice/src/cbmdos.h:106 */
export const CBMDOS_FDC_ERR_HEADER = 2;
/** PORT OF: vice/src/cbmdos.h:107 */
export const CBMDOS_FDC_ERR_SYNC = 3;
/** PORT OF: vice/src/cbmdos.h:108 */
export const CBMDOS_FDC_ERR_NOBLOCK = 4;
/** PORT OF: vice/src/cbmdos.h:109 */
export const CBMDOS_FDC_ERR_DCHECK = 5;
/** PORT OF: vice/src/cbmdos.h:110 */
export const CBMDOS_FDC_ERR_VERIFY = 7;
/** PORT OF: vice/src/cbmdos.h:111 */
export const CBMDOS_FDC_ERR_WPROT = 8;
/** PORT OF: vice/src/cbmdos.h:112 */
export const CBMDOS_FDC_ERR_HCHECK = 9;
/** PORT OF: vice/src/cbmdos.h:113 */
export const CBMDOS_FDC_ERR_BLENGTH = 10;
/** PORT OF: vice/src/cbmdos.h:114 */
export const CBMDOS_FDC_ERR_ID = 11;
/** PORT OF: vice/src/cbmdos.h:115 */
export const CBMDOS_FDC_ERR_FSPEED = 12;
/** PORT OF: vice/src/cbmdos.h:116 */
export const CBMDOS_FDC_ERR_DRIVE = 15;
/** PORT OF: vice/src/cbmdos.h:117 */
export const CBMDOS_FDC_ERR_DECODE = 16;

// -----------------------------------------------------------------------------
// Module-level GCR conversion tables (NL-5)
// -----------------------------------------------------------------------------

/** PORT OF: vice/src/gcr.c:51-57 (GCR_conv_data) — 4-bit nybble → 5-bit GCR. */
export const GCR_conv_data: Readonly<Uint8Array> = new Uint8Array([
  0x0a, 0x0b, 0x12, 0x13,
  0x0e, 0x0f, 0x16, 0x17,
  0x09, 0x19, 0x1a, 0x1b,
  0x0d, 0x1d, 0x1e, 0x15,
]);

/** PORT OF: vice/src/gcr.c:59-65 (From_GCR_conv_data) — 5-bit GCR → 4-bit
 *  nybble (0 = invalid). */
export const From_GCR_conv_data: Readonly<Uint8Array> = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 8, 0, 1, 0, 12, 4, 5,
  0, 0, 2, 3, 0, 15, 6, 7,
  0, 9, 10, 11, 0, 13, 14, 0,
]);

// -----------------------------------------------------------------------------
// Codec helpers — VICE static functions, ported per NL-2 (verbatim names).
// Exported because TS has no file-private linkage equivalent that preserves
// grep parity for cross-file callers (fsimage_*.ts in later layers will need
// these). Marking them `export` does not change VICE semantics.
// -----------------------------------------------------------------------------

// PORT OF: vice/src/gcr.c:68-85 (gcr_convert_4bytes_to_GCR)
export function gcr_convert_4bytes_to_GCR(
  source: Uint8Array,
  source_off: number,
  dest: Uint8Array,
  dest_off: number,
): void {
  let tdest = 0; // at least 16 bits for overflow shifting
  let s = source_off;
  let d = dest_off;
  for (let i = 2; i < 10; i += 2, s++, d++) {
    tdest = (tdest << 5) & 0xffff;        // make room for upper nybble
    tdest |= GCR_conv_data[(source[s]! >> 4) & 0x0f]!;
    tdest = (tdest << 5) & 0xffff;        // make room for lower nybble
    tdest |= GCR_conv_data[source[s]! & 0x0f]!;
    dest[d] = (tdest >> i) & 0xff;
  }
  dest[d] = tdest & 0xff;
}

// PORT OF: vice/src/gcr.c:87-110 (gcr_convert_GCR_to_4bytes)
export function gcr_convert_GCR_to_4bytes(
  source: Uint8Array,
  source_off: number,
  dest: Uint8Array,
  dest_off: number,
): void {
  // at least 24 bits for shifting into bits 16..20
  let tdest = source[source_off]! >>> 0;
  tdest = (tdest << 13) >>> 0;
  let s = source_off;
  let d = dest_off;
  for (let i = 5; i < 13; i += 2, d++) {
    s++;
    tdest = (tdest | ((source[s]! >>> 0) << i)) >>> 0;
    // "tdest >> 16" could be optimized to a word-aligned access
    dest[d] = (From_GCR_conv_data[(tdest >>> 16) & 0x1f]! << 4) & 0xff;
    tdest = (tdest << 5) >>> 0;
    dest[d] = (dest[d]! | From_GCR_conv_data[(tdest >>> 16) & 0x1f]!) & 0xff;
    tdest = (tdest << 5) >>> 0;
  }
}

// PORT OF: vice/src/gcr.c:112-168 (gcr_convert_sector_to_GCR)
export function gcr_convert_sector_to_GCR(
  buffer: Uint8Array,
  buffer_off: number,
  data: Uint8Array,
  data_off: number,
  header: gcr_header_t,
  gap: number,
  sync: number,
  error_code: number,
): void {
  const buf = new Uint8Array(4);
  let chksum: number;
  const idm = error_code === CBMDOS_FDC_ERR_ID ? 0xff : 0x00;
  let d = data_off;
  let b = buffer_off;

  // Sync
  const syncFill = error_code === CBMDOS_FDC_ERR_SYNC ? 0x55 : 0xff;
  for (let i = 0; i < 5; i++) data[d + i] = syncFill;
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

  d += gap;                              // Gap

  // Sync
  for (let i = 0; i < sync; i++) data[d + i] = syncFill;
  d += sync;

  chksum = error_code === CBMDOS_FDC_ERR_DCHECK ? 0xff : 0x00;
  // note: error 4 (CBMDOS_FDC_ERR_NOBLOCK) is considered a "soft error",
  //       meaning the data is still available. because of that, we must use
  //       a value (incase of error) here that in GCR will have its leftmost
  //       bit 0, or else it will be taken as part of the SYNC and the framing
  //       will break (and the data mess up).
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

// PORT OF: vice/src/gcr.c:170-203 (gcr_find_sync)
export function gcr_find_sync(raw: disk_track_t, p: number, s: number): number {
  if (!raw.data || !raw.size) {
    return -CBMDOS_FDC_ERR_SYNC;
  }
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
      if (p >= raw.size * 8) {
        p = 0;
      }
      b = data[p >> 3]!;
    }
  }
  return -CBMDOS_FDC_ERR_SYNC;
}

// PORT OF: vice/src/gcr.c:205-232 (gcr_decode_block)
export function gcr_decode_block(
  raw: disk_track_t,
  p: number,
  buf: Uint8Array,
  num: number,
): void {
  if (!raw.data) return;
  const data = raw.data;
  const end = raw.size;
  const shift = p & 7;
  let offset = p >> 3;
  const gcr = new Uint8Array(5);
  let b = (data[offset]! << shift) & 0xffff;
  let bufOff = 0;
  for (let i = 0; i < num; i++, bufOff += 4) {
    // get 5 bytes of gcr data
    for (let j = 0; j < 5; j++) {
      offset++;
      if (offset >= end) {
        offset = 0;
      }
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

// PORT OF: vice/src/gcr.c:234-261 (gcr_find_sector_header)
export function gcr_find_sector_header(raw: disk_track_t, sector: number): number {
  const header = new Uint8Array(4);
  let p = 0;
  let p2 = -CBMDOS_FDC_ERR_SYNC;
  for (;;) {
    p = gcr_find_sync(raw, p, raw.size * 8);
    if (p2 === p) {
      break;
    }
    if (p2 < 0) {
      p2 = p;
    }
    gcr_decode_block(raw, p, header, 1);
    if (header[0] === 0x08 && header[2] === sector) {
      // Track, checksum or ID's are not checked here
      return p;
    }
  }
  if (p2 < 0) {
    return p2;
  }
  return -CBMDOS_FDC_ERR_HEADER;
}

// PORT OF: vice/src/gcr.c:263-292 (gcr_read_sector)
export function gcr_read_sector(
  raw: disk_track_t,
  data: Uint8Array,
  sector: number,
): number {
  const buffer = new Uint8Array(260);
  let b: number;
  let i: number;
  let p: number;

  p = gcr_find_sector_header(raw, sector);
  if (p < 0) {
    return -p;
  }

  p = gcr_find_sync(raw, p, 500 * 8);
  if (p < 0) {
    return -p;
  }

  gcr_decode_block(raw, p, buffer, 65);

  b = buffer[257]!;
  for (i = 0; i < 256; i++) {
    data[i] = buffer[i + 1]!;
    b ^= data[i]!;
  }

  if (buffer[0] !== 0x07) {
    return CBMDOS_FDC_ERR_NOBLOCK;
  }

  return b ? CBMDOS_FDC_ERR_DCHECK : CBMDOS_FDC_ERR_OK;
}

// PORT OF: vice/src/gcr.c:294-346 (gcr_write_sector)
export function gcr_write_sector(
  raw: disk_track_t,
  data: Uint8Array,
  sector: number,
): number {
  if (!raw.data) {
    return CBMDOS_FDC_ERR_DRIVE;
  }
  const rdata = raw.data;
  const buffer = new Uint8Array(260);
  const gcr = new Uint8Array(5);
  let chksum: number;
  let b: number;
  let i: number;
  let j: number;
  let shift: number;
  let p: number;

  p = gcr_find_sector_header(raw, sector);
  if (p < 0) {
    return -p;
  }

  p = gcr_find_sync(raw, p, 500 * 8);
  if (p < 0) {
    return -p;
  }

  shift = p & 7;
  let offset = p >> 3;
  const end = raw.size;

  b = rdata[offset]! & ((0xff00 >> shift) & 0xff);

  buffer[0] = 0x07;
  for (i = 0; i < 256; i++) buffer[i + 1] = data[i]!;
  chksum = buffer[1]!;
  for (i = 2; i < 257; i++) {
    chksum ^= buffer[i]!;
  }
  buffer[257] = chksum;
  buffer[258] = 0;
  buffer[259] = 0;

  let buf = 0;

  for (i = 0; i < 65; i++) {
    gcr_convert_4bytes_to_GCR(buffer, buf, gcr, 0);
    buf += 4;
    for (j = 0; j < 5; j++) {
      if (shift) {
        rdata[offset] = (b | (gcr[j]! >> shift)) & 0xff;
        b = ((gcr[j]! << 8) >> shift) & 0xff;
      } else {
        rdata[offset] = gcr[j]!;
      }
      offset++;
      if (offset >= end) {
        offset = 0;
      }
    }
  }
  rdata[offset] = (b | (rdata[offset]! & ((0xff >> shift) & 0xff))) & 0xff;

  return CBMDOS_FDC_ERR_OK;
}

// PORT OF: vice/src/gcr.c:348-351 (gcr_create_image)
export function gcr_create_image(): gcr_t {
  const tracks: disk_track_t[] = [];
  for (let i = 0; i < MAX_GCR_TRACKS; i++) {
    tracks.push({ data: null, size: 0 });
  }
  return { tracks };
}

// PORT OF: vice/src/gcr.c:353-357 (gcr_destroy_image)
export function gcr_destroy_image(_gcr: gcr_t): void {
  // GC handles allocation; explicit free not required.
}
