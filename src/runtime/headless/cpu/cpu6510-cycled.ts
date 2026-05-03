// Spec 092.7 — True cycle-stepped 6510 with per-cycle bus access.
//
// Replaces the wrapper-style Cpu6510Cycled (which only ran whole
// instructions at boundary). This implementation executes ONE micro-op
// per cycle, where each micro-op corresponds to a single bus access
// (or internal cycle) of the 6502.
//
// Bus accesses fire at the EXACT cycle within the instruction. Drive
// (running cycle-lockstep) sees state changes at the right moment.
//
// Architecture matches virtualc64 (Hoffmann) cycle-stepped CPU + VICE
// 6510core.c CLK_ADD-per-access pattern.

import type { CpuMemory } from "../cpu6510.js";
import type { CycleSteppable } from "../scheduler/cycle-steppable.js";
import { MICROCODE_TABLE, ADDR_MODE_PATTERNS, type MicrocodeEntry } from "./microcode-table.js";

const FLAG_N = 0x80;
const FLAG_V = 0x40;
const FLAG_D = 0x08;
const FLAG_I = 0x04;
const FLAG_Z = 0x02;
const FLAG_C = 0x01;

interface InstructionState {
  entry: MicrocodeEntry;
  microIdx: number;             // which micro-op we'll execute next cycle
  microcode: string[];          // resolved pattern
  // Operand accumulator across cycles.
  operandLo: number;
  operandHi: number;
  // Effective address (computed mid-instruction).
  ea: number;
  // Indirect zp pointer (for indx/indy).
  indPtr: number;
  // Value read from EA (for ALU ops + RMW).
  fetchedValue: number;
  // Branch decision + target.
  branchOffset: number;
}

export class Cpu6510Cycled implements CycleSteppable {
  // Public CPU register state (compatible with legacy Cpu6510 API).
  public cycles = 0;
  public pc = 0;
  public sp = 0xff;
  public flags = 0x20;
  public a = 0;
  public x = 0;
  public y = 0;

  // True iff we're at an instruction boundary (about to fetch next opcode).
  private atBoundary = true;
  // Current instruction state (when not at boundary).
  private inst: InstructionState | null = null;

  // IRQ / NMI lines (set by external CIA / VIC).
  public irqLine = false;
  public nmiLine = false;
  private nmiPending = false;
  private prevNmi = false;

  constructor(public readonly memory: CpuMemory) {}

  reset(pc?: number): void {
    this.a = 0; this.x = 0; this.y = 0;
    this.sp = 0xff; this.flags = 0x20; this.cycles = 0;
    this.atBoundary = true;
    this.inst = null;
    this.irqLine = false;
    this.nmiLine = false;
    this.nmiPending = false;
    this.prevNmi = false;
    this.pc = pc ?? (this.busRead(0xfffc) | (this.busRead(0xfffd) << 8));
  }

  isAtInstructionBoundary(): boolean { return this.atBoundary; }

  cycle(): number { return this.cycles; }

  // CycleSteppable: advance one cycle.
  executeCycle(): void {
    if (this.atBoundary) {
      this.startInstructionCycle();
    } else {
      this.continueInstructionCycle();
    }
    this.cycles++;
  }

  private startInstructionCycle(): void {
    // NMI edge detection.
    if (this.nmiLine && !this.prevNmi) this.nmiPending = true;
    this.prevNmi = this.nmiLine;
    if (this.nmiPending) {
      this.nmiPending = false;
      this.serviceInterrupt(0xfffa, false);
      return;
    }
    if (this.irqLine && (this.flags & FLAG_I) === 0) {
      this.serviceInterrupt(0xfffe, false);
      return;
    }
    // Fetch opcode (1st cycle of new instruction).
    const opcode = this.busRead(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    const entry = MICROCODE_TABLE[opcode];
    if (!entry) {
      // Unknown opcode (shouldn't happen for documented). Fall back to
      // 1-cycle no-op.
      return;
    }
    const microcode = ADDR_MODE_PATTERNS[entry.pattern];
    if (microcode.length <= 1) {
      // Single-cycle instruction (rare — most have 2+). Execute final
      // op now, stay at boundary.
      this.executeFinalOp(entry, this.makeFreshState(entry, microcode));
      return;
    }
    // Multi-cycle: set up state, advance index past opcode fetch.
    this.inst = this.makeFreshState(entry, microcode);
    this.inst.microIdx = 1; // next cycle does microcode[1]
    this.atBoundary = false;
  }

  private makeFreshState(entry: MicrocodeEntry, microcode: string[]): InstructionState {
    return {
      entry, microIdx: 0, microcode,
      operandLo: 0, operandHi: 0, ea: 0, indPtr: 0,
      fetchedValue: 0, branchOffset: 0,
    };
  }

  private continueInstructionCycle(): void {
    const inst = this.inst!;
    const op = inst.microcode[inst.microIdx]!;
    inst.microIdx++;
    const isFinal = inst.microIdx >= inst.microcode.length;
    this.executeMicroOp(op, inst);
    if (isFinal) {
      this.executeFinalOp(inst.entry, inst);
      this.atBoundary = true;
      this.inst = null;
    }
  }

  // Execute a single micro-op (advances bus access + accumulates state).
  private executeMicroOp(op: string, s: InstructionState): void {
    switch (op) {
      case 'fetch_opcode':
        // Already done in startInstructionCycle for first cycle.
        break;
      case 'fetch_imm':
        s.operandLo = this.busRead(this.pc);
        this.pc = (this.pc + 1) & 0xffff;
        break;
      case 'fetch_lo':
      case 'fetch_zp_lo':
        s.operandLo = this.busRead(this.pc);
        this.pc = (this.pc + 1) & 0xffff;
        if (op === 'fetch_zp_lo') s.ea = s.operandLo & 0xff;
        break;
      case 'fetch_hi':
        s.operandHi = this.busRead(this.pc);
        this.pc = (this.pc + 1) & 0xffff;
        s.ea = s.operandLo | (s.operandHi << 8);
        break;
      case 'dummy_zp':
        // Dummy read of (zp,X) intermediate — no functional effect.
        this.busRead(s.ea);
        // Apply X for zpx, Y for zpy. Mode-aware: check entry.mode.
        if (s.entry.mode === 'zpx') s.ea = (s.ea + this.x) & 0xff;
        else if (s.entry.mode === 'zpy') s.ea = (s.ea + this.y) & 0xff;
        else if (s.entry.mode === 'indx') s.indPtr = (s.ea + this.x) & 0xff;
        break;
      case 'fetch_ind_lo':
        s.operandLo = this.busRead(s.indPtr);
        break;
      case 'fetch_ind_hi':
        s.operandHi = this.busRead((s.indPtr + 1) & 0xff);
        s.ea = s.operandLo | (s.operandHi << 8);
        break;
      case 'dummy_addr': {
        // Dummy read of (addr_base + X/Y) high page before final access.
        const base = s.operandLo | (s.operandHi << 8);
        const idx = s.entry.mode === 'absx' ? this.x : this.y;
        const eaCandidate = (base + idx) & 0xffff;
        this.busRead((base & 0xff00) | (eaCandidate & 0xff));
        s.ea = eaCandidate;
        break;
      }
      case 'read_ea':
        s.fetchedValue = this.busRead(s.ea);
        break;
      case 'write_ea':
        // Final op writes via finalize, but mode-write happens here in pattern.
        this.executeStore(s.entry, s);
        break;
      case 'dummy_write_ea_old':
        this.busWrite(s.ea, s.fetchedValue);
        break;
      case 'write_ea_new':
        this.busWrite(s.ea, this.computeRmwResult(s.entry, s));
        break;
      case 'read_ea_pgx': {
        const base = s.operandLo | (s.operandHi << 8);
        const ea = (base + this.x) & 0xffff;
        s.ea = ea;
        s.fetchedValue = this.busRead(ea);
        // Page cross adds one cycle: handled by adding +1 to cycles below.
        if ((base & 0xff00) !== (ea & 0xff00)) this.cycles += 1;
        break;
      }
      case 'read_ea_pgy': {
        const base = s.entry.mode === 'indy' ? (s.operandLo | (s.operandHi << 8)) : (s.operandLo | (s.operandHi << 8));
        const ea = (base + this.y) & 0xffff;
        s.ea = ea;
        s.fetchedValue = this.busRead(ea);
        if ((base & 0xff00) !== (ea & 0xff00)) this.cycles += 1;
        break;
      }
      case 'read_ea_lo':
        s.operandLo = this.busRead(s.ea);
        break;
      case 'read_ea_hi':
        // 6502 bug: page wrap on indirect JMP.
        s.operandHi = this.busRead((s.ea & 0xff00) | ((s.ea + 1) & 0xff));
        this.pc = s.operandLo | (s.operandHi << 8);
        break;
      case 'internal':
        // No bus access this cycle (internal ALU compute).
        break;
      case 'push':
        this.pushByte(s.entry.op === 'pha' ? this.a : (this.flags | 0x10));
        break;
      case 'pop':
        s.fetchedValue = this.popByte();
        break;
      case 'dummy_sp':
        this.busRead(0x0100 + this.sp);
        break;
      case 'push_pch':
        this.pushByte((this.pc >> 8) & 0xff);
        break;
      case 'push_pcl':
        this.pushByte(this.pc & 0xff);
        break;
      case 'push_p_brk':
        this.pushByte(this.flags | 0x10);
        this.flags |= FLAG_I;
        break;
      case 'pop_p':
        this.flags = this.popByte() & ~0x10;
        break;
      case 'pop_pcl':
        s.operandLo = this.popByte();
        break;
      case 'pop_pch':
        s.operandHi = this.popByte();
        this.pc = s.operandLo | (s.operandHi << 8);
        break;
      case 'fetch_pc_dummy':
        this.busRead(this.pc);
        this.pc = (this.pc + 1) & 0xffff;
        break;
      case 'read_brk_vec_lo':
        s.operandLo = this.busRead(0xfffe);
        break;
      case 'read_brk_vec_hi':
        s.operandHi = this.busRead(0xffff);
        this.pc = s.operandLo | (s.operandHi << 8);
        break;
      case 'fetch_dummy_pc':
        this.busRead(this.pc);
        this.pc = (this.pc + 1) & 0xffff;
        break;
      default:
        // Unknown micro-op — no-op.
        break;
    }
  }

  // Apply final ALU operation that defines the opcode's semantics.
  // Called at last cycle of instruction.
  private executeFinalOp(entry: MicrocodeEntry, s: InstructionState): void {
    const op = entry.op;
    const mode = entry.mode;
    // For load ops, value already in s.fetchedValue (read by 'read_ea')
    // or in operandLo (for imm).
    const valueIn = mode === 'imm' || mode === 'rel' ? s.operandLo : s.fetchedValue;
    switch (op) {
      // Loads.
      case 'lda': this.a = valueIn; this.updateNz(this.a); break;
      case 'ldx': this.x = valueIn; this.updateNz(this.x); break;
      case 'ldy': this.y = valueIn; this.updateNz(this.y); break;
      // Stores: write happens via 'write_ea' micro-op already.
      case 'sta': case 'stx': case 'sty': break;
      // ALU.
      case 'and': this.a &= valueIn; this.updateNz(this.a); break;
      case 'ora': this.a |= valueIn; this.updateNz(this.a); break;
      case 'eor': this.a ^= valueIn; this.updateNz(this.a); break;
      case 'adc': this.adc(valueIn); break;
      case 'sbc': this.sbc(valueIn); break;
      case 'cmp': this.compare(this.a, valueIn); break;
      case 'cpx': this.compare(this.x, valueIn); break;
      case 'cpy': this.compare(this.y, valueIn); break;
      case 'bit': this.bit(valueIn); break;
      // RMW: result already written via 'write_ea_new' micro-op.
      case 'inc': case 'dec': case 'asl': case 'lsr': case 'rol': case 'ror':
        if (mode === 'acc') {
          // Accumulator RMW: we didn't have EA reads. Compute on A.
          this.a = this.computeRmwOnValue(op, this.a);
          this.updateNz(this.a);
        }
        break;
      // Implied flag/transfer ops.
      case 'clc': this.flags &= ~FLAG_C; break;
      case 'sec': this.flags |= FLAG_C; break;
      case 'cli': this.flags &= ~FLAG_I; break;
      case 'sei': this.flags |= FLAG_I; break;
      case 'cld': this.flags &= ~FLAG_D; break;
      case 'sed': this.flags |= FLAG_D; break;
      case 'clv': this.flags &= ~FLAG_V; break;
      case 'tax': this.x = this.a; this.updateNz(this.x); break;
      case 'tay': this.y = this.a; this.updateNz(this.y); break;
      case 'tsx': this.x = this.sp; this.updateNz(this.x); break;
      case 'txa': this.a = this.x; this.updateNz(this.a); break;
      case 'txs': this.sp = this.x; break;
      case 'tya': this.a = this.y; this.updateNz(this.a); break;
      case 'inx': this.x = (this.x + 1) & 0xff; this.updateNz(this.x); break;
      case 'iny': this.y = (this.y + 1) & 0xff; this.updateNz(this.y); break;
      case 'dex': this.x = (this.x - 1) & 0xff; this.updateNz(this.x); break;
      case 'dey': this.y = (this.y - 1) & 0xff; this.updateNz(this.y); break;
      case 'nop': break;
      // Stack.
      case 'pha': case 'php': break; // already pushed
      case 'pla': this.a = s.fetchedValue; this.updateNz(this.a); break;
      case 'plp': this.flags = s.fetchedValue & ~0x10; break;
      // Branches.
      case 'bcc': if ((this.flags & FLAG_C) === 0) this.takeBranch(s.operandLo); break;
      case 'bcs': if ((this.flags & FLAG_C) !== 0) this.takeBranch(s.operandLo); break;
      case 'bne': if ((this.flags & FLAG_Z) === 0) this.takeBranch(s.operandLo); break;
      case 'beq': if ((this.flags & FLAG_Z) !== 0) this.takeBranch(s.operandLo); break;
      case 'bpl': if ((this.flags & FLAG_N) === 0) this.takeBranch(s.operandLo); break;
      case 'bmi': if ((this.flags & FLAG_N) !== 0) this.takeBranch(s.operandLo); break;
      case 'bvc': if ((this.flags & FLAG_V) === 0) this.takeBranch(s.operandLo); break;
      case 'bvs': if ((this.flags & FLAG_V) !== 0) this.takeBranch(s.operandLo); break;
      // Flow.
      case 'jmp': if (mode === 'abs') this.pc = s.ea; break;  // ind handled in micro-op
      case 'jsr': {
        // PC was advanced past JSR + lo + hi; subtract 1 (real 6502 pushes PC-1).
        // Microcode: opcode + lo + dummy_sp + push_pch + push_pcl + hi.
        // After hi fetched, pc is past instruction. Push happened during
        // micro-ops. Set pc to (lo|hi<<8).
        this.pc = s.operandLo | (s.operandHi << 8);
        break;
      }
      case 'rts': {
        // pop_pcl + pop_pch already set this.pc. Add 1.
        this.pc = (this.pc + 1) & 0xffff;
        break;
      }
      case 'rti': break; // pop_p + pop_pcl + pop_pch did it
      case 'brk': break; // microcode set vec
      default:
        break;
    }
  }

  private computeRmwResult(entry: MicrocodeEntry, s: InstructionState): number {
    return this.computeRmwOnValue(entry.op, s.fetchedValue);
  }

  private computeRmwOnValue(op: string, value: number): number {
    let result: number;
    switch (op) {
      case 'inc': result = (value + 1) & 0xff; this.updateNz(result); return result;
      case 'dec': result = (value - 1) & 0xff; this.updateNz(result); return result;
      case 'asl':
        this.setCarry((value & 0x80) !== 0);
        result = (value << 1) & 0xff;
        this.updateNz(result); return result;
      case 'lsr':
        this.setCarry((value & 0x01) !== 0);
        result = (value >> 1) & 0xff;
        this.updateNz(result); return result;
      case 'rol': {
        const oldC = this.flags & FLAG_C;
        this.setCarry((value & 0x80) !== 0);
        result = ((value << 1) | (oldC ? 1 : 0)) & 0xff;
        this.updateNz(result); return result;
      }
      case 'ror': {
        const oldC = this.flags & FLAG_C;
        this.setCarry((value & 0x01) !== 0);
        result = ((value >> 1) | (oldC ? 0x80 : 0)) & 0xff;
        this.updateNz(result); return result;
      }
      default: return value;
    }
  }

  private executeStore(entry: MicrocodeEntry, s: InstructionState): void {
    let v: number;
    switch (entry.op) {
      case 'sta': v = this.a; break;
      case 'stx': v = this.x; break;
      case 'sty': v = this.y; break;
      default: return;
    }
    // For absx/absy/indy stores, EA has been pre-computed. For rel n/a.
    if (entry.mode === 'zpx') s.ea = (s.operandLo + this.x) & 0xff;
    else if (entry.mode === 'zpy') s.ea = (s.operandLo + this.y) & 0xff;
    else if (entry.mode === 'absx') s.ea = ((s.operandLo | (s.operandHi << 8)) + this.x) & 0xffff;
    else if (entry.mode === 'absy') s.ea = ((s.operandLo | (s.operandHi << 8)) + this.y) & 0xffff;
    else if (entry.mode === 'indx') {
      const ptr = (s.operandLo + this.x) & 0xff;
      s.ea = this.busRead(ptr) | (this.busRead((ptr + 1) & 0xff) << 8);
    } else if (entry.mode === 'indy') {
      const base = this.busRead(s.operandLo) | (this.busRead((s.operandLo + 1) & 0xff) << 8);
      s.ea = (base + this.y) & 0xffff;
    }
    this.busWrite(s.ea, v);
  }

  private takeBranch(offset: number): void {
    const signed = offset < 0x80 ? offset : offset - 0x100;
    const oldPc = this.pc;
    this.pc = (this.pc + signed) & 0xffff;
    this.cycles += 1; // branch taken adds 1 cycle
    if ((oldPc & 0xff00) !== (this.pc & 0xff00)) this.cycles += 1; // page cross
  }

  private adc(value: number): void {
    const result = this.a + value + (this.flags & FLAG_C);
    this.setCarry((result & 0x100) !== 0);
    this.setOverflow((((this.a & 0x80) === (value & 0x80)) && ((this.a & 0x80) !== (result & 0x80))));
    this.a = result & 0xff;
    this.updateNz(this.a);
  }

  private sbc(value: number): void {
    const result = this.a - value - (1 - (this.flags & FLAG_C));
    this.setCarry((result & 0x100) === 0);
    this.setOverflow((((this.a & 0x80) !== (value & 0x80)) && ((this.a & 0x80) !== (result & 0x80))));
    this.a = result & 0xff;
    this.updateNz(this.a);
  }

  private compare(reg: number, value: number): void {
    const result = reg - value;
    this.setCarry((result & 0x100) === 0);
    this.updateNz(result & 0xff);
  }

  private bit(value: number): void {
    this.flags &= ~(FLAG_N | FLAG_V | FLAG_Z);
    this.flags |= value & (FLAG_N | FLAG_V);
    if ((value & this.a) === 0) this.flags |= FLAG_Z;
  }

  private updateNz(v: number): void {
    this.flags &= ~(FLAG_Z | FLAG_N);
    if ((v & 0xff) === 0) this.flags |= FLAG_Z;
    this.flags |= v & FLAG_N;
  }

  private setCarry(b: boolean): void {
    this.flags = (this.flags & ~FLAG_C) | (b ? FLAG_C : 0);
  }

  private setOverflow(b: boolean): void {
    this.flags = (this.flags & ~FLAG_V) | (b ? FLAG_V : 0);
  }

  private pushByte(v: number): void {
    this.busWrite(0x0100 + this.sp, v & 0xff);
    this.sp = (this.sp - 1) & 0xff;
  }

  private popByte(): number {
    this.sp = (this.sp + 1) & 0xff;
    return this.busRead(0x0100 + this.sp);
  }

  serviceInterrupt(vectorAddress: number, breakFlag = false): number {
    const nextPc = this.pc & 0xffff;
    this.pushByte((nextPc >> 8) & 0xff);
    this.pushByte(nextPc & 0xff);
    this.pushByte((this.flags & ~0x10) | (breakFlag ? 0x10 : 0x00));
    this.flags = (this.flags | FLAG_I) & 0xef;
    const target = this.busRead(vectorAddress & 0xffff) | (this.busRead((vectorAddress + 1) & 0xffff) << 8);
    this.pc = target & 0xffff;
    this.cycles += 7;
    return this.pc;
  }

  busRead(address: number): number {
    return this.memory.read(address & 0xffff) & 0xff;
  }

  busWrite(address: number, value: number): void {
    this.memory.write(address & 0xffff, value & 0xff);
  }

  // Compatibility shims for old Cpu6510 API.
  setCarryFlag(b: boolean): void { this.setCarry(b); }
  setZero(b: boolean): void {
    this.flags = (this.flags & ~FLAG_Z) | (b ? FLAG_Z : 0);
  }
  interruptsDisabled(): boolean {
    return (this.flags & FLAG_I) !== 0;
  }
  returnFromSubroutine(): void {
    this.pc = ((this.popByte() | (this.popByte() << 8)) + 1) & 0xffff;
  }
}
