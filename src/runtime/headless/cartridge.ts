import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { HeadlessBankInfo, HeadlessCartridgeMapperType, HeadlessCartridgeState } from "./types.js";

const CRT_SIGNATURE = "C64 CARTRIDGE   ";
const FLASH_CMD_ADDR1 = 0x0555;
const FLASH_CMD_ADDR2 = 0x02aa;

type CrtLoadProfile = "roml" | "romh_a000" | "romh_e000";

interface CrtBank {
  roml?: Uint8Array;
  romhA000?: Uint8Array;
  romhE000?: Uint8Array;
}

interface ParsedCartridgeImage {
  path: string;
  name: string;
  mapperType: HeadlessCartridgeMapperType;
  exrom: number;
  game: number;
  banks: Map<number, CrtBank>;
  profiles: Set<CrtLoadProfile>;
}

interface HeadlessCartridgeLines {
  exrom: number;
  game: number;
}

export interface HeadlessCartridgeMapper {
  getMapperType(): HeadlessCartridgeMapperType;
  getState(): HeadlessCartridgeState;
  getLines(): HeadlessCartridgeLines;
  read(address: number, bankInfo: HeadlessBankInfo): number | undefined;
  write(address: number, value: number, bankInfo: HeadlessBankInfo): boolean;
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
    case "normal_8k":
      return new Normal8kMapper(image);
    case "normal_16k":
      return new Normal16kMapper(image);
    case "ultimax":
      return new UltimaxMapper(image);
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

  const banks = new Map<number, CrtBank>();
  const profiles = new Set<CrtLoadProfile>();
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
      existing.roml = normalizeBankData(rom.slice(0, 0x2000), 0x2000);
      profiles.add("roml");
      if (rom.length > 0x2000) {
        existing.romhA000 = normalizeBankData(rom.slice(0x2000), 0x2000);
        profiles.add("romh_a000");
      }
    } else if (loadAddress === 0xa000) {
      existing.romhA000 = normalizeBankData(rom, 0x2000);
      profiles.add("romh_a000");
    } else if (loadAddress === 0xe000) {
      existing.romhE000 = normalizeBankData(rom, 0x2000);
      profiles.add("romh_e000");
    }
    banks.set(bank, existing);
    offset += packetLen;
  }

  const inferredMapper = mapperType ?? inferMapperType(hardwareType, exrom, game, profiles);
  if (!inferredMapper) {
    throw new Error(`Unsupported CRT hardware type ${hardwareType}. Pass mapper_type explicitly if the layout is known.`);
  }

  return {
    path,
    name,
    mapperType: inferredMapper,
    exrom,
    game,
    banks,
    profiles,
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

function inferMapperType(
  hardwareType: number,
  exrom: number,
  game: number,
  profiles: Set<CrtLoadProfile>,
): HeadlessCartridgeMapperType | undefined {
  switch (hardwareType) {
    case 0:
      if (profiles.has("romh_e000") || (exrom === 1 && game === 1)) {
        return "ultimax";
      }
      if (profiles.has("romh_a000")) {
        return "normal_16k";
      }
      if (profiles.has("roml")) {
        return "normal_8k";
      }
      return undefined;
    case 5:
      return "ocean";
    case 19:
    case 85:
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

function cloneBankData(bank: CrtBank): CrtBank {
  return {
    roml: bank.roml ? new Uint8Array(bank.roml) : undefined,
    romhA000: bank.romhA000 ? new Uint8Array(bank.romhA000) : undefined,
    romhE000: bank.romhE000 ? new Uint8Array(bank.romhE000) : undefined,
  };
}

function resolveRelativeOffset(baseAddress: number, address: number): number {
  return (address - baseAddress) & 0x1fff;
}

abstract class BaseMapper implements HeadlessCartridgeMapper {
  protected currentBank = 0;
  protected readonly banks = new Map<number, CrtBank>();

  constructor(protected readonly image: ParsedCartridgeImage) {
    for (const [bank, data] of image.banks.entries()) {
      this.banks.set(bank, cloneBankData(data));
    }
  }

  getMapperType(): HeadlessCartridgeMapperType {
    return this.image.mapperType;
  }

  getState(): HeadlessCartridgeState {
    return {
      path: this.image.path,
      name: this.image.name,
      mapperType: this.image.mapperType,
      currentBank: this.currentBank,
      controlRegister: this.getControlRegister(),
      exrom: this.getLines().exrom,
      game: this.getLines().game,
      romlBanks: [...this.banks.entries()].filter(([, bank]) => bank.roml).map(([bank]) => bank),
      romhBanks: [...this.banks.entries()].filter(([, bank]) => bank.romhA000 || bank.romhE000).map(([bank]) => bank),
      writable: false,
    };
  }

  getLines(): HeadlessCartridgeLines {
    return {
      exrom: this.image.exrom,
      game: this.image.game,
    };
  }

  read(address: number, bankInfo: HeadlessBankInfo): number | undefined {
    const bank = this.banks.get(this.currentBank);
    if (!bank) {
      return undefined;
    }
    if (address >= 0x8000 && address <= 0x9fff && this.romlVisible(bankInfo) && bank.roml) {
      return bank.roml[address - 0x8000];
    }
    if (address >= 0xa000 && address <= 0xbfff && this.romhA000Visible(bankInfo) && bank.romhA000) {
      return bank.romhA000[address - 0xa000];
    }
    if (address >= 0xe000 && address <= 0xffff && this.romhE000Visible(bankInfo) && bank.romhE000) {
      return bank.romhE000[address - 0xe000];
    }
    return undefined;
  }

  write(address: number, value: number, bankInfo: HeadlessBankInfo): boolean {
    void address;
    void value;
    void bankInfo;
    return false;
  }

  protected romhA000Visible(_bankInfo: HeadlessBankInfo): boolean {
    return true;
  }

  protected romhE000Visible(_bankInfo: HeadlessBankInfo): boolean {
    return false;
  }

  protected romlVisible(_bankInfo: HeadlessBankInfo): boolean {
    return true;
  }

  protected getControlRegister(): number | undefined {
    return undefined;
  }
}

class Normal8kMapper extends BaseMapper {}

class Normal16kMapper extends BaseMapper {}

class UltimaxMapper extends BaseMapper {
  protected romhA000Visible(): boolean {
    return false;
  }

  protected romhE000Visible(): boolean {
    return true;
  }
}

class MagicDeskMapper extends BaseMapper {
  write(address: number, value: number): boolean {
    if (address === 0xde00) {
      this.currentBank = value & 0x3f;
      return true;
    }
    return false;
  }

  protected romhA000Visible(): boolean {
    return false;
  }
}

class OceanMapper extends BaseMapper {
  write(address: number, value: number): boolean {
    if (address === 0xde00) {
      this.currentBank = value & 0x3f;
      return true;
    }
    return false;
  }
}

type FlashCommandState = "read" | "cmd1" | "cmd2" | "program" | "erase1" | "erase2" | "erase3" | "autoselect";

class FlashChip {
  public state: FlashCommandState = "read";

  constructor(private readonly label: string) {}

  getMode(): string {
    return `${this.label}:${this.state}`;
  }

  read(bankData: Uint8Array, relativeOffset: number): number {
    if (this.state === "autoselect") {
      if (relativeOffset === 0x0000) return 0x01;
      if (relativeOffset === 0x0001) return 0xa4;
    }
    return bankData[relativeOffset] ?? 0xff;
  }

  write(bankData: Uint8Array, relativeOffset: number, value: number): boolean {
    const byte = value & 0xff;
    if (byte === 0xf0) {
      this.state = "read";
      return true;
    }

    switch (this.state) {
      case "read":
        if (relativeOffset === FLASH_CMD_ADDR1 && byte === 0xaa) {
          this.state = "cmd1";
          return true;
        }
        return false;
      case "cmd1":
        if (relativeOffset === FLASH_CMD_ADDR2 && byte === 0x55) {
          this.state = "cmd2";
          return true;
        }
        this.state = "read";
        return false;
      case "cmd2":
        if (relativeOffset === FLASH_CMD_ADDR1 && byte === 0xa0) {
          this.state = "program";
          return true;
        }
        if (relativeOffset === FLASH_CMD_ADDR1 && byte === 0x80) {
          this.state = "erase1";
          return true;
        }
        if (relativeOffset === FLASH_CMD_ADDR1 && byte === 0x90) {
          this.state = "autoselect";
          return true;
        }
        this.state = "read";
        return false;
      case "program":
        bankData[relativeOffset] = byte;
        this.state = "read";
        return true;
      case "erase1":
        if (relativeOffset === FLASH_CMD_ADDR1 && byte === 0xaa) {
          this.state = "erase2";
          return true;
        }
        this.state = "read";
        return false;
      case "erase2":
        if (relativeOffset === FLASH_CMD_ADDR2 && byte === 0x55) {
          this.state = "erase3";
          return true;
        }
        this.state = "read";
        return false;
      case "erase3":
        if (relativeOffset === FLASH_CMD_ADDR1 && byte === 0x10) {
          bankData.fill(0xff);
          this.state = "read";
          return true;
        }
        if (byte === 0x30) {
          const sectorStart = relativeOffset & ~0x0fff;
          bankData.fill(0xff, sectorStart, Math.min(bankData.length, sectorStart + 0x1000));
          this.state = "read";
          return true;
        }
        this.state = "read";
        return false;
      case "autoselect":
        if (byte === 0xf0) {
          this.state = "read";
          return true;
        }
        return false;
    }
  }
}

class EasyFlashMapper extends BaseMapper {
  private controlRegister = 0x07;
  private readonly loFlash = new FlashChip("lo");
  private readonly hiFlash = new FlashChip("hi");

  getLines(): HeadlessCartridgeLines {
    switch (this.currentMode()) {
      case "off":
        return { exrom: 1, game: 1 };
      case "ultimax":
        return { exrom: 1, game: 0 };
      case "8k":
        return { exrom: 0, game: 1 };
      case "16k":
        return { exrom: 0, game: 0 };
    }
  }

  getState(): HeadlessCartridgeState {
    const state = super.getState();
    state.controlRegister = this.controlRegister;
    state.writable = true;
    state.flashMode = `${this.currentMode()} [${this.loFlash.getMode()},${this.hiFlash.getMode()}]`;
    return state;
  }

  read(address: number, bankInfo: HeadlessBankInfo): number | undefined {
    const bank = this.banks.get(this.currentBank);
    if (!bank) {
      return undefined;
    }
    if (address >= 0x8000 && address <= 0x9fff && this.romlVisible(bankInfo) && bank.roml) {
      return this.loFlash.read(bank.roml, resolveRelativeOffset(0x8000, address));
    }
    if (address >= 0xa000 && address <= 0xbfff && this.romhA000Visible(bankInfo) && bank.romhA000) {
      return this.hiFlash.read(bank.romhA000, resolveRelativeOffset(0xa000, address));
    }
    if (address >= 0xe000 && address <= 0xffff && this.romhE000Visible(bankInfo) && bank.romhE000) {
      return this.hiFlash.read(bank.romhE000, resolveRelativeOffset(0xe000, address));
    }
    return undefined;
  }

  write(address: number, value: number, bankInfo: HeadlessBankInfo): boolean {
    if (address === 0xde00) {
      this.currentBank = value & 0x3f;
      return true;
    }
    if (address === 0xde02) {
      this.controlRegister = value & 0xff;
      return true;
    }

    const bank = this.banks.get(this.currentBank);
    if (!bank) {
      return false;
    }
    if (address >= 0x8000 && address <= 0x9fff && this.romlVisible(bankInfo) && bank.roml) {
      return this.loFlash.write(bank.roml, resolveRelativeOffset(0x8000, address), value);
    }
    if (address >= 0xa000 && address <= 0xbfff && this.romhA000Visible(bankInfo) && bank.romhA000) {
      return this.hiFlash.write(bank.romhA000, resolveRelativeOffset(0xa000, address), value);
    }
    if (address >= 0xe000 && address <= 0xffff && this.romhE000Visible(bankInfo) && bank.romhE000) {
      return this.hiFlash.write(bank.romhE000, resolveRelativeOffset(0xe000, address), value);
    }
    return false;
  }

  protected romhA000Visible(_bankInfo: HeadlessBankInfo): boolean {
    return this.currentMode() === "16k";
  }

  protected romhE000Visible(_bankInfo: HeadlessBankInfo): boolean {
    return this.currentMode() === "ultimax";
  }

  protected romlVisible(_bankInfo: HeadlessBankInfo): boolean {
    return this.currentMode() !== "off";
  }

  protected getControlRegister(): number {
    return this.controlRegister;
  }

  private currentMode(): "off" | "ultimax" | "8k" | "16k" {
    const mxg = this.controlRegister & 0x07;
    switch (mxg) {
      case 0x04:
        return "off";
      case 0x05:
        return "ultimax";
      case 0x06:
        return "8k";
      case 0x07:
        return "16k";
      case 0x00:
        return this.image.game === 0 ? "ultimax" : "off";
      case 0x02:
        return this.image.game === 0 ? "16k" : "8k";
      default:
        return "off";
    }
  }
}
