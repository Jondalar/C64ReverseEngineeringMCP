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
        //   - CIA1:     $DC00-$DC0F (base only — 16-fold mirror to $DC10-$DCFF
        //               not yet installed; no in-scope game reads from a CIA
        //               mirror. Future spec extends `installCia1` to mirror.)
        //   - CIA2:     $DD00-$DD0F (same — base only, mirror deferred).
        // All mirror ranges are pre-installed at session boot, so the
        // handler lookup below already covers them; no extra masking
        // needed here.
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
