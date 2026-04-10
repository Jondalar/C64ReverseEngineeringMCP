/**
 * GCR decoder for Commodore 1541.
 */

const GCR_DECODE: number[] = [
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0xff, 0x08, 0x00, 0x01, 0xff, 0x0c, 0x04, 0x05,
  0xff, 0xff, 0x02, 0x03, 0xff, 0x0f, 0x06, 0x07,
  0xff, 0x09, 0x0a, 0x0b, 0xff, 0x0d, 0x0e, 0xff,
];

export function decodeGCRNybble(gcr5: number): number {
  return GCR_DECODE[gcr5 & 0x1f];
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
    valid: decoded.every((value) => value !== 0xff),
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

export function findSectorHeaderLikeVice(trackData: Uint8Array, sector: number): GCRHeaderCandidate | null {
  for (const candidate of scanSectorHeadersLikeVice(trackData)) {
    if (candidate.header.sector === (sector & 0xff)) {
      return candidate;
    }
  }
  return null;
}

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
