import type { HeadlessBankInfo, HeadlessMemoryAccess } from "./types.js";
import type { HeadlessCartridgeMapper } from "./cartridge.js";

export interface HeadlessIoHandler {
  read?(address: number): number | undefined;
  write?(address: number, value: number): void;
}

function clampByte(value: number): number {
  return value & 0xff;
}

function clampWord(value: number): number {
  return value & 0xffff;
}

export class HeadlessMemoryBus {
  public readonly ram = new Uint8Array(0x10000);
  public readonly basicRom = new Uint8Array(0x2000);
  public readonly kernalRom = new Uint8Array(0x2000);
  public readonly charRom = new Uint8Array(0x1000);
  public readonly io = new Uint8Array(0x1000);

  private readonly ioHandlers = new Map<number, HeadlessIoHandler>();
  private cpuPortDirection = 0x2f;
  private cpuPortValue = 0x37;
  // Spec 219 c4 — capacitor-decay model for CPU-port bits 6,7 (NMOS C64).
  // Mirrors VICE c64mem.c pport.data_set_bitN / data_set_clk_bitN /
  // data_falloff_bitN. Bit transitions output→input snapshot the latched
  // data bit; the snapshot decays to 0 after ~350000 c64 cycles.
  private static readonly FALLOFF_CYCLES = 350000;
  private cpuPortClock: () => number = () => 0;
  private dataSetBit6 = 0; // 0x40 or 0
  private dataSetBit7 = 0; // 0x80 or 0
  private dataSetClkBit6 = 0;
  private dataSetClkBit7 = 0;
  private dataFalloffBit6 = 0;
  private dataFalloffBit7 = 0;
  private accessTrace: HeadlessMemoryAccess[] = [];
  private tracingEnabled = false;
  private cartridge?: HeadlessCartridgeMapper;

  reset(): void {
    // Sprint 93.2: match VICE cold-power RAM init pattern.
    // VICE `ram_init_with_pattern` defaults (src/ram.c):
    //   start_value = 0xff, value_invert = 128, value_offset = 0,
    //   pattern_invert = 0, random_chance = 0.
    // Effective formula: ram[i] = 0xff ^ (((i / 128) & 1) ? 0xff : 0x00).
    // I.e. blocks of 128 bytes alternate $FF / $00, starting with $FF.
    // Required for KERNAL RAMTAS / cart-detect to read the same values
    // VICE does, otherwise the swimlane diff drifts at the very first
    // RAM read.
    for (let i = 0; i < 0x10000; i++) {
      this.ram[i] = ((i >>> 7) & 1) ? 0x00 : 0xff;
    }
    this.cpuPortDirection = 0x2f;
    this.cpuPortValue = 0x37;
    this.ram[0x0000] = this.cpuPortDirection;
    this.ram[0x0001] = this.cpuPortValue;
    this.dataSetBit6 = 0;
    this.dataSetBit7 = 0;
    this.dataSetClkBit6 = 0;
    this.dataSetClkBit7 = 0;
    this.dataFalloffBit6 = 0;
    this.dataFalloffBit7 = 0;
  }

  setCpuPortClock(fn: () => number): void {
    this.cpuPortClock = fn;
  }

  getCpuPortDirection(): number {
    return this.cpuPortDirection;
  }

  getCpuPortValue(): number {
    return this.cpuPortValue;
  }

  getBankInfo(): HeadlessBankInfo {
    const lines = this.cartridge?.getLines();
    return {
      cpuPortDirection: this.cpuPortDirection,
      cpuPortValue: this.cpuPortValue,
      basicVisible: this.basicVisible(),
      kernalVisible: this.kernalVisible(),
      ioVisible: this.ioVisible(),
      charVisible: this.charVisible(),
      cartridgeAttached: this.cartridge !== undefined,
      cartridgeExrom: lines?.exrom,
      cartridgeGame: lines?.game,
      cartridgeMapperType: this.cartridge?.getMapperType(),
    };
  }

  attachCartridge(cartridge: HeadlessCartridgeMapper | undefined): void {
    this.cartridge = cartridge;
  }

  beginInstructionTrace(): void {
    this.accessTrace = [];
    this.tracingEnabled = true;
  }

  endInstructionTrace(): HeadlessMemoryAccess[] {
    this.tracingEnabled = false;
    const result = this.accessTrace;
    this.accessTrace = [];
    return result;
  }

  registerIoHandler(address: number, handler: HeadlessIoHandler): void {
    this.ioHandlers.set(clampWord(address), handler);
  }

  loadBasicRom(data: Uint8Array): void {
    this.basicRom.set(data.slice(0, this.basicRom.length));
  }

  loadKernalRom(data: Uint8Array): void {
    this.kernalRom.set(data.slice(0, this.kernalRom.length));
  }

  loadCharRom(data: Uint8Array): void {
    this.charRom.set(data.slice(0, this.charRom.length));
  }

  loadBytes(address: number, data: Uint8Array): void {
    const start = clampWord(address);
    const available = Math.min(data.length, 0x10000 - start);
    this.ram.set(data.slice(0, available), start);
  }

  readRange(start: number, endInclusive: number): Uint8Array {
    const normalizedStart = clampWord(start);
    const normalizedEnd = clampWord(endInclusive);
    if (normalizedEnd < normalizedStart) {
      throw new Error(`Invalid range ${normalizedStart.toString(16)}-${normalizedEnd.toString(16)}`);
    }
    return this.ram.slice(normalizedStart, normalizedEnd + 1);
  }

  read(address: number): number {
    const normalized = clampWord(address);
    let value: number;
    if (normalized === 0x0000) {
      // VICE c64mem.c:269 / c64pla.c:98 — $00 returns pport.dir_read = pport.dir.
      value = this.cpuPortDirection;
      this.recordAccess("read", normalized, value, "cpu_port_direction");
      return value;
    }
    if (normalized === 0x0001) {
      // VICE c64mem.c:271 / c64pla.c:53-55 — $01 returns
      //   data_read = (data | ~dir) & (data_out | pullup)
      // where data_out = (data_out & ~dir) | (data & dir) and pullup = 0x17
      // on stock C64 (charen/hiram/loram + tape sense). For pins that are
      // outputs the formula collapses to the latched data bit; for input
      // pins the pullup forces bit-1, matching real HW behavior.
      // Capacitor-decay of bits 6,7 (and 3,4,5 on SX-64) is documented in
      // pla-fidelity-notes.md and deferred — almost no software depends on it.
      value = this.computeCpuPortDataRead();
      this.recordAccess("read", normalized, value, "cpu_port_value");
      return value;
    }
    const cartValue = this.cartridge?.read(normalized, this.getBankInfo());
    if (cartValue !== undefined) {
      this.recordAccess("read", normalized, cartValue, "cartridge");
      return cartValue;
    }
    if (normalized >= 0xa000 && normalized <= 0xbfff && this.basicVisible()) {
      value = this.basicRom[normalized - 0xa000]!;
      this.recordAccess("read", normalized, value, "basic_rom");
      return value;
    }
    if (normalized >= 0xd000 && normalized <= 0xdfff) {
      if (this.ioVisible()) {
        const handler = this.ioHandlers.get(normalized);
        const value = handler?.read?.(normalized);
        if (value !== undefined) {
          this.io[normalized - 0xd000] = clampByte(value);
        }
        let ioValue = this.io[normalized - 0xd000]!;
        // Spec 106 (M2.4d) — color RAM ($D800-$DBFF) is a 1Kx4 SRAM
        // on real HW: only the low nibble is stored; reads return
        // open-bus on the upper nibble. We approximate open-bus as
        // $f0 (a common observed value when VIC has just fetched a
        // sprite-pointer / screen byte). Per Spec 106 fallback path:
        // "Open-bus value coupled too tightly to VIC: return constant
        //  $FF, document, refine in a follow-up spec." We pick $f0
        // so the lower-nibble write/read round-trip is visible
        // without leaking VIC state.
        if (normalized >= 0xd800 && normalized <= 0xdbff) {
          ioValue = (ioValue & 0x0f) | 0xf0;
        }
        this.recordAccess("read", normalized, ioValue, "io");
        return ioValue;
      }
      if (this.charVisible()) {
        value = this.charRom[normalized - 0xd000]!;
        this.recordAccess("read", normalized, value, "char_rom");
        return value;
      }
    }
    if (normalized >= 0xe000 && normalized <= 0xffff && this.kernalVisible()) {
      value = this.kernalRom[normalized - 0xe000]!;
      this.recordAccess("read", normalized, value, "kernal_rom");
      return value;
    }
    value = this.ram[normalized]!;
    this.recordAccess("read", normalized, value, classifyRamRegion(normalized));
    return value;
  }

  write(address: number, value: number): void {
    const normalized = clampWord(address);
    const byte = clampByte(value);
    const bankInfo = this.getBankInfo();
    if (normalized === 0x0000) {
      // Spec 219 c4 — DDR transition output→input snapshots the latched
      // data bit into the capacitor (VICE c64mem.c:421-436).
      const oldDir = this.cpuPortDirection;
      const clk = this.cpuPortClock();
      if ((oldDir & 0x40) && ((oldDir ^ byte) & 0x40)) {
        this.dataSetClkBit6 = clk + HeadlessMemoryBus.FALLOFF_CYCLES;
        this.dataSetBit6 = this.cpuPortValue & 0x40;
        this.dataFalloffBit6 = 1;
      }
      if ((oldDir & 0x80) && ((oldDir ^ byte) & 0x80)) {
        this.dataSetClkBit7 = clk + HeadlessMemoryBus.FALLOFF_CYCLES;
        this.dataSetBit7 = this.cpuPortValue & 0x80;
        this.dataFalloffBit7 = 1;
      }
      this.cpuPortDirection = byte;
      this.ram[0x0000] = byte;
      this.recordAccess("write", normalized, byte, "cpu_port_direction");
      return;
    }
    if (normalized === 0x0001) {
      // Spec 219 c4 — write to $01 while DDR bit is output charges the
      // capacitor with the new value (VICE c64mem.c:461-471).
      const clk = this.cpuPortClock();
      if (this.cpuPortDirection & 0x40) {
        this.dataSetBit6 = byte & 0x40;
        this.dataSetClkBit6 = clk + HeadlessMemoryBus.FALLOFF_CYCLES;
        this.dataFalloffBit6 = 1;
      }
      if (this.cpuPortDirection & 0x80) {
        this.dataSetBit7 = byte & 0x80;
        this.dataSetClkBit7 = clk + HeadlessMemoryBus.FALLOFF_CYCLES;
        this.dataFalloffBit7 = 1;
      }
      this.cpuPortValue = byte;
      this.ram[0x0001] = byte;
      this.recordAccess("write", normalized, byte, "cpu_port_value");
      return;
    }
    if (this.cartridge?.write(normalized, byte, bankInfo)) {
      this.recordAccess("write", normalized, byte, normalized >= 0xde00 && normalized <= 0xdeff ? "cartridge_control" : "cartridge");
      return;
    }
    if (normalized >= 0xd000 && normalized <= 0xdfff && this.ioVisible()) {
      this.io[normalized - 0xd000] = byte;
      this.ioHandlers.get(normalized)?.write?.(normalized, byte);
      this.recordAccess("write", normalized, byte, "io");
      return;
    }
    this.ram[normalized] = byte;
    this.recordAccess("write", normalized, byte, classifyRamRegion(normalized));
  }

  // Sprint 87 (Spec 087) / Sprint 113 audit: PLA truth-table approach. Inputs:
  //   LORAM ($01 bit 0), HIRAM ($01 bit 1), CHAREN ($01 bit 2)
  //   /EXROM, /GAME from cartridge (1 = released/inactive, 0 = asserted)
  // No cartridge attached: EXROM=1, GAME=1.
  //
  // Mode bits per VICE c64mem.c:216:
  //   mem_config bits 0..2 = (~pport.dir | pport.data) & 7
  // i.e. for OUTPUT pins (dir bit=1) the bit equals the latched data bit;
  // for INPUT pins (dir bit=0) the bit is forced HIGH (pulled up). This
  // matches the LORAM/HIRAM/CHAREN pullups on real HW.
  private pla(): { bank8: 'ram' | 'cart_lo'; bankA: 'ram' | 'basic' | 'cart_hi'; bankD: 'ram' | 'io' | 'char'; bankE: 'ram' | 'kernal' | 'cart_hi_ultimax' } {
    const port = (~this.cpuPortDirection | this.cpuPortValue) & 0x07;
    const loram = (port & 0x01) !== 0;
    const hiram = (port & 0x02) !== 0;
    const charen = (port & 0x04) !== 0;
    const lines = this.cartridge?.getLines();
    const exrom = lines ? (lines.exrom !== 0) : true;
    const game = lines ? (lines.game !== 0) : true;
    // Ultimax mode: GAME=0 AND EXROM=1.
    const ultimax = !game && exrom;

    let bank8: 'ram' | 'cart_lo' = 'ram';
    if (ultimax) bank8 = 'cart_lo';
    else if (loram && hiram && !exrom) bank8 = 'cart_lo';

    let bankA: 'ram' | 'basic' | 'cart_hi' = 'ram';
    if (ultimax) bankA = 'ram';                 // unmapped in Ultimax
    else if (loram && hiram && !exrom && !game) bankA = 'cart_hi'; // 16K cart
    else if (loram && hiram) bankA = 'basic';   // standard

    let bankD: 'ram' | 'io' | 'char' = 'ram';
    if (ultimax) bankD = 'io';                  // I/O always in Ultimax
    else if ((loram || hiram) && charen) bankD = 'io';
    else if ((loram || hiram) && !charen) bankD = 'char';

    let bankE: 'ram' | 'kernal' | 'cart_hi_ultimax' = 'ram';
    if (ultimax) bankE = 'cart_hi_ultimax';
    else if (hiram) bankE = 'kernal';

    return { bank8, bankA, bankD, bankE };
  }

  private basicVisible(): boolean { return this.pla().bankA === 'basic'; }
  private kernalVisible(): boolean { return this.pla().bankE === 'kernal'; }
  private ioVisible(): boolean { return this.pla().bankD === 'io'; }
  private charVisible(): boolean { return this.pla().bankD === 'char'; }

  /**
   * Compute VICE-equivalent `pport.data_read` for $01.
   * c64pla.c:53-55: data_out = (data_out & ~dir) | (data & dir);
   *                 data_read = (data | ~dir) & (data_out | pullup).
   * On stock C64 pullup = 0x17 (bits 0,1,2,4 — charen/hiram/loram + tape sense).
   * Bit 6 (caps-sense, optional) and bits 3,4,5 (SX-64 disconnected) decays
   * are not modeled here.
   *
   * Simplification: we don't keep `data_out` separately, so reconstruct it
   * from `data & dir` (output pins drive their data bits; input pins float
   * to pullup level). For motm-equivalent banking this is sufficient.
   */
  private computeCpuPortDataRead(): number {
    // Spec 219 c4 — discharge capacitor before computing data_read,
    // matching VICE c64mem.c:295-305.
    const clk = this.cpuPortClock();
    if (this.dataFalloffBit6 && this.dataSetClkBit6 < clk) {
      this.dataFalloffBit6 = 0;
      this.dataSetBit6 = 0;
    }
    if (this.dataFalloffBit7 && this.dataSetClkBit7 < clk) {
      this.dataFalloffBit7 = 0;
      this.dataSetBit7 = 0;
    }
    const dir = this.cpuPortDirection & 0xff;
    const data = this.cpuPortValue & 0xff;
    // pullup = $17 (LORAM/HIRAM/CHAREN + CASS_SENSE).
    const pullup = 0x17;
    const dataOut = data & dir;
    let retval = ((data | (~dir & 0xff)) & (dataOut | pullup)) & 0xff;
    // Bit 5 (CASS_MOTOR): VICE c64pla.c:61 — `if (!(dir & 0x20)) data_read &= 0xdf`.
    // Always clears bit 5 in input mode (no datasette = no motor pullup).
    if (!(dir & 0x20)) retval &= 0xdf;
    // Bits 6,7: capacitor override when input. data_set_bitN holds the
    // last latched output value (or 0 once decayed). VICE c64mem.c:326-336.
    if (!(dir & 0x40)) retval = (retval & ~0x40) | (this.dataSetBit6 & 0x40);
    if (!(dir & 0x80)) retval = (retval & ~0x80) | (this.dataSetBit7 & 0x80);
    return retval & 0xff;
  }

  private recordAccess(kind: "read" | "write", address: number, value: number, region: string): void {
    if (!this.tracingEnabled) {
      return;
    }
    this.accessTrace.push({
      kind,
      address,
      value: clampByte(value),
      region,
    });
  }
}

function classifyRamRegion(address: number): string {
  if (address < 0x0100) return "zero_page";
  if (address < 0x0200) return "stack";
  if (address >= 0x0200 && address < 0xa000) return "ram";
  if (address >= 0xc000 && address < 0xd000) return "ram_high";
  return "ram";
}
