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

export function decodeGCRGroup(gcr: Uint8Array, offset = 0): Uint8Array {
  const result = new Uint8Array(4);
  const b0 = gcr[offset];
  const b1 = gcr[offset + 1];
  const b2 = gcr[offset + 2];
  const b3 = gcr[offset + 3];
  const b4 = gcr[offset + 4];

  const n0 = (b0 >> 3) & 0x1f;
  const n1 = ((b0 << 2) | (b1 >> 6)) & 0x1f;
  const n2 = (b1 >> 1) & 0x1f;
  const n3 = ((b1 << 4) | (b2 >> 4)) & 0x1f;
  const n4 = ((b2 << 1) | (b3 >> 7)) & 0x1f;
  const n5 = (b3 >> 2) & 0x1f;
  const n6 = ((b3 << 3) | (b4 >> 5)) & 0x1f;
  const n7 = b4 & 0x1f;

  result[0] = (decodeGCRNybble(n0) << 4) | decodeGCRNybble(n1);
  result[1] = (decodeGCRNybble(n2) << 4) | decodeGCRNybble(n3);
  result[2] = (decodeGCRNybble(n4) << 4) | decodeGCRNybble(n5);
  result[3] = (decodeGCRNybble(n6) << 4) | decodeGCRNybble(n7);
  return result;
}

export function decodeGCRHeader(gcr: Uint8Array, offset = 0): {
  valid: boolean;
  track: number;
  sector: number;
  id1: number;
  id2: number;
  checksum: number;
} {
  const part1 = decodeGCRGroup(gcr, offset);
  const part2 = decodeGCRGroup(gcr, offset + 5);
  const headerId = part1[0];
  const checksum = part1[1];
  const sector = part1[2];
  const track = part1[3];
  const id2 = part2[0];
  const id1 = part2[1];
  const valid = headerId === 0x08;
  const calcChecksum = sector ^ track ^ id2 ^ id1;

  return {
    valid: valid && checksum === calcChecksum,
    track,
    sector,
    id1,
    id2,
    checksum,
  };
}

export function decodeGCRDataBlock(gcr: Uint8Array, offset = 0): {
  valid: boolean;
  data: Uint8Array;
  checksum: number;
} {
  const decoded = new Uint8Array(260);
  for (let i = 0; i < 65; i++) {
    const group = decodeGCRGroup(gcr, offset + i * 5);
    decoded.set(group, i * 4);
  }

  const blockId = decoded[0];
  const data = decoded.slice(1, 257);
  const checksum = decoded[257];

  let calcChecksum = 0;
  for (let i = 1; i <= 256; i++) {
    calcChecksum ^= decoded[i];
  }

  return {
    valid: blockId === 0x07 && checksum === calcChecksum,
    data,
    checksum,
  };
}

export function findSyncMark(data: Uint8Array, startByte = 0): number {
  let consecutiveOnes = 0;

  for (let byteIdx = startByte; byteIdx < data.length; byteIdx++) {
    const byte = data[byteIdx];
    for (let bit = 7; bit >= 0; bit--) {
      if ((byte >> bit) & 1) {
        consecutiveOnes++;
      } else {
        if (consecutiveOnes >= 10) {
          return byteIdx;
        }
        consecutiveOnes = 0;
      }
    }
  }

  return consecutiveOnes >= 10 ? data.length : -1;
}

export function findAllSyncMarks(data: Uint8Array): number[] {
  const syncs: number[] = [];
  let pos = 0;

  while (pos < data.length) {
    const syncPos = findSyncMark(data, pos);
    if (syncPos < 0 || syncPos >= data.length) break;
    syncs.push(syncPos);
    pos = syncPos + 1;
  }

  return syncs;
}

export interface DecodedSector {
  track: number;
  sector: number;
  data: Uint8Array;
  headerValid: boolean;
  dataValid: boolean;
}

export function decodeGCRTrack(trackData: Uint8Array): DecodedSector[] {
  const sectors: DecodedSector[] = [];
  const syncs = findAllSyncMarks(trackData);

  for (let i = 0; i < syncs.length; i++) {
    const syncPos = syncs[i];
    if (syncPos + 10 > trackData.length) continue;

    if (trackData[syncPos] !== 0x52) continue;

    const header = decodeGCRHeader(trackData, syncPos);
    if (!header.valid) continue;

    const nextSync = i + 1 < syncs.length ? syncs[i + 1] : -1;
    if (nextSync < 0 || nextSync + 325 > trackData.length) continue;
    if (trackData[nextSync] !== 0x55) continue;

    const dataBlock = decodeGCRDataBlock(trackData, nextSync);
    sectors.push({
      track: header.track,
      sector: header.sector,
      data: dataBlock.data,
      headerValid: header.valid,
      dataValid: dataBlock.valid,
    });

    i++;
  }

  return sectors;
}
