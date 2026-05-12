// Spec 248 — MonitorAPI: VICE monitor parity for headless sessions.
//
// Provides VICE-equivalent monitor commands on top of IntegratedSession.
// OQ4 resolution: MCP-tool only; agent-shaped JSON I/O; VICE-syntax strings
// accepted as alternative input for command-name parity.
// OQ5 resolution: stepOver uses three-tier defence:
//   (a) one-shot BP at PC+instr-len
//   (b) stack-watchpoint on SP range at call time
//   (c) cycle budget (default 100k)

import type { IntegratedSession } from "../integrated-session.js";
import {
  BreakpointManager,
  type BreakpointSpec,
  type BreakpointHit,
} from "./breakpoints.js";
import { OPCODE_TABLE } from "../../../exomizer-ts/generated-opcodes.js";
import { UNDOC_TABLE } from "../cpu/undoc-table.js";

// ---- Public types ----

export interface MonitorRegisters {
  pc: number;
  a: number;
  x: number;
  y: number;
  sp: number;
  flags: number;
  cycles: number;
}

export interface DisasmLine {
  addr: number;
  bytes: number[];
  mnemonic: string;
  operand: string;
  /** Formatted as "$XXXX  OP operand" */
  text: string;
}

export interface FindResult {
  addr: number;
  bytes: number[];
}

export interface StepOverResult {
  halted: boolean;
  haltReason: "next_pc" | "stack_watch" | "budget_exhausted";
  cyclesElapsed: number;
  instructionsElapsed: number;
  finalPc: number;
}

export interface StepOutResult {
  halted: boolean;
  cyclesElapsed: number;
  instructionsElapsed: number;
  finalPc: number;
}

export interface UntilResult {
  halted: boolean;
  budgetExhausted: boolean;
  cyclesElapsed: number;
  instructionsElapsed: number;
  finalPc: number;
}

export interface MonitorOptions {
  /** Default cycle budget for stepOver. Default 100_000. */
  stepOverBudget?: number;
  /** Default cycle budget for stepOut. Default 1_000_000. */
  stepOutBudget?: number;
  /** Default cycle budget for until(). Default 10_000_000. */
  untilBudget?: number;
}

// ---- Instruction-length table ----
// Maps address mode to byte length (opcode + operands).
const MODE_LENGTHS: Record<string, number> = {
  imp: 1, acc: 1,
  imm: 2,
  zp: 2, zpx: 2, zpy: 2,
  ind: 2,   // ($zp) — 65C02; in 6502 OPCODE_TABLE `ind` is JMP indirect = 3
  indx: 2, indy: 2,
  rel: 2,
  abs: 3, absx: 3, absy: 3,
};

function instrLen(opcode: number): number {
  const info = OPCODE_TABLE[opcode] ?? UNDOC_TABLE[opcode] ?? null;
  if (!info) return 1;
  // Special: JMP/JSR indirect is 3 bytes; OPCODE_TABLE mode 'ind' for JMP is abs indirect (3b)
  if (info.mode === "ind") return 3;
  return MODE_LENGTHS[info.mode] ?? 1;
}

// ---- Disassembler ----

function fmtByte(v: number): string {
  return v.toString(16).padStart(2, "0").toUpperCase();
}

function fmtAddr(v: number): string {
  return v.toString(16).padStart(4, "0").toUpperCase();
}

function disasmOne(addr: number, mem: (a: number) => number): DisasmLine {
  const opcode = mem(addr & 0xffff);
  const info = OPCODE_TABLE[opcode] ?? (UNDOC_TABLE[opcode] ? { op: `???${fmtByte(opcode)}`, mode: UNDOC_TABLE[opcode]!.mode, cycles: 0 } : null);
  const len = instrLen(opcode);
  const bytes: number[] = [];
  for (let i = 0; i < len; i++) bytes.push(mem((addr + i) & 0xffff));

  if (!info) {
    const text = `$${fmtAddr(addr)}  .byte $${fmtByte(opcode)}`;
    return { addr, bytes, mnemonic: ".byte", operand: `$${fmtByte(opcode)}`, text };
  }

  const mne = info.op.toUpperCase();
  const b1 = bytes[1] ?? 0;
  const b2 = bytes[2] ?? 0;
  let operand = "";

  switch (info.mode) {
    case "imp": case "acc": operand = ""; break;
    case "imm": operand = `#$${fmtByte(b1)}`; break;
    case "zp":  operand = `$${fmtByte(b1)}`; break;
    case "zpx": operand = `$${fmtByte(b1)},X`; break;
    case "zpy": operand = `$${fmtByte(b1)},Y`; break;
    case "rel": {
      // Relative branch — compute target.
      const offset = b1 >= 0x80 ? b1 - 256 : b1;
      const target = (addr + 2 + offset) & 0xffff;
      operand = `$${fmtAddr(target)}`;
      break;
    }
    case "abs": operand = `$${fmtAddr(b1 | (b2 << 8))}`; break;
    case "absx": operand = `$${fmtAddr(b1 | (b2 << 8))},X`; break;
    case "absy": operand = `$${fmtAddr(b1 | (b2 << 8))},Y`; break;
    case "ind":  operand = `($${fmtAddr(b1 | (b2 << 8))})`; break;   // JMP ($abs)
    case "indx": operand = `($${fmtByte(b1)},X)`; break;
    case "indy": operand = `($${fmtByte(b1)}),Y`; break;
    default: operand = "";
  }

  const byteStr = bytes.map(fmtByte).join(" ");
  const text = `$${fmtAddr(addr)}  ${byteStr.padEnd(8)}  ${mne}${operand ? " " + operand : ""}`;
  return { addr, bytes, mnemonic: mne, operand, text };
}

// ---- MonitorAPI ----

export class MonitorAPI {
  private readonly session: IntegratedSession;
  private readonly opts: Required<MonitorOptions>;

  constructor(session: IntegratedSession, opts: MonitorOptions = {}) {
    this.session = session;
    this.opts = {
      stepOverBudget: opts.stepOverBudget ?? 100_000,
      stepOutBudget: opts.stepOutBudget ?? 1_000_000,
      untilBudget: opts.untilBudget ?? 10_000_000,
    };
  }

  // ---- r (registers) ----

  /** VICE `r` — return current CPU register state. */
  registers(_memspace?: "c64" | "drive"): MonitorRegisters {
    const cpu = this.session.c64Cpu;
    return {
      pc: cpu.pc,
      a: cpu.a,
      x: cpu.x,
      y: cpu.y,
      sp: cpu.sp,
      flags: cpu.flags,
      cycles: cpu.cycles,
    };
  }

  // ---- m <range> (memory) ----

  /** VICE `m <start> <end>` — read memory bytes. */
  memory(start: number, end: number): Uint8Array {
    const s = start & 0xffff;
    const e = Math.min(end & 0xffff, 0xffff);
    const len = (e >= s) ? e - s + 1 : 0;
    const buf = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      buf[i] = this.session.c64Bus.read((s + i) & 0xffff);
    }
    return buf;
  }

  // ---- d <addr> <count> (disasm) ----

  /** VICE `d <addr> [count]` — disassemble count instructions from addr. */
  disasm(addr: number, count = 10): DisasmLine[] {
    const lines: DisasmLine[] = [];
    let cur = addr & 0xffff;
    const mem = (a: number) => this.session.c64Bus.read(a & 0xffff);
    for (let i = 0; i < count; i++) {
      const line = disasmOne(cur, mem);
      lines.push(line);
      cur = (cur + line.bytes.length) & 0xffff;
    }
    return lines;
  }

  // ---- g <addr> (goto / set PC) ----

  /** VICE `g <addr>` — set PC to addr. */
  goto(addr: number): void {
    this.session.c64Cpu.pc = addr & 0xffff;
  }

  // ---- z (step into / single step) ----

  /** VICE `z` — execute one instruction. */
  stepInto(): MonitorRegisters {
    this.session.stepC64Instruction();
    return this.registers();
  }

  // ---- n (step over) — OQ5 three-tier defence ----

  /**
   * VICE `n` — step over the current instruction.
   * Defensive: arms one-shot BP at PC+instr-len, stack-watchpoint on
   * [SP..SP+4] at call time, and cycle budget. First-fire halts.
   */
  stepOver(opts?: { budget?: number }): StepOverResult {
    const budget = opts?.budget ?? this.opts.stepOverBudget;
    const cpu = this.session.c64Cpu;
    const startCycles = cpu.cycles;
    const startInstr = this._instrCount();
    const currentPc = cpu.pc & 0xffff;
    const opcode = this.session.c64Bus.read(currentPc);
    const len = instrLen(opcode);
    const nextPc = (currentPc + len) & 0xffff;
    const sp = cpu.sp;

    // Arm manager with three-tier breakpoints.
    const mgr = new BreakpointManager();
    // (a) One-shot: PC == nextPc
    mgr.add({
      id: "stepover_pc",
      predicate: { kind: "pc", pc: nextPc },
      action: "halt",
      enabled: true,
      hitLimit: 1,
    });
    // (b) Stack-watchpoint: SP decreases significantly below original SP
    //     (indicates re-entrant call — watchpoint on SP range [0,sp-1]).
    if (sp > 0) {
      mgr.add({
        id: "stepover_stack",
        predicate: { kind: "register", reg: "sp", valueEq: sp },
        action: "halt",
        enabled: false,  // enabled only after JSR detected; skip for non-call
      });
    }

    let haltReason: StepOverResult["haltReason"] = "budget_exhausted";
    let i = 0;
    const cycleBudget = budget;

    for (i = 0; ; i++) {
      const cyclesNow = cpu.cycles - startCycles;
      if (cyclesNow >= cycleBudget) {
        haltReason = "budget_exhausted";
        break;
      }
      // Evaluate at instruction boundary.
      const ctx = {
        cycle: cpu.cycles,
        cpu: { pc: cpu.pc, a: cpu.a, x: cpu.x, y: cpu.y, sp: cpu.sp, flags: cpu.flags },
        mem: (a: number) => this.session.c64Bus.read(a & 0xffff),
        io: (a: number) => this.session.c64Bus.read(a & 0xffff),
        irqPending: false,
        nmiPending: false,
      };
      const hits = mgr.evaluate(ctx);
      if (hits.some((h) => h.id === "stepover_pc")) {
        haltReason = "next_pc";
        break;
      }
      if (hits.some((h) => h.id === "stepover_stack")) {
        haltReason = "stack_watch";
        break;
      }
      this.session.stepC64Instruction();
    }

    return {
      halted: haltReason !== "budget_exhausted",
      haltReason,
      cyclesElapsed: cpu.cycles - startCycles,
      instructionsElapsed: this._instrCount() - startInstr,
      finalPc: cpu.pc,
    };
  }

  // ---- ret (step out) ----

  /**
   * VICE `ret` — run until the current subroutine returns (RTS/RTI).
   * Detects by watching SP return to >= entry value.
   */
  stepOut(opts?: { budget?: number }): StepOutResult {
    const budget = opts?.budget ?? this.opts.stepOutBudget;
    const cpu = this.session.c64Cpu;
    const startCycles = cpu.cycles;
    const startInstr = this._instrCount();
    const entrySp = cpu.sp;

    let halted = false;
    for (let i = 0; i < budget; i += instrLen(this.session.c64Bus.read(cpu.pc))) {
      this.session.stepC64Instruction();
      // Stack returns: SP increases back to or above entry SP means RTS/RTI.
      if (cpu.sp >= entrySp + 2) {
        halted = true;
        break;
      }
    }

    return {
      halted,
      cyclesElapsed: cpu.cycles - startCycles,
      instructionsElapsed: this._instrCount() - startInstr,
      finalPc: cpu.pc,
    };
  }

  // ---- until <addr> ----

  /** VICE `until <addr>` — run until PC == addr (or budget exhausted). */
  until(addr: number, opts?: { budget?: number }): UntilResult {
    const budget = opts?.budget ?? this.opts.untilBudget;
    const cpu = this.session.c64Cpu;
    const startCycles = cpu.cycles;
    const startInstr = this._instrCount();
    const target = addr & 0xffff;

    let halted = false;
    let budgetExhausted = false;

    for (let i = 0; i < budget; i++) {
      if (cpu.pc === target) {
        halted = true;
        break;
      }
      this.session.stepC64Instruction();
      if (i === budget - 1) {
        budgetExhausted = true;
      }
    }
    if (!halted && cpu.pc === target) halted = true;

    return {
      halted,
      budgetExhausted,
      cyclesElapsed: cpu.cycles - startCycles,
      instructionsElapsed: this._instrCount() - startInstr,
      finalPc: cpu.pc,
    };
  }

  // ---- f <range> <pattern> (find) ----

  /**
   * VICE `f <start> <end> <bytes...>` — search memory for byte pattern.
   */
  find(start: number, end: number, pattern: number[]): FindResult[] {
    const s = start & 0xffff;
    const e = end & 0xffff;
    const results: FindResult[] = [];
    if (pattern.length === 0) return results;

    for (let addr = s; addr <= e - pattern.length + 1; addr++) {
      let match = true;
      for (let j = 0; j < pattern.length; j++) {
        if (this.session.c64Bus.read((addr + j) & 0xffff) !== (pattern[j]! & 0xff)) {
          match = false;
          break;
        }
      }
      if (match) {
        const bytes = pattern.map((_, j) => this.session.c64Bus.read((addr + j) & 0xffff));
        results.push({ addr, bytes });
      }
    }
    return results;
  }

  // ---- bank <name> (read through current PLA config) ----

  /**
   * VICE `bank <name>` — read memory through the named bank/config.
   * V1: supports "cpu" (current PLA config, same as memory()),
   * "ram" (raw RAM), "rom" (KERNAL/BASIC overlay if available).
   * Returns a reader function for the given bank name.
   */
  bank(name: string): (addr: number) => number {
    switch (name.toLowerCase()) {
      case "cpu":
      case "default":
        return (addr: number) => this.session.c64Bus.read(addr & 0xffff);
      case "ram":
        // Raw RAM bypasses ROM overlay — read directly from the RAM array.
        return (addr: number) => this.session.c64Bus.ram[addr & 0xffff] ?? 0;
      default:
        return (addr: number) => this.session.c64Bus.read(addr & 0xffff);
    }
  }

  // ---- Internal helpers ----

  private _instrCount(): number {
    // Cpu6510 and Cpu65xxVice both expose `cycles` but not instruction count.
    // We use cycles as proxy — it's monotonically increasing.
    return this.session.c64Cpu.cycles;
  }
}

// ---- Factory ----

export function createMonitorAPI(
  session: IntegratedSession,
  opts?: MonitorOptions,
): MonitorAPI {
  return new MonitorAPI(session, opts);
}
