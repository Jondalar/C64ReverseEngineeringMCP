// Static metadata for 6502 opcodes — used to format helpful error messages
// and (later) to drive a per-opcode regression test harness.
//
// Convention for `mode`:
//   imp   implied / accumulator
//   imm   #immediate
//   zp    zeropage
//   zpx   zeropage,X
//   zpy   zeropage,Y
//   abs   absolute
//   absx  absolute,X
//   absy  absolute,Y
//   ind   (indirect)
//   indx  (indirect,X)
//   indy  (indirect),Y
//   rel   relative branch
//
// `legal` is true for the 151 official NMOS opcodes; false for the
// commonly-encountered "illegal" / undocumented set.

export type OpcodeMode =
  | "imp" | "imm" | "zp" | "zpx" | "zpy"
  | "abs" | "absx" | "absy"
  | "ind" | "indx" | "indy" | "rel";

export interface OpcodeInfo {
  mnemonic: string;
  mode: OpcodeMode;
  legal: boolean;
}

const T: Record<number, OpcodeInfo> = {};

function add(opcode: number, mnemonic: string, mode: OpcodeMode, legal = true): void {
  T[opcode] = { mnemonic, mode, legal };
}

// --- Documented NMOS 6502 (151 opcodes) ---
add(0x69, "ADC", "imm");  add(0x65, "ADC", "zp");   add(0x75, "ADC", "zpx");
add(0x6d, "ADC", "abs");  add(0x7d, "ADC", "absx"); add(0x79, "ADC", "absy");
add(0x61, "ADC", "indx"); add(0x71, "ADC", "indy");

add(0x29, "AND", "imm");  add(0x25, "AND", "zp");   add(0x35, "AND", "zpx");
add(0x2d, "AND", "abs");  add(0x3d, "AND", "absx"); add(0x39, "AND", "absy");
add(0x21, "AND", "indx"); add(0x31, "AND", "indy");

add(0x0a, "ASL", "imp");  add(0x06, "ASL", "zp");   add(0x16, "ASL", "zpx");
add(0x0e, "ASL", "abs");  add(0x1e, "ASL", "absx");

add(0x90, "BCC", "rel"); add(0xb0, "BCS", "rel");
add(0xf0, "BEQ", "rel"); add(0x30, "BMI", "rel");
add(0xd0, "BNE", "rel"); add(0x10, "BPL", "rel");
add(0x50, "BVC", "rel"); add(0x70, "BVS", "rel");

add(0x24, "BIT", "zp"); add(0x2c, "BIT", "abs");
add(0x00, "BRK", "imp");

add(0x18, "CLC", "imp"); add(0xd8, "CLD", "imp");
add(0x58, "CLI", "imp"); add(0xb8, "CLV", "imp");

add(0xc9, "CMP", "imm");  add(0xc5, "CMP", "zp");   add(0xd5, "CMP", "zpx");
add(0xcd, "CMP", "abs");  add(0xdd, "CMP", "absx"); add(0xd9, "CMP", "absy");
add(0xc1, "CMP", "indx"); add(0xd1, "CMP", "indy");

add(0xe0, "CPX", "imm"); add(0xe4, "CPX", "zp"); add(0xec, "CPX", "abs");
add(0xc0, "CPY", "imm"); add(0xc4, "CPY", "zp"); add(0xcc, "CPY", "abs");

add(0xc6, "DEC", "zp");  add(0xd6, "DEC", "zpx");
add(0xce, "DEC", "abs"); add(0xde, "DEC", "absx");
add(0xca, "DEX", "imp"); add(0x88, "DEY", "imp");

add(0x49, "EOR", "imm");  add(0x45, "EOR", "zp");   add(0x55, "EOR", "zpx");
add(0x4d, "EOR", "abs");  add(0x5d, "EOR", "absx"); add(0x59, "EOR", "absy");
add(0x41, "EOR", "indx"); add(0x51, "EOR", "indy");

add(0xe6, "INC", "zp");  add(0xf6, "INC", "zpx");
add(0xee, "INC", "abs"); add(0xfe, "INC", "absx");
add(0xe8, "INX", "imp"); add(0xc8, "INY", "imp");

add(0x4c, "JMP", "abs"); add(0x6c, "JMP", "ind");
add(0x20, "JSR", "abs");

add(0xa9, "LDA", "imm");  add(0xa5, "LDA", "zp");   add(0xb5, "LDA", "zpx");
add(0xad, "LDA", "abs");  add(0xbd, "LDA", "absx"); add(0xb9, "LDA", "absy");
add(0xa1, "LDA", "indx"); add(0xb1, "LDA", "indy");

add(0xa2, "LDX", "imm"); add(0xa6, "LDX", "zp");  add(0xb6, "LDX", "zpy");
add(0xae, "LDX", "abs"); add(0xbe, "LDX", "absy");

add(0xa0, "LDY", "imm"); add(0xa4, "LDY", "zp");  add(0xb4, "LDY", "zpx");
add(0xac, "LDY", "abs"); add(0xbc, "LDY", "absx");

add(0x4a, "LSR", "imp"); add(0x46, "LSR", "zp");  add(0x56, "LSR", "zpx");
add(0x4e, "LSR", "abs"); add(0x5e, "LSR", "absx");

add(0xea, "NOP", "imp");

add(0x09, "ORA", "imm");  add(0x05, "ORA", "zp");   add(0x15, "ORA", "zpx");
add(0x0d, "ORA", "abs");  add(0x1d, "ORA", "absx"); add(0x19, "ORA", "absy");
add(0x01, "ORA", "indx"); add(0x11, "ORA", "indy");

add(0x48, "PHA", "imp"); add(0x08, "PHP", "imp");
add(0x68, "PLA", "imp"); add(0x28, "PLP", "imp");

add(0x2a, "ROL", "imp"); add(0x26, "ROL", "zp");  add(0x36, "ROL", "zpx");
add(0x2e, "ROL", "abs"); add(0x3e, "ROL", "absx");

add(0x6a, "ROR", "imp"); add(0x66, "ROR", "zp");  add(0x76, "ROR", "zpx");
add(0x6e, "ROR", "abs"); add(0x7e, "ROR", "absx");

add(0x40, "RTI", "imp"); add(0x60, "RTS", "imp");

add(0xe9, "SBC", "imm");  add(0xe5, "SBC", "zp");   add(0xf5, "SBC", "zpx");
add(0xed, "SBC", "abs");  add(0xfd, "SBC", "absx"); add(0xf9, "SBC", "absy");
add(0xe1, "SBC", "indx"); add(0xf1, "SBC", "indy");

add(0x38, "SEC", "imp"); add(0xf8, "SED", "imp"); add(0x78, "SEI", "imp");

add(0x85, "STA", "zp");   add(0x95, "STA", "zpx");
add(0x8d, "STA", "abs");  add(0x9d, "STA", "absx"); add(0x99, "STA", "absy");
add(0x81, "STA", "indx"); add(0x91, "STA", "indy");

add(0x86, "STX", "zp"); add(0x96, "STX", "zpy"); add(0x8e, "STX", "abs");
add(0x84, "STY", "zp"); add(0x94, "STY", "zpx"); add(0x8c, "STY", "abs");

add(0xaa, "TAX", "imp"); add(0xa8, "TAY", "imp");
add(0xba, "TSX", "imp"); add(0x8a, "TXA", "imp");
add(0x9a, "TXS", "imp"); add(0x98, "TYA", "imp");

// --- Common undocumented / "illegal" opcodes ---
add(0x0b, "ANC", "imm",  false); add(0x2b, "ANC", "imm",  false);
add(0x4b, "ALR", "imm",  false);
add(0x6b, "ARR", "imm",  false);
add(0xcb, "AXS", "imm",  false);

add(0xa3, "LAX", "indx", false); add(0xa7, "LAX", "zp",   false);
add(0xaf, "LAX", "abs",  false); add(0xb3, "LAX", "indy", false);
add(0xb7, "LAX", "zpy",  false); add(0xbf, "LAX", "absy", false);
add(0xab, "LAX", "imm",  false); // unstable on some chips

add(0x83, "SAX", "indx", false); add(0x87, "SAX", "zp",   false);
add(0x8f, "SAX", "abs",  false); add(0x97, "SAX", "zpy",  false);

add(0xc3, "DCP", "indx", false); add(0xc7, "DCP", "zp",   false);
add(0xcf, "DCP", "abs",  false); add(0xd3, "DCP", "indy", false);
add(0xd7, "DCP", "zpx",  false); add(0xdb, "DCP", "absy", false);
add(0xdf, "DCP", "absx", false);

add(0xe3, "ISC", "indx", false); add(0xe7, "ISC", "zp",   false);
add(0xef, "ISC", "abs",  false); add(0xf3, "ISC", "indy", false);
add(0xf7, "ISC", "zpx",  false); add(0xfb, "ISC", "absy", false);
add(0xff, "ISC", "absx", false);

add(0x03, "SLO", "indx", false); add(0x07, "SLO", "zp",   false);
add(0x0f, "SLO", "abs",  false); add(0x13, "SLO", "indy", false);
add(0x17, "SLO", "zpx",  false); add(0x1b, "SLO", "absy", false);
add(0x1f, "SLO", "absx", false);

add(0x23, "RLA", "indx", false); add(0x27, "RLA", "zp",   false);
add(0x2f, "RLA", "abs",  false); add(0x33, "RLA", "indy", false);
add(0x37, "RLA", "zpx",  false); add(0x3b, "RLA", "absy", false);
add(0x3f, "RLA", "absx", false);

add(0x43, "SRE", "indx", false); add(0x47, "SRE", "zp",   false);
add(0x4f, "SRE", "abs",  false); add(0x53, "SRE", "indy", false);
add(0x57, "SRE", "zpx",  false); add(0x5b, "SRE", "absy", false);
add(0x5f, "SRE", "absx", false);

add(0x63, "RRA", "indx", false); add(0x67, "RRA", "zp",   false);
add(0x6f, "RRA", "abs",  false); add(0x73, "RRA", "indy", false);
add(0x77, "RRA", "zpx",  false); add(0x7b, "RRA", "absy", false);
add(0x7f, "RRA", "absx", false);

add(0x9b, "TAS", "absy", false);
add(0x9c, "SHY", "absx", false);
add(0x9e, "SHX", "absy", false);
add(0x9f, "AHX", "absy", false); add(0x93, "AHX", "indy", false);
add(0xbb, "LAS", "absy", false);

add(0xeb, "SBC", "imm", false); // duplicate of $E9

// Undocumented NOPs
add(0x1a, "NOP", "imp",  false); add(0x3a, "NOP", "imp",  false);
add(0x5a, "NOP", "imp",  false); add(0x7a, "NOP", "imp",  false);
add(0xda, "NOP", "imp",  false); add(0xfa, "NOP", "imp",  false);
add(0x80, "NOP", "imm",  false); add(0x82, "NOP", "imm",  false);
add(0x89, "NOP", "imm",  false); add(0xc2, "NOP", "imm",  false);
add(0xe2, "NOP", "imm",  false);
add(0x04, "NOP", "zp",   false); add(0x44, "NOP", "zp",   false);
add(0x64, "NOP", "zp",   false);
add(0x14, "NOP", "zpx",  false); add(0x34, "NOP", "zpx",  false);
add(0x54, "NOP", "zpx",  false); add(0x74, "NOP", "zpx",  false);
add(0xd4, "NOP", "zpx",  false); add(0xf4, "NOP", "zpx",  false);
add(0x0c, "NOP", "abs",  false);
add(0x1c, "NOP", "absx", false); add(0x3c, "NOP", "absx", false);
add(0x5c, "NOP", "absx", false); add(0x7c, "NOP", "absx", false);
add(0xdc, "NOP", "absx", false); add(0xfc, "NOP", "absx", false);

// JAM / KIL / HLT — illegal halts
add(0x02, "JAM", "imp", false); add(0x12, "JAM", "imp", false);
add(0x22, "JAM", "imp", false); add(0x32, "JAM", "imp", false);
add(0x42, "JAM", "imp", false); add(0x52, "JAM", "imp", false);
add(0x62, "JAM", "imp", false); add(0x72, "JAM", "imp", false);
add(0x92, "JAM", "imp", false); add(0xb2, "JAM", "imp", false);
add(0xd2, "JAM", "imp", false); add(0xf2, "JAM", "imp", false);

export const OPCODE_TABLE: Readonly<Record<number, OpcodeInfo>> = T;

export function describeOpcode(opcode: number): string {
  const info = OPCODE_TABLE[opcode & 0xff];
  if (!info) return "unknown";
  const modeText: Record<OpcodeMode, string> = {
    imp: "",
    imm: " #imm",
    zp: " zp",
    zpx: " zp,X",
    zpy: " zp,Y",
    abs: " abs",
    absx: " abs,X",
    absy: " abs,Y",
    ind: " (ind)",
    indx: " (ind,X)",
    indy: " (ind),Y",
    rel: " rel",
  };
  const tag = info.legal ? "" : "*";
  return `${info.mnemonic}${tag}${modeText[info.mode]}`.trim();
}
