import { ensureDir, writeBinary, writeJson, toPosixRelative } from "./fs-utils";
import { hex16 } from "./format";

export interface CrtHeader {
  headerLen: number;
  version: number;
  hardwareType: number;
  exrom: number;
  game: number;
  name: string;
  imageSize: number;
}

export interface CrtChip {
  offset: number;
  packetLen: number;
  chipType: number;
  bank: number;
  loadAddress: number;
  size: number;
  rom: Buffer;
}

export interface ParsedCrt {
  header: CrtHeader;
  chips: CrtChip[];
}

export interface RomClassification {
  asciiRatio: number;
  hasCbm80Signature: boolean;
  prgCandidate: boolean;
  prgLoadAddress: number | null;
  looksLikeStartupBank: boolean;
}

export function parseCrt(data: Buffer): ParsedCrt {
  if (data.subarray(0, 16).toString("ascii") !== "C64 CARTRIDGE   ") {
    throw new Error("Not a CRT image");
  }

  const headerLen = data.readUInt32BE(0x10);
  const version = data.readUInt16BE(0x14);
  const hardwareType = data.readUInt16BE(0x16);
  const exrom = data[0x18];
  const game = data[0x19];
  const rawName = data.subarray(0x20, 0x40);
  const zeroOffset = rawName.indexOf(0);
  const name = rawName.subarray(0, zeroOffset >= 0 ? zeroOffset : rawName.length).toString("ascii");

  const chips: CrtChip[] = [];
  let offset = headerLen;

  while (offset < data.length) {
    if (data.subarray(offset, offset + 4).toString("ascii") !== "CHIP") {
      throw new Error(`Unexpected chunk at 0x${offset.toString(16)}`);
    }

    const packetLen = data.readUInt32BE(offset + 4);
    const chipType = data.readUInt16BE(offset + 8);
    const bank = data.readUInt16BE(offset + 10);
    const loadAddress = data.readUInt16BE(offset + 12);
    const size = data.readUInt16BE(offset + 14);
    const rom = data.subarray(offset + 16, offset + 16 + size);

    chips.push({
      offset,
      packetLen,
      chipType,
      bank,
      loadAddress,
      size,
      rom,
    });

    offset += packetLen;
  }

  return {
    header: {
      headerLen,
      version,
      hardwareType,
      exrom,
      game,
      name,
      imageSize: data.length,
    },
    chips,
  };
}

export function classifyRom(rom: Buffer, loadAddress: number): RomClassification {
  let asciiCount = 0;
  for (const byte of rom) {
    if (byte >= 32 && byte < 127) {
      asciiCount += 1;
    }
  }

  const hasCbm80Signature =
    rom.length >= 9 &&
    rom[4] === 0xc3 &&
    rom[5] === 0xc2 &&
    rom[6] === 0xcd &&
    rom[7] === 0x38 &&
    rom[8] === 0x30;

  const firstWord = rom.length >= 2 ? rom.readUInt16LE(0) : 0;
  const prgCandidate = firstWord >= 0x0200 && firstWord <= 0xcfff;

  return {
    asciiRatio: Number((asciiCount / rom.length).toFixed(3)),
    hasCbm80Signature,
    prgCandidate,
    prgLoadAddress: prgCandidate ? firstWord : null,
    looksLikeStartupBank: loadAddress === 0x8000 && hasCbm80Signature,
  };
}

export function writeCrtOutputs(parsed: ParsedCrt, outputDir: string): void {
  ensureDir(outputDir);
  const chipsDir = `${outputDir}/chips`;
  const banksDir = `${outputDir}/banks`;
  ensureDir(chipsDir);
  ensureDir(banksDir);

  const byBank = new Map<number, CrtChip[]>();
  const manifest: {
    header: CrtHeader;
    chips: Array<Record<string, unknown>>;
    banks: Record<string, Record<string, unknown>>;
  } = {
    header: parsed.header,
    chips: [],
    banks: {},
  };

  for (const chip of parsed.chips) {
    const chipPath = `${chipsDir}/bank_${chip.bank.toString().padStart(2, "0")}_${hex16(chip.loadAddress)}.bin`;
    writeBinary(chipPath, chip.rom);

    const chips = byBank.get(chip.bank) ?? [];
    chips.push(chip);
    byBank.set(chip.bank, chips);

    manifest.chips.push({
      bank: chip.bank,
      load_address: chip.loadAddress,
      size: chip.size,
      file: toPosixRelative(outputDir, chipPath),
      offset: chip.offset,
      packet_len: chip.packetLen,
      chip_type: chip.chipType,
      ...classifyRom(chip.rom, chip.loadAddress),
    });
  }

  for (const [bank, chips] of [...byBank.entries()].sort((a, b) => a[0] - b[0])) {
    const bankDir = `${banksDir}/bank_${bank.toString().padStart(2, "0")}`;
    ensureDir(bankDir);

    const combined = Buffer.alloc(0x4000, 0xff);
    const slots: string[] = [];

    for (const chip of [...chips].sort((a, b) => a.loadAddress - b.loadAddress)) {
      const start = chip.loadAddress === 0x8000 ? 0x0000 : 0x2000;
      chip.rom.copy(combined, start);
      slots.push(`$${hex16(chip.loadAddress)}`);
    }

    const bankFile = `${bankDir}/bank_16k.bin`;
    writeBinary(bankFile, combined);
    manifest.banks[bank.toString().padStart(2, "0")] = {
      slots,
      file: toPosixRelative(outputDir, bankFile),
    };
  }

  writeJson(`${outputDir}/manifest.json`, manifest);
}
