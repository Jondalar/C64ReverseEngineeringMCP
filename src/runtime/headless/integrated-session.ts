// IntegratedSession — C64 + 1541 drive coupled via shared IEC bus,
// dual-clock cycle accumulator. Real KERNAL/BASIC/CHARROM loaded so
// LISTEN/SECOND/CIOUT/UNLSN/TALK/etc are real bit-bang code that
// drives the IEC bus, which the drive emulation observes via VIA1
// PB pins.
//
// This is the path that finally lets headless trace games like
// Murder through their custom drive-install (M-W / M-E sequences)
// and runtime fastloader bit-bang. Stand-alone from the existing
// HeadlessSession (which keeps trap-based KERNAL behavior for
// backwards compatibility); future merger optional.

import { Cpu6510 } from "./cpu6510.js";
import { HeadlessMemoryBus } from "./memory-bus.js";
import { loadAllC64Roms, type LoadedC64RomSet } from "./c64-rom.js";
import { IecBus } from "./iec/iec-bus.js";
import { attachCia2ToIecBus } from "./iec/cia2-stub.js";
import { DriveCpu } from "./drive/drive-cpu.js";
import { TrackBuffer, HeadPosition } from "./drive/head-position.js";
import { G64Parser } from "../../disk/g64-parser.js";
import { existsSync, readFileSync } from "node:fs";

const C64_HZ_PAL = 985248;
const C64_HZ_NTSC = 1022727;
const DRIVE_HZ = 1000000;

// Reset vector points into KERNAL ROM at $FCE2 (cold-start) on a real
// C64. Calling cpu.reset() reads the vector at $FFFC/$FFFD which
// (with KERNAL ROM mapped) gives $FCE2.

export interface IntegratedSessionOptions {
  diskPath: string;
  isPal?: boolean;
  deviceId?: number;
  startTrack?: number;
  writeProtected?: boolean;
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
    attachCia2ToIecBus(this.c64Bus, this.iecBus);
    this.c64Bus.reset();
    this.c64Cpu = new Cpu6510(this.c64Bus);

    // Drive side.
    this.drive = new DriveCpu({
      deviceId: opts.deviceId ?? 8,
      iecBus: this.iecBus,
      gcr: { trackBuffer: this.trackBuffer, headPosition: this.headPosition, writeProtected: opts.writeProtected },
    });
  }

  // Reset both CPUs to their ROM cold-start vectors.
  resetCold(): void {
    this.c64Bus.reset();
    this.iecBus.reset();
    this.c64Cpu.reset();          // reads $FFFC/$FFFD = KERNAL cold start when ROM mapped
    this.drive.reset();           // reads $FFFC/$FFFD = drive ROM init
    this.driveCycleAccumulator = 0;
    this.c64InstructionCount = 0;
    this.driveInstructionCount = 0;
  }

  // Inject a PRG file into RAM as if KERNAL LOAD had completed. PRG
  // format: first 2 bytes = load address LE, rest = bytes.
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

  // Step ONE C64 instruction; the drive runs the proportional cycles.
  stepC64Instruction(): void {
    this.checkC64Interrupts();
    const before = this.c64Cpu.cycles;
    this.c64Cpu.step();
    this.c64InstructionCount += 1;
    const consumed = this.c64Cpu.cycles - before;
    this.driveCycleAccumulator += consumed * this.driveCyclesPerC64Cycle;
    while (this.driveCycleAccumulator >= 1) {
      this.runOneDriveStep();
    }
  }

  // Run for up to N C64 instructions or until breakpoint / max-cycle hit.
  // Returns counters + last-pc + abort reason.
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
    // Sprint 65 minimum: only honors VIA-style triggered IRQs that
    // would propagate via CIA1/2 IFR — we don't model CIA1/CIA2 timer
    // IRQs yet (Spec 063 Phase B). C64 IRQ wiring placeholder.
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
