/**
 * GCR decoder for Commodore 1541 — Spec 437 literal port of VICE gcr.c.
 *
 * VICE function map (line ranges from VICE 3.7.1 src/gcr.c):
 *
 *   VICE function               Lines      TS impl                Notes
 *   --------------------------- --------   --------------------   -------
 *   gcr_convert_4bytes_to_GCR   68-86      n/a (write-back only)
 *   gcr_convert_GCR_to_4bytes   87-110     decodeGCRGroup         decode 4 bytes
 *   gcr_convert_sector_to_GCR   112-168    n/a (write-back only)
 *   gcr_find_sync               170-203    gcr_find_sync (export) bit-by-bit
 *                                          findSyncMarkFromBit
 *                                            (back-compat alias)
 *   gcr_decode_block            205-232    gcr_decode_block       arbitrary bit pos
 *                                            (export)
 *   gcr_find_sector_header      234-261    gcr_find_sector_header literal scan
 *                                            (export)
 *   gcr_read_sector             263-292    gcr_read_sector        header + 500*8 bit data window
 *                                            (export)
 *   gcr_write_sector            294-346    out-of-scope (Spec 437)
 *
 * All functions are bit-level (arbitrary `p & 7` bit position),
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
export function gcr_find_sync(raw: Uint8Array, p: number, s: number): SyncMark | null {
  return findSyncMarkFromBit(raw, p, s);
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
 * VICE gcr.c gcr_find_sector_header (lines 234-261). Scans for a
 * sync mark, decodes 10 bytes at that position, accepts if
 * `header[0] == 0x08` (GCR-encoded header id) and decoded sector
 * matches the requested one. Returns null if no matching header
 * found within one full revolution.
 */
export function gcr_find_sector_header(raw: Uint8Array, sector: number): GCRHeaderCandidate | null {
  return findSectorHeaderLikeVice(raw, sector);
}

/**
 * VICE gcr.c gcr_read_sector (lines 263-292). Finds the sector
 * header sync, then the data sync within 500*8 bits of the header,
 * then decodes 325 GCR bytes = 65 groups = 256 data bytes + block id
 * + checksum + padding. Returns full read status + payload.
 */
export function gcr_read_sector(raw: Uint8Array, sector: number): GCRReadSectorResult {
  return readSectorLikeVice(raw, sector);
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
