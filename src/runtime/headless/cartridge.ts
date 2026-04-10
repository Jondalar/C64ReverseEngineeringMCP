import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { HeadlessBankInfo, HeadlessCartridgeMapperType, HeadlessCartridgeState } from "./types.js";

const CRT_SIGNATURE = "C64 CARTRIDGE   ";

interface CrtBank {
  roml?: Uint8Array;
  romh?: Uint8Array;
}

interface ParsedCartridgeImage {
  path: string;
  name: string;
  mapperType: HeadlessCartridgeMapperType;
  exrom: number;
  game: number;
  banks: Map<number, CrtBank>;
}

export interface HeadlessCartridgeMapper {
  getState(): HeadlessCartridgeState;
  read(address: number, bankInfo: HeadlessBankInfo): number | undefined;
  write(address: number, value: number): void;
}

export function loadCartridgeMapper(crtPath: string, mapperType?: HeadlessCartridgeMapperType): HeadlessCartridgeMapper {
  const image = parseCrt(readFileSync(crtPath), crtPath, mapperType);
  switch (image.mapperType) {
    case "magicdesk":
      return new MagicDeskMapper(image);
    case "ocean":
      return new OceanMapper(image);
    case "easyflash":
      return new EasyFlashMapper(image);
  }
}

function parseCrt(data: Uint8Array, path: string, mapperType?: HeadlessCartridgeMapperType): ParsedCartridgeImage {
  if (Buffer.from(data.slice(0, 16)).toString("ascii") !== CRT_SIGNATURE) {
    throw new Error(`Not a CRT image: ${path}`);
  }
  const headerLen = readU32Be(data, 0x10);
  const hardwareType = readU16Be(data, 0x16);
  const exrom = data[0x18] ?? 0;
  const game = data[0x19] ?? 0;
  const rawName = Buffer.from(data.slice(0x20, 0x40));
  const zeroOffset = rawName.indexOf(0);
  const name = rawName.subarray(0, zeroOffset >= 0 ? zeroOffset : rawName.length).toString("ascii").trim() || basename(path);
  const inferredMapper = mapperType ?? inferMapperType(hardwareType);
  if (!inferredMapper) {
    throw new Error(`Unsupported CRT hardware type ${hardwareType}. Pass mapper_type explicitly if the layout is known.`);
  }

  const banks = new Map<number, CrtBank>();
  let offset = headerLen;
  while (offset + 0x10 <= data.length) {
    if (Buffer.from(data.slice(offset, offset + 4)).toString("ascii") !== "CHIP") {
      break;
    }
    const packetLen = readU32Be(data, offset + 4);
    const bank = readU16Be(data, offset + 10);
    const loadAddress = readU16Be(data, offset + 12);
    const size = readU16Be(data, offset + 14);
    const rom = data.slice(offset + 16, offset + 16 + size);
    const existing = banks.get(bank) ?? {};
    if (loadAddress === 0x8000) {
      existing.roml = normalizeBankData(rom, 0x2000);
    } else if (loadAddress === 0xa000 || loadAddress === 0xe000) {
      existing.romh = normalizeBankData(rom, 0x2000);
    }
    banks.set(bank, existing);
    offset += packetLen;
  }

  return {
    path,
    name,
    mapperType: inferredMapper,
    exrom,
    game,
    banks,
  };
}

function normalizeBankData(data: Uint8Array, size: number): Uint8Array {
  if (data.length === size) {
    return new Uint8Array(data);
  }
  const result = new Uint8Array(size);
  result.fill(0xff);
  result.set(data.slice(0, Math.min(size, data.length)));
  return result;
}

function inferMapperType(hardwareType: number): HeadlessCartridgeMapperType | undefined {
  switch (hardwareType) {
    case 5:
      return "ocean";
    case 19:
      return "magicdesk";
    case 32:
      return "easyflash";
    default:
      return undefined;
  }
}

function readU16Be(data: Uint8Array, offset: number): number {
  return ((data[offset] ?? 0) << 8) | (data[offset + 1] ?? 0);
}

function readU32Be(data: Uint8Array, offset: number): number {
  return (((data[offset] ?? 0) << 24) | ((data[offset + 1] ?? 0) << 16) | ((data[offset + 2] ?? 0) << 8) | (data[offset + 3] ?? 0)) >>> 0;
}

abstract class BaseMapper implements HeadlessCartridgeMapper {
  protected currentBank = 0;

  constructor(protected readonly image: ParsedCartridgeImage) {}

  getState(): HeadlessCartridgeState {
    return {
      path: this.image.path,
      name: this.image.name,
      mapperType: this.image.mapperType,
      currentBank: this.currentBank,
      controlRegister: this.getControlRegister(),
      exrom: this.image.exrom,
      game: this.image.game,
      romlBanks: [...this.image.banks.entries()].filter(([, bank]) => bank.roml).map(([bank]) => bank),
      romhBanks: [...this.image.banks.entries()].filter(([, bank]) => bank.romh).map(([bank]) => bank),
    };
  }

  read(address: number, bankInfo: HeadlessBankInfo): number | undefined {
    const bank = this.image.banks.get(this.currentBank);
    if (!bank) {
      return undefined;
    }
    if (address >= 0x8000 && address <= 0x9fff && bank.roml) {
      return bank.roml[address - 0x8000];
    }
    if (address >= 0xa000 && address <= 0xbfff && this.romhVisible(bankInfo) && bank.romh) {
      return bank.romh[address - 0xa000];
    }
    return undefined;
  }

  abstract write(address: number, value: number): void;

  protected romhVisible(_bankInfo: HeadlessBankInfo): boolean {
    return true;
  }

  protected getControlRegister(): number | undefined {
    return undefined;
  }
}

class MagicDeskMapper extends BaseMapper {
  write(address: number, value: number): void {
    if (address === 0xde00) {
      this.currentBank = value & 0x3f;
    }
  }

  protected romhVisible(): boolean {
    return false;
  }
}

class OceanMapper extends BaseMapper {
  write(address: number, value: number): void {
    if (address === 0xde00) {
      this.currentBank = value & 0x3f;
    }
  }
}

class EasyFlashMapper extends BaseMapper {
  private controlRegister = 0x07;

  write(address: number, value: number): void {
    if (address === 0xde00) {
      this.currentBank = value & 0x3f;
      return;
    }
    if (address === 0xde02) {
      this.controlRegister = value & 0xff;
    }
  }

  protected romhVisible(): boolean {
    return (this.controlRegister & 0x04) !== 0;
  }

  protected getControlRegister(): number {
    return this.controlRegister;
  }
}
