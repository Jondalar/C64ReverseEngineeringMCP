export type CpuOp = 'adc' | 'and' | 'asl' | 'bcc' | 'bcs' | 'beq' | 'bit' | 'bmi' | 'bne' | 'bpl' | 'brk' | 'bvc' | 'bvs' | 'clc' | 'cld' | 'cli' | 'clv' | 'cmp' | 'cpx' | 'cpy' | 'dec' | 'dex' | 'dey' | 'eor' | 'inc' | 'inx' | 'iny' | 'jmp' | 'jsr' | 'lda' | 'ldx' | 'ldy' | 'lsr' | 'nop' | 'ora' | 'pha' | 'php' | 'pla' | 'plp' | 'rol' | 'ror' | 'rti' | 'rts' | 'sbc' | 'sec' | 'sed' | 'sei' | 'sta' | 'stx' | 'sty' | 'tax' | 'tay' | 'tsx' | 'txa' | 'txs' | 'tya';
export type AddressMode = 'imm' | 'zp' | 'zpx' | 'zpy' | 'abs' | 'absx' | 'absy' | 'ind' | 'indx' | 'indy' | 'rel' | 'acc' | 'imp';
export interface OpcodeInfo { op: CpuOp; mode: AddressMode; cycles: number; }
export const OPCODE_TABLE: Array<OpcodeInfo | null> = [
  {
    "op": "brk",
    "mode": "imp",
    "cycles": 7
  },
  {
    "op": "ora",
    "mode": "indx",
    "cycles": 6
  },
  null,
  null,
  null,
  {
    "op": "ora",
    "mode": "zp",
    "cycles": 3
  },
  {
    "op": "asl",
    "mode": "zp",
    "cycles": 5
  },
  null,
  {
    "op": "php",
    "mode": "imp",
    "cycles": 3
  },
  {
    "op": "ora",
    "mode": "imm",
    "cycles": 2
  },
  {
    "op": "asl",
    "mode": "acc",
    "cycles": 2
  },
  null,
  null,
  {
    "op": "ora",
    "mode": "abs",
    "cycles": 4
  },
  {
    "op": "asl",
    "mode": "abs",
    "cycles": 6
  },
  null,
  {
    "op": "bpl",
    "mode": "rel",
    "cycles": 2
  },
  {
    "op": "ora",
    "mode": "indy",
    "cycles": 5
  },
  null,
  null,
  null,
  {
    "op": "ora",
    "mode": "zpx",
    "cycles": 4
  },
  {
    "op": "asl",
    "mode": "zpx",
    "cycles": 6
  },
  null,
  {
    "op": "clc",
    "mode": "imp",
    "cycles": 2
  },
  {
    "op": "ora",
    "mode": "absy",
    "cycles": 4
  },
  null,
  null,
  null,
  {
    "op": "ora",
    "mode": "absx",
    "cycles": 4
  },
  {
    "op": "asl",
    "mode": "absx",
    "cycles": 7
  },
  null,
  {
    "op": "jsr",
    "mode": "abs",
    "cycles": 6
  },
  {
    "op": "and",
    "mode": "indx",
    "cycles": 6
  },
  null,
  null,
  {
    "op": "bit",
    "mode": "zp",
    "cycles": 3
  },
  {
    "op": "and",
    "mode": "zp",
    "cycles": 3
  },
  {
    "op": "rol",
    "mode": "zp",
    "cycles": 5
  },
  null,
  {
    "op": "plp",
    "mode": "imp",
    "cycles": 4
  },
  {
    "op": "and",
    "mode": "imm",
    "cycles": 2
  },
  {
    "op": "rol",
    "mode": "acc",
    "cycles": 2
  },
  null,
  {
    "op": "bit",
    "mode": "abs",
    "cycles": 4
  },
  {
    "op": "and",
    "mode": "abs",
    "cycles": 4
  },
  {
    "op": "rol",
    "mode": "abs",
    "cycles": 6
  },
  null,
  {
    "op": "bmi",
    "mode": "rel",
    "cycles": 2
  },
  {
    "op": "and",
    "mode": "indy",
    "cycles": 5
  },
  null,
  null,
  null,
  {
    "op": "and",
    "mode": "zpx",
    "cycles": 4
  },
  {
    "op": "rol",
    "mode": "zpx",
    "cycles": 6
  },
  null,
  {
    "op": "sec",
    "mode": "imp",
    "cycles": 2
  },
  {
    "op": "and",
    "mode": "absy",
    "cycles": 4
  },
  null,
  null,
  null,
  {
    "op": "and",
    "mode": "absx",
    "cycles": 4
  },
  {
    "op": "rol",
    "mode": "absx",
    "cycles": 7
  },
  null,
  {
    "op": "rti",
    "mode": "imp",
    "cycles": 6
  },
  {
    "op": "eor",
    "mode": "indx",
    "cycles": 6
  },
  null,
  null,
  null,
  {
    "op": "eor",
    "mode": "zp",
    "cycles": 4
  },
  {
    "op": "lsr",
    "mode": "zp",
    "cycles": 5
  },
  null,
  {
    "op": "pha",
    "mode": "imp",
    "cycles": 3
  },
  {
    "op": "eor",
    "mode": "imm",
    "cycles": 2
  },
  {
    "op": "lsr",
    "mode": "acc",
    "cycles": 2
  },
  null,
  {
    "op": "jmp",
    "mode": "abs",
    "cycles": 3
  },
  {
    "op": "eor",
    "mode": "abs",
    "cycles": 4
  },
  {
    "op": "lsr",
    "mode": "abs",
    "cycles": 6
  },
  null,
  {
    "op": "bvc",
    "mode": "rel",
    "cycles": 2
  },
  {
    "op": "eor",
    "mode": "indy",
    "cycles": 5
  },
  null,
  null,
  null,
  {
    "op": "eor",
    "mode": "zpx",
    "cycles": 3
  },
  {
    "op": "lsr",
    "mode": "zpx",
    "cycles": 6
  },
  null,
  {
    "op": "cli",
    "mode": "imp",
    "cycles": 2
  },
  {
    "op": "eor",
    "mode": "absy",
    "cycles": 4
  },
  null,
  null,
  null,
  {
    "op": "eor",
    "mode": "absx",
    "cycles": 4
  },
  {
    "op": "lsr",
    "mode": "absx",
    "cycles": 7
  },
  null,
  {
    "op": "rts",
    "mode": "imp",
    "cycles": 6
  },
  {
    "op": "adc",
    "mode": "indx",
    "cycles": 6
  },
  null,
  null,
  null,
  {
    "op": "adc",
    "mode": "zp",
    "cycles": 3
  },
  {
    "op": "ror",
    "mode": "zp",
    "cycles": 5
  },
  null,
  {
    "op": "pla",
    "mode": "imp",
    "cycles": 4
  },
  {
    "op": "adc",
    "mode": "imm",
    "cycles": 2
  },
  {
    "op": "ror",
    "mode": "acc",
    "cycles": 2
  },
  {
    "op": "jmp",
    "mode": "ind",
    "cycles": 5
  },
  null,
  {
    "op": "adc",
    "mode": "abs",
    "cycles": 4
  },
  {
    "op": "ror",
    "mode": "abs",
    "cycles": 6
  },
  null,
  {
    "op": "bvs",
    "mode": "rel",
    "cycles": 2
  },
  {
    "op": "adc",
    "mode": "indy",
    "cycles": 5
  },
  null,
  null,
  null,
  {
    "op": "adc",
    "mode": "zpx",
    "cycles": 4
  },
  {
    "op": "ror",
    "mode": "zpx",
    "cycles": 6
  },
  null,
  {
    "op": "sei",
    "mode": "imp",
    "cycles": 2
  },
  {
    "op": "adc",
    "mode": "absy",
    "cycles": 4
  },
  null,
  null,
  null,
  {
    "op": "adc",
    "mode": "absx",
    "cycles": 4
  },
  {
    "op": "ror",
    "mode": "absx",
    "cycles": 7
  },
  null,
  null,
  {
    "op": "sta",
    "mode": "indx",
    "cycles": 6
  },
  null,
  null,
  {
    "op": "sty",
    "mode": "zp",
    "cycles": 3
  },
  {
    "op": "sta",
    "mode": "zp",
    "cycles": 3
  },
  {
    "op": "stx",
    "mode": "zp",
    "cycles": 3
  },
  null,
  {
    "op": "dey",
    "mode": "imp",
    "cycles": 2
  },
  null,
  {
    "op": "txa",
    "mode": "imp",
    "cycles": 2
  },
  null,
  {
    "op": "sty",
    "mode": "abs",
    "cycles": 4
  },
  {
    "op": "sta",
    "mode": "abs",
    "cycles": 4
  },
  {
    "op": "stx",
    "mode": "abs",
    "cycles": 4
  },
  null,
  {
    "op": "bcc",
    "mode": "rel",
    "cycles": 2
  },
  {
    "op": "sta",
    "mode": "indy",
    "cycles": 6
  },
  null,
  null,
  {
    "op": "sty",
    "mode": "zpx",
    "cycles": 4
  },
  {
    "op": "sta",
    "mode": "zpx",
    "cycles": 4
  },
  {
    "op": "stx",
    "mode": "zpy",
    "cycles": 4
  },
  null,
  {
    "op": "tya",
    "mode": "imp",
    "cycles": 2
  },
  {
    "op": "sta",
    "mode": "absy",
    "cycles": 5
  },
  {
    "op": "txs",
    "mode": "imp",
    "cycles": 2
  },
  null,
  null,
  {
    "op": "sta",
    "mode": "absx",
    "cycles": 5
  },
  null,
  null,
  {
    "op": "ldy",
    "mode": "imm",
    "cycles": 2
  },
  {
    "op": "lda",
    "mode": "indx",
    "cycles": 6
  },
  {
    "op": "ldx",
    "mode": "imm",
    "cycles": 2
  },
  null,
  {
    "op": "ldy",
    "mode": "zp",
    "cycles": 3
  },
  {
    "op": "lda",
    "mode": "zp",
    "cycles": 3
  },
  {
    "op": "ldx",
    "mode": "zp",
    "cycles": 3
  },
  null,
  {
    "op": "tay",
    "mode": "imp",
    "cycles": 2
  },
  {
    "op": "lda",
    "mode": "imm",
    "cycles": 2
  },
  {
    "op": "tax",
    "mode": "imp",
    "cycles": 2
  },
  null,
  {
    "op": "ldy",
    "mode": "abs",
    "cycles": 4
  },
  {
    "op": "lda",
    "mode": "abs",
    "cycles": 4
  },
  {
    "op": "ldx",
    "mode": "abs",
    "cycles": 4
  },
  null,
  {
    "op": "bcs",
    "mode": "rel",
    "cycles": 2
  },
  {
    "op": "lda",
    "mode": "indy",
    "cycles": 5
  },
  null,
  null,
  {
    "op": "ldy",
    "mode": "zpx",
    "cycles": 4
  },
  {
    "op": "lda",
    "mode": "zpx",
    "cycles": 4
  },
  {
    "op": "ldx",
    "mode": "zpy",
    "cycles": 4
  },
  null,
  {
    "op": "clv",
    "mode": "imp",
    "cycles": 2
  },
  {
    "op": "lda",
    "mode": "absy",
    "cycles": 4
  },
  {
    "op": "tsx",
    "mode": "imp",
    "cycles": 2
  },
  null,
  {
    "op": "ldy",
    "mode": "absx",
    "cycles": 4
  },
  {
    "op": "lda",
    "mode": "absx",
    "cycles": 4
  },
  {
    "op": "ldx",
    "mode": "absy",
    "cycles": 4
  },
  null,
  {
    "op": "cpy",
    "mode": "imm",
    "cycles": 2
  },
  {
    "op": "cmp",
    "mode": "indx",
    "cycles": 6
  },
  null,
  null,
  {
    "op": "cpy",
    "mode": "zp",
    "cycles": 3
  },
  {
    "op": "cmp",
    "mode": "zp",
    "cycles": 3
  },
  {
    "op": "dec",
    "mode": "zp",
    "cycles": 5
  },
  null,
  {
    "op": "iny",
    "mode": "imp",
    "cycles": 2
  },
  {
    "op": "cmp",
    "mode": "imm",
    "cycles": 2
  },
  {
    "op": "dex",
    "mode": "imp",
    "cycles": 2
  },
  null,
  {
    "op": "cpy",
    "mode": "abs",
    "cycles": 4
  },
  {
    "op": "cmp",
    "mode": "abs",
    "cycles": 4
  },
  {
    "op": "dec",
    "mode": "abs",
    "cycles": 6
  },
  null,
  {
    "op": "bne",
    "mode": "rel",
    "cycles": 2
  },
  {
    "op": "cmp",
    "mode": "indy",
    "cycles": 5
  },
  null,
  null,
  null,
  {
    "op": "cmp",
    "mode": "zpx",
    "cycles": 4
  },
  {
    "op": "dec",
    "mode": "zpx",
    "cycles": 6
  },
  null,
  {
    "op": "cld",
    "mode": "imp",
    "cycles": 2
  },
  {
    "op": "cmp",
    "mode": "absy",
    "cycles": 4
  },
  null,
  null,
  null,
  {
    "op": "cmp",
    "mode": "absx",
    "cycles": 4
  },
  {
    "op": "dec",
    "mode": "absx",
    "cycles": 7
  },
  null,
  {
    "op": "cpx",
    "mode": "imm",
    "cycles": 2
  },
  {
    "op": "sbc",
    "mode": "indx",
    "cycles": 6
  },
  null,
  null,
  {
    "op": "cpx",
    "mode": "zp",
    "cycles": 3
  },
  {
    "op": "sbc",
    "mode": "zp",
    "cycles": 3
  },
  {
    "op": "inc",
    "mode": "zp",
    "cycles": 5
  },
  null,
  {
    "op": "inx",
    "mode": "imp",
    "cycles": 2
  },
  {
    "op": "sbc",
    "mode": "imm",
    "cycles": 2
  },
  {
    "op": "nop",
    "mode": "imp",
    "cycles": 2
  },
  null,
  {
    "op": "cpx",
    "mode": "abs",
    "cycles": 4
  },
  {
    "op": "sbc",
    "mode": "abs",
    "cycles": 4
  },
  {
    "op": "inc",
    "mode": "abs",
    "cycles": 6
  },
  null,
  {
    "op": "beq",
    "mode": "rel",
    "cycles": 2
  },
  {
    "op": "sbc",
    "mode": "indy",
    "cycles": 5
  },
  null,
  null,
  null,
  {
    "op": "sbc",
    "mode": "zpx",
    "cycles": 4
  },
  {
    "op": "inc",
    "mode": "zpx",
    "cycles": 6
  },
  null,
  {
    "op": "sed",
    "mode": "imp",
    "cycles": 2
  },
  {
    "op": "sbc",
    "mode": "absy",
    "cycles": 4
  },
  null,
  null,
  null,
  {
    "op": "sbc",
    "mode": "absx",
    "cycles": 4
  },
  {
    "op": "inc",
    "mode": "absx",
    "cycles": 7
  },
  null
] as Array<OpcodeInfo | null>;
