// DriveSession — minimal harness that runs a C64 CPU + drive CPU in
// lockstep over a shared IEC bus.
//
// Sprint 61 scope: dual-step loop with cycle-accurate fractional
// accumulator (per Spec 062 Q2). Drive IRQ wired from VIA1+VIA2.
// Full session-manager integration (with disk image attachment, etc.)
// lands in Sprint 63.
//
// Use this class for tests that need both CPUs ticking together; for
// drive-only or C64-only isolated tests, instantiate the CPUs directly.

import { Cpu6510 } from "../cpu6510.js";
import { HeadlessMemoryBus } from "../memory-bus.js";
import { DriveCpu } from "./drive-cpu.js";
import { IecBus } from "../iec/iec-bus.js";
import { attachCia2ToIecBus } from "../iec/cia2-stub.js";
import { alarmContextDispatch } from "../alarm/alarm-context.js";

const C64_HZ_PAL = 985248;
const C64_HZ_NTSC = 1022727;
const DRIVE_HZ = 1000000;

import type { Via2GcrCoupling } from "./via2-gcr.js";

export interface DriveSessionOptions {
  isPal?: boolean;     // default true
  deviceId?: number;   // default 8
  gcr?: Via2GcrCoupling; // wire VIA2 to a TrackBuffer + HeadPosition
}

export class DriveSession {
  public readonly c64Bus: HeadlessMemoryBus;
  public readonly c64Cpu: Cpu6510;
  public readonly drive: DriveCpu;
  public readonly iecBus: IecBus;
  private readonly driveCyclesPerC64Cycle: number;
  private driveCycleAccumulator = 0;

  constructor(opts: DriveSessionOptions = {}) {
    const isPal = opts.isPal ?? true;
    this.driveCyclesPerC64Cycle = DRIVE_HZ / (isPal ? C64_HZ_PAL : C64_HZ_NTSC);
    this.iecBus = new IecBus();
    this.c64Bus = new HeadlessMemoryBus();
    attachCia2ToIecBus(this.c64Bus, this.iecBus);
    this.c64Cpu = new Cpu6510(this.c64Bus);
    this.drive = new DriveCpu({ deviceId: opts.deviceId, iecBus: this.iecBus, gcr: opts.gcr });
  }

  reset(c64Pc?: number, drivePc?: number): void {
    this.iecBus.reset();
    this.c64Bus.reset();
    this.c64Cpu.reset(c64Pc);
    this.drive.reset(drivePc);
    this.driveCycleAccumulator = 0;
  }

  // Step one C64 instruction; the drive CPU runs the proportional
  // number of cycles to keep the dual-clock in sync. After each drive
  // instruction, VIA timers tick and the IRQ line is checked.
  stepC64Instruction(): void {
    const before = this.c64Cpu.cycles;
    this.c64Cpu.step();
    const consumed = this.c64Cpu.cycles - before;
    this.driveCycleAccumulator += consumed * this.driveCyclesPerC64Cycle;
    while (this.driveCycleAccumulator >= 1) {
      this.runOneDriveStep();
    }
  }

  // Step ONE drive instruction (used in tests that want to advance
  // the drive without involving the C64).
  stepDriveInstruction(): number {
    return this.runOneDriveStep();
  }

  private runOneDriveStep(): number {
    // Pre-instruction interrupt check.
    this.checkDriveInterrupts();
    const consumed = this.drive.step();
    // Sprint 113 Phase 2: VIA1 + VIA2 are alarm-driven (Via1d1541 /
    // Via2d1541). No tick() call needed — the alarm context is drained
    // inside DriveCpu.executeToClock / DriveCpuCycled. For DriveSession
    // (standalone test harness), drain the local alarm context here.
    const ctx = this.drive.bus.alarmContext;
    const cpuClk = this.drive.cpu.cycles;
    let guard = 0;
    while (cpuClk >= ctx.next_pending_alarm_clk) {
      alarmContextDispatch(ctx, cpuClk);
      if (++guard > 0x1000) break;
    }
    if (this.driveCycleAccumulator > 0) {
      this.driveCycleAccumulator -= consumed;
    }
    return consumed;
  }

  private checkDriveInterrupts(): void {
    // 1541 wires VIA1 + VIA2 IRQ outputs into the 6502 IRQ line
    // (open-drain). NMI is unused on standard 1541.
    if (this.drive.cpu.interruptsDisabled()) return;
    const irq = this.drive.bus.via1.irqAsserted() || this.drive.bus.via2.irqAsserted();
    if (irq) {
      this.drive.cpu.serviceInterrupt(0xfffe, false);
    }
  }
}
