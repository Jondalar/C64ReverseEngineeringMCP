export type AddressingMode =
  | "impl"
  | "acc"
  | "imm"
  | "zp"
  | "zp,x"
  | "zp,y"
  | "abs"
  | "abs,x"
  | "abs,y"
  | "ind"
  | "(zp,x)"
  | "(zp),y"
  | "rel";

export interface OpcodeDefinition {
  mnemonic: string;
  mode: AddressingMode;
  size: 1 | 2 | 3;
}

export interface DecodedInstruction {
  address: number;
  opcode: number;
  size: number;
  bytes: number[];
  mnemonic: string;
  mode: AddressingMode;
  operand?: number;
  targetAddress?: number;
  isUnknown: boolean;
  isUndocumented: boolean;
}

const OPCODES = new Map<number, OpcodeDefinition>([
  [0x02, { mnemonic: "jam", mode: "impl", size: 1 }],
  [0x03, { mnemonic: "slo", mode: "(zp,x)", size: 2 }],
  [0x00, { mnemonic: "brk", mode: "impl", size: 1 }],
  [0x01, { mnemonic: "ora", mode: "(zp,x)", size: 2 }],
  [0x04, { mnemonic: "nop", mode: "zp", size: 2 }],
  [0x05, { mnemonic: "ora", mode: "zp", size: 2 }],
  [0x06, { mnemonic: "asl", mode: "zp", size: 2 }],
  [0x07, { mnemonic: "slo", mode: "zp", size: 2 }],
  [0x08, { mnemonic: "php", mode: "impl", size: 1 }],
  [0x09, { mnemonic: "ora", mode: "imm", size: 2 }],
  [0x0a, { mnemonic: "asl", mode: "acc", size: 1 }],
  [0x0b, { mnemonic: "anc", mode: "imm", size: 2 }],
  [0x0c, { mnemonic: "nop", mode: "abs", size: 3 }],
  [0x0d, { mnemonic: "ora", mode: "abs", size: 3 }],
  [0x0e, { mnemonic: "asl", mode: "abs", size: 3 }],
  [0x0f, { mnemonic: "slo", mode: "abs", size: 3 }],
  [0x10, { mnemonic: "bpl", mode: "rel", size: 2 }],
  [0x11, { mnemonic: "ora", mode: "(zp),y", size: 2 }],
  [0x12, { mnemonic: "jam", mode: "impl", size: 1 }],
  [0x13, { mnemonic: "slo", mode: "(zp),y", size: 2 }],
  [0x14, { mnemonic: "nop", mode: "zp,x", size: 2 }],
  [0x15, { mnemonic: "ora", mode: "zp,x", size: 2 }],
  [0x16, { mnemonic: "asl", mode: "zp,x", size: 2 }],
  [0x17, { mnemonic: "slo", mode: "zp,x", size: 2 }],
  [0x18, { mnemonic: "clc", mode: "impl", size: 1 }],
  [0x19, { mnemonic: "ora", mode: "abs,y", size: 3 }],
  [0x1a, { mnemonic: "nop", mode: "impl", size: 1 }],
  [0x1b, { mnemonic: "slo", mode: "abs,y", size: 3 }],
  [0x1c, { mnemonic: "nop", mode: "abs,x", size: 3 }],
  [0x1d, { mnemonic: "ora", mode: "abs,x", size: 3 }],
  [0x1e, { mnemonic: "asl", mode: "abs,x", size: 3 }],
  [0x1f, { mnemonic: "slo", mode: "abs,x", size: 3 }],
  [0x20, { mnemonic: "jsr", mode: "abs", size: 3 }],
  [0x21, { mnemonic: "and", mode: "(zp,x)", size: 2 }],
  [0x22, { mnemonic: "jam", mode: "impl", size: 1 }],
  [0x23, { mnemonic: "rla", mode: "(zp,x)", size: 2 }],
  [0x24, { mnemonic: "bit", mode: "zp", size: 2 }],
  [0x25, { mnemonic: "and", mode: "zp", size: 2 }],
  [0x26, { mnemonic: "rol", mode: "zp", size: 2 }],
  [0x27, { mnemonic: "rla", mode: "zp", size: 2 }],
  [0x28, { mnemonic: "plp", mode: "impl", size: 1 }],
  [0x29, { mnemonic: "and", mode: "imm", size: 2 }],
  [0x2a, { mnemonic: "rol", mode: "acc", size: 1 }],
  [0x2b, { mnemonic: "anc", mode: "imm", size: 2 }],
  [0x2c, { mnemonic: "bit", mode: "abs", size: 3 }],
  [0x2d, { mnemonic: "and", mode: "abs", size: 3 }],
  [0x2e, { mnemonic: "rol", mode: "abs", size: 3 }],
  [0x2f, { mnemonic: "rla", mode: "abs", size: 3 }],
  [0x30, { mnemonic: "bmi", mode: "rel", size: 2 }],
  [0x31, { mnemonic: "and", mode: "(zp),y", size: 2 }],
  [0x32, { mnemonic: "jam", mode: "impl", size: 1 }],
  [0x33, { mnemonic: "rla", mode: "(zp),y", size: 2 }],
  [0x34, { mnemonic: "nop", mode: "zp,x", size: 2 }],
  [0x35, { mnemonic: "and", mode: "zp,x", size: 2 }],
  [0x36, { mnemonic: "rol", mode: "zp,x", size: 2 }],
  [0x37, { mnemonic: "rla", mode: "zp,x", size: 2 }],
  [0x38, { mnemonic: "sec", mode: "impl", size: 1 }],
  [0x39, { mnemonic: "and", mode: "abs,y", size: 3 }],
  [0x3a, { mnemonic: "nop", mode: "impl", size: 1 }],
  [0x3b, { mnemonic: "rla", mode: "abs,y", size: 3 }],
  [0x3c, { mnemonic: "nop", mode: "abs,x", size: 3 }],
  [0x3d, { mnemonic: "and", mode: "abs,x", size: 3 }],
  [0x3e, { mnemonic: "rol", mode: "abs,x", size: 3 }],
  [0x3f, { mnemonic: "rla", mode: "abs,x", size: 3 }],
  [0x40, { mnemonic: "rti", mode: "impl", size: 1 }],
  [0x41, { mnemonic: "eor", mode: "(zp,x)", size: 2 }],
  [0x42, { mnemonic: "jam", mode: "impl", size: 1 }],
  [0x43, { mnemonic: "sre", mode: "(zp,x)", size: 2 }],
  [0x44, { mnemonic: "nop", mode: "zp", size: 2 }],
  [0x45, { mnemonic: "eor", mode: "zp", size: 2 }],
  [0x46, { mnemonic: "lsr", mode: "zp", size: 2 }],
  [0x47, { mnemonic: "sre", mode: "zp", size: 2 }],
  [0x48, { mnemonic: "pha", mode: "impl", size: 1 }],
  [0x49, { mnemonic: "eor", mode: "imm", size: 2 }],
  [0x4a, { mnemonic: "lsr", mode: "acc", size: 1 }],
  [0x4b, { mnemonic: "alr", mode: "imm", size: 2 }],
  [0x4c, { mnemonic: "jmp", mode: "abs", size: 3 }],
  [0x4d, { mnemonic: "eor", mode: "abs", size: 3 }],
  [0x4e, { mnemonic: "lsr", mode: "abs", size: 3 }],
  [0x4f, { mnemonic: "sre", mode: "abs", size: 3 }],
  [0x50, { mnemonic: "bvc", mode: "rel", size: 2 }],
  [0x51, { mnemonic: "eor", mode: "(zp),y", size: 2 }],
  [0x52, { mnemonic: "jam", mode: "impl", size: 1 }],
  [0x53, { mnemonic: "sre", mode: "(zp),y", size: 2 }],
  [0x54, { mnemonic: "nop", mode: "zp,x", size: 2 }],
  [0x55, { mnemonic: "eor", mode: "zp,x", size: 2 }],
  [0x56, { mnemonic: "lsr", mode: "zp,x", size: 2 }],
  [0x57, { mnemonic: "sre", mode: "zp,x", size: 2 }],
  [0x58, { mnemonic: "cli", mode: "impl", size: 1 }],
  [0x59, { mnemonic: "eor", mode: "abs,y", size: 3 }],
  [0x5a, { mnemonic: "nop", mode: "impl", size: 1 }],
  [0x5b, { mnemonic: "sre", mode: "abs,y", size: 3 }],
  [0x5c, { mnemonic: "nop", mode: "abs,x", size: 3 }],
  [0x5d, { mnemonic: "eor", mode: "abs,x", size: 3 }],
  [0x5e, { mnemonic: "lsr", mode: "abs,x", size: 3 }],
  [0x5f, { mnemonic: "sre", mode: "abs,x", size: 3 }],
  [0x60, { mnemonic: "rts", mode: "impl", size: 1 }],
  [0x61, { mnemonic: "adc", mode: "(zp,x)", size: 2 }],
  [0x62, { mnemonic: "jam", mode: "impl", size: 1 }],
  [0x63, { mnemonic: "rra", mode: "(zp,x)", size: 2 }],
  [0x64, { mnemonic: "nop", mode: "zp", size: 2 }],
  [0x65, { mnemonic: "adc", mode: "zp", size: 2 }],
  [0x66, { mnemonic: "ror", mode: "zp", size: 2 }],
  [0x67, { mnemonic: "rra", mode: "zp", size: 2 }],
  [0x68, { mnemonic: "pla", mode: "impl", size: 1 }],
  [0x69, { mnemonic: "adc", mode: "imm", size: 2 }],
  [0x6a, { mnemonic: "ror", mode: "acc", size: 1 }],
  [0x6b, { mnemonic: "arr", mode: "imm", size: 2 }],
  [0x6c, { mnemonic: "jmp", mode: "ind", size: 3 }],
  [0x6d, { mnemonic: "adc", mode: "abs", size: 3 }],
  [0x6e, { mnemonic: "ror", mode: "abs", size: 3 }],
  [0x6f, { mnemonic: "rra", mode: "abs", size: 3 }],
  [0x70, { mnemonic: "bvs", mode: "rel", size: 2 }],
  [0x71, { mnemonic: "adc", mode: "(zp),y", size: 2 }],
  [0x72, { mnemonic: "jam", mode: "impl", size: 1 }],
  [0x73, { mnemonic: "rra", mode: "(zp),y", size: 2 }],
  [0x74, { mnemonic: "nop", mode: "zp,x", size: 2 }],
  [0x75, { mnemonic: "adc", mode: "zp,x", size: 2 }],
  [0x76, { mnemonic: "ror", mode: "zp,x", size: 2 }],
  [0x77, { mnemonic: "rra", mode: "zp,x", size: 2 }],
  [0x78, { mnemonic: "sei", mode: "impl", size: 1 }],
  [0x79, { mnemonic: "adc", mode: "abs,y", size: 3 }],
  [0x7a, { mnemonic: "nop", mode: "impl", size: 1 }],
  [0x7b, { mnemonic: "rra", mode: "abs,y", size: 3 }],
  [0x7c, { mnemonic: "nop", mode: "abs,x", size: 3 }],
  [0x7d, { mnemonic: "adc", mode: "abs,x", size: 3 }],
  [0x7e, { mnemonic: "ror", mode: "abs,x", size: 3 }],
  [0x7f, { mnemonic: "rra", mode: "abs,x", size: 3 }],
  [0x80, { mnemonic: "nop", mode: "imm", size: 2 }],
  [0x81, { mnemonic: "sta", mode: "(zp,x)", size: 2 }],
  [0x82, { mnemonic: "nop", mode: "imm", size: 2 }],
  [0x83, { mnemonic: "sax", mode: "(zp,x)", size: 2 }],
  [0x84, { mnemonic: "sty", mode: "zp", size: 2 }],
  [0x85, { mnemonic: "sta", mode: "zp", size: 2 }],
  [0x86, { mnemonic: "stx", mode: "zp", size: 2 }],
  [0x87, { mnemonic: "sax", mode: "zp", size: 2 }],
  [0x88, { mnemonic: "dey", mode: "impl", size: 1 }],
  [0x89, { mnemonic: "nop", mode: "imm", size: 2 }],
  [0x8a, { mnemonic: "txa", mode: "impl", size: 1 }],
  [0x8b, { mnemonic: "xaa", mode: "imm", size: 2 }],
  [0x8c, { mnemonic: "sty", mode: "abs", size: 3 }],
  [0x8d, { mnemonic: "sta", mode: "abs", size: 3 }],
  [0x8e, { mnemonic: "stx", mode: "abs", size: 3 }],
  [0x8f, { mnemonic: "sax", mode: "abs", size: 3 }],
  [0x90, { mnemonic: "bcc", mode: "rel", size: 2 }],
  [0x91, { mnemonic: "sta", mode: "(zp),y", size: 2 }],
  [0x92, { mnemonic: "jam", mode: "impl", size: 1 }],
  [0x93, { mnemonic: "ahx", mode: "(zp),y", size: 2 }],
  [0x94, { mnemonic: "sty", mode: "zp,x", size: 2 }],
  [0x95, { mnemonic: "sta", mode: "zp,x", size: 2 }],
  [0x96, { mnemonic: "stx", mode: "zp,y", size: 2 }],
  [0x97, { mnemonic: "sax", mode: "zp,y", size: 2 }],
  [0x98, { mnemonic: "tya", mode: "impl", size: 1 }],
  [0x99, { mnemonic: "sta", mode: "abs,y", size: 3 }],
  [0x9a, { mnemonic: "txs", mode: "impl", size: 1 }],
  [0x9b, { mnemonic: "tas", mode: "abs,y", size: 3 }],
  [0x9c, { mnemonic: "shy", mode: "abs,x", size: 3 }],
  [0x9d, { mnemonic: "sta", mode: "abs,x", size: 3 }],
  [0x9e, { mnemonic: "shx", mode: "abs,y", size: 3 }],
  [0x9f, { mnemonic: "ahx", mode: "abs,y", size: 3 }],
  [0xa0, { mnemonic: "ldy", mode: "imm", size: 2 }],
  [0xa1, { mnemonic: "lda", mode: "(zp,x)", size: 2 }],
  [0xa2, { mnemonic: "ldx", mode: "imm", size: 2 }],
  [0xa3, { mnemonic: "lax", mode: "(zp,x)", size: 2 }],
  [0xa4, { mnemonic: "ldy", mode: "zp", size: 2 }],
  [0xa5, { mnemonic: "lda", mode: "zp", size: 2 }],
  [0xa6, { mnemonic: "ldx", mode: "zp", size: 2 }],
  [0xa7, { mnemonic: "lax", mode: "zp", size: 2 }],
  [0xa8, { mnemonic: "tay", mode: "impl", size: 1 }],
  [0xa9, { mnemonic: "lda", mode: "imm", size: 2 }],
  [0xaa, { mnemonic: "tax", mode: "impl", size: 1 }],
  [0xab, { mnemonic: "lax", mode: "imm", size: 2 }],
  [0xac, { mnemonic: "ldy", mode: "abs", size: 3 }],
  [0xad, { mnemonic: "lda", mode: "abs", size: 3 }],
  [0xae, { mnemonic: "ldx", mode: "abs", size: 3 }],
  [0xaf, { mnemonic: "lax", mode: "abs", size: 3 }],
  [0xb0, { mnemonic: "bcs", mode: "rel", size: 2 }],
  [0xb1, { mnemonic: "lda", mode: "(zp),y", size: 2 }],
  [0xb2, { mnemonic: "jam", mode: "impl", size: 1 }],
  [0xb3, { mnemonic: "lax", mode: "(zp),y", size: 2 }],
  [0xb4, { mnemonic: "ldy", mode: "zp,x", size: 2 }],
  [0xb5, { mnemonic: "lda", mode: "zp,x", size: 2 }],
  [0xb6, { mnemonic: "ldx", mode: "zp,y", size: 2 }],
  [0xb7, { mnemonic: "lax", mode: "zp,y", size: 2 }],
  [0xb8, { mnemonic: "clv", mode: "impl", size: 1 }],
  [0xb9, { mnemonic: "lda", mode: "abs,y", size: 3 }],
  [0xba, { mnemonic: "tsx", mode: "impl", size: 1 }],
  [0xbb, { mnemonic: "las", mode: "abs,y", size: 3 }],
  [0xbc, { mnemonic: "ldy", mode: "abs,x", size: 3 }],
  [0xbd, { mnemonic: "lda", mode: "abs,x", size: 3 }],
  [0xbe, { mnemonic: "ldx", mode: "abs,y", size: 3 }],
  [0xbf, { mnemonic: "lax", mode: "abs,y", size: 3 }],
  [0xc0, { mnemonic: "cpy", mode: "imm", size: 2 }],
  [0xc1, { mnemonic: "cmp", mode: "(zp,x)", size: 2 }],
  [0xc2, { mnemonic: "nop", mode: "imm", size: 2 }],
  [0xc3, { mnemonic: "dcp", mode: "(zp,x)", size: 2 }],
  [0xc4, { mnemonic: "cpy", mode: "zp", size: 2 }],
  [0xc5, { mnemonic: "cmp", mode: "zp", size: 2 }],
  [0xc6, { mnemonic: "dec", mode: "zp", size: 2 }],
  [0xc7, { mnemonic: "dcp", mode: "zp", size: 2 }],
  [0xc8, { mnemonic: "iny", mode: "impl", size: 1 }],
  [0xc9, { mnemonic: "cmp", mode: "imm", size: 2 }],
  [0xca, { mnemonic: "dex", mode: "impl", size: 1 }],
  [0xcb, { mnemonic: "axs", mode: "imm", size: 2 }],
  [0xcc, { mnemonic: "cpy", mode: "abs", size: 3 }],
  [0xcd, { mnemonic: "cmp", mode: "abs", size: 3 }],
  [0xce, { mnemonic: "dec", mode: "abs", size: 3 }],
  [0xcf, { mnemonic: "dcp", mode: "abs", size: 3 }],
  [0xd0, { mnemonic: "bne", mode: "rel", size: 2 }],
  [0xd1, { mnemonic: "cmp", mode: "(zp),y", size: 2 }],
  [0xd2, { mnemonic: "jam", mode: "impl", size: 1 }],
  [0xd3, { mnemonic: "dcp", mode: "(zp),y", size: 2 }],
  [0xd4, { mnemonic: "nop", mode: "zp,x", size: 2 }],
  [0xd5, { mnemonic: "cmp", mode: "zp,x", size: 2 }],
  [0xd6, { mnemonic: "dec", mode: "zp,x", size: 2 }],
  [0xd7, { mnemonic: "dcp", mode: "zp,x", size: 2 }],
  [0xd8, { mnemonic: "cld", mode: "impl", size: 1 }],
  [0xd9, { mnemonic: "cmp", mode: "abs,y", size: 3 }],
  [0xda, { mnemonic: "nop", mode: "impl", size: 1 }],
  [0xdb, { mnemonic: "dcp", mode: "abs,y", size: 3 }],
  [0xdc, { mnemonic: "nop", mode: "abs,x", size: 3 }],
  [0xdd, { mnemonic: "cmp", mode: "abs,x", size: 3 }],
  [0xde, { mnemonic: "dec", mode: "abs,x", size: 3 }],
  [0xdf, { mnemonic: "dcp", mode: "abs,x", size: 3 }],
  [0xe0, { mnemonic: "cpx", mode: "imm", size: 2 }],
  [0xe1, { mnemonic: "sbc", mode: "(zp,x)", size: 2 }],
  [0xe2, { mnemonic: "nop", mode: "imm", size: 2 }],
  [0xe3, { mnemonic: "isc", mode: "(zp,x)", size: 2 }],
  [0xe4, { mnemonic: "cpx", mode: "zp", size: 2 }],
  [0xe5, { mnemonic: "sbc", mode: "zp", size: 2 }],
  [0xe6, { mnemonic: "inc", mode: "zp", size: 2 }],
  [0xe7, { mnemonic: "isc", mode: "zp", size: 2 }],
  [0xe8, { mnemonic: "inx", mode: "impl", size: 1 }],
  [0xe9, { mnemonic: "sbc", mode: "imm", size: 2 }],
  [0xea, { mnemonic: "nop", mode: "impl", size: 1 }],
  [0xeb, { mnemonic: "sbc", mode: "imm", size: 2 }],
  [0xec, { mnemonic: "cpx", mode: "abs", size: 3 }],
  [0xed, { mnemonic: "sbc", mode: "abs", size: 3 }],
  [0xee, { mnemonic: "inc", mode: "abs", size: 3 }],
  [0xef, { mnemonic: "isc", mode: "abs", size: 3 }],
  [0xf0, { mnemonic: "beq", mode: "rel", size: 2 }],
  [0xf1, { mnemonic: "sbc", mode: "(zp),y", size: 2 }],
  [0xf2, { mnemonic: "jam", mode: "impl", size: 1 }],
  [0xf3, { mnemonic: "isc", mode: "(zp),y", size: 2 }],
  [0xf4, { mnemonic: "nop", mode: "zp,x", size: 2 }],
  [0xf5, { mnemonic: "sbc", mode: "zp,x", size: 2 }],
  [0xf6, { mnemonic: "inc", mode: "zp,x", size: 2 }],
  [0xf7, { mnemonic: "isc", mode: "zp,x", size: 2 }],
  [0xf8, { mnemonic: "sed", mode: "impl", size: 1 }],
  [0xf9, { mnemonic: "sbc", mode: "abs,y", size: 3 }],
  [0xfa, { mnemonic: "nop", mode: "impl", size: 1 }],
  [0xfb, { mnemonic: "isc", mode: "abs,y", size: 3 }],
  [0xfc, { mnemonic: "nop", mode: "abs,x", size: 3 }],
  [0xfd, { mnemonic: "sbc", mode: "abs,x", size: 3 }],
  [0xfe, { mnemonic: "inc", mode: "abs,x", size: 3 }],
  [0xff, { mnemonic: "isc", mode: "abs,x", size: 3 }],
]);

const DOCUMENTED_OPCODES = new Set<number>([
  0x00, 0x01, 0x05, 0x06, 0x08, 0x09, 0x0a, 0x0d, 0x0e,
  0x10, 0x11, 0x15, 0x16, 0x18, 0x19, 0x1d, 0x1e,
  0x20, 0x21, 0x24, 0x25, 0x26, 0x28, 0x29, 0x2a, 0x2c, 0x2d, 0x2e,
  0x30, 0x31, 0x35, 0x36, 0x38, 0x39, 0x3d, 0x3e,
  0x40, 0x41, 0x45, 0x46, 0x48, 0x49, 0x4a, 0x4c, 0x4d, 0x4e,
  0x50, 0x51, 0x55, 0x56, 0x58, 0x59, 0x5d, 0x5e,
  0x60, 0x61, 0x65, 0x66, 0x68, 0x69, 0x6a, 0x6c, 0x6d, 0x6e,
  0x70, 0x71, 0x75, 0x76, 0x78, 0x79, 0x7d, 0x7e,
  0x81, 0x84, 0x85, 0x86, 0x88, 0x8a, 0x8c, 0x8d, 0x8e,
  0x90, 0x91, 0x94, 0x95, 0x96, 0x98, 0x99, 0x9a, 0x9d,
  0xa0, 0xa1, 0xa2, 0xa4, 0xa5, 0xa6, 0xa8, 0xa9, 0xaa, 0xac, 0xad, 0xae,
  0xb0, 0xb1, 0xb4, 0xb5, 0xb6, 0xb8, 0xb9, 0xba, 0xbc, 0xbd, 0xbe,
  0xc0, 0xc1, 0xc4, 0xc5, 0xc6, 0xc8, 0xc9, 0xca, 0xcc, 0xcd, 0xce,
  0xd0, 0xd1, 0xd5, 0xd6, 0xd8, 0xd9, 0xdd, 0xde,
  0xe0, 0xe1, 0xe4, 0xe5, 0xe6, 0xe8, 0xe9, 0xea, 0xec, 0xed, 0xee,
  0xf0, 0xf1, 0xf5, 0xf6, 0xf8, 0xf9, 0xfd, 0xfe,
]);

export function decodeInstruction(data: Buffer, offset: number, baseAddress: number): DecodedInstruction {
  const opcode = data[offset];
  const definition = OPCODES.get(opcode);
  const address = baseAddress + offset;

  if (!definition || offset + definition.size > data.length) {
    return {
      address,
      opcode,
      size: 1,
      bytes: [opcode],
      mnemonic: ".byte",
      mode: "impl",
      operand: opcode,
      isUnknown: true,
      isUndocumented: false,
    };
  }

  const bytes = Array.from(data.subarray(offset, offset + definition.size));
  let operand: number | undefined;
  let targetAddress: number | undefined;

  if (definition.size === 2) {
    operand = bytes[1];
  } else if (definition.size === 3) {
    operand = bytes[1] | (bytes[2] << 8);
  }

  if (definition.mode === "rel" && operand !== undefined) {
    const signed = operand >= 0x80 ? operand - 0x100 : operand;
    targetAddress = (address + definition.size + signed) & 0xffff;
  } else if (
    operand !== undefined &&
    (definition.mode === "abs" || definition.mode === "abs,x" || definition.mode === "abs,y" || definition.mode === "ind")
  ) {
    targetAddress = operand;
  }

  return {
    address,
    opcode,
    size: definition.size,
    bytes,
    mnemonic: definition.mnemonic,
    mode: definition.mode,
    operand,
    targetAddress,
    isUnknown: false,
    isUndocumented: !DOCUMENTED_OPCODES.has(opcode),
  };
}

export function hasFallthrough(instruction: DecodedInstruction): boolean {
  if (instruction.isUnknown) {
    return false;
  }

  if (
    instruction.mnemonic === "jmp" ||
    instruction.mnemonic === "rts" ||
    instruction.mnemonic === "rti" ||
    instruction.mnemonic === "brk" ||
    instruction.mnemonic === "jam"
  ) {
    return false;
  }

  return true;
}

export function isJumpInstruction(instruction: DecodedInstruction): boolean {
  return !instruction.isUnknown && instruction.mnemonic === "jmp";
}

export function isCallInstruction(instruction: DecodedInstruction): boolean {
  return !instruction.isUnknown && instruction.mnemonic === "jsr";
}

export function isBranchInstruction(instruction: DecodedInstruction): boolean {
  return !instruction.isUnknown && instruction.mode === "rel";
}
