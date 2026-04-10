import { OPCODE_TABLE, type AddressMode, type CpuOp } from "./generated-opcodes.js";

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

export class Cpu6502 {
  public cycles = 0;
  public pc = 0;
  public sp = 0xff;
  public flags = 0;
  public a = 0;
  public x = 0;
  public y = 0;

  constructor(public readonly memory: CpuMemory) {}

  step(): void {
    const opcode = this.read(this.pc);
    const info = OPCODE_TABLE[opcode];
    if (!info) {
      throw new Error(`Unimplemented opcode $${opcode.toString(16).toUpperCase().padStart(2, "0")} @ $${this.pc.toString(16).toUpperCase().padStart(4, "0")}`);
    }

    const arg = this.resolveArg(info.mode);
    this.execute(info.op, info.mode, arg);
    this.cycles += info.cycles;
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
        if ((base & 0xff00) !== (ea & 0xff00)) {
          this.cycles += 1;
        }
        this.pc = (this.pc + 3) & 0xffff;
        return { mode, ea };
      }
      case "absy": {
        const lo = this.read((this.pc + 1) & 0xffff);
        const hi = this.read((this.pc + 2) & 0xffff);
        const base = lo | (hi << 8);
        const ea = (base + this.y) & 0xffff;
        if ((base & 0xff00) !== (ea & 0xff00)) {
          this.cycles += 1;
        }
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
        if ((base & 0xff00) !== (ea & 0xff00)) {
          this.cycles += 1;
        }
        this.pc = (this.pc + 2) & 0xffff;
        return { mode, ea };
      }
      case "rel": {
        const offset = this.read((this.pc + 1) & 0xffff);
        this.pc = (this.pc + 2) & 0xffff;
        return { mode, value: offset < 0x80 ? offset : offset - 0x100 };
      }
      case "acc":
        this.pc = (this.pc + 1) & 0xffff;
        return { mode };
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
        this.push(this.flags & ~0x10);
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
    if ((oldPc & 0xff00) !== (target & 0xff00)) {
      this.cycles += 1;
    }
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

  private read(address: number): number {
    return this.memory.read(address & 0xffff) & 0xff;
  }

  private write(address: number, value: number): void {
    this.memory.write(address & 0xffff, value & 0xff);
  }
}
