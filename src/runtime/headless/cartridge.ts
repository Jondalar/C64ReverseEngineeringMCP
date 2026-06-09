import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { HeadlessBankInfo, HeadlessCartridgeMapperType, HeadlessCartridgeState, Flash040SnapState } from "./types.js";
import { EAPI_AM29F040 } from "./eapi-am29f040.js";
import { M93c86 } from "./m93c86.js";
import { SpiFlash } from "./spi-flash.js";

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
  /** BUG-023-cart / Spec 742 — the original .crt bytes, kept so a writable
   *  mapper can re-pack its mutated flash back into a valid .crt (CHIP packets
   *  overwritten in place) for host-file write-back. */
  rawBytes: Uint8Array;
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
  /** Spec 754 §3.4 / BUG-038 — side-effect-free cartridge peek (VICE
   *  `*_peek` analog) for the bank lens. Returns the ROM-window byte (ROML
   *  $8000-$9FFF / ROMH $A000-$BFFF / $E000-$FFFF) for the CURRENT bank
   *  WITHOUT advancing any flash command-state machine, toggling DQ6/DQ3
   *  status, clocking a serial EEPROM/SPI line, or mutating `lastRead`.
   *  Returns undefined when the window/IO is not mapped by this cart (the
   *  bus then falls back to RAM / open-bus). Optional — a mapper that can
   *  only answer via a side-effecting path omits it (best-effort fallback). */
  peek?(address: number, bankInfo: HeadlessBankInfo): number | undefined;
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
  /** BUG-023-cart / Spec 742 — re-pack the live mutated flash back into a valid
   *  .crt byte image (the original .crt with each CHIP packet's data overwritten
   *  from the current flash), for host-file write-back on eject/persist. Null
   *  when the mapper cannot produce one. */
  getCrtImage?(): Uint8Array | null;
  /** Spec 713 — wire the live maincpu_clk into writable hardware that needs it
   *  (flash erase busy window / status toggle). The bus calls this at attach. */
  setClock?(clk: () => number): void;
  /** Spec 713 (audit #4) — wire the live vicii_read_phi1() float-bus value into
   *  mappers whose IO reads mix in open-bus low bits (GMOD2 EEPROM read =
   *  (data<<7)|(phi1&0x7f)). The bus calls this at attach with its phi1 source. */
  setPhi1?(phi1: () => number): void;
  /** Spec 713 (audit) — wire VICE `mem_read_without_ultimax` for fake-ultimax
   *  mappers whose romh_read falls through to the normal CPU-port C64 map without
   *  the cart overlay (GMOD3 $E000-$FFF7 → KERNAL/BASIC/IO/RAM per $01, NOT raw RAM). */
  setReadWithoutUltimax?(read: (addr: number) => number): void;
  /** The expansion-port RESET line. A C64 reset (RESET button or power-cycle)
   *  also resets the cartridge: its bank + mode/control registers return to the
   *  power-on/config value, so GAME/EXROM re-vector $FFFC from the cart (e.g.
   *  EasyFlash → ultimax boot → the machine reboots INTO the cart, like real
   *  hardware). VICE: cartridge_reset() re-applies each cart's config on a
   *  machine reset. Non-volatile flash/EEPROM DATA is preserved across a reset;
   *  only the bank/mode/line + serial-select latches reset. The memory bus calls
   *  this from its own reset()/resetCpuPortKeepRam() BEFORE the CPU fetches the
   *  reset vector. Optional only so minimal test-double carts may omit it; every
   *  real mapper implements it via BaseMapper. */
  reset?(): void;
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
    case "c64megacart":
      return new C64MegaCartMapper(image);
    default:
      // Spec 713 — a type with no authoritative VICE source is not a supported
      // VICE-faithful cartridge; report unsupported rather than keep an invented
      // proxy mapper.
      throw new Error(`Unsupported cartridge type "${image.mapperType}" — no authoritative VICE implementation.`);
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
    rawBytes: new Uint8Array(data),
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
    case 60:
      return "gmod2";           // CARTRIDGE_GMOD2
    case 61:
      return "c64megacart";     // CARTRIDGE_C64MEGACART (martinpiper fork)
    case 62:
      return "gmod3";           // CARTRIDGE_GMOD3
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

  // Spec 754 §3.4 / BUG-038 — side-effect-free peek. The BaseMapper read()
  // path (and OceanMapper's, MagicDesk's) is already a pure array index with
  // no command-state / latch mutation, so peek == read for these families.
  // Flash/serial-backed mappers (EasyFlash, MegaByter, GMOD2/3, C64MegaCart)
  // override this to avoid advancing the flash command machine / clocking the
  // EEPROM/SPI line.
  peek(address: number, bankInfo: HeadlessBankInfo): number | undefined {
    return this.read(address, bankInfo);
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

  // Default RESET-line behaviour: bank 0. Stateless 8K/16K/Ultimax carts have
  // static GAME/EXROM (from the CRT header), so only the bank needs clearing.
  // Banked / flash / serial mappers override to also clear their control
  // register, mode and serial-select latches (DATA is preserved — see reset()).
  reset(): void { this.currentBank = 0; }
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
  // VICE magicdesk_config_init: io1_store($DE00,0) → bank 0, EXROM asserted (8K).
  reset(): void { super.reset(); this.regval = 0; }
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
  // VICE magicdesk16_config_init: io1_store($DE00,0) → bank 0, 16K game.
  reset(): void { super.reset(); this.regval = 0; }
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
  // VICE ocean_config_init: io1_store($DE00,0) → bank 0 (size-fixed lines).
  reset(): void { super.reset(); this.regval = 0; }
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
// MX29F800CB (FLASH800_TYPE_CB) — MegaByter. VICE core/flash800core.c is the same
// AMD command state machine as flash040core (identical states + `old & byte`
// program), just a different device row, so it reuses the Flash040 class. 1MB,
// mfg 0xc2 / dev 0x58, magic 0xaaa/0x555 mask 0xfff.
const FLASH800_CB: Flash040Type = {
  manufacturerId: 0xc2, deviceId: 0x58, deviceIdAddr: 1,
  size: 0x100000, sectorMask: 0x0f0000, sectorSize: 0x10000, sectorShift: 16,
  magic1Addr: 0xaaa, magic2Addr: 0x555, magic1Mask: 0xfff, magic2Mask: 0xfff,
  statusToggleBits: 0x40,
  eraseSectorTimeoutCycles: 40, eraseSectorCycles: 700_000, eraseChipCycles: 8_000_000,
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
  /** Spec 713 (audit #5) — apply any erase steps due at the live clk. VICE's
   *  erase_alarm_handler fires independently of flash access, so every
   *  capture/inspect point (snapshot, writable-image, status) must catch up
   *  first or it serialises stale (un-erased) data when a checkpoint lands past
   *  completion without an intervening flash read/store. */
  catchUp(): void { this.catchUpErase(this.clock()); }
  getData(): Uint8Array { this.catchUp(); return this.data; }
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

  /** Spec 754 §3.4 / BUG-038 — side-effect-free flash array byte. Ignores the
   *  command-state machine + erase busy status (no DQ6/DQ3/DQ7 toggling, no
   *  catch-up, no lastRead mutation): just the stored array byte, which is the
   *  ROM contents the CPU sees in the plain READ state. Best-effort for a chip
   *  mid-command/erase (a peek is a debugger view, not a bus read). */
  peek(addr: number): number {
    return this.data[addr] ?? 0xff;
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
    this.catchUp(); // audit #5 — capture post-alarm state, not stale lazy state
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

  // BUG-023-cart / Spec 742 — re-pack the live flash back into the original .crt
  // structure: copy the original bytes and overwrite each CHIP packet's data
  // from the matching flash bank (ROML→loFlash, ROMH→hiFlash). Bank b lives at
  // b<<13 in each flash (buildLinearChipData layout). Preserves header / names /
  // load addresses / chip order exactly — only data changes (VICE-faithful save).
  getCrtImage(): Uint8Array | null {
    const orig = this.image.rawBytes;
    if (!orig || orig.length < 0x40) return null;
    const out = new Uint8Array(orig);
    const lo = this.loFlash.getData();
    const hi = this.hiFlash.getData();
    const headerLen = readU32Be(out, 0x10);
    let offset = headerLen;
    while (offset + 0x10 <= out.length) {
      if (Buffer.from(out.subarray(offset, offset + 4)).toString("ascii") !== "CHIP") break;
      const packetLen = readU32Be(out, offset + 4);
      const bank = readU16Be(out, offset + 10);
      const loadAddress = readU16Be(out, offset + 12);
      const size = readU16Be(out, offset + 14);
      const dataOff = offset + 16;
      const bankOff = bank << 13;
      const first = Math.min(size, 0x2000);
      const src = loadAddress === 0x8000 ? lo : hi; // $A000/$E000 → ROMH
      if (bankOff + first <= src.length && dataOff + first <= out.length) {
        out.set(src.subarray(bankOff, bankOff + first), dataOff);
      }
      // 16K chip ($8000 carrying ROML+ROMH): second 8K from hiFlash.
      if (loadAddress === 0x8000 && size > 0x2000) {
        const second = size - 0x2000;
        if (bankOff + second <= hi.length && dataOff + 0x2000 + second <= out.length) {
          out.set(hi.subarray(bankOff, bankOff + second), dataOff + 0x2000);
        }
      }
      offset += packetLen;
    }
    return out;
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

  // Spec 754 §3.4 / BUG-038 — side-effect-free peek: flash array byte via
  // Flash040.peek (no command-state advance / DQ status toggle). IO2 RAM is a
  // plain array read (already side-effect-free).
  peek(address: number, _bankInfo: HeadlessBankInfo): number | undefined {
    if (address >= 0xdf00 && address <= 0xdfff) return this.ioRam[address & 0xff];
    const offset = this.chipOffsetForWindow(address);
    if (address >= 0x8000 && address <= 0x9fff) return this.loFlash.peek(offset);
    if (address >= 0xa000 && address <= 0xbfff) return this.hiFlash.peek(offset);
    if (address >= 0xe000 && address <= 0xffff) return this.hiFlash.peek(offset);
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

  // VICE easyflash_config_init: io1_store($DE00,0)=bank 0 + io1_store($DE02,0)=
  // mode 0 → memconfig[jumper<<3] = ULTIMAX (exrom=1,game=0) so $E000-$FFFF maps
  // from the cart and $FFFC re-vectors INTO the cart on reset. The physical
  // jumper, the IO2 RAM and the (non-volatile) flash DATA are preserved.
  reset(): void { super.reset(); this.register02 = 0x00; }
}

// VICE megabyter.c — Protovision MegaByter. 1MB Flash (MX29F800CB via
// flash800core, 128×8K banks, ROML only). IO1 ($DE00): addr bit1 → register_02
// (mode bits 0-1 + LED bit7), else register_00 (ROM bank & 0x7f). Mode index →
// memconfig[0..3] = 8K / 16K / RAM(off) / ULTIMAX. Flash is read AND programmed
// at ROML $8000-$9FFF (roml_read / roml_store → flash800core); the cart has no
// ROMH. Replaces the old approximate AmdFlashChip path.
class MegabyterMapper extends BaseMapper {
  private register00 = 0;   // bank
  private register02 = 0;   // mode (bits 0-1) + LED (bit 7)
  private readonly flash: Flash040;

  constructor(image: ParsedCartridgeImage) {
    super(image);
    this.flash = new Flash040(buildLinearChipData(image, (b) => b.roml, 128), "megabyter", FLASH800_CB);
  }

  setClock(clk: () => number): void { this.flash.clock = clk; }
  private flashOffset(address: number): number { return ((this.register00 * 0x2000) + (address & 0x1fff)) >>> 0; }

  getLines(): HeadlessCartridgeLines {
    switch (this.register02 & 0x03) {
      case 0x00: return { exrom: 0, game: 1 }; // 8K
      case 0x01: return { exrom: 0, game: 0 }; // 16K
      case 0x02: return { exrom: 1, game: 1 }; // RAM (off)
      default:   return { exrom: 1, game: 0 }; // ULTIMAX
    }
  }

  read(address: number, _bankInfo: HeadlessBankInfo): number | undefined {
    if (address >= 0x8000 && address <= 0x9fff) return this.flash.read(this.flashOffset(address));
    return undefined; // ROML-only cart; upper windows are not mapped by MegaByter
  }

  // Spec 754 §3.4 / BUG-038 — side-effect-free peek of the ROML flash window.
  peek(address: number, _bankInfo: HeadlessBankInfo): number | undefined {
    if (address >= 0x8000 && address <= 0x9fff) return this.flash.peek(this.flashOffset(address));
    return undefined;
  }

  write(address: number, value: number, _bankInfo: HeadlessBankInfo): boolean {
    if (address >= 0xde00 && address <= 0xdeff) {
      if (address & 2) this.register02 = value & 0x83;
      else this.register00 = value & 0x7f;
      this.currentBank = this.register00;
      return true;
    }
    // Flash is programmed ONLY in ultimax (VICE roml_store → megabyter_roml_store →
    // flash800core_store). In 8K/16K the $8000 write hook is roml_no_ultimax_store,
    // and MegaByter is NOT in its switch → ram_store: the write falls through to the
    // RAM underneath. So return false in non-ultimax so the bus writes RAM (Lykia
    // stages code into $9Fxx-RAM under the ROML, then banks ROML out and runs it).
    if (address >= 0x8000 && address <= 0x9fff) {
      if ((this.register02 & 0x03) === 0x03) { this.flash.store(this.flashOffset(address), value); return true; }
      return false;
    }
    return false;
  }

  getState(): HeadlessCartridgeState {
    const state = super.getState();
    state.currentBank = this.register00;
    state.controlRegister = this.register02;
    state.writable = true;
    state.flashMode = `megabyter:${this.register02 & 0x03} [${this.flash.getMode()}]`;
    state.flashLoState = this.flash.snapshotState();
    return state;
  }

  setState(state: HeadlessCartridgeState): void {
    this.register00 = (state.currentBank ?? 0) & 0x7f;
    this.register02 = (state.controlRegister ?? 0) & 0x83;
    this.currentBank = this.register00;
    if (state.flashLoState) this.flash.restoreState(state.flashLoState);
  }

  persistsWritableState(): boolean { return true; }
  isWritableDirty(): boolean { return this.flash.isDirty(); }
  getWritableImage(): Uint8Array { return new Uint8Array(this.flash.getData()); }
  setWritableImage(bytes: Uint8Array): void { this.flash.loadData(bytes); }
  // VICE megabyter_config_init: io1_store($DE00,0)=bank 0 + io1_store($DE02,0)=
  // mode 0 → memconfig[0] = 8K game. Flash DATA preserved.
  reset(): void { super.reset(); this.register00 = 0; this.register02 = 0; }
}

// VICE gmod2.c — Individual Computers GMOD2: 512KB Flash (29F040, TYPE_NORMAL,
// 64×8K banks) + M93C86 serial EEPROM. IO1 ($DE00) store:
//   bits 0-5 = ROM bank;  bit 6 = EEPROM CS (and cart mode);  bit 4 = EEPROM DI;
//   bit 5 = EEPROM CLK;  bits 7-6 select cmode: 0xc0=ULTIMAX, b6=0 → 8K game,
//   b6=1 (b7=0) → RAM (cart off).
//   IO1 read: CS ? (eeprom.read_data()<<7) | open-bus(0x7f) : 0.
// Flash is READ at $8000-$9FFF in 8K mode (roml_read); flash is PROGRAMMED in
// ULTIMAX (roml_store/romh_store → flash040core_store at (addr&0x1fff)+(bank<<13)).
type Gmod2Cmode = "8k" | "off" | "ultimax";
class Gmod2Mapper extends BaseMapper {
  private register = 0;
  private cmode: Gmod2Cmode = "8k";
  private eepromCs = 0;
  private readonly flash: Flash040;
  private readonly eeprom: M93c86;
  private phi1: () => number = () => 0xff;

  constructor(image: ParsedCartridgeImage) {
    super(image);
    this.flash = new Flash040(buildLinearChipData(image, (b) => b.roml, 64), "gmod2", FLASH040_NORMAL);
    this.eeprom = new M93c86();
  }

  setClock(clk: () => number): void { this.flash.clock = clk; }
  setPhi1(fn: () => number): void { this.phi1 = fn; }

  private flashOffset(address: number): number {
    return ((address & 0x1fff) + (this.currentBank << 13)) >>> 0;
  }

  getLines(): HeadlessCartridgeLines {
    switch (this.cmode) {
      case "8k": return { exrom: 0, game: 1 };
      case "ultimax": return { exrom: 1, game: 0 };
      case "off": return { exrom: 1, game: 1 };
    }
  }

  read(address: number, _bankInfo: HeadlessBankInfo): number | undefined {
    if (address >= 0xde00 && address <= 0xdeff) {
      // gmod2_io1_read: (m93c86_read_data() << 7) | (vicii_read_phi1() & 0x7f)
      // while CS asserted; otherwise open bus (phi1).
      const phi1 = this.phi1() & 0xff;
      return this.eepromCs ? (((this.eeprom.read_data() & 1) << 7) | (phi1 & 0x7f)) : phi1;
    }
    // gmod2_roml_read: flash only in 8K mode; otherwise the C64 RAM underneath
    // (fake-ultimax) — return undefined so the bus serves RAM.
    if (this.cmode === "8k" && address >= 0x8000 && address <= 0x9fff) {
      return this.flash.read(this.flashOffset(address));
    }
    return undefined;
  }

  // Spec 754 §3.4 / BUG-038 — side-effect-free peek. The flash ROML window is
  // peeked via Flash040.peek. The IO1 ($DE00) EEPROM-read path is NOT peeked
  // (m93c86_read_data advances the serial state machine) — return undefined so
  // the bus serves open-bus instead of clocking the EEPROM. Best-effort,
  // documented: a debugger peek of $DE00 on GMOD2 reports open-bus, not the
  // live EEPROM data bit.
  peek(address: number, _bankInfo: HeadlessBankInfo): number | undefined {
    if (address >= 0xde00 && address <= 0xdeff) return undefined; // → bus open-bus
    if (this.cmode === "8k" && address >= 0x8000 && address <= 0x9fff) {
      return this.flash.peek(this.flashOffset(address));
    }
    return undefined;
  }

  write(address: number, value: number, _bankInfo: HeadlessBankInfo): boolean {
    if (address >= 0xde00 && address <= 0xdeff) {
      this.register = value & 0xff;
      this.currentBank = value & 0x3f;
      if ((value & 0xc0) === 0xc0) this.cmode = "ultimax";
      else if ((value & 0x40) === 0x00) this.cmode = "8k";
      else this.cmode = "off";
      this.eepromCs = (value >> 6) & 1;
      const eepromData = (value >> 4) & 1;
      const eepromClock = (value >> 5) & 1;
      this.eeprom.write_select(this.eepromCs);
      if (this.eepromCs) {
        this.eeprom.write_data(eepromData);
        this.eeprom.write_clock(eepromClock);
      }
      return true;
    }
    // gmod2_romh_store / roml_store: program flash. The bus routes cart-window
    // writes here only in ultimax (roml_store/romh_store); 8K/off writes go to RAM.
    if (this.cmode === "ultimax" &&
        ((address >= 0x8000 && address <= 0x9fff) || (address >= 0xe000 && address <= 0xffff))) {
      this.flash.store(this.flashOffset(address), value);
      return true;
    }
    return false;
  }

  getState(): HeadlessCartridgeState {
    const state = super.getState();
    state.currentBank = this.currentBank;
    state.controlRegister = this.register;
    state.writable = true;
    state.flashMode = `gmod2:${this.cmode} [${this.flash.getMode()}]`;
    state.flashLoState = this.flash.snapshotState();
    state.eepromState = this.eeprom.snapshotState();
    return state;
  }

  setState(state: HeadlessCartridgeState): void {
    this.register = (state.controlRegister ?? 0) & 0xff;
    this.currentBank = (state.currentBank ?? 0) & 0x3f;
    if ((this.register & 0xc0) === 0xc0) this.cmode = "ultimax";
    else if ((this.register & 0x40) === 0x00) this.cmode = "8k";
    else this.cmode = "off";
    this.eepromCs = (this.register >> 6) & 1;
    if (state.flashLoState) this.flash.restoreState(state.flashLoState);
    if (state.eepromState) this.eeprom.restoreState(state.eepromState);
  }

  persistsWritableState(): boolean { return true; }
  isWritableDirty(): boolean { return this.flash.isDirty() || this.eeprom.isDirty(); }

  getWritableImage(): Uint8Array {
    const flash = this.flash.getData(), eeprom = this.eeprom.getData();
    const out = new Uint8Array(flash.length + eeprom.length);
    out.set(flash, 0); out.set(eeprom, flash.length);
    return out;
  }
  setWritableImage(bytes: Uint8Array): void {
    const flashLen = this.flash.getData().length;
    this.flash.loadData(bytes.subarray(0, flashLen));
    this.eeprom.loadData(bytes.subarray(flashLen));
  }
  // VICE gmod2_reset (gmod2.c): CMODE_8KGAME, eeprom_cs=0, m93c86_write_select(0).
  // (VICE also resets the flash command FSM "anyway"; real HW does not, and the
  // non-volatile flash DATA is preserved either way — we keep the FSM, matching HW.)
  reset(): void {
    super.reset();
    this.register = 0;
    this.cmode = "8k";
    this.eepromCs = 0;
    this.eeprom.write_select(0);
  }
}

// GMOD3 — 16 MB Flash version of GMOD2. Same banking via $DE00 +
// extended bank select via $DE02. v1 only handles low-byte bank select.
// VICE gmod3.c — Individual Computers GMOD3: up to 16MB SPI flash, 8K banks.
// IO1 ($DE00) is register-paged by the low address nibble:
//   $DE00-$DE07: bitbang mode → SPI lines (cs=b6 active-low, clk=b5, di=b4);
//                else → ROM bank: bank = value | ((addr&7)<<8) (11-bit).
//   $DE08: control — bitbang_enabled=b7, vectors_enabled=b5, cmode (b6=0 →
//          vectors?ultimax:8K; b6=1 → RAM/off).
//   read $DE00-07 → bitbang+selected ? spi.read_data()<<7 : bank low;
//        $DE08-0f → bank high.
// ROML ($8000) reads the flash array DIRECTLY (parallel), gated by the CPU port
// mem_config for fake-ultimax (vectors). Flash is REFLASHED only via the serial
// SPI path (no parallel ROM-window programming).
// VICE gmod3.c vectors[] — fixed table returned by gmod3_romh_read at $FFF8-$FFFF
// when vectors are enabled (reset → $800C cart, NMI → $0008, IRQ → $000C).
const GMOD3_VECTORS = [0x08, 0x00, 0x08, 0x00, 0x0c, 0x80, 0x0c, 0x00];
type Gmod3Cmode = "8k" | "off" | "ultimax";
class Gmod3Mapper extends BaseMapper {
  private gmod3Bank = 0;
  private bitbang = 0;
  private vectors = 0;
  private cmode: Gmod3Cmode = "8k";
  private eepromCs = 0;
  private eepromClock = 0;
  private eepromData = 0;
  private readonly rom: Uint8Array;
  private readonly spi = new SpiFlash();
  private readWithoutUltimax: (addr: number) => number = () => 0;

  constructor(image: ParsedCartridgeImage) {
    super(image);
    const highest = [...image.banks.keys()].reduce((m, b) => Math.max(m, b), 0);
    this.rom = buildLinearChipData(image, (b) => b.roml, highest + 1);
    this.spi.setImage(this.rom, this.rom.length);
  }

  setReadWithoutUltimax(fn: (addr: number) => number): void { this.readWithoutUltimax = fn; }

  getLines(): HeadlessCartridgeLines {
    switch (this.cmode) {
      case "8k": return { exrom: 0, game: 1 };
      case "ultimax": return { exrom: 1, game: 0 };
      case "off": return { exrom: 1, game: 1 };
    }
  }

  read(address: number, bankInfo: HeadlessBankInfo): number | undefined {
    if (address >= 0xde00 && address <= 0xdeff) {
      const a = address & 0xff;
      if (this.bitbang) {
        return this.eepromCs === 0 ? ((this.spi.read_data() & 1) << 7) : 0; // cs active-low
      }
      if (a <= 0x07) return this.gmod3Bank & 0xff;
      if (a <= 0x0f) return (this.gmod3Bank & 0x0700) >> 8;
      return 0;
    }
    if (address >= 0x8000 && address <= 0x9fff) {
      // gmod3_roml_read: direct ROM unless vectors-enabled fake-ultimax says RAM.
      const memConfig = (~bankInfo.cpuPortDirection | bankInfo.cpuPortValue) & 0x7;
      if (!this.vectors || memConfig === 7 || memConfig === 3) {
        return this.rom[((address & 0x1fff) + (this.gmod3Bank << 13)) >>> 0] ?? 0xff;
      }
      return undefined; // → bus RAM (fake ultimax)
    }
    // gmod3_romh_read (ultimax, vectors enabled): the fixed vector table at
    // $FFF8-$FFFF, otherwise mem_read_without_ultimax (the underlying C64 RAM).
    if (address >= 0xe000 && address <= 0xffff) {
      if (address >= 0xfff8) return GMOD3_VECTORS[address & 7];
      return this.readWithoutUltimax(address); // mem_read_without_ultimax (KERNAL/RAM per $01)
    }
    return undefined;
  }

  // Spec 754 §3.4 / BUG-038 — side-effect-free peek. ROML reads the parallel
  // flash array directly (no side effect) and ROMH the vector table /
  // mem_read_without_ultimax (side-effect-free); both reuse read(). The IO1
  // ($DE00) SPI-read path is skipped (return undefined → bus open-bus) so a
  // debugger peek never disturbs the serial line. Best-effort, documented.
  peek(address: number, bankInfo: HeadlessBankInfo): number | undefined {
    if (address >= 0xde00 && address <= 0xdeff) return undefined; // → bus open-bus
    // ROML / ROMH read() paths are pure array / readWithoutUltimax — safe.
    return this.read(address, bankInfo);
  }

  write(address: number, value: number, _bankInfo: HeadlessBankInfo): boolean {
    if (address >= 0xde00 && address <= 0xdeff) {
      const a = address & 0xff;
      if (a <= 0x07) {
        if (this.bitbang) {
          this.eepromCs = (value >> 6) & 1;
          this.eepromClock = (value >> 5) & 1;
          this.eepromData = (value >> 4) & 1;
        } else {
          this.gmod3Bank = (value & 0xff) | ((a & 0x07) << 8);
        }
      } else if (a === 0x08) {
        this.bitbang = (value >> 7) & 1;
        this.vectors = (value >> 5) & 1;
        if ((value & 0x40) === 0x00) this.cmode = this.vectors ? "ultimax" : "8k";
        else this.cmode = "off";
      }
      // VICE drives the SPI lines on every IO1 store (cs active low).
      this.spi.write_select(this.eepromCs);
      if (this.eepromCs === 0) {
        this.spi.write_data(this.eepromData);
        this.spi.write_clock(this.eepromClock);
      }
      return true;
    }
    return false; // ROM window writes → RAM (flash is reprogrammed via SPI only)
  }

  getState(): HeadlessCartridgeState {
    const state = super.getState();
    state.currentBank = this.gmod3Bank;
    state.controlRegister = (this.bitbang << 7) | (this.vectors << 5) | (this.cmode === "off" ? 0x40 : 0);
    state.writable = true;
    state.flashMode = `gmod3:${this.cmode}${this.bitbang ? " bitbang" : ""}`;
    state.spiState = this.spi.snapshotState();
    // audit #3 — the mapper's own serial pin latches gate the next SPI edge.
    state.mapperPins = (this.eepromCs << 2) | (this.eepromClock << 1) | this.eepromData;
    return state;
  }

  setState(state: HeadlessCartridgeState): void {
    this.gmod3Bank = (state.currentBank ?? 0) & 0x7ff;
    const ctrl = state.controlRegister ?? 0;
    this.bitbang = (ctrl >> 7) & 1;
    this.vectors = (ctrl >> 5) & 1;
    if ((ctrl & 0x40) === 0x00) this.cmode = this.vectors ? "ultimax" : "8k";
    else this.cmode = "off";
    if (state.spiState) this.spi.restoreState(state.spiState);
    const pins = state.mapperPins ?? 0;
    this.eepromCs = (pins >> 2) & 1; this.eepromClock = (pins >> 1) & 1; this.eepromData = pins & 1;
  }

  persistsWritableState(): boolean { return true; }
  isWritableDirty(): boolean { return this.spi.isDirty(); }
  getWritableImage(): Uint8Array { return new Uint8Array(this.rom); }
  setWritableImage(bytes: Uint8Array): void { this.rom.set(bytes.subarray(0, this.rom.length)); }
  // VICE gmod3_reset (gmod3.c): CMODE_8KGAME, eeprom_cs=1 (SPI CS is active-low →
  // deasserted), spi_flash_write_select(1), bitbang off, vectors off, bank 0.
  reset(): void {
    super.reset();
    this.gmod3Bank = 0;
    this.bitbang = 0;
    this.vectors = 0;
    this.cmode = "8k";
    this.eepromCs = 1;
    this.eepromClock = 0;
    this.eepromData = 0;
    this.spi.write_select(1);
  }
}

// VICE c64megacart.c (martinpiper fork, vendored in vice-refs/c64megacart/).
// 2MB flash (FLASH040_TYPE_160), 14-bit bank: IO1 $DE00 = bank low byte, IO2
// $DF00 = bank high 6 bits (<<8) + cmode (bits 7-6: 0xc0 ultimax / 0x00 8K /
// 0x80 RAM-off). ROML ($8000) and ultimax ROMH ($E000) both read the same flash
// offset (addr&0x1fff)+(bank<<13). Flash is programmed in ultimax
// (roml_store/romh_store). No EEPROM (the m93c86 include in the C source is
// vestigial — zero calls).
type MegaCartCmode = "8k" | "off" | "ultimax";
class C64MegaCartMapper extends BaseMapper {
  private megaBank = 0;       // 14-bit
  private regHi = 0;          // last $DF00 value (cmode + bank high)
  private cmode: MegaCartCmode = "8k";
  private readonly flash: Flash040;

  constructor(image: ParsedCartridgeImage) {
    super(image);
    this.flash = new Flash040(buildLinearChipData(image, (b) => b.roml, 256), "c64megacart", FLASH040_160);
  }

  setClock(clk: () => number): void { this.flash.clock = clk; }
  private flashOffset(address: number): number { return ((address & 0x1fff) + (this.megaBank << 13)) >>> 0; }

  getLines(): HeadlessCartridgeLines {
    switch (this.cmode) {
      case "8k": return { exrom: 0, game: 1 };
      case "ultimax": return { exrom: 1, game: 0 };
      case "off": return { exrom: 1, game: 1 };
    }
  }

  read(address: number, _bankInfo: HeadlessBankInfo): number | undefined {
    if (address >= 0xde00 && address <= 0xdfff) return undefined; // IO1/IO2 read = phi1 open-bus
    if ((address >= 0x8000 && address <= 0x9fff) || (address >= 0xe000 && address <= 0xffff)) {
      return this.flash.read(this.flashOffset(address));
    }
    return undefined;
  }

  // Spec 754 §3.4 / BUG-038 — side-effect-free peek of the flash ROM windows
  // (no command-state advance). IO1/IO2 are open-bus (return undefined).
  peek(address: number, _bankInfo: HeadlessBankInfo): number | undefined {
    if (address >= 0xde00 && address <= 0xdfff) return undefined;
    if ((address >= 0x8000 && address <= 0x9fff) || (address >= 0xe000 && address <= 0xffff)) {
      return this.flash.peek(this.flashOffset(address));
    }
    return undefined;
  }

  write(address: number, value: number, _bankInfo: HeadlessBankInfo): boolean {
    if (address >= 0xde00 && address <= 0xdeff) { // IO1: bank low byte
      this.megaBank = (this.megaBank & 0xff00) | (value & 0xff);
      return true;
    }
    if (address >= 0xdf00 && address <= 0xdfff) { // IO2: bank high 6 bits + cmode
      this.regHi = value & 0xff;
      this.megaBank = (this.megaBank & 0x00ff) | ((value & 0x3f) << 8);
      if ((value & 0xc0) === 0xc0) this.cmode = "ultimax";
      else if ((value & 0xc0) === 0x00) this.cmode = "8k";
      else this.cmode = "off"; // 0x80
      return true;
    }
    // flash program (roml_store/romh_store) in ultimax; 8K window writes pass to RAM.
    if (this.cmode === "ultimax" &&
        ((address >= 0x8000 && address <= 0x9fff) || (address >= 0xe000 && address <= 0xffff))) {
      this.flash.store(this.flashOffset(address), value);
      return true;
    }
    return false;
  }

  getState(): HeadlessCartridgeState {
    const state = super.getState();
    state.currentBank = this.megaBank;
    state.controlRegister = this.regHi;
    state.writable = true;
    state.flashMode = `c64megacart:${this.cmode} [${this.flash.getMode()}]`;
    state.flashLoState = this.flash.snapshotState();
    return state;
  }

  setState(state: HeadlessCartridgeState): void {
    this.megaBank = (state.currentBank ?? 0) & 0x3fff;
    this.regHi = (state.controlRegister ?? 0) & 0xff;
    if ((this.regHi & 0xc0) === 0xc0) this.cmode = "ultimax";
    else if ((this.regHi & 0xc0) === 0x00) this.cmode = "8k";
    else this.cmode = "off";
    if (state.flashLoState) this.flash.restoreState(state.flashLoState);
  }

  persistsWritableState(): boolean { return true; }
  isWritableDirty(): boolean { return this.flash.isDirty(); }
  getWritableImage(): Uint8Array { return new Uint8Array(this.flash.getData()); }
  setWritableImage(bytes: Uint8Array): void { this.flash.loadData(bytes); }
  // No VICE reset fn (martinpiper fork) → power-on default: bank 0, 8K game.
  reset(): void { super.reset(); this.megaBank = 0; this.regHi = 0; this.cmode = "8k"; }
}

