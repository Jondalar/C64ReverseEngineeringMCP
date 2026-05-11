// Drive 6502 instance + memory bus.
//
// Address map (1541):
//   $0000-$07FF   2KB drive RAM
//   $0800-$17FF   open bus (returns last fetch byte on real HW; we
//                 return 0 — Sprint 60 stub. Drive ROM should never
//                 read this region.)
//   $1800-$1BFF   VIA1 (16 registers mirrored across 1KB)
//   $1C00-$1FFF   VIA2 (16 registers mirrored across 1KB)
//   $2000-$BFFF   open bus (return 0)
//   $C000-$FFFF   16KB DOS ROM
//
// Reset vector at $FFFC/$FFFD points into the ROM startup routine.
// Without ROM (Sprint 60 zero-fill case) the reset vector reads $0000
// which is RAM — caller must place test code at the documented entry
// point and seed PC explicitly.

import { Cpu6510, type CpuMemory } from "../cpu6510.js";
import { Cpu65xxVice } from "../cpu/cpu65xx-vice.js";
import { alarmContextNew, type AlarmContext } from "../alarm/alarm-context.js";
import { Via1d1541 } from "../via/via1d1541.js";
import { Via2d1541, type Via2GcrPortCoupling } from "../via/via2d1541.js";
import { makeGcrVia2Pa, makeGcrVia2Pb, type Via2GcrCoupling } from "./via2-gcr.js";
import { makeGcrShifterCoupling } from "./via2-gcr-shifter-coupling.js";
import type { GcrShifter } from "./gcr-shifter.js";
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

export class DriveBus implements CpuMemory {
  public readonly ram = new Uint8Array(DRIVE_RAM_SIZE);
  public readonly rom: Uint8Array;
  public readonly via1: Via1d1541;
  public readonly via2: Via2d1541;
  public readonly romSource: LoadedDriveRom["source"];
  public readonly romPath?: string;
  /** Alarm context used by VIA1 + VIA2. May be caller-supplied or local. */
  public readonly alarmContext: AlarmContext;

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
    });
  }

  read(address: number): number {
    const a = address & 0xffff;
    if (a < DRIVE_RAM_SIZE) return this.ram[a]!;
    if (a >= VIA1_BASE && a <= VIA1_END) return this.via1.read(a & 0xf);
    if (a >= VIA2_BASE && a <= VIA2_END) return this.via2.read(a & 0xf);
    if (a >= DRIVE_ROM_BASE) return this.rom[a - DRIVE_ROM_BASE]!;
    return 0; // open bus (returns last fetch on real HW)
  }

  write(address: number, value: number): void {
    const a = address & 0xffff;
    const v = value & 0xff;
    if (a < DRIVE_RAM_SIZE) { this.ram[a] = v; return; }
    if (a >= VIA1_BASE && a <= VIA1_END) { this.via1.write(a & 0xf, v); return; }
    if (a >= VIA2_BASE && a <= VIA2_END) { this.via2.write(a & 0xf, v); return; }
    // ROM writes ignored (read-only). Open-bus regions ignored.
  }

  reset(): void {
    this.ram.fill(0);
    this.via1.reset();
    this.via2.reset();
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

  // Spec 090: 16.16 fixed-point sync_factor. drive_cycles_per_c64_cycle.
  // PAL: 1.01477 → 0x103C5 (= 1.0149 in 16.16). NTSC: 0x10000 (1.0).
  private syncFactor16dot16 = 0;
  // Drive's last sync clock (in C64 cycles) — i.e. up to which C64
  // cycle we have already caught up.
  private lastSyncC64Clk = 0;
  // Fixed-point accumulator — fractional drive cycles owed.
  private cycleAccumulator16dot16 = 0;
  // Sleep mode: drive is in known busy-wait loop, skip ahead to next
  // bus state change. Cleared on bus state change.
  private sleeping = false;
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
  // Idle-wakeup callback installed by IntegratedSession via IecBus.
  // When iec bus state changes, we wake the drive.
  public wakeUp(): void { this.sleeping = false; }

  constructor(opts: DriveCpuOptions = {}) {
    // Spec 407 — record device number for Drive1541Unit shape.
    // VICE: `diskunit_context_t.mynumber` (drivetypes.h:166).
    this.mynumber = opts.deviceId ?? 8;
    // Sprint 113 Phase 2: DriveBus needs the CPU clock pointer for VIA1/VIA2
    // construction. CPU hasn't been built yet, so we pass a live closure that
    // reads cpu.cycles once the cpu field is assigned below.
    let cpuRef: { cycles: number } = { cycles: 0 };
    const clkRef = () => cpuRef.cycles;
    this.bus = new DriveBus(opts, clkRef);
    this.microcoded = opts.useMicrocodedCpu ?? false;
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
    }
    this.trackBuffer = opts.gcr?.trackBuffer;
    this.headPosition = opts.gcr?.headPosition;
    this.gcrShifter = opts.gcrShifter;

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
      this.gcrShifter.onByteReady = (_byte: number) => {
        // VICE 1:1 — byte-ready is GATED by VIA2 PCR bit 1 (BRA_BYTE_READY).
        // Drive ROM enables/disables this via PCR write; when disabled
        // (e.g. during IEC bit-bang serial transfer, or before drive ROM
        // initializes PCR) the GCR shifter keeps spinning but byte-ready
        // edges are suppressed — neither CA1 nor V flag fire. See:
        //   vice/src/drive/iecieee/via2d.c L170-178 (via2d_update_pcr)
        //   vice/src/drive/drive.h          L283   BRA_BYTE_READY 0x02
        //   vice/src/drive/rotation.c       L1060  gate before edge=1
        const pcr = via2.via.pcr & 0xff;
        if ((pcr & 0x02) === 0) return;

        // VIA2 CA1 falling edge — chip core handles PA latch + IFR set
        // per VICE viacore_signal (PCR polarity-gated).
        via2.via.signal("ca1", "fall");

        // V-flag direct set — VICE drivecpu_set_overflow (drivecpu.c:219-223)
        // directly does `cpu_regs.p |= P_OVERFLOW`. There's no SO-pin pulse
        // shaping in VICE for the drive 6502; byte-ready latches V immediately
        // and CLV (or BVC consume) clears it. We previously routed through
        // setSoLine(0)+pulse-back-to-1 but the same-cycle re-raise meant the
        // CPU's edge detector never saw a 1→0 transition and V was never set
        // (root cause of $F3BE BVC deadlock). Match VICE: set V directly.
        if (cpuMicro) {
          cpuMicro.reg_p = (cpuMicro.reg_p | 0x40) & 0xff;
        } else if (cpuLegacy) {
          cpuLegacy.flags |= 0x40;
        }
        // Spec 203-c3: SO line edge — fire after V flag set so consumers
        // see the post-edge state. Pulse-shaped as asserted=true here;
        // VICE-style same-cycle release means the level visible to the
        // CPU is one-cycle. For event-ring purposes the asserted edge
        // is what matters.
        onSoEdge?.(true, cpuClk());
      };
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
    this.lastSyncC64Clk = 0;
    this.cycleAccumulator16dot16 = 0;
    this.sleeping = false;
  }

  // Spec 090: configure sync ratio. PAL = 1.01477 (1MHz drive / 985.248kHz C64).
  setSyncRatio(driveCyclesPerC64Cycle: number): void {
    this.syncFactor16dot16 = Math.round(driveCyclesPerC64Cycle * 0x10000);
  }

  reset(pc?: number): void {
    this.bus.reset();
    this.cpu.reset(pc);
    this.lastSyncC64Clk = 0;
    this.cycleAccumulator16dot16 = 0;
    this.sleeping = false;
  }

  // Sync drive clock baseline (called when c64Clk wraps or on cold reset).
  setSyncBaseline(c64Clk: number): void {
    this.lastSyncC64Clk = c64Clk;
  }

  // Spec 090: execute drive cycles up to the given C64 clock value.
  // Idempotent if c64Clk hasn't advanced. Drive may run a few cycles
  // ahead at end of each call (instruction overrun) — next call sees
  // fewer cycles owed because lastSyncC64Clk is updated only by what
  // we actually consumed. cycleAccumulator16dot16 carries fractional
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
    if (c64Clk <= this.lastSyncC64Clk) return;
    const c64Delta = c64Clk - this.lastSyncC64Clk;
    this.lastSyncC64Clk = c64Clk;
    if (this.sleeping) {
      // Drive in known busy-wait; defer cycles until wakeUp().
      // Accumulate the C64 delta for later replay.
      this.cycleAccumulator16dot16 += this.syncFactor16dot16 * c64Delta;
      return;
    }
    // Accumulate fractional drive cycles owed.
    this.cycleAccumulator16dot16 += this.syncFactor16dot16 * c64Delta;
    if (!this.microcoded) {
      throw new Error(
        "DriveCpu.executeToClock: legacy whole-instruction Cpu6510 path " +
        "removed (spec 401 / OQ-400-Q4). Construct DriveCpu with " +
        "useMicrocodedCpu: true.",
      );
    }
    const cycled = this.cpu as Cpu65xxVice;
    // Spec 410 — VIA1 polling bridge dropped (chip-side push via
    // `Via1d1541.attachIrqLine`). VIA2 still polled at instruction
    // boundary until spec 411 migrates it.
    if (!this.intNumVia2Irq && cycled.cpuIntStatus) {
      this.intNumVia2Irq = cycled.cpuIntStatus.newIntNum("via2-irq");
    }
    while (this.cycleAccumulator16dot16 >= 0x10000) {
      if (cycled.isAtInstructionBoundary() && this.intNumVia2Irq) {
        // VIA2 IRQ polling — replaced by spec 411 chip-side push.
        cycled.cpuIntStatus.setIrq(this.intNumVia2Irq, this.bus.via2.irqAsserted(cycled.cycles), cycled.cycles);
      }
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
      this.cycleAccumulator16dot16 -= 0x10000;
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
    // `Via1d1541.attachIrqLine`). VIA2 stays polled (spec 411 follows).
    if (!this.intNumVia2Irq && cycled.cpuIntStatus) {
      this.intNumVia2Irq = cycled.cpuIntStatus.newIntNum("via2-irq");
    }
    if (this.intNumVia2Irq) {
      cycled.cpuIntStatus.setIrq(this.intNumVia2Irq, this.bus.via2.irqAsserted(cycled.cycles), cycled.cycles);
    }
    // Tick at least once, then until back at boundary. Per-bus-cycle
    // path matches VICE 6510core.c addressing-mode decomposition.
    cycled.executeCycle();
    while (!cycled.isAtInstructionBoundary()) cycled.executeCycle();
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
