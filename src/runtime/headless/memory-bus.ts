import type { HeadlessBankInfo, HeadlessMemoryAccess } from "./types.js";
import type { HeadlessCartridgeMapper } from "./cartridge.js";

export interface HeadlessIoHandler {
  read?(address: number): number | undefined;
  write?(address: number, value: number): void;
  // Spec 754 §3.4 / BUG-038 — side-effect-free register peek (VICE
  // *_peek analog). Returns the current register/shadow value WITHOUT
  // the read side effect (no IRQ-latch clear on $D019, no collision-latch
  // clear on $D01E/$D01F, no CIA timer-read latch effects, no SID osc3/env
  // read advance). Optional so existing handlers keep compiling; the bus
  // `peek()` io path falls back when a handler omits it. NEVER calls read().
  peek?(address: number): number | undefined;
}

// Spec 754 §3.4 / BUG-038 — bank-lens selector for the side-effect-free
// memory `peek` (the VICE `mem_bank_peek` model). `cpu` mirrors the live
// banked CPU view (current PLA memconfig); the others force a specific
// underlying source regardless of banking.
export type MemBankLens = 'cpu' | 'ram' | 'rom' | 'io' | 'cart';

function clampByte(value: number): number {
  return value & 0xff;
}

function clampWord(value: number): number {
  return value & 0xffff;
}

// Spec 402 — C64 Phase B: Memory and PLA.
// Doc anchor: docs/vice-c64-arch.md §4.1, §4.2, §4.3, §4.4, §4.6, §12 Phase B,
// §13 invariants 3, 11, 14.
// VICE cite: src/c64/c64mem.c:80 (NUM_CONFIGS=32), :83 (NUM_VBANKS=4),
//            src/c64/c64pla.c:51 (c64pla_config_changed),
//            src/c64/c64gluelogic.c:144 (default GLUE_LOGIC_DISCRETE),
//            src/c64/c64.h:79 (FALLOFF_CYCLES=350000).
//
// OQ-402-1 (RESOLVED): NUM_CONFIGS=32 (5-bit index from
//   LORAM, HIRAM, CHAREN, GAME, EXROM), NUM_VBANKS=4 (CIA2 PA bits 0..1).
//   Only ~14 unique in stock-C64 use; VICE allocates the full 32 for
//   branchless dispatch. Cite: c64mem.c:80,83.
// OQ-402-2 (RESOLVED): Fall-off = 350000 cycles ≈ 355 ms @ PAL.
//   Cite: c64.h:79.
// OQ-402-3 (RESOLVED): Default glue logic for VICE_MACHINE_C64 (x64/x64sc)
//   = GLUE_LOGIC_DISCRETE (HMOS). Cite: c64gluelogic.c:144.

/** Spec 402 / §4.1 — NUM_CONFIGS = 32 (c64mem.c:80). */
export const NUM_CONFIGS = 32;
/** Spec 402 / §4.1 — NUM_VBANKS = 4 (c64mem.c:83). */
export const NUM_VBANKS = 4;

/** Spec 402 / §4.4 — glue-logic selection per c64gluelogic.c. */
export type GlueLogic = "discrete" | "custom_ic";

/** Spec 402 / §4.1 — per-config bank mapping. ~14 unique entries in the
 * stock-C64 no-cart slice; the rest are duplicates per VICE's table-driven
 * dispatch. We keep one entry per of the 32 (LORAM|HIRAM|CHAREN|GAME|EXROM)
 * combinations. Each address window is labelled with a discrete region
 * tag, mirroring VICE's mem_read_tab[][] pointer fan-out. */
export interface MemConfigEntry {
  /** $8000-$9FFF mapping. */
  bank8: "ram" | "cart_lo";
  /** $A000-$BFFF mapping. */
  bankA: "ram" | "basic" | "cart_hi";
  /** $D000-$DFFF mapping. */
  bankD: "ram" | "io" | "char";
  /** $E000-$FFFF mapping. */
  bankE: "ram" | "kernal" | "cart_hi_ultimax";
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
  // Spec 219 c4 / Spec 402 — capacitor-decay model for CPU-port bits 6,7.
  // Mirrors VICE c64mem.c pport.data_set_bitN / data_set_clk_bitN /
  // data_falloff_bitN. Bit transitions output→input snapshot the latched
  // data bit; the snapshot decays to 0 after FALLOFF_CYCLES cycles.
  // OQ-402-2: 350000 cycles ≈ 355 ms @ PAL 985248 Hz. Cite: c64.h:79.
  private static readonly FALLOFF_CYCLES = 350000;
  // Spec 402 / §4.4 / OQ-402-3 — default for VICE_MACHINE_C64 is
  // GLUE_LOGIC_DISCRETE (HMOS) per c64gluelogic.c:144. C64C (CMOS) opt-in.
  private glueLogic: GlueLogic = "discrete";
  // Spec 402 / §4.1 — 32-entry pre-built config table (NUM_CONFIGS=32).
  // Built at construct time; indexed via memConfigIndex.
  // VICE cite: c64meminit.c — fills mem_read_tab[32][257] +
  // mem_write_tab[NUM_VBANKS][32][257] at init.
  private readonly memConfigTable: readonly MemConfigEntry[] = buildMemConfigTable();
  // Current 5-bit selector: (LORAM | HIRAM<<1 | CHAREN<<2 | GAME<<3 | EXROM<<4).
  // Recomputed in mem_pla_config_changed() (= c64pla.c:51 analog).
  private memConfigIndex = 0;
  // Reverse-lookup cached entry (memConfigTable[memConfigIndex]).
  private memConfig: MemConfigEntry = this.memConfigTable[0]!;
  private cpuPortClock: () => number = () => 0;
  // Spec 713 §2 — open-bus value for unmapped reads (ultimax $1000-$7FFF /
  // $A000-$BFFF / $C000-$CFFF, where VICE returns vicii_read_phi1() = the last
  // byte the VIC fetched on phi1). The session wires this to the literal-port
  // VIC's `vicii.last_read_phi1`; default $FF for renderers without a phi1 lane.
  private openBusProvider: () => number = () => 0xff;
  private dataSetBit6 = 0; // 0x40 or 0
  private dataSetBit7 = 0; // 0x80 or 0
  private dataSetClkBit6 = 0;
  private dataSetClkBit7 = 0;
  private dataFalloffBit6 = 0;
  private dataFalloffBit7 = 0;
  private accessTrace: HeadlessMemoryAccess[] = [];
  private tracingEnabled = false;
  // Spike: lightweight aggregating access observer (region-liveness tooling).
  // Fires on EVERY read/write (independent of beginInstructionTrace), O(1)/call,
  // so it scales to whole-session windows without buffering every event.
  private accessObserver: ((kind: "read" | "write", address: number, value: number) => void) | null = null;
  private cartridge?: HeadlessCartridgeMapper;
  // Spec 709.7 — the original .crt bytes + display name backing the attached
  // cartridge, so RuntimeCheckpoint/.c64re can embed + recreate it on restore.
  private cartridgeMedia?: { bytes: Uint8Array; name: string };

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
    // The expansion-port RESET line resets the cartridge too: bank + mode return
    // to boot config so GAME/EXROM re-vector $FFFC from the cart (real HW reboots
    // INTO the cart). Done before memPlaConfigChanged so the PLA picks up the
    // reset lines; the CPU then fetches $FFFC through the cart-mapped vector.
    this.cartridge?.reset?.();
    // Spec 402 — recompute PLA config index after port reset.
    this.memPlaConfigChanged();
  }

  /**
   * HW reset-button (RESET line) banking reset: restore default $00/$01
   * processor-port + PLA mapping WITHOUT wiping RAM. Mirrors reset() minus
   * the cold-power RAM fill so a warm reset preserves user RAM like real
   * hardware (DRAM keeps its contents across a reset pulse).
   */
  resetCpuPortKeepRam(): void {
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
    // RESET line → cartridge reset (see reset() above): re-vector $FFFC from the
    // cart on a warm reset too, so a RESET-button press reboots into the cart.
    this.cartridge?.reset?.();
    this.memPlaConfigChanged();
  }

  /** Spec 402 / §4.4 — glue logic resource setter (HMOS / CMOS). */
  setGlueLogic(g: GlueLogic): void {
    this.glueLogic = g;
  }

  /** Spec 402 / §4.4 — read currently selected glue logic. */
  getGlueLogic(): GlueLogic {
    return this.glueLogic;
  }

  /** Spec 402 / §4.1 — current 5-bit PLA config index
   *  `(LORAM | HIRAM<<1 | CHAREN<<2 | GAME<<3 | EXROM<<4)`. */
  getMemConfigIndex(): number {
    return this.memConfigIndex;
  }

  /** Spec 402 / §4.1 — current pre-built mem-config entry. */
  getMemConfig(): MemConfigEntry {
    return this.memConfig;
  }

  /** Spec 402 / §4.1 — read-only copy of the 32-entry config table.
   *  Cite: c64mem.c:80 NUM_CONFIGS=32. */
  getMemConfigTable(): readonly MemConfigEntry[] {
    return this.memConfigTable;
  }

  setCpuPortClock(fn: () => number): void {
    this.cpuPortClock = fn;
  }

  /** Spec 713 §2 — wire the open-bus (phi1) source for ultimax unmapped reads.
   *  VICE: vicii_read_phi1(). The session passes the literal-port VIC's
   *  last_read_phi1; absent a phi1 lane the default $FF stands in. */
  setOpenBusProvider(fn: () => number): void {
    this.openBusProvider = fn;
  }

  getCpuPortDirection(): number {
    return this.cpuPortDirection;
  }

  getCpuPortValue(): number {
    return this.cpuPortValue;
  }

  /** Spec 705.A step 3 — restore the CPU-port latches ($00 direction, $01
   *  value) from a native RuntimeCheckpoint and re-run the PLA banking
   *  reconfig. Mirrors the reset path (resetCpuPortKeepRam) but with captured
   *  values. RAM[0]/[1] are part of the captured 64K image; this restores the
   *  separate port latches that drive memPlaConfigChanged(). */
  setCpuPort(direction: number, value: number): void {
    this.cpuPortDirection = direction & 0xff;
    this.cpuPortValue = value & 0xff;
    this.ram[0x0000] = this.cpuPortDirection;
    this.ram[0x0001] = this.cpuPortValue;
    this.memPlaConfigChanged();
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

  /** The mapper currently attached (for snapshot/cart-status), or undefined. */
  getCartridge(): HeadlessCartridgeMapper | undefined { return this.cartridge; }
  /** The original .crt bytes + name backing the attached cart (Spec 709.7), or undefined. */
  getCartridgeMedia(): { bytes: Uint8Array; name: string } | undefined { return this.cartridgeMedia; }

  attachCartridge(cartridge: HeadlessCartridgeMapper | undefined, media?: { bytes: Uint8Array; name: string }): void {
    this.cartridge = cartridge;
    this.cartridgeMedia = cartridge ? media : undefined;
    // Spec 713 — wire the live maincpu_clk into writable cartridge hardware
    // (EasyFlash flash040 erase busy window / DQ6 toggle need a clock).
    cartridge?.setClock?.(this.cpuPortClock);
    // Spec 713 (audit #4) — give the cart the live phi1 float-bus source so IO
    // reads that mix in open-bus low bits (GMOD2 EEPROM) match VICE.
    cartridge?.setPhi1?.(this.openBusProvider);
    // Spec 713 (audit) — fake-ultimax romh read (GMOD3 $E000-$FFF7 =
    // VICE mem_read_without_ultimax: normal CPU-port C64 map, no cart overlay).
    cartridge?.setReadWithoutUltimax?.((addr) => this.readWithoutUltimax(addr));
    // Spec 402 / §12 step 8 — cartridge GAME/EXROM lines feed the 5-bit
    // memConfig selector. On attach/detach (or banking-register write
    // that changes the lines), re-run the PLA reconfig hook so the
    // table-driven dispatch picks up the new lines.
    this.memPlaConfigChanged();
  }

  /** Spec 402 / §4.1 / §12 step 8 — cartridge-side notification that
   *  GAME/EXROM lines have changed. Cartridge mappers call this from
   *  their banking-register write site (e.g. EasyFlash $DE02 writes).
   *  Cite: c64pla.c:51 `c64pla_config_changed()`. */
  notifyCartridgeLinesChanged(): void {
    this.memPlaConfigChanged();
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

  /** Spike — attach an aggregating read/write observer (region-liveness map).
   *  Pass null to detach. Independent of beginInstructionTrace. */
  setAccessObserver(obs: ((kind: "read" | "write", address: number, value: number) => void) | null): void {
    this.accessObserver = obs;
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
    // Spec 713 §1/§2 — route every read through the active VICE memconfig (PLA),
    // like mem_read_tab[config][page]. The cartridge is consulted ONLY for the
    // windows the current config maps to it (ROML/ROMH/IO); unmapped ultimax
    // windows return open bus (vicii_read_phi1), never RAM. Cite: c64meminit.c +
    // c64cartmem.c ultimax_* → vicii_read_phi1.

    // $8000-$9FFF — ROML when the config maps cart_lo (8k/16k/ultimax).
    if (normalized >= 0x8000 && normalized <= 0x9fff) {
      if (this.memConfig.bank8 === "cart_lo") {
        const cv = this.cartridge?.read(normalized, this.getBankInfo());
        if (cv !== undefined) { this.recordAccess("read", normalized, cv, "cartridge"); return cv; }
      }
      value = this.ram[normalized]!;
      this.recordAccess("read", normalized, value, classifyRamRegion(normalized));
      return value;
    }
    // $A000-$BFFF — ROMH@a000 (16k) / BASIC / ultimax open bus / RAM.
    if (normalized >= 0xa000 && normalized <= 0xbfff) {
      if (this.memConfig.bankA === "cart_hi") {
        const cv = this.cartridge?.read(normalized, this.getBankInfo());
        if (cv !== undefined) { this.recordAccess("read", normalized, cv, "cartridge"); return cv; }
      } else if (this.basicVisible()) {
        value = this.basicRom[normalized - 0xa000]!;
        this.recordAccess("read", normalized, value, "basic_rom");
        return value;
      } else if (this.isUltimax()) {
        value = this.openBusProvider() & 0xff;
        this.recordAccess("read", normalized, value, "open_bus");
        return value;
      }
      value = this.ram[normalized]!;
      this.recordAccess("read", normalized, value, classifyRamRegion(normalized));
      return value;
    }
    // $C000-$CFFF — ultimax open bus, else RAM.
    if (normalized >= 0xc000 && normalized <= 0xcfff) {
      if (this.isUltimax()) {
        value = this.openBusProvider() & 0xff;
        this.recordAccess("read", normalized, value, "open_bus");
        return value;
      }
      value = this.ram[normalized]!;
      this.recordAccess("read", normalized, value, classifyRamRegion(normalized));
      return value;
    }
    // $D000-$DFFF — I/O (incl cart $DE/$DF) when visible, else char ROM / RAM.
    if (normalized >= 0xd000 && normalized <= 0xdfff) {
      if (this.ioVisible()) {
        // Spec 713 §1 — cart IO ($DE00 IO1 / $DF00 IO2) is reached ONLY when
        // I/O is visible (the PLA gate). CHAREN-low / non-io configs never see
        // it, so $DE00 can't change a bank register and $DFxx isn't IO2 RAM.
        if (normalized >= 0xde00 && normalized <= 0xdfff) {
          const cv = this.cartridge?.read(normalized, this.getBankInfo());
          if (cv !== undefined) { this.recordAccess("read", normalized, cv, "cartridge"); return cv; }
        }
        // Spec 405 / §8.1 / §8.2 — I/O area dispatch + open-bus.
        // Doc anchor: docs/vice-c64-arch.md §8.1 (page-aligned I/O
        // dispatch), §8.2 (chip register mirrors).
        // VICE cite: src/c64io.c:352-371 — when no chip claims the
        // address VICE returns `vicii_read_phi1()` (the last byte the
        // VIC fetched). We approximate phi1 open-bus with the cached
        // `this.io[]` shadow (= last value seen on the I/O bus at that
        // address). Chip mirrors are installed by each peripheral's
        // own `install*` function:
        //   - VIC-II:   $D000-$D03F mirrored every 0x40 across $D000-$D3FF
        //               (vic-ii-vice.ts installVicIIVice, c64-snapshot
        //               §8.2). 64-byte stride, 16-fold mirror.
        //   - SID:      $D400-$D41F mirrored every 0x20 across $D400-$D7FF
        //               (sid.ts installSid, c64sid.c). 32-byte stride.
        //   - Color RAM:$D800-$DBFF (1Kx4, low nibble valid; upper nibble
        //               is open-bus, masked to $f0 below).
        //   - CIA1:     $DC00-$DC0F mirrored 16-fold across $DC00-$DCFF
        //               (installCia1, ciacore.c `addr &= 0xf` + c64meminit.c
        //               full-page route). 16-byte stride.
        //   - CIA2:     $DD00-$DD0F mirrored 16-fold across $DD00-$DDFF
        //               (installCia2). $DD80,X folds onto $DD00 = PRA/VIC bank.
        // All mirror ranges are pre-installed at session boot, so the
        // handler lookup below already covers them; no extra masking
        // needed here.
        const handler = this.ioHandlers.get(normalized);
        const value = handler?.read?.(normalized);
        if (value !== undefined) {
          this.io[normalized - 0xd000] = clampByte(value);
        }
        let ioValue = this.io[normalized - 0xd000]!;
        // Color RAM ($D800-$DBFF) is a 1Kx4 SRAM on real HW: only the low
        // nibble is stored; the upper nibble reads back the open (phi1) data
        // bus. VICE: colorram_read() = mem_color_ram | (vicii_read_phi1() &
        // 0xf0). We use the same phi1 source already wired for ultimax
        // open-bus (openBusProvider → literal-port last_read_phi1); absent a
        // phi1 lane the provider defaults to $FF.
        if (normalized >= 0xd800 && normalized <= 0xdbff) {
          ioValue = (ioValue & 0x0f) | (this.openBusProvider() & 0xf0);
        }
        this.recordAccess("read", normalized, ioValue, "io");
        return ioValue;
      }
      if (this.charVisible()) {
        value = this.charRom[normalized - 0xd000]!;
        this.recordAccess("read", normalized, value, "char_rom");
        return value;
      }
      // IO invisible + char invisible (configs 0/4/8/12/...) → RAM underneath.
      value = this.ram[normalized]!;
      this.recordAccess("read", normalized, value, classifyRamRegion(normalized));
      return value;
    }
    // $E000-$FFFF — KERNAL / ultimax ROMH / RAM.
    if (normalized >= 0xe000 && normalized <= 0xffff) {
      if (this.kernalVisible()) {
        value = this.kernalRom[normalized - 0xe000]!;
        this.recordAccess("read", normalized, value, "kernal_rom");
        return value;
      }
      if (this.memConfig.bankE === "cart_hi_ultimax") {
        const cv = this.cartridge?.read(normalized, this.getBankInfo());
        if (cv !== undefined) { this.recordAccess("read", normalized, cv, "cartridge"); return cv; }
        value = this.openBusProvider() & 0xff;
        this.recordAccess("read", normalized, value, "open_bus");
        return value;
      }
      value = this.ram[normalized]!;
      this.recordAccess("read", normalized, value, classifyRamRegion(normalized));
      return value;
    }
    // $1000-$7FFF — ultimax open bus (board != MAX keeps $0000-$0FFF as RAM).
    if (normalized >= 0x1000 && normalized <= 0x7fff && this.isUltimax()) {
      value = this.openBusProvider() & 0xff;
      this.recordAccess("read", normalized, value, "open_bus");
      return value;
    }
    // $0000-$0FFF + everything else → RAM.
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
      // Spec 402 / §12 step 7 — bits 0..2 trigger mem_pla_config_changed.
      // DDR also affects the (~dir | data) selector, so recompute here.
      // Cite: c64pla.c:51.
      this.memPlaConfigChanged();
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
      // Spec 402 / §12 step 7 — bits 0..2 (LORAM/HIRAM/CHAREN) feed PLA;
      // bits 3..5 hook the datasette (stub — see datasetteHookStub).
      // Cite: c64pla.c:51 (`c64pla_config_changed`).
      this.memPlaConfigChanged();
      // Spec 405 / §9 / OQ-405-1 — datasette hook.
      // VICE cite: c64pla.c:80-94. bits 3..5 of $01 hook the tape port:
      //   bit 3 (mask 0x08) = cassette WRITE line
      //   bit 4 (mask 0x10) = cassette SENSE OUT (PLAY-key feedback)
      //   bit 5 (mask 0x20) = cassette MOTOR control (active LOW)
      // For this port the entire tape port is deferred ("not implemented
      // — no in-scope game (MM, Scramble, motm, IM2, LNR, Lorenz corpus)
      // requires datasette; deferred to post-arch-port spec"). The hook
      // call-site is kept so a future spec can wire it without re-tracing
      // the write path. Bit 4 of $01 is therefore a no-op datasette hook
      // (= sense out goes nowhere; bit-4 reads still see the pullup HIGH
      // via the INPUT_PULLS mask in computeCpuPortDataRead()).
      this.datasetteHookStub(
        /* motorOn */ (byte & 0x20) === 0,
        /* writeBit */ (byte >> 3) & 1,
        /* senseOut */ (byte >> 4) & 1,
      );
      this.recordAccess("write", normalized, byte, "cpu_port_value");
      return;
    }
    // Spec 713 §1/§3 — route writes through the active memconfig (PLA), like
    // mem_write_tab[vbank][config][page]. Flash is programmed only where the
    // config maps the cart for writing: ULTIMAX ROML ($8000) / ROMH ($E000) →
    // roml_store/romh_store → easyflash_*_store. 8k/16k ROM-window writes hit
    // the RAM underneath (roml_no_ultimax_store / romh_no_ultimax_store →
    // ram_store; EF is not in those switches). Ultimax open windows ($1000-
    // $7FFF / $A000 / $C000) drop the write. Cart IO only when I/O is visible.

    // $D000-$DFFF — I/O (incl cart $DE/$DF) when visible, else RAM underneath.
    if (normalized >= 0xd000 && normalized <= 0xdfff) {
      if (this.ioVisible()) {
        if (normalized >= 0xde00 && normalized <= 0xdfff && this.cartridge?.write(normalized, byte, bankInfo)) {
          this.recordAccess("write", normalized, byte, normalized <= 0xdeff ? "cartridge_control" : "cartridge");
          // A consumed cart IO write can change EXROM/GAME — IO1 ($DE00, EasyFlash
          // $DE02 / Magic Desk / Ocean / GMOD2 bank+mode) AND IO2 ($DF00, e.g.
          // C64MegaCart's high-bank/mode register). Re-run the PLA reconfig in both
          // cases (VICE cart_config_changed_slotmain fires from the relevant store);
          // a no-op recompute for IO2-RAM carts (EasyFlash $DF00) is harmless.
          this.memPlaConfigChanged();
          return;
        }
        this.io[normalized - 0xd000] = byte;
        this.ioHandlers.get(normalized)?.write?.(normalized, byte);
        this.recordAccess("write", normalized, byte, "io");
        return;
      }
      // I/O invisible (char-ROM / RAM config): write lands in the RAM underneath.
      this.ram[normalized] = byte;
      this.recordAccess("write", normalized, byte, classifyRamRegion(normalized));
      return;
    }
    // $8000-$9FFF — when ROML is mapped the cart sees the write; it returns true
    // if it consumes it (flash programming, e.g. EasyFlash in ultimax / GMOD2 in
    // 8K) or false to pass through to the RAM underneath (VICE roml_store vs
    // roml_no_ultimax_store → ram_store). When ROML is unmapped → RAM.
    if (normalized >= 0x8000 && normalized <= 0x9fff) {
      if (this.memConfig.bank8 === "cart_lo" && this.cartridge?.write(normalized, byte, bankInfo)) {
        this.recordAccess("write", normalized, byte, "cartridge");
        return;
      }
      this.ram[normalized] = byte;
      this.recordAccess("write", normalized, byte, classifyRamRegion(normalized));
      return;
    }
    // $A000-$BFFF — ROMH@a000: cart may consume (flash) else RAM; ultimax open
    // window (not cart_hi) drops; otherwise RAM (16K ROMH / BASIC region writes
    // reach RAM per romh_no_ultimax_store).
    if (normalized >= 0xa000 && normalized <= 0xbfff) {
      if (this.memConfig.bankA === "cart_hi" && this.cartridge?.write(normalized, byte, bankInfo)) {
        this.recordAccess("write", normalized, byte, "cartridge");
        return;
      }
      if (this.memConfig.bankA !== "cart_hi" && this.isUltimax()) { this.recordAccess("write", normalized, byte, "open_bus"); return; }
      this.ram[normalized] = byte;
      this.recordAccess("write", normalized, byte, classifyRamRegion(normalized));
      return;
    }
    // $C000-$CFFF — ultimax open window drops; else RAM.
    if (normalized >= 0xc000 && normalized <= 0xcfff) {
      if (this.isUltimax()) { this.recordAccess("write", normalized, byte, "open_bus"); return; }
      this.ram[normalized] = byte;
      this.recordAccess("write", normalized, byte, classifyRamRegion(normalized));
      return;
    }
    // $E000-$FFFF — ultimax ROMH: cart may consume (flash) else RAM; otherwise RAM.
    if (normalized >= 0xe000 && normalized <= 0xffff) {
      if (this.memConfig.bankE === "cart_hi_ultimax" && this.cartridge?.write(normalized, byte, bankInfo)) {
        this.recordAccess("write", normalized, byte, "cartridge");
        return;
      }
      this.ram[normalized] = byte;
      this.recordAccess("write", normalized, byte, classifyRamRegion(normalized));
      return;
    }
    // $1000-$7FFF — ultimax open window drops; else RAM.
    if (normalized >= 0x1000 && normalized <= 0x7fff && this.isUltimax()) {
      this.recordAccess("write", normalized, byte, "open_bus");
      return;
    }
    // $0000-$0FFF + everything else → RAM.
    this.ram[normalized] = byte;
    this.recordAccess("write", normalized, byte, classifyRamRegion(normalized));
  }

  // Spec 713 (audit) — VICE `mem_read_without_ultimax(addr)` (c64mem.c:595):
  //   read_tab_ptr = mem_read_tab[mem_config & 7]; return read_tab_ptr[addr>>8](addr)
  // i.e. read `addr` through the NORMAL CPU-port-dependent C64 memory map with the
  // cart's ultimax ROMH/ROML overlay removed. `mem_config & 7` keeps only LORAM/
  // HIRAM/CHAREN (the stock no-cart configs 0-7), so at $01=$37 (config 7)
  // $E000-$FFFF is KERNAL ROM, $A000-$BFFF is BASIC, $D000-$DFFF is I/O — NOT RAM.
  // GMOD3's romh_read falls through here for $E000-$FFF7.
  readWithoutUltimax(address: number): number {
    const n = clampWord(address);
    if (n === 0x0000) return this.cpuPortDirection;
    if (n === 0x0001) return this.computeCpuPortDataRead();
    // stock-C64 config = current port bits with the cart lines released (exrom=1,
    // game=1) → memConfigTable[port | 0x18], the no-cart slice (= VICE config & 7).
    const port = (~this.cpuPortDirection | this.cpuPortValue) & 0x07;
    const cfg = this.memConfigTable[(port | 0x18) & 0x1f]!;
    if (n >= 0xa000 && n <= 0xbfff && cfg.bankA === "basic") return this.basicRom[n - 0xa000]!;
    if (n >= 0xd000 && n <= 0xdfff) {
      if (cfg.bankD === "io") {
        const handler = this.ioHandlers.get(n);
        const v = handler?.read?.(n);
        if (v !== undefined) this.io[n - 0xd000] = clampByte(v);
        let ioValue = this.io[n - 0xd000]!;
        if (n >= 0xd800 && n <= 0xdbff) ioValue = (ioValue & 0x0f) | (this.openBusProvider() & 0xf0);
        return ioValue;
      }
      if (cfg.bankD === "char") return this.charRom[n - 0xd000]!;
      return this.ram[n]!;
    }
    if (n >= 0xe000 && n <= 0xffff && cfg.bankE === "kernal") return this.kernalRom[n - 0xe000]!;
    return this.ram[n]!;
  }

  // Spec 754 §3.4 / BUG-038 — side-effect-free banked peek (VICE
  // `mem_bank_peek` analog) for the bank lens. Replicates read()'s
  // window/ultimax/PLA routing for the `cpu` lens but performs NO side
  // effects: no IRQ/collision latch clears, no CIA timer-read latch
  // effects, no SID osc3/env advance, no CPU-port capacitor mutation, no
  // PLA reconfig, no access-trace/observer fire. It NEVER calls the
  // side-effecting read()/handler.read(); it reads the raw RAM/ROM arrays,
  // a handler's peek?(), or the cartridge's peek?().
  //
  // Lenses:
  //   ram  → raw 64K RAM.
  //   rom  → underlying ROM byte for ROM regions regardless of banking
  //          ($A000-$BFFF=basic, $D000-$DFFF=char, $E000-$FFFF=kernal),
  //          else RAM.
  //   cart → cartridge ROM byte for the cart windows ($8000-$9FFF ROML,
  //          $A000-$BFFF / $E000-$FFFF ROMH) if a cart is attached and
  //          exposes a side-effect-free peek?(); else RAM / open-bus $FF.
  //   io   → side-effect-free I/O register peek for $D000-$DFFF; else RAM.
  //   cpu  → mirror read()'s banking decision using the CURRENT memConfig
  //          windows, then peek that source side-effect-free.
  peek(address: number, lens: MemBankLens = 'cpu'): number {
    const n = clampWord(address);
    switch (lens) {
      case 'ram':
        return this.ram[n]!;
      case 'rom':
        return this.peekRom(n);
      case 'cart':
        return this.peekCart(n);
      case 'io':
        return (n >= 0xd000 && n <= 0xdfff) ? this.peekIo(n) : this.ram[n]!;
      case 'cpu':
      default:
        return this.peekCpu(n);
    }
  }

  /** Spec 754 §3.4 — `rom` lens: the underlying ROM byte for ROM regions
   *  regardless of current banking, else raw RAM. */
  private peekRom(n: number): number {
    if (n >= 0xa000 && n <= 0xbfff) return this.basicRom[n - 0xa000]!;
    if (n >= 0xd000 && n <= 0xdfff) return this.charRom[n - 0xd000]!;
    if (n >= 0xe000 && n <= 0xffff) return this.kernalRom[n - 0xe000]!;
    return this.ram[n]!;
  }

  /** Spec 754 §3.4 — `cart` lens: cartridge ROM byte for the cart windows
   *  via a side-effect-free path. Best-effort: a mapper that exposes no
   *  peek?() falls back to RAM (or open-bus $FF in ultimax-mapped windows).
   *  Documented limit — see HeadlessCartridgeMapper.peek?. */
  private peekCart(n: number): number {
    const isCartWindow =
      (n >= 0x8000 && n <= 0x9fff) || (n >= 0xa000 && n <= 0xbfff) || (n >= 0xe000 && n <= 0xffff);
    if (this.cartridge && isCartWindow) {
      const cv = this.cartridge.peek?.(n, this.getBankInfo());
      if (cv !== undefined) return cv & 0xff;
      // Mapper can't peek this window → open bus for ultimax-mapped windows,
      // else the RAM underneath. (Best-effort; documented.)
      if (this.isUltimax()) return this.openBusProvider() & 0xff;
      return this.ram[n]!;
    }
    return this.ram[n]!;
  }

  /** Spec 754 §3.4 — `io` lens: side-effect-free I/O register peek for
   *  $D000-$DFFF. Cart IO ($DE00-$DFFF) and chip registers ($D000-$DC.., SID,
   *  CIAs, color RAM) are peeked via the handler's peek?() / raw shadow; never
   *  via the side-effecting handler.read(). */
  private peekIo(n: number): number {
    // Cart IO ($DE00-$DFFF): mappers may have side-effecting IO reads
    // (GMOD2/3 SPI/EEPROM clocking); a cart peek?() is side-effect-free, else
    // we fall back to the open-bus shadow rather than calling cart.read().
    if (n >= 0xde00 && n <= 0xdfff && this.cartridge) {
      const cv = this.cartridge.peek?.(n, this.getBankInfo());
      if (cv !== undefined) return cv & 0xff;
      return this.openBusProvider() & 0xff;
    }
    const handler = this.ioHandlers.get(n);
    if (handler?.peek) {
      const v = handler.peek(n);
      if (v !== undefined) {
        let ioValue = clampByte(v);
        // Color RAM ($D800-$DBFF) — low nibble valid, upper nibble open (phi1)
        // bus, mirroring read(). (Color RAM has no handler; this guards a
        // future handler too.)
        if (n >= 0xd800 && n <= 0xdbff) ioValue = (ioValue & 0x0f) | (this.openBusProvider() & 0xf0);
        return ioValue;
      }
    }
    // No handler peek available → documented best-effort: the last value seen
    // on the I/O bus at that address (the `this.io[]` open-bus shadow). For
    // color RAM ($D800-$DBFF, no handler) this is the authoritative store.
    // NEVER call the side-effecting handler.read().
    let ioValue = this.io[n - 0xd000]!;
    if (n >= 0xd800 && n <= 0xdbff) ioValue = (ioValue & 0x0f) | (this.openBusProvider() & 0xf0);
    return ioValue;
  }

  /** Spec 754 §3.4 — `cpu` lens: mirror read()'s banking decision using the
   *  CURRENT memConfig windows + ultimax logic, minus all handler side
   *  effects. Cite: read() above (the structure is replicated 1:1). */
  private peekCpu(n: number): number {
    // $00/$01 — processor port latches (computeCpuPortDataRead mutates the
    // capacitor-decay state, so return the latched values directly here).
    if (n === 0x0000) return this.cpuPortDirection;
    if (n === 0x0001) return this.cpuPortValue;
    // $8000-$9FFF — ROML when the config maps cart_lo.
    if (n >= 0x8000 && n <= 0x9fff) {
      if (this.memConfig.bank8 === 'cart_lo') {
        const cv = this.cartridge?.peek?.(n, this.getBankInfo());
        if (cv !== undefined) return cv & 0xff;
      }
      return this.ram[n]!;
    }
    // $A000-$BFFF — ROMH@a000 / BASIC / ultimax open bus / RAM.
    if (n >= 0xa000 && n <= 0xbfff) {
      if (this.memConfig.bankA === 'cart_hi') {
        const cv = this.cartridge?.peek?.(n, this.getBankInfo());
        if (cv !== undefined) return cv & 0xff;
      } else if (this.basicVisible()) {
        return this.basicRom[n - 0xa000]!;
      } else if (this.isUltimax()) {
        return this.openBusProvider() & 0xff;
      }
      return this.ram[n]!;
    }
    // $C000-$CFFF — ultimax open bus, else RAM.
    if (n >= 0xc000 && n <= 0xcfff) {
      if (this.isUltimax()) return this.openBusProvider() & 0xff;
      return this.ram[n]!;
    }
    // $D000-$DFFF — I/O when visible, else char ROM / RAM.
    if (n >= 0xd000 && n <= 0xdfff) {
      if (this.ioVisible()) return this.peekIo(n);
      if (this.charVisible()) return this.charRom[n - 0xd000]!;
      return this.ram[n]!;
    }
    // $E000-$FFFF — KERNAL / ultimax ROMH / RAM.
    if (n >= 0xe000 && n <= 0xffff) {
      if (this.kernalVisible()) return this.kernalRom[n - 0xe000]!;
      if (this.memConfig.bankE === 'cart_hi_ultimax') {
        const cv = this.cartridge?.peek?.(n, this.getBankInfo());
        if (cv !== undefined) return cv & 0xff;
        return this.openBusProvider() & 0xff;
      }
      return this.ram[n]!;
    }
    // $1000-$7FFF — ultimax open bus, else RAM.
    if (n >= 0x1000 && n <= 0x7fff && this.isUltimax()) {
      return this.openBusProvider() & 0xff;
    }
    // $0000-$0FFF + everything else → RAM.
    return this.ram[n]!;
  }

  // Spec 402 / §4.1 / §4.3 — PLA reconfig hook.
  // Cite: src/c64/c64pla.c:51 `c64pla_config_changed()`.
  //
  // Recompute the 5-bit memConfig selector
  //   (LORAM | HIRAM<<1 | CHAREN<<2 | GAME<<3 | EXROM<<4)
  // from the latched processor-port state + cartridge lines, then swap
  // `this.memConfig` to the matching pre-built entry.
  //
  // Mode bits per VICE c64mem.c:216:
  //   mem_config bits 0..2 = (~pport.dir | pport.data) & 7
  // For OUTPUT pins (dir bit=1) the bit equals the latched data bit;
  // for INPUT pins (dir bit=0) the bit is forced HIGH (pulled up). This
  // matches the LORAM/HIRAM/CHAREN pullups on real HW.
  private memPlaConfigChanged(): void {
    const port = (~this.cpuPortDirection | this.cpuPortValue) & 0x07;
    const loram = port & 0x01;
    const hiram = (port >> 1) & 0x01;
    const charen = (port >> 2) & 0x01;
    const lines = this.cartridge?.getLines();
    // No cart: EXROM=1, GAME=1 (lines released). Per spec 402 §12 step 8
    // OQ-402-1 — stub when no cart attached.
    const game = lines ? (lines.game & 1) : 1;
    const exrom = lines ? (lines.exrom & 1) : 1;
    // Spec 402 §4.1 selector: 5 bits, low→high
    //   bit0=LORAM, bit1=HIRAM, bit2=CHAREN, bit3=EXROM, bit4=GAME.
    // Cite: src/c64/c64mem.c:216
    //   mem_config = (((~pport.dir | pport.data) & 0x7)
    //                | (export.exrom << 3) | (export.game << 4));
    this.memConfigIndex = (loram | (hiram << 1) | (charen << 2) | (exrom << 3) | (game << 4)) & 0x1f;
    this.memConfig = this.memConfigTable[this.memConfigIndex]!;
  }

  /** Spec 405 / §9 / OQ-405-1 — datasette tape-port hook.
   *
   *  Doc anchor: docs/vice-c64-arch.md §9 (Datasette), §12 Phase E step 22.
   *  VICE cite: src/c64/c64pla.c:80-94 (tape port pin writes),
   *             src/c64/c64datasette.c (PULSE alarm + CIA1 FLAG wiring).
   *
   *  Status: **stub** — not implemented; no in-scope game (MM, Scramble,
   *  motm, IM2, LNR, Lorenz CPU corpus) requires the datasette. Full
   *  alarm-driven pulse list + bit-4-of-$01 → CIA1 FLAG bit wiring is
   *  **deferred to a post-arch-port spec** per OQ-405-1 resolution
   *  (2026-05-11).
   *
   *  Bit 4 of $01 (sense-out) is therefore a no-op datasette hook;
   *  bit-4 reads still see the standard pullup mask through
   *  computeCpuPortDataRead() (= no tape attached → bit-4 HIGH).
   *  // TODO post-arch-port: wire alarm-driven pulse list + CIA1 FLAG.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private datasetteHookStub(_motorOn: boolean, _writeBit: number, _senseOut: number): void {
    // not implemented — no in-scope game requires it (deferred to
    // post-arch-port spec; bit 4 of $01 is a no-op datasette hook).
  }

  private basicVisible(): boolean { return this.memConfig.bankA === 'basic'; }
  private kernalVisible(): boolean { return this.memConfig.bankE === 'kernal'; }
  private ioVisible(): boolean { return this.memConfig.bankD === 'io'; }
  private charVisible(): boolean { return this.memConfig.bankD === 'char'; }
  /** Ultimax = GAME=0 AND EXROM=1 (VICE memconfig 16-23). In this mode
   *  $1000-$7FFF / $A000-$BFFF / $C000-$CFFF are open bus (not RAM) and
   *  ROMH maps to $E000-$FFFF. Cite: c64meminit.c c64meminit_romh_mapping. */
  /** Public: the literal VIC fetch lane reads this per fetch (= export.ultimax_phi1/phi2,
   *  c64cartmem.c:231 — VICE updates the flag at cart config change; the underlying
   *  state only changes there, so a live read is observably identical). */
  isUltimax(): boolean { return this.memConfig.bankE === 'cart_hi_ultimax'; }

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
    if (this.accessObserver) {
      this.accessObserver(kind, address, value);
    }
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

// Spec 402 / §4.1 — pre-build the 32-entry mem-config table.
// Cite: src/c64/c64meminit.c (fills mem_read_tab[][] at init for each
// (LORAM, HIRAM, CHAREN, GAME, EXROM) combination). VICE allocates the
// full 32 entries even though only ~14 are unique (NUM_CONFIGS=32 at
// c64mem.c:80).
//
// Selector encoding (low→high) — matches VICE c64mem.c:216 exactly:
//   bit0 = LORAM   ($01 bit 0, output high = "ROM mapped")
//   bit1 = HIRAM   ($01 bit 1, output high = "Kernal/BASIC mapped")
//   bit2 = CHAREN  ($01 bit 2, output high = "I/O mapped" / low = char ROM)
//   bit3 = EXROM   (cartridge line; 1 = released/inactive)
//   bit4 = GAME    (cartridge line; 1 = released/inactive)
//
// Reference truth table: docs/vice-c64-arch.md §4.2 (stock C64, no cart)
// + Ultimax mode (GAME=0 AND EXROM=1).
function buildMemConfigTable(): MemConfigEntry[] {
  const table: MemConfigEntry[] = [];
  for (let idx = 0; idx < NUM_CONFIGS; idx++) {
    const loram = (idx & 0x01) !== 0;
    const hiram = (idx & 0x02) !== 0;
    const charen = (idx & 0x04) !== 0;
    const exrom = (idx & 0x08) !== 0;
    const game = (idx & 0x10) !== 0;
    // Ultimax mode: GAME=0 AND EXROM=1.
    const ultimax = !game && exrom;

    let bank8: MemConfigEntry["bank8"] = "ram";
    if (ultimax) bank8 = "cart_lo";
    else if (loram && hiram && !exrom) bank8 = "cart_lo";

    let bankA: MemConfigEntry["bankA"] = "ram";
    if (ultimax) bankA = "ram"; // unmapped in Ultimax
    else if (loram && hiram && !exrom && !game) bankA = "cart_hi"; // 16K cart
    else if (loram && hiram) bankA = "basic";

    let bankD: MemConfigEntry["bankD"] = "ram";
    if (ultimax) bankD = "io"; // I/O always in Ultimax
    else if ((loram || hiram) && charen) bankD = "io";
    else if ((loram || hiram) && !charen) bankD = "char";

    let bankE: MemConfigEntry["bankE"] = "ram";
    if (ultimax) bankE = "cart_hi_ultimax";
    else if (hiram) bankE = "kernal";

    table.push({ bank8, bankA, bankD, bankE });
  }
  return table;
}
