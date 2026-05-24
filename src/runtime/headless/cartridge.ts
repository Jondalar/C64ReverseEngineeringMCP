import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { HeadlessBankInfo, HeadlessCartridgeMapperType, HeadlessCartridgeState, Flash040SnapState } from "./types.js";
import { EAPI_AM29F040 } from "./eapi-am29f040.js";

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
  /** Spec 709.7 — restore the bank-switching continuation state (currentBank +
   *  control register) so a checkpoint/.c64re-restored cart resumes identically. */
  setState(state: HeadlessCartridgeState): void;
  getLines(): HeadlessCartridgeLines;
  read(address: number, bankInfo: HeadlessBankInfo): number | undefined;
  write(address: number, value: number, bankInfo: HeadlessBankInfo): boolean;
  /** Spec 709.11b — true if writable (flash) contents were mutated since attach.
   *  Read-only mappers omit it. Used by the dump guard (v1 can't persist flash). */
  isWritableDirty?(): boolean;
  /** Spec 713/714.5 — true when this mapper's full mutable hardware state (flash,
   *  etc.) is captured/restored by getWritableImage/setWritableImage, so a dirty
   *  cartridge IS persistable (no reject). Families without a faithful writable
   *  port (no test corpus yet) omit it / return false and stay reject-on-dirty. */
  persistsWritableState?(): boolean;
  /** Spec 714.5 — the mapper's mutable device image (e.g. flash low+high), as a
   *  flat copy safe to pool/serialize, or null when there is nothing writable.
   *  Captured apart from the original .crt bytes so the ring can dedup it. */
  getWritableImage?(): Uint8Array | null;
  /** Spec 714.5 — restore a previously captured writable image onto the live
   *  device (overlays the flash rebuilt from the original .crt bytes). */
  setWritableImage?(bytes: Uint8Array): void;
  /** Spec 713 — wire the live maincpu_clk into writable hardware that needs it
   *  (flash erase busy window / status toggle). The bus calls this at attach. */
  setClock?(clk: () => number): void;
}

export function loadCartridgeMapper(crtPath: string, mapperType?: HeadlessCartridgeMapperType): HeadlessCartridgeMapper {
  return mapperFromImage(parseCrt(readFileSync(crtPath), crtPath, mapperType));
}

// Spec 709 — byte-based CRT load for the media-ingress service (no file path).
export function loadCartridgeMapperFromBytes(
  bytes: Uint8Array, name: string, mapperType?: HeadlessCartridgeMapperType,
): HeadlessCartridgeMapper {
  return mapperFromImage(parseCrt(bytes, name, mapperType));
}

function mapperFromImage(image: ParsedCartridgeImage): HeadlessCartridgeMapper {
  switch (image.mapperType) {
    case "megabyter":
      return new MegabyterMapper(image);
    case "magicdesk":
      return new MagicDeskMapper(image);
    case "magicdesk16":
      return new MagicDesk16Mapper(image);
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
    // Sprint 87 (Spec 087) — user-priority adds. GMOD2/3 are EAPI-style
    // banked Flash carts; C64MegaCart is a multi-game banked cart. Each
    // shares Magic Desk-style $DE00 bank-select semantics for v1; full
    // EEPROM (GMOD2 SDA) deferred per R31 backlog.
    case "gmod2":
      return new Gmod2Mapper(image);
    case "gmod3":
      return new Gmod3Mapper(image);
    default:
      // Spec 713 — a type with no authoritative VICE C64 source is not a
      // supported VICE-faithful cartridge. (C64MegaCart was removed: the only
      // "megacart" in the VICE tree is vic20/cart/megacart.c, a VIC20 cart, so
      // there is no C64 authority to port — we report unsupported rather than
      // keep an invented Magic-Desk-proxy mapper.)
      throw new Error(`Unsupported cartridge type "${image.mapperType}" — no authoritative VICE C64 implementation.`);
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
      return "magicdesk";       // CARTRIDGE_MAGIC_DESK
    case 85:
      return "magicdesk16";     // CARTRIDGE_MAGIC_DESK_16
    case 86:
      return "megabyter";
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

function buildLinearChipData(
  image: ParsedCartridgeImage,
  selector: (bank: CrtBank) => Uint8Array | undefined,
  bankCount?: number,
): Uint8Array {
  const highestBank = [...image.banks.keys()].reduce((max, bank) => Math.max(max, bank), 0);
  const totalBanks = Math.max(bankCount ?? 0, highestBank + 1);
  const result = new Uint8Array(totalBanks * 0x2000);
  result.fill(0xff);
  for (const [bankNumber, bank] of image.banks.entries()) {
    const segment = selector(bank);
    if (!segment) {
      continue;
    }
    result.set(segment.slice(0, 0x2000), bankNumber * 0x2000);
  }
  return result;
}

interface FlashSectorLayout {
  start: number;
  size: number;
}

interface AmdFlashChipOptions {
  label: string;
  data: Uint8Array;
  commandAddress1: number;
  commandAddress2: number;
  commandAddressMask: number;
  manufacturerId: number;
  deviceId: number;
  sectors: FlashSectorLayout[];
}

interface HeadlessWritableChip {
  read(offset: number): number;
  write(offset: number, value: number): boolean;
  getMode(): string;
}

function createUniformSectors(totalSize: number, sectorSize: number): FlashSectorLayout[] {
  const sectors: FlashSectorLayout[] = [];
  for (let start = 0; start < totalSize; start += sectorSize) {
    sectors.push({ start, size: Math.min(sectorSize, totalSize - start) });
  }
  return sectors;
}

function findSectorForOffset(sectors: FlashSectorLayout[], offset: number): FlashSectorLayout | undefined {
  return sectors.find((sector) => offset >= sector.start && offset < sector.start + sector.size);
}

// VICE derives the bank register mask from the loaded image size (magicdesk.c /
// magicdesk16.c bankmask, ocean.c io1_mask = (size>>13)-1). We derive the same
// power-of-two-minus-one mask from the highest 8K bank index present, capped to
// the family's maximum (MagicDesk 0x7f, Ocean 0x3f).
function bankMaskForImage(image: ParsedCartridgeImage, cap: number): number {
  const highest = [...image.banks.keys()].reduce((m, b) => Math.max(m, b), 0);
  let mask = 1;
  while (mask < highest) mask = ((mask << 1) | 1);
  return mask & cap;
}

function totalImageBytes(image: ParsedCartridgeImage): number {
  const highest = [...image.banks.keys()].reduce((m, b) => Math.max(m, b), 0);
  return (highest + 1) * 0x2000;
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

  // Spec 709.7 — restore the bank-switching state. Banked mappers with a
  // control register override setControlRegister; flash-write (EEPROM) state is
  // not restored in v1 (treated like a writable-disk delta — deferred).
  setState(state: HeadlessCartridgeState): void {
    this.currentBank = (state.currentBank ?? 0) & 0xff;
    this.setControlRegister(state.controlRegister);
  }

  protected setControlRegister(_v: number | undefined): void { /* override in banked mappers */ }
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

// VICE magicdesk.c — 8K-game banked cart. IO1 ($DE00-$DEFF) store: bit 7 =
// disable (EXROM released → cart off), bits 0..6 = ROM bank (& bankmask). ROML
// only; $A000-$BFFF stays BASIC. regval is the snapshot register.
class MagicDeskMapper extends BaseMapper {
  private regval = 0;
  private readonly bankmask = bankMaskForImage(this.image, 0x7f);
  write(address: number, value: number): boolean {
    if (address >= 0xde00 && address <= 0xdeff) {
      this.regval = value & (0x80 | this.bankmask);
      this.currentBank = value & this.bankmask;
      return true;
    }
    return false;
  }
  getLines(): HeadlessCartridgeLines {
    return (this.regval & 0x80) ? { exrom: 1, game: 1 } : { exrom: 0, game: 1 };
  }
  protected romhA000Visible(): boolean { return false; }
  protected getControlRegister(): number { return this.regval; }
  protected setControlRegister(v: number | undefined): void { this.regval = (v ?? 0) & 0xff; }
}

// VICE magicdesk16.c — 16K-game banked cart. IO1 store: bit 7 = disable, bits
// 0..6 = bank (& bankmask); the bank maps to BOTH ROML ($8000) and ROMH ($A000).
class MagicDesk16Mapper extends BaseMapper {
  private regval = 0;
  private readonly bankmask = bankMaskForImage(this.image, 0x7f);
  write(address: number, value: number): boolean {
    if (address >= 0xde00 && address <= 0xdeff) {
      this.regval = value & (0x80 | this.bankmask);
      this.currentBank = value & this.bankmask;
      return true;
    }
    return false;
  }
  getLines(): HeadlessCartridgeLines {
    // enabled → 16K game (exrom+game asserted); bit 7 → cart off.
    return (this.regval & 0x80) ? { exrom: 1, game: 1 } : { exrom: 0, game: 0 };
  }
  protected getControlRegister(): number { return this.regval; }
  protected setControlRegister(v: number | undefined): void { this.regval = (v ?? 0) & 0xff; }
}

// VICE ocean.c — banked cart, 8K bank → ROML. 512KB images use 8K-game config;
// every other size uses 16K-game and MIRRORS the same 8K bank to ROML and ROMH.
// IO1 store: bank = value & io1_mask & 0x3f (io1_mask = (size>>13)-1). No disable.
class OceanMapper extends BaseMapper {
  private regval = 0;
  private readonly io1Mask = bankMaskForImage(this.image, 0x3f);
  private readonly is8k = totalImageBytes(this.image) === 0x80000;
  write(address: number, value: number): boolean {
    if (address >= 0xde00 && address <= 0xdeff) {
      this.regval = value;
      this.currentBank = value & this.io1Mask & 0x3f;
      return true;
    }
    return false;
  }
  getLines(): HeadlessCartridgeLines {
    return this.is8k ? { exrom: 0, game: 1 } : { exrom: 0, game: 0 };
  }
  read(address: number, _bankInfo: HeadlessBankInfo): number | undefined {
    const bank = this.banks.get(this.currentBank);
    if (!bank?.roml) return undefined;
    if (address >= 0x8000 && address <= 0x9fff) return bank.roml[address - 0x8000];
    // 16K-game mirror: $A000-$BFFF reads the same 8K ROML bank (ocean.c romh_read).
    if (!this.is8k && address >= 0xa000 && address <= 0xbfff) return bank.roml[address - 0xa000];
    return undefined;
  }
  protected getControlRegister(): number { return this.regval; }
  protected setControlRegister(v: number | undefined): void { this.regval = (v ?? 0) & 0xff; }
}

type FlashCommandState = "read" | "cmd1" | "cmd2" | "program" | "erase1" | "erase2" | "erase3" | "autoselect";

class AmdFlashChip implements HeadlessWritableChip {
  public state: FlashCommandState = "read";
  // Spec 709.11b — set when flash contents are mutated (program/erase). Used by
  // the writable-CRT dump guard: v1 cannot persist flash deltas, so a dirty
  // flash is rejected at dump rather than silently restoring the original bytes.
  private dirty = false;

  constructor(private readonly options: AmdFlashChipOptions) {}

  isDirty(): boolean { return this.dirty; }
  // Spec 714.5 (audit) — true while a multi-step AMD command is in progress
  // (state != read). Such a mid-command checkpoint is non-restorable until the
  // flash command-state machine is snapshotted, so it must be rejected for now.
  isBusy(): boolean { return this.state !== "read"; }

  // Spec 713/714.5 — VICE-faithful writable-state surface. getData() returns the
  // live flash array (caller copies before pooling); loadData() overlays a
  // restored image and resets the command state machine to read mode (the
  // restored bytes are the new truth, so dirty clears).
  getData(): Uint8Array { return this.options.data; }
  loadData(bytes: Uint8Array): void {
    this.options.data.set(bytes.subarray(0, this.options.data.length));
    this.state = "read";
    this.dirty = false;
  }

  getMode(): string {
    return `${this.options.label}:${this.state}`;
  }

  read(offset: number): number {
    const normalized = offset % this.options.data.length;
    const commandOffset = normalized & this.options.commandAddressMask;
    if (this.state === "autoselect") {
      if (commandOffset === 0x0000) return this.options.manufacturerId;
      if (commandOffset === 0x0001) return this.options.deviceId;
    }
    return this.options.data[normalized] ?? 0xff;
  }

  write(offset: number, value: number): boolean {
    const normalized = offset % this.options.data.length;
    const commandOffset = normalized & this.options.commandAddressMask;
    const byte = value & 0xff;
    if (byte === 0xf0) {
      this.state = "read";
      return true;
    }

    switch (this.state) {
      case "read":
        if (commandOffset === this.options.commandAddress1 && byte === 0xaa) {
          this.state = "cmd1";
          return true;
        }
        return false;
      case "cmd1":
        if (commandOffset === this.options.commandAddress2 && byte === 0x55) {
          this.state = "cmd2";
          return true;
        }
        this.state = "read";
        return false;
      case "cmd2":
        if (commandOffset === this.options.commandAddress1 && byte === 0xa0) {
          this.state = "program";
          return true;
        }
        if (commandOffset === this.options.commandAddress1 && byte === 0x80) {
          this.state = "erase1";
          return true;
        }
        if (commandOffset === this.options.commandAddress1 && byte === 0x90) {
          this.state = "autoselect";
          return true;
        }
        this.state = "read";
        return false;
      case "program":
        this.options.data[normalized] = byte;
        this.dirty = true; // Spec 709.11b — flash mutated
        this.state = "read";
        return true;
      case "erase1":
        if (commandOffset === this.options.commandAddress1 && byte === 0xaa) {
          this.state = "erase2";
          return true;
        }
        this.state = "read";
        return false;
      case "erase2":
        if (commandOffset === this.options.commandAddress2 && byte === 0x55) {
          this.state = "erase3";
          return true;
        }
        this.state = "read";
        return false;
      case "erase3":
        if (commandOffset === this.options.commandAddress1 && byte === 0x10) {
          this.options.data.fill(0xff);
          this.dirty = true; // Spec 709.11b — chip erase mutated flash
          this.state = "read";
          return true;
        }
        if (byte === 0x30) {
          const sector = findSectorForOffset(this.options.sectors, normalized);
          if (!sector) {
            this.state = "read";
            return false;
          }
          this.options.data.fill(0xff, sector.start, sector.start + sector.size);
          this.dirty = true; // Spec 709.11b — sector erase mutated flash
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

// Spec 713 — source-faithful port of VICE flash040core.c for AM29F040B
// (FLASH040_TYPE_B, as EasyFlash uses). Full 13-state command machine + base
// state, AM29F040 `old & byte` programming, autoselect IDs, byte-program-error,
// sector/chip erase with the clk-scheduled busy window (DQ6/DQ3/DQ7 status
// toggling during erase), multi-sector erase_mask, and snapshot/restore of the
// complete continuation incl. the pending erase-alarm clock.
//
// The erase alarm is modelled LAZILY: `eraseAlarmClk` is the maincpu_clk at
// which the next erase step completes; it is applied on the next flash access
// at-or-after that clk (visible behaviour identical to VICE's alarm — software
// only observes the flash via reads, and each read catches the alarm up). The
// chip is driven the live maincpu_clk via `clock()`, wired at attach.
//
// RMW NOTE: VICE flash040core_store re-issues the dummy `last_read` write under
// maincpu_rmw_flag (RMW opcodes write the old value first). The active TS CPU
// path does not signal RMW to the cartridge; if it ever does, wrap store() the
// same way. The EAPI flash path is plain LDA/STA, unaffected.
// VICE flash040core.c flash_types[] rows. The TS Flash040 core is parametrized
// by one of these so EasyFlash (TYPE_B), GMOD2 (TYPE_NORMAL) and C64MegaCart
// (TYPE_160, from the martinpiper fork) share one faithful implementation.
interface Flash040Type {
  manufacturerId: number; deviceId: number; deviceIdAddr: number;
  size: number; sectorMask: number; sectorSize: number; sectorShift: number;
  magic1Addr: number; magic2Addr: number; magic1Mask: number; magic2Mask: number;
  statusToggleBits: number;
  eraseSectorTimeoutCycles: number; eraseSectorCycles: number; eraseChipCycles: number;
}
// AM29F040 (FLASH040_TYPE_NORMAL) — GMOD2.
const FLASH040_NORMAL: Flash040Type = {
  manufacturerId: 0x01, deviceId: 0xa4, deviceIdAddr: 1,
  size: 0x80000, sectorMask: 0x70000, sectorSize: 0x10000, sectorShift: 16,
  magic1Addr: 0x5555, magic2Addr: 0x2aaa, magic1Mask: 0x7fff, magic2Mask: 0x7fff,
  statusToggleBits: 0x40,
  eraseSectorTimeoutCycles: 80, eraseSectorCycles: 2_000_000, eraseChipCycles: 14_000_000,
};
// AM29F040B (FLASH040_TYPE_B) — EasyFlash.
const FLASH040B: Flash040Type = {
  manufacturerId: 0x01, deviceId: 0xa4, deviceIdAddr: 1,
  size: 0x80000, sectorMask: 0x70000, sectorSize: 0x10000, sectorShift: 16,
  magic1Addr: 0x555, magic2Addr: 0x2aa, magic1Mask: 0x7ff, magic2Mask: 0x7ff,
  statusToggleBits: 0x40,
  eraseSectorTimeoutCycles: 50, eraseSectorCycles: 1_000_000, eraseChipCycles: 8_000_000,
};
// M29F160FT (FLASH040_TYPE_160, martinpiper fork) — C64MegaCart. 2MB,
// device id 0xd2 at addr 2, magic 0xaaa/0x555 mask 0xfff. The fork uses a
// global erase-cycle define; we reuse the TYPE_B busy-window timings.
const FLASH040_160: Flash040Type = {
  manufacturerId: 0x01, deviceId: 0xd2, deviceIdAddr: 2,
  size: 0x200000, sectorMask: 0x7f0000, sectorSize: 0x10000, sectorShift: 16,
  magic1Addr: 0xaaa, magic2Addr: 0x555, magic1Mask: 0xfff, magic2Mask: 0xfff,
  statusToggleBits: 0x40,
  eraseSectorTimeoutCycles: 50, eraseSectorCycles: 1_000_000, eraseChipCycles: 8_000_000,
};
const FLASH040_ERASE_MASK_SIZE = 8;
type Flash040StateName =
  | "read" | "magic1" | "magic2" | "autoselect"
  | "byte_program" | "byte_program_error"
  | "erase_magic1" | "erase_magic2" | "erase_select"
  | "chip_erase" | "sector_erase" | "sector_erase_timeout" | "sector_erase_suspend";
// index order = VICE flash040_state_s enum (for snapshot).
const FLASH040_STATES: Flash040StateName[] = [
  "read", "magic1", "magic2", "autoselect", "byte_program", "byte_program_error",
  "erase_magic1", "erase_magic2", "erase_select", "chip_erase", "sector_erase",
  "sector_erase_timeout", "sector_erase_suspend",
];

class Flash040 {
  private state: Flash040StateName = "read";
  private baseState: Flash040StateName = "read";
  private programByte = 0;
  private lastRead = 0;
  private dirty = false;
  private readonly eraseMask = new Uint8Array(FLASH040_ERASE_MASK_SIZE);
  private eraseAlarmClk = -1;     // absolute maincpu_clk of next erase step; -1 = unset
  clock: () => number = () => 0;  // wired to maincpu_clk at attach

  constructor(readonly data: Uint8Array, readonly label: string, private readonly t: Flash040Type = FLASH040B) {}

  isDirty(): boolean { return this.dirty; }
  /** "operation active" status (command sequence / erase busy). Not a snapshot
   *  veto — the full state is captured. Exposed for UI/debug. */
  isBusy(): boolean { return this.state !== "read"; }
  getData(): Uint8Array { return this.data; }
  loadData(bytes: Uint8Array): void { this.data.set(bytes.subarray(0, this.data.length)); }
  getMode(): string { return `${this.label}:${this.state}`; }

  private magic1(addr: number): boolean { return (addr & this.t.magic1Mask) === this.t.magic1Addr; }
  private magic2(addr: number): boolean { return (addr & this.t.magic2Mask) === this.t.magic2Addr; }
  private sectorNum(addr: number): number { return (addr & this.t.sectorMask) >>> this.t.sectorShift; }

  // VICE erase_alarm_handler, applied lazily for every elapsed step. Each step
  // chains the next alarm off the FIRED alarm's scheduled clk (`fireClk`), not
  // the current clk, so the multi-step erase timeline matches VICE's real alarm
  // exactly regardless of when a read happens to catch it up.
  private catchUpErase(clk: number): void {
    let guard = 0;
    while (this.eraseAlarmClk >= 0 && clk >= this.eraseAlarmClk && guard++ < 256) {
      const fireClk = this.eraseAlarmClk;
      this.eraseAlarmClk = -1; // alarm_unset
      switch (this.state) {
        case "sector_erase_timeout":
          this.eraseAlarmClk = fireClk + this.t.eraseSectorCycles;
          this.state = "sector_erase";
          break;
        case "sector_erase": {
          for (let i = 0; i < 8 * FLASH040_ERASE_MASK_SIZE; i++) {
            const j = i >> 3, m = (1 << (i & 7)) & 0xff;
            if (this.eraseMask[j]! & m) { this.eraseSector(i); this.eraseMask[j]! &= ~m & 0xff; break; }
          }
          let any = 0;
          for (let i = 0; i < FLASH040_ERASE_MASK_SIZE; i++) any |= this.eraseMask[i]!;
          if (any !== 0) this.eraseAlarmClk = fireClk + this.t.eraseSectorCycles;
          else this.state = this.baseState;
          break;
        }
        case "chip_erase":
          this.eraseChip(); this.state = this.baseState;
          break;
        default: break;
      }
    }
  }

  read(addr: number): number {
    // Hot path: in READ state with no pending erase (the overwhelming common
    // case — the CPU fetching code/data from flash) just index the array. No
    // clock() closure, no catch-up — keeps cart execution at full speed.
    if (this.state === "read" && this.eraseAlarmClk < 0) {
      return (this.lastRead = this.data[addr] ?? 0xff);
    }
    const clk = this.clock();
    this.catchUpErase(clk);
    let v: number;
    switch (this.state) {
      case "autoselect": {
        const a = addr & 0xff;
        if (a === 0) v = this.t.manufacturerId;
        else if (a === this.t.deviceIdAddr) v = this.t.deviceId;
        else if (a === 2) v = 0;
        else v = this.data[addr] ?? 0xff;
        break;
      }
      case "byte_program_error":
        v = this.writeOperationStatus(clk);
        break;
      case "sector_erase_suspend":
      case "chip_erase":
      case "sector_erase":
      case "sector_erase_timeout":
        v = this.eraseOperationStatus();
        break;
      default: // read + any in-command state (a read does NOT reset the state)
        v = this.data[addr] ?? 0xff;
        break;
    }
    this.lastRead = v & 0xff;
    return this.lastRead;
  }

  // VICE flash_write_operation_status: DQ7 inverse-of-data, DQ6 toggle, DQ5 timeout.
  private writeOperationStatus(clk: number): number {
    return (((this.programByte ^ 0x80) & 0x80) | ((clk & 2) << 5) | 0x20) & 0xff;
  }
  // VICE flash_erase_operation_status: DQ6 toggle (status_toggle_bits), DQ3 timer.
  private eraseOperationStatus(): number {
    const v = this.programByte;
    this.programByte = (this.programByte ^ this.t.statusToggleBits) & 0xff;
    return (this.state !== "sector_erase_timeout" ? (v | 0x08) : v) & 0xff;
  }

  // VICE flash040core_store_internal.
  store(addr: number, byte: number): void {
    const clk = this.clock();
    this.catchUpErase(clk);
    const b = byte & 0xff;
    switch (this.state) {
      case "read":
        if (this.magic1(addr) && b === 0xaa) this.state = "magic1";
        break;
      case "magic1":
        this.state = (this.magic2(addr) && b === 0x55) ? "magic2" : this.baseState;
        break;
      case "magic2":
        if (this.magic1(addr)) {
          switch (b) {
            case 0x90: this.state = "autoselect"; this.baseState = "autoselect"; break;
            case 0xf0: this.state = "read"; this.baseState = "read"; break;
            case 0xa0: this.state = "byte_program"; break;
            case 0x80: this.state = "erase_magic1"; break;
            default: this.state = this.baseState; break;
          }
        } else this.state = this.baseState;
        break;
      case "byte_program":
        this.state = this.programByteOp(addr, b) ? this.baseState : "byte_program_error";
        break;
      case "erase_magic1":
        this.state = (this.magic1(addr) && b === 0xaa) ? "erase_magic2" : this.baseState;
        break;
      case "erase_magic2":
        this.state = (this.magic2(addr) && b === 0x55) ? "erase_select" : this.baseState;
        break;
      case "erase_select":
        if (this.magic1(addr) && b === 0x10) {
          this.state = "chip_erase"; this.programByte = 0;
          this.eraseAlarmClk = clk + this.t.eraseChipCycles;
        } else if (b === 0x30) {
          this.addSectorToEraseMask(addr); this.programByte = 0;
          this.state = "sector_erase_timeout";
          this.eraseAlarmClk = clk + this.t.eraseSectorTimeoutCycles;
        } else this.state = this.baseState;
        break;
      case "sector_erase_timeout":
        if (b === 0x30) this.addSectorToEraseMask(addr);
        else { this.state = this.baseState; this.eraseMask.fill(0); this.eraseAlarmClk = -1; }
        break;
      case "sector_erase":
        if (b === 0xb0) { this.state = "sector_erase_suspend"; this.eraseAlarmClk = -1; }
        break;
      case "sector_erase_suspend":
        if (b === 0x30) { this.state = "sector_erase"; this.eraseAlarmClk = clk + this.t.eraseSectorCycles; }
        break;
      case "byte_program_error":
      case "autoselect":
        if (this.magic1(addr) && b === 0xaa) this.state = "magic1";
        if (b === 0xf0) { this.state = "read"; this.baseState = "read"; }
        break;
      case "chip_erase":
      default:
        break;
    }
  }

  private programByteOp(addr: number, byte: number): boolean {
    const old = this.data[addr] ?? 0xff;
    const next = old & byte; // AM29F040: a program can only clear bits (1 -> 0)
    this.programByte = byte;
    this.data[addr] = next;
    this.dirty = true;
    return next === byte; // false → byte_program_error (a 0->1 was requested)
  }
  private eraseSector(sector: number): void {
    const start = sector * this.t.sectorSize;
    this.data.fill(0xff, start, Math.min(start + this.t.sectorSize, this.data.length));
    this.dirty = true;
  }
  private eraseChip(): void { this.data.fill(0xff); this.dirty = true; }
  private addSectorToEraseMask(addr: number): void {
    const s = this.sectorNum(addr);
    this.eraseMask[s >> 3]! |= (1 << (s & 7)) & 0xff;
  }

  snapshotState(): Flash040SnapState {
    return {
      state: FLASH040_STATES.indexOf(this.state),
      baseState: FLASH040_STATES.indexOf(this.baseState),
      programByte: this.programByte, lastRead: this.lastRead, dirty: this.dirty,
      eraseMask: Array.from(this.eraseMask), eraseAlarmClk: this.eraseAlarmClk,
    };
  }
  restoreState(s: Flash040SnapState): void {
    this.state = FLASH040_STATES[s.state] ?? "read";
    this.baseState = FLASH040_STATES[s.baseState] ?? "read";
    this.programByte = s.programByte & 0xff;
    this.lastRead = s.lastRead & 0xff;
    this.dirty = !!s.dirty;
    if (Array.isArray(s.eraseMask)) this.eraseMask.set(s.eraseMask.slice(0, FLASH040_ERASE_MASK_SIZE));
    this.eraseAlarmClk = typeof s.eraseAlarmClk === "number" ? s.eraseAlarmClk : -1;
  }
}

// VICE easyflash_memconfig[(jumper<<3)|(register_02 & 0x07)] → CMODE
// (0=8k, 1=16k, 2=RAM/off, 3=ultimax). easyflash.c.
const EASYFLASH_MEMCONFIG: readonly number[] = [
  3, 3, 1, 1, 2, 3, 0, 1, // jumper off (mode 0 | mode 1)
  2, 3, 0, 1, 2, 3, 0, 1, // jumper on  (mode 0 | mode 1)
];
type EasyFlashMode = "8k" | "16k" | "off" | "ultimax";
const CMODE_TO_MODE: readonly EasyFlashMode[] = ["8k", "16k", "off", "ultimax"];

class EasyFlashMapper extends BaseMapper {
  private register02 = 0x00;          // VICE easyflash_register_02 (& 0x87)
  private jumper = 0;                 // VICE easyflash_jumper
  private readonly ioRam = new Uint8Array(256); // VICE easyflash_ram ($DF00-$DFFF IO2)
  private readonly loFlash: Flash040;
  private readonly hiFlash: Flash040;

  constructor(image: ParsedCartridgeImage) {
    super(image);
    const lowData = buildLinearChipData(image, (bank) => bank.roml, 64);
    const highData = buildLinearChipData(image, (bank) => bank.romhA000 ?? bank.romhE000, 64);
    // VICE easyflash.c: if the EAPI signature "eapi" is present at romh bank-0
    // $1800 (= $B800), replace the cart's EAPI with VICE's known-good
    // eapiam29f040 block — cart EAPIs vary / assume real-HW timing; the
    // replacement drives this flash040 port correctly (incl. the loader's
    // EAPIReadFlashInc bank walk + flash write/erase status polling).
    if (highData.length >= 0x1800 + 768 &&
        highData[0x1800] === 0x65 && highData[0x1801] === 0x61 &&
        highData[0x1802] === 0x70 && highData[0x1803] === 0x69) {
      highData.set(EAPI_AM29F040, 0x1800);
    }
    this.loFlash = new Flash040(lowData, "easyflash-lo");
    this.hiFlash = new Flash040(highData, "easyflash-hi");
    // VICE easyflash_powerup: IO2 RAM init with a pattern (not zeros), see
    // sourceforge bug 469. ramparam {start 255, value_invert 2, offset 1} →
    // FF 00 00 FF FF 00 00 FF ... (no random component).
    for (let i = 0; i < 256; i++) this.ioRam[i] = (((i + 1) >> 1) & 1) ? 0x00 : 0xff;
  }

  /** Spec 713 — wire the live maincpu_clk into the flash chips (erase busy
   *  window + DQ6 toggle). Called by the memory bus at attach. */
  setClock(clk: () => number): void {
    this.loFlash.clock = clk;
    this.hiFlash.clock = clk;
  }

  private chipOffsetForWindow(address: number): number {
    const relative = address >= 0xe000 ? resolveRelativeOffset(0xe000, address)
      : address >= 0xa000 ? resolveRelativeOffset(0xa000, address)
      : resolveRelativeOffset(0x8000, address);
    return (this.currentBank << 13) | relative;
  }

  private currentMode(): EasyFlashMode {
    const cmode = EASYFLASH_MEMCONFIG[((this.jumper << 3) | (this.register02 & 0x07)) & 0x0f] ?? 2;
    return CMODE_TO_MODE[cmode] ?? "off";
  }

  getLines(): HeadlessCartridgeLines {
    switch (this.currentMode()) {
      case "off": return { exrom: 1, game: 1 };
      case "ultimax": return { exrom: 1, game: 0 };
      case "8k": return { exrom: 0, game: 1 };
      case "16k": return { exrom: 0, game: 0 };
    }
  }

  getState(): HeadlessCartridgeState {
    const state = super.getState();
    state.controlRegister = this.register02;
    state.writable = true;
    state.flashMode = `${this.currentMode()} [${this.loFlash.getMode()},${this.hiFlash.getMode()}]`;
    // Spec 713/714.5 — EasyFlash continuation state (small; flash DATA rides in
    // the separate cartFlash payload via getWritableImage).
    state.easyflashJumper = this.jumper;
    state.easyflashRam = Array.from(this.ioRam);
    state.flashLoState = this.loFlash.snapshotState();
    state.flashHiState = this.hiFlash.snapshotState();
    return state;
  }

  setState(state: HeadlessCartridgeState): void {
    super.setState(state); // currentBank + setControlRegister (register02)
    if (typeof state.easyflashJumper === "number") this.jumper = state.easyflashJumper & 1;
    if (Array.isArray(state.easyflashRam)) this.ioRam.set(state.easyflashRam.slice(0, 256));
    if (state.flashLoState) this.loFlash.restoreState(state.flashLoState);
    if (state.flashHiState) this.hiFlash.restoreState(state.flashHiState);
  }

  // Spec 713/714.5 — EasyFlash writable hardware state is now VICE-faithful
  // (flash command-state machine + program semantics + IO2 RAM are captured), so
  // a written/mid-command EasyFlash is persistable, not rejected.
  persistsWritableState(): boolean { return true; }

  getWritableImage(): Uint8Array {
    const lo = this.loFlash.getData();
    const hi = this.hiFlash.getData();
    const out = new Uint8Array(lo.length + hi.length);
    out.set(lo, 0);
    out.set(hi, lo.length);
    return out;
  }

  setWritableImage(bytes: Uint8Array): void {
    const loLen = this.loFlash.getData().length;
    this.loFlash.loadData(bytes.subarray(0, loLen));
    this.hiFlash.loadData(bytes.subarray(loLen));
  }

  // Spec 713 §1 — the memory bus routes every access through the active VICE
  // memconfig (the PLA) and calls these ONLY for the windows the current config
  // maps to the cart. The mapper therefore responds purely by address and does
  // NOT re-derive visibility (= "nicht im Mapper an der PLA vorbei antworten").
  // VICE equivalents: easyflash_roml_read / easyflash_romh_read / easyflash_io2_read.
  read(address: number, _bankInfo: HeadlessBankInfo): number | undefined {
    if (address >= 0xdf00 && address <= 0xdfff) return this.ioRam[address & 0xff]; // IO2 RAM
    const offset = this.chipOffsetForWindow(address);
    if (address >= 0x8000 && address <= 0x9fff) return this.loFlash.read(offset); // ROML
    if (address >= 0xa000 && address <= 0xbfff) return this.hiFlash.read(offset); // ROMH @ $A000 (16k)
    if (address >= 0xe000 && address <= 0xffff) return this.hiFlash.read(offset); // ROMH @ $E000 (ultimax)
    return undefined;
  }

  write(address: number, value: number, _bankInfo: HeadlessBankInfo): boolean {
    // VICE easyflash_io1_store: IO1 ($DE00-$DEFF) decodes `addr & 2` — even = bank
    // register (& 0x3f), odd-bit1 = mode register (& 0x87). So $DE04 mirrors
    // $DE00 and $DE06 mirrors $DE02.
    if (address >= 0xde00 && address <= 0xdeff) {
      if (address & 2) this.register02 = value & 0x87;
      else this.currentBank = value & 0x3f;
      return true;
    }
    if (address >= 0xdf00 && address <= 0xdfff) { // IO2 RAM
      this.ioRam[address & 0xff] = value & 0xff;
      return true;
    }
    // Flash programming (AMD command state machine). VICE programs the flash
    // ONLY in ULTIMAX: $8000-$9FFF → easyflash_roml_store (flash_low), $E000-$FFFF
    // → easyflash_romh_store (flash_high). In 8K/16K the ROM-window write hook is
    // roml_no_ultimax_store / romh_no_ultimax_store → ram_store, so we return
    // false and let the bus write the RAM underneath. Returning true consumes the
    // write (no RAM); returning false = pass through to RAM.
    if (this.currentMode() === "ultimax") {
      const offset = this.chipOffsetForWindow(address);
      if (address >= 0x8000 && address <= 0x9fff) { this.loFlash.store(offset, value); return true; }
      if (address >= 0xe000 && address <= 0xffff) { this.hiFlash.store(offset, value); return true; }
    }
    return false;
  }

  protected getControlRegister(): number { return this.register02; }
  protected setControlRegister(v: number | undefined): void {
    this.register02 = (v ?? 0x00) & 0x87; // VICE register_02 mask
  }

  isWritableDirty(): boolean {
    // Spec 714.5 — "modified" status only (flash data mutated). NOT a snapshot
    // veto and NOT mid-command — the command state is now captured.
    return this.loFlash.isDirty() || this.hiFlash.isDirty();
  }
}

function createMegabyterSectors(): FlashSectorLayout[] {
  return [
    { start: 0x00000, size: 0x04000 },
    { start: 0x04000, size: 0x02000 },
    { start: 0x06000, size: 0x02000 },
    { start: 0x08000, size: 0x08000 },
    ...createUniformSectors(0x100000 - 0x10000, 0x10000).map((sector) => ({
      start: sector.start + 0x10000,
      size: sector.size,
    })),
  ];
}

class MegabyterMapper extends BaseMapper {
  private bankRegister = 0x00;
  private controlRegister = 0x00;
  private readonly flash: AmdFlashChip;

  constructor(image: ParsedCartridgeImage) {
    super(image);
    const data = buildLinearChipData(image, (bank) => bank.roml, 128);
    this.flash = new AmdFlashChip({
      label: "megabyter",
      data,
      commandAddress1: 0x0aaa,
      commandAddress2: 0x0555,
      commandAddressMask: 0x1fff,
      manufacturerId: 0xc2,
      deviceId: 0x58,
      sectors: createMegabyterSectors(),
    });
  }

  getLines(): HeadlessCartridgeLines {
    switch (this.controlRegister & 0x03) {
      case 0x00:
        return { exrom: 0, game: 1 };
      case 0x01:
        return { exrom: 0, game: 0 };
      case 0x02:
        return { exrom: 1, game: 1 };
      case 0x03:
        return { exrom: 1, game: 0 };
      default:
        return { exrom: 1, game: 1 };
    }
  }

  getState(): HeadlessCartridgeState {
    const state = super.getState();
    state.currentBank = this.bankRegister;
    state.controlRegister = this.controlRegister;
    state.writable = true;
    state.flashMode = `${this.currentMode()} [${this.flash.getMode()}]`;
    return state;
  }

  setState(state: HeadlessCartridgeState): void {
    // Spec 709.7 — Megabyter banks via bankRegister (mapped to currentBank in
    // getState); restore both registers. Flash-write state is deferred (v1).
    this.bankRegister = (state.currentBank ?? 0) & 0xff;
    this.controlRegister = (state.controlRegister ?? 0) & 0xff;
  }

  isWritableDirty(): boolean {
    return this.flash.isDirty(); // Spec 709.11b
  }

  read(address: number, bankInfo: HeadlessBankInfo): number | undefined {
    if (this.currentMode() === "off") {
      return undefined;
    }
    if (address >= 0x8000 && address <= 0x9fff) {
      return this.flash.read(this.chipOffsetForWindow(0x8000, address));
    }
    if (address >= 0xe000 && address <= 0xffff && this.currentMode() === "ultimax") {
      return this.flash.read(this.chipOffsetForWindow(0xe000, address));
    }
    return super.read(address, bankInfo);
  }

  write(address: number, value: number, _bankInfo: HeadlessBankInfo): boolean {
    if (address === 0xde00) {
      this.bankRegister = value & 0x7f;
      this.currentBank = this.bankRegister;
      return true;
    }
    if (address === 0xde02) {
      this.controlRegister = value & 0x03;
      return true;
    }
    if (this.currentMode() !== "ultimax") {
      return false;
    }
    if (address >= 0x8000 && address <= 0x9fff) {
      return this.flash.write(this.chipOffsetForWindow(0x8000, address), value);
    }
    if (address >= 0xe000 && address <= 0xffff) {
      return this.flash.write(this.chipOffsetForWindow(0xe000, address), value);
    }
    return false;
  }

  protected romhA000Visible(): boolean {
    return false;
  }

  protected romhE000Visible(): boolean {
    return this.currentMode() === "ultimax";
  }

  protected romlVisible(): boolean {
    return this.currentMode() !== "off";
  }

  protected getControlRegister(): number {
    return this.controlRegister;
  }

  private currentMode(): "8k" | "off" | "ultimax" {
    switch (this.controlRegister & 0x03) {
      case 0x02:
        return "off";
      case 0x03:
        return "ultimax";
      default:
        return "8k";
    }
  }

  private chipOffsetForWindow(baseAddress: number, address: number): number {
    return (this.bankRegister << 13) | resolveRelativeOffset(baseAddress, address);
  }
}

// Sprint 87 (Spec 087) — GMOD2 mapper (Individual Computers).
// 512 KB Flash + 2 KB EEPROM. v1 implements bank switching via
// $DE00 (bits 0-5 = bank, bit 6 = flash visible/disabled). EEPROM
// SDA/CLK simulation (bit 7 + bit 6) deferred to R31 backlog.
class Gmod2Mapper extends BaseMapper {
  write(address: number, value: number): boolean {
    if (address === 0xde00) {
      this.currentBank = value & 0x3f;
      // bit 6 = exrom (1 = released, 0 = asserted) per GMOD2 docs
      // simplification: cart visible while bank-select active
      return true;
    }
    return false;
  }
}

// GMOD3 — 16 MB Flash version of GMOD2. Same banking via $DE00 +
// extended bank select via $DE02. v1 only handles low-byte bank select.
class Gmod3Mapper extends BaseMapper {
  write(address: number, value: number): boolean {
    if (address === 0xde00) {
      this.currentBank = (this.currentBank & 0xff00) | (value & 0xff);
      return true;
    }
    if (address === 0xde02) {
      this.currentBank = ((value & 0xff) << 8) | (this.currentBank & 0xff);
      return true;
    }
    return false;
  }
}

