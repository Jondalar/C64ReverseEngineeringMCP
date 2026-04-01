import { AnalysisReport } from "./types";
import { analyzeMappedBuffer } from "./pipeline";

function encodeWord(value: number): [number, number] {
  return [value & 0xff, (value >> 8) & 0xff];
}

export function buildSampleBuffer(): { buffer: Buffer; loadAddress: number } {
  const loadAddress = 0x2000;
  const bytes = new Uint8Array(0x400);

  const code = [
    0x20, 0x10, 0x21,
    0xa9, 0x00,
    0x8d, 0x20, 0xd0,
    0x4c, 0x20, 0x20,
  ];
  bytes.set(code, 0x0000);
  bytes.set([0xa9, 0x01, 0x8d, 0x21, 0xd0, 0x60], 0x0110);

  const text = Buffer.from("HELLO FROM TRXDIS\x00", "ascii");
  bytes.set(text, 0x0040);

  for (let sprite = 0; sprite < 2; sprite += 1) {
    const base = 0x0080 + sprite * 64;
    for (let row = 0; row < 21; row += 1) {
      bytes[base + row * 3 + 1] = 0b00011000;
      if (row > 4 && row < 16) {
        bytes[base + row * 3] = 0b00000110;
        bytes[base + row * 3 + 2] = 0b01100000;
      }
    }
  }

  for (let glyph = 0; glyph < 32; glyph += 1) {
    const base = 0x0180 + glyph * 8;
    bytes.set([0x00, 0x3c, 0x66, 0x66, 0x7e, 0x66, 0x66, 0x00], base);
  }

  const pointers = [
    loadAddress + 0x0000,
    loadAddress + 0x0110,
    loadAddress + 0x0040,
    loadAddress + 0x0080,
  ];
  let pointerOffset = 0x0300;
  for (const pointer of pointers) {
    bytes.set(encodeWord(pointer), pointerOffset);
    pointerOffset += 2;
  }

  return {
    buffer: Buffer.from(bytes),
    loadAddress,
  };
}

export function analyzeSampleBuffer(): AnalysisReport {
  const sample = buildSampleBuffer();
  return analyzeMappedBuffer(
    "sample-buffer",
    sample.buffer,
    {
      format: "raw",
      loadAddress: sample.loadAddress,
      startAddress: sample.loadAddress,
      endAddress: sample.loadAddress + sample.buffer.length - 1,
      fileOffset: 0,
      fileSize: sample.buffer.length,
    },
    {
      userEntryPoints: [sample.loadAddress],
    },
  );
}
