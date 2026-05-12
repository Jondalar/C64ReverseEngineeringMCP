// Spec 142 — Bus-access trace ring.
//
// Single event per logical bus access (= bus-touch cycle, NOT
// opcode-fetch cycles). Matches VICE binmon checkpoint semantics
// per Q1 decision. Used by Spec 143 to diff against VICE.
//
// Hooked from:
//   - IecBus.setC64Output      (c64 store $DD00 PA)
//   - IecBus.buildC64InputBits (c64 read $DD00 PA)
//   - Via6522.read(VIA_ORB)    (drive VIA1 read $1800)
//   - Via6522.write(VIA_ORB)   (drive VIA1 write $1800)
//
// Channel: "bus_access" via TraceRegistry. Mode "off" = zero overhead.

import type { TraceRegistry } from "./channels.js";
import type { IecBus } from "../iec/iec-bus.js";

export interface BusAccessIecSnapshot {
  atn: 0 | 1;            // raw line: 1 = released (high)
  clk: 0 | 1;
  data: 0 | 1;
  c64_atn: 0 | 1;        // per-side: 1 = released
  c64_clk: 0 | 1;
  c64_data: 0 | 1;
  drv_clk: 0 | 1;
  drv_data: 0 | 1;
  drv_atn_ack: 0 | 1;
}

export interface BusAccessVia1Snapshot {
  ifr: number;
  ier: number;
  pcr: number;
}

export interface BusAccessEvent {
  // Common
  cycle_c64: number;
  cycle_drive: number;
  side: "c64" | "drive";
  op: "read" | "write";
  addr: number;
  value: number;

  // CPU context
  pc: number;
  at_boundary: boolean;
  /** Free-form phase label (legacy). */
  phase?: string;
  /** Spec 287: address-bus Φ phase tag. "phi1" = VIC drives bus
   *  (matrix/bitmap/sprite fetch); "phi2" = CPU drives bus (normal
   *  read/write). Optional — undefined when not modeled (= back-compat). */
  phi?: "phi1" | "phi2";

  // IEC bus state at access time
  iec: BusAccessIecSnapshot;

  // VIA1 snapshot (only $1800 events)
  via1?: BusAccessVia1Snapshot;

  // Monotonic sequence index within capture window
  seq: number;
}

// Side-specific dependency injection. Producer pulls pc / cycle /
// at_boundary from whichever CPU is active.
export interface CpuAccessor {
  pc: number;
  cycles: number;
  isAtInstructionBoundary?: () => boolean;
}

export interface ScheduleAccessor {
  c64Cycle: () => number;
  driveCycle: () => number;
}

// VIA1 register read accessor. Optional — only needed if events
// should include via1 snapshot.
export interface Via1Accessor {
  ifr: number;
  ier: number;
  pcr: number;
}

export interface BusAccessTraceProducerDeps {
  registry: TraceRegistry;
  c64Cpu: CpuAccessor;
  driveCpu: CpuAccessor;
  schedule: ScheduleAccessor;
  iecBus: IecBus;
  driveVia1?: Via1Accessor;
}

export interface BusAccessTraceFilter {
  // PC ranges, inclusive on both ends. Empty = always emit.
  pcRangesC64: Array<[number, number]>;
  pcRangesDrive: Array<[number, number]>;
}

export interface BusAccessTraceProducer {
  emitC64Access(p: { op: "read" | "write"; addr: number; value: number }): void;
  emitDriveAccess(p: { op: "read" | "write"; addr: number; value: number }): void;
  setFilter(filter: BusAccessTraceFilter): void;
  enable(): void;
  disable(): void;
  isEnabled(): boolean;
  getSeqCount(): number;
  resetSeq(): void;
}

export class BusAccessTraceProducerImpl implements BusAccessTraceProducer {
  private enabled = false;
  private seq = 0;
  private filter: BusAccessTraceFilter = {
    pcRangesC64: [],
    pcRangesDrive: [],
  };

  constructor(private readonly deps: BusAccessTraceProducerDeps) {}

  enable(): void { this.enabled = true; }
  disable(): void { this.enabled = false; }
  isEnabled(): boolean { return this.enabled; }
  getSeqCount(): number { return this.seq; }
  resetSeq(): void { this.seq = 0; }

  setFilter(filter: BusAccessTraceFilter): void {
    this.filter = {
      pcRangesC64: filter.pcRangesC64.slice(),
      pcRangesDrive: filter.pcRangesDrive.slice(),
    };
  }

  emitC64Access(p: { op: "read" | "write"; addr: number; value: number }): void {
    if (!this.enabled) return;
    if (!this.deps.registry.isEnabled("bus_access")) return;
    const pc = this.deps.c64Cpu.pc;
    if (!this.passFilter(pc, this.filter.pcRangesC64)) return;
    const cycle_c64 = this.deps.schedule.c64Cycle();
    const cycle_drive = this.deps.schedule.driveCycle();
    const at_boundary = this.deps.c64Cpu.isAtInstructionBoundary?.() ?? true;
    const event: BusAccessEvent = {
      cycle_c64,
      cycle_drive,
      side: "c64",
      op: p.op,
      addr: p.addr & 0xffff,
      value: p.value & 0xff,
      pc: pc & 0xffff,
      at_boundary,
      iec: this.snapIec(),
      seq: this.seq++,
    };
    this.deps.registry.publish("bus_access", cycle_c64, event as unknown as Record<string, unknown>);
  }

  emitDriveAccess(p: { op: "read" | "write"; addr: number; value: number }): void {
    if (!this.enabled) return;
    if (!this.deps.registry.isEnabled("bus_access")) return;
    const pc = this.deps.driveCpu.pc;
    if (!this.passFilter(pc, this.filter.pcRangesDrive)) return;
    const cycle_c64 = this.deps.schedule.c64Cycle();
    const cycle_drive = this.deps.schedule.driveCycle();
    const at_boundary = this.deps.driveCpu.isAtInstructionBoundary?.() ?? true;
    const event: BusAccessEvent = {
      cycle_c64,
      cycle_drive,
      side: "drive",
      op: p.op,
      addr: p.addr & 0xffff,
      value: p.value & 0xff,
      pc: pc & 0xffff,
      at_boundary,
      iec: this.snapIec(),
      via1: this.deps.driveVia1
        ? { ifr: this.deps.driveVia1.ifr & 0xff, ier: this.deps.driveVia1.ier & 0xff, pcr: this.deps.driveVia1.pcr & 0xff }
        : undefined,
      seq: this.seq++,
    };
    this.deps.registry.publish("bus_access", cycle_drive, event as unknown as Record<string, unknown>);
  }

  private passFilter(pc: number, ranges: Array<[number, number]>): boolean {
    if (ranges.length === 0) return true;
    for (const [lo, hi] of ranges) {
      if (pc >= lo && pc <= hi) return true;
    }
    return false;
  }

  private snapIec(): BusAccessIecSnapshot {
    const snap = this.deps.iecBus.snapshot();
    return {
      atn: snap.line.atn ? 1 : 0,
      clk: snap.line.clk ? 1 : 0,
      data: snap.line.data ? 1 : 0,
      c64_atn: snap.c64.atnReleased ? 1 : 0,
      c64_clk: snap.c64.clkReleased ? 1 : 0,
      c64_data: snap.c64.dataReleased ? 1 : 0,
      drv_clk: snap.drive.clkReleased ? 1 : 0,
      drv_data: snap.drive.dataReleased ? 1 : 0,
      drv_atn_ack: snap.drive.atnAckReleased ? 1 : 0,
    };
  }
}

// No-op fallback used when tracing is disabled at construction time
// — avoids null checks in hot path.
export const NULL_BUS_ACCESS_PRODUCER: BusAccessTraceProducer = {
  emitC64Access() {},
  emitDriveAccess() {},
  setFilter() {},
  enable() {},
  disable() {},
  isEnabled() { return false; },
  getSeqCount() { return 0; },
  resetSeq() {},
};
