/**
 * GCR decoder/encoder for Commodore 1541 — Spec 430/437 read-path +
 * Spec 445 write-path literal port of VICE gcr.c.
 *
 * VICE function map (line ranges from VICE 3.7.1 src/gcr.c):
 *
 *   VICE function               Lines      TS impl                       Spec
 *   --------------------------- --------   ----------------------------- ----
 *   GCR_conv_data[16] table     51-57      GCR_ENCODE                    445 Phase 2a
 *   From_GCR_conv_data[32] tbl  59-65      GCR_DECODE                    430
 *   gcr_convert_4bytes_to_GCR   68-86      gcr_convert_4bytes_to_GCR     445 Phase 2a
 *   gcr_convert_GCR_to_4bytes   87-110     decodeGCRGroup                430
 *   gcr_convert_sector_to_GCR   112-168    — MISSING                     445 Phase 2b
 *   gcr_find_sync               170-203    gcr_find_sync (export)        430
 *                                          findSyncMarkFromBit
 *                                            (back-compat alias)
 *   gcr_decode_block            205-232    gcr_decode_block              430 (num-arg fix)
 *                                            (export)
 *   gcr_find_sector_header      234-261    gcr_find_sector_header        430
 *                                            (export)
 *   gcr_read_sector             263-292    gcr_read_sector               430
 *                                            (export)
 *   gcr_write_sector            294-346    — MISSING                     445 Phase 2b
 *
 * All read functions are bit-level (arbitrary `p & 7` bit position),
 * wrap around track end, and use the same 10-consecutive-ones sync
 * detection as VICE.
 *
 * Legacy `*LikeVice` exports are kept as `@deprecated` aliases for
 * back-compat with `g64-parser.ts` and `server-tools/disk-g64.ts`
 * during the Sprint 430 transition; new callers should use the
 * VICE-shaped names.
 */

// VICE `From_GCR_conv_data[32]` — src/gcr.c:59-65. Invalid entries are
// 0 (silent decode-as-zero) per VICE. Do NOT change to 0xff — that
// diverges from VICE's bit-for-bit byte output on corrupt GCR. Use
// `isValidGcrNybble` if a separate validity flag is needed.
const GCR_DECODE: number[] = [
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 8, 0, 1, 0, 12, 4, 5,
  0, 0, 2, 3, 0, 15, 6, 7,
  0, 9, 10, 11, 0, 13, 14, 0,
];

// VICE `GCR_conv_data[16]` — src/gcr.c:51-57. Encode table: 4-bit
// nybble → 5-bit GCR symbol.
const GCR_ENCODE: number[] = [
  0x0a, 0x0b, 0x12, 0x13,
  0x0e, 0x0f, 0x16, 0x17,
  0x09, 0x19, 0x1a, 0x1b,
  0x0d, 0x1d, 0x1e, 0x15,
];

// Valid 5-bit GCR nybble set (VICE GCR_conv_data[16] inverse). Used by
// diagnostic helpers that want to flag invalid GCR without changing the
// VICE-faithful byte output.
const VALID_GCR_NYBBLES = new Set<number>(GCR_ENCODE);

export function decodeGCRNybble(gcr5: number): number {
  return GCR_DECODE[gcr5 & 0x1f];
}

export function isValidGcrNybble(gcr5: number): boolean {
  return VALID_GCR_NYBBLES.has(gcr5 & 0x1f);
}

/**
 * Spec 445 — VICE `gcr_convert_4bytes_to_GCR` (src/gcr.c:68-86) literal.
 *
 * Encode 4 raw bytes into 5 GCR-encoded bytes:
 *   - Each input byte = 2 nybbles (high + low)
 *   - Each nybble → 5-bit GCR symbol via GCR_ENCODE table
 *   - 8 nybbles × 5 bits = 40 bits packed into 5 bytes
 *
 * VICE body (lines 73-84):
 *   for (i = 2; i < 10; i += 2, source++, dest++) {
 *     tdest <<= 5;
 *     tdest |= GCR_conv_data[(*source) >> 4];
 *     tdest <<= 5;
 *     tdest |= GCR_conv_data[(*source) & 0x0f];
 *     *dest = (uint8_t)(tdest >> i);
 *   }
 *   *dest = (uint8_t)tdest;
 *
 * Note: VICE uses `register unsigned int tdest = 0` and relies on
 * "at least 16 bits for overflow shifting". TS uses plain `number`
 * (53-bit float) which is comfortably wider.
 */
export function gcr_convert_4bytes_to_GCR(source: Uint8Array, sourceOffset: number, dest: Uint8Array, destOffset: number): void {
  let tdest = 0;
  let sp = sourceOffset;
  let dp = destOffset;
  for (let i = 2; i < 10; i += 2) {
    tdest = ((tdest << 5) | GCR_ENCODE[(source[sp]! >> 4) & 0x0f]) >>> 0;
    tdest = ((tdest << 5) | GCR_ENCODE[source[sp]! & 0x0f]) >>> 0;
    dest[dp] = (tdest >>> i) & 0xff;
    sp += 1;
    dp += 1;
  }
  dest[dp] = tdest & 0xff;
}

// ---------------------------------------------------------------------------
// Spec 449 — fdc_err_t enum migrated to canonical home in
// `src/runtime/headless/drive/fdc.ts`. The previous INTERIM block
// (Spec 445 Phase 2b) lived here; re-exported below so existing
// `src/disk/gcr.ts` consumers continue to work unchanged.
// ---------------------------------------------------------------------------

import {
  CBMDOS_FDC_ERR_OK,
  CBMDOS_FDC_ERR_HEADER,
  CBMDOS_FDC_ERR_SYNC,
  CBMDOS_FDC_ERR_NOBLOCK,
  CBMDOS_FDC_ERR_DCHECK,
  CBMDOS_FDC_ERR_VERIFY,
  CBMDOS_FDC_ERR_WPROT,
  CBMDOS_FDC_ERR_HCHECK,
  CBMDOS_FDC_ERR_BLENGTH,
  CBMDOS_FDC_ERR_ID,
  CBMDOS_FDC_ERR_FSPEED,
  CBMDOS_FDC_ERR_DRIVE,
  CBMDOS_FDC_ERR_DECODE,
  type fdc_err_t,
} from "../runtime/headless/drive/fdc.js";

export {
  CBMDOS_FDC_ERR_OK,
  CBMDOS_FDC_ERR_HEADER,
  CBMDOS_FDC_ERR_SYNC,
  CBMDOS_FDC_ERR_NOBLOCK,
  CBMDOS_FDC_ERR_DCHECK,
  CBMDOS_FDC_ERR_VERIFY,
  CBMDOS_FDC_ERR_WPROT,
  CBMDOS_FDC_ERR_HCHECK,
  CBMDOS_FDC_ERR_BLENGTH,
  CBMDOS_FDC_ERR_ID,
  CBMDOS_FDC_ERR_FSPEED,
  CBMDOS_FDC_ERR_DRIVE,
  CBMDOS_FDC_ERR_DECODE,
  type fdc_err_t,
};

/**
 * Spec 445 Phase 2b — VICE `gcr_header_t` (src/gcr.h:61-63).
 */
export interface gcr_header_t {
  sector: number;
  track: number;
  id2: number;
  id1: number;
}

/**
 * Spec 445 Phase 2c — VICE `disk_track_t` (src/gcr.h:51-54) literal.
 *
 * VICE uses an explicit track-size field; the data buffer may be
 * over-allocated up to NUM_MAX_MEM_BYTES_TRACK = 65536 (gcr.h:42).
 * Wrap-around detection uses `end = data + size`. The TS port mirrors
 * the C struct: `data` = the raw GCR byte array (possibly over-
 * allocated), `size` = the active track length used for wrap.
 */
export interface disk_track_t {
  data: Uint8Array;
  size: number;
}

/** Convenience: build a `disk_track_t` from a Uint8Array (size = length). */
export function makeDiskTrack(data: Uint8Array, size?: number): disk_track_t {
  return { data, size: size ?? data.length };
}

// ---------------------------------------------------------------------------
// Spec 445 Phase 2b — gcr_convert_sector_to_GCR (gcr.c:112-168) literal.
//
// Writes a full sector layout into `data` starting at `dataOffset`:
//   sync (5 bytes) | header GCR (5) | header-id GCR (5) | gap |
//   sync (`sync` bytes) | data block GCR (5 × 65 = 325 bytes)
//
// VICE function signature:
//   void gcr_convert_sector_to_GCR(const uint8_t *buffer,
//                                  uint8_t *data,
//                                  const gcr_header_t *header,
//                                  int gap, int sync,
//                                  fdc_err_t error_code);
//
// `buffer` = 256-byte sector data. `data` = output track buffer
// (caller-supplied, size ≥ 5 + 5 + 5 + gap + sync + 5*65). `header`
// = sector/track/id1/id2. `gap` + `sync` = byte counts. `error_code`
// selects which fault to inject (CBMDOS_FDC_ERR_*; OK = clean encode).
//
// NOTE: gap bytes are LEFT AS-IS per VICE (gcr.c:138 does
// `data += gap` without initialisation). If a specific gap fill is
// required (e.g. 0x55 sentinel), callers must pre-init the buffer
// BEFORE invoking this function.
// ---------------------------------------------------------------------------
export function gcr_convert_sector_to_GCR(
  buffer: Uint8Array,
  bufferOffset: number,
  data: Uint8Array,
  dataOffset: number,
  header: gcr_header_t,
  gap: number,
  sync: number,
  error_code: fdc_err_t,
): void {
  // VICE local declarations.
  const buf = new Uint8Array(4);
  let chksum: number;
  const idm = (error_code === CBMDOS_FDC_ERR_ID) ? 0xff : 0x00;

  let dp = dataOffset;
  let bp = bufferOffset;

  // gcr.c:120-121 — sync (5 bytes).
  const syncFill1 = (error_code === CBMDOS_FDC_ERR_SYNC) ? 0x55 : 0xff;
  for (let k = 0; k < 5; k++) data[dp + k] = syncFill1;
  dp += 5;

  // gcr.c:123-130 — header GCR (5 bytes).
  chksum = (error_code === CBMDOS_FDC_ERR_HCHECK) ? 0xff : 0x00;
  chksum ^= header.sector ^ header.track ^ header.id2 ^ header.id1 ^ idm;
  buf[0] = (error_code === CBMDOS_FDC_ERR_HEADER) ? 0xff : 0x08;
  buf[1] = chksum & 0xff;
  buf[2] = header.sector & 0xff;
  buf[3] = header.track & 0xff;
  gcr_convert_4bytes_to_GCR(buf, 0, data, dp);
  dp += 5;

  // gcr.c:132-136 — header-id GCR (5 bytes).
  buf[0] = header.id2 & 0xff;
  buf[1] = (header.id1 ^ idm) & 0xff;
  buf[2] = 0x0f;
  buf[3] = 0x0f;
  gcr_convert_4bytes_to_GCR(buf, 0, data, dp);
  dp += 5;

  // gcr.c:138 — gap (caller-specified byte count; not initialised by
  // VICE → preserves whatever's in `data` already).
  dp += gap;

  // gcr.c:140-141 — sync (caller-specified count).
  const syncFill2 = (error_code === CBMDOS_FDC_ERR_SYNC) ? 0x55 : 0xff;
  for (let k = 0; k < sync; k++) data[dp + k] = syncFill2;
  dp += sync;

  // gcr.c:143-155 — first data block (4 bytes: 0x07 prefix + buffer[0..2]).
  chksum = (error_code === CBMDOS_FDC_ERR_DCHECK) ? 0xff : 0x00;
  buf[0] = (error_code === CBMDOS_FDC_ERR_NOBLOCK) ? 0x00 : 0x07;
  buf[1] = buffer[bp + 0]!;
  buf[2] = buffer[bp + 1]!;
  buf[3] = buffer[bp + 2]!;
  chksum ^= buffer[bp + 0]! ^ buffer[bp + 1]! ^ buffer[bp + 2]!;
  gcr_convert_4bytes_to_GCR(buf, 0, data, dp);
  bp += 3;
  dp += 5;

  // gcr.c:157-162 — 63 × 4-byte blocks.
  for (let i = 0; i < 63; i++) {
    chksum ^= buffer[bp + 0]! ^ buffer[bp + 1]! ^ buffer[bp + 2]! ^ buffer[bp + 3]!;
    gcr_convert_4bytes_to_GCR(buffer, bp, data, dp);
    bp += 4;
    dp += 5;
  }

  // gcr.c:164-167 — last block (1 byte data + chksum + 2 zeros).
  buf[0] = buffer[bp]!;
  buf[1] = (chksum ^ buffer[bp]!) & 0xff;
  buf[2] = 0;
  buf[3] = 0;
  gcr_convert_4bytes_to_GCR(buf, 0, data, dp);
}

function getBit(data: Uint8Array, bitIndex: number): number {
  const totalBits = data.length * 8;
  const normalized = ((bitIndex % totalBits) + totalBits) % totalBits;
  const byteIndex = normalized >> 3;
  const bitOffset = 7 - (normalized & 7);
  return (data[byteIndex]! >> bitOffset) & 1;
}

function readAlignedBytesFromBit(data: Uint8Array, startBit: number, byteCount: number): Uint8Array {
  const result = new Uint8Array(byteCount);
  for (let byteIndex = 0; byteIndex < byteCount; byteIndex += 1) {
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value << 1) | getBit(data, startBit + byteIndex * 8 + bit);
    }
    result[byteIndex] = value;
  }
  return result;
}

function decodeGCRGroupDetailed(gcr: Uint8Array, offset = 0): { bytes: Uint8Array; valid: boolean } {
  const result = new Uint8Array(4);
  const b0 = gcr[offset];
  const b1 = gcr[offset + 1];
  const b2 = gcr[offset + 2];
  const b3 = gcr[offset + 3];
  const b4 = gcr[offset + 4];

  const nybbles = [
    (b0 >> 3) & 0x1f,
    ((b0 << 2) | (b1 >> 6)) & 0x1f,
    (b1 >> 1) & 0x1f,
    ((b1 << 4) | (b2 >> 4)) & 0x1f,
    ((b2 << 1) | (b3 >> 7)) & 0x1f,
    (b3 >> 2) & 0x1f,
    ((b3 << 3) | (b4 >> 5)) & 0x1f,
    b4 & 0x1f,
  ];
  const decoded = nybbles.map((nybble) => decodeGCRNybble(nybble));
  result[0] = (decoded[0]! << 4) | decoded[1]!;
  result[1] = (decoded[2]! << 4) | decoded[3]!;
  result[2] = (decoded[4]! << 4) | decoded[5]!;
  result[3] = (decoded[6]! << 4) | decoded[7]!;
  return {
    bytes: result,
    // Validity = "every input nybble was in the valid GCR set". VICE
    // does not track this (silently decodes invalid → 0), but we keep
    // it as a separate signal for diagnostic tooling. Production
    // sector reads do NOT depend on this flag.
    valid: nybbles.every((n) => isValidGcrNybble(n)),
  };
}

export function decodeGCRGroup(gcr: Uint8Array, offset = 0): Uint8Array {
  return decodeGCRGroupDetailed(gcr, offset).bytes;
}

export function decodeGCRHeader(gcr: Uint8Array, offset = 0): {
  valid: boolean;
  gcrValid: boolean;
  headerId: number;
  track: number;
  sector: number;
  id1: number;
  id2: number;
  checksum: number;
  gap1: number;
  gap2: number;
} {
  const part1 = decodeGCRGroupDetailed(gcr, offset);
  const part2 = decodeGCRGroupDetailed(gcr, offset + 5);
  const headerBytes1 = part1.bytes;
  const headerBytes2 = part2.bytes;
  const headerId = headerBytes1[0];
  const checksum = headerBytes1[1];
  const sector = headerBytes1[2];
  const track = headerBytes1[3];
  const id2 = headerBytes2[0];
  const id1 = headerBytes2[1];
  const gap1 = headerBytes2[2];
  const gap2 = headerBytes2[3];
  const valid = headerId === 0x08;
  const calcChecksum = sector ^ track ^ id2 ^ id1;

  return {
    valid: part1.valid && part2.valid && valid && checksum === calcChecksum,
    gcrValid: part1.valid && part2.valid,
    headerId,
    track,
    sector,
    id1,
    id2,
    checksum,
    gap1,
    gap2,
  };
}

export function decodeGCRDataBlock(gcr: Uint8Array, offset = 0): {
  valid: boolean;
  gcrValid: boolean;
  blockId: number;
  data: Uint8Array;
  checksum: number;
} {
  const decoded = new Uint8Array(260);
  let gcrValid = true;
  for (let i = 0; i < 65; i++) {
    const group = decodeGCRGroupDetailed(gcr, offset + i * 5);
    decoded.set(group.bytes, i * 4);
    gcrValid &&= group.valid;
  }

  const blockId = decoded[0];
  const data = decoded.slice(1, 257);
  const checksum = decoded[257];

  let calcChecksum = 0;
  for (let i = 1; i <= 256; i++) {
    calcChecksum ^= decoded[i];
  }

  return {
    valid: gcrValid && blockId === 0x07 && checksum === calcChecksum,
    gcrValid,
    blockId,
    data,
    checksum,
  };
}

export interface SyncMark {
  byteOffset: number;
  bitOffset: number;
  bitIndex: number;
}

function trailingOnes(data: Uint8Array): number {
  let ones = 0;
  for (let byteIndex = data.length - 1; byteIndex >= 0; byteIndex -= 1) {
    const byte = data[byteIndex]!;
    for (let bit = 0; bit < 8; bit += 1) {
      if ((byte >> bit) & 1) {
        ones += 1;
      } else {
        return ones;
      }
    }
  }
  return ones;
}

function syncMarkFromBit(bitIndex: number): SyncMark {
  return {
    byteOffset: bitIndex >> 3,
    bitOffset: bitIndex & 7,
    bitIndex,
  };
}

export function findSyncMark(data: Uint8Array, startByte = 0): SyncMark | null {
  const totalBits = data.length * 8;
  if (totalBits === 0) {
    return null;
  }
  const startBit = Math.max(0, Math.min(startByte, data.length)) * 8;
  let consecutiveOnes = 0;
  for (let bitIndex = startBit; bitIndex < totalBits; bitIndex += 1) {
    if (getBit(data, bitIndex)) {
      consecutiveOnes += 1;
      continue;
    }
    if (consecutiveOnes >= 10) {
      return syncMarkFromBit(bitIndex);
    }
    consecutiveOnes = 0;
  }
  return null;
}

export function findAllSyncMarks(data: Uint8Array): SyncMark[] {
  const syncs: SyncMark[] = [];
  const totalBits = data.length * 8;
  if (totalBits === 0) {
    return syncs;
  }
  let consecutiveOnes = trailingOnes(data);
  for (let bitIndex = 0; bitIndex < totalBits; bitIndex += 1) {
    if (getBit(data, bitIndex)) {
      consecutiveOnes += 1;
      continue;
    }
    if (consecutiveOnes >= 10) {
      const mark = syncMarkFromBit(bitIndex % totalBits);
      const previous = syncs[syncs.length - 1];
      if (!previous || previous.bitIndex !== mark.bitIndex) {
        syncs.push(mark);
      }
    }
    consecutiveOnes = 0;
  }
  syncs.sort((left, right) => left.bitIndex - right.bitIndex);
  return syncs;
}

export interface DecodedSector {
  track: number;
  sector: number;
  data: Uint8Array;
  headerValid: boolean;
  dataValid: boolean;
}

export interface GCRHeaderInspection {
  valid: boolean;
  gcrValid: boolean;
  headerId: number;
  track: number;
  sector: number;
  id1: number;
  id2: number;
  checksum: number;
  gap1: number;
  gap2: number;
}

export interface GCRDataInspection {
  valid: boolean;
  gcrValid: boolean;
  blockId: number;
  checksum: number;
  dataLength: number;
}

export interface GCRBlockPairInspection {
  pairIndex: number;
  headerSync: SyncMark;
  dataSync: SyncMark;
  headerStartBit: number;
  dataStartBit: number;
  header: GCRHeaderInspection;
  data: GCRDataInspection;
}

export interface GCRTrackInspection {
  syncs: SyncMark[];
  chosenParity: 0 | 1;
  alternativeParityScore: number;
  chosenParityScore: number;
  pairs: GCRBlockPairInspection[];
}

export interface GCRHeaderCandidate {
  sync: SyncMark;
  header: GCRHeaderInspection;
}

export interface GCRReadSectorResult {
  status: "ok" | "sync_not_found" | "header_not_found" | "no_block" | "checksum_error";
  headerSync?: SyncMark;
  dataSync?: SyncMark;
  header?: GCRHeaderInspection;
  data?: GCRDataInspection;
  payload?: Uint8Array;
}

/**
 * VICE gcr.c gcr_find_sync (lines 170-203) — bit-by-bit scan for 10
 * consecutive 1-bits followed by a 0-bit. Wraps around the track.
 * Returns the bit position AT the terminating 0 (i.e. just after the
 * 10-ones run), encoded as a SyncMark (byteOffset/bitOffset/bitIndex).
 *
 * @param raw   GCR-encoded track bytes
 * @param p     starting bit position (any value; modulo track size)
 * @param s     max bits to scan before giving up
 * @returns SyncMark or null when no sync found within `s` bits
 */
/**
 * **Inspection-tier API** (NOT for production drive emulation).
 *
 * SyncMark-returning variant used by `g64-parser` and disk-viewer
 * tooling to surface bit/byte offsets in rich form. Production-tier
 * VICE-literal port is `gcr_find_sync_vice` (gcr.c:170-203). The two
 * functions co-exist by design: production uses fdc_err_t shape,
 * inspection uses rich objects.
 */
export function gcr_find_sync(raw: Uint8Array, p: number, s: number): SyncMark | null {
  return findSyncMarkFromBit(raw, p, s);
}

/**
 * Spec 445 Phase 2c — VICE `gcr_find_sync` (gcr.c:170-203) literal.
 *
 * @param raw  disk_track_t (data + size) — VICE shape
 * @param p    starting bit position
 * @param s    max bits to scan
 * @returns bit position (≥ 0) of FIRST 0 bit after ≥10 consecutive
 *          1s, OR `-CBMDOS_FDC_ERR_SYNC` (= -3) if no sync found.
 *
 * VICE signature:
 *   static int gcr_find_sync(const disk_track_t *raw, int p, int s);
 */
export function gcr_find_sync_vice(raw: disk_track_t, p: number, s: number): number {
  if (!raw.data || !raw.size) return -CBMDOS_FDC_ERR_SYNC;
  const totalBits = raw.size * 8;
  let consecutiveOnes = 0;
  let bitIndex = ((p % totalBits) + totalBits) % totalBits;
  let scanned = 0;
  while (scanned < s) {
    if (getBit(raw.data, bitIndex)) {
      consecutiveOnes += 1;
    } else {
      if (consecutiveOnes >= 10) {
        return bitIndex;
      }
      consecutiveOnes = 0;
    }
    bitIndex = (bitIndex + 1) % totalBits;
    scanned += 1;
  }
  return -CBMDOS_FDC_ERR_SYNC;
}

/**
 * VICE gcr.c gcr_decode_block (lines 205-232) — decode `num` GROUPS
 * from arbitrary bit position `p`. Each group consumes 5 GCR bytes
 * and produces 4 decoded bytes. Wraps around track end.
 *
 * VICE signature: `void gcr_decode_block(raw, p, uint8_t *buf, int num)`
 * writes `num * 4` decoded bytes into `buf`. Here we return the
 * decoded byte array (length = `num * 4`) instead of mutating an
 * out-parameter.
 *
 * @param raw  GCR track bytes
 * @param p    starting bit position
 * @param num  number of GROUPS to decode (each group = 5 GCR → 4 raw)
 * @returns Uint8Array of length `num * 4` with decoded bytes
 */
/**
 * **Inspection-tier API.** Convenience: returns decoded bytes as a
 * fresh Uint8Array (used by disk-layout viewers). Production-tier
 * literal port is `gcr_decode_block_vice` (out-param shape).
 */
export function gcr_decode_block(raw: Uint8Array, p: number, num: number): Uint8Array {
  // Read num * 5 GCR bytes from bit position p, then decode group by group.
  const gcrBytes = readAlignedBytesFromBit(raw, p, num * 5);
  const result = new Uint8Array(num * 4);
  for (let i = 0; i < num; i++) {
    const group = decodeGCRGroupDetailed(gcrBytes, i * 5);
    result.set(group.bytes, i * 4);
  }
  return result;
}

/**
 * Spec 445 Phase 2c — VICE `gcr_decode_block` (gcr.c:205-232) literal.
 *
 * Decode `num` GROUPS from bit position `p`, writing into `buf`.
 * Uses `raw.size` for wrap-around.
 *
 * VICE signature:
 *   static void gcr_decode_block(const disk_track_t *raw, int p,
 *                                uint8_t *buf, int num);
 */
export function gcr_decode_block_vice(
  raw: disk_track_t,
  p: number,
  buf: Uint8Array,
  bufOffset: number,
  num: number,
): void {
  // Literal VICE shift-register form (gcr.c:205-232):
  //   shift = p & 7;
  //   offset = raw->data + (p >> 3);
  //   b = offset[0] << shift;
  //   for (i = 0; i < num; i++, buf += 4) {
  //     for (j = 0; j < 5; j++) {
  //       offset++;
  //       if (offset >= end) offset = raw->data;
  //       if (shift) {
  //         gcr[j] = b | ((offset[0] << shift) >> 8);
  //         b = offset[0] << shift;
  //       } else {
  //         gcr[j] = b;
  //         b = offset[0];
  //       }
  //     }
  //     gcr_convert_GCR_to_4bytes(gcr, buf);
  //   }
  const data = raw.data;
  const end = raw.size;
  const shift = p & 7;
  let offset = p >>> 3;
  // VICE: `b = offset[0] << shift` — keeps the 8+shift-bit pre-shifted byte
  // in `b`. The next byte is OR-merged via `(offset[0] << shift) >> 8` to
  // produce a fully shifted bit-aligned byte for gcr[j].
  let b = (data[offset]! << shift) & 0xffff;
  const gcr = new Uint8Array(5);

  for (let i = 0; i < num; i++) {
    for (let j = 0; j < 5; j++) {
      offset += 1;
      if (offset >= end) offset = 0;
      if (shift) {
        // gcr[j] = top 8 of `b` (= last byte's tail in high bits) OR'd
        // with the next byte's leading `shift` bits (= (offset[0] << shift) >> 8).
        const next = (data[offset]! << shift) & 0xffff;
        gcr[j] = (b | (next >>> 8)) & 0xff;
        b = next;
      } else {
        gcr[j] = b & 0xff;
        b = data[offset]!;
      }
    }
    const group = decodeGCRGroupDetailed(gcr, 0);
    buf[bufOffset + i * 4 + 0] = group.bytes[0]!;
    buf[bufOffset + i * 4 + 1] = group.bytes[1]!;
    buf[bufOffset + i * 4 + 2] = group.bytes[2]!;
    buf[bufOffset + i * 4 + 3] = group.bytes[3]!;
  }
}

/**
 * VICE gcr.c gcr_find_sector_header (lines 234-261). Scans for a
 * sync mark, decodes 10 bytes at that position, accepts if
 * `header[0] == 0x08` (GCR-encoded header id) and decoded sector
 * matches the requested one. Returns null if no matching header
 * found within one full revolution.
 */
/**
 * **Inspection-tier API.** Null-returning, returns rich
 * GCRHeaderCandidate (sync mark + decoded header fields). Used by
 * g64-parser / disk-layout viewer. Production-tier VICE-literal
 * port is `gcr_find_sector_header_vice` (fdc_err_t shape).
 *
 * NOTE: this inspection variant CANNOT distinguish "no syncs at all"
 * from "syncs found but no matching sector" — both return null.
 * Use `gcr_find_sector_header_vice` if that distinction matters.
 */
export function gcr_find_sector_header(raw: Uint8Array, sector: number): GCRHeaderCandidate | null {
  return findSectorHeaderLikeVice(raw, sector);
}

/**
 * Spec 445 Phase 2c — VICE `gcr_find_sector_header` (gcr.c:234-261) literal.
 *
 * @returns bit position (≥ 0) of the data immediately following the
 *          matching sector's sync, OR negative fdc_err_t:
 *          - `-CBMDOS_FDC_ERR_SYNC` (= -3) if track has no syncs at all
 *          - `-CBMDOS_FDC_ERR_HEADER` (= -2) if syncs found but none match
 *
 * VICE signature:
 *   static int gcr_find_sector_header(const disk_track_t *raw, uint8_t sector);
 */
export function gcr_find_sector_header_vice(raw: disk_track_t, sector: number): number {
  const header = new Uint8Array(4);
  let p = 0;
  let p2 = -CBMDOS_FDC_ERR_SYNC;
  const totalBits = raw.size * 8;
  for (;;) {
    p = gcr_find_sync_vice(raw, p, totalBits);
    if (p2 === p) break;
    if (p2 < 0) p2 = p;
    gcr_decode_block_vice(raw, p, header, 0, 1);
    if (header[0] === 0x08 && header[2] === (sector & 0xff)) {
      return p;
    }
  }
  if (p2 < 0) return p2;
  return -CBMDOS_FDC_ERR_HEADER;
}

/**
 * VICE gcr.c gcr_read_sector (lines 263-292). Finds the sector
 * header sync, then the data sync within 500*8 bits of the header,
 * then decodes 325 GCR bytes = 65 groups = 256 data bytes + block id
 * + checksum + padding. Returns full read status + payload.
 */
/**
 * **Inspection-tier API.** Returns rich GCRReadSectorResult
 * (status enum + payload + decoded header + sync positions). Used
 * by g64-parser / disk-layout viewer. Production-tier VICE-literal
 * port is `gcr_read_sector_vice` (out-param + fdc_err_t shape).
 */
export function gcr_read_sector(raw: Uint8Array, sector: number): GCRReadSectorResult {
  return readSectorLikeVice(raw, sector);
}

/**
 * Spec 445 Phase 2c — VICE `gcr_read_sector` (gcr.c:263-292) literal.
 *
 * Find sector header → find data sync → decode 65 GCR groups (260 bytes
 * = id byte + 256 data + checksum + 2 zeros) → write 256 data bytes
 * to `data[0..255]` → verify block id (0x07) + checksum.
 *
 * VICE signature:
 *   fdc_err_t gcr_read_sector(const disk_track_t *raw, uint8_t *data,
 *                             uint8_t sector);
 *
 * @returns fdc_err_t:
 *   - CBMDOS_FDC_ERR_OK       success
 *   - CBMDOS_FDC_ERR_HEADER   sector header not found
 *   - CBMDOS_FDC_ERR_SYNC     no sync between header and data block
 *   - CBMDOS_FDC_ERR_NOBLOCK  block id byte ≠ 0x07
 *   - CBMDOS_FDC_ERR_DCHECK   checksum mismatch
 */
export function gcr_read_sector_vice(
  raw: disk_track_t,
  data: Uint8Array,
  sector: number,
): fdc_err_t {
  let p = gcr_find_sector_header_vice(raw, sector);
  if (p < 0) return -p;

  p = gcr_find_sync_vice(raw, p, 500 * 8);
  if (p < 0) return -p;

  const buffer = new Uint8Array(260);
  gcr_decode_block_vice(raw, p, buffer, 0, 65);

  let b = buffer[257]!;
  for (let i = 0; i < 256; i++) {
    data[i] = buffer[i + 1]!;
    b ^= data[i]!;
  }

  if (buffer[0] !== 0x07) return CBMDOS_FDC_ERR_NOBLOCK;
  return (b & 0xff) ? CBMDOS_FDC_ERR_DCHECK : CBMDOS_FDC_ERR_OK;
}

/**
 * Spec 445 Phase 2b — VICE `gcr_write_sector` (src/gcr.c:294-346) literal.
 *
 * Find sector header, advance past the inter-block sync, then encode
 * `data` (256 bytes) into the data block at that bit position
 * (bit-aligned, may straddle byte boundaries). Mutates `raw` in place.
 *
 * Returns `fdc_err_t`:
 *   - CBMDOS_FDC_ERR_OK         success
 *   - CBMDOS_FDC_ERR_HEADER     sector header not found
 *   - CBMDOS_FDC_ERR_SYNC       no sync between header and data block
 *
 * VICE body line cites (gcr.c:294-346):
 *   - 301-304: find sector header (`gcr_find_sector_header`)
 *   - 306-309: advance past inter-block sync (`gcr_find_sync` window
 *              500*8 = 4000 bits)
 *   - 311-314: bit-position decomposition (shift = p & 7,
 *              offset = data + p/8, b = preserved bits before shift)
 *   - 316-323: assemble 260-byte data-block buffer
 *              ([0x07] + data[256] + chksum + 2 zeros)
 *   - 327-342: 65 × (4-byte encode → 5-byte GCR write, possibly
 *              cross-byte-boundary via `b` carry)
 *   - 343:     finalise last byte (preserve trailing bits after shift)
 */
export function gcr_write_sector(
  raw: disk_track_t,
  data: Uint8Array,
  sector: number,
): fdc_err_t {
  // gcr.c:301 — find sector header.
  let p = gcr_find_sector_header_vice(raw, sector);
  if (p < 0) return -p;

  // gcr.c:306 — find next sync within 500*8 = 4000 bits.
  p = gcr_find_sync_vice(raw, p, 500 * 8);
  if (p < 0) return -p;

  // gcr.c:311-314 — bit position decomposition.
  const shift = p & 7;
  let offset = p >>> 3;
  // VICE: b = offset[0] & (0xff00 >> shift) — preserves the high bits
  // BEFORE the write position. With shift = 0..7, (0xff00 >> shift)
  // = 0xff00 / 2^shift. Low byte is the mask we want to AND with raw.
  // For shift = 0, mask = 0x00 (no bits preserved); for shift = 7,
  // mask = 0xfe (preserve top 7 bits).
  let b = raw.data[offset]! & ((0xff00 >> shift) & 0xff);

  // gcr.c:316-323 — assemble 260-byte data-block buffer.
  const buffer = new Uint8Array(260);
  buffer[0] = 0x07;
  for (let i = 0; i < 256; i++) buffer[i + 1] = data[i]!;
  let chksum = buffer[1]!;
  for (let i = 2; i < 257; i++) chksum ^= buffer[i]!;
  buffer[257] = chksum & 0xff;
  buffer[258] = 0;
  buffer[259] = 0;

  // gcr.c:327-342 — 65 × (4-byte → 5-byte GCR) write loop.
  const gcr = new Uint8Array(5);
  let bp = 0;
  const end = raw.size;

  for (let i = 0; i < 65; i++) {
    gcr_convert_4bytes_to_GCR(buffer, bp, gcr, 0);
    bp += 4;
    for (let j = 0; j < 5; j++) {
      if (shift) {
        // VICE: offset[0] = b | (gcr[j] >> shift); b = (gcr[j] << 8) >> shift;
        raw.data[offset] = (b | (gcr[j]! >>> shift)) & 0xff;
        b = ((gcr[j]! << 8) >>> shift) & 0xff;
      } else {
        // VICE: offset[0] = gcr[j];
        raw.data[offset] = gcr[j]!;
      }
      offset++;
      if (offset >= end) {
        offset = 0;  // wrap to track start (VICE: offset = raw->data)
      }
    }
  }

  // gcr.c:343 — finalise last byte: preserve bits AFTER the write position.
  // (0xff >> shift) masks the LOW (8 - shift) bits to keep; rest comes from b.
  raw.data[offset] = (b | (raw.data[offset]! & (0xff >> shift))) & 0xff;

  return CBMDOS_FDC_ERR_OK;
}

/** @deprecated Use `gcr_find_sync(raw, startBit, searchBits)` instead. */
export function findSyncMarkFromBit(data: Uint8Array, startBit = 0, searchBits = data.length * 8): SyncMark | null {
  const totalBits = data.length * 8;
  if (totalBits === 0 || searchBits <= 0) {
    return null;
  }
  let consecutiveOnes = 0;
  let bitIndex = ((startBit % totalBits) + totalBits) % totalBits;
  for (let scanned = 0; scanned < searchBits; scanned += 1, bitIndex = (bitIndex + 1) % totalBits) {
    if (getBit(data, bitIndex)) {
      consecutiveOnes += 1;
      continue;
    }
    if (consecutiveOnes >= 10) {
      return syncMarkFromBit(bitIndex);
    }
    consecutiveOnes = 0;
  }
  return null;
}

/** @deprecated Use `gcr_find_sector_header` instead (returns single match). */
export function scanSectorHeadersLikeVice(trackData: Uint8Array): GCRHeaderCandidate[] {
  const candidates: GCRHeaderCandidate[] = [];
  const seen = new Set<number>();
  const totalBits = trackData.length * 8;
  let startBit = 0;
  while (seen.size < totalBits) {
    const sync = findSyncMarkFromBit(trackData, startBit, totalBits);
    if (!sync || seen.has(sync.bitIndex)) {
      break;
    }
    seen.add(sync.bitIndex);
    const headerBytes = readAlignedBytesFromBit(trackData, sync.bitIndex, 10);
    const header = decodeGCRHeader(headerBytes, 0);
    if (header.headerId === 0x08) {
      candidates.push({ sync, header });
    }
    startBit = sync.bitIndex + 1;
  }
  return candidates;
}

/** @deprecated Use `gcr_find_sector_header(raw, sector)` instead. */
export function findSectorHeaderLikeVice(trackData: Uint8Array, sector: number): GCRHeaderCandidate | null {
  for (const candidate of scanSectorHeadersLikeVice(trackData)) {
    if (candidate.header.sector === (sector & 0xff)) {
      return candidate;
    }
  }
  return null;
}

/** @deprecated Use `gcr_read_sector(raw, sector)` instead. */
export function readSectorLikeVice(trackData: Uint8Array, sector: number): GCRReadSectorResult {
  const headerCandidate = findSectorHeaderLikeVice(trackData, sector);
  if (!headerCandidate) {
    return { status: "header_not_found" };
  }
  const dataSync = findSyncMarkFromBit(trackData, headerCandidate.sync.bitIndex, 500 * 8);
  if (!dataSync) {
    return {
      status: "sync_not_found",
      headerSync: headerCandidate.sync,
      header: headerCandidate.header,
    };
  }
  const dataBytes = readAlignedBytesFromBit(trackData, dataSync.bitIndex, 325);
  const dataBlock = decodeGCRDataBlock(dataBytes, 0);
  const result: GCRReadSectorResult = {
    status: dataBlock.blockId !== 0x07 ? "no_block" : dataBlock.valid ? "ok" : "checksum_error",
    headerSync: headerCandidate.sync,
    dataSync,
    header: headerCandidate.header,
    data: {
      valid: dataBlock.valid,
      gcrValid: dataBlock.gcrValid,
      blockId: dataBlock.blockId,
      checksum: dataBlock.checksum,
      dataLength: dataBlock.data.length,
    },
    payload: dataBlock.data,
  };
  return result;
}

function inspectPair(trackData: Uint8Array, headerSync: SyncMark, dataSync: SyncMark, pairIndex: number): GCRBlockPairInspection {
  const headerBytes = readAlignedBytesFromBit(trackData, headerSync.bitIndex, 10);
  const header = decodeGCRHeader(headerBytes, 0);
  const dataBytes = readAlignedBytesFromBit(trackData, dataSync.bitIndex, 325);
  const dataBlock = decodeGCRDataBlock(dataBytes, 0);
  return {
    pairIndex,
    headerSync,
    dataSync,
    headerStartBit: headerSync.bitIndex,
    dataStartBit: dataSync.bitIndex,
    header,
    data: {
      valid: dataBlock.valid,
      gcrValid: dataBlock.gcrValid,
      blockId: dataBlock.blockId,
      checksum: dataBlock.checksum,
      dataLength: dataBlock.data.length,
    },
  };
}

function scorePair(pair: GCRBlockPairInspection): number {
  let score = 0;
  if (pair.header.gcrValid) score += 3;
  if (pair.header.headerId === 0x08) score += 5;
  if (pair.header.valid) score += 8;
  if (pair.data.gcrValid) score += 2;
  if (pair.data.blockId === 0x07) score += 4;
  if (pair.data.valid) score += 6;
  return score;
}

export function inspectGCRTrack(trackData: Uint8Array): GCRTrackInspection {
  const syncs = findAllSyncMarks(trackData);
  const parityPairs = ([0, 1] as const).map((parity) => {
    const pairs: GCRBlockPairInspection[] = [];
    for (let i = parity, pairIndex = 0; i < syncs.length; i += 2, pairIndex += 1) {
      const headerSync = syncs[i]!;
      const dataSync = i + 1 < syncs.length ? syncs[i + 1]! : syncs[0]!;
      if (headerSync.bitIndex === dataSync.bitIndex) {
        continue;
      }
      pairs.push(inspectPair(trackData, headerSync, dataSync, pairIndex));
    }
    const score = pairs.reduce((total, pair) => total + scorePair(pair), 0);
    return { parity, pairs, score };
  });
  const [first, second] = parityPairs;
  const chosen = (second && second.score > first.score) ? second : first;
  const alternative = chosen === first ? second : first;
  return {
    syncs,
    chosenParity: chosen.parity,
    chosenParityScore: chosen.score,
    alternativeParityScore: alternative?.score ?? 0,
    pairs: chosen.pairs,
  };
}

function markRange(chars: string[], totalBits: number, startBit: number, lengthBits: number, mark: string): void {
  if (!chars.length || totalBits <= 0 || lengthBits <= 0) {
    return;
  }
  const endBit = startBit + lengthBits;
  for (let i = 0; i < chars.length; i += 1) {
    const segmentStart = Math.floor((i * totalBits) / chars.length);
    const segmentEnd = Math.floor(((i + 1) * totalBits) / chars.length);
    const overlaps = segmentEnd > startBit && segmentStart < endBit;
    if (!overlaps) {
      continue;
    }
    chars[i] = mark;
  }
}

export function renderGCRTrackAscii(inspected: GCRTrackInspection, trackByteLength: number, width = 96): string {
  const totalBits = trackByteLength * 8;
  const chars = new Array<string>(Math.max(16, width)).fill(".");
  for (const pair of inspected.pairs) {
    const headerMark = pair.header.valid ? "H" : pair.header.gcrValid ? "h" : "?";
    const dataMark = pair.data.valid ? "D" : pair.data.gcrValid ? "d" : "x";
    markRange(chars, totalBits, pair.headerStartBit, 10 * 8, headerMark);
    markRange(chars, totalBits, pair.dataStartBit, 325 * 8, dataMark);
  }
  for (const sync of inspected.syncs) {
    const index = Math.min(chars.length - 1, Math.floor((sync.bitIndex / totalBits) * chars.length));
    chars[index] = "S";
  }
  return chars.join("");
}

export function decodeGCRTrack(trackData: Uint8Array): DecodedSector[] {
  const sectors: DecodedSector[] = [];
  const inspected = inspectGCRTrack(trackData);
  const syncs = inspected.syncs;
  const seen = new Set<string>();

  for (const pair of inspected.pairs) {
    if (!pair.header.gcrValid) continue;
    const key = `${pair.header.track}:${pair.header.sector}:${pair.dataSync.bitIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sectors.push({
      track: pair.header.track,
      sector: pair.header.sector,
      data: readAlignedBytesFromBit(trackData, pair.dataStartBit, 325).length === 325
        ? decodeGCRDataBlock(readAlignedBytesFromBit(trackData, pair.dataStartBit, 325), 0).data
        : new Uint8Array(256),
      headerValid: pair.header.valid,
      dataValid: pair.data.valid,
    });
  }

  return sectors;
}
