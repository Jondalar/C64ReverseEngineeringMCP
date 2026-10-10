// A tiny two-pass 6502 assembler for synthetic test PRGs: only the opcodes the e2e programs
// use, labels, `<label` / `>label`, and relative branches. Not a general tool — a test that
// builds its bytes from a listing it can read, with no assembler installed on the runner.

const OPS = {
  SEI: { imp: 0x78 }, CLI: { imp: 0x58 }, PHA: { imp: 0x48 }, PLA: { imp: 0x68 }, RTI: { imp: 0x40 },
  INX: { imp: 0xe8 }, INY: { imp: 0xc8 }, SEC: { imp: 0x38 },
  LDA: { imm: 0xa9, abs: 0xad, zp: 0xa5 }, STA: { abs: 0x8d, zp: 0x85 },
  AND: { imm: 0x29 }, ORA: { imm: 0x09 }, EOR: { imm: 0x49 },
  CMP: { imm: 0xc9, zp: 0xc5, abs: 0xcd }, SBC: { imm: 0xe9 },
  LDX: { imm: 0xa2 }, LDY: { imm: 0xa0 }, CPY: { imm: 0xc0 },
  INC: { abs: 0xee, zp: 0xe6 }, JMP: { abs: 0x4c },
  BNE: { rel: 0xd0 }, BEQ: { rel: 0xf0 }, BCC: { rel: 0x90 },
};

/** `prog`: lines like "LDA #$7F", "STA $D011", "loop:", "BNE loop", "LDA #<irq". Returns the bytes. */
export function assemble(origin, prog) {
  const labels = new Map();
  const value = (tok, here) => {
    if (/^\$[0-9a-f]+$/i.test(tok)) return parseInt(tok.slice(1), 16);
    if (/^\d+$/.test(tok)) return Number(tok);
    if (tok.startsWith("<")) return (value(tok.slice(1), here) ?? 0) & 0xff;
    if (tok.startsWith(">")) return ((value(tok.slice(1), here) ?? 0) >> 8) & 0xff;
    return labels.get(tok);
  };
  const encode = (line, pc, final) => {
    const m = line.trim().match(/^([A-Z]{3})(?:\s+(.+))?$/);
    if (!m) throw new Error(`cannot assemble "${line}"`);
    const op = OPS[m[1]];
    if (!op) throw new Error(`no opcode ${m[1]}`);
    const arg = m[2]?.trim();
    if (arg === undefined) return [op.imp];
    if (arg.startsWith("#")) return [op.imm, value(arg.slice(1), pc) ?? 0];
    if (op.rel !== undefined) {
      const t = value(arg, pc);
      if (t === undefined) { if (final) throw new Error(`no label ${arg}`); return [op.rel, 0]; }
      const d = t - (pc + 2);
      if (final && (d < -128 || d > 127)) throw new Error(`branch to ${arg} is out of range`);
      return [op.rel, d & 0xff];
    }
    const v = value(arg, pc);
    if (v === undefined) { if (final) throw new Error(`no label ${arg}`); return [op.abs, 0, 0]; }
    if (v < 0x100 && op.zp !== undefined && /^\$[0-9a-f]{1,2}$/i.test(arg)) return [op.zp, v];
    return [op.abs, v & 0xff, v >> 8];
  };
  for (const final of [false, true]) {
    let pc = origin;
    const out = [];
    for (const line of prog) {
      const l = line.trim();
      if (l.endsWith(":")) { labels.set(l.slice(0, -1), pc); continue; }
      const b = encode(l, pc, final);
      out.push(...b);
      pc += b.length;
    }
    if (final) return out;
  }
}

/** A PRG at $0801: `10 SYS2061`, then the code at $080D. */
export function prgWithStub(prog) {
  const stub = [0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00];
  return Buffer.from([...stub, ...assemble(0x080d, prog)]);
}
