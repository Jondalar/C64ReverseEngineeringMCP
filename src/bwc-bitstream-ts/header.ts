// BWC bitstream chunk header.
//
// Layout (14 bytes + Y bytes literal table):
//
//   off 0..3   skip4        opaque; first two bytes are always 'pu' ($70 $75)
//   off 4      cmp_op       token value that signals "LZ ref or end"
//   off 5      dest_lo      unpack destination, low byte
//   off 6      dest_hi      unpack destination, high byte
//   off 7      n1           main-token bit width, 1..8
//   off 8      n2           gamma cap (typical: 8)
//   off 9      n3           short-distance threshold; EOS marker = 2*n3 - 1
//   off 10     n4           distance high-extra-bits width
//   off 11..12 unused2      read-but-ignored; must roundtrip for byte-identical pack
//   off 13     y            literal-table size, 0..32
//   off 14..   lit_table[y] literal bytes copied to RAM at $0101..$0100+y
//
// The bit-stream payload starts immediately after `lit_table`.

export interface BwcHeader {
  skip4: Uint8Array;       // 4 bytes
  cmpOp: number;
  dest: number;            // 16-bit dest_lo | dest_hi << 8
  n1: number;
  n2: number;
  n3: number;
  n4: number;
  unused2: Uint8Array;     // 2 bytes
  y: number;
  litTable: Uint8Array;    // length === y
}

export interface BwcChunk {
  header: BwcHeader;
  payload: Uint8Array;     // bit-stream body, starts right after header (offset 14+y)
  headerSize: number;      // 14 + y
}

const PU_MAGIC = [0x70, 0x75];

export class BwcHeaderError extends Error {}

export function parseHeader(buffer: Uint8Array, offset = 0): BwcChunk {
  if (offset + 14 > buffer.length) {
    throw new BwcHeaderError(`buffer too short for header at offset $${offset.toString(16)}`);
  }
  if (buffer[offset] !== PU_MAGIC[0] || buffer[offset + 1] !== PU_MAGIC[1]) {
    throw new BwcHeaderError(
      `bad magic at offset $${offset.toString(16)}: expected 70 75, got ${buffer[offset]?.toString(16)} ${buffer[offset + 1]?.toString(16)}`,
    );
  }
  const skip4 = buffer.slice(offset, offset + 4);
  const cmpOp = buffer[offset + 4]!;
  const destLo = buffer[offset + 5]!;
  const destHi = buffer[offset + 6]!;
  const n1 = buffer[offset + 7]!;
  const n2 = buffer[offset + 8]!;
  const n3 = buffer[offset + 9]!;
  const n4 = buffer[offset + 10]!;
  const unused2 = buffer.slice(offset + 11, offset + 13);
  const y = buffer[offset + 13]!;

  if (n1 < 1 || n1 > 8) throw new BwcHeaderError(`n1 out of range: ${n1}`);
  if (n2 < 1 || n2 > 16) throw new BwcHeaderError(`n2 out of range: ${n2}`);
  if (n3 < 1 || n3 > 255) throw new BwcHeaderError(`n3 out of range: ${n3}`);
  if (n4 > 8) throw new BwcHeaderError(`n4 out of range: ${n4}`);
  if (y > 32) throw new BwcHeaderError(`y out of range: ${y}`);

  const litStart = offset + 14;
  if (litStart + y > buffer.length) {
    throw new BwcHeaderError(`buffer too short for lit_table[${y}]`);
  }
  const litTable = buffer.slice(litStart, litStart + y);

  const headerSize = 14 + y;
  const payload = buffer.slice(litStart + y);

  return {
    header: {
      skip4,
      cmpOp,
      dest: destLo | (destHi << 8),
      n1, n2, n3, n4,
      unused2,
      y,
      litTable,
    },
    payload,
    headerSize,
  };
}

export function serializeHeader(header: BwcHeader): Uint8Array {
  if (header.skip4.length !== 4) throw new BwcHeaderError(`skip4 must be 4 bytes`);
  if (header.unused2.length !== 2) throw new BwcHeaderError(`unused2 must be 2 bytes`);
  if (header.litTable.length !== header.y) throw new BwcHeaderError(`litTable length (${header.litTable.length}) must equal y (${header.y})`);
  const out = new Uint8Array(14 + header.y);
  out.set(header.skip4, 0);
  out[4] = header.cmpOp & 0xff;
  out[5] = header.dest & 0xff;
  out[6] = (header.dest >> 8) & 0xff;
  out[7] = header.n1 & 0xff;
  out[8] = header.n2 & 0xff;
  out[9] = header.n3 & 0xff;
  out[10] = header.n4 & 0xff;
  out.set(header.unused2, 11);
  out[13] = header.y & 0xff;
  out.set(header.litTable, 14);
  return out;
}

export function defaultHeader(opts: { dest: number; cmpOp?: number; n1?: number; y?: number; litTable?: Uint8Array }): BwcHeader {
  const y = opts.y ?? (opts.litTable?.length ?? 0);
  const lit = opts.litTable ?? new Uint8Array(y);
  if (lit.length !== y) throw new BwcHeaderError(`litTable length must equal y`);
  return {
    skip4: new Uint8Array([0x70, 0x75, 0x00, 0x00]),
    cmpOp: opts.cmpOp ?? 0x01,
    dest: opts.dest & 0xffff,
    n1: opts.n1 ?? 2,
    n2: 8,
    n3: 128,
    n4: 0,
    unused2: new Uint8Array([0xff, 0xff]),
    y,
    litTable: lit,
  };
}
