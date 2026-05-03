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
import type { KeyboardMatrix } from "./peripherals/keyboard.js";
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
  public readonly vic: VicII;
  public readonly sid: Sid6581;
  public readonly framebuffer: VicFramebuffer;
  public readonly enableKernalFileIoTraps: boolean;
  public readonly enableKernalSerialTraps: boolean;
  public readonly enableKernalIoTraps: boolean;
  // NMI edge detection bookkeeping.
  private prevCia2IrqAsserted = false;
  public get lastTrap(): string | undefined { return this.kernalFileIo.lastTrap; }
  public get loadEvents(): KernalFileIoState["loadEvents"] { return this.kernalFileIo.loadEvents; }
  private readonly driveCyclesPerC64Cycle: number;
  private driveCycleAccumulator = 0;
  private c64InstructionCount = 0;
  private driveInstructionCount = 0;

  constructor(opts: IntegratedSessionOptions) {
    if (!existsSync(opts.diskPath)) throw new Error(`Disk image not found: ${opts.diskPath}`);
    const isPal = opts.isPal ?? true;
    this.driveCyclesPerC64Cycle = DRIVE_HZ / (isPal ? C64_HZ_PAL : C64_HZ_NTSC);
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
    this.iecBus.beforeC64Read = () => this.flushDriveCycles();
    this.cia2 = installCia2(this.c64Bus, this.iecBus);
    const cia1Install = installCia1(this.c64Bus);
    this.cia1 = cia1Install.cia;
    this.keyboard = cia1Install.keyboard;
    this.vic = installVicII(this.c64Bus);
    this.sid = installSid(this.c64Bus);
    if (!isPal) this.vic.setNtsc();
    this.c64Bus.reset();
    this.c64Cpu = new Cpu6510(this.c64Bus);

    // Drive side.
    this.drive = new DriveCpu({
      deviceId: opts.deviceId ?? 8,
      iecBus: this.iecBus,
      gcr: { trackBuffer: this.trackBuffer, headPosition: this.headPosition, writeProtected: opts.writeProtected },
    });
    this.iecBus.attachDriveRam(this.drive.bus.ram);

    this.kernalFileIo = makeKernalFileIoState();
    this.kernalSerial = makeKernalSerialState();
    this.kernalIo = makeKernalIoState();
    // Spec 083: real KERNAL serial bit-bang via cycle-precise CIA timer
    // is the default. Traps are opt-in fast-mode.
    this.enableKernalFileIoTraps = opts.enableKernalFileIoTraps ?? false;
    this.enableKernalSerialTraps = opts.enableKernalSerialTraps ?? false;
    this.enableKernalIoTraps = opts.enableKernalIoTraps ?? false;
    this.framebuffer = new VicFramebuffer(isPal);
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
    this.c64Cpu.reset();
    this.drive.reset();
    this.sid.reset();
    this.driveCycleAccumulator = 0;
    this.c64InstructionCount = 0;
    this.driveInstructionCount = 0;
  }

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

  stepC64Instruction(): void {
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
      this.cia1.tick(trapCycles);
      this.cia2.tick(trapCycles);
      this.vic.tick(trapCycles);
      this.sid.tick(trapCycles);
      this.keyboard.advance(trapCycles);
      this.driveCycleAccumulator += trapCycles * this.driveCyclesPerC64Cycle;
      while (this.driveCycleAccumulator >= 1) this.runOneDriveStep();
      return;
    }
    this.checkC64Interrupts();
    const before = this.c64Cpu.cycles;
    this.c64Cpu.step();
    this.c64InstructionCount += 1;
    const consumed = this.c64Cpu.cycles - before;
    // Sprint 84: VIC may steal cycles via bad-line + sprite DMA. CPU
    // pauses; CIA + drive + SID + keyboard still tick during stolen
    // cycles ("wall clock" advances). CPU.cycles also advanced so
    // future scheduling is correct.
    const vicTick = this.vic.tick(consumed);
    const totalCycles = consumed + vicTick.stolenCycles;
    if (vicTick.stolenCycles > 0) this.c64Cpu.cycles += vicTick.stolenCycles;
    this.cia1.tick(totalCycles);
    this.cia2.tick(totalCycles);
    this.sid.tick(totalCycles);
    this.keyboard.advance(totalCycles);
    this.driveCycleAccumulator += totalCycles * this.driveCyclesPerC64Cycle;
    while (this.driveCycleAccumulator >= 1) {
      this.runOneDriveStep();
    }
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

  // Spec 083 / VICE iecbus_cpu_execute_one pattern: drain the drive
  // cycle accumulator down to ≤ 0 so drive has caught up to the C64's
  // current time. Called from IecBus.beforeC64Read on every CIA2 PA
  // read/write. Idempotent — if no cycles owed, no-op.
  flushDriveCycles(): void {
    while (this.driveCycleAccumulator >= 1) {
      this.runOneDriveStep();
    }
  }

  private runOneDriveStep(): number {
    if (!this.drive.cpu.interruptsDisabled()) {
      const irq = this.drive.bus.via1.irqAsserted() || this.drive.bus.via2.irqAsserted();
      if (irq) this.drive.cpu.serviceInterrupt(0xfffe, false);
    }
    const consumed = this.drive.step();
    this.drive.bus.via1.tick(consumed);
    this.drive.bus.via2.tick(consumed);
    this.driveInstructionCount += 1;
    if (this.driveCycleAccumulator > 0) this.driveCycleAccumulator -= consumed;
    return consumed;
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
        cycles: this.drive.cpu.cycles, instructions: this.driveInstructionCount,
        track: this.headPosition.currentTrack,
      },
      iecBus: this.iecBus.snapshot(),
      romSet: {
        kernal: `${this.romSet.kernal.source}${this.romSet.kernal.path ? ` (${this.romSet.kernal.path})` : ""}`,
        basic: `${this.romSet.basic.source}${this.romSet.basic.path ? ` (${this.romSet.basic.path})` : ""}`,
        charRom: `${this.romSet.charRom.source}${this.romSet.charRom.path ? ` (${this.romSet.charRom.path})` : ""}`,
      },
    };
  }
}
