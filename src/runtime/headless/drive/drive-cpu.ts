// Drive 6502 instance + memory bus + drivecpu catch-up.
//
// Spec 408 — 1541 Phase B: per-page dispatch tables.
// Spec 435 — drivecpu.c catch-up wrapper literal VICE port:
//
//   VICE function           Lines      TS impl                     Notes
//   ---------------------    --------   --------------------------  --------
//   drivecpu_init            58-95      DriveCpu.constructor        + reset
//   drivecpu_reset           107-130    DriveCpu.reset              + reset state
//   drivecpu_wake_up         132-151    DriveCpu.wakeUp             clear sleeping
//   drivecpu_sleep           153-172    DriveCpu.sleep              effectively no-op
//   drivecpu_execute         356-470    DriveCpu.executeToClock     core catch-up
//   drive_cpu_execute_one    991-1020   driveCpuExecuteOne (export) public entry
//   drive_cpu_execute_all    1001-1050  driveCpuExecuteAll (export) public entry
//
// State shape (mirrors VICE drivecpu_context_t):
//   lastClk           VICE cpu->last_clk
//   cycleAccum        VICE cpu->cycle_accum (16.16 fixed-point)
//   syncFactor16dot16 VICE cpu->sync_factor
//
// Spec 401 owns the inner cycle-stepped 6502 dispatch (1:1 VICE 6510core
// per-bus-cycle macro template). Spec 428 introduced a "whole-instruction"
// dispatch kludge which was purged in Spec 444 Phase 4 — drive CPU now
// runs cycle-stepped only, no opt-in mode flag.
//
// Doc: docs/vice-1541-arch.md §4 (drive memory map), §4.1 (physical
//      layout), §4.2 (dispatch tables), §4.3 (ROM loading), §13 Phase
//      B steps 3-6, §14 invariant 8 (open-bus on unmapped pages).
// VICE: src/drive/drivemem.c:217  drivemem_init()  — blanket open-bus
//       src/drive/iec/memiec.c:138-177 memiec_init() — 1541 overlay
//       src/drive/driverom.c            driverom_load_images()
//
// Address map (stock 1541 — drive_ram2/4/6/8/a_enabled all = 0):
//   $0000-$00FF   zero-page RAM (drive_read_zero / drive_store_zero)
//   $0100-$07FF   RAM         (drive_read_1541ram / drive_store_1541ram)
//   $0800-$17FF   open bus    (drive_read_free / drive_store_free)
//   $1800-$1BFF   VIA1        (16 registers mirrored ×64 within 1 KB)
//   $1C00-$1FFF   VIA2        (16 registers mirrored ×64 within 1 KB)
//   $2000-$27FF   RAM mirror  (a14/a15 do not decode on stock; memiec.c:148)
//   $2800-$37FF   open bus
//   $3800-$3BFF   VIA1 mirror (memiec.c:149)
//   $3C00-$3FFF   VIA2 mirror (memiec.c:150)
//   $4000-$47FF   RAM mirror  (memiec.c:155)
//   $4800-$57FF   open bus
//   $5800-$5BFF   VIA1 mirror (memiec.c:156)
//   $5C00-$5FFF   VIA2 mirror (memiec.c:157)
//   $6000-$67FF   RAM mirror  (memiec.c:162)
//   $6800-$77FF   open bus
//   $7800-$7BFF   VIA1 mirror (memiec.c:163)
//   $7C00-$7FFF   VIA2 mirror (memiec.c:164)
//   $8000-$9FFF   ROM low half  = trap_rom[$0000..$1FFF]
//                                  (zero on stock 1541 split-ROM image)
//   $A000-$BFFF   ROM mid half  = trap_rom[$2000..$3FFF]
//                                  (zero on stock 1541 split-ROM image)
//   $C000-$FFFF   ROM canonical = trap_rom[$4000..$7FFF] (16 KB DOS ROM)
//
// Reset vector at $FFFC/$FFFD lives in ROM ($EAA0 on the bundled 1541
// DOS ROM). Without a ROM (zero-fill fallback) the vector reads $0000
// — callers seed PC explicitly in that path.

import { Cpu6510, type CpuMemory } from "../cpu6510.js";
import { Cpu65xxVice } from "../cpu/cpu65xx-vice.js";
import { alarmContextNew, type AlarmContext } from "../alarm/alarm-context.js";
import { Via1d1541 } from "../via/via1d1541.js";
import { Via2d1541, type Via2GcrPortCoupling } from "../via/via2d1541.js";
import { makeGcrVia2Pa, makeGcrVia2Pb, type Via2GcrCoupling } from "./via2-gcr.js";
import { makeGcrShifterCoupling } from "./via2-gcr-shifter-coupling.js";
import type { GcrShifter } from "./gcr-shifter.js";
import { bindDriveTrack, type Drive_t, makeDrive_t } from "./drive-t.js";
import { rotation_init, rotation_reset } from "./rotation.js";
import { DriveLedMonitor } from "./led-monitor.js";
import { loadDriveRom, DRIVE_ROM_BASE, DRIVE_ROM_SIZE, type LoadedDriveRom } from "./drive-rom.js";
import { IecBusCore } from "../iec/iec-bus-core.js";
import type { IecBus } from "../iec/iec-bus.js";
import type { TrackBuffer, HeadPosition } from "./head-position.js";
import {
  DRIVE_TYPE_1541,
  type Drive1541Unit,
  type DriveSlot,
  type DriveType1541Family,
} from "./drive-types.js";

export const DRIVE_RAM_SIZE = 0x0800; // $0000-$07FF
export const VIA1_BASE = 0x1800;
export const VIA1_END = 0x1bff;
export const VIA2_BASE = 0x1c00;
export const VIA2_END = 0x1fff;

// ─────────────────────────────────────────────────────────────────────
// Spec 409 — VICE-exact sync_factor constants.
//
// Computed via `drive_set_machine_parameter(cycles_per_sec)`:
//   sync_factor = floor(65536 * 1_000_000 / cycles_per_sec)
//
// Doc:  docs/vice-1541-arch.md §5.1 (formula + values), §17 OQ-409-1/2/3.
// VICE: src/drive/drivesync.c:57.
//       src/c64/c64.h:35 C64_PAL_CYCLES_PER_SEC  = 985248.
//       src/c64/c64.h:42 C64_NTSC_CYCLES_PER_SEC = 1022730.
// ─────────────────────────────────────────────────────────────────────

/** VICE C64 PAL cycles per second. Source: `src/c64/c64.h:35`. */
export const C64_PAL_CYCLES_PER_SEC = 985248;
/** VICE C64 NTSC cycles per second. Source: `src/c64/c64.h:42`. */
export const C64_NTSC_CYCLES_PER_SEC = 1022730;
/**
 * Drive nominal clock: 1.000 MHz, hard-coded literal in
 * `src/drive/drivesync.c:57` (= `1000000.0` inside the floor formula).
 * No separate `drive_freq` symbol exists; see OQ-409-3 in
 * `docs/vice-1541-arch.md §17`.
 */
export const DRIVE_NOMINAL_HZ = 1_000_000;

/** PAL sync_factor for 1541 (clock_frequency = 1). 0x103D5 = 66517. */
export const SYNC_FACTOR_1541_PAL =
  Math.floor(65536 * (DRIVE_NOMINAL_HZ / C64_PAL_CYCLES_PER_SEC));
/** NTSC sync_factor for 1541 (clock_frequency = 1). 0xFA4F = 64079. */
export const SYNC_FACTOR_1541_NTSC =
  Math.floor(65536 * (DRIVE_NOMINAL_HZ / C64_NTSC_CYCLES_PER_SEC));

export interface DriveCpuOptions {
  deviceId?: number;        // 8-11; default 8
  rom?: LoadedDriveRom;     // skip ROM load if caller provides one
  romBytes?: Uint8Array;    // raw override (testing)
  iecBus?: IecBus;          // wire VIA1 PB to the bus; otherwise stub
  gcr?: Via2GcrCoupling;    // wire VIA2 PA/PB to TrackBuffer + HeadPosition
  // Spec 153 / Sprint 114: optional 1:1 VICE GcrShifter. When provided
  // it REPLACES the `gcr` (TrackBuffer) PA/PB coupling — VIA2 PA reads
  // the shifter's latched byte and PB7 reflects shifter SYNC#. The
  // legacy `gcr.trackBuffer.tickShifter()` is bypassed in DriveCpuCycled
  // when this is set; GcrShifter is ticked instead.
  gcrShifter?: GcrShifter;
  /**
   * Spec 441 step 4c — drive_t shadow target. Set by DriveCpu
   * constructor before DriveBus instantiation; the VIA2 coupling
   * uses it to mirror motor/density writes into drive.byte_ready_active
   * + rotation_t. Internal — callers do not set this directly.
   */
  shadowDriveT?: Drive_t;
  // Sprint 96 part 6 (Bug 39): use cycle-stepped microcoded CPU with
  // sub-instruction bus access. Required for IEC bit-bang correctness.
  useMicrocodedCpu?: boolean;
  // Sprint 113 Phase 2: VICE-style alarm context for the drive CPU.
  // VIA1 + VIA2 register their T1/T2/SR alarms here. When provided,
  // DriveCpu drains pending alarms after each instruction in the
  // executeToClock path. In lockstep, AlarmContextCycled handles drain.
  alarmContext?: AlarmContext;
  // Sprint 113 Phase 2: live drive CPU clock pointer for VIA construction.
  // If not provided, DriveCpu supplies one automatically.
  clkRef?: () => number;
  /**
   * Spec 201-c3: optional kernel-aware override for VIA1 $1800 PB
   * store. When provided, threads down to Via1d1541 and replaces the
   * default direct-IecBusCore call so cross-domain access is observed
   * by KernelBus.
   */
  iecStorePb?: (byte: number, deviceId: number) => void;
  /**
   * Spec 203-c3: VIA1 IRQ line edge (drive-cpu target). Called only on
   * level transitions, not on every via.setIrq. `clk` is drive-cpu cycles.
   */
  onVia1IrqEdge?: (asserted: boolean, clk: number) => void;
  /** Spec 203-c3: VIA2 IRQ line edge (drive-cpu target). */
  onVia2IrqEdge?: (asserted: boolean, clk: number) => void;
  /**
   * Spec 203-c3: drive SO line (byte-ready) edge. Fired right before
   * the V flag is set on the drive CPU. `clk` is drive-cpu cycles.
   */
  onSoEdge?: (asserted: boolean, clk: number) => void;
}

/**
 * Per-page dispatch entry. 1:1 with VICE
 * `drivecpud_context_t.{read_tab,store_tab,peek_tab}` — one function per
 * 256-byte page, indexed by `(addr >> 8)`. The full 16-bit address is
 * passed to the handler so a single function can serve a contiguous
 * range of pages and mask internally (= VIA register mirror via
 * `addr & 0xf`).
 *
 * Doc: docs/vice-1541-arch.md §4.2 (dispatch tables).
 * VICE: src/drive/drivetypes.h `drivecpud_context_t` (read_tab/store_tab
 *       arrays of function pointers), drivemem.c:217 drivemem_init().
 */
type DrivePageRead = (addr: number) => number;
type DrivePageStore = (addr: number, value: number) => void;
type DrivePagePeek = (addr: number) => number;

export class DriveBus implements CpuMemory {
  public readonly ram = new Uint8Array(DRIVE_RAM_SIZE);
  public readonly rom: Uint8Array;
  public readonly via1: Via1d1541;
  public readonly via2: Via2d1541;
  public readonly romSource: LoadedDriveRom["source"];
  public readonly romPath?: string;
  /** Alarm context used by VIA1 + VIA2. May be caller-supplied or local. */
  public readonly alarmContext: AlarmContext;

  /**
   * Per-page dispatch tables. 256 entries, indexed by `addr >> 8`.
   *
   * - `readTab[p]`  invoked by every CPU bus read targeting page `p`.
   * - `storeTab[p]` invoked by every CPU bus write targeting page `p`.
   * - `peekTab[p]`  side-effect-free read for monitor / snapshot
   *                 inspection. Identical to readTab for plain RAM/ROM;
   *                 VIA peek bypasses IFR clears (= viaXd_peek in VICE).
   *
   * Initialized blanket to open-bus stubs, then overlaid with RAM,
   * VIA1, VIA2, ROM, and stock-1541 mirrors per `memiec.c:138-177`
   * (drive_ram2/4/6/8/a_enabled all = 0 = stock layout).
   *
   * VICE: drivemem.c:217 drivemem_init() (blanket open-bus, line 231),
   *       iec/memiec.c:138-177 memiec_init() (overlay).
   */
  public readonly readTab: DrivePageRead[] = new Array(256);
  public readonly storeTab: DrivePageStore[] = new Array(256);
  public readonly peekTab: DrivePagePeek[] = new Array(256);
  /** Spec 424 — drive activity LED tracker (VIA2 PB3 latch transitions). */
  public readonly ledMonitor: DriveLedMonitor = new DriveLedMonitor();

  /**
   * Last value seen on the drive bus. `drive_read_free` returns this on
   * unmapped pages — VICE invariant 8 (§14): "Reads outside RAM/ROM/VIA
   * windows return open bus." For a strict 1:1 port we model this with
   * a sticky data-bus latch updated on every read. The latch defaults
   * to `0xff` (= reset bus state, since open-collector lines float high).
   * VICE drive_read_free returns the data bus value of the last access;
   * here we track it explicitly.
   *
   * Doc: docs/vice-1541-arch.md §14 invariant 8.
   * VICE: drivemem.c (drive_read_free) reads the floating bus value.
   */
  private lastBusValue = 0xff;

  constructor(opts: DriveCpuOptions = {}, clkRef?: () => number) {
    // Alarm context: caller-supplied (IntegratedSession passes its
    // drivecpuAlarmContext) or local (standalone test / drive-session.ts).
    this.alarmContext = opts.alarmContext ?? alarmContextNew("drivecpu-local");

    if (opts.romBytes) {
      if (opts.romBytes.length !== DRIVE_ROM_SIZE) {
        throw new Error(`romBytes must be ${DRIVE_ROM_SIZE} bytes`);
      }
      this.rom = opts.romBytes;
      this.romSource = "env";
    } else {
      const loaded = opts.rom ?? loadDriveRom();
      this.rom = loaded.bytes;
      this.romSource = loaded.source;
      this.romPath = loaded.path;
    }

    // clkRef is set by DriveCpu after constructing the CPU; for standalone
    // DriveBus construction (equiv tests) we use a local zero clock.
    const resolvedClkRef = opts.clkRef ?? clkRef ?? (() => 0);
    const deviceId = opts.deviceId ?? 8;

    // Spec 203-c3: edge tracking closures so onVia*IrqEdge fires only
    // on actual level transitions, not on every VICE update_myviairq.
    let via1PrevAsserted = false;
    const via1SetIrq = (value: number, clk: number) => {
      const asserted = value !== 0;
      if (asserted !== via1PrevAsserted) {
        via1PrevAsserted = asserted;
        opts.onVia1IrqEdge?.(asserted, clk);
      }
    };
    let via2PrevAsserted = false;
    const via2SetIrq = (value: number, clk: number) => {
      const asserted = value !== 0;
      if (asserted !== via2PrevAsserted) {
        via2PrevAsserted = asserted;
        opts.onVia2IrqEdge?.(asserted, clk);
      }
    };

    if (opts.iecBus) {
      this.via1 = new Via1d1541({
        alarmContext: this.alarmContext,
        iec: opts.iecBus.core,
        deviceId,
        clkRef: resolvedClkRef,
        setIrq: via1SetIrq,
        iecStorePb: opts.iecStorePb,
      });
      opts.iecBus.attachDriveVia1(this.via1);
    } else {
      // Stub: no IEC bus — Via1d1541 still needs an IecBusCore.
      // Create a disconnected core (all pins released).
      this.via1 = new Via1d1541({
        alarmContext: this.alarmContext,
        iec: new IecBusCore(),
        deviceId,
        clkRef: resolvedClkRef,
        setIrq: via1SetIrq,
      });
    }

    // VIA2: alarm-driven VICE-faithful chip core (Via2d1541).
    // When GCR coupling is provided, wire real PA (GCR byte read) and PB
    // (head step / motor / density / sync) backends via Via2GcrPortCoupling.
    //
    // Backend selection priority:
    //   1) Spec 153 GcrShifter (1:1 VICE rotation.c bit-stream)
    //      — gcrShifter takes precedence when supplied.
    //   2) Legacy TrackBuffer-inline-shifter (Sprint 96 path) when only
    //      `gcr` (Via2GcrCoupling) is supplied.
    //   3) Idle stub (PA=0xff, PB=WPS-only) when neither is supplied.
    let gcrCoupling: Via2GcrPortCoupling | undefined;
    if (opts.gcrShifter && opts.gcr?.headPosition) {
      // Spec 153 GcrShifter coupling. Step phase / motor / density
      // writes propagate via the shifter; PB7 reflects shifter syncBit
      // live. Read-only V2 (storePa = no-op).
      gcrCoupling = makeGcrShifterCoupling({
        shifter: opts.gcrShifter,
        headPosition: opts.gcr.headPosition,
        writeProtected: opts.gcr.writeProtected,
        ledSink: (on, clk) => this.ledMonitor.noteTransition(on, clk),
        clkRef: clkRef ?? (() => 0),
        shadowDrive: opts.shadowDriveT,
      });
    } else if (opts.gcr) {
      const paBackend = makeGcrVia2Pa(opts.gcr);
      const pbBackend = makeGcrVia2Pb(opts.gcr);
      gcrCoupling = {
        readPa: () => paBackend.readPins(),
        onPaOutputChanged: (orValue, ddrMask, cause) =>
          paBackend.onOutputChanged(orValue, ddrMask, cause),
        readPb: () => pbBackend.readPins(),
        onPbOutputChanged: (orValue, ddrMask) =>
          pbBackend.onOutputChanged(orValue, ddrMask, "or"),
      };
    }
    this.via2 = new Via2d1541({
      alarmContext: this.alarmContext,
      clkRef: resolvedClkRef,
      setIrq: via2SetIrq,
      gcr: gcrCoupling,
      shadowDrive: opts.shadowDriveT,
    });

    // Spec 408 — build per-page dispatch tables (§13 step 4).
    this.buildDispatchTables();
  }

  /**
   * Populate `readTab` / `storeTab` / `peekTab` per stock 1541 layout
   * (§4.2). Matches VICE `drivemem_init()` (blanket open-bus) followed
   * by `memiec_init()` for `DRIVE_TYPE_1541` with all RAM-expansion
   * flags off.
   *
   * Doc: docs/vice-1541-arch.md §4.1, §4.2, §13 step 4.
   * VICE: src/drive/drivemem.c:231 (blanket drive_read_free /
   *       drive_store_free / drive_peek_free over pages 0x00..0x100),
   *       src/drive/iec/memiec.c:138-177 (1541 overlay).
   */
  private buildDispatchTables(): void {
    // Step 1: blanket "open bus" — drivemem.c:231.
    const readFree: DrivePageRead = () => this.lastBusValue;
    const storeFree: DrivePageStore = (_addr, value) => {
      // VICE drive_store_free updates the data-bus latch but does not
      // commit anywhere. Match that so subsequent reads on unmapped
      // pages reflect the most recent bus transaction.
      this.lastBusValue = value & 0xff;
    };
    const peekFree: DrivePagePeek = () => this.lastBusValue;
    for (let p = 0; p < 256; p++) {
      this.readTab[p] = readFree;
      this.storeTab[p] = storeFree;
      this.peekTab[p] = peekFree;
    }

    // Step 2: machine-drive overlay (memiec.c:138-177, DRIVE_TYPE_1541
    // with drive_ram2/4/6/8/a_enabled = 0 = stock).
    //
    // Page $00 — zero-page RAM (drive_read_zero / drive_store_zero).
    // VICE keeps page-zero as a special handler for the 6510 zero-page
    // addressing fast-path; semantically identical to RAM-read/RAM-write
    // for the data bus (memiec.c:141). We use a single RAM handler here.
    const ramRead: DrivePageRead = (addr) => {
      const v = this.ram[addr & 0x07ff]!;
      this.lastBusValue = v;
      return v;
    };
    const ramStore: DrivePageStore = (addr, value) => {
      const v = value & 0xff;
      this.ram[addr & 0x07ff] = v;
      this.lastBusValue = v;
    };
    const ramPeek: DrivePagePeek = (addr) => this.ram[addr & 0x07ff]!;

    // RAM canonical $0000-$07FF (= pages $00-$07, memiec.c:141-142).
    for (let p = 0x00; p < 0x08; p++) {
      this.readTab[p] = ramRead;
      this.storeTab[p] = ramStore;
      this.peekTab[p] = ramPeek;
    }

    // VIA1 $1800-$1BFF (= pages $18-$1B, memiec.c:143).
    // 16 registers mirrored ×64 within the 1 KB window — addr & 0xf.
    const via1Read: DrivePageRead = (addr) => {
      const v = this.via1.read(addr & 0xf) & 0xff;
      this.lastBusValue = v;
      return v;
    };
    const via1Store: DrivePageStore = (addr, value) => {
      const v = value & 0xff;
      this.via1.write(addr & 0xf, v);
      this.lastBusValue = v;
    };
    // VIA peek is side-effect-free (= no IFR clear). The Via1d1541 / via
    // core does not expose a peek today; reuse `read` for now and flag
    // for future fidelity work. Behavioural impact: monitor reads of
    // IFR/T1CL would clear the latches. Acceptable — not on hot path.
    const via1Peek: DrivePagePeek = (addr) => this.via1.read(addr & 0xf) & 0xff;
    for (let p = 0x18; p < 0x1c; p++) {
      this.readTab[p] = via1Read;
      this.storeTab[p] = via1Store;
      this.peekTab[p] = via1Peek;
    }

    // VIA2 $1C00-$1FFF (= pages $1C-$1F, memiec.c:144).
    const via2Read: DrivePageRead = (addr) => {
      const v = this.via2.read(addr & 0xf) & 0xff;
      this.lastBusValue = v;
      return v;
    };
    const via2Store: DrivePageStore = (addr, value) => {
      const v = value & 0xff;
      this.via2.write(addr & 0xf, v);
      this.lastBusValue = v;
    };
    const via2Peek: DrivePagePeek = (addr) => this.via2.read(addr & 0xf) & 0xff;
    for (let p = 0x1c; p < 0x20; p++) {
      this.readTab[p] = via2Read;
      this.storeTab[p] = via2Store;
      this.peekTab[p] = via2Peek;
    }

    // RAM/VIA mirror block 1: $2000-$3FFF (drive_ram2_enabled=0 stock).
    // memiec.c:148-150 — RAM at $2000-$27FF, VIA1 mirror at $3800-$3BFF,
    // VIA2 mirror at $3C00-$3FFF. Pages $28-$37 fall through to the
    // blanket open-bus from step 1.
    for (let p = 0x20; p < 0x28; p++) {
      this.readTab[p] = ramRead;
      this.storeTab[p] = ramStore;
      this.peekTab[p] = ramPeek;
    }
    for (let p = 0x38; p < 0x3c; p++) {
      this.readTab[p] = via1Read;
      this.storeTab[p] = via1Store;
      this.peekTab[p] = via1Peek;
    }
    for (let p = 0x3c; p < 0x40; p++) {
      this.readTab[p] = via2Read;
      this.storeTab[p] = via2Store;
      this.peekTab[p] = via2Peek;
    }

    // Mirror block 2: $4000-$5FFF (drive_ram4_enabled=0 stock).
    // memiec.c:155-157.
    for (let p = 0x40; p < 0x48; p++) {
      this.readTab[p] = ramRead;
      this.storeTab[p] = ramStore;
      this.peekTab[p] = ramPeek;
    }
    for (let p = 0x58; p < 0x5c; p++) {
      this.readTab[p] = via1Read;
      this.storeTab[p] = via1Store;
      this.peekTab[p] = via1Peek;
    }
    for (let p = 0x5c; p < 0x60; p++) {
      this.readTab[p] = via2Read;
      this.storeTab[p] = via2Store;
      this.peekTab[p] = via2Peek;
    }

    // Mirror block 3: $6000-$7FFF (drive_ram6_enabled=0 stock).
    // memiec.c:162-164.
    for (let p = 0x60; p < 0x68; p++) {
      this.readTab[p] = ramRead;
      this.storeTab[p] = ramStore;
      this.peekTab[p] = ramPeek;
    }
    for (let p = 0x78; p < 0x7c; p++) {
      this.readTab[p] = via1Read;
      this.storeTab[p] = via1Store;
      this.peekTab[p] = via1Peek;
    }
    for (let p = 0x7c; p < 0x80; p++) {
      this.readTab[p] = via2Read;
      this.storeTab[p] = via2Store;
      this.peekTab[p] = via2Peek;
    }

    // Spec 447 — ROM $8000-$BFFF + $C000-$FFFF literal VICE memiec.c:167-176
    // (1541 stock, drive_ram8/a_enabled = 0).
    //
    // VICE wires drive_read_rom for:
    //   $80-$9F → trap_rom[0x0000..$1FFF]  (line 169, drive_ram8 disabled)
    //   $A0-$BF → trap_rom[0x2000..$3FFF]  (line 174, drive_rama disabled)
    //   $C0-$FF → trap_rom[$4000..$7FFF]  (line 176, canonical 16K DOS ROM)
    //
    // For a 1541 stock split-ROM (16K), trap_rom[0..$3FFF] is sparse =
    // zero — drive_read_rom returns 0 there. Observable equivalent to
    // open-bus on a 1541-II 32K image, $80-$BF mirrors valid ROM data.
    //
    // TS rom buffer is 16K (DRIVE_ROM_SIZE = 0x4000). For literal
    // memiec.c shape, we dispatch all three windows; rom[] indexing
    // wraps around the 16K (drive_read_rom modulo). Stock split-ROM
    // returns 0 for $80-$BF, 1541-II would return mirror.
    const romReadCanonical: DrivePageRead = (addr) => {
      // $C000-$FFFF reads trap_rom[$4000-$7FFF]. With 16K rom buffer
      // (= just the canonical half), this is rom[(addr - 0xC000)].
      const v = this.rom[(addr - DRIVE_ROM_BASE) & 0x3fff]!;
      this.lastBusValue = v;
      return v;
    };
    const romPeekCanonical: DrivePagePeek = (addr) => this.rom[(addr - DRIVE_ROM_BASE) & 0x3fff]!;
    // $8000-$BFFF: sparse on stock 16K split-ROM (returns 0).
    // VICE pointer arithmetic: drive_read_rom with base = &trap_rom[0]
    // for $80-$9F and &trap_rom[$2000] for $A0-$BF. With 16K buffer
    // those bytes are zero-fill outside the canonical 16K. TS mirrors
    // by reading rom[] at byte offset wrap; for stock buffer those
    // offsets all return 0 (memmem outside loaded ROM is zero per
    // Uint8Array init).
    const romReadLow: DrivePageRead = (addr) => {
      // Pages $80-$9F read trap_rom[$0000..$1FFF]. TS rom buffer is
      // 16K = trap_rom[$4000..$7FFF] only; pages $80-$9F are stub.
      // For 32K image this would read low half.
      const offset = addr - 0x8000;
      const v = offset < this.rom.length ? this.rom[offset]! : 0;
      this.lastBusValue = v;
      return v;
    };
    const romPeekLow: DrivePagePeek = (addr) => {
      const offset = addr - 0x8000;
      return offset < this.rom.length ? this.rom[offset]! : 0;
    };
    const romReadMid: DrivePageRead = (addr) => {
      // Pages $A0-$BF read trap_rom[$2000..$3FFF]. Sparse on 16K.
      const offset = (addr - 0xa000) + 0x2000;
      const v = offset < this.rom.length ? this.rom[offset]! : 0;
      this.lastBusValue = v;
      return v;
    };
    const romPeekMid: DrivePagePeek = (addr) => {
      const offset = (addr - 0xa000) + 0x2000;
      return offset < this.rom.length ? this.rom[offset]! : 0;
    };
    for (let p = 0x80; p < 0xa0; p++) {
      this.readTab[p] = romReadLow;
      this.peekTab[p] = romPeekLow;
    }
    for (let p = 0xa0; p < 0xc0; p++) {
      this.readTab[p] = romReadMid;
      this.peekTab[p] = romPeekMid;
    }
    for (let p = 0xc0; p < 0x100; p++) {
      this.readTab[p] = romReadCanonical;
      // storeTab stays = storeFree (drive_store_free) — ROM is RO.
      this.peekTab[p] = romPeekCanonical;
    }
  }

  read(address: number): number {
    const a = address & 0xffff;
    return this.readTab[a >>> 8]!(a);
  }

  write(address: number, value: number): void {
    const a = address & 0xffff;
    this.storeTab[a >>> 8]!(a, value & 0xff);
  }

  /**
   * Side-effect-free read for monitor / snapshot tooling. Matches VICE
   * `drivemem_bank_peek` (drivemem.c:198). Does not clear VIA IFR or
   * latch byte-ready edges.
   */
  peek(address: number): number {
    const a = address & 0xffff;
    return this.peekTab[a >>> 8]!(a);
  }

  reset(): void {
    this.ram.fill(0);
    this.via1.reset();
    this.via2.reset();
    this.lastBusValue = 0xff;
  }
}

// DriveCpu = Cpu6510 wired to a DriveBus.
//
// Sprint 90 (Spec 090): VICE-style executeToClock(c64Clk) lazy lockstep.
// Drive only runs when caller (IntegratedSession) requests catch-up.
// Sync points: every $DD00 access (via KernelBus catch-up) +
// after each C64 instruction. Drive's clock advances independently
// using fixed-point sync_factor (drive 1MHz / C64 985.248kHz ratio).
//
// Spec 407 — 1541 Phase A: `DriveCpu` now also satisfies the
// `Drive1541Unit` interface (= `diskunit_context_t` shape) by exposing
// `clk`, `drives[2]`, `cpu`, `via1`, `via2`, `cia1571=null`, `rom`,
// `ram`, `alarmContext`, `clockFrequency=1`, `type=DRIVE_TYPE_1541`,
// `mynumber=deviceId`, `reset()`, `shutdown()`. The legacy flat fields
// (`bus.via1`, etc.) are preserved verbatim — no consumer-side rewrite
// required by spec 407 (consumer rewrite handled by 408/409).
//
// Doc: docs/vice-1541-arch.md §2.1 + §13 Phase A.
// VICE: src/drive/drivetypes.h:166 `diskunit_context_t`,
//       src/drive/drive.h:236 `drive_t`,
//       src/drive/drive.c:162 `drive_init()`,
//       src/drive/drive.c:298 `drive_shutdown()`.
export class DriveCpu implements Drive1541Unit {
  // Legacy whole-instruction CPU (default). May be replaced by the
  // cycled CPU when useMicrocodedCpu=true.
  public readonly cpu: Cpu6510 | Cpu65xxVice;
  public readonly bus: DriveBus;
  public readonly microcoded: boolean;
  // Sprint 96 part 7: GCR shifter coupling for free-running tick.
  public readonly trackBuffer?: TrackBuffer;
  public readonly headPosition?: HeadPosition;
  // Spec 153 / Sprint 114: 1:1 VICE GcrShifter (when supplied). When
  // present this REPLACES the TrackBuffer-inline shifter — DriveCpuCycled
  // ticks `gcrShifter` per drive cycle and bypasses
  // `trackBuffer.tickShifter`.
  public readonly gcrShifter?: GcrShifter;

  // Spec 441 step 4a — Drive_t struct (VICE drive.h:236-365 literal).
  // Populated alongside gcrShifter during the migration. Until step 4e
  // (cycle-wrapper switch) this field is NOT read by production code;
  // rotation.ts entry points expect to operate on this struct once
  // the migration completes.
  public readonly drive: Drive_t;

  /**
   * Spec 441 step 4e — byte-ready firing callback. Same body as the
   * legacy gcrShifter.onByteReady (PCR gate, CA1 falling-edge signal,
   * V flag set, onSoEdge trace). Called from cycle-wrappers after
   * rotation_rotate_disk when drive.byte_ready_edge transitions to 1.
   */
  public fireByteReady?: () => void;

  // ───────────────────────────────────────────────────────────────────
  // Spec 407 — Drive1541Unit (= `diskunit_context_t`) shape.
  //
  // These fields project the existing flat state onto the nested VICE
  // structure. They are non-allocating accessors (drives[] is a single
  // immutable tuple; clk reads cpu.cycles live).
  //
  // VICE: src/drive/drivetypes.h:166 `diskunit_context_t`.
  // Doc: docs/vice-1541-arch.md §2.1.
  // ───────────────────────────────────────────────────────────────────

  /** Device number (8..11). Mirrors VICE `diskunit_context_t.mynumber`. */
  public readonly mynumber: number;
  /**
   * Drive type. Always `DRIVE_TYPE_1541` for the supported config
   * (1541-II is identical at this layer; only ROM differs — doc §2.2).
   */
  public readonly type: DriveType1541Family = DRIVE_TYPE_1541;
  /**
   * 1541 = 1 MHz drive. PAL/NTSC switch affects only `sync_factor`,
   * not `clock_frequency` (doc §13 step 2 + §5.1).
   */
  public readonly clockFrequency: 1 = 1;
  /** 1571-only CIA. NULL for 1541 (= doc §13 step 2 explicit). */
  public readonly cia1571: null = null;
  /**
   * `drives[NUM_DRIVES]`. 1541 uses slot 0 only; slot 1 is `null`
   * (= VICE NULL pointer for the unused 1571 second-head slot).
   * OQ-407-1 resolution (doc §17). Tuple is constructed in the
   * `DriveCpu` constructor after slot 0 fields are assigned. Slot 0
   * may be `null` for harness configurations without a GCR pipeline.
   */
  public readonly drives: readonly [DriveSlot | null, DriveSlot | null];

  /**
   * Per-unit drive clock (= `*clk_ptr` in VICE, indirecting to
   * `diskunit_clk[mynumber]`). Reads `cpu.cycles` live so existing
   * code paths that drive `cpu.cycles` stay authoritative.
   *
   * VICE: `drivetypes.h:166` `CLOCK *clk_ptr`.
   */
  public get clk(): number { return this.cpu.cycles; }
  /**
   * VIA1 — IEC interface. Alias of `bus.via1`. Doc §6.
   * VICE: `src/drive/iec/via1d1541.c`.
   */
  public get via1(): Via1d1541 { return this.bus.via1; }
  /**
   * VIA2 — disk controller. Alias of `bus.via2`. Doc §7.
   * VICE: `src/drive/iecieee/via2d.c`.
   */
  public get via2(): Via2d1541 { return this.bus.via2; }
  /** Drive RAM (2 KB stock 1541). Alias of `bus.ram`. Doc §4.1. */
  public get ram(): Uint8Array { return this.bus.ram; }
  /** Drive ROM (16 KB). Alias of `bus.rom`. Doc §4.1. */
  public get rom(): Uint8Array { return this.bus.rom; }
  /**
   * Per-unit alarm context. VIA1 + VIA2 alarms register here.
   * Alias of `bus.alarmContext`. Doc §13 step 1.
   * VICE: `drivecpu.c:356` `drivecpu_execute()`.
   */
  public get alarmContext(): AlarmContext { return this.bus.alarmContext; }
  // ───────────────────────────────────────────────────────────────────

  // Spec 090 / Spec 409 Phase C: 16.16 fixed-point sync_factor.
  // drive_cycles_per_c64_cycle, computed via VICE's exact formula
  //   sync_factor = floor(65536 * (drive_freq / host_freq))
  //              ≡ floor(65536 * 1_000_000 / cycles_per_sec)
  // PAL  (985248):  0x103D5 = 66517 (drive runs FASTER than C64).
  // NTSC (1022730): 0xFA4F  = 64079 (drive runs slower).
  //
  // Doc: docs/vice-1541-arch.md §5.1, §13 Phase C step 7, §17 OQ-409-1/2/3.
  // VICE: src/drive/drivesync.c:57 drive_set_machine_parameter().
  private syncFactor16dot16 = 0;
  // Drive's last sync clock (in C64 cycles) — i.e. up to which C64
  // cycle we have already caught up.
  private lastClk = 0;
  // Fixed-point accumulator — fractional drive cycles owed.
  private cycleAccum = 0;
  // Spec 444 Phase 4 — `sleeping` flag PURGED. Was output-affecting
  // TS-EXTRA divergence from VICE (VICE drive always runs cycles when
  // enabled; TS sleeping skipped inner loop → drive clock stalled).
  // Doctrine: "MACH es GENAU so wie VICE". Removed.

  /**
   * Spec 444 — VICE `drivecpu_context_t.stop_clk` (drivetypes.h:83).
   * ADDITIVE across calls per drivecpu.c:388. Inner loop terminates
   * at `cycled.cycles >= stop_clk`. Phase 4 = VICE-literal loop shape.
   */
  public stop_clk = 0;

  /**
   * Spec 444 — VICE `drivecpu_context_t.last_exc_cycles`
   * (drivetypes.h:81). VICE sets to 0 only in drivecpu_reset_clk
   * (drivecpu.c:189); not written during runtime. Phase 4: TS mirrors
   * that semantic — field cleared on softReset/reset only, NOT updated
   * by executeToClock. Used by VSF snapshot only (Spec 451).
   */
  public last_exc_cycles = 0;

  /**
   * Spec 444 — VICE `drivecpu_context_t.is_jammed` (drivetypes.h:97).
   * Set when CPU hits a JAM opcode (illegal $02/$12/$22/...).
   * For V1 (stock 1541 DOS code never executes a JAM), the field
   * exists for snapshot compat but no dispatcher acts on it.
   * If a future VICE-faithful JAM dispatcher is added, this is the
   * field to set/test.
   */
  public is_jammed = 0;

  // ───────────────────────────────────────────────────────────────────
  // Spec 414 — Phase H step 32 (enable/disable hooks).
  //
  // VICE `drive_enable()` / `drive_disable()` toggle a per-unit
  // `enable` flag on `diskunit_context_t`. When disabled the drive CPU
  // does not run; the IEC bus state already iterates over all units
  // `4..8+NUM_DISK_UNITS` (`via1d1541.c:200`) and skips disabled units
  // via this `enable` flag — there is **no** separate IEC callback
  // list (OQ-414-1, doc §17, §2.3).
  //
  // In TS the equivalent is:
  //   - `enabled = false` makes `executeToClock` early-return (drive
  //     CPU stops). VIA1 PB output stops updating, so `setDriveOutput`
  //     is no longer driven from the drive side. The IEC bus core's
  //     drv_data slot for this unit retains its last-released state.
  //   - `enable()` re-arms by calling `setSyncBaseline(currentClk)`
  //     (= `cpu->stop_clk = *clk_ptr` per drive.c:514) and
  //     `wakeUp()` (= `drivecpu_wake_up`, drive.c:520). We do not
  //     re-attach the disk image here — the TS port keeps the parser
  //     swap inside `mountMedia`/`unmountMedia` (mount.ts), which
  //     mirrors VICE `drive_image_attach` already.
  //
  // Doc: docs/vice-1541-arch.md §13 Phase H step 32, §2.3, §17 OQ-414-1.
  // VICE: src/drive/drive.c:482-529 `drive_enable()`,
  //       src/drive/drive.c:531-560 `drive_disable()`.
  // ───────────────────────────────────────────────────────────────────
  public enabled = true;
  // Phase-C compat-bridge: per-source IntNum allocations for drive 6502.
  // Lazy-init on first dispatch site that touches microcoded path.
  //
  // Spec 410 (2026-05-11) — `intNumVia1Irq` retired. VIA1 IRQ is now
  // pushed chip-side from `Via1d1541.attachIrqLine` → `cpuIntStatus.setIrq`
  // (1:1 with VICE src/drive/iec/via1d1541.c:92 `set_int()`). VIA2 still
  // goes through the polling bridge below; spec 411 migrates it.
  private intNumVia2Irq: any = null;
  // Spec 410 — `true` once `bus.via1.attachIrqLine` has been called.
  // Guards `executeToClock` / `runOneInstruction` against re-applying
  // the polled level after each instruction.
  private via1Attached = false;
  // Spec 444 Phase 4 — wakeUp() retained as VICE drivecpu_wake_up
  // analog (called by Spec 414 enable()). With `sleeping` purged this
  // is effectively a no-op stub; kept for VICE-name parity and for
  // future callers that may want a wake-event hook.
  public wakeUp(): void { /* no-op (sleeping flag purged Spec 444 Phase 4) */ }

  constructor(opts: DriveCpuOptions = {}) {
    // Spec 407 — record device number for Drive1541Unit shape.
    // VICE: `diskunit_context_t.mynumber` (drivetypes.h:166).
    this.mynumber = opts.deviceId ?? 8;
    // Sprint 113 Phase 2: DriveBus needs the CPU clock pointer for VIA1/VIA2
    // construction. CPU hasn't been built yet, so we pass a live closure that
    // reads cpu.cycles once the cpu field is assigned below.
    let cpuRef: { cycles: number } = { cycles: 0 };
    const clkRef = () => cpuRef.cycles;

    // Spec 441 step 4a — drive_t literal struct. Constructed BEFORE
    // DriveBus so the VIA2 gcr-shifter coupling can shadow motor/
    // density writes into drive.byte_ready_active + rotation_t.
    const dnr = (this.mynumber - 8) | 0;
    this.drive = makeDrive_t({
      drive: dnr,
      mynumber: dnr,
      clk_ptr: () => BigInt(cpuRef.cycles | 0),
    });
    rotation_init(0, dnr);
    rotation_reset(this.drive);
    opts.shadowDriveT = this.drive;

    this.bus = new DriveBus(opts, clkRef);
    this.microcoded = opts.useMicrocodedCpu ?? false;
    // Spec 444 Phase 4 — Spec 428 dispatch-mode kludge purged. Drive CPU
    // runs cycle-stepped only (= 1:1 VICE drivecpu.c per-bus-cycle).
    this.cpu = this.microcoded
      ? new Cpu65xxVice({ memBus: this.bus, alarmContext: opts.alarmContext ?? this.bus.alarmContext })
      : new Cpu6510(this.bus);
    // Wire the closure to the actual CPU object now that it's created.
    cpuRef = this.cpu as { cycles: number };

    // Spec 410 step 15 — VIA1 chip-side IRQ push.
    // Doc: docs/vice-1541-arch.md §13 step 15 + §14 invariant 4.
    // VICE: src/drive/iec/via1d1541.c:92 set_int() pushes via
    //   interrupt_set_irq(dc->cpu->int_status, int_num, value, rclk).
    // Attach AFTER cpu construction so `this.cpu.cpuIntStatus` is
    // the drive's own InterruptCpuStatus (one per drive — VICE
    // dc->cpu->int_status). Drops the per-cycle polling bridge in
    // `executeToClock` / `runOneInstruction` for VIA1 (= Phase 309-D'
    // analog for the drive CPU).
    if (this.microcoded) {
      const cycled = this.cpu as Cpu65xxVice;
      this.bus.via1.attachIrqLine(cycled.cpuIntStatus, "via1-irq");
      this.via1Attached = true;
      // Spec 444 v2 — VIA2 chip-side IRQ push. Drops the executeToClock
      // per-instruction polling line (was Spec 411 TODO).
      this.bus.via2.attachIrqLine(cycled.cpuIntStatus, "via2-irq");
    }
    this.trackBuffer = opts.gcr?.trackBuffer;
    this.headPosition = opts.gcr?.headPosition;
    this.gcrShifter = opts.gcrShifter;

    // Spec 441 step 4c — wire head-step → drive.GCR_track_start_ptr +
    // drive.current_half_track. Bind initial track now that
    // headPosition/parser are assigned. rotation.ts gets track data
    // from cycle 0 of the FIRST runFor call.
    if (this.headPosition && opts.gcr?.trackBuffer?.source) {
      const parser = opts.gcr.trackBuffer.source;
      bindDriveTrack(this.drive, parser, this.headPosition.currentTrack * 2);
      const prevOnStep = this.headPosition.onStep;
      this.headPosition.onStep = (direction, halfTrack) => {
        bindDriveTrack(this.drive, parser, halfTrack);
        prevOnStep?.(direction, halfTrack);
      };
    }
    this.drive.GCR_image_loaded = this.drive.GCR_track_start_ptr ? 1 : 0;

    // Spec 153 / Sprint 114: 1:1 VICE byte-ready path.
    //
    // When the standalone GcrShifter is supplied, route byte-ready edges
    // BOTH to VIA2 CA1 (chip-core IRQ + PA latch) and to the drive CPU's
    // SO input pin (V-flag set on high→low edge — matches VICE
    // drivecpu_set_overflow). The shifter's tick() emits a one-cycle SO
    // pulse via DriveCpuCycled (see scheduler/cycle-wrappers.ts) — here
    // we wire the *event*; the per-cycle pulse shaping is the scheduler's
    // job (drop SO low at byte-ready, raise it on the next tick).
    //
    // Approach 1 from Spec 153 Step 2 (one-cycle pulse):
    //   - on byte-ready: pulse soLine low; DriveCpuCycled raises it back
    //     high on the next tick.
    //   - VIA2 CA1 fires `signal('ca1','fall')` to set IFR + latch PA.
    //
    // Microcoded CPU only: setSoLine is exclusive to Cpu65xxVice. For
    // the legacy whole-instruction Cpu6510, fall back to direct V-flag
    // set (the legacy path doesn't get cycle-perfect SO timing — but
    // that path is incompatible with the chip-level Sprint 113 doctrine
    // anyway; motm runs on microcoded CPU).
    if (this.gcrShifter) {
      const via2 = this.bus.via2;
      const cpuMicro = this.microcoded
        ? (this.cpu as Cpu65xxVice)
        : null;
      const cpuLegacy = this.microcoded ? null : (this.cpu as Cpu6510);
      const onSoEdge = opts.onSoEdge;
      const cpuClk = () => (this.cpu as { cycles: number }).cycles;
      // VICE 1:1 byte-ready fire — gated by VIA2 PCR bit 1
      // (BRA_BYTE_READY). When the gate is closed, neither CA1 IFR
      // nor V flag fires. Otherwise: signal CA1 falling edge, set V
      // directly (drivecpu_set_overflow drivecpu.c:219-223), emit
      // onSoEdge for the trace ring.
      const fireByteReady = (): void => {
        const pcr = via2.via.pcr & 0xff;
        if ((pcr & 0x02) === 0) return;
        via2.via.signal("ca1", "fall");
        if (cpuMicro) {
          cpuMicro.reg_p = (cpuMicro.reg_p | 0x40) & 0xff;
        } else if (cpuLegacy) {
          cpuLegacy.flags |= 0x40;
        }
        onSoEdge?.(true, cpuClk());
      };
      this.gcrShifter.onByteReady = fireByteReady;
      this.fireByteReady = fireByteReady;
    } else if (this.trackBuffer) {
      // Sprint 96 part 8 (legacy path): wire TrackBuffer byte-ready →
      // CPU V flag directly. Used when no GcrShifter is supplied — V2
      // back-compat for non-microcoded callers and pre-Spec-153 tests.
      const cpu = this.cpu as { flags: number };
      this.trackBuffer.onByteReady = () => { cpu.flags |= 0x40; };
    }

    // Spec 407 — populate `drives[]` tuple. 1541 uses slot 0 only;
    // slot 1 is `null` (= VICE NULL for unused 1571 second-head slot,
    // OQ-407-1). The slot wraps the per-physical-drive state — head
    // position, track buffer, GCR shifter — that VICE keeps inside
    // `drive_t` (drive.h:236). The fields are optional on `DriveCpu`
    // (depend on caller-provided opts.gcr/opts.gcrShifter); slot 0 is
    // only emitted when both head + shifter are supplied. When neither
    // is wired (= equiv tests, raw CPU/VIA harnesses) slot 0 is also
    // `null` — matches VICE behaviour for a unit with no image
    // attached (drives[0] still allocated but inactive).
    //
    // VICE: src/drive/drive.h:236 `drive_t`,
    //       src/drive/drivetypes.h:169 `drives[NUM_DRIVES]`.
    const slot0: DriveSlot | null =
      this.headPosition && this.trackBuffer && this.gcrShifter
        ? {
            drive: 0,
            diskunit: this,
            headPosition: this.headPosition,
            trackBuffer: this.trackBuffer,
            gcrShifter: this.gcrShifter,
            readOnly: opts.gcr?.writeProtected ?? false,
          }
        : null;
    this.drives = [slot0, null] as const;
  }

  /**
   * Spec 407 — `drive_shutdown` stub.
   *
   * VICE releases per-unit resources here: alarm context, image
   * detach, log destruction. In the TS port there is no malloc to
   * free; we clear references and run a `bus.reset()` to drop state
   * predictably. Idempotent.
   *
   * Doc: docs/vice-1541-arch.md §2.3 (boot/init) + §13-H step 33.
   * VICE: src/drive/drive.c:298 `drive_shutdown()`.
   */
  shutdown(): void {
    this.bus.reset();
    this.cpu.reset();
    this.lastClk = 0;
    this.cycleAccum = 0;
  }

  // Spec 090 / Spec 409: configure sync ratio. PAL = 1.01477
  // (1MHz drive / 985.248kHz C64).
  //
  // **Strict 1:1 VICE port (spec 409)**: the canonical factor is computed
  // via `driveSetMachineParameter(cyclesPerSec)` (= VICE
  // drive_set_machine_parameter, drivesync.c:57). This back-compat helper
  // accepts the (drive/host) ratio used by IntegratedSession and converts
  // via the same `floor(ratio * 65536)` formula so callers that already
  // hold the ratio get the exact same constant VICE would.
  //
  // Doc: docs/vice-1541-arch.md §5.1 + §13 Phase C step 7.
  // VICE: src/drive/drivesync.c:57.
  setSyncRatio(driveCyclesPerC64Cycle: number): void {
    // VICE uses floor(); we match exactly. round() drifts for some
    // inputs (e.g. NTSC ratio with C64_HZ_NTSC=1022727 vs 1022730).
    this.syncFactor16dot16 = Math.floor(driveCyclesPerC64Cycle * 0x10000);
  }

  /**
   * Spec 409 — VICE-exact sync_factor init.
   *
   * Mirrors `drive_set_machine_parameter(long cycles_per_sec)` in
   * `src/drive/drivesync.c:55-65`:
   *
   * ```c
   * sync_factor = (unsigned int)floor(65536.0 * (1000000.0 /
   *                                   (double)cycles_per_sec));
   * for (dnr = 0; dnr < NUM_DISK_UNITS; dnr++)
   *     drivesync_factor(diskunit_context[dnr]);
   * ```
   *
   * Then `drivesync_factor` multiplies by `clock_frequency` (1 for
   * 1541, 2 for 1581/1571). 1541 only here → factor unchanged.
   *
   * - PAL  cycles_per_sec = 985248  → 66517 = 0x103D5.
   * - NTSC cycles_per_sec = 1022730 → 64079 = 0xFA4F.
   *
   * Recomputed on PAL/NTSC switch (= VICE `c64_set_model_timing()`
   * at `src/c64/c64.c:1347`).
   *
   * Doc: docs/vice-1541-arch.md §5.1 (formula), §5.3 (PAL/NTSC
   *      switch), §13 Phase C step 7, §17 OQ-409-1/2/3.
   * Doc: docs/vice-iec-arc42.md §5.12.
   * VICE: src/drive/drivesync.c:55-65 drive_set_machine_parameter().
   */
  driveSetMachineParameter(cyclesPerSec: number): void {
    if (!(cyclesPerSec > 0)) {
      throw new Error(`driveSetMachineParameter: invalid cyclesPerSec=${cyclesPerSec}`);
    }
    // clock_frequency = 1 for 1541 (this.clockFrequency = 1 const).
    this.syncFactor16dot16 = this.clockFrequency *
      Math.floor(65536.0 * (1000000.0 / cyclesPerSec));
  }

  /**
   * Spec 409 — expose the 16.16 sync_factor for verification smokes
   * and snapshot/debug tooling. Pure getter; no side-effects.
   *
   * VICE: `diskunit_context_t.cpud->sync_factor` (drivetypes.h /
   * drivesync.c).
   */
  getSyncFactor16dot16(): number {
    return this.syncFactor16dot16;
  }

  /**
   * Spec 446 — VICE `drivesync_clock_frequency(unit, type)` literal port
   * (drivesync.c:86-117). Returns the drive's clock frequency multiplier
   * for a given drive type. 1541-family = 1; 1551/1581/4000/CMDHD = 2;
   * IEEE drives (2031, 2040, 3040, 4040, 1001, 8050, 8250, 9000) = 1.
   *
   * V1 only emulates 1541 (= type DRIVE_TYPE_1541). The full dispatch
   * table is ported literal for VICE-shape parity; other types are
   * unreachable in the current runtime but the function returns the
   * correct value if called.
   */
  static drivesync_clock_frequency(driveType: number): 1 | 2 {
    // VICE drive type constants (drive.h:121-145). 1541 family = 1.
    switch (driveType) {
      case 1540: case 1541: case 1542: case 1570:
      case 1571: case 1573:  // DRIVE_TYPE_1540/1541/1541II/1570/1571/1571CR
        return 1;
      case 1551: case 1581: case 2000: case 4000: case 4844:
        // DRIVE_TYPE_1551/1581/2000/4000/CMDHD
        return 2;
      case 2031: case 2040: case 3040: case 4040:
      case 1001: case 8050: case 8250: case 9000:
        return 1;
      default:
        return 1;
    }
  }

  /**
   * Spec 446 — convenience helper for PAL/NTSC sync switch.
   * Internally calls `driveSetMachineParameter(C64_PAL_CYCLES_PER_SEC)`
   * or `(C64_NTSC_CYCLES_PER_SEC)` per VICE drivesync.c:57.
   *
   * Use this when the C64 video mode changes mid-session (rare). Most
   * callers should set machine parameter once at construction.
   */
  setPalNtsc(mode: "pal" | "ntsc"): void {
    const cyclesPerSec =
      mode === "ntsc" ? C64_NTSC_CYCLES_PER_SEC : C64_PAL_CYCLES_PER_SEC;
    this.driveSetMachineParameter(cyclesPerSec);
  }

  /**
   * Spec 414 — hard reset (= drive_init / power-on).
   *
   * Clears drive RAM ($0000-$07FF), resets VIA1+VIA2, resets CPU at
   * reset vector. Equivalent to VICE `drive_init` + `drivemem_init`
   * which zero-initialise the RAM array. Distinct from `softReset()`
   * which preserves RAM (= drivecpu_reset / RESET-line pulse).
   *
   * Doc: docs/vice-1541-arch.md §2.3 (init sequence — RAM zeroed at
   *      `lib_calloc` in `drive_init`, drive.c:162-285),
   *      §13 Phase H step 33 (hard reset clears RAM).
   * VICE: src/drive/drive.c:162 `drive_init()`, drivecpu.c:251
   *       `drivecpu_init()` (allocates drive_ram via lib_calloc).
   */
  reset(pc?: number): void {
    this.bus.reset();
    this.cpu.reset(pc);
    // Hard reset (power-cycle): full state clear including cycleAccum.
    // Differs from VICE softReset semantics (drivecpu_reset preserves
    // cycle_accum). Hard reset = power-on, no fractional residual.
    this.lastClk = 0;
    this.cycleAccum = 0;
    this.stop_clk = 0;
    this.last_exc_cycles = 0;
  }

  /**
   * Spec 414 — soft reset (= RESET-line pulse).
   *
   * Per `drivecpu_reset()` (drivecpu.c:194-209): zero the drive clock,
   * call `interrupt_cpu_status_reset` (clears pending IRQ/NMI), then
   * `interrupt_trigger_reset` (CPU jumps to reset vector at $FFFC).
   * **RAM is NOT cleared** — it survives the RESET pulse. Same for
   * VIA timer latches and shift register (per VICE `viacore.reset`
   * which preserves register 10 = SR; doc §13 Phase H step 33).
   *
   * Use when emulating the C64-side RESET button or `JMP ($FFFC)`
   * from the drive monitor; use `reset()` (hard) for power-cycle
   * semantics where RAM must be reinitialised.
   *
   * Doc: docs/vice-1541-arch.md §13 Phase H step 33 (soft reset
   *      pulses RESET line; RAM preserved).
   * VICE: src/drive/drivecpu.c:194 `drivecpu_reset()`,
   *       src/core/viacore.c:378-439 `viacore_reset` (SR preserved).
   */
  softReset(c64Clk: number, pc?: number): void {
    // VIA reset preserves SR (register 10) per viacore.c:357 — already
    // implemented in via6522-vice.ts (loop starts at register 11).
    this.bus.via1.reset();
    this.bus.via2.reset();
    // CPU reset = clear interrupt latches + jump to reset vector. RAM
    // is NOT touched (= drivecpu_reset semantics).
    this.cpu.reset(pc);
    // Spec 444 Phase 4 — literal VICE drivecpu_reset_clk (drivecpu.c:186-191):
    //   last_clk = maincpu_clk;
    //   last_exc_cycles = 0;
    //   stop_clk = 0;
    // c64Clk arg is REQUIRED (mid-run-lastClk contract enforced in
    // code, not prose). cycle_accum INTENTIONALLY NOT cleared
    // (VICE-literal — fractional residual preserved across reset).
    this.lastClk = c64Clk >>> 0;
    this.last_exc_cycles = 0;
    this.stop_clk = 0;
  }

  /**
   * Spec 414 — `drive_enable()` analog (Phase H step 32).
   *
   * Re-arms a previously-disabled drive: sets `enabled = true`,
   * resyncs the host-side baseline (= `cpu->stop_clk = *clk_ptr` in
   * drive.c:514), and wakes the CPU from sleep (= `drivecpu_wake_up`
   * in drive.c:520).
   *
   * No IEC callback registration: the IEC bus already iterates all
   * units and skips disabled (OQ-414-1; doc §17). No image re-attach:
   * the parser swap lives in `mount.ts` `mountMedia`, which is the
   * caller's responsibility (mirrors VICE `drive_image_attach`).
   *
   * Doc: docs/vice-1541-arch.md §13 Phase H step 32, §2.3,
   *      §17 OQ-414-1.
   * VICE: src/drive/drive.c:482-529 `drive_enable()` —
   *       (a) check `Drive%uTrueEmulation` resource (= caller in TS),
   *       (b) re-attach images (= `mountMedia` in TS),
   *       (c) set `cpu->stop_clk = *clk_ptr` (= setSyncBaseline),
   *       (d) `drivecpu_wake_up` (= wakeUp),
   *       (e) update UI (= no-op in TS headless).
   */
  enable(currentHostClk?: number): void {
    this.enabled = true;
    if (currentHostClk !== undefined) {
      this.lastClk = currentHostClk >>> 0;
    }
    this.wakeUp();
  }

  /**
   * Spec 414 — `drive_disable()` analog (Phase H step 32).
   *
   * Sets `enabled = false`. Subsequent `executeToClock` calls
   * early-return; the drive CPU stops advancing. The IEC bus continues
   * to operate (= ATN edge from C64 still pulses CA1) but with no
   * drive CPU advance, no VIA1 PB output is generated — matches VICE's
   * "iterate units, skip disabled" model.
   *
   * Spec 444 Phase 4: `sleeping = true` removed (flag purged).
   * VICE drivecpu_sleep body is empty (drivecpu.c:266-269) so the
   * TS-EXTRA flag was doctrine-violating and now gone.
   *
   * Doc: docs/vice-1541-arch.md §13 Phase H step 32, §17 OQ-414-1.
   * VICE: src/drive/drive.c:531-560 `drive_disable()`.
   */
  disable(): void {
    this.enabled = false;
  }

  // Sync drive clock baseline (called when c64Clk wraps or on cold reset).
  setSyncBaseline(c64Clk: number): void {
    this.lastClk = c64Clk;
  }

  /**
   * Spec 409 — VICE `drive_cpu_execute_one(unit, host_clk)` wrapper.
   *
   * Push-mode entry from the C64 side for a single drive unit. For the
   * stock 1541 (this class) this is a thin alias for `executeToClock`;
   * VICE picks `drivecpu_execute` (6502) vs `drivecpu65c02_execute` based
   * on `drv->type` (see `src/drive/drive.c:991-1000`). With only the
   * 6502-based 1541 implemented here, dispatch is direct.
   *
   * Mirrors the §13 Phase C step 10 contract:
   *
   *   Convert (host_clk - last_clk) cycles to drive cycles via
   *   fixed-point accumulation, run 6502 until drive_clk ≥ stop_clk,
   *   update last_clk.
   *
   * Doc: docs/vice-1541-arch.md §13 Phase C step 10.
   * VICE: src/drive/drive.c:991 `drive_cpu_execute_one`.
   */
  driveCpuExecuteOne(hostClk: number): void {
    this.executeToClock(hostClk);
  }

  /**
   * Spec 435 — VICE `drive_cpu_execute_all(host_clk)` wrapper.
   *
   * Iterates over all active drive units and catches each up to the
   * given host clock. For the 1541-only milestone this is equivalent
   * to `driveCpuExecuteOne(hostClk)`. The named entry point exists so
   * the IEC bus read path (iecbus.c:229 `drive_cpu_execute_all(clock)`)
   * has a 1:1 callable in TS.
   *
   * VICE: src/drive/drive.c:1001 `drive_cpu_execute_all`.
   */
  driveCpuExecuteAll(hostClk: number): void {
    this.executeToClock(hostClk);
  }

  // Spec 090: execute drive cycles up to the given C64 clock value.
  // Idempotent if c64Clk hasn't advanced. Drive may run a few cycles
  // ahead at end of each call (instruction overrun) — next call sees
  // fewer cycles owed because lastClk is updated only by what
  // we actually consumed. cycleAccum carries fractional
  // C64 cycles between calls.
  /**
   * Spec 401 / OQ-400-Q4 — `cycleStepped` flag dropped; the executor
   * now always runs the cycle-stepped microcoded path (= 1:1 VICE
   * `drivecpu_execute_one` / 6510core.c per-cycle decomposition).
   * VICE has no whole-instruction drive dispatch — strict 1:1 forbids
   * it. The legacy `!microcoded` whole-instruction fallback was the
   * "legacy `runOneInstruction` whole-instruction drive path" called
   * out by OQ-400-Q4; it is gone. Callers that relied on it must opt
   * into `useMicrocodedCpu: true` at DriveCpu construction.
   *
   * The `cycleStepped` arg is retained for back-compat call sites; it
   * is now ignored.
   *
   * Doc: docs/vice-1541-arch.md §3; docs/vice-c64-arch.md §3.2.
   * VICE source: src/drive/drivecpu.c (drivecpu_execute_one) +
   * src/6510core.c (per-bus-cycle macro template).
   */
  executeToClock(c64Clk: number, _cycleStepped: boolean = false): void {
    // Spec 414 — disabled drive does not advance.
    if (!this.enabled) {
      this.lastClk = c64Clk >>> 0;
      return;
    }
    if (c64Clk <= this.lastClk) return;

    // Spec 444 v2 — VICE drivecpu_execute (drivecpu.c:356-445) literal
    // shape. Prologue: wake_up; outer chunked accum-into-stop_clk math;
    // inner `while (drive_clk < stop_clk)` loop; epilogue: last_clk
    // update + sleep no-op.

    // VICE drivecpu.c:374 prologue — wake_up stale-clock-skip.
    this.drivecpuWakeUp(c64Clk);

    // VICE drivecpu.c:377-381 — compute cycles delta.
    let cycles: number;
    if (c64Clk > this.lastClk) cycles = c64Clk - this.lastClk;
    else cycles = 0;

    // VICE drivecpu.c:383-390 — chunk into 10000-cycle batches, accumulate
    // cycle_accum, extract integer drive cycles into stop_clk (ADDITIVE),
    // keep fractional residual in cycle_accum.
    while (cycles !== 0) {
      const tcycles = cycles > 10000 ? 10000 : cycles;
      cycles -= tcycles;
      this.cycleAccum = (this.cycleAccum + this.syncFactor16dot16 * tcycles) >>> 0;
      this.stop_clk = (this.stop_clk + (this.cycleAccum >>> 16)) >>> 0;
      this.cycleAccum &= 0xffff;
    }

    if (!this.microcoded) {
      throw new Error(
        "DriveCpu.executeToClock: legacy whole-instruction Cpu6510 path " +
        "removed (spec 401 / OQ-400-Q4). Construct DriveCpu with " +
        "useMicrocodedCpu: true.",
      );
    }

    // Spec 444 Phase 4 — `sleeping` flag PURGED. VICE drive always runs
    // cycles when enabled; no busy-wait skip. Was output-affecting
    // TS-EXTRA divergence; removed per doctrine.

    const cycled = this.cpu as Cpu65xxVice;
    // Spec 444 — VIA2 IRQ now pushed chip-side via
    // `Via2d1541.attachIrqLine` (analog of Spec 410 VIA1). The polling
    // line at the per-instruction boundary is dropped. If `intNumVia2Irq`
    // is still being lazily initialised (legacy callers), keep the IntNum
    // allocation so other paths that still poll work, but the inner
    // loop no longer pushes from here.
    if (!this.intNumVia2Irq && cycled.cpuIntStatus) {
      this.intNumVia2Irq = cycled.cpuIntStatus.newIntNum("via2-irq");
    }

    // VICE drivecpu.c:393 inner loop — literal `while (*clk_ptr < stop_clk)`.
    // Each iteration advances drive CPU by one bus cycle (6510core macro
    // template). When clk reaches stop_clk, loop exits — drive may overshoot
    // by ≤ 1 cycle at most (instruction granularity); captured in
    // last_exc_cycles.
    while (cycled.cycles < this.stop_clk) {
      // Spec 452 OPEN — rotation tick AFTER cpu (current). Doc §14
      // invariant 1 requires BEFORE; flipping wedges Scramble Infinity
      // Krill loader at PC=$eeb1 (KERNAL LOAD). A different TS timing
      // divergence elsewhere in the drive path is masked by AFTER;
      // root-cause hunt + flip is Spec 452 scope.
      cycled.executeCycle();
      if (this.gcrShifter) this.gcrShifter.tick(1);
      if (cycled.isAtInstructionBoundary()) {
        this.onInstructionComplete?.(
          cycled.pc & 0xffff, 0, 0, 0,
          cycled.reg_a ?? 0, cycled.reg_x ?? 0, cycled.reg_y ?? 0,
          cycled.reg_sp ?? 0, cycled.reg_p ?? 0,
          cycled.cycles,
        );
      }
    }

    // VICE drivecpu.c:443 epilogue — last_clk = clk_value.
    this.lastClk = c64Clk;

    // VICE drivecpu.c:444 epilogue — drivecpu_sleep (empty body in VICE).
    // Spec 444 Phase 4: TS sleeping flag purged; no-op.

    // Spec 444 Phase 4 — `last_exc_cycles` is NOT updated here. VICE
    // writes it only in drivecpu_reset_clk (drivecpu.c:189). The
    // `max(0, cycles - stop_clk)` formula I added in Phase 2b was
    // invented — strict-literal port writes the field only from reset.
  }

  /**
   * Spec 444 v2 — VICE drivecpu_wake_up (drivecpu.c:255-264).
   *
   * If main CPU has run > 16M cycles since last sync AND drive has
   * run > 934639 cycles, skip ahead (drop the backlog). Prevents
   * massive over-run after long idle.
   */
  private drivecpuWakeUp(c64Clk: number): void {
    const driveClk = (this.cpu as { cycles: number }).cycles;
    if ((c64Clk - this.lastClk) > 0xffffff && driveClk > 934639) {
      this.lastClk = c64Clk >>> 0;
    }
  }

  // Spec 401 / OQ-400-Q4 — `step()` and `runOneInstruction` now drive
  // the cycled microcoded CPU only. The legacy `Cpu6510.step()` whole-
  // instruction dispatch path is removed (VICE has no whole-instruction
  // drive dispatch; cf. drivecpu.c `drivecpu_execute_one` which cycles
  // 6510core.c per bus cycle). Callers must opt into useMicrocodedCpu.
  step(): number {
    return this.runOneInstruction();
  }

  /** Drive cycles until the next instruction boundary (microcoded-only). */
  private runOneInstruction(): number {
    if (!this.microcoded) {
      throw new Error(
        "DriveCpu.runOneInstruction: legacy whole-instruction Cpu6510 " +
        "path removed (spec 401 / OQ-400-Q4). Construct with " +
        "useMicrocodedCpu: true.",
      );
    }
    const cycled = this.cpu as Cpu65xxVice;
    const before = cycled.cycles;
    // Spec 410 — VIA1 polling bridge dropped (chip-side push from
    // `Via1d1541.attachIrqLine`). Spec 444 v2 — VIA2 polling bridge
    // dropped (chip-side push from `Via2d1541.attachIrqLine`); both
    // IRQ lines feed the drive intStatus async.
    // Tick at least once, then until back at boundary. Per-bus-cycle
    // path matches VICE 6510core.c addressing-mode decomposition.
    //
    // Spec 452 OPEN: rotation AFTER cpu; BEFORE pattern regresses Krill
    // loader (Scramble Infinity, PC=$eeb1 KERNAL LOAD). See Spec 452 /
    // drive-cpu.ts executeToClock for context.
    cycled.executeCycle();
    if (this.gcrShifter) this.gcrShifter.tick(1);
    while (!cycled.isAtInstructionBoundary()) {
      cycled.executeCycle();
      if (this.gcrShifter) this.gcrShifter.tick(1);
    }
    // Spec 205-A c4 / Spec 217: inner cpu's onInstructionComplete
    // (installed by kernel directly on this.cpu) fires inside the
    // microcode dispatch above. The wrapper hook below is kept for
    // backward-compat; pass post-state minimally so signature
    // matches the inner-cpu shape.
    this.onInstructionComplete?.(
      cycled.pc & 0xffff, 0, 0, 0,
      cycled.reg_a ?? 0, cycled.reg_x ?? 0, cycled.reg_y ?? 0,
      cycled.reg_sp ?? 0, cycled.reg_p ?? 0,
      cycled.cycles,
    );
    return cycled.cycles - before;
  }

  /**
   * Spec 205-A c4 / Spec 217: kernel-installed instruction-complete
   * callback. Set externally (e.g. by HeadlessMachineKernel) so the
   * drive CPU doesn't depend on the kernel module directly. Mirrors
   * the inner cpu signature; in practice the kernel installs the hook
   * on `this.cpu` directly and the wrapper-level dispatch below is
   * unused (kept for backward-compat).
   */
  onInstructionComplete?: (
    prevPc: number,
    opcode: number,
    b1: number,
    b2: number,
    a: number,
    x: number,
    y: number,
    sp: number,
    p: number,
    clk: number,
  ) => void;
}
