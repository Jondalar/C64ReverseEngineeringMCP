export type TraceAccessKind = "read" | "write" | "readwrite" | "call" | "jump" | "return" | "branch" | "other";

export interface TraceDecodedInstruction {
  opcode: number;
  size: number;
  mnemonic: string;
  mode: string;
  operand?: number;
  directAddress?: number;
  access: TraceAccessKind;
  isCall: boolean;
  isReturn: boolean;
}

const SIZE_BY_OPCODE = new Map<number, number>([
  [0x20, 3], [0x4c, 3], [0x6c, 3], [0x60, 1], [0x40, 1],
  [0xd0, 2], [0xf0, 2], [0x90, 2], [0xb0, 2], [0x10, 2], [0x30, 2], [0x50, 2], [0x70, 2],
]);

const OPCODE_MAP = new Map<number, Omit<TraceDecodedInstruction, "opcode" | "size" | "operand">>([
  [0x20, { mnemonic: "JSR", mode: "abs", access: "call", isCall: true, isReturn: false, directAddress: 0 }],
  [0x4c, { mnemonic: "JMP", mode: "abs", access: "jump", isCall: false, isReturn: false, directAddress: 0 }],
  [0x6c, { mnemonic: "JMP", mode: "ind", access: "jump", isCall: false, isReturn: false }],
  [0x60, { mnemonic: "RTS", mode: "impl", access: "return", isCall: false, isReturn: true }],
  [0x40, { mnemonic: "RTI", mode: "impl", access: "return", isCall: false, isReturn: true }],

  [0xad, { mnemonic: "LDA", mode: "abs", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0xbd, { mnemonic: "LDA", mode: "abs,X", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0xb9, { mnemonic: "LDA", mode: "abs,Y", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0xa5, { mnemonic: "LDA", mode: "zp", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0xb5, { mnemonic: "LDA", mode: "zp,X", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0xae, { mnemonic: "LDX", mode: "abs", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0xbe, { mnemonic: "LDX", mode: "abs,Y", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0xa6, { mnemonic: "LDX", mode: "zp", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0xb6, { mnemonic: "LDX", mode: "zp,Y", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0xac, { mnemonic: "LDY", mode: "abs", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0xbc, { mnemonic: "LDY", mode: "abs,X", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0xa4, { mnemonic: "LDY", mode: "zp", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0xb4, { mnemonic: "LDY", mode: "zp,X", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0x0d, { mnemonic: "ORA", mode: "abs", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0x1d, { mnemonic: "ORA", mode: "abs,X", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0x19, { mnemonic: "ORA", mode: "abs,Y", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0x05, { mnemonic: "ORA", mode: "zp", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0x15, { mnemonic: "ORA", mode: "zp,X", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0x2d, { mnemonic: "AND", mode: "abs", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0x3d, { mnemonic: "AND", mode: "abs,X", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0x39, { mnemonic: "AND", mode: "abs,Y", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0x25, { mnemonic: "AND", mode: "zp", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0x35, { mnemonic: "AND", mode: "zp,X", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0x4d, { mnemonic: "EOR", mode: "abs", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0x5d, { mnemonic: "EOR", mode: "abs,X", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0x59, { mnemonic: "EOR", mode: "abs,Y", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0x45, { mnemonic: "EOR", mode: "zp", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0x55, { mnemonic: "EOR", mode: "zp,X", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0x6d, { mnemonic: "ADC", mode: "abs", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0x7d, { mnemonic: "ADC", mode: "abs,X", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0x79, { mnemonic: "ADC", mode: "abs,Y", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0x65, { mnemonic: "ADC", mode: "zp", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0x75, { mnemonic: "ADC", mode: "zp,X", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0xed, { mnemonic: "SBC", mode: "abs", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0xfd, { mnemonic: "SBC", mode: "abs,X", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0xf9, { mnemonic: "SBC", mode: "abs,Y", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0xe5, { mnemonic: "SBC", mode: "zp", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0xf5, { mnemonic: "SBC", mode: "zp,X", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0xcd, { mnemonic: "CMP", mode: "abs", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0xdd, { mnemonic: "CMP", mode: "abs,X", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0xd9, { mnemonic: "CMP", mode: "abs,Y", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0xc5, { mnemonic: "CMP", mode: "zp", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0xd5, { mnemonic: "CMP", mode: "zp,X", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0xec, { mnemonic: "CPX", mode: "abs", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0xe4, { mnemonic: "CPX", mode: "zp", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0xcc, { mnemonic: "CPY", mode: "abs", access: "read", isCall: false, isReturn: false, directAddress: 0 }],
  [0xc4, { mnemonic: "CPY", mode: "zp", access: "read", isCall: false, isReturn: false, directAddress: 0 }],

  [0x8d, { mnemonic: "STA", mode: "abs", access: "write", isCall: false, isReturn: false, directAddress: 0 }],
  [0x9d, { mnemonic: "STA", mode: "abs,X", access: "write", isCall: false, isReturn: false, directAddress: 0 }],
  [0x99, { mnemonic: "STA", mode: "abs,Y", access: "write", isCall: false, isReturn: false, directAddress: 0 }],
  [0x85, { mnemonic: "STA", mode: "zp", access: "write", isCall: false, isReturn: false, directAddress: 0 }],
  [0x95, { mnemonic: "STA", mode: "zp,X", access: "write", isCall: false, isReturn: false, directAddress: 0 }],
  [0x8e, { mnemonic: "STX", mode: "abs", access: "write", isCall: false, isReturn: false, directAddress: 0 }],
  [0x86, { mnemonic: "STX", mode: "zp", access: "write", isCall: false, isReturn: false, directAddress: 0 }],
  [0x96, { mnemonic: "STX", mode: "zp,Y", access: "write", isCall: false, isReturn: false, directAddress: 0 }],
  [0x8c, { mnemonic: "STY", mode: "abs", access: "write", isCall: false, isReturn: false, directAddress: 0 }],
  [0x84, { mnemonic: "STY", mode: "zp", access: "write", isCall: false, isReturn: false, directAddress: 0 }],
  [0x94, { mnemonic: "STY", mode: "zp,X", access: "write", isCall: false, isReturn: false, directAddress: 0 }],

  [0xee, { mnemonic: "INC", mode: "abs", access: "readwrite", isCall: false, isReturn: false, directAddress: 0 }],
  [0xfe, { mnemonic: "INC", mode: "abs,X", access: "readwrite", isCall: false, isReturn: false, directAddress: 0 }],
  [0xe6, { mnemonic: "INC", mode: "zp", access: "readwrite", isCall: false, isReturn: false, directAddress: 0 }],
  [0xf6, { mnemonic: "INC", mode: "zp,X", access: "readwrite", isCall: false, isReturn: false, directAddress: 0 }],
  [0xce, { mnemonic: "DEC", mode: "abs", access: "readwrite", isCall: false, isReturn: false, directAddress: 0 }],
  [0xde, { mnemonic: "DEC", mode: "abs,X", access: "readwrite", isCall: false, isReturn: false, directAddress: 0 }],
  [0xc6, { mnemonic: "DEC", mode: "zp", access: "readwrite", isCall: false, isReturn: false, directAddress: 0 }],
  [0xd6, { mnemonic: "DEC", mode: "zp,X", access: "readwrite", isCall: false, isReturn: false, directAddress: 0 }],
  [0x0e, { mnemonic: "ASL", mode: "abs", access: "readwrite", isCall: false, isReturn: false, directAddress: 0 }],
  [0x1e, { mnemonic: "ASL", mode: "abs,X", access: "readwrite", isCall: false, isReturn: false, directAddress: 0 }],
  [0x06, { mnemonic: "ASL", mode: "zp", access: "readwrite", isCall: false, isReturn: false, directAddress: 0 }],
  [0x16, { mnemonic: "ASL", mode: "zp,X", access: "readwrite", isCall: false, isReturn: false, directAddress: 0 }],
  [0x2e, { mnemonic: "ROL", mode: "abs", access: "readwrite", isCall: false, isReturn: false, directAddress: 0 }],
  [0x3e, { mnemonic: "ROL", mode: "abs,X", access: "readwrite", isCall: false, isReturn: false, directAddress: 0 }],
  [0x26, { mnemonic: "ROL", mode: "zp", access: "readwrite", isCall: false, isReturn: false, directAddress: 0 }],
  [0x36, { mnemonic: "ROL", mode: "zp,X", access: "readwrite", isCall: false, isReturn: false, directAddress: 0 }],
  [0x4e, { mnemonic: "LSR", mode: "abs", access: "readwrite", isCall: false, isReturn: false, directAddress: 0 }],
  [0x5e, { mnemonic: "LSR", mode: "abs,X", access: "readwrite", isCall: false, isReturn: false, directAddress: 0 }],
  [0x46, { mnemonic: "LSR", mode: "zp", access: "readwrite", isCall: false, isReturn: false, directAddress: 0 }],
  [0x56, { mnemonic: "LSR", mode: "zp,X", access: "readwrite", isCall: false, isReturn: false, directAddress: 0 }],
  [0x6e, { mnemonic: "ROR", mode: "abs", access: "readwrite", isCall: false, isReturn: false, directAddress: 0 }],
  [0x7e, { mnemonic: "ROR", mode: "abs,X", access: "readwrite", isCall: false, isReturn: false, directAddress: 0 }],
  [0x66, { mnemonic: "ROR", mode: "zp", access: "readwrite", isCall: false, isReturn: false, directAddress: 0 }],
  [0x76, { mnemonic: "ROR", mode: "zp,X", access: "readwrite", isCall: false, isReturn: false, directAddress: 0 }],

  [0xd0, { mnemonic: "BNE", mode: "rel", access: "branch", isCall: false, isReturn: false }],
  [0xf0, { mnemonic: "BEQ", mode: "rel", access: "branch", isCall: false, isReturn: false }],
  [0x90, { mnemonic: "BCC", mode: "rel", access: "branch", isCall: false, isReturn: false }],
  [0xb0, { mnemonic: "BCS", mode: "rel", access: "branch", isCall: false, isReturn: false }],
  [0x10, { mnemonic: "BPL", mode: "rel", access: "branch", isCall: false, isReturn: false }],
  [0x30, { mnemonic: "BMI", mode: "rel", access: "branch", isCall: false, isReturn: false }],
  [0x50, { mnemonic: "BVC", mode: "rel", access: "branch", isCall: false, isReturn: false }],
  [0x70, { mnemonic: "BVS", mode: "rel", access: "branch", isCall: false, isReturn: false }],
]);

export function decodeTraceInstruction(bytes: number[]): TraceDecodedInstruction {
  const opcode = bytes[0] ?? 0;
  const template = OPCODE_MAP.get(opcode);
  const size = inferInstructionSize(opcode);

  if (!template) {
    return {
      opcode,
      size,
      mnemonic: `OP${opcode.toString(16).toUpperCase().padStart(2, "0")}`,
      mode: "unknown",
      access: "other",
      isCall: false,
      isReturn: false,
    };
  }

  const operand = size >= 2
    ? size === 2
      ? (bytes[1] ?? 0)
      : ((bytes[1] ?? 0) | ((bytes[2] ?? 0) << 8))
    : undefined;

  return {
    opcode,
    size,
    mnemonic: template.mnemonic,
    mode: template.mode,
    operand,
    directAddress: template.directAddress !== undefined ? operand : undefined,
    access: template.access,
    isCall: template.isCall,
    isReturn: template.isReturn,
  };
}

export function computeTraceSuccessorPcs(pc: number | undefined, bytes: number[]): number[] {
  if (pc === undefined) {
    return [];
  }
  const decoded = decodeTraceInstruction(bytes);
  if (decoded.mnemonic === "JMP" && decoded.mode === "abs" && decoded.operand !== undefined) {
    return [decoded.operand];
  }
  if (decoded.mnemonic === "JSR" && decoded.operand !== undefined) {
    return [decoded.operand];
  }
  if (decoded.mode === "rel" && decoded.operand !== undefined) {
    const fallthrough = (pc + decoded.size) & 0xffff;
    const offset = decoded.operand >= 0x80 ? decoded.operand - 0x100 : decoded.operand;
    const target = (fallthrough + offset) & 0xffff;
    return [fallthrough, target];
  }
  if (decoded.isReturn) {
    return [];
  }
  return [((pc + decoded.size) & 0xffff)];
}

function inferInstructionSize(opcode: number): number {
  const explicit = SIZE_BY_OPCODE.get(opcode);
  if (explicit !== undefined) {
    return explicit;
  }
  const low = opcode & 0x1f;
  if (low === 0x09 || low === 0x0b || low === 0x00 || low === 0x02) {
    return 2;
  }
  if (low === 0x0d || low === 0x0e || low === 0x0c) {
    return 3;
  }
  if ((opcode & 0x1f) === 0x01 || (opcode & 0x1f) === 0x11) {
    return 2;
  }
  if ((opcode & 0x1f) === 0x15 || (opcode & 0x1f) === 0x16 || (opcode & 0x1f) === 0x14) {
    return 2;
  }
  if ((opcode & 0x1f) === 0x19 || (opcode & 0x1f) === 0x1d || (opcode & 0x1f) === 0x1e || (opcode & 0x1f) === 0x1c) {
    return 3;
  }
  return 1;
}
