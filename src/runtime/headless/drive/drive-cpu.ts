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
import { Via6522 } from "./via6522.js";
import { makeStubVia1Pa, makeStubVia1Pb } from "./via1-iec.js";
import { makeStubVia2Pa, makeStubVia2Pb } from "./via2-gcr.js";
import { loadDriveRom, DRIVE_ROM_BASE, DRIVE_ROM_SIZE, type LoadedDriveRom } from "./drive-rom.js";

export const DRIVE_RAM_SIZE = 0x0800; // $0000-$07FF
export const VIA1_BASE = 0x1800;
export const VIA1_END = 0x1bff;
export const VIA2_BASE = 0x1c00;
export const VIA2_END = 0x1fff;

export interface DriveCpuOptions {
  deviceId?: number;        // 8-11; default 8
  rom?: LoadedDriveRom;     // skip ROM load if caller provides one
  romBytes?: Uint8Array;    // raw override (testing)
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
    this.via1 = new Via6522(makeStubVia1Pa(), makeStubVia1Pb(opts.deviceId ?? 8));
    this.via2 = new Via6522(makeStubVia2Pa(), makeStubVia2Pb());
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

// DriveCpu = Cpu6510 wired to a DriveBus. Sprint 60 keeps step()
// passthrough; the dual-clock accumulator wiring lands in
// session-manager.ts later in this sprint.
export class DriveCpu {
  public readonly cpu: Cpu6510;
  public readonly bus: DriveBus;

  constructor(opts: DriveCpuOptions = {}) {
    this.bus = new DriveBus(opts);
    this.cpu = new Cpu6510(this.bus);
  }

  reset(pc?: number): void {
    this.bus.reset();
    this.cpu.reset(pc);
  }

  // Step one instruction. Returns cycles consumed (for the dual-clock
  // accumulator in session-manager).
  step(): number {
    const before = this.cpu.cycles;
    this.cpu.step();
    return this.cpu.cycles - before;
  }
}
