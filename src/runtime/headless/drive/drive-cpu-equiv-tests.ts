// Spec 109 (M3.1) — drive CPU equivalence harness.
//
// Walks the 1541 DOS ROM from reset on both legacy Cpu6510 and
// microcoded Cpu65xxVice side-by-side, asserting state equality at
// each instruction boundary.
//
// Sub-stories:
//   M3.1a — runDriveRomEquivWalk: 50K instructions from reset, stub
//           VIAs (no IEC, no GCR), per-instruction state diff.
//   M3.1b — runSoPinTest: poke V flag (real-HW SO), assert next BVS
//           taken.
//   M3.1c — runIndexedCrossPageTest: LDA ($XX),Y across page; capture
//           bus access trace from microcoded core; pin via golden
//           expectation.
//   M3.1d — runStackOpTraces: PHA / PLA / PHP / PLP / JSR / RTS bus
//           trace (microcoded only — golden snapshot).
//   M3.1e — collectOpcodeCoverage: opcodes visited during equiv walk.

import { Cpu6510 } from "../cpu6510.js";
import { Cpu65xxVice } from "../cpu/cpu65xx-vice.js";
import { DriveBus } from "./drive-cpu.js";
import { OPCODE_TABLE } from "../../../exomizer-ts/generated-opcodes.js";
import { UNDOC_TABLE } from "../cpu/undoc-table.js";

export interface EquivDivergence {
  step: number;
  pc: number;
  opcode: number;
  legacy: { pc: number; a: number; x: number; y: number; sp: number; flags: number; cycles: number };
  micro:  { pc: number; a: number; x: number; y: number; sp: number; flags: number; cycles: number };
  diffs: string[];
}

export interface EquivWalkResult {
  steps: number;
  divergences: EquivDivergence[];
  opcodesVisited: Set<number>;
  finalCyclesLegacy: number;
  finalCyclesMicro: number;
  cycleDeltaByOpcode: Map<number, number>;
}

function snap(cpu: Cpu6510 | Cpu65xxVice): EquivDivergence["legacy"] {
  return { pc: cpu.pc, a: cpu.a, x: cpu.x, y: cpu.y, sp: cpu.sp, flags: cpu.flags, cycles: cpu.cycles };
}

function diffStates(a: EquivDivergence["legacy"], b: EquivDivergence["legacy"]): string[] {
  const out: string[] = [];
  if (a.pc !== b.pc) out.push(`pc: ${a.pc.toString(16)} vs ${b.pc.toString(16)}`);
  if (a.a  !== b.a ) out.push(`a: ${a.a.toString(16)} vs ${b.a.toString(16)}`);
  if (a.x  !== b.x ) out.push(`x: ${a.x.toString(16)} vs ${b.x.toString(16)}`);
  if (a.y  !== b.y ) out.push(`y: ${a.y.toString(16)} vs ${b.y.toString(16)}`);
  if (a.sp !== b.sp) out.push(`sp: ${a.sp.toString(16)} vs ${b.sp.toString(16)}`);
  // mask B (0x10) + unused (0x20) — both CPUs handle B differently.
  const fa = a.flags & 0xcf;
  const fb = b.flags & 0xcf;
  if (fa !== fb) out.push(`flags: ${fa.toString(16)} vs ${fb.toString(16)}`);
  return out;
}

function runOneInstrLegacy(cpu: Cpu6510, bus: DriveBus): number {
  const before = cpu.cycles;
  if (!cpu.interruptsDisabled()) {
    if (bus.via1.irqAsserted() || bus.via2.irqAsserted()) {
      cpu.serviceInterrupt(0xfffe, false);
    }
  }
  cpu.step();
  const consumed = cpu.cycles - before;
  bus.via1.tick(consumed);
  bus.via2.tick(consumed);
  return consumed;
}

function runOneInstrMicro(cpu: Cpu65xxVice, bus: DriveBus): number {
  const before = cpu.cycles;
  cpu.irqLine = bus.via1.irqAsserted() || bus.via2.irqAsserted();
  cpu.executeCycle();
  while (!cpu.isAtInstructionBoundary()) cpu.executeCycle();
  const consumed = cpu.cycles - before;
  bus.via1.tick(consumed);
  bus.via2.tick(consumed);
  return consumed;
}

export interface EquivWalkOpts {
  romBytes?: Uint8Array;     // override ROM bytes
  maxInstructions?: number;  // default 50_000
  maxDivergences?: number;   // stop logging after N (default 8)
}

export function runDriveRomEquivWalk(opts: EquivWalkOpts = {}): EquivWalkResult {
  const max = opts.maxInstructions ?? 50_000;
  const cap = opts.maxDivergences ?? 8;
  const busL = new DriveBus({ romBytes: opts.romBytes });
  const busM = new DriveBus({ romBytes: opts.romBytes });
  const cpuL = new Cpu6510(busL);
  const cpuM = new Cpu65xxVice({ memBus: busM });
  cpuL.reset();
  cpuM.reset();

  const divergences: EquivDivergence[] = [];
  const opcodesVisited = new Set<number>();
  const cycleDeltaCounts = new Map<number, number>();
  let steps = 0;

  for (let i = 0; i < max; i++) {
    const pc = cpuL.pc;
    const opcode = busL.read(pc);
    opcodesVisited.add(opcode);
    const cycL0 = cpuL.cycles;
    const cycM0 = cpuM.cycles;
    runOneInstrLegacy(cpuL, busL);
    runOneInstrMicro(cpuM, busM);
    steps++;
    const sL = snap(cpuL);
    const sM = snap(cpuM);
    const diffs = diffStates(sL, sM);
    const dL = cpuL.cycles - cycL0;
    const dM = cpuM.cycles - cycM0;
    if (dL !== dM) cycleDeltaCounts.set(opcode, (cycleDeltaCounts.get(opcode) ?? 0) + 1);
    if (diffs.length > 0) {
      if (divergences.length < cap) {
        divergences.push({ step: i, pc, opcode, legacy: sL, micro: sM, diffs });
      }
      // Stop walking on first divergence — state has split, further
      // comparisons are noise.
      if (divergences.length >= 1) break;
    }
  }

  return {
    steps,
    divergences,
    opcodesVisited,
    finalCyclesLegacy: cpuL.cycles,
    finalCyclesMicro:  cpuM.cycles,
    cycleDeltaByOpcode: cycleDeltaCounts,
  };
}

// -------- M3.1b: SO pin test --------

export interface SoPinResult {
  vBefore: boolean;
  vAfter: boolean;
  branchTaken: boolean;
}

// Drive ROM polls V flag for byte-ready (BVC $XX wait loop). Real 6502
// has SO pin that latches V=1. Microcoded core mirrors this via
// `cpu.flags |= 0x40` from trackBuffer.onByteReady. This test wires a
// minimal program: BVS +2 ; LDA #$00 ; LDA #$01 ; BRK
// With V cleared, BVS not taken → A = $00 ; BRK.
// With V pre-set,  BVS taken     → A = $01 ; BRK.
export function runSoPinTest(): SoPinResult {
  // Build a synthetic drive RAM-only program. We'll skip the ROM by
  // seeding the reset vector at a known location.
  const rom = new Uint8Array(0x4000); // 16KB blank ROM
  // Reset vector → $0200
  rom[0x4000 - 4] = 0x00; rom[0x4000 - 3] = 0x02;
  // BRK vector → $0210
  rom[0x4000 - 2] = 0x10; rom[0x4000 - 1] = 0x02;

  const program = [
    0x70, 0x02,        // BVS +2 ($0204)
    0xa9, 0x00,        // LDA #$00
    0x4c, 0x08, 0x02,  // JMP $0208
    0xa9, 0x01,        // LDA #$01    ($0204) — branch target lands here
    0xea,              // NOP          ($0207)
    0xea,              // NOP          ($0208)
    0x00,              // BRK          ($0209)
  ];
  // BVS +2 from $0202 lands at PC+2 + 2 = $0206? Recheck.
  // After fetch BVS+offset, PC = $0202. branch target = PC + signed offset.
  // We want target = $0207 (LDA #$01). offset = $0207 - $0202 = $05.
  // Fix offset.
  program[1] = 0x05;

  const bus = new DriveBus({ romBytes: rom });
  for (let i = 0; i < program.length; i++) {
    bus.ram[0x0200 + i] = program[i]!;
  }
  // Run microcoded path (the one with SO wiring).
  const cpu = new Cpu65xxVice({ memBus: bus });
  cpu.reset(0x0200);
  cpu.flags = 0x20; // V clear

  // Pre-fire SO before BVS.
  (cpu as { flags: number }).flags |= 0x40;
  const vBefore = (cpu.flags & 0x40) !== 0;

  // Run a few instructions.
  for (let i = 0; i < 6; i++) {
    cpu.executeCycle();
    while (!cpu.isAtInstructionBoundary()) cpu.executeCycle();
    if (cpu.pc === 0x0209 || cpu.pc < 0x0200 || cpu.pc > 0x0220) break;
  }

  const branchTaken = cpu.a === 0x01;
  const vAfter = (cpu.flags & 0x40) !== 0;
  return { vBefore, vAfter, branchTaken };
}

// -------- M3.1c: indexed cross-page bus access trace --------

interface TracingMemory {
  read(a: number): number;
  write(a: number, v: number): void;
  trace: { kind: "r" | "w"; addr: number; value: number }[];
}

function makeTracingRam(): TracingMemory {
  const ram = new Uint8Array(0x10000);
  const trace: { kind: "r" | "w"; addr: number; value: number }[] = [];
  return {
    read(a: number): number {
      const v = ram[a & 0xffff]!;
      trace.push({ kind: "r", addr: a & 0xffff, value: v });
      return v;
    },
    write(a: number, v: number): void {
      const vv = v & 0xff;
      ram[a & 0xffff] = vv;
      trace.push({ kind: "w", addr: a & 0xffff, value: vv });
    },
    trace,
    // helper for seed
    ...({ ram } as Record<string, unknown>),
  } as TracingMemory & { ram: Uint8Array };
}

export interface BusTraceResult {
  label: string;
  expected: string[];
  actual: string[];
  pass: boolean;
}

function fmtAccess(a: { kind: "r" | "w"; addr: number; value: number }): string {
  return `${a.kind}@$${a.addr.toString(16).padStart(4, "0")}=$${a.value.toString(16).padStart(2, "0")}`;
}

function runBusTrace(
  programAt0200: number[],
  prepRam: (ram: Uint8Array) => void,
  cyclesToTrace: number,
  expected: string[],
  label: string,
  prepCpu?: (cpu: Cpu65xxVice) => void,
): BusTraceResult {
  const mem = makeTracingRam();
  const ram = (mem as unknown as { ram: Uint8Array }).ram;
  for (let i = 0; i < programAt0200.length; i++) ram[0x0200 + i] = programAt0200[i]!;
  prepRam(ram);
  const cpu = new Cpu65xxVice({ memBus: mem });
  cpu.reset(0x0200);
  prepCpu?.(cpu);
  for (let i = 0; i < cyclesToTrace; i++) cpu.executeCycle();
  const actual = mem.trace.map(fmtAccess);
  const pass = actual.length >= expected.length && expected.every((e, i) => e === actual[i]);
  return { label, expected, actual, pass };
}

// LDA ($10),Y with ptr at $10/$11 = $00FF, Y = $01 → ea = $0100 (page cross).
// Cpu65xxVice `indy_read` pattern: fetch_opcode, fetch_zp_lo,
// fetch_ind_lo, fetch_ind_hi, read_ea_pgy. On page cross, read_ea_pgy
// emits VICE's "unfixed" dummy read at (base.hi | ea.lo) = $0000 BEFORE
// the final read at $0100 — matches VICE 1:1 (Sprint 113 Phase 2). The
// previous Cpu6510Cycled omitted this dummy read; the trace expectation
// now pins the VICE-faithful behavior.
export function runIndyCrossPageBusTrace(): BusTraceResult {
  const expected = [
    "r@$0200=$b1",
    "r@$0201=$10",
    "r@$0010=$ff",
    "r@$0011=$00",
    "r@$0000=$00", // VICE unfixed dummy read on page cross
    "r@$0100=$42",
  ];
  return runBusTrace(
    [0xb1, 0x10],          // LDA ($10),Y
    (ram) => {
      ram[0x10] = 0xff; ram[0x11] = 0x00;
      ram[0x0100] = 0x42;
    },
    6,
    expected,
    "LDA (\$10),Y page-cross",
    (cpu) => { cpu.y = 0x01; },
  );
}

// -------- M3.1d: stack ops bus access traces --------

// PHA bus accesses (3 cycles):
//   1. fetch opcode    ($0200 = $48)
//   2. dummy read      ($0201 — internal cycle reads next byte)
//   3. push to stack   (write to $01FF = A)
// (Note: 6502 internal-cycle behavior varies; tracing here records what
//  the microcoded core actually does — locking in current behavior.)
export function runPhaBusTrace(): BusTraceResult {
  // Initialize A by running LDA #$77 first; trace only PHA part.
  // Simpler: seed A via cpu after reset.
  const mem = makeTracingRam();
  const ram = (mem as unknown as { ram: Uint8Array }).ram;
  ram[0x0200] = 0x48; // PHA
  ram[0x0201] = 0xea; // NOP follow-up
  const cpu = new Cpu65xxVice({ memBus: mem });
  cpu.reset(0x0200);
  cpu.a = 0x77;
  cpu.sp = 0xff;
  for (let i = 0; i < 3; i++) cpu.executeCycle();
  const actual = mem.trace.map(fmtAccess);
  // Just assert: opcode fetched, push of $77 happened to $01ff.
  const sawOpcode = actual[0] === "r@$0200=$48";
  const sawPush   = actual.some((s) => s === "w@$01ff=$77");
  const pass = sawOpcode && sawPush;
  return {
    label: "PHA",
    expected: ["r@$0200=$48", "...", "w@$01ff=$77"],
    actual,
    pass,
  };
}

// JSR $1234 bus accesses (6 cycles):
//   1. fetch opcode      ($0200 = $20)
//   2. fetch lo          ($0201 = $34)
//   3. internal/dummy    (varies)
//   4. push pch          (write to $01ff = $02)
//   5. push pcl          (write to $01fe = $02)  — return = $0202 (last byte of JSR)
//   6. fetch hi          ($0202 = $12)
export function runJsrBusTrace(): BusTraceResult {
  const mem = makeTracingRam();
  const ram = (mem as unknown as { ram: Uint8Array }).ram;
  ram[0x0200] = 0x20; ram[0x0201] = 0x34; ram[0x0202] = 0x12;
  ram[0x1234] = 0xea; // NOP at target
  const cpu = new Cpu65xxVice({ memBus: mem });
  cpu.reset(0x0200);
  cpu.sp = 0xff;
  for (let i = 0; i < 6; i++) cpu.executeCycle();
  const actual = mem.trace.map(fmtAccess);
  const sawOpcode = actual[0] === "r@$0200=$20";
  const sawLo     = actual.some((s) => s === "r@$0201=$34");
  const sawPushHi = actual.some((s) => s === "w@$01ff=$02");
  const sawPushLo = actual.some((s) => s === "w@$01fe=$02");
  const sawHi     = actual.some((s) => s === "r@$0202=$12");
  const finalPc   = cpu.pc === 0x1234;
  const finalSp   = cpu.sp === 0xfd;
  const pass = sawOpcode && sawLo && sawPushHi && sawPushLo && sawHi && finalPc && finalSp;
  return {
    label: "JSR \$1234",
    expected: [
      "r@$0200=$20",
      "r@$0201=$34",
      "w@$01ff=$02",
      "w@$01fe=$02",
      "r@$0202=$12",
      `final pc=$1234 sp=$fd`,
    ],
    actual: [...actual, `final pc=$${cpu.pc.toString(16)} sp=$${cpu.sp.toString(16)}`],
    pass,
  };
}

// RTS bus accesses (6 cycles): pulls PCL+PCH from stack, increments PC.
export function runRtsBusTrace(): BusTraceResult {
  const mem = makeTracingRam();
  const ram = (mem as unknown as { ram: Uint8Array }).ram;
  ram[0x0200] = 0x60; // RTS
  ram[0x01fe] = 0x33; // pcl-1
  ram[0x01ff] = 0x12; // pch
  const cpu = new Cpu65xxVice({ memBus: mem });
  cpu.reset(0x0200);
  cpu.sp = 0xfd; // about to pop two
  for (let i = 0; i < 6; i++) cpu.executeCycle();
  const actual = mem.trace.map(fmtAccess);
  const finalPc = cpu.pc === 0x1234;
  const finalSp = cpu.sp === 0xff;
  const pass = finalPc && finalSp && actual[0] === "r@$0200=$60";
  return {
    label: "RTS",
    expected: ["r@$0200=$60", "...", "final pc=$1234 sp=$ff"],
    actual: [...actual, `final pc=$${cpu.pc.toString(16)} sp=$${cpu.sp.toString(16)}`],
    pass,
  };
}

// -------- M3.1e: opcode coverage from equiv walk --------

export interface OpcodeCoverage {
  visited: number;
  documented: number;
  undocumented: number;
  unimplementedVisited: number[];
  visitedList: number[];
}

export function summarizeOpcodeCoverage(opcodesVisited: Set<number>): OpcodeCoverage {
  let documented = 0;
  let undocumented = 0;
  const unimpl: number[] = [];
  for (const oc of opcodesVisited) {
    if (OPCODE_TABLE[oc]) { documented++; continue; }
    if (UNDOC_TABLE[oc])  { undocumented++; continue; }
    unimpl.push(oc);
  }
  return {
    visited: opcodesVisited.size,
    documented,
    undocumented,
    unimplementedVisited: unimpl,
    visitedList: [...opcodesVisited].sort((a, b) => a - b),
  };
}
