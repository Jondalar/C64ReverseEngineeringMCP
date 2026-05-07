import { OPCODE_TABLE, type AddressMode, type CpuOp } from "../../exomizer-ts/generated-opcodes.js";
import type { HeadlessCpuState } from "./types.js";

const FLAG_N = 0x80;
const FLAG_V = 0x40;
const FLAG_D = 0x08;
const FLAG_I = 0x04;
const FLAG_Z = 0x02;
const FLAG_C = 0x01;

export interface CpuMemory {
  read(address: number): number;
  write(address: number, value: number): void;
}

interface ResolvedArg {
  mode: AddressMode;
  ea?: number;
  value?: number;
}

export class Cpu6510 {
  public cycles = 0;
  public pc = 0;
  public sp = 0xff;
  public flags = 0x20;
  public a = 0;
  public x = 0;
  public y = 0;

  constructor(public readonly memory: CpuMemory) {}

  reset(pc?: number): void {
    this.a = 0;
    this.x = 0;
    this.y = 0;
    this.sp = 0xff;
    this.flags = 0x20;
    this.cycles = 0;
    this.pc = pc ?? (this.read(0xfffc) | (this.read(0xfffd) << 8));
  }

  getState(): HeadlessCpuState {
    return {
      pc: this.pc,
      a: this.a,
      x: this.x,
      y: this.y,
      sp: this.sp,
      flags: this.flags,
      cycles: this.cycles,
    };
  }

  setState(state: Partial<HeadlessCpuState>): void {
    if (state.pc !== undefined) this.pc = state.pc & 0xffff;
    if (state.a !== undefined) this.a = state.a & 0xff;
    if (state.x !== undefined) this.x = state.x & 0xff;
    if (state.y !== undefined) this.y = state.y & 0xff;
    if (state.sp !== undefined) this.sp = state.sp & 0xff;
    if (state.flags !== undefined) this.flags = state.flags & 0xff;
    if (state.cycles !== undefined) this.cycles = Math.max(0, state.cycles);
  }

  setCarry(enabled: boolean): void {
    this.flags = (this.flags & ~FLAG_C) | (enabled ? FLAG_C : 0);
  }

  setZero(enabled: boolean): void {
    this.flags = (this.flags & ~FLAG_Z) | (enabled ? FLAG_Z : 0);
  }

  interruptsDisabled(): boolean {
    return (this.flags & FLAG_I) !== 0;
  }

  peekInstructionBytes(): number[] {
    const opcode = this.read(this.pc);
    const info = OPCODE_TABLE[opcode];
    if (!info) {
      return [opcode];
    }
    const length = instructionLength(info.mode);
    return Array.from({ length }, (_, index) => this.read((this.pc + index) & 0xffff));
  }

  returnFromSubroutine(): void {
    this.pc = ((this.pop() | (this.pop() << 8)) + 1) & 0xffff;
  }

  /**
   * Spec 203-c4: kernel-installed callback fired on every vector entry.
   * Same shape as Cpu65xxVice.onInterruptServiced so kernel can install
   * one closure that handles both CPU classes interchangeably.
   */
  onInterruptServiced?: (vectorAddress: number, clk: number) => void;

  /**
   * Spec 205-A c4 + Spec 217 ext: kernel-installed callback fired
   * AFTER each instruction commits.
   *
   * Args:
   *   prevPc — PC of the instruction that just executed (= opcode address)
   *   opcode — first byte (opcode) of that instruction
   *   b1, b2 — operand bytes (Cpu6510 doesn't track these in legacy
   *            path; passes 0/0 — for full operand capture use the
   *            microcoded Cpu65xxVice)
   *   a, x, y, sp, p — register state AFTER the instruction
   *   clk    — post-instruction CPU cycles
   */
  onInstructionComplete?: (
    prevPc: number,
    opcode: number,
    b1: number,
    b2: number,
    a: number,
    x: number,
    y: number,
    sp: number,
    p: number,
    clk: number,
  ) => void;

  serviceInterrupt(vectorAddress: number, breakFlag = false): number {
    // Spec 203-c4: stamp before the 7-cycle entry so servicedClock
    // tracks the entry-start cycle, matching Cpu65xxVice.
    this.onInterruptServiced?.(vectorAddress & 0xffff, this.cycles);
    const nextPc = this.pc & 0xffff;
    this.push((nextPc >> 8) & 0xff);
    this.push(nextPc & 0xff);
    this.push((this.flags & ~0x10) | (breakFlag ? 0x10 : 0x00));
    this.flags = (this.flags | FLAG_I) & 0xef;
    const target = this.read(vectorAddress & 0xffff) | (this.read((vectorAddress + 1) & 0xffff) << 8);
    this.pc = target & 0xffff;
    this.cycles += 7;
    return this.pc;
  }

  step(): void {
    // Spec 109 fix: capture cyclesBefore BEFORE the opcode fetch so the
    // fetch's own +1 is counted toward accessesDone. Without this, every
    // instruction over-counted by 1 because info.cycles (which includes
    // the fetch) was added on top of the fetch's already-charged cycle.
    const cyclesBefore = this.cycles;
    const startPc = this.pc & 0xffff;
    const opcode = this.read(this.pc);
    const info = OPCODE_TABLE[opcode];
    if (!info) {
      // Sprint 81: real undocumented 6502 opcodes (semantics per VICE
      // src/6510core.c). MM/Murder loaders rely on SLO/SRE/RLA/RRA etc.
      // Pass cyclesBefore so the same accounting fix applies.
      this.stepUndocumented(opcode, cyclesBefore);
      // Spec 205-A c4 + Spec 217 + Spec 218: instruction-complete edge
      // with full state. b1/b2 are best-effort peeks from memory at
      // startPc+1/+2; UNDOC_TABLE knows the addressing mode so length
      // resolves correctly. memory.read bypasses this.cycles to avoid
      // perturbing cycle accounting.
      const undoc = UNDOC_TABLE[opcode];
      const undocLen = undoc ? instructionLength(undoc.mode) : 1;
      const ub1 = undocLen >= 2 ? this.memory.read((startPc + 1) & 0xffff) & 0xff : 0;
      const ub2 = undocLen >= 3 ? this.memory.read((startPc + 2) & 0xffff) & 0xff : 0;
      this.onInstructionComplete?.(startPc, opcode, ub1, ub2, this.a, this.x, this.y, this.sp, this.flags, this.cycles);
      return;
    }

    const arg = this.resolveArg(info.mode);
    this.execute(info.op, info.mode, arg);
    // Spec 091: each bus access already incremented cycles by 1. We've
    // counted N accesses since cyclesBefore (incl. opcode fetch).
    // info.cycles is the true total per VICE/Lorenz table. Add the
    // remainder to keep totals accurate. Branch-taken / page-cross
    // adjustments stay in branch().
    const accessesDone = this.cycles - cyclesBefore;
    if (accessesDone < info.cycles) {
      this.cycles += info.cycles - accessesDone;
    }
    // Note: if accessesDone > info.cycles (rare overcount), let the
    // overshoot stand — peripherals see wall-clock that ticks slightly
    // faster, but it self-corrects on next instruction.
    // Spec 205-A c4 + Spec 217 + Spec 218: instruction-complete edge
    // with full state. b1/b2 are peeked via memory.read directly so
    // they bypass this.cycles bookkeeping (no spurious cycle bump).
    const docLen = instructionLength(info.mode);
    const b1 = docLen >= 2 ? this.memory.read((startPc + 1) & 0xffff) & 0xff : 0;
    const b2 = docLen >= 3 ? this.memory.read((startPc + 2) & 0xffff) & 0xff : 0;
    this.onInstructionComplete?.(startPc, opcode, b1, b2, this.a, this.x, this.y, this.sp, this.flags, this.cycles);
  }

  private stepUndocumented(opcode: number, cyclesBeforeFetch?: number): void {
    // Address-mode + cycles per illegal opcode (Lorenz/VICE table).
    const slot = UNDOC_TABLE[opcode];
    if (!slot) {
      // True KIL/JAM ($02,$12,...): freeze. Treat as NOP+1 to avoid
      // total stall, but log indirectly via cycle burn.
      this.pc = (this.pc + 1) & 0xffff;
      this.cycles += 2;
      return;
    }
    const { kind, mode, cycles } = slot;
    // Spec 109: cyclesBeforeFetch is reserved for a future top-up pass
    // that mirrors the documented-opcode path. For now undoc relies on
    // per-bus-access counting only; mark the param read to silence
    // unused-arg lint without changing semantics.
    void cyclesBeforeFetch;
    const arg = this.resolveArg(mode);
    void cycles;
    switch (kind) {
      case "nop": return;
      case "slo": {
        const v = this.read(arg.ea!);
        this.updateCarry((v & 0x80) !== 0);
        const shifted = (v << 1) & 0xff;
        this.write(arg.ea!, shifted);
        this.a = (this.a | shifted) & 0xff;
        this.updateFlagsNz(this.a);
        return;
      }
      case "rla": {
        const v = this.read(arg.ea!);
        const oldC = this.flags & FLAG_C;
        this.updateCarry((v & 0x80) !== 0);
        const shifted = ((v << 1) | (oldC ? 1 : 0)) & 0xff;
        this.write(arg.ea!, shifted);
        this.a = (this.a & shifted) & 0xff;
        this.updateFlagsNz(this.a);
        return;
      }
      case "sre": {
        const v = this.read(arg.ea!);
        this.updateCarry((v & 0x01) !== 0);
        const shifted = (v >>> 1) & 0xff;
        this.write(arg.ea!, shifted);
        this.a = (this.a ^ shifted) & 0xff;
        this.updateFlagsNz(this.a);
        return;
      }
      case "rra": {
        const v = this.read(arg.ea!);
        const oldC = this.flags & FLAG_C;
        this.updateCarry((v & 0x01) !== 0);
        const shifted = ((v >>> 1) | (oldC ? 0x80 : 0)) & 0xff;
        this.write(arg.ea!, shifted);
        // ADC shifted
        const result = this.a + shifted + (this.flags & FLAG_C);
        this.updateCarry((result & 0x100) !== 0);
        this.updateOverflow((((this.a & 0x80) === (shifted & 0x80)) && ((this.a & 0x80) !== (result & 0x80))));
        this.a = result & 0xff;
        this.updateFlagsNz(this.a);
        return;
      }
      case "sax": {
        this.write(arg.ea!, this.a & this.x & 0xff);
        return;
      }
      case "lax": {
        const v = this.readArg(mode, arg);
        this.a = v;
        this.x = v;
        this.updateFlagsNz(v);
        return;
      }
      case "dcp": {
        const v = (this.read(arg.ea!) - 1) & 0xff;
        this.write(arg.ea!, v);
        // CMP A vs v
        this.subtract(1, this.a, v);
        return;
      }
      case "isb": {
        const v = (this.read(arg.ea!) + 1) & 0xff;
        this.write(arg.ea!, v);
        // SBC v
        const result = this.subtract(this.flags & FLAG_C, this.a, v);
        this.updateOverflow((((this.a & 0x80) !== (v & 0x80)) && ((this.a & 0x80) !== (result & 0x80))));
        this.a = result & 0xff;
        this.updateFlagsNz(this.a);
        return;
      }
      case "anc": {
        this.a = (this.a & arg.value!) & 0xff;
        this.updateFlagsNz(this.a);
        this.updateCarry((this.a & 0x80) !== 0);
        return;
      }
      case "alr": {
        this.a = (this.a & arg.value!) & 0xff;
        this.updateCarry((this.a & 0x01) !== 0);
        this.a = (this.a >>> 1) & 0xff;
        this.updateFlagsNz(this.a);
        return;
      }
      case "arr": {
        const v = (this.a & arg.value!) & 0xff;
        const oldC = this.flags & FLAG_C;
        this.a = ((v >>> 1) | (oldC ? 0x80 : 0)) & 0xff;
        this.updateFlagsNz(this.a);
        // VICE: C = bit 6 of result; V = bit 6 XOR bit 5
        this.updateCarry((this.a & 0x40) !== 0);
        this.updateOverflow(((this.a >> 6) ^ (this.a >> 5)) & 0x01 ? true : false);
        return;
      }
      case "xaa": {
        // unstable; common emulation: A = X & imm
        this.a = (this.x & arg.value!) & 0xff;
        this.updateFlagsNz(this.a);
        return;
      }
      case "axs": {
        // X = (A & X) - imm (no borrow consideration like CMP)
        const v = (this.a & this.x) - arg.value!;
        this.updateCarry((v & 0x100) === 0);
        this.x = v & 0xff;
        this.updateFlagsNz(this.x);
        return;
      }
      case "sbc_imm": {
        const result = this.subtract(this.flags & FLAG_C, this.a, arg.value!);
        this.updateOverflow((((this.a & 0x80) !== (arg.value! & 0x80)) && ((this.a & 0x80) !== (result & 0x80))));
        this.a = result & 0xff;
        this.updateFlagsNz(this.a);
        return;
      }
      case "shy": { this.write(arg.ea!, this.y & (((arg.ea! >> 8) + 1) & 0xff)); return; }
      case "shx": { this.write(arg.ea!, this.x & (((arg.ea! >> 8) + 1) & 0xff)); return; }
      case "ahx": { this.write(arg.ea!, this.a & this.x & (((arg.ea! >> 8) + 1) & 0xff)); return; }
      case "tas": {
        this.sp = this.a & this.x & 0xff;
        this.write(arg.ea!, this.sp & (((arg.ea! >> 8) + 1) & 0xff));
        return;
      }
      case "las": {
        const v = this.read(arg.ea!) & this.sp;
        this.a = v; this.x = v; this.sp = v;
        this.updateFlagsNz(v);
        return;
      }
    }
  }

  private resolveArg(mode: AddressMode): ResolvedArg {
    switch (mode) {
      case "imm": {
        const value = this.read((this.pc + 1) & 0xffff);
        this.pc = (this.pc + 2) & 0xffff;
        return { mode, value };
      }
      case "zp": {
        const ea = this.read((this.pc + 1) & 0xffff);
        this.pc = (this.pc + 2) & 0xffff;
        return { mode, ea };
      }
      case "zpx": {
        const ea = (this.read((this.pc + 1) & 0xffff) + this.x) & 0xff;
        this.pc = (this.pc + 2) & 0xffff;
        return { mode, ea };
      }
      case "zpy": {
        const ea = (this.read((this.pc + 1) & 0xffff) + this.y) & 0xff;
        this.pc = (this.pc + 2) & 0xffff;
        return { mode, ea };
      }
      case "abs": {
        const lo = this.read((this.pc + 1) & 0xffff);
        const hi = this.read((this.pc + 2) & 0xffff);
        this.pc = (this.pc + 3) & 0xffff;
        return { mode, ea: lo | (hi << 8) };
      }
      case "absx": {
        const lo = this.read((this.pc + 1) & 0xffff);
        const hi = this.read((this.pc + 2) & 0xffff);
        const base = lo | (hi << 8);
        const ea = (base + this.x) & 0xffff;
        if ((base & 0xff00) !== (ea & 0xff00)) this.cycles += 1;
        this.pc = (this.pc + 3) & 0xffff;
        return { mode, ea };
      }
      case "absy": {
        const lo = this.read((this.pc + 1) & 0xffff);
        const hi = this.read((this.pc + 2) & 0xffff);
        const base = lo | (hi << 8);
        const ea = (base + this.y) & 0xffff;
        if ((base & 0xff00) !== (ea & 0xff00)) this.cycles += 1;
        this.pc = (this.pc + 3) & 0xffff;
        return { mode, ea };
      }
      case "ind": {
        const ptrLo = this.read((this.pc + 1) & 0xffff);
        const ptrHi = this.read((this.pc + 2) & 0xffff);
        const loAddr = ptrLo | (ptrHi << 8);
        const hiAddr = ((ptrLo + 1) & 0xff) | (ptrHi << 8);
        const ea = this.read(loAddr) | (this.read(hiAddr) << 8);
        this.pc = (this.pc + 3) & 0xffff;
        return { mode, ea };
      }
      case "indx": {
        const zp = (this.read((this.pc + 1) & 0xffff) + this.x) & 0xff;
        const ea = this.read(zp) | (this.read((zp + 1) & 0xff) << 8);
        this.pc = (this.pc + 2) & 0xffff;
        return { mode, ea };
      }
      case "indy": {
        const zp = this.read((this.pc + 1) & 0xffff);
        const base = this.read(zp) | (this.read((zp + 1) & 0xff) << 8);
        const ea = (base + this.y) & 0xffff;
        if ((base & 0xff00) !== (ea & 0xff00)) this.cycles += 1;
        this.pc = (this.pc + 2) & 0xffff;
        return { mode, ea };
      }
      case "rel": {
        const offset = this.read((this.pc + 1) & 0xffff);
        this.pc = (this.pc + 2) & 0xffff;
        return { mode, value: offset < 0x80 ? offset : offset - 0x100 };
      }
      case "acc":
      case "imp":
        this.pc = (this.pc + 1) & 0xffff;
        return { mode };
    }
  }

  private execute(op: CpuOp, mode: AddressMode, arg: ResolvedArg): void {
    switch (op) {
      case "adc": {
        const value = this.readArg(mode, arg);
        const result = this.a + value + (this.flags & FLAG_C);
        this.updateCarry((result & 0x100) !== 0);
        this.updateOverflow((((this.a & 0x80) === (value & 0x80)) && ((this.a & 0x80) !== (result & 0x80))));
        this.a = result & 0xff;
        this.updateFlagsNz(this.a);
        return;
      }
      case "and":
        this.a &= this.readArg(mode, arg);
        this.updateFlagsNz(this.a);
        return;
      case "asl": {
        const value = this.readArg(mode, arg);
        this.updateCarry((value & 0x80) !== 0);
        const result = (value << 1) & 0xff;
        this.writeArg(mode, arg, result);
        this.updateFlagsNz(result);
        return;
      }
      case "bcc":
        if ((this.flags & FLAG_C) === 0) this.branch(arg.value ?? 0);
        return;
      case "bcs":
        if ((this.flags & FLAG_C) !== 0) this.branch(arg.value ?? 0);
        return;
      case "beq":
        if ((this.flags & FLAG_Z) !== 0) this.branch(arg.value ?? 0);
        return;
      case "bit": {
        const value = this.readArg(mode, arg);
        this.flags &= ~(FLAG_N | FLAG_V | FLAG_Z);
        this.flags |= value & (FLAG_N | FLAG_V);
        if ((value & this.a) === 0) this.flags |= FLAG_Z;
        return;
      }
      case "bmi":
        if ((this.flags & FLAG_N) !== 0) this.branch(arg.value ?? 0);
        return;
      case "bne":
        if ((this.flags & FLAG_Z) === 0) this.branch(arg.value ?? 0);
        return;
      case "bpl":
        if ((this.flags & FLAG_N) === 0) this.branch(arg.value ?? 0);
        return;
      case "brk":
        this.push((this.pc + 1) >> 8);
        this.push((this.pc + 1) & 0xff);
        this.push(this.flags | 0x10);
        return;
      case "bvc":
        if ((this.flags & FLAG_V) === 0) this.branch(arg.value ?? 0);
        return;
      case "bvs":
        if ((this.flags & FLAG_V) !== 0) this.branch(arg.value ?? 0);
        return;
      case "clc":
        this.flags &= ~FLAG_C;
        return;
      case "cld":
        this.flags &= ~FLAG_D;
        return;
      case "cli":
        this.flags &= ~FLAG_I;
        return;
      case "clv":
        this.flags &= ~FLAG_V;
        return;
      case "cmp":
        this.subtract(1, this.a, this.readArg(mode, arg));
        return;
      case "cpx":
        this.subtract(1, this.x, this.readArg(mode, arg));
        return;
      case "cpy":
        this.subtract(1, this.y, this.readArg(mode, arg));
        return;
      case "dec": {
        const result = (this.read(arg.ea!) - 1) & 0xff;
        this.write(arg.ea!, result);
        this.updateFlagsNz(result);
        return;
      }
      case "dex":
        this.x = (this.x - 1) & 0xff;
        this.updateFlagsNz(this.x);
        return;
      case "dey":
        this.y = (this.y - 1) & 0xff;
        this.updateFlagsNz(this.y);
        return;
      case "eor":
        this.a ^= this.readArg(mode, arg);
        this.updateFlagsNz(this.a);
        return;
      case "inc": {
        const result = (this.read(arg.ea!) + 1) & 0xff;
        this.write(arg.ea!, result);
        this.updateFlagsNz(result);
        return;
      }
      case "inx":
        this.x = (this.x + 1) & 0xff;
        this.updateFlagsNz(this.x);
        return;
      case "iny":
        this.y = (this.y + 1) & 0xff;
        this.updateFlagsNz(this.y);
        return;
      case "jmp":
        this.pc = arg.ea!;
        return;
      case "jsr":
        this.pc = (this.pc - 1) & 0xffff;
        this.push(this.pc >> 8);
        this.push(this.pc & 0xff);
        this.pc = arg.ea!;
        return;
      case "lda":
        this.a = this.readArg(mode, arg);
        this.updateFlagsNz(this.a);
        return;
      case "ldx":
        this.x = this.readArg(mode, arg);
        this.updateFlagsNz(this.x);
        return;
      case "ldy":
        this.y = this.readArg(mode, arg);
        this.updateFlagsNz(this.y);
        return;
      case "lsr": {
        const value = this.readArg(mode, arg);
        this.updateCarry((value & 0x01) !== 0);
        const result = (value >> 1) & 0xff;
        this.writeArg(mode, arg, result);
        this.updateFlagsNz(result);
        return;
      }
      case "nop":
        return;
      case "ora":
        this.a |= this.readArg(mode, arg);
        this.updateFlagsNz(this.a);
        return;
      case "pha":
        this.push(this.a);
        return;
      case "php":
        // 6502 spec: PHP always pushes flags with B=1 (and unused=1).
        // (BRK also forces B=1; IRQ/NMI push with B=0 — see serviceInterrupt.)
        this.push(this.flags | 0x10);
        return;
      case "pla":
        this.a = this.pop();
        this.updateFlagsNz(this.a);
        return;
      case "plp":
        this.flags = this.pop();
        return;
      case "rol": {
        const value = this.readArg(mode, arg);
        const oldCarry = this.flags & FLAG_C;
        this.updateCarry((value & 0x80) !== 0);
        const result = ((value << 1) | (oldCarry ? 1 : 0)) & 0xff;
        this.writeArg(mode, arg, result);
        this.updateFlagsNz(result);
        return;
      }
      case "ror": {
        const value = this.readArg(mode, arg);
        const oldCarry = this.flags & FLAG_C;
        this.updateCarry((value & 0x01) !== 0);
        const result = ((value >> 1) | (oldCarry ? 0x80 : 0x00)) & 0xff;
        this.writeArg(mode, arg, result);
        this.updateFlagsNz(result);
        return;
      }
      case "rti":
        this.flags = this.pop();
        this.pc = this.pop() | (this.pop() << 8);
        return;
      case "rts":
        this.pc = ((this.pop() | (this.pop() << 8)) + 1) & 0xffff;
        return;
      case "sbc": {
        const value = this.readArg(mode, arg);
        const result = this.subtract(this.flags & FLAG_C, this.a, value);
        this.updateOverflow((((this.a & 0x80) !== (value & 0x80)) && ((this.a & 0x80) !== (result & 0x80))));
        this.a = result & 0xff;
        this.updateFlagsNz(this.a);
        return;
      }
      case "sec":
        this.flags |= FLAG_C;
        return;
      case "sed":
        this.flags |= FLAG_D;
        return;
      case "sei":
        this.flags |= FLAG_I;
        return;
      case "sta":
        this.write(arg.ea!, this.a);
        return;
      case "stx":
        this.write(arg.ea!, this.x);
        return;
      case "sty":
        this.write(arg.ea!, this.y);
        return;
      case "tax":
        this.x = this.a;
        this.updateFlagsNz(this.x);
        return;
      case "tay":
        this.y = this.a;
        this.updateFlagsNz(this.y);
        return;
      case "tsx":
        this.x = this.sp;
        this.updateFlagsNz(this.x);
        return;
      case "txa":
        this.a = this.x;
        this.updateFlagsNz(this.a);
        return;
      case "txs":
        this.sp = this.x;
        return;
      case "tya":
        this.a = this.y;
        this.updateFlagsNz(this.a);
        return;
    }
  }

  private readArg(mode: AddressMode, arg: ResolvedArg): number {
    if (mode === "imm") return arg.value!;
    if (mode === "acc") return this.a;
    return this.read(arg.ea!);
  }

  private writeArg(mode: AddressMode, arg: ResolvedArg, value: number): void {
    if (mode === "acc") {
      this.a = value & 0xff;
      return;
    }
    this.write(arg.ea!, value);
  }

  private branch(offset: number): void {
    const oldPc = this.pc;
    const target = (this.pc + offset) & 0xffff;
    this.cycles += 1;
    if ((oldPc & 0xff00) !== (target & 0xff00)) this.cycles += 1;
    this.pc = target;
  }

  private subtract(carry: number, left: number, right: number): number {
    const result = left - right - (1 - (carry ? 1 : 0));
    this.updateCarry((result & 0x100) === 0);
    this.updateFlagsNz(result & 0xff);
    return result & 0x1ff;
  }

  private updateFlagsNz(value: number): void {
    this.flags &= ~(FLAG_Z | FLAG_N);
    if ((value & 0xff) === 0) this.flags |= FLAG_Z;
    this.flags |= value & FLAG_N;
  }

  private updateCarry(enabled: boolean): void {
    this.flags = (this.flags & ~FLAG_C) | (enabled ? FLAG_C : 0);
  }

  private updateOverflow(enabled: boolean): void {
    this.flags = (this.flags & ~FLAG_V) | (enabled ? FLAG_V : 0);
  }

  private push(value: number): void {
    this.write(0x0100 + this.sp, value & 0xff);
    this.sp = (this.sp - 1) & 0xff;
  }

  private pop(): number {
    this.sp = (this.sp + 1) & 0xff;
    return this.read(0x0100 + this.sp);
  }

  // Spec 091: per-bus-access cycle counting. Each call advances
  // this.cycles by 1 BEFORE the actual bus access. Drive (and other
  // observers) see the current CPU cycle at the correct
  // mid-instruction bus-access point.
  // The legacy `cycles += info.cycles` at end of step() is now ZERO'd
  // because we count cycles per access. For opcodes whose info.cycles
  // exceeds bus access count (dummy reads, page-cross penalty, branch
  // taken), specific helpers add the missing cycles.
  private read(address: number): number {
    this.cycles += 1;
    return this.memory.read(address & 0xffff) & 0xff;
  }

  private write(address: number, value: number): void {
    this.cycles += 1;
    this.memory.write(address & 0xffff, value & 0xff);
  }
}

type UndocKind =
  | "nop" | "slo" | "rla" | "sre" | "rra"
  | "sax" | "lax" | "dcp" | "isb"
  | "anc" | "alr" | "arr" | "xaa" | "axs" | "sbc_imm"
  | "shy" | "shx" | "ahx" | "tas" | "las";

interface UndocSlot { kind: UndocKind; mode: AddressMode; cycles: number; }

const UNDOC_TABLE: Array<UndocSlot | null> = (() => {
  const t: Array<UndocSlot | null> = new Array(256).fill(null);
  const set = (op: number, kind: UndocKind, mode: AddressMode, cycles: number) => { t[op] = { kind, mode, cycles }; };
  // NOPs (implied)
  for (const op of [0x1a, 0x3a, 0x5a, 0x7a, 0xda, 0xfa]) set(op, "nop", "imp", 2);
  // NOPs (immediate)
  for (const op of [0x80, 0x82, 0x89, 0xc2, 0xe2]) set(op, "nop", "imm", 2);
  // NOPs (zp / zpx / abs / absx)
  for (const op of [0x04, 0x44, 0x64]) set(op, "nop", "zp", 3);
  for (const op of [0x14, 0x34, 0x54, 0x74, 0xd4, 0xf4]) set(op, "nop", "zpx", 4);
  set(0x0c, "nop", "abs", 4);
  for (const op of [0x1c, 0x3c, 0x5c, 0x7c, 0xdc, 0xfc]) set(op, "nop", "absx", 4);
  // SLO
  set(0x07, "slo", "zp",   5); set(0x17, "slo", "zpx", 6);
  set(0x0f, "slo", "abs",  6); set(0x1f, "slo", "absx", 7);
  set(0x1b, "slo", "absy", 7); set(0x03, "slo", "indx", 8); set(0x13, "slo", "indy", 8);
  // RLA
  set(0x27, "rla", "zp",   5); set(0x37, "rla", "zpx", 6);
  set(0x2f, "rla", "abs",  6); set(0x3f, "rla", "absx", 7);
  set(0x3b, "rla", "absy", 7); set(0x23, "rla", "indx", 8); set(0x33, "rla", "indy", 8);
  // SRE
  set(0x47, "sre", "zp",   5); set(0x57, "sre", "zpx", 6);
  set(0x4f, "sre", "abs",  6); set(0x5f, "sre", "absx", 7);
  set(0x5b, "sre", "absy", 7); set(0x43, "sre", "indx", 8); set(0x53, "sre", "indy", 8);
  // RRA
  set(0x67, "rra", "zp",   5); set(0x77, "rra", "zpx", 6);
  set(0x6f, "rra", "abs",  6); set(0x7f, "rra", "absx", 7);
  set(0x7b, "rra", "absy", 7); set(0x63, "rra", "indx", 8); set(0x73, "rra", "indy", 8);
  // SAX
  set(0x87, "sax", "zp",   3); set(0x97, "sax", "zpy", 4);
  set(0x8f, "sax", "abs",  4); set(0x83, "sax", "indx", 6);
  // LAX
  set(0xa7, "lax", "zp",   3); set(0xb7, "lax", "zpy", 4);
  set(0xaf, "lax", "abs",  4); set(0xbf, "lax", "absy", 4);
  set(0xa3, "lax", "indx", 6); set(0xb3, "lax", "indy", 5);
  set(0xab, "lax", "imm",  2);
  // DCP
  set(0xc7, "dcp", "zp",   5); set(0xd7, "dcp", "zpx", 6);
  set(0xcf, "dcp", "abs",  6); set(0xdf, "dcp", "absx", 7);
  set(0xdb, "dcp", "absy", 7); set(0xc3, "dcp", "indx", 8); set(0xd3, "dcp", "indy", 8);
  // ISB
  set(0xe7, "isb", "zp",   5); set(0xf7, "isb", "zpx", 6);
  set(0xef, "isb", "abs",  6); set(0xff, "isb", "absx", 7);
  set(0xfb, "isb", "absy", 7); set(0xe3, "isb", "indx", 8); set(0xf3, "isb", "indy", 8);
  // ANC
  set(0x0b, "anc", "imm", 2); set(0x2b, "anc", "imm", 2);
  // ALR / ARR / XAA / AXS / SBC#
  set(0x4b, "alr", "imm", 2);
  set(0x6b, "arr", "imm", 2);
  set(0x8b, "xaa", "imm", 2);
  set(0xcb, "axs", "imm", 2);
  set(0xeb, "sbc_imm", "imm", 2);
  // Stores
  set(0x9c, "shy", "absx", 5);
  set(0x9e, "shx", "absy", 5);
  set(0x93, "ahx", "indy", 6);
  set(0x9f, "ahx", "absy", 5);
  set(0x9b, "tas", "absy", 5);
  set(0xbb, "las", "absy", 4);
  return t;
})();

function instructionLength(mode: AddressMode): number {
  switch (mode) {
    case "imp":
    case "acc":
      return 1;
    case "imm":
    case "zp":
    case "zpx":
    case "zpy":
    case "indx":
    case "indy":
    case "rel":
      return 2;
    case "abs":
    case "absx":
    case "absy":
    case "ind":
      return 3;
  }
}
