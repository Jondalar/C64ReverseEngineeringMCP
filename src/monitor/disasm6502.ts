// Self-contained 6502/6510 disassembler for the headless debugger
// (monitor/exec in ws-server). ESM, no pipeline dependency — the
// opcode table is a verbatim copy of pipeline/src/lib/mos6502.ts OPCODES
// (full 256 incl. undocumented). Used by the UI monitor `d` command and
// step-over (`n`) to know instruction sizes.

export type AddressingMode =
  | "impl" | "acc" | "imm" | "zp" | "zp,x" | "zp,y"
  | "abs" | "abs,x" | "abs,y" | "ind" | "(zp,x)" | "(zp),y" | "rel";

interface OpDef { mnemonic: string; mode: AddressingMode; size: 1 | 2 | 3; }

const OPCODES: (OpDef | undefined)[] = [];
const def = (op: number, mnemonic: string, mode: AddressingMode, size: 1 | 2 | 3) => {
  OPCODES[op] = { mnemonic, mode, size };
};
// verbatim from pipeline mos6502 OPCODES
def(0x00,"brk","impl",1); def(0x01,"ora","(zp,x)",2); def(0x02,"jam","impl",1); def(0x03,"slo","(zp,x)",2);
def(0x04,"nop","zp",2); def(0x05,"ora","zp",2); def(0x06,"asl","zp",2); def(0x07,"slo","zp",2);
def(0x08,"php","impl",1); def(0x09,"ora","imm",2); def(0x0a,"asl","acc",1); def(0x0b,"anc","imm",2);
def(0x0c,"nop","abs",3); def(0x0d,"ora","abs",3); def(0x0e,"asl","abs",3); def(0x0f,"slo","abs",3);
def(0x10,"bpl","rel",2); def(0x11,"ora","(zp),y",2); def(0x12,"jam","impl",1); def(0x13,"slo","(zp),y",2);
def(0x14,"nop","zp,x",2); def(0x15,"ora","zp,x",2); def(0x16,"asl","zp,x",2); def(0x17,"slo","zp,x",2);
def(0x18,"clc","impl",1); def(0x19,"ora","abs,y",3); def(0x1a,"nop","impl",1); def(0x1b,"slo","abs,y",3);
def(0x1c,"nop","abs,x",3); def(0x1d,"ora","abs,x",3); def(0x1e,"asl","abs,x",3); def(0x1f,"slo","abs,x",3);
def(0x20,"jsr","abs",3); def(0x21,"and","(zp,x)",2); def(0x22,"jam","impl",1); def(0x23,"rla","(zp,x)",2);
def(0x24,"bit","zp",2); def(0x25,"and","zp",2); def(0x26,"rol","zp",2); def(0x27,"rla","zp",2);
def(0x28,"plp","impl",1); def(0x29,"and","imm",2); def(0x2a,"rol","acc",1); def(0x2b,"anc","imm",2);
def(0x2c,"bit","abs",3); def(0x2d,"and","abs",3); def(0x2e,"rol","abs",3); def(0x2f,"rla","abs",3);
def(0x30,"bmi","rel",2); def(0x31,"and","(zp),y",2); def(0x32,"jam","impl",1); def(0x33,"rla","(zp),y",2);
def(0x34,"nop","zp,x",2); def(0x35,"and","zp,x",2); def(0x36,"rol","zp,x",2); def(0x37,"rla","zp,x",2);
def(0x38,"sec","impl",1); def(0x39,"and","abs,y",3); def(0x3a,"nop","impl",1); def(0x3b,"rla","abs,y",3);
def(0x3c,"nop","abs,x",3); def(0x3d,"and","abs,x",3); def(0x3e,"rol","abs,x",3); def(0x3f,"rla","abs,x",3);
def(0x40,"rti","impl",1); def(0x41,"eor","(zp,x)",2); def(0x42,"jam","impl",1); def(0x43,"sre","(zp,x)",2);
def(0x44,"nop","zp",2); def(0x45,"eor","zp",2); def(0x46,"lsr","zp",2); def(0x47,"sre","zp",2);
def(0x48,"pha","impl",1); def(0x49,"eor","imm",2); def(0x4a,"lsr","acc",1); def(0x4b,"alr","imm",2);
def(0x4c,"jmp","abs",3); def(0x4d,"eor","abs",3); def(0x4e,"lsr","abs",3); def(0x4f,"sre","abs",3);
def(0x50,"bvc","rel",2); def(0x51,"eor","(zp),y",2); def(0x52,"jam","impl",1); def(0x53,"sre","(zp),y",2);
def(0x54,"nop","zp,x",2); def(0x55,"eor","zp,x",2); def(0x56,"lsr","zp,x",2); def(0x57,"sre","zp,x",2);
def(0x58,"cli","impl",1); def(0x59,"eor","abs,y",3); def(0x5a,"nop","impl",1); def(0x5b,"sre","abs,y",3);
def(0x5c,"nop","abs,x",3); def(0x5d,"eor","abs,x",3); def(0x5e,"lsr","abs,x",3); def(0x5f,"sre","abs,x",3);
def(0x60,"rts","impl",1); def(0x61,"adc","(zp,x)",2); def(0x62,"jam","impl",1); def(0x63,"rra","(zp,x)",2);
def(0x64,"nop","zp",2); def(0x65,"adc","zp",2); def(0x66,"ror","zp",2); def(0x67,"rra","zp",2);
def(0x68,"pla","impl",1); def(0x69,"adc","imm",2); def(0x6a,"ror","acc",1); def(0x6b,"arr","imm",2);
def(0x6c,"jmp","ind",3); def(0x6d,"adc","abs",3); def(0x6e,"ror","abs",3); def(0x6f,"rra","abs",3);
def(0x70,"bvs","rel",2); def(0x71,"adc","(zp),y",2); def(0x72,"jam","impl",1); def(0x73,"rra","(zp),y",2);
def(0x74,"nop","zp,x",2); def(0x75,"adc","zp,x",2); def(0x76,"ror","zp,x",2); def(0x77,"rra","zp,x",2);
def(0x78,"sei","impl",1); def(0x79,"adc","abs,y",3); def(0x7a,"nop","impl",1); def(0x7b,"rra","abs,y",3);
def(0x7c,"nop","abs,x",3); def(0x7d,"adc","abs,x",3); def(0x7e,"ror","abs,x",3); def(0x7f,"rra","abs,x",3);
def(0x80,"nop","imm",2); def(0x81,"sta","(zp,x)",2); def(0x82,"nop","imm",2); def(0x83,"sax","(zp,x)",2);
def(0x84,"sty","zp",2); def(0x85,"sta","zp",2); def(0x86,"stx","zp",2); def(0x87,"sax","zp",2);
def(0x88,"dey","impl",1); def(0x89,"nop","imm",2); def(0x8a,"txa","impl",1); def(0x8b,"xaa","imm",2);
def(0x8c,"sty","abs",3); def(0x8d,"sta","abs",3); def(0x8e,"stx","abs",3); def(0x8f,"sax","abs",3);
def(0x90,"bcc","rel",2); def(0x91,"sta","(zp),y",2); def(0x92,"jam","impl",1); def(0x93,"ahx","(zp),y",2);
def(0x94,"sty","zp,x",2); def(0x95,"sta","zp,x",2); def(0x96,"stx","zp,y",2); def(0x97,"sax","zp,y",2);
def(0x98,"tya","impl",1); def(0x99,"sta","abs,y",3); def(0x9a,"txs","impl",1); def(0x9b,"tas","abs,y",3);
def(0x9c,"shy","abs,x",3); def(0x9d,"sta","abs,x",3); def(0x9e,"shx","abs,y",3); def(0x9f,"ahx","abs,y",3);
def(0xa0,"ldy","imm",2); def(0xa1,"lda","(zp,x)",2); def(0xa2,"ldx","imm",2); def(0xa3,"lax","(zp,x)",2);
def(0xa4,"ldy","zp",2); def(0xa5,"lda","zp",2); def(0xa6,"ldx","zp",2); def(0xa7,"lax","zp",2);
def(0xa8,"tay","impl",1); def(0xa9,"lda","imm",2); def(0xaa,"tax","impl",1); def(0xab,"lax","imm",2);
def(0xac,"ldy","abs",3); def(0xad,"lda","abs",3); def(0xae,"ldx","abs",3); def(0xaf,"lax","abs",3);
def(0xb0,"bcs","rel",2); def(0xb1,"lda","(zp),y",2); def(0xb2,"jam","impl",1); def(0xb3,"lax","(zp),y",2);
def(0xb4,"ldy","zp,x",2); def(0xb5,"lda","zp,x",2); def(0xb6,"ldx","zp,y",2); def(0xb7,"lax","zp,y",2);
def(0xb8,"clv","impl",1); def(0xb9,"lda","abs,y",3); def(0xba,"tsx","impl",1); def(0xbb,"las","abs,y",3);
def(0xbc,"ldy","abs,x",3); def(0xbd,"lda","abs,x",3); def(0xbe,"ldx","abs,y",3); def(0xbf,"lax","abs,y",3);
def(0xc0,"cpy","imm",2); def(0xc1,"cmp","(zp,x)",2); def(0xc2,"nop","imm",2); def(0xc3,"dcp","(zp,x)",2);
def(0xc4,"cpy","zp",2); def(0xc5,"cmp","zp",2); def(0xc6,"dec","zp",2); def(0xc7,"dcp","zp",2);
def(0xc8,"iny","impl",1); def(0xc9,"cmp","imm",2); def(0xca,"dex","impl",1); def(0xcb,"axs","imm",2);
def(0xcc,"cpy","abs",3); def(0xcd,"cmp","abs",3); def(0xce,"dec","abs",3); def(0xcf,"dcp","abs",3);
def(0xd0,"bne","rel",2); def(0xd1,"cmp","(zp),y",2); def(0xd2,"jam","impl",1); def(0xd3,"dcp","(zp),y",2);
def(0xd4,"nop","zp,x",2); def(0xd5,"cmp","zp,x",2); def(0xd6,"dec","zp,x",2); def(0xd7,"dcp","zp,x",2);
def(0xd8,"cld","impl",1); def(0xd9,"cmp","abs,y",3); def(0xda,"nop","impl",1); def(0xdb,"dcp","abs,y",3);
def(0xdc,"nop","abs,x",3); def(0xdd,"cmp","abs,x",3); def(0xde,"dec","abs,x",3); def(0xdf,"dcp","abs,x",3);
def(0xe0,"cpx","imm",2); def(0xe1,"sbc","(zp,x)",2); def(0xe2,"nop","imm",2); def(0xe3,"isc","(zp,x)",2);
def(0xe4,"cpx","zp",2); def(0xe5,"sbc","zp",2); def(0xe6,"inc","zp",2); def(0xe7,"isc","zp",2);
def(0xe8,"inx","impl",1); def(0xe9,"sbc","imm",2); def(0xea,"nop","impl",1); def(0xeb,"sbc","imm",2);
def(0xec,"cpx","abs",3); def(0xed,"sbc","abs",3); def(0xee,"inc","abs",3); def(0xef,"isc","abs",3);
def(0xf0,"beq","rel",2); def(0xf1,"sbc","(zp),y",2); def(0xf2,"jam","impl",1); def(0xf3,"isc","(zp),y",2);
def(0xf4,"nop","zp,x",2); def(0xf5,"sbc","zp,x",2); def(0xf6,"inc","zp,x",2); def(0xf7,"isc","zp,x",2);
def(0xf8,"sed","impl",1); def(0xf9,"sbc","abs,y",3); def(0xfa,"nop","impl",1); def(0xfb,"isc","abs,y",3);
def(0xfc,"nop","abs,x",3); def(0xfd,"sbc","abs,x",3); def(0xfe,"inc","abs,x",3); def(0xff,"isc","abs,x",3);

export interface Disasm6502 {
  address: number;
  opcode: number;
  size: number;
  mnemonic: string;
  mode: AddressingMode;
  operand?: number;
  target?: number;   // branch / abs target for jumps
  isJsr: boolean;
  text: string;      // formatted operand, VICE-ish ("$1234" / "#$0a" / "($fb),y")
}

const hx = (n: number, w: number) => n.toString(16).padStart(w, "0");

/** Decode one instruction. `read(addr)` returns the byte at addr (0..255). */
export function disasm6502(read: (addr: number) => number, addr: number): Disasm6502 {
  const opcode = read(addr) & 0xff;
  const d = OPCODES[opcode];
  if (!d) {
    return { address: addr, opcode, size: 1, mnemonic: "???", mode: "impl", isJsr: false, text: "" };
  }
  const b1 = read((addr + 1) & 0xffff) & 0xff;
  const b2 = read((addr + 2) & 0xffff) & 0xff;
  let operand: number | undefined;
  let target: number | undefined;
  if (d.size === 2) operand = b1;
  else if (d.size === 3) operand = b1 | (b2 << 8);

  let text = "";
  switch (d.mode) {
    case "impl": case "acc": text = ""; break;
    case "imm": text = `#$${hx(operand!, 2)}`; break;
    case "zp": text = `$${hx(operand!, 2)}`; break;
    case "zp,x": text = `$${hx(operand!, 2)},x`; break;
    case "zp,y": text = `$${hx(operand!, 2)},y`; break;
    case "abs": text = `$${hx(operand!, 4)}`; target = operand; break;
    case "abs,x": text = `$${hx(operand!, 4)},x`; break;
    case "abs,y": text = `$${hx(operand!, 4)},y`; break;
    case "ind": text = `($${hx(operand!, 4)})`; break;
    case "(zp,x)": text = `($${hx(operand!, 2)},x)`; break;
    case "(zp),y": text = `($${hx(operand!, 2)}),y`; break;
    case "rel": {
      const signed = operand! >= 0x80 ? operand! - 0x100 : operand!;
      target = (addr + d.size + signed) & 0xffff;
      text = `$${hx(target, 4)}`;
      break;
    }
  }
  return {
    address: addr, opcode, size: d.size, mnemonic: d.mnemonic, mode: d.mode,
    operand, target, isJsr: opcode === 0x20, text,
  };
}

/** Format one line: `$addr  bb bb bb  MNEMONIC ops`. Bytes padded to a
 *  fixed 3-byte column (max instruction length) so mnemonics align;
 *  mnemonic upper-cased, operand hex lower-case (VICE-ish). */
export function disasmLine(
  read: (addr: number) => number,
  addr: number,
  labels?: Map<number, string>,
): { size: number; line: string } {
  const di = disasm6502(read, addr);
  const bytes: string[] = [];
  for (let i = 0; i < di.size; i++) bytes.push(hx(read((addr + i) & 0xffff) & 0xff, 2));
  const ops = di.text ? ` ${di.text}` : "";
  // "bb bb bb" = 8 chars max; pad to 8 so the mnemonic column is fixed
  let line = `$${hx(addr, 4)}  ${bytes.join(" ").padEnd(8)}  ${di.mnemonic.toUpperCase()}${ops}`;
  // Spec 754 §3.3f (Block F) — annotate with user/segment labels. The numeric
  // address is ALWAYS kept (operand hex stays); the name is added as a comment,
  // and the instruction's OWN address gets an asm-style `name:` line above it.
  // Both the label AND the numeric address stay visible together.
  if (labels) {
    const tgt = di.target ?? (di.size === 3 ? di.operand : undefined);
    const tname = tgt !== undefined ? labels.get(tgt & 0xffff) : undefined;
    if (tname) line += `   ; → ${tname}`;
    const own = labels.get(addr & 0xffff);
    if (own) line = `${own}:\n${line}`;
  }
  return { size: di.size, line };
}
