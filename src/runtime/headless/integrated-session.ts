// IntegratedSession — C64 + 1541 drive coupled via shared IEC bus,
// dual-clock cycle accumulator. Real KERNAL/BASIC/CHARROM loaded.
//
// Composition:
// - C64 cpu + memory bus with real ROMs
// - Drive cpu + drive bus + iec bus + cycle accumulator
// - Peripherals (vic-stub, cia1-stub) — replaced by full models in
//   Spec 064 (CIA1/CIA2 timers) + Spec 065 (full VIC)
// - KERNAL traps (kernal-fileio) — removed in Sprint 69 once Spec 064
//   real CIA1 timer lets KERNAL serial run authentically
// - CIA2 wired to iec-bus for IEC PA bits

import { Cpu6510 } from "./cpu6510.js";
import { HeadlessMemoryBus } from "./memory-bus.js";
import { loadAllC64Roms, type LoadedC64RomSet } from "./c64-rom.js";
import { IecBus } from "./iec/iec-bus.js";
import { DriveCpu } from "./drive/drive-cpu.js";
import { TrackBuffer, HeadPosition } from "./drive/head-position.js";
import { G64Parser } from "../../disk/g64-parser.js";
import { DiskProvider } from "./providers.js";
import { existsSync, readFileSync } from "node:fs";
import { installVicII, type VicII } from "./peripherals/vic-ii.js";
import { installSid, type Sid6581 } from "./peripherals/sid.js";
import { VicFramebuffer, renderTextModeFrame, computeVicBankBase } from "./peripherals/vic-renderer.js";
import { rgbaToPng } from "./peripherals/png-writer.js";
import { writeFileSync } from "node:fs";
import { installCia1 } from "./peripherals/cia1.js";
import type { KeyboardMatrix, JoystickState } from "./peripherals/keyboard.js";
import { installCia2 } from "./peripherals/cia2.js";
import type { Cia6526 } from "./cia/cia6526.js";
import {
  handleKernalFileIoTrap,
  makeKernalFileIoState,
  type KernalFileIoState,
} from "./traps/kernal-fileio.js";
import {
  handleKernalSerialTrap,
  makeKernalSerialState,
  type KernalSerialState,
} from "./traps/kernal-serial.js";
import {
  handleKernalIoTrap,
  makeKernalIoState,
  type KernalIoState,
} from "./traps/kernal-io.js";
import { CycleLockstepSchedulerImpl } from "./scheduler/cycle-lockstep-scheduler.js";
import {
  Cpu6510Cycled, CiaCycled, VicCycled, SidCycled,
  DriveCpuCycled, ViaCycled, KeyboardCycled,
} from "./scheduler/cycle-wrappers.js";
import { Cpu6510Cycled as Cpu6510Microcoded } from "./cpu/cpu6510-cycled.js";

const C64_HZ_PAL = 985248;
const C64_HZ_NTSC = 1022727;
const DRIVE_HZ = 1000000;

export interface IntegratedSessionOptions {
  diskPath: string;
  isPal?: boolean;
  deviceId?: number;
  startTrack?: number;
  writeProtected?: boolean;
  // Spec 064 Sprint 69b: file-IO traps default OFF (KERNAL runs
  // real serial bit-bang to drive). Set true to fall back to the
  // Sprint 67 trap path if the real protocol stalls.
  enableKernalFileIoTraps?: boolean;
  // Sprint 81: serial + IO traps default ON for back-compat, but
  // game stage-2 custom bit-bang needs them OFF so KERNAL drives
  // real CIA2 → drive ATN handler runs and releases ATN_ACK.
  enableKernalSerialTraps?: boolean;
  enableKernalIoTraps?: boolean;
  // Sprint 92: enable cycle-lockstep scheduler. Default false.
  useCycleLockstep?: boolean;
  // Sprint 92.7 v2: use new microcoded cpu6510 (sub-instruction bus
  // access). Implies useCycleLockstep=true. Default false.
  useMicrocodedCpu?: boolean;
  // Spec 093: cycle-stamped IEC edge trace (ring buffer in IecBus).
  traceIec?: boolean;
  traceIecCapacity?: number;
  // Spec 093: drive PC trace ring (per drive instruction).
  traceDrive?: boolean;
  traceDriveCapacity?: number;
}

export interface PrgLoadResult {
  loadAddress: number;
  endAddress: number;
  bytesLoaded: number;
}

export class IntegratedSession {
  public readonly c64Bus: HeadlessMemoryBus;
  public readonly c64Cpu: Cpu6510;
  public readonly drive: DriveCpu;
  public readonly iecBus: IecBus;
  public readonly trackBuffer: TrackBuffer;
  public readonly headPosition: HeadPosition;
  public readonly diskPath: string;
  public readonly parser: G64Parser;
  public readonly romSet: LoadedC64RomSet;
  public readonly diskProvider: DiskProvider;
  public readonly kernalFileIo: KernalFileIoState;
  public readonly kernalSerial: KernalSerialState;
  public readonly kernalIo: KernalIoState;
  public readonly cia1: Cia6526;
  public readonly cia2: Cia6526;
  public readonly keyboard: KeyboardMatrix;
  public readonly joystick2: JoystickState;
  public readonly vic: VicII;
  public readonly sid: Sid6581;
  public readonly framebuffer: VicFramebuffer;
  public readonly enableKernalFileIoTraps: boolean;
  public readonly enableKernalSerialTraps: boolean;
  public readonly enableKernalIoTraps: boolean;
  // Sprint 92: cycle-lockstep scheduler. Optional opt-in for now via
  // useCycleLockstep option. Default false for back-compat.
  public readonly scheduler?: CycleLockstepSchedulerImpl;
  public readonly cpuCycled?: Cpu6510Cycled;
  public readonly useCycleLockstep: boolean;
  public readonly useMicrocodedCpu: boolean;
  // Spec 093: image format string ("g64" | "d64" | "other") + clock ratio.
  public readonly imageFormat: string;
  public readonly driveClockRatio: number;
  // Spec 093: drive PC trace ring (last N drive PCs sampled per step).
  private drivePcTrace: Array<{ cycle: number; pc: number }> = [];
  private drivePcTraceCapacity = 0;
  // NMI edge detection bookkeeping.
  private prevCia2IrqAsserted = false;
  public get lastTrap(): string | undefined { return this.kernalFileIo.lastTrap; }
  public get loadEvents(): KernalFileIoState["loadEvents"] { return this.kernalFileIo.loadEvents; }
  private readonly driveCyclesPerC64Cycle: number;
  private c64InstructionCount = 0;

  constructor(opts: IntegratedSessionOptions) {
    if (!existsSync(opts.diskPath)) throw new Error(`Disk image not found: ${opts.diskPath}`);
    const isPal = opts.isPal ?? true;
    this.driveCyclesPerC64Cycle = DRIVE_HZ / (isPal ? C64_HZ_PAL : C64_HZ_NTSC);
    this.driveClockRatio = this.driveCyclesPerC64Cycle;
    const ext = opts.diskPath.toLowerCase().split(".").pop() ?? "";
    this.imageFormat = ext === "g64" ? "g64" : ext === "d64" ? "d64" : ext || "other";
    this.diskPath = opts.diskPath;
    this.parser = new G64Parser(readFileSync(opts.diskPath));
    this.diskProvider = DiskProvider.fromImagePath(opts.diskPath);
    this.trackBuffer = new TrackBuffer(this.parser);
    this.headPosition = new HeadPosition({ startTrack: opts.startTrack ?? 18 });
    this.iecBus = new IecBus();

    // C64 side.
    this.c64Bus = new HeadlessMemoryBus();
    this.romSet = loadAllC64Roms();
    if (this.romSet.allRomsAvailable) {
      this.c64Bus.loadKernalRom(this.romSet.kernal.bytes);
      this.c64Bus.loadBasicRom(this.romSet.basic.bytes);
      this.c64Bus.loadCharRom(this.romSet.charRom.bytes);
    }
    // Spec 083 / VICE-style: when C64 reads or writes IEC bus state,
    // first catch the drive CPU up to the current cycle so drive's
    // response reflects all elapsed time. Without this, drive lag
    // breaks serial bit timing.
    this.cia2 = installCia2(this.c64Bus, this.iecBus);
    const cia1Install = installCia1(this.c64Bus);
    this.cia1 = cia1Install.cia;
    this.keyboard = cia1Install.keyboard;
    this.joystick2 = cia1Install.joystick2;
    this.vic = installVicII(this.c64Bus);
    this.sid = installSid(this.c64Bus);
    if (!isPal) this.vic.setNtsc();
    this.c64Bus.reset();
    this.c64Cpu = new Cpu6510(this.c64Bus);

    // Drive side. Spec 090: configure sync ratio + zero baseline.
    this.drive = new DriveCpu({
      deviceId: opts.deviceId ?? 8,
      iecBus: this.iecBus,
      gcr: { trackBuffer: this.trackBuffer, headPosition: this.headPosition, writeProtected: opts.writeProtected },
    });
    this.iecBus.attachDriveRam(this.drive.bus.ram);
    // Spec 090: configure drive's sync ratio + zero baseline.
    this.drive.setSyncRatio(this.driveCyclesPerC64Cycle);
    this.drive.setSyncBaseline(0);
    // Spec 090: bus-read hook for legacy non-lockstep mode. In Sprint 92
    // lockstep, drive ticks per cycle so hook becomes no-op. We install
    // it conditionally on construction (after drive built).
    if (!opts.useCycleLockstep) {
      this.iecBus.beforeC64Read = () => this.drive.executeToClock(this.c64Cpu.cycles);
    }

    this.kernalFileIo = makeKernalFileIoState();
    this.kernalSerial = makeKernalSerialState();
    this.kernalIo = makeKernalIoState();
    // Spec 083: real KERNAL serial bit-bang via cycle-precise CIA timer
    // is the default. Traps are opt-in fast-mode.
    this.enableKernalFileIoTraps = opts.enableKernalFileIoTraps ?? false;
    this.enableKernalSerialTraps = opts.enableKernalSerialTraps ?? false;
    this.enableKernalIoTraps = opts.enableKernalIoTraps ?? false;
    this.framebuffer = new VicFramebuffer(isPal);

    // Sprint 92: cycle-lockstep scheduler (opt-in).
    this.useCycleLockstep = (opts.useCycleLockstep ?? false) || (opts.useMicrocodedCpu ?? false);
    this.useMicrocodedCpu = opts.useMicrocodedCpu ?? false;
    // Spec 093: trace wiring. timeSource bound to c64Cpu cycles via getter.
    this.iecBus.timeSource = () => this.c64Cpu.cycles;
    if (opts.traceIec) this.iecBus.enableTrace(opts.traceIecCapacity ?? 1024);
    this.drivePcTraceCapacity = opts.traceDrive ? (opts.traceDriveCapacity ?? 512) : 0;
    if (this.useCycleLockstep) {
      // Sprint 92.7 v2: optional microcoded cpu (per-cycle bus access).
      let cpuCompoonent: any;
      if (opts.useMicrocodedCpu) {
        const microcoded = new Cpu6510Microcoded(this.c64Bus);
        // Replace c64Cpu with microcoded version. Cast — both share
        // public register state interface.
        (this as any).c64Cpu = microcoded;
        microcoded.reset();
        cpuCompoonent = microcoded;
      } else {
        const cpuCycled = new Cpu6510Cycled(this.c64Cpu);
        cpuCycled.preInstructionCheck = () => this.checkC64Interrupts();
        this.cpuCycled = cpuCycled;
        cpuCompoonent = cpuCycled;
      }
      const c64Components = [
        cpuCompoonent,
        new CiaCycled(this.cia1),
        new CiaCycled(this.cia2),
        new VicCycled(this.vic),
        new SidCycled(this.sid),
        new KeyboardCycled(this.keyboard),
      ];
      const driveComponents = [
        new DriveCpuCycled(this.drive),
        new ViaCycled(this.drive.bus.via1),
        new ViaCycled(this.drive.bus.via2),
      ];
      this.scheduler = new CycleLockstepSchedulerImpl({
        c64Components, driveComponents,
        c64IsAtInstructionBoundary: () => cpuCompoonent.isAtInstructionBoundary?.() ?? true,
        c64Pc: () => this.c64Cpu.pc,
        isPal,
        // Sprint 93.1: per-cycle IRQ/NMI pin update (VICE pattern).
        updateInterruptLines: opts.useMicrocodedCpu
          ? () => this.updateMicrocodedInterruptLines()
          : undefined,
      });
    }
  }

  // Render the current VIC state to the framebuffer (text mode only
  // for Phase 65b — bitmap + sprites in 65d/65e).
  renderFrame(): void {
    const cia2Pa = this.cia2.pra & this.cia2.ddra; // output bits only
    const bankBase = computeVicBankBase(cia2Pa & 0x03);
    renderTextModeFrame(this.framebuffer, {
      vic: this.vic,
      bus: this.c64Bus,
      vicBankBase: bankBase,
    });
  }

  // Render current VIC state then write to a PNG file. Phase 65f.
  renderToPng(path: string): { width: number; height: number; bytes: number } {
    this.renderFrame();
    const png = rgbaToPng(this.framebuffer.width, this.framebuffer.height, this.framebuffer.pixels);
    writeFileSync(path, png);
    return { width: this.framebuffer.width, height: this.framebuffer.height, bytes: png.length };
  }

  resetCold(): void {
    this.c64Bus.reset();
    this.iecBus.reset();
    if (this.iecBus.isTraceEnabled()) this.iecBus.clearTrace();
    this.c64Cpu.reset();
    this.drive.reset();
    this.drive.setSyncBaseline(this.c64Cpu.cycles);
    this.sid.reset();
    this.c64InstructionCount = 0;
    this.drivePcTrace = [];
  }

  // Sprint 93.1: queue text typing into keyboard matrix. Hold/gap default
  // tuned for KERNAL SCNKEY raster IRQ (~16400 cyc per scan): 33000 cyc
  // hold + 33000 cyc gap means at least 2 scan ticks see press, 2 scan
  // ticks see release — buffer reliably picks up the key.
  typeText(text: string, holdCycles = 33000, gapCycles = 33000): void {
    this.keyboard.typeText(text, holdCycles, gapCycles);
  }

  // Sprint 93.1: set joystick port 2 directional / fire state.
  setJoystick2(state: Partial<JoystickState>): void {
    if (state.up !== undefined) this.joystick2.up = state.up;
    if (state.down !== undefined) this.joystick2.down = state.down;
    if (state.left !== undefined) this.joystick2.left = state.left;
    if (state.right !== undefined) this.joystick2.right = state.right;
    if (state.fire !== undefined) this.joystick2.fire = state.fire;
  }

  // Spec 093: drive PC sample (called per C64 instruction step).
  private sampleDrivePc(): void {
    if (this.drivePcTraceCapacity <= 0) return;
    const pc = this.drive.cpu.pc;
    const last = this.drivePcTrace[this.drivePcTrace.length - 1];
    if (last && last.pc === pc) return; // dedupe consecutive
    this.drivePcTrace.push({ cycle: this.c64Cpu.cycles, pc });
    if (this.drivePcTrace.length > this.drivePcTraceCapacity) this.drivePcTrace.shift();
  }

  getDrivePcTrace(): Array<{ cycle: number; pc: number }> { return this.drivePcTrace.slice(); }
  getIecTrace() { return this.iecBus.getTrace(); }

  loadPrgIntoRam(prgPath: string, overrideLoadAddress?: number): PrgLoadResult {
    if (!existsSync(prgPath)) throw new Error(`PRG not found: ${prgPath}`);
    const data = readFileSync(prgPath);
    if (data.length < 2) throw new Error(`PRG too short: ${prgPath}`);
    const headerAddress = data[0]! | (data[1]! << 8);
    const loadAddress = overrideLoadAddress ?? headerAddress;
    const payload = data.slice(2);
    for (let i = 0; i < payload.length; i++) {
      this.c64Bus.ram[(loadAddress + i) & 0xffff] = payload[i]!;
    }
    return {
      loadAddress,
      endAddress: (loadAddress + payload.length - 1) & 0xffff,
      bytesLoaded: payload.length,
    };
  }

  // Sprint 92: extracted helper for trap dispatch — used by both
  // legacy stepC64Instruction and scheduler-backed path.
  private checkAndHandleTraps(): boolean {
    return ((this.enableKernalFileIoTraps && handleKernalFileIoTrap({
      cpu: this.c64Cpu, bus: this.c64Bus,
      diskProvider: this.diskProvider, state: this.kernalFileIo,
    })) || (this.enableKernalSerialTraps && handleKernalSerialTrap({
      cpu: this.c64Cpu, bus: this.c64Bus,
      diskProvider: this.diskProvider, drive: this.drive,
      iecBus: this.iecBus, state: this.kernalSerial,
    })) || (this.enableKernalIoTraps && handleKernalIoTrap({
      cpu: this.c64Cpu, bus: this.c64Bus,
      diskProvider: this.diskProvider, serial: this.kernalSerial,
      state: this.kernalIo,
    }))) === true;
  }

  stepC64Instruction(): void {
    if (this.scheduler) {
      // Sprint 92: route through cycle-lockstep scheduler. Trap path
      // still checked at instruction boundary BEFORE delegating to
      // scheduler — traps short-circuit a real instruction.
      const trapped = this.checkAndHandleTraps();
      if (trapped) {
        // Trap consumed an "instruction" worth of cycles. Run scheduler
        // for ~7 cycles to advance peripherals + drive.
        this.scheduler.runCycles(7);
        this.sampleDrivePc();
        return;
      }
      this.scheduler.runInstructions(1);
      this.sampleDrivePc();
      return;
    }
    // Spec 064 Sprint 69b: KERNAL file-IO traps now opt-in via
    // enableKernalFileIoTraps. Default is real KERNAL serial via
    // CIA1 timer + drive ROM bit-bang. Trap path kept as fallback
    // for cases where the real protocol stalls (still being tuned).
    // Sprint 67 + 72: KERNAL trap suite. Try fileio first then serial.
    // enableKernalFileIoTraps gates fileio path (default off — Sprint
    // 69 wants real KERNAL serial). Serial trap suite always on; it's
    // the workaround for the byte-tx mutual-wait until Sprint 69b
    // finish lands.
    const trapped = (this.enableKernalFileIoTraps && handleKernalFileIoTrap({
      cpu: this.c64Cpu, bus: this.c64Bus,
      diskProvider: this.diskProvider, state: this.kernalFileIo,
    })) || (this.enableKernalSerialTraps && handleKernalSerialTrap({
      cpu: this.c64Cpu, bus: this.c64Bus,
      diskProvider: this.diskProvider, drive: this.drive,
      iecBus: this.iecBus, state: this.kernalSerial,
    })) || (this.enableKernalIoTraps && handleKernalIoTrap({
      cpu: this.c64Cpu, bus: this.c64Bus,
      diskProvider: this.diskProvider, serial: this.kernalSerial,
      state: this.kernalIo,
    }));
    if (trapped) {
      this.c64InstructionCount += 1;
      const trapCycles = 7;
      this.c64Cpu.cycles += trapCycles;
      this.cia1.tick(trapCycles);
      this.cia2.tick(trapCycles);
      this.vic.tick(trapCycles);
      this.sid.tick(trapCycles);
      this.keyboard.advance(trapCycles);
      // Spec 090: drive lazy executeToClock instead of accumulator drain.
      this.drive.executeToClock(this.c64Cpu.cycles);
      this.sampleDrivePc();
      return;
    }
    // Spec 090 / VICE pattern: drive catches up to current C64 clock
    // BEFORE the C64 instruction starts (so any bus access during
    // the instruction sees up-to-date drive state).
    this.drive.executeToClock(this.c64Cpu.cycles);
    this.checkC64Interrupts();
    const before = this.c64Cpu.cycles;
    this.c64Cpu.step();
    this.c64InstructionCount += 1;
    const consumed = this.c64Cpu.cycles - before;
    // Sprint 84: VIC may steal cycles via bad-line + sprite DMA. CPU
    // pauses; peripherals still tick during stolen cycles ("wall
    // clock" advances). CPU.cycles also advanced so future scheduling
    // is correct.
    const vicTick = this.vic.tick(consumed);
    const totalCycles = consumed + vicTick.stolenCycles;
    if (vicTick.stolenCycles > 0) this.c64Cpu.cycles += vicTick.stolenCycles;
    // Tick CIA / SID / keyboard for the full wall-clock window.
    this.cia1.tick(totalCycles);
    this.cia2.tick(totalCycles);
    this.sid.tick(totalCycles);
    this.keyboard.advance(totalCycles);
    // Spec 090: drive catches up to NEW C64 clock after instruction.
    this.drive.executeToClock(this.c64Cpu.cycles);
    this.sampleDrivePc();
  }

  runFor(maxC64Instructions: number, opts?: { breakpoints?: Set<number>; cycleBudget?: number }): {
    instructionsExecuted: number;
    lastPc: number;
    aborted?: "breakpoint" | "cycle-budget";
  } {
    const breakpoints = opts?.breakpoints;
    const cycleBudget = opts?.cycleBudget ?? Infinity;
    const startCycles = this.c64Cpu.cycles;
    let i = 0;
    for (; i < maxC64Instructions; i++) {
      if (breakpoints && breakpoints.has(this.c64Cpu.pc)) {
        return { instructionsExecuted: i, lastPc: this.c64Cpu.pc, aborted: "breakpoint" };
      }
      if (this.c64Cpu.cycles - startCycles >= cycleBudget) {
        return { instructionsExecuted: i, lastPc: this.c64Cpu.pc, aborted: "cycle-budget" };
      }
      this.stepC64Instruction();
    }
    return { instructionsExecuted: i, lastPc: this.c64Cpu.pc };
  }

  // Spec 090: legacy flushDriveCycles kept as no-op shim for any
  // remaining callers. Drive lazy-executes via drive.executeToClock
  // now. Wrapper just forwards to executeToClock with current C64 clk.
  flushDriveCycles(): void {
    this.drive.executeToClock(this.c64Cpu.cycles);
  }

  // Sprint 93.1: per-cycle IRQ/NMI pin refresh for microcoded CPU. Called
  // by the cycle-lockstep scheduler before each cycle. Mirrors VICE's
  // maincpu_int_status pattern: peripherals assert/deassert IRQ/NMI pin,
  // CPU samples it at instruction boundary (handled inside microcoded
  // cpu's startInstructionCycle).
  private updateMicrocodedInterruptLines(): void {
    const cpu = this.c64Cpu as any;
    if (!("irqLine" in cpu)) return;
    cpu.irqLine = this.cia1.irqAsserted() || this.vic.irqAsserted();
    cpu.nmiLine = this.cia2.irqAsserted();
  }

  private checkC64Interrupts(): void {
    // CIA2 → C64 NMI (edge-triggered). RESTORE-key NMI deferred.
    const cia2Irq = this.cia2.irqAsserted();
    if (cia2Irq && !this.prevCia2IrqAsserted) {
      this.c64Cpu.serviceInterrupt(0xfffa, false);
    }
    this.prevCia2IrqAsserted = cia2Irq;
    // CIA1 + VIC → C64 IRQ (level-triggered, gated by I-flag).
    if (!this.c64Cpu.interruptsDisabled() && (this.cia1.irqAsserted() || this.vic.irqAsserted())) {
      this.c64Cpu.serviceInterrupt(0xfffe, false);
    }
  }

  status(): {
    c64: { pc: number; a: number; x: number; y: number; sp: number; flags: number; cycles: number; instructions: number };
    drive: { pc: number; a: number; x: number; y: number; sp: number; flags: number; cycles: number; instructions: number; track: number };
    iecBus: ReturnType<IecBus["snapshot"]>;
    romSet: { kernal: string; basic: string; charRom: string };
    runtime: {
      imageFormat: string;
      diskPath: string;
      useCycleLockstep: boolean;
      useMicrocodedCpu: boolean;
      driveClockRatio: number;
      enableKernalFileIoTraps: boolean;
      enableKernalSerialTraps: boolean;
      enableKernalIoTraps: boolean;
      iecTraceEnabled: boolean;
      drivePcTraceCapacity: number;
    };
  } {
    return {
      c64: {
        pc: this.c64Cpu.pc, a: this.c64Cpu.a, x: this.c64Cpu.x, y: this.c64Cpu.y,
        sp: this.c64Cpu.sp, flags: this.c64Cpu.flags,
        cycles: this.c64Cpu.cycles, instructions: this.c64InstructionCount,
      },
      drive: {
        pc: this.drive.cpu.pc, a: this.drive.cpu.a, x: this.drive.cpu.x, y: this.drive.cpu.y,
        sp: this.drive.cpu.sp, flags: this.drive.cpu.flags,
        cycles: this.drive.cpu.cycles, instructions: 0,
        track: this.headPosition.currentTrack,
      },
      iecBus: this.iecBus.snapshot(),
      romSet: {
        kernal: `${this.romSet.kernal.source}${this.romSet.kernal.path ? ` (${this.romSet.kernal.path})` : ""}`,
        basic: `${this.romSet.basic.source}${this.romSet.basic.path ? ` (${this.romSet.basic.path})` : ""}`,
        charRom: `${this.romSet.charRom.source}${this.romSet.charRom.path ? ` (${this.romSet.charRom.path})` : ""}`,
      },
      runtime: {
        imageFormat: this.imageFormat,
        diskPath: this.diskPath,
        useCycleLockstep: this.useCycleLockstep,
        useMicrocodedCpu: this.useMicrocodedCpu,
        driveClockRatio: this.driveClockRatio,
        enableKernalFileIoTraps: this.enableKernalFileIoTraps,
        enableKernalSerialTraps: this.enableKernalSerialTraps,
        enableKernalIoTraps: this.enableKernalIoTraps,
        iecTraceEnabled: this.iecBus.isTraceEnabled(),
        drivePcTraceCapacity: this.drivePcTraceCapacity,
      },
    };
  }
}
