import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { HeadlessBankInfo, HeadlessCartridgeMapperType, HeadlessCartridgeState, Flash040SnapState } from "./types.js";

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
    case "c64megacart":
      return new C64MegaCartMapper(image);
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

// Spec 713 — source-faithful port of VICE flash040core.c (AM29F040B / FLASH040
// TYPE_B, as EasyFlash uses). Full command state machine + base_state, AM29F040
// program semantics (`old & byte` — a bit only flips 1->0 without an erase),
// autoselect ID reads, and a program-error status read. Snapshot/restore the
// command-state continuation so a checkpoint mid-unlock/mid-command resumes
// identically (VICE flash040core_snapshot_*).
//
// DOCUMENTED SIMPLIFICATION vs VICE: erase completes ATOMICALLY on the final
// command byte (no erase_alarm timing / sector-erase-timeout accumulation
// window). The erased DATA is identical to VICE; only the multi-cycle erase
// TIMING + toggle-bit polling window are not modeled (the active EasyFlash
// corpus does not erase at runtime). flash_state therefore never rests in a
// CHIP_ERASE / SECTOR_ERASE state, so there is no mid-erase continuation to
// snapshot. Spec 714.5 §5 gate 5 (mid-erase continuation) is N/A under this
// model; the data result is gated instead.
const FLASH040B = {
  magic1Addr: 0x555, magic2Addr: 0x2aa, magicMask: 0x7ff,
  manufacturerId: 0x01, deviceId: 0xa4, deviceIdAddr: 1, sectorSize: 0x10000,
} as const;
type Flash040StateName =
  | "read" | "magic1" | "magic2" | "autoselect"
  | "byte_program" | "byte_program_error"
  | "erase_magic1" | "erase_magic2" | "erase_select";
const FLASH040_STATES: Flash040StateName[] = [
  "read", "magic1", "magic2", "autoselect", "byte_program",
  "byte_program_error", "erase_magic1", "erase_magic2", "erase_select",
];

class Flash040 {
  private state: Flash040StateName = "read";
  private baseState: Flash040StateName = "read";
  private programByte = 0;
  private lastRead = 0;
  private dirty = false;

  constructor(readonly data: Uint8Array, readonly label: string) {}

  isDirty(): boolean { return this.dirty; }
  /** Spec 714.5 — "operation active" status (mid command sequence). NOT a
   *  snapshot veto: the command state is captured, so a checkpoint here is
   *  restorable. Exposed for UI/debug only. */
  isBusy(): boolean { return this.state !== "read"; }
  getData(): Uint8Array { return this.data; }
  loadData(bytes: Uint8Array): void { this.data.set(bytes.subarray(0, this.data.length)); }
  getMode(): string { return `${this.label}:${this.state}`; }

  private magic1(addr: number): boolean { return (addr & FLASH040B.magicMask) === FLASH040B.magic1Addr; }
  private magic2(addr: number): boolean { return (addr & FLASH040B.magicMask) === FLASH040B.magic2Addr; }

  read(addr: number): number {
    let v: number;
    switch (this.state) {
      case "autoselect": {
        const a = addr & 0xff;
        if (a === 0) v = FLASH040B.manufacturerId;
        else if (a === FLASH040B.deviceIdAddr) v = FLASH040B.deviceId;
        else if (a === 2) v = 0;
        else v = this.data[addr] ?? 0xff;
        break;
      }
      case "byte_program_error":
        // VICE flash_write_operation_status: DQ5 (error/timeout) + DQ6 toggle.
        v = ((this.lastRead ^ 0x40) | 0x20) & 0xff;
        break;
      default: // "read" + any in-command state (a read does NOT reset the state)
        v = this.data[addr] ?? 0xff;
        break;
    }
    this.lastRead = v;
    return v;
  }

  // VICE flash040core_store_internal (atomic erase variant).
  store(addr: number, byte: number): void {
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
        if (this.magic1(addr) && b === 0x10) this.chipErase();
        else if (b === 0x30) this.sectorErase(addr);
        this.state = this.baseState; // atomic erase: complete immediately, no timeout window
        break;
      case "byte_program_error":
      case "autoselect":
        if (this.magic1(addr) && b === 0xaa) this.state = "magic1";
        if (b === 0xf0) { this.state = "read"; this.baseState = "read"; }
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
  private chipErase(): void { this.data.fill(0xff); this.dirty = true; }
  private sectorErase(addr: number): void {
    const start = Math.floor(addr / FLASH040B.sectorSize) * FLASH040B.sectorSize;
    this.data.fill(0xff, start, Math.min(start + FLASH040B.sectorSize, this.data.length));
    this.dirty = true;
  }

  snapshotState(): Flash040SnapState {
    return {
      state: FLASH040_STATES.indexOf(this.state),
      baseState: FLASH040_STATES.indexOf(this.baseState),
      programByte: this.programByte, lastRead: this.lastRead, dirty: this.dirty,
    };
  }
  restoreState(s: Flash040SnapState): void {
    this.state = FLASH040_STATES[s.state] ?? "read";
    this.baseState = FLASH040_STATES[s.baseState] ?? "read";
    this.programByte = s.programByte & 0xff;
    this.lastRead = s.lastRead & 0xff;
    this.dirty = !!s.dirty;
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
    this.loFlash = new Flash040(lowData, "easyflash-lo");
    this.hiFlash = new Flash040(highData, "easyflash-hi");
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

  read(address: number, bankInfo: HeadlessBankInfo): number | undefined {
    if (address >= 0xdf00 && address <= 0xdfff) return this.ioRam[address & 0xff]; // IO2 RAM
    const offset = this.chipOffsetForWindow(address);
    if (address >= 0x8000 && address <= 0x9fff && this.romlVisible(bankInfo)) return this.loFlash.read(offset);
    if (address >= 0xa000 && address <= 0xbfff && this.romhA000Visible(bankInfo)) return this.hiFlash.read(offset);
    if (address >= 0xe000 && address <= 0xffff && this.romhE000Visible(bankInfo)) return this.hiFlash.read(offset);
    return undefined;
  }

  write(address: number, value: number, bankInfo: HeadlessBankInfo): boolean {
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
    // Flash window writes: the flash chip on ROML/ROMH sees the write (AMD
    // command state machine / programming) AND the C64 RAM underneath is written
    // too — on real HW writes to $8000-$BFFF / $E000-$FFFF always reach RAM,
    // shadowed by the cart ROM on read while mapped and revealed when the cart
    // switches off. So run flash.store for programming but return FALSE so the
    // memory bus ALSO writes the underlying RAM; otherwise data a program stores
    // under the cart window (its copied graphics / colour tables, read back after
    // the cart is disabled) is silently lost.
    const offset = this.chipOffsetForWindow(address);
    if (address >= 0x8000 && address <= 0x9fff && this.romlVisible(bankInfo)) { this.loFlash.store(offset, value); return false; }
    if (address >= 0xa000 && address <= 0xbfff && this.romhA000Visible(bankInfo)) { this.hiFlash.store(offset, value); return false; }
    if (address >= 0xe000 && address <= 0xffff && this.romhE000Visible(bankInfo)) { this.hiFlash.store(offset, value); return false; }
    return false;
  }

  protected romhA000Visible(_bankInfo: HeadlessBankInfo): boolean {
    const mode = this.currentMode();
    return mode === "16k" || mode === "ultimax";
  }
  protected romhE000Visible(_bankInfo: HeadlessBankInfo): boolean {
    return this.currentMode() === "ultimax";
  }
  protected romlVisible(_bankInfo: HeadlessBankInfo): boolean {
    return this.currentMode() !== "off";
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

// C64MegaCart — multi-game cart with simple $DE00 bank select.
class C64MegaCartMapper extends BaseMapper {
  write(address: number, value: number): boolean {
    if (address === 0xde00) {
      this.currentBank = value & 0x7f;
      return true;
    }
    return false;
  }
}
