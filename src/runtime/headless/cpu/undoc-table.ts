// Sprint 92.7 v2 — illegal opcode table shared between legacy Cpu6510
// and microcoded Cpu6510Cycled. Per VICE 6510core.c.

export type UndocKind =
  | "nop" | "slo" | "rla" | "sre" | "rra"
  | "sax" | "lax" | "dcp" | "isb"
  | "anc" | "alr" | "arr" | "xaa" | "axs" | "sbc_imm"
  | "shy" | "shx" | "ahx" | "tas" | "las";

export type AddressMode =
  | "imm" | "zp" | "zpx" | "zpy" | "abs" | "absx" | "absy"
  | "ind" | "indx" | "indy" | "rel" | "acc" | "imp";

export interface UndocSlot { kind: UndocKind; mode: AddressMode; cycles: number; }

export const UNDOC_TABLE: Array<UndocSlot | null> = (() => {
  const t: Array<UndocSlot | null> = new Array(256).fill(null);
  const set = (op: number, kind: UndocKind, mode: AddressMode, cycles: number) => {
    t[op] = { kind, mode, cycles };
  };
  for (const op of [0x1a, 0x3a, 0x5a, 0x7a, 0xda, 0xfa]) set(op, "nop", "imp", 2);
  for (const op of [0x80, 0x82, 0x89, 0xc2, 0xe2]) set(op, "nop", "imm", 2);
  for (const op of [0x04, 0x44, 0x64]) set(op, "nop", "zp", 3);
  for (const op of [0x14, 0x34, 0x54, 0x74, 0xd4, 0xf4]) set(op, "nop", "zpx", 4);
  set(0x0c, "nop", "abs", 4);
  for (const op of [0x1c, 0x3c, 0x5c, 0x7c, 0xdc, 0xfc]) set(op, "nop", "absx", 4);
  set(0x07, "slo", "zp",   5); set(0x17, "slo", "zpx", 6);
  set(0x0f, "slo", "abs",  6); set(0x1f, "slo", "absx", 7);
  set(0x1b, "slo", "absy", 7); set(0x03, "slo", "indx", 8); set(0x13, "slo", "indy", 8);
  set(0x27, "rla", "zp",   5); set(0x37, "rla", "zpx", 6);
  set(0x2f, "rla", "abs",  6); set(0x3f, "rla", "absx", 7);
  set(0x3b, "rla", "absy", 7); set(0x23, "rla", "indx", 8); set(0x33, "rla", "indy", 8);
  set(0x47, "sre", "zp",   5); set(0x57, "sre", "zpx", 6);
  set(0x4f, "sre", "abs",  6); set(0x5f, "sre", "absx", 7);
  set(0x5b, "sre", "absy", 7); set(0x43, "sre", "indx", 8); set(0x53, "sre", "indy", 8);
  set(0x67, "rra", "zp",   5); set(0x77, "rra", "zpx", 6);
  set(0x6f, "rra", "abs",  6); set(0x7f, "rra", "absx", 7);
  set(0x7b, "rra", "absy", 7); set(0x63, "rra", "indx", 8); set(0x73, "rra", "indy", 8);
  set(0x87, "sax", "zp",   3); set(0x97, "sax", "zpy", 4);
  set(0x8f, "sax", "abs",  4); set(0x83, "sax", "indx", 6);
  set(0xa7, "lax", "zp",   3); set(0xb7, "lax", "zpy", 4);
  set(0xaf, "lax", "abs",  4); set(0xbf, "lax", "absy", 4);
  set(0xa3, "lax", "indx", 6); set(0xb3, "lax", "indy", 5);
  set(0xab, "lax", "imm",  2);
  set(0xc7, "dcp", "zp",   5); set(0xd7, "dcp", "zpx", 6);
  set(0xcf, "dcp", "abs",  6); set(0xdf, "dcp", "absx", 7);
  set(0xdb, "dcp", "absy", 7); set(0xc3, "dcp", "indx", 8); set(0xd3, "dcp", "indy", 8);
  set(0xe7, "isb", "zp",   5); set(0xf7, "isb", "zpx", 6);
  set(0xef, "isb", "abs",  6); set(0xff, "isb", "absx", 7);
  set(0xfb, "isb", "absy", 7); set(0xe3, "isb", "indx", 8); set(0xf3, "isb", "indy", 8);
  set(0x0b, "anc", "imm", 2); set(0x2b, "anc", "imm", 2);
  set(0x4b, "alr", "imm", 2);
  set(0x6b, "arr", "imm", 2);
  set(0x8b, "xaa", "imm", 2);
  set(0xcb, "axs", "imm", 2);
  set(0xeb, "sbc_imm", "imm", 2);
  set(0x9c, "shy", "absx", 5);
  set(0x9e, "shx", "absy", 5);
  set(0x93, "ahx", "indy", 6);
  set(0x9f, "ahx", "absy", 5);
  set(0x9b, "tas", "absy", 5);
  set(0xbb, "las", "absy", 4);
  return t;
})();
