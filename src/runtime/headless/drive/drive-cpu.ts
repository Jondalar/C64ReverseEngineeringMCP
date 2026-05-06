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
import { alarmContextNew, alarmContextDispatch, type AlarmContext } from "../alarm/alarm-context.js";
import { Via1d1541 } from "../via/via1d1541.js";
import { Via2d1541, type Via2GcrPortCoupling } from "../via/via2d1541.js";
import { makeGcrVia2Pa, makeGcrVia2Pb, type Via2GcrCoupling } from "./via2-gcr.js";
import { makeGcrShifterCoupling } from "./via2-gcr-shifter-coupling.js";
import type { GcrShifter } from "./gcr-shifter.js";
import { loadDriveRom, DRIVE_ROM_BASE, DRIVE_ROM_SIZE, type LoadedDriveRom } from "./drive-rom.js";
import { IecBusCore } from "../iec/iec-bus-core.js";
import type { IecBus } from "../iec/iec-bus.js";
import type { TrackBuffer, HeadPosition } from "./head-position.js";

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

    if (opts.iecBus) {
      this.via1 = new Via1d1541({
        alarmContext: this.alarmContext,
        iec: opts.iecBus.core,
        deviceId,
        clkRef: resolvedClkRef,
        setIrq: () => { /* IRQ sampled via irqAsserted() in runOneInstruction */ },
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
        setIrq: () => { /* sampled */ },
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
      setIrq: () => { /* sampled */ },
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
// Sync points: every $DD00 access (via IecBus.beforeC64Read hook) +
// after each C64 instruction. Drive's clock advances independently
// using fixed-point sync_factor (drive 1MHz / C64 985.248kHz ratio).
export class DriveCpu {
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
  // Idle-wakeup callback installed by IntegratedSession via IecBus.
  // When iec bus state changes, we wake the drive.
  public wakeUp(): void { this.sleeping = false; }

  constructor(opts: DriveCpuOptions = {}) {
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
      };
    } else if (this.trackBuffer) {
      // Sprint 96 part 8 (legacy path): wire TrackBuffer byte-ready →
      // CPU V flag directly. Used when no GcrShifter is supplied — V2
      // back-compat for non-microcoded callers and pre-Spec-153 tests.
      const cpu = this.cpu as { flags: number };
      this.trackBuffer.onByteReady = () => { cpu.flags |= 0x40; };
    }
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
  executeToClock(c64Clk: number): void {
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
    while (this.cycleAccumulator16dot16 >= 0x10000) {
      const consumed = this.runOneInstruction();
      // Spec 153 / Sprint 114: tick GcrShifter for the cycles consumed.
      // Non-lockstep callers drive the shifter through this path; the
      // SO-pin pulse-shape behaviour of DriveCpuCycled is approximated
      // here by raising soLine back high after the tick (microcoded
      // path only — legacy CPU uses direct V-flag set).
      if (this.gcrShifter) {
        // Byte-ready callback in DriveCpu sets V directly on reg_p
        // (mirrors VICE drivecpu_set_overflow). No SO-pin pulse needed.
        this.gcrShifter.tick(consumed);
      }
      // Sprint 113 Phase 2: VIA1 + VIA2 are alarm-driven (Via1d1541 /
      // Via2d1541). No tick() needed — alarm context is drained by the
      // microcoded CPU inline (Cpu65xxVice) or via the legacy CPU path
      // here. For the legacy-CPU executeToClock path we drain pending
      // drive alarms after each instruction to keep T1/T2 timers current.
      // (In lockstep, AlarmContextCycled handles drain per cycle.)
      if (!this.microcoded) {
        const ctx = this.bus.alarmContext;
        const cpuClk = (this.cpu as Cpu6510).cycles;
        let guard = 0;
        while (cpuClk >= ctx.next_pending_alarm_clk) {
          alarmContextDispatch(ctx, cpuClk);
          if (++guard > 0x1000) break;
        }
      }
      this.cycleAccumulator16dot16 -= consumed * 0x10000;
    }
  }

  // Legacy step API kept for back-compat (will be removed once
  // IntegratedSession fully on executeToClock).
  step(): number {
    return this.runOneInstruction();
  }

  // Run exactly one instruction on whichever CPU is wired. For the
  // microcoded path, drive-cycle until next instruction boundary.
  private runOneInstruction(): number {
    if (this.microcoded) {
      const cycled = this.cpu as Cpu65xxVice;
      const before = cycled.cycles;
      // Spec 141 v2: pass current drive clock so VIA's clocked
      // irqAsserted enforces INTERRUPT_DELAY=2 between IFR-set and
      // CPU IRQ entry. Matches VICE drivecpu interrupt_check_irq_delay.
      cycled.irqLine =
        this.bus.via1.irqAsserted(cycled.cycles) ||
        this.bus.via2.irqAsserted(cycled.cycles);
      // Tick at least once, then until back at boundary.
      cycled.executeCycle();
      while (!cycled.isAtInstructionBoundary()) cycled.executeCycle();
      return cycled.cycles - before;
    }
    const legacy = this.cpu as Cpu6510;
    if (!legacy.interruptsDisabled()) {
      const irq =
        this.bus.via1.irqAsserted(legacy.cycles) ||
        this.bus.via2.irqAsserted(legacy.cycles);
      if (irq) legacy.serviceInterrupt(0xfffe, false);
    }
    const before = legacy.cycles;
    legacy.step();
    return legacy.cycles - before;
  }
}
