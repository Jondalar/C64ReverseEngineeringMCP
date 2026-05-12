// Lightweight 6502 CPU for sandbox execution.
//
// Ported from tools/lykia_disk_depack.py. Models documented + commonly-used
// undocumented opcodes encountered in C64 depackers/crypto routines. No IO
// bus, no banking — just a flat 64K Uint8Array. Writes are logged so the
// caller can extract decrunched output regions.
//
// Differences vs runtime/headless/cpu6510.ts: that one is the "full machine"
// CPU plugged into the C64 memory bus and has no undocumented opcodes; this
// one is self-contained and supports the undoc set so depacker wrappers
// (Exomizer SFX, BB2 lykia, custom LZ77) execute end-to-end.

export interface SandboxCpuState {
  pc: number;
  a: number;
  x: number;
  y: number;
  sp: number;
  flags: number;
  cycles: number;
}

export interface CpuWrite {
  address: number;
  value: number;
}

export type StopReason =
  | "stop_pc"
  | "sentinel_rts"
  | "max_steps"
  | "brk"
  | "jam"
  | "stream_exhausted"
  | "unimplemented_opcode";

export class Cpu6502 {
  a = 0;
  x = 0;
  y = 0;
  sp = 0xff;
  pc = 0;
  cycles = 0;

  // Flags as individual booleans for parity with the Python port.
  n = false;
  v = false;
  z = true;
  c = false;
  i = false;
  d = false;

  readonly writes: CpuWrite[] = [];

  // Stream-feed hook: when PC matches a hooked entry, the CPU synthesises
  // "A = next stream byte, C = 0, RTS" instead of executing the routine.
  streamBytes: Uint8Array = new Uint8Array(0);
  streamPos = 0;
  hookEntries: Set<number> = new Set();

  // Optional ROM overlay for EasyFlash-style "read source from ROM, write
  // destination to RAM" depackers. When `romMask[addr]` is non-zero, reads
  // at that address return `rom[addr]` instead of `mem[addr]`. Writes
  // always go to `mem` (and are tracked in `writes`). Both arrays stay
  // null when no ROM is mapped — the hot path then has a single null-check.
  rom: Uint8Array | null = null;
  romMask: Uint8Array | null = null;

  constructor(public readonly mem: Uint8Array) {
    if (mem.length !== 0x10000) {
      throw new Error(`Cpu6502 expects 64K memory, got ${mem.length}`);
    }
  }

  // Map a contiguous range as ROM. Subsequent reads in that range return
  // bytes from `source`; writes still go to `mem`. Calling this lazily
  // allocates the overlay buffers.
  mapRom(start: number, source: ArrayLike<number>): void {
    if (!this.rom) this.rom = new Uint8Array(0x10000);
    if (!this.romMask) this.romMask = new Uint8Array(0x10000);
    for (let i = 0; i < source.length; i++) {
      const a = (start + i) & 0xffff;
      this.rom[a] = source[i]! & 0xff;
      this.romMask[a] = 1;
    }
  }

  read(addr: number): number {
    const a = addr & 0xffff;
    if (this.romMask && this.romMask[a]) return this.rom![a]!;
    return this.mem[a]!;
  }

  readWord(addr: number): number {
    return this.read(addr) | (this.read((addr + 1) & 0xffff) << 8);
  }

  write(addr: number, value: number): void {
    const a = addr & 0xffff;
    const v = value & 0xff;
    this.mem[a] = v;
    this.writes.push({ address: a, value: v });
  }

  push(value: number): void {
    this.mem[0x0100 | this.sp] = value & 0xff;
    this.sp = (this.sp - 1) & 0xff;
  }

  pop(): number {
    this.sp = (this.sp + 1) & 0xff;
    return this.mem[0x0100 | this.sp]!;
  }

  setNZ(value: number): void {
    const v = value & 0xff;
    this.z = v === 0;
    this.n = (v & 0x80) !== 0;
  }

  getFlags(): number {
    return ((this.n ? 0x80 : 0) | (this.v ? 0x40 : 0) | 0x20
      | (this.d ? 0x08 : 0) | (this.i ? 0x04 : 0)
      | (this.z ? 0x02 : 0) | (this.c ? 0x01 : 0));
  }

  setFlags(p: number): void {
    this.n = (p & 0x80) !== 0;
    this.v = (p & 0x40) !== 0;
    this.d = (p & 0x08) !== 0;
    this.i = (p & 0x04) !== 0;
    this.z = (p & 0x02) !== 0;
    this.c = (p & 0x01) !== 0;
  }

  getState(): SandboxCpuState {
    return { pc: this.pc, a: this.a, x: this.x, y: this.y, sp: this.sp, flags: this.getFlags(), cycles: this.cycles };
  }

  // Execute one instruction. Returns:
  //  - "continue"           — keep stepping
  //  - "sentinel_rts"       — RTS popped sentinel ($FFFE)
  //  - "brk"                — BRK encountered
  //  - "jam"                — illegal JAM opcode encountered
  //  - "stream_exhausted"   — stream hook fired with no bytes left
  //  - "unimplemented_opcode" — opcode not handled (returns; caller sees it)
  step(): "continue" | StopReason {
    if (this.hookEntries.has(this.pc)) {
      if (this.streamPos >= this.streamBytes.length) {
        // End of stream — leave A=0, C=0 then RTS as the Python port does;
        // caller sees stream_exhausted before next decode.
        this.a = 0; this.c = false;
        const lo = this.pop(); const hi = this.pop();
        const ret = (((hi << 8) | lo) + 1) & 0xffff;
        if (ret === 0xfffe) return "sentinel_rts";
        this.pc = ret;
        return "stream_exhausted";
      }
      this.a = this.streamBytes[this.streamPos]!;
      this.streamPos += 1;
      this.setNZ(this.a);
      this.c = false; // signal "byte OK"
      const lo = this.pop(); const hi = this.pop();
      const ret = (((hi << 8) | lo) + 1) & 0xffff;
      if (ret === 0xfffe) return "sentinel_rts";
      this.pc = ret;
      return "continue";
    }

    const op = this.read(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    this.cycles += 1; // approximate; we don't track per-opcode cycle counts here

    const imm = (): number => { const v = this.read(this.pc); this.pc = (this.pc + 1) & 0xffff; return v; };
    const absAddr = (): number => { const lo = this.read(this.pc); const hi = this.read((this.pc + 1) & 0xffff); this.pc = (this.pc + 2) & 0xffff; return lo | (hi << 8); };
    const zpAddr = (): number => { const a = this.read(this.pc); this.pc = (this.pc + 1) & 0xffff; return a; };
    const rel = (): number => {
      let off = this.read(this.pc);
      this.pc = (this.pc + 1) & 0xffff;
      if (off & 0x80) off -= 0x100;
      return (this.pc + off) & 0xffff;
    };

    switch (op) {
      case 0x00: return "brk";
      case 0x01: { const z = zpAddr(); const addr = this.readWord((z + this.x) & 0xff); this.a |= this.read(addr); this.setNZ(this.a); return "continue"; }
      case 0x05: this.a |= this.read(zpAddr()); this.setNZ(this.a); return "continue";
      case 0x06: { const a = zpAddr(); let v = this.mem[a]!; this.c = (v & 0x80) !== 0; v = (v << 1) & 0xff; this.mem[a] = v; this.setNZ(v); return "continue"; }
      case 0x08: this.push(this.getFlags() | 0x30); return "continue";
      case 0x09: this.a = (this.a | imm()) & 0xff; this.setNZ(this.a); return "continue";
      case 0x0a: this.c = (this.a & 0x80) !== 0; this.a = (this.a << 1) & 0xff; this.setNZ(this.a); return "continue";
      case 0x0c: this.read(absAddr()); return "continue";
      case 0x0d: this.a = (this.a | this.read(absAddr())) & 0xff; this.setNZ(this.a); return "continue";
      case 0x10: { const t = rel(); if (!this.n) this.pc = t; return "continue"; }
      case 0x11: { const z = zpAddr(); const addr = (this.readWord(z) + this.y) & 0xffff; this.a = (this.a | this.read(addr)) & 0xff; this.setNZ(this.a); return "continue"; }
      case 0x15: this.a = (this.a | this.read((zpAddr() + this.x) & 0xff)) & 0xff; this.setNZ(this.a); return "continue";
      case 0x18: this.c = false; return "continue";
      case 0x19: this.a = (this.a | this.read((absAddr() + this.y) & 0xffff)) & 0xff; this.setNZ(this.a); return "continue";
      case 0x1a: return "continue";
      case 0x1d: this.a = (this.a | this.read((absAddr() + this.x) & 0xffff)) & 0xff; this.setNZ(this.a); return "continue";
      case 0x1f: { const a = (absAddr() + this.x) & 0xffff; let v = this.read(a); this.c = (v & 0x80) !== 0; v = (v << 1) & 0xff; this.write(a, v); this.a = (this.a | v) & 0xff; this.setNZ(this.a); return "continue"; }
      case 0x20: { const t = absAddr(); const ret = (this.pc - 1) & 0xffff; this.push((ret >> 8) & 0xff); this.push(ret & 0xff); this.pc = t; return "continue"; }
      case 0x25: this.a &= this.read(zpAddr()); this.setNZ(this.a); return "continue";
      case 0x26: { const a = zpAddr(); const old = this.mem[a]!; const newc = (old & 0x80) !== 0; const v = ((old << 1) | (this.c ? 1 : 0)) & 0xff; this.c = newc; this.mem[a] = v; this.setNZ(v); return "continue"; }
      case 0x28: this.setFlags(this.pop()); return "continue";
      case 0x29: this.a &= imm(); this.setNZ(this.a); return "continue";
      case 0x2a: { const newc = (this.a & 0x80) !== 0; this.a = ((this.a << 1) | (this.c ? 1 : 0)) & 0xff; this.c = newc; this.setNZ(this.a); return "continue"; }
      case 0x2c: { const v = this.read(absAddr()); this.z = (this.a & v) === 0; this.n = (v & 0x80) !== 0; this.v = (v & 0x40) !== 0; return "continue"; }
      case 0x2f: { const a = absAddr(); const old = this.read(a); const newc = (old & 0x80) !== 0; const v = ((old << 1) | (this.c ? 1 : 0)) & 0xff; this.c = newc; this.write(a, v); this.a &= v; this.setNZ(this.a); return "continue"; }
      case 0x30: { const t = rel(); if (this.n) this.pc = t; return "continue"; }
      case 0x35: this.a &= this.read((zpAddr() + this.x) & 0xff); this.setNZ(this.a); return "continue";
      case 0x37: { const a = (zpAddr() + this.x) & 0xff; const old = this.mem[a]!; const newc = (old & 0x80) !== 0; const v = ((old << 1) | (this.c ? 1 : 0)) & 0xff; this.c = newc; this.mem[a] = v; this.a &= v; this.setNZ(this.a); return "continue"; }
      case 0x38: this.c = true; return "continue";
      case 0x39: this.a &= this.read((absAddr() + this.y) & 0xffff); this.setNZ(this.a); return "continue";
      case 0x3b: { const a = (absAddr() + this.y) & 0xffff; const old = this.read(a); const newc = (old & 0x80) !== 0; const v = ((old << 1) | (this.c ? 1 : 0)) & 0xff; this.c = newc; this.write(a, v); this.a &= v; this.setNZ(this.a); return "continue"; }
      case 0x3d: this.a &= this.read((absAddr() + this.x) & 0xffff); this.setNZ(this.a); return "continue";
      case 0x3f: { const a = (absAddr() + this.x) & 0xffff; const old = this.read(a); const newc = (old & 0x80) !== 0; const v = ((old << 1) | (this.c ? 1 : 0)) & 0xff; this.c = newc; this.write(a, v); this.a &= v; this.setNZ(this.a); return "continue"; }
      case 0x40: { this.setFlags(this.pop()); const lo = this.pop(); const hi = this.pop(); this.pc = (hi << 8) | lo; return "continue"; }
      case 0x45: this.a ^= this.read(zpAddr()); this.setNZ(this.a); return "continue";
      case 0x46: { const a = zpAddr(); let v = this.mem[a]!; this.c = (v & 1) !== 0; v >>= 1; this.mem[a] = v; this.setNZ(v); return "continue"; }
      case 0x47: { const a = zpAddr(); let v = this.mem[a]!; this.c = (v & 1) !== 0; v >>= 1; this.mem[a] = v; this.a ^= v; this.setNZ(this.a); return "continue"; }
      case 0x48: this.push(this.a); return "continue";
      case 0x49: this.a ^= imm(); this.setNZ(this.a); return "continue";
      case 0x4a: this.c = (this.a & 1) !== 0; this.a >>= 1; this.setNZ(this.a); return "continue";
      case 0x4b: this.a &= imm(); this.c = (this.a & 1) !== 0; this.a >>= 1; this.setNZ(this.a); return "continue";
      case 0x4c: this.pc = absAddr(); return "continue";
      case 0x50: { const t = rel(); if (!this.v) this.pc = t; return "continue"; }
      case 0x51: { const z = zpAddr(); const addr = (this.readWord(z) + this.y) & 0xffff; this.a ^= this.read(addr); this.setNZ(this.a); return "continue"; }
      case 0x55: this.a ^= this.read((zpAddr() + this.x) & 0xff); this.setNZ(this.a); return "continue";
      case 0x57: { const a = (zpAddr() + this.x) & 0xff; let v = this.mem[a]!; this.c = (v & 1) !== 0; v >>= 1; this.mem[a] = v; this.a ^= v; this.setNZ(this.a); return "continue"; }
      case 0x58: this.i = false; return "continue";
      case 0x59: this.a ^= this.read((absAddr() + this.y) & 0xffff); this.setNZ(this.a); return "continue";
      case 0x5d: this.a ^= this.read((absAddr() + this.x) & 0xffff); this.setNZ(this.a); return "continue";
      case 0x5e: { const a = (absAddr() + this.x) & 0xffff; let v = this.read(a); this.c = (v & 1) !== 0; v >>= 1; this.write(a, v); this.setNZ(v); return "continue"; }
      case 0x60: { const lo = this.pop(); const hi = this.pop(); const ret = (((hi << 8) | lo) + 1) & 0xffff; if (ret === 0xfffe) return "sentinel_rts"; this.pc = ret; return "continue"; }
      case 0x61: { const z = zpAddr(); const addr = this.readWord((z + this.x) & 0xff); return this.adc(this.read(addr)) ? "continue" : "continue"; }
      case 0x65: return this.adc(this.read(zpAddr())) ? "continue" : "continue";
      case 0x66: { const a = zpAddr(); const old = this.mem[a]!; const newc = (old & 1) !== 0; const v = (old >> 1) | (this.c ? 0x80 : 0); this.c = newc; this.mem[a] = v; this.setNZ(v); return "continue"; }
      case 0x67: { const a = zpAddr(); const old = this.mem[a]!; const newc = (old & 1) !== 0; const v = (old >> 1) | (this.c ? 0x80 : 0); this.c = newc; this.mem[a] = v; this.adc(v); return "continue"; }
      case 0x68: this.a = this.pop(); this.setNZ(this.a); return "continue";
      case 0x69: this.adc(imm()); return "continue";
      case 0x6a: { const newc = (this.a & 1) !== 0; this.a = (this.a >> 1) | (this.c ? 0x80 : 0); this.c = newc; this.setNZ(this.a); return "continue"; }
      case 0x6b: { this.a &= imm(); this.a = (this.a >> 1) | (this.c ? 0x80 : 0); this.c = (this.a & 0x40) !== 0; this.v = (((this.a >> 6) ^ ((this.a >> 5) & 1)) & 1) !== 0; this.setNZ(this.a); return "continue"; }
      case 0x70: { const t = rel(); if (this.v) this.pc = t; return "continue"; }
      case 0x71: { const z = zpAddr(); const addr = (this.readWord(z) + this.y) & 0xffff; this.adc(this.read(addr)); return "continue"; }
      case 0x75: this.adc(this.read((zpAddr() + this.x) & 0xff)); return "continue";
      case 0x76: { const a = (zpAddr() + this.x) & 0xff; const old = this.mem[a]!; const newc = (old & 1) !== 0; const v = (old >> 1) | (this.c ? 0x80 : 0); this.c = newc; this.mem[a] = v; this.setNZ(v); return "continue"; }
      case 0x78: this.i = true; return "continue";
      case 0x79: this.adc(this.read((absAddr() + this.y) & 0xffff)); return "continue";
      case 0x7b: { const a = (absAddr() + this.y) & 0xffff; const old = this.read(a); const newc = (old & 1) !== 0; const v = (old >> 1) | (this.c ? 0x80 : 0); this.c = newc; this.write(a, v); this.adc(v); return "continue"; }
      case 0x7d: this.adc(this.read((absAddr() + this.x) & 0xffff)); return "continue";
      case 0x7e: { const a = (absAddr() + this.x) & 0xffff; const old = this.read(a); const newc = (old & 1) !== 0; const v = (old >> 1) | (this.c ? 0x80 : 0); this.c = newc; this.write(a, v); this.setNZ(v); return "continue"; }
      case 0x80: imm(); return "continue";
      case 0x84: this.write(zpAddr(), this.y); return "continue";
      case 0x85: this.write(zpAddr(), this.a); return "continue";
      case 0x86: this.write(zpAddr(), this.x); return "continue";
      case 0x87: this.write(zpAddr(), this.a & this.x); return "continue";
      case 0x88: this.y = (this.y - 1) & 0xff; this.setNZ(this.y); return "continue";
      case 0x89: imm(); return "continue";
      case 0x8a: this.a = this.x; this.setNZ(this.a); return "continue";
      case 0x8c: this.write(absAddr(), this.y); return "continue";
      case 0x8d: this.write(absAddr(), this.a); return "continue";
      case 0x8e: this.write(absAddr(), this.x); return "continue";
      case 0x90: { const t = rel(); if (!this.c) this.pc = t; return "continue"; }
      case 0x91: { const z = zpAddr(); const base = this.readWord(z); this.write((base + this.y) & 0xffff, this.a); return "continue"; }
      case 0x94: this.write((zpAddr() + this.x) & 0xff, this.y); return "continue";
      case 0x95: this.write((zpAddr() + this.x) & 0xff, this.a); return "continue";
      case 0x97: this.write((zpAddr() + this.y) & 0xff, this.a & this.x); return "continue";
      case 0x98: this.a = this.y; this.setNZ(this.a); return "continue";
      case 0x99: this.write((absAddr() + this.y) & 0xffff, this.a); return "continue";
      case 0x9a: this.sp = this.x; return "continue";
      case 0x9d: this.write((absAddr() + this.x) & 0xffff, this.a); return "continue";
      case 0xa0: this.y = imm(); this.setNZ(this.y); return "continue";
      case 0xa2: this.x = imm(); this.setNZ(this.x); return "continue";
      case 0xa3: { const z = zpAddr(); const addr = this.readWord((z + this.x) & 0xff); const v = this.read(addr); this.a = v; this.x = v; this.setNZ(v); return "continue"; }
      case 0xa4: this.y = this.read(zpAddr()); this.setNZ(this.y); return "continue";
      case 0xa5: this.a = this.read(zpAddr()); this.setNZ(this.a); return "continue";
      case 0xa6: this.x = this.read(zpAddr()); this.setNZ(this.x); return "continue";
      case 0xa7: { const v = this.read(zpAddr()); this.a = v; this.x = v; this.setNZ(v); return "continue"; }
      case 0xa8: this.y = this.a; this.setNZ(this.y); return "continue";
      case 0xa9: this.a = imm(); this.setNZ(this.a); return "continue";
      case 0xaa: this.x = this.a; this.setNZ(this.x); return "continue";
      case 0xac: this.y = this.read(absAddr()); this.setNZ(this.y); return "continue";
      case 0xad: this.a = this.read(absAddr()); this.setNZ(this.a); return "continue";
      case 0xae: this.x = this.read(absAddr()); this.setNZ(this.x); return "continue";
      case 0xaf: { const v = this.read(absAddr()); this.a = v; this.x = v; this.setNZ(v); return "continue"; }
      case 0xb0: { const t = rel(); if (this.c) this.pc = t; return "continue"; }
      case 0xb1: { const z = zpAddr(); const addr = (this.readWord(z) + this.y) & 0xffff; this.a = this.read(addr); this.setNZ(this.a); return "continue"; }
      case 0xb5: this.a = this.read((zpAddr() + this.x) & 0xff); this.setNZ(this.a); return "continue";
      case 0xb6: this.x = this.read((zpAddr() + this.y) & 0xff); this.setNZ(this.x); return "continue";
      case 0xb7: { const v = this.read((zpAddr() + this.y) & 0xff); this.a = v; this.x = v; this.setNZ(v); return "continue"; }
      case 0xb8: this.v = false; return "continue";
      case 0xb9: this.a = this.read((absAddr() + this.y) & 0xffff); this.setNZ(this.a); return "continue";
      case 0xba: this.x = this.sp; this.setNZ(this.x); return "continue";
      case 0xbb: { const v = this.read((absAddr() + this.y) & 0xffff) & this.sp; this.a = v; this.x = v; this.sp = v; this.setNZ(v); return "continue"; }
      case 0xbc: this.y = this.read((absAddr() + this.x) & 0xffff); this.setNZ(this.y); return "continue";
      case 0xbd: this.a = this.read((absAddr() + this.x) & 0xffff); this.setNZ(this.a); return "continue";
      case 0xbe: this.x = this.read((absAddr() + this.y) & 0xffff); this.setNZ(this.x); return "continue";
      case 0xbf: { const v = this.read((absAddr() + this.y) & 0xffff); this.a = v; this.x = v; this.setNZ(v); return "continue"; }
      case 0xc0: { const v = imm(); this.c = this.y >= v; this.setNZ((this.y - v) & 0xff); return "continue"; }
      case 0xc5: { const v = this.read(zpAddr()); this.c = this.a >= v; this.setNZ((this.a - v) & 0xff); return "continue"; }
      case 0xc6: { const a = zpAddr(); const v = (this.mem[a]! - 1) & 0xff; this.mem[a] = v; this.setNZ(v); return "continue"; }
      case 0xc7: { const a = zpAddr(); const v = (this.mem[a]! - 1) & 0xff; this.mem[a] = v; this.c = this.a >= v; this.setNZ((this.a - v) & 0xff); return "continue"; }
      case 0xc8: this.y = (this.y + 1) & 0xff; this.setNZ(this.y); return "continue";
      case 0xc9: { const v = imm(); this.c = this.a >= v; this.setNZ((this.a - v) & 0xff); return "continue"; }
      case 0xca: this.x = (this.x - 1) & 0xff; this.setNZ(this.x); return "continue";
      case 0xcb: { const v = imm(); const r = (this.a & this.x) - v; this.c = r >= 0; this.x = r & 0xff; this.setNZ(this.x); return "continue"; }
      case 0xcc: { const v = this.read(absAddr()); this.c = this.y >= v; this.setNZ((this.y - v) & 0xff); return "continue"; }
      case 0xcd: { const v = this.read(absAddr()); this.c = this.a >= v; this.setNZ((this.a - v) & 0xff); return "continue"; }
      case 0xce: { const a = absAddr(); const v = (this.read(a) - 1) & 0xff; this.write(a, v); this.setNZ(v); return "continue"; }
      case 0xd0: { const t = rel(); if (!this.z) this.pc = t; return "continue"; }
      case 0xd2: return "jam";
      case 0xd8: this.d = false; return "continue";
      case 0xd9: { const v = this.read((absAddr() + this.y) & 0xffff); this.c = this.a >= v; this.setNZ((this.a - v) & 0xff); return "continue"; }
      case 0xdc: this.read((absAddr() + this.x) & 0xffff); return "continue";
      case 0xdd: { const v = this.read((absAddr() + this.x) & 0xffff); this.c = this.a >= v; this.setNZ((this.a - v) & 0xff); return "continue"; }
      case 0xdf: { const a = (absAddr() + this.x) & 0xffff; const v = (this.read(a) - 1) & 0xff; this.write(a, v); this.c = this.a >= v; this.setNZ((this.a - v) & 0xff); return "continue"; }
      case 0xe0: { const v = imm(); this.c = this.x >= v; this.setNZ((this.x - v) & 0xff); return "continue"; }
      case 0xe4: { const v = this.read(zpAddr()); this.c = this.x >= v; this.setNZ((this.x - v) & 0xff); return "continue"; }
      case 0xe5: this.sbc(this.read(zpAddr())); return "continue";
      case 0xe6: { const a = zpAddr(); const v = (this.mem[a]! + 1) & 0xff; this.mem[a] = v; this.setNZ(v); return "continue"; }
      case 0xe7: { const a = zpAddr(); const v = (this.mem[a]! + 1) & 0xff; this.mem[a] = v; this.sbc(v); return "continue"; }
      case 0xe8: this.x = (this.x + 1) & 0xff; this.setNZ(this.x); return "continue";
      case 0xe9: this.sbc(imm()); return "continue";
      case 0xea: return "continue";
      case 0xec: { const v = this.read(absAddr()); this.c = this.x >= v; this.setNZ((this.x - v) & 0xff); return "continue"; }
      case 0xed: this.sbc(this.read(absAddr())); return "continue";
      case 0xee: { const a = absAddr(); const v = (this.read(a) + 1) & 0xff; this.write(a, v); this.setNZ(v); return "continue"; }
      case 0xef: { const a = absAddr(); const v = (this.read(a) + 1) & 0xff; this.write(a, v); this.sbc(v); return "continue"; }
      case 0xf0: { const t = rel(); if (this.z) this.pc = t; return "continue"; }
      case 0xf1: { const z = zpAddr(); const addr = (this.readWord(z) + this.y) & 0xffff; this.sbc(this.read(addr)); return "continue"; }
      case 0xf2: return "jam";
      case 0xf4: this.read((zpAddr() + this.x) & 0xff); return "continue";
      case 0xf6: { const a = (zpAddr() + this.x) & 0xff; const v = (this.mem[a]! + 1) & 0xff; this.mem[a] = v; this.setNZ(v); return "continue"; }
      case 0xf7: { const a = (zpAddr() + this.x) & 0xff; const v = (this.mem[a]! + 1) & 0xff; this.mem[a] = v; this.sbc(v); return "continue"; }
      case 0xf8: this.d = true; return "continue";
      case 0xf9: this.sbc(this.read((absAddr() + this.y) & 0xffff)); return "continue";
      case 0xfa: return "continue";
      case 0xfb: { const a = (absAddr() + this.y) & 0xffff; const v = (this.read(a) + 1) & 0xff; this.write(a, v); this.sbc(v); return "continue"; }
      case 0xfd: this.sbc(this.read((absAddr() + this.x) & 0xffff)); return "continue";
      case 0xff: { const a = (absAddr() + this.x) & 0xffff; const v = (this.read(a) + 1) & 0xff; this.write(a, v); this.sbc(v); return "continue"; }

      // --- Missing documented NMOS opcodes (filled in to complete the 151-op set). ---
      case 0x0e: { const a = absAddr(); let v = this.read(a); this.c = (v & 0x80) !== 0; v = (v << 1) & 0xff; this.write(a, v); this.setNZ(v); return "continue"; }
      case 0x16: { const a = (zpAddr() + this.x) & 0xff; let v = this.mem[a]!; this.c = (v & 0x80) !== 0; v = (v << 1) & 0xff; this.mem[a] = v; this.setNZ(v); return "continue"; }
      case 0x1e: { const a = (absAddr() + this.x) & 0xffff; let v = this.read(a); this.c = (v & 0x80) !== 0; v = (v << 1) & 0xff; this.write(a, v); this.setNZ(v); return "continue"; }
      case 0x21: { const z = zpAddr(); const addr = this.readWord((z + this.x) & 0xff); this.a &= this.read(addr); this.setNZ(this.a); return "continue"; }
      case 0x24: { const v = this.read(zpAddr()); this.z = (this.a & v) === 0; this.n = (v & 0x80) !== 0; this.v = (v & 0x40) !== 0; return "continue"; }
      case 0x2d: this.a &= this.read(absAddr()); this.setNZ(this.a); return "continue";
      case 0x2e: { const a = absAddr(); const old = this.read(a); const newc = (old & 0x80) !== 0; const v = ((old << 1) | (this.c ? 1 : 0)) & 0xff; this.c = newc; this.write(a, v); this.setNZ(v); return "continue"; }
      case 0x31: { const z = zpAddr(); const addr = (this.readWord(z) + this.y) & 0xffff; this.a &= this.read(addr); this.setNZ(this.a); return "continue"; }
      case 0x36: { const a = (zpAddr() + this.x) & 0xff; const old = this.mem[a]!; const newc = (old & 0x80) !== 0; const v = ((old << 1) | (this.c ? 1 : 0)) & 0xff; this.c = newc; this.mem[a] = v; this.setNZ(v); return "continue"; }
      case 0x3e: { const a = (absAddr() + this.x) & 0xffff; const old = this.read(a); const newc = (old & 0x80) !== 0; const v = ((old << 1) | (this.c ? 1 : 0)) & 0xff; this.c = newc; this.write(a, v); this.setNZ(v); return "continue"; }
      case 0x41: { const z = zpAddr(); const addr = this.readWord((z + this.x) & 0xff); this.a ^= this.read(addr); this.setNZ(this.a); return "continue"; }
      case 0x4d: this.a ^= this.read(absAddr()); this.setNZ(this.a); return "continue";
      case 0x4e: { const a = absAddr(); let v = this.read(a); this.c = (v & 1) !== 0; v >>= 1; this.write(a, v); this.setNZ(v); return "continue"; }
      case 0x56: { const a = (zpAddr() + this.x) & 0xff; let v = this.mem[a]!; this.c = (v & 1) !== 0; v >>= 1; this.mem[a] = v; this.setNZ(v); return "continue"; }
      case 0x6c: {
        // JMP (indirect). NMOS page-wrap quirk: when the indirect pointer
        // straddles a page boundary ($XXFF), the high byte is fetched from
        // $XX00 of the same page, NOT $XY00 of the next page.
        const ind = absAddr();
        const lo = this.read(ind);
        const hiAddr = (ind & 0xff) === 0xff ? (ind & 0xff00) : (ind + 1) & 0xffff;
        const hi = this.read(hiAddr);
        this.pc = lo | (hi << 8);
        return "continue";
      }
      case 0x6d: this.adc(this.read(absAddr())); return "continue";
      case 0x6e: { const a = absAddr(); const old = this.read(a); const newc = (old & 1) !== 0; const v = (old >> 1) | (this.c ? 0x80 : 0); this.c = newc; this.write(a, v); this.setNZ(v); return "continue"; }
      case 0x81: { const z = zpAddr(); const addr = this.readWord((z + this.x) & 0xff); this.write(addr, this.a); return "continue"; }
      case 0x96: this.write((zpAddr() + this.y) & 0xff, this.x); return "continue";
      case 0xa1: { const z = zpAddr(); const addr = this.readWord((z + this.x) & 0xff); this.a = this.read(addr); this.setNZ(this.a); return "continue"; }
      case 0xb4: this.y = this.read((zpAddr() + this.x) & 0xff); this.setNZ(this.y); return "continue";
      case 0xc1: { const z = zpAddr(); const addr = this.readWord((z + this.x) & 0xff); const v = this.read(addr); this.c = this.a >= v; this.setNZ((this.a - v) & 0xff); return "continue"; }
      case 0xc4: { const v = this.read(zpAddr()); this.c = this.y >= v; this.setNZ((this.y - v) & 0xff); return "continue"; }
      case 0xd1: { const z = zpAddr(); const addr = (this.readWord(z) + this.y) & 0xffff; const v = this.read(addr); this.c = this.a >= v; this.setNZ((this.a - v) & 0xff); return "continue"; }
      case 0xd5: { const v = this.read((zpAddr() + this.x) & 0xff); this.c = this.a >= v; this.setNZ((this.a - v) & 0xff); return "continue"; }
      case 0xd6: { const a = (zpAddr() + this.x) & 0xff; const v = (this.mem[a]! - 1) & 0xff; this.mem[a] = v; this.setNZ(v); return "continue"; }
      case 0xde: { const a = (absAddr() + this.x) & 0xffff; const v = (this.read(a) - 1) & 0xff; this.write(a, v); this.setNZ(v); return "continue"; }
      case 0xe1: { const z = zpAddr(); const addr = this.readWord((z + this.x) & 0xff); this.sbc(this.read(addr)); return "continue"; }
      case 0xf5: this.sbc(this.read((zpAddr() + this.x) & 0xff)); return "continue";
      case 0xfe: { const a = (absAddr() + this.x) & 0xffff; const v = (this.read(a) + 1) & 0xff; this.write(a, v); this.setNZ(v); return "continue"; }

      // --- Remaining NMOS JAM opcodes (illegal halts). Returning "jam" lets
      // callers see the halt instead of an unimplemented_opcode error.
      case 0x02: case 0x12: case 0x22: case 0x32: case 0x42: case 0x52:
      case 0x62: case 0x72: case 0x92: case 0xb2:
        return "jam";

      // --- Additional undocumented NOPs (per riff.2ix.at illops table). ---
      case 0x3a: case 0x5a: case 0x7a: case 0xda: return "continue";
      case 0x82: case 0xc2: case 0xe2: imm(); return "continue";
      case 0x04: case 0x44: case 0x64: zpAddr(); return "continue";
      case 0x14: case 0x34: case 0x54: case 0x74: case 0xd4: zpAddr(); return "continue";
      case 0x1c: case 0x3c: case 0x5c: case 0x7c: case 0xfc: this.read((absAddr() + this.x) & 0xffff); return "continue";

      // --- USBC ($EB) — undocumented duplicate of SBC #imm ($E9). ---
      case 0xeb: this.sbc(imm()); return "continue";

      // --- SLO (ASL + ORA): $03, $07, $0F, $13, $17, $1B ($1F handled above). ---
      case 0x03: { const z = zpAddr(); const a = this.readWord((z + this.x) & 0xff); let v = this.read(a); this.c = (v & 0x80) !== 0; v = (v << 1) & 0xff; this.write(a, v); this.a = (this.a | v) & 0xff; this.setNZ(this.a); return "continue"; }
      case 0x07: { const a = zpAddr(); let v = this.mem[a]!; this.c = (v & 0x80) !== 0; v = (v << 1) & 0xff; this.mem[a] = v; this.a = (this.a | v) & 0xff; this.setNZ(this.a); return "continue"; }
      case 0x0f: { const a = absAddr(); let v = this.read(a); this.c = (v & 0x80) !== 0; v = (v << 1) & 0xff; this.write(a, v); this.a = (this.a | v) & 0xff; this.setNZ(this.a); return "continue"; }
      case 0x13: { const z = zpAddr(); const a = (this.readWord(z) + this.y) & 0xffff; let v = this.read(a); this.c = (v & 0x80) !== 0; v = (v << 1) & 0xff; this.write(a, v); this.a = (this.a | v) & 0xff; this.setNZ(this.a); return "continue"; }
      case 0x17: { const a = (zpAddr() + this.x) & 0xff; let v = this.mem[a]!; this.c = (v & 0x80) !== 0; v = (v << 1) & 0xff; this.mem[a] = v; this.a = (this.a | v) & 0xff; this.setNZ(this.a); return "continue"; }
      case 0x1b: { const a = (absAddr() + this.y) & 0xffff; let v = this.read(a); this.c = (v & 0x80) !== 0; v = (v << 1) & 0xff; this.write(a, v); this.a = (this.a | v) & 0xff; this.setNZ(this.a); return "continue"; }

      // --- RLA (ROL + AND): $23, $27, $33 ($2F, $37, $3B, $3F handled above). ---
      case 0x23: { const z = zpAddr(); const a = this.readWord((z + this.x) & 0xff); const old = this.read(a); const newc = (old & 0x80) !== 0; const v = ((old << 1) | (this.c ? 1 : 0)) & 0xff; this.c = newc; this.write(a, v); this.a &= v; this.setNZ(this.a); return "continue"; }
      case 0x27: { const a = zpAddr(); const old = this.mem[a]!; const newc = (old & 0x80) !== 0; const v = ((old << 1) | (this.c ? 1 : 0)) & 0xff; this.c = newc; this.mem[a] = v; this.a &= v; this.setNZ(this.a); return "continue"; }
      case 0x33: { const z = zpAddr(); const a = (this.readWord(z) + this.y) & 0xffff; const old = this.read(a); const newc = (old & 0x80) !== 0; const v = ((old << 1) | (this.c ? 1 : 0)) & 0xff; this.c = newc; this.write(a, v); this.a &= v; this.setNZ(this.a); return "continue"; }

      // --- SRE (LSR + EOR): $43, $4F, $53, $5B, $5F ($47, $57 handled above). ---
      case 0x43: { const z = zpAddr(); const a = this.readWord((z + this.x) & 0xff); let v = this.read(a); this.c = (v & 1) !== 0; v >>= 1; this.write(a, v); this.a ^= v; this.setNZ(this.a); return "continue"; }
      case 0x4f: { const a = absAddr(); let v = this.read(a); this.c = (v & 1) !== 0; v >>= 1; this.write(a, v); this.a ^= v; this.setNZ(this.a); return "continue"; }
      case 0x53: { const z = zpAddr(); const a = (this.readWord(z) + this.y) & 0xffff; let v = this.read(a); this.c = (v & 1) !== 0; v >>= 1; this.write(a, v); this.a ^= v; this.setNZ(this.a); return "continue"; }
      case 0x5b: { const a = (absAddr() + this.y) & 0xffff; let v = this.read(a); this.c = (v & 1) !== 0; v >>= 1; this.write(a, v); this.a ^= v; this.setNZ(this.a); return "continue"; }
      case 0x5f: { const a = (absAddr() + this.x) & 0xffff; let v = this.read(a); this.c = (v & 1) !== 0; v >>= 1; this.write(a, v); this.a ^= v; this.setNZ(this.a); return "continue"; }

      // --- RRA (ROR + ADC): $63, $6F, $73, $77, $7F ($67, $7B handled above). ---
      case 0x63: { const z = zpAddr(); const a = this.readWord((z + this.x) & 0xff); const old = this.read(a); const newc = (old & 1) !== 0; const v = (old >> 1) | (this.c ? 0x80 : 0); this.c = newc; this.write(a, v); this.adc(v); return "continue"; }
      case 0x6f: { const a = absAddr(); const old = this.read(a); const newc = (old & 1) !== 0; const v = (old >> 1) | (this.c ? 0x80 : 0); this.c = newc; this.write(a, v); this.adc(v); return "continue"; }
      case 0x73: { const z = zpAddr(); const a = (this.readWord(z) + this.y) & 0xffff; const old = this.read(a); const newc = (old & 1) !== 0; const v = (old >> 1) | (this.c ? 0x80 : 0); this.c = newc; this.write(a, v); this.adc(v); return "continue"; }
      case 0x77: { const a = (zpAddr() + this.x) & 0xff; const old = this.mem[a]!; const newc = (old & 1) !== 0; const v = (old >> 1) | (this.c ? 0x80 : 0); this.c = newc; this.mem[a] = v; this.adc(v); return "continue"; }
      case 0x7f: { const a = (absAddr() + this.x) & 0xffff; const old = this.read(a); const newc = (old & 1) !== 0; const v = (old >> 1) | (this.c ? 0x80 : 0); this.c = newc; this.write(a, v); this.adc(v); return "continue"; }

      // --- DCP (DEC + CMP): $C3, $CF, $D3, $D7, $DB ($C7, $DF handled above). ---
      case 0xc3: { const z = zpAddr(); const a = this.readWord((z + this.x) & 0xff); const v = (this.read(a) - 1) & 0xff; this.write(a, v); this.c = this.a >= v; this.setNZ((this.a - v) & 0xff); return "continue"; }
      case 0xcf: { const a = absAddr(); const v = (this.read(a) - 1) & 0xff; this.write(a, v); this.c = this.a >= v; this.setNZ((this.a - v) & 0xff); return "continue"; }
      case 0xd3: { const z = zpAddr(); const a = (this.readWord(z) + this.y) & 0xffff; const v = (this.read(a) - 1) & 0xff; this.write(a, v); this.c = this.a >= v; this.setNZ((this.a - v) & 0xff); return "continue"; }
      case 0xd7: { const a = (zpAddr() + this.x) & 0xff; const v = (this.mem[a]! - 1) & 0xff; this.mem[a] = v; this.c = this.a >= v; this.setNZ((this.a - v) & 0xff); return "continue"; }
      case 0xdb: { const a = (absAddr() + this.y) & 0xffff; const v = (this.read(a) - 1) & 0xff; this.write(a, v); this.c = this.a >= v; this.setNZ((this.a - v) & 0xff); return "continue"; }

      // --- ISC / ISB (INC + SBC): $E3, $F3 (others handled above). ---
      case 0xe3: { const z = zpAddr(); const a = this.readWord((z + this.x) & 0xff); const v = (this.read(a) + 1) & 0xff; this.write(a, v); this.sbc(v); return "continue"; }
      case 0xf3: { const z = zpAddr(); const a = (this.readWord(z) + this.y) & 0xffff; const v = (this.read(a) + 1) & 0xff; this.write(a, v); this.sbc(v); return "continue"; }

      // --- SAX (A AND X → memory): $83, $8F (others handled above). ---
      case 0x83: { const z = zpAddr(); const a = this.readWord((z + this.x) & 0xff); this.write(a, this.a & this.x); return "continue"; }
      case 0x8f: this.write(absAddr(), this.a & this.x); return "continue";

      // --- LAX (LDA + LDX): $B3, $AB (others handled above). ---
      // $AB (LAX #imm) is unstable on real hardware ("magic constant" mixed
      // with A); the common convention is `A = X = imm` which is what most
      // documented depackers actually rely on.
      case 0xb3: { const z = zpAddr(); const addr = (this.readWord(z) + this.y) & 0xffff; const v = this.read(addr); this.a = v; this.x = v; this.setNZ(v); return "continue"; }
      case 0xab: { const v = imm(); this.a = v; this.x = v; this.setNZ(v); return "continue"; }

      // --- ANC ($0B, $2B): A &= imm, then C ← N. ---
      case 0x0b: case 0x2b: { this.a &= imm(); this.setNZ(this.a); this.c = (this.a & 0x80) !== 0; return "continue"; }

      // --- XAA / ANE ($8B): unstable. Common emulation: A = (A | $EE) & X & imm. ---
      case 0x8b: { const v = imm(); this.a = (this.a | 0xee) & this.x & v; this.setNZ(this.a); return "continue"; }

      // --- TAS ($9B): SP = A & X; mem[abs+Y] = A & X & (highByte+1). ---
      case 0x9b: { const lo = this.read(this.pc); const hi = this.read((this.pc + 1) & 0xffff); this.pc = (this.pc + 2) & 0xffff; const base = lo | (hi << 8); const addr = (base + this.y) & 0xffff; this.sp = this.a & this.x; this.write(addr, this.a & this.x & ((hi + 1) & 0xff)); return "continue"; }

      // --- AHX / SHA ($93 indy, $9F absy): mem = A & X & (highByte+1). ---
      case 0x93: { const z = zpAddr(); const base = this.readWord(z); const hi = (base >> 8) & 0xff; const addr = (base + this.y) & 0xffff; this.write(addr, this.a & this.x & ((hi + 1) & 0xff)); return "continue"; }
      case 0x9f: { const lo = this.read(this.pc); const hi = this.read((this.pc + 1) & 0xffff); this.pc = (this.pc + 2) & 0xffff; const addr = ((lo | (hi << 8)) + this.y) & 0xffff; this.write(addr, this.a & this.x & ((hi + 1) & 0xff)); return "continue"; }

      // --- SHX ($9E absy): mem = X & (highByte+1). ---
      case 0x9e: { const lo = this.read(this.pc); const hi = this.read((this.pc + 1) & 0xffff); this.pc = (this.pc + 2) & 0xffff; const addr = ((lo | (hi << 8)) + this.y) & 0xffff; this.write(addr, this.x & ((hi + 1) & 0xff)); return "continue"; }

      // --- SHY ($9C absx): mem = Y & (highByte+1). ---
      case 0x9c: { const lo = this.read(this.pc); const hi = this.read((this.pc + 1) & 0xffff); this.pc = (this.pc + 2) & 0xffff; const addr = ((lo | (hi << 8)) + this.x) & 0xffff; this.write(addr, this.y & ((hi + 1) & 0xff)); return "continue"; }

      default:
        // Roll PC back so caller sees the offending opcode.
        this.pc = (this.pc - 1) & 0xffff;
        return "unimplemented_opcode";
    }
  }

  private adc(v: number): boolean {
    const r = this.a + v + (this.c ? 1 : 0);
    this.v = (((this.a ^ r) & (v ^ r)) & 0x80) !== 0;
    this.c = r > 0xff;
    this.a = r & 0xff;
    this.setNZ(this.a);
    return true;
  }

  private sbc(v: number): boolean {
    const inv = v ^ 0xff;
    const r = this.a + inv + (this.c ? 1 : 0);
    this.v = (((this.a ^ r) & (inv ^ r)) & 0x80) !== 0;
    this.c = r > 0xff;
    this.a = r & 0xff;
    this.setNZ(this.a);
    return true;
  }
}
