// Spec 099 (M1.2) — Unified stepping primitives.
//
// Wraps IntegratedSession's runFor() with named primitives that
// match how agents and tools actually want to step.
//
// All primitives return a StepResult: { exitReason, cyclesElapsed,
// instructionsElapsed, hit?: <primitive-specific data> }. exitReason
// is one of "hit" (the wait condition was satisfied), "budget" (the
// cycle/instruction budget ran out without hitting), or "error"
// (irrecoverable runtime fault).

import type { IntegratedSession } from "./integrated-session.js";

export type StepExitReason = "hit" | "budget" | "error";

export interface StepResult<H = unknown> {
  exitReason: StepExitReason;
  cyclesElapsed: number;
  instructionsElapsed: number;
  hit?: H;
  error?: string;
}

const DEFAULT_BUDGET_INSTR = 10_000_000;
const DEFAULT_BUDGET_CYCLES = 50_000_000;

// Step a fixed number of C64 cycles. Drive co-steps via the
// scheduler. Always rounds UP to the next instruction boundary —
// real CPUs don't stop mid-instruction.
export function stepCycles(
  session: IntegratedSession,
  cycles: number,
): StepResult {
  const startCyc = session.c64Cpu.cycles;
  const startInstr = readInstructionCount(session);
  const target = startCyc + cycles;
  let exitReason: StepExitReason = "budget";
  while (session.c64Cpu.cycles < target) {
    const r = session.runFor(1);
    if (r.aborted === "cycle-budget") break;
    if (r.instructionsExecuted === 0) {
      exitReason = "error";
      break;
    }
  }
  if (session.c64Cpu.cycles >= target) exitReason = "hit";
  return {
    exitReason,
    cyclesElapsed: session.c64Cpu.cycles - startCyc,
    instructionsElapsed: readInstructionCount(session) - startInstr,
  };
}

// Step a fixed number of C64 instructions.
export function stepInstructions(
  session: IntegratedSession,
  count: number,
): StepResult {
  const startCyc = session.c64Cpu.cycles;
  const startInstr = readInstructionCount(session);
  const r = session.runFor(count);
  return {
    exitReason: r.instructionsExecuted >= count ? "hit" : "budget",
    cyclesElapsed: session.c64Cpu.cycles - startCyc,
    instructionsElapsed: r.instructionsExecuted,
  };
}

export interface RunUntilPcOptions {
  side?: "c64" | "drive";
  budget?: number; // C64 instructions
  count?: number;  // hits to wait for (default 1)
}

// Run until PC matches target the requested number of times. The
// "drive" side polls drive.cpu.pc after each c64 instruction.
export function runUntilPc(
  session: IntegratedSession,
  pc: number,
  opts: RunUntilPcOptions = {},
): StepResult<{ pc: number; hits: number }> {
  const side = opts.side ?? "c64";
  const target = pc & 0xffff;
  const wantCount = opts.count ?? 1;
  const budget = opts.budget ?? DEFAULT_BUDGET_INSTR;
  const startCyc = session.c64Cpu.cycles;
  const startInstr = readInstructionCount(session);
  let hits = 0;
  let lastPc = -1;
  for (let i = 0; i < budget; i++) {
    const cur = side === "c64" ? session.c64Cpu.pc : session.drive.cpu.pc;
    if (cur === target && lastPc !== target) {
      hits++;
      if (hits >= wantCount) {
        return {
          exitReason: "hit",
          cyclesElapsed: session.c64Cpu.cycles - startCyc,
          instructionsElapsed: readInstructionCount(session) - startInstr,
          hit: { pc: cur, hits },
        };
      }
    }
    lastPc = cur;
    session.runFor(1);
  }
  return {
    exitReason: "budget",
    cyclesElapsed: session.c64Cpu.cycles - startCyc,
    instructionsElapsed: readInstructionCount(session) - startInstr,
    hit: { pc: -1, hits },
  };
}

// Run until VIC raster line equals (line). Polls VIC raster register
// after each c64 instruction. Stops on the rising-edge of equality
// (so consecutive instructions in the same line don't re-fire).
export function runUntilRaster(
  session: IntegratedSession,
  line: number,
  budget = DEFAULT_BUDGET_INSTR,
): StepResult<{ raster: number }> {
  const startCyc = session.c64Cpu.cycles;
  const startInstr = readInstructionCount(session);
  const vic = session.vic as { rasterLine?: number };
  let prevRaster = vic.rasterLine ?? -1;
  for (let i = 0; i < budget; i++) {
    session.runFor(1);
    const cur = vic.rasterLine ?? -1;
    if (cur === line && prevRaster !== line) {
      return {
        exitReason: "hit",
        cyclesElapsed: session.c64Cpu.cycles - startCyc,
        instructionsElapsed: readInstructionCount(session) - startInstr,
        hit: { raster: cur },
      };
    }
    prevRaster = cur;
  }
  return {
    exitReason: "budget",
    cyclesElapsed: session.c64Cpu.cycles - startCyc,
    instructionsElapsed: readInstructionCount(session) - startInstr,
    hit: { raster: prevRaster },
  };
}

export type IecEdge =
  | "atn-fall" | "atn-rise"
  | "clk-fall" | "clk-rise"
  | "data-fall" | "data-rise";

// Run until a specific IEC line edge fires. "fall" = released → pulled
// (line going LOW). "rise" = pulled → released (line going HIGH).
export function runUntilIecEvent(
  session: IntegratedSession,
  edge: IecEdge,
  budget = DEFAULT_BUDGET_INSTR,
): StepResult<{ edge: IecEdge }> {
  const startCyc = session.c64Cpu.cycles;
  const startInstr = readInstructionCount(session);
  const sample = () => {
    const s = session.iecBus.snapshot();
    return { atn: s.line.atn, clk: s.line.clk, data: s.line.data };
  };
  let prev = sample();
  for (let i = 0; i < budget; i++) {
    session.runFor(1);
    const cur = sample();
    if (matchesEdge(edge, prev, cur)) {
      return {
        exitReason: "hit",
        cyclesElapsed: session.c64Cpu.cycles - startCyc,
        instructionsElapsed: readInstructionCount(session) - startInstr,
        hit: { edge },
      };
    }
    prev = cur;
  }
  return {
    exitReason: "budget",
    cyclesElapsed: session.c64Cpu.cycles - startCyc,
    instructionsElapsed: readInstructionCount(session) - startInstr,
  };
}

interface IecLevels { atn: boolean; clk: boolean; data: boolean }
function matchesEdge(edge: IecEdge, prev: IecLevels, cur: IecLevels): boolean {
  // "fall" = released (true) → pulled (false). "rise" = false → true.
  switch (edge) {
    case "atn-fall":  return prev.atn  && !cur.atn;
    case "atn-rise":  return !prev.atn && cur.atn;
    case "clk-fall":  return prev.clk  && !cur.clk;
    case "clk-rise":  return !prev.clk && cur.clk;
    case "data-fall": return prev.data && !cur.data;
    case "data-rise": return !prev.data && cur.data;
  }
}

export interface RunUntilStableScreenOptions {
  framesStable?: number; // default 3
  budgetCycles?: number; // default 50M
}

// Run until screen RAM ($0400-$07E7) has been unchanged for N
// consecutive frames. Frame boundary = raster line 0 rising edge.
// Useful for "wait for title screen to settle".
export function runUntilStableScreen(
  session: IntegratedSession,
  opts: RunUntilStableScreenOptions = {},
): StepResult<{ stableFrames: number }> {
  const wantStable = opts.framesStable ?? 3;
  const budgetCycles = opts.budgetCycles ?? DEFAULT_BUDGET_CYCLES;
  const startCyc = session.c64Cpu.cycles;
  const startInstr = readInstructionCount(session);
  const vic = session.vic as { rasterLine?: number };
  const ram = session.c64Bus.ram;
  let prevRaster = vic.rasterLine ?? -1;
  let prevSnapshot = snapshotScreen(ram);
  let stableFrames = 0;
  while (session.c64Cpu.cycles - startCyc < budgetCycles) {
    session.runFor(1);
    const cur = vic.rasterLine ?? -1;
    if (cur === 0 && prevRaster !== 0) {
      // Frame boundary.
      const curSnap = snapshotScreen(ram);
      if (buffersEqual(curSnap, prevSnapshot)) {
        stableFrames++;
        if (stableFrames >= wantStable) {
          return {
            exitReason: "hit",
            cyclesElapsed: session.c64Cpu.cycles - startCyc,
            instructionsElapsed: readInstructionCount(session) - startInstr,
            hit: { stableFrames },
          };
        }
      } else {
        stableFrames = 0;
      }
      prevSnapshot = curSnap;
    }
    prevRaster = cur;
  }
  return {
    exitReason: "budget",
    cyclesElapsed: session.c64Cpu.cycles - startCyc,
    instructionsElapsed: readInstructionCount(session) - startInstr,
    hit: { stableFrames },
  };
}

function snapshotScreen(ram: Uint8Array): Uint8Array {
  return ram.slice(0x0400, 0x07e8);
}

function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function readInstructionCount(session: IntegratedSession): number {
  // session.status() returns an instructions counter on c64.
  return session.status().c64.instructions;
}
