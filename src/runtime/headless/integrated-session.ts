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
import { DiskProvider } from "./providers.js";
import { existsSync, readFileSync } from "node:fs";

// KERNAL JMP-table addresses we trap. Sprint 67 rationale: CIA1
// timer A IRQ + raster-IRQ jiffy aren't yet modeled; real KERNAL
// serial routines depend on CIA1 timer T1 for inter-bit handshake
// delays. Without that, the C64 + drive ROM end up in mutual-wait
// during the LOAD bit-bang (verified during Sprint 66 iteration).
//
// The valuable trace material — custom-loader drive code installed
// via M-W and started via M-E — runs on the drive CPU and bit-bangs
// $DD00 DIRECTLY, bypassing KERNAL. The trap fast-paths bootstrap
// LOAD via direct G64 read; real-IEC bit-mirror handles everything
// downstream. Documented for spec 062 follow-up: model CIA1 timer
// to retire the trap.
const KERNAL_SETLFS = 0xffba;
const KERNAL_SETNAM = 0xffbd;
const KERNAL_LOAD = 0xffd5;
const KERNAL_SAVE = 0xffd8;

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
  public readonly diskProvider: DiskProvider;
  // KERNAL trap state (mirrors HeadlessSession's loaderState shape).
  public lastTrap?: string;
  private logicalFile = 0;
  private device = 0;
  private secondaryAddress = 1;
  private fileName = "";
  public loadEvents: Array<{ name: string; loadAddress: number; endAddress: number; bytesLoaded: number }> = [];
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
    attachCia2ToIecBus(this.c64Bus, this.iecBus);
    this.installVicMinimalStubs();
    this.installCia1KeyboardStub();
    this.c64Bus.reset();
    this.c64Cpu = new Cpu6510(this.c64Bus);

    // Drive side.
    this.drive = new DriveCpu({
      deviceId: opts.deviceId ?? 8,
      iecBus: this.iecBus,
      gcr: { trackBuffer: this.trackBuffer, headPosition: this.headPosition, writeProtected: opts.writeProtected },
    });
    // Sprint 66 hack: hand drive RAM to iec-bus for the ATN-pending
    // flag direct-poke (works around boot-order CA1 IRQ miss).
    this.iecBus.attachDriveRam(this.drive.bus.ram);
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
  // KERNAL LOAD/SAVE/SETLFS/SETNAM are trapped at the JMP-table entry
  // (see header rationale). Custom-loader bit-bang traffic via $DD00
  // bypasses KERNAL and runs through the real iec-bus bit-mirror —
  // that's what we want to trace.
  stepC64Instruction(): void {
    if (this.handleKernalTrap()) {
      this.c64InstructionCount += 1;
      this.driveCycleAccumulator += 7 * this.driveCyclesPerC64Cycle;
      while (this.driveCycleAccumulator >= 1) this.runOneDriveStep();
      return;
    }
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

  private handleKernalTrap(): boolean {
    switch (this.c64Cpu.pc) {
      case KERNAL_SETLFS: this.trapSetlfs(); return true;
      case KERNAL_SETNAM: this.trapSetnam(); return true;
      case KERNAL_LOAD: this.trapLoad(); return true;
      case KERNAL_SAVE: this.trapSave(); return true;
      default: return false;
    }
  }

  private trapSetlfs(): void {
    this.logicalFile = this.c64Cpu.a;
    this.device = this.c64Cpu.x;
    this.secondaryAddress = this.c64Cpu.y;
    // Mirror real KERNAL: write to zero-page so direct readers see them.
    this.c64Bus.ram[0xb8] = this.logicalFile;
    this.c64Bus.ram[0xba] = this.device;
    this.c64Bus.ram[0xb9] = this.secondaryAddress;
    this.c64Cpu.setCarry(false);
    this.c64Cpu.returnFromSubroutine();
    this.lastTrap = `SETLFS lfn=${this.logicalFile} device=${this.device} sa=${this.secondaryAddress}`;
  }

  private trapSetnam(): void {
    const length = this.c64Cpu.a & 0xff;
    const ptr = this.c64Cpu.x | (this.c64Cpu.y << 8);
    const bytes: number[] = [];
    for (let i = 0; i < length; i++) bytes.push(this.c64Bus.read((ptr + i) & 0xffff));
    this.fileName = String.fromCharCode(...bytes);
    // Mirror real KERNAL.
    this.c64Bus.ram[0xb7] = length;
    this.c64Bus.ram[0xbb] = ptr & 0xff;
    this.c64Bus.ram[0xbc] = (ptr >> 8) & 0xff;
    this.c64Cpu.setCarry(false);
    this.c64Cpu.returnFromSubroutine();
    this.lastTrap = `SETNAM "${this.fileName}" @ $${ptr.toString(16)}`;
  }

  private trapLoad(): void {
    // Re-read filename from zero-page so direct callers (script
    // setting $B7/$BB/$BC + skipping SETNAM) work too.
    const fnLen = this.c64Bus.ram[0xb7]!;
    const fnPtr = this.c64Bus.ram[0xbb]! | (this.c64Bus.ram[0xbc]! << 8);
    let nameFromZp = "";
    for (let i = 0; i < fnLen; i++) {
      nameFromZp += String.fromCharCode(this.c64Bus.read((fnPtr + i) & 0xffff));
    }
    if (nameFromZp) this.fileName = nameFromZp;
    this.device = this.c64Bus.ram[0xba]!;
    this.secondaryAddress = this.c64Bus.ram[0xb9]!;
    const fileName = this.fileName.trim();
    if (!fileName) {
      this.c64Cpu.setCarry(true);
      this.c64Cpu.a = 8;
      this.c64Cpu.returnFromSubroutine();
      this.lastTrap = `LOAD ERROR: no filename`;
      return;
    }
    const match = this.diskProvider.findFile(fileName);
    if (!match) {
      this.c64Cpu.setCarry(true);
      this.c64Cpu.a = 4;
      this.c64Cpu.returnFromSubroutine();
      this.lastTrap = `LOAD ERROR: "${fileName}" not found`;
      return;
    }
    const bytes = match.bytes;
    const fileLoadAddress = bytes.length >= 2 ? (bytes[0]! | (bytes[1]! << 8)) : 0;
    const target = this.secondaryAddress === 0 ? (this.c64Cpu.x | (this.c64Cpu.y << 8)) : fileLoadAddress;
    const payload = bytes.length >= 2 ? bytes.slice(2) : bytes;
    for (let i = 0; i < payload.length; i++) {
      this.c64Bus.ram[(target + i) & 0xffff] = payload[i]!;
    }
    const end = (target + payload.length) & 0xffff;
    this.c64Cpu.a = 0;
    this.c64Cpu.x = end & 0xff;
    this.c64Cpu.y = (end >> 8) & 0xff;
    this.c64Cpu.setCarry(false);
    this.c64Cpu.returnFromSubroutine();
    this.lastTrap = `LOAD "${match.entry.name}" -> $${target.toString(16)}-$${(end - 1).toString(16)} (${payload.length} bytes)`;
    this.loadEvents.push({ name: match.entry.name, loadAddress: target, endAddress: end, bytesLoaded: payload.length });
  }

  private trapSave(): void {
    this.c64Cpu.setCarry(false);
    this.c64Cpu.returnFromSubroutine();
    this.lastTrap = `SAVE (no-op stub)`;
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

  // Minimal VIC stubs so KERNAL cold-start doesn't deadlock on
  // raster polling. Spec 063 Phase A replaces these with the real
  // VIC video model. For now: $D012 returns 0 always (so KERNAL's
  // PAL/NTSC detection at $FF5E sees "raster at 0 = top of frame"
  // immediately); $D011 high bit (raster bit 8) returns 0; $D019
  // returns 0 (no IRQ source pending) so KERNAL clears the flag and
  // proceeds.
  // Minimal CIA1 stubs so KERNAL's keyboard-scan IRQ doesn't pollute
  // the keyboard buffer with phantom keypresses (every key would
  // appear pressed because $DC01 reads default 0). Returning $FF (all
  // keys released) lets injected $0277 / $C6 buffer state persist.
  private installCia1KeyboardStub(): void {
    this.c64Bus.registerIoHandler(0xdc01, {
      read: () => 0xff, // all keys released
      write: (_addr, value) => { this.c64Bus.io[0xdc01 - 0xd000] = value & 0xff; },
    });
  }

  private installVicMinimalStubs(): void {
    // $D011 — control register 1. Bit 7 = current raster line bit 8.
    // We always report bit 7 = 0 (raster line < 256) regardless of
    // what KERNAL latched. Other bits returned from io[] for compat.
    this.c64Bus.registerIoHandler(0xd011, {
      read: () => this.c64Bus.io[0xd011 - 0xd000]! & 0x7f,
      write: (_addr, value) => { this.c64Bus.io[0xd011 - 0xd000] = value & 0xff; },
    });
    // $D012 — current raster line low byte. Always 0.
    this.c64Bus.registerIoHandler(0xd012, {
      read: () => 0,
      write: (_addr, value) => { this.c64Bus.io[0xd012 - 0xd000] = value & 0xff; },
    });
    // $D019 — VIC IRQ status. Always 0 (no IRQ source has fired).
    // Without this stub, KERNAL's PAL/NTSC detect reads back the
    // last test-pattern value and mis-detects.
    this.c64Bus.registerIoHandler(0xd019, {
      read: () => 0,
      write: (_addr, value) => { this.c64Bus.io[0xd019 - 0xd000] = value & 0xff; },
    });
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
