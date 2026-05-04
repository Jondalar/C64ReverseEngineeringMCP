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
import { Cpu6510Cycled as Cpu6510Microcoded } from "../cpu/cpu6510-cycled.js";
import { Via6522 } from "./via6522.js";
import { makeStubVia1Pa, makeStubVia1Pb, makeBusVia1Pa, makeBusVia1Pb } from "./via1-iec.js";
import { makeStubVia2Pa, makeStubVia2Pb, makeGcrVia2Pa, makeGcrVia2Pb, type Via2GcrCoupling } from "./via2-gcr.js";
import { loadDriveRom, DRIVE_ROM_BASE, DRIVE_ROM_SIZE, type LoadedDriveRom } from "./drive-rom.js";
import type { IecBus } from "../iec/iec-bus.js";

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
  // Sprint 96 part 6 (Bug 39): use cycle-stepped microcoded CPU with
  // sub-instruction bus access. Required for IEC bit-bang correctness.
  useMicrocodedCpu?: boolean;
}

export class DriveBus implements CpuMemory {
  public readonly ram = new Uint8Array(DRIVE_RAM_SIZE);
  public readonly rom: Uint8Array;
  public readonly via1: Via6522;
  public readonly via2: Via6522;
  public readonly romSource: LoadedDriveRom["source"];
  public readonly romPath?: string;

  constructor(opts: DriveCpuOptions = {}) {
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
    if (opts.iecBus) {
      this.via1 = new Via6522(makeBusVia1Pa(), makeBusVia1Pb(opts.iecBus, opts.deviceId ?? 8));
      opts.iecBus.attachDriveVia1(this.via1);
    } else {
      this.via1 = new Via6522(makeStubVia1Pa(), makeStubVia1Pb(opts.deviceId ?? 8));
    }
    if (opts.gcr) {
      this.via2 = new Via6522(makeGcrVia2Pa(opts.gcr), makeGcrVia2Pb(opts.gcr));
    } else {
      this.via2 = new Via6522(makeStubVia2Pa(), makeStubVia2Pb());
    }
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
  public readonly cpu: Cpu6510 | Cpu6510Microcoded;
  public readonly bus: DriveBus;
  public readonly microcoded: boolean;

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
    this.bus = new DriveBus(opts);
    this.microcoded = opts.useMicrocodedCpu ?? false;
    this.cpu = this.microcoded
      ? new Cpu6510Microcoded(this.bus)
      : new Cpu6510(this.bus);
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
      this.bus.via1.tick(consumed);
      this.bus.via2.tick(consumed);
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
      const cycled = this.cpu as Cpu6510Microcoded;
      const before = cycled.cycles;
      // Set IRQ pin from VIAs (level-triggered). NMI not used by 1541.
      cycled.irqLine = this.bus.via1.irqAsserted() || this.bus.via2.irqAsserted();
      // Tick at least once, then until back at boundary.
      cycled.executeCycle();
      while (!cycled.isAtInstructionBoundary()) cycled.executeCycle();
      return cycled.cycles - before;
    }
    const legacy = this.cpu as Cpu6510;
    if (!legacy.interruptsDisabled()) {
      const irq = this.bus.via1.irqAsserted() || this.bus.via2.irqAsserted();
      if (irq) legacy.serviceInterrupt(0xfffe, false);
    }
    const before = legacy.cycles;
    legacy.step();
    return legacy.cycles - before;
  }
}
