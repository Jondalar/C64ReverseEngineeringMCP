// Spec 826 D1 — the operand semantics `mos6502.ts` does not carry: per
// mnemonic, which registers and flags an instruction reads and writes,
// whether the memory operand is read / written, the stack delta, and whether
// the instruction ends the path. One entry per mnemonic of the 256-entry table
// (documented and undocumented), refined by addressing mode in `effects()`.
//
// Locations are the nine bits of machine state the signature is over:
// A X Y SP and the flags C Z N V D I. Memory cells are named by the producer
// from the addressing mode (`memRead` / `memWrite` say whether the operand
// cell is touched); `acc` mode turns the operand into A.

export type Loc = "A" | "X" | "Y" | "SP" | "C" | "Z" | "N" | "V" | "D" | "I";

export interface Effects {
  reads: Loc[];
  writes: Loc[];
  /** the operand cell is read (`lda`, `inc`, `bit`, …) */
  memRead: boolean;
  /** the operand cell is written (`sta`, `inc`, `asl mem`, …) */
  memWrite: boolean;
  /** SP delta in bytes: push +1, pull −1, jsr +2, rts −2, rti −3, brk +3; NaN = unknown (`txs`, `tas`, `las`) */
  stack: number;
  /** the instruction ends the path: `rts` `rti` `jmp` `brk` `jam` */
  terminal?: boolean;
  /** the flag a conditional branch reads */
  branchFlag?: Loc;
}

const NZ: Loc[] = ["N", "Z"];
const NZC: Loc[] = ["N", "Z", "C"];
const NZCV: Loc[] = ["N", "Z", "C", "V"];
const ALL_FLAGS: Loc[] = ["C", "Z", "N", "V", "D", "I"];

interface Base { r?: Loc[]; w?: Loc[]; mr?: boolean; mw?: boolean; s?: number; t?: boolean; bf?: Loc }

// One row per mnemonic. `mr` / `mw` describe the non-accumulator forms; the
// `acc` and `imm` modes are corrected in effects().
const TABLE: Record<string, Base> = {
  // loads / stores
  lda: { w: ["A", ...NZ], mr: true },
  ldx: { w: ["X", ...NZ], mr: true },
  ldy: { w: ["Y", ...NZ], mr: true },
  sta: { r: ["A"], mw: true },
  stx: { r: ["X"], mw: true },
  sty: { r: ["Y"], mw: true },
  // transfers
  tax: { r: ["A"], w: ["X", ...NZ] },
  tay: { r: ["A"], w: ["Y", ...NZ] },
  txa: { r: ["X"], w: ["A", ...NZ] },
  tya: { r: ["Y"], w: ["A", ...NZ] },
  tsx: { r: ["SP"], w: ["X", ...NZ] },
  txs: { r: ["X"], w: ["SP"], s: Number.NaN },
  // stack
  pha: { r: ["A"], s: 1 },
  php: { r: [...ALL_FLAGS], s: 1 },
  pla: { w: ["A", ...NZ], s: -1 },
  plp: { w: [...ALL_FLAGS], s: -1 },
  // logic / arithmetic
  and: { r: ["A"], w: ["A", ...NZ], mr: true },
  ora: { r: ["A"], w: ["A", ...NZ], mr: true },
  eor: { r: ["A"], w: ["A", ...NZ], mr: true },
  adc: { r: ["A", "C"], w: ["A", ...NZCV], mr: true },
  sbc: { r: ["A", "C"], w: ["A", ...NZCV], mr: true },
  cmp: { r: ["A"], w: [...NZC], mr: true },
  cpx: { r: ["X"], w: [...NZC], mr: true },
  cpy: { r: ["Y"], w: [...NZC], mr: true },
  bit: { r: ["A"], w: ["N", "V", "Z"], mr: true },
  // read-modify-write
  inc: { w: [...NZ], mr: true, mw: true },
  dec: { w: [...NZ], mr: true, mw: true },
  asl: { w: [...NZC], mr: true, mw: true },
  lsr: { w: [...NZC], mr: true, mw: true },
  rol: { r: ["C"], w: [...NZC], mr: true, mw: true },
  ror: { r: ["C"], w: [...NZC], mr: true, mw: true },
  inx: { r: ["X"], w: ["X", ...NZ] },
  dex: { r: ["X"], w: ["X", ...NZ] },
  iny: { r: ["Y"], w: ["Y", ...NZ] },
  dey: { r: ["Y"], w: ["Y", ...NZ] },
  // flags
  clc: { w: ["C"] },
  sec: { w: ["C"] },
  cld: { w: ["D"] },
  sed: { w: ["D"] },
  cli: { w: ["I"] },
  sei: { w: ["I"] },
  clv: { w: ["V"] },
  // control flow
  jmp: { t: true },
  jsr: { s: 2 },
  rts: { s: -2, t: true },
  rti: { r: [...ALL_FLAGS], w: [...ALL_FLAGS], s: -3, t: true },
  brk: { r: [...ALL_FLAGS], w: ["I"], s: 3, t: true },
  bcc: { r: ["C"], bf: "C" },
  bcs: { r: ["C"], bf: "C" },
  beq: { r: ["Z"], bf: "Z" },
  bne: { r: ["Z"], bf: "Z" },
  bmi: { r: ["N"], bf: "N" },
  bpl: { r: ["N"], bf: "N" },
  bvc: { r: ["V"], bf: "V" },
  bvs: { r: ["V"], bf: "V" },
  nop: {},
  // undocumented — documented behaviour
  lax: { w: ["A", "X", ...NZ], mr: true },
  sax: { r: ["A", "X"], mw: true },
  dcp: { r: ["A"], w: [...NZC], mr: true, mw: true },
  isc: { r: ["A", "C"], w: ["A", ...NZCV], mr: true, mw: true },
  slo: { r: ["A"], w: ["A", ...NZC], mr: true, mw: true },
  rla: { r: ["A", "C"], w: ["A", ...NZC], mr: true, mw: true },
  sre: { r: ["A"], w: ["A", ...NZC], mr: true, mw: true },
  rra: { r: ["A", "C"], w: ["A", ...NZCV], mr: true, mw: true },
  anc: { r: ["A"], w: ["A", ...NZC] },
  alr: { r: ["A"], w: ["A", ...NZC] },
  arr: { r: ["A", "C"], w: ["A", ...NZCV] },
  axs: { r: ["A", "X"], w: ["X", ...NZC] },
  las: { r: ["SP"], w: ["A", "X", "SP", ...NZ], mr: true, s: Number.NaN },
  ahx: { r: ["A", "X"], mw: true },
  shx: { r: ["X"], mw: true },
  shy: { r: ["Y"], mw: true },
  tas: { r: ["A", "X"], w: ["SP"], mw: true, s: Number.NaN },
  xaa: { r: ["A", "X"], w: ["A", ...NZ] },
  jam: { t: true },
};

export const MNEMONICS: readonly string[] = Object.keys(TABLE);
export const BRANCHES: ReadonlySet<string> = new Set(["bcc", "bcs", "beq", "bne", "bmi", "bpl", "bvc", "bvs"]);

/** The register an indexed addressing mode reads: `,x` / `(zp,x)` → X, `,y` / `(zp),y` → Y. */
export function indexRegister(mode: string): Loc | undefined {
  if (mode === "zp,x" || mode === "abs,x" || mode === "(zp,x)") return "X";
  if (mode === "zp,y" || mode === "abs,y" || mode === "(zp),y") return "Y";
  return undefined;
}

/**
 * Read / write sets of one instruction. Unknown mnemonics answer an empty
 * effect (nothing read, nothing written) rather than throwing — the report
 * is the instruction stream and a byte the table does not know is a fact
 * about the table, not a reason to stop the producer.
 */
export function effects(mnemonic: string, mode: string): Effects {
  const base = TABLE[mnemonic.toLowerCase()] ?? {};
  const reads = new Set<Loc>(base.r ?? []);
  const writes = new Set<Loc>(base.w ?? []);
  let memRead = base.mr ?? false;
  let memWrite = base.mw ?? false;
  if (mode === "imm") {
    memRead = false;
    memWrite = false;
  } else if (mode === "acc") {
    if (memRead) reads.add("A");
    if (memWrite) writes.add("A");
    memRead = false;
    memWrite = false;
  } else if (mode === "impl" || mode === "rel") {
    memRead = false;
    memWrite = false;
  }
  const idx = indexRegister(mode);
  if (idx) reads.add(idx);
  const out: Effects = { reads: [...reads], writes: [...writes], memRead, memWrite, stack: base.s ?? 0 };
  if (base.t) out.terminal = true;
  if (base.bf) out.branchFlag = base.bf;
  return out;
}
