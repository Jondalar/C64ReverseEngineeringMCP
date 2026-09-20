// Spec 861 §3.4 — equivalence, by symbolic execution.
//
// Two versions of a straight-line block are run over expressions instead of
// bytes, and their EFFECTS are compared: A, X, Y, the stack pointer, the flags
// that are live afterwards, and every memory write — address and value as
// expressions. A read of a cell the block wrote is resolved; every other read is
// a symbol, and the same read in both versions is the same symbol, so two
// different spellings of the same computation come out equal.
//
// I/O IS NOT MEMORY. Reading $DC0D clears the CIA's interrupt flags; reading
// $D012 twice gives two different values. So an access to $D000-$DFFF is
// recorded as an event, each read is its own symbol, and the two versions must
// make the SAME accesses in the SAME ORDER or they are not equivalent — even
// when every register and every RAM cell agrees.
//
// The verdict is EQUIVALENT, NOT EQUIVALENT with the differing effect, or
// UNKNOWN with the reason named. UNKNOWN is a real answer here: a loop, an
// indirect jump, a write to an address that is not constant, an opcode this
// does not model. Guessing in the other direction would be the one failure mode
// that breaks a program.

import type { Insn } from "./cfg.js";
import type { Loc } from "../knowledge-graph/isa-6502.js";
import type { LocSet } from "./liveness.js";

// --------------------------------------------------------------------- Expr

export type Expr =
  | { k: "c"; v: number }
  | { k: "s"; n: string }
  | { k: "add"; terms: Expr[]; c: number }
  | { k: "op"; op: string; args: Expr[] };

export const K = (v: number): Expr => ({ k: "c", v: v & 0xff });
export const S = (n: string): Expr => ({ k: "s", n });

export function key(e: Expr): string {
  switch (e.k) {
    case "c": return `#${e.v}`;
    case "s": return e.n;
    case "add": return `(+ ${[...e.terms.map(key)].sort().join(" ")}${e.c ? ` ${e.c}` : ""})`;
    case "op": return `(${e.op} ${e.args.map(key).join(" ")})`;
  }
}

export function show(e: Expr): string {
  switch (e.k) {
    case "c": return `$${e.v.toString(16).toUpperCase().padStart(2, "0")}`;
    case "s": return e.n;
    case "add": {
      const parts = e.terms.map(show);
      if (e.c) parts.push(`$${(e.c & 0xff).toString(16).toUpperCase().padStart(2, "0")}`);
      return parts.length === 1 ? parts[0]! : `(${parts.join(" + ")})`;
    }
    case "op": return `${e.op}(${e.args.map(show).join(", ")})`;
  }
}

export const isConst = (e: Expr): e is { k: "c"; v: number } => e.k === "c";
export const same = (a: Expr, b: Expr): boolean => key(a) === key(b);

/** Sum mod 256, flattened and sorted, so `a + 1` written two ways is one expression. */
export function add(...parts: Expr[]): Expr {
  const terms: Expr[] = [];
  let c = 0;
  const push = (e: Expr): void => {
    if (e.k === "c") { c += e.v; return; }
    if (e.k === "add") { c += e.c; for (const t of e.terms) push(t); return; }
    terms.push(e);
  };
  for (const p of parts) push(p);
  c &= 0xff;
  if (terms.length === 0) return K(c);
  terms.sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
  return { k: "add", terms, c };
}

function op(name: string, ...args: Expr[]): Expr {
  return { k: "op", op: name, args };
}

const byteOp = (name: string, fold: (a: number, b: number) => number) => (a: Expr, b: Expr): Expr =>
  isConst(a) && isConst(b) ? K(fold(a.v, b.v)) : op(name, a, b);

const andE = byteOp("and", (a, b) => a & b);
const oraE = byteOp("ora", (a, b) => a | b);
const eorE = byteOp("eor", (a, b) => a ^ b);

/** N and Z of a byte-valued expression. Constant in, constant out. */
const nOf = (v: Expr): Expr => (isConst(v) ? K((v.v & 0x80) !== 0 ? 1 : 0) : op("N", v));
const zOf = (v: Expr): Expr => (isConst(v) ? K(v.v === 0 ? 1 : 0) : op("Z", v));

// --------------------------------------------------------------------- state

export type FlagName = "C" | "Z" | "N" | "V" | "D" | "I";

export interface MemWrite { order: number; where: string; value: Expr }
export interface IoAccess { order: number; kind: "read" | "write"; addr: number; value?: Expr }

export interface SymState {
  a: Expr; x: Expr; y: Expr;
  /** stack pointer, relative to the entry value; NaN once it stops being known */
  spDelta: number;
  flags: Record<FlagName, Expr>;
  /** constant RAM cells this block has written */
  mem: Map<number, Expr>;
  /** every write, in order, keyed by where it went */
  writes: MemWrite[];
  /** every access to $D000-$DFFF, in order */
  io: IoAccess[];
  /** reasons this state cannot decide an equivalence */
  unknown: string[];
  /** how many times each volatile address has been read */
  volatileReads: Map<number, number>;
  order: number;
}

export interface SymOptions {
  /** Decimal mode at entry. The C64 runs with D clear; a block that sets it is modelled as unknown. */
  decimalAtEntry?: "clear" | "unknown";
  /** a suffix on every entry symbol, so two versions of the same code share them */
  entryTag?: string;
}

const IO = (addr: number): boolean => addr >= 0xd000 && addr <= 0xdfff;
const hex4 = (a: number): string => `$${(a & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;

export function initialState(options: SymOptions = {}): SymState {
  const d = options.decimalAtEntry === "unknown" ? S("D_in") : K(0);
  return {
    a: S("A_in"), x: S("X_in"), y: S("Y_in"),
    spDelta: 0,
    flags: { C: S("C_in"), Z: S("Z_in"), N: S("N_in"), V: S("V_in"), D: d, I: S("I_in") },
    mem: new Map(), writes: [], io: [], unknown: [], volatileReads: new Map(), order: 0,
  };
}

// --------------------------------------------------------------------- exec

function readMem(st: SymState, addr: number): Expr {
  if (IO(addr)) {
    const n = (st.volatileReads.get(addr) ?? 0) + 1;
    st.volatileReads.set(addr, n);
    st.io.push({ order: st.order++, kind: "read", addr });
    return S(`io[${hex4(addr)}]#${n}`);
  }
  const held = st.mem.get(addr);
  if (held) return held;
  const fresh = S(`m[${hex4(addr)}]`);
  st.mem.set(addr, fresh);
  return fresh;
}

function writeMem(st: SymState, addr: number, value: Expr): void {
  if (IO(addr)) st.io.push({ order: st.order++, kind: "write", addr, value });
  else st.mem.set(addr, value);
  st.writes.push({ order: st.order++, where: hex4(addr), value });
}

function push(st: SymState, value: Expr): void {
  st.writes.push({ order: st.order++, where: `stack[${st.spDelta}]`, value });
  st.spDelta -= 1;
}

function pull(st: SymState): Expr {
  st.spDelta += 1;
  const slot = `stack[${st.spDelta}]`;
  const held = [...st.writes].reverse().find((w) => w.where === slot);
  return held ? held.value : S(`stack_in[${st.spDelta}]`);
}

/** The effective address, when it is a constant. `undefined` means the address
 *  depends on data, and an equivalence over it is UNKNOWN rather than guessed. */
function effectiveAddress(st: SymState, insn: Insn): { addr?: number; why?: string } {
  const o = insn.operand ?? 0;
  switch (insn.mode) {
    case "zp": return { addr: o };
    case "abs": return { addr: o };
    case "zp,x": return isConst(st.x) ? { addr: (o + st.x.v) & 0xff } : { why: `${insn.mnemonic} ${insn.text} — X is not a constant here` };
    case "zp,y": return isConst(st.y) ? { addr: (o + st.y.v) & 0xff } : { why: `${insn.mnemonic} ${insn.text} — Y is not a constant here` };
    case "abs,x": return isConst(st.x) ? { addr: (o + st.x.v) & 0xffff } : { why: `${insn.mnemonic} ${insn.text} — X is not a constant here` };
    case "abs,y": return isConst(st.y) ? { addr: (o + st.y.v) & 0xffff } : { why: `${insn.mnemonic} ${insn.text} — Y is not a constant here` };
    case "(zp,x)": return { why: `${insn.mnemonic} ${insn.text} — the address comes from a pointer in zero page` };
    case "(zp),y": return { why: `${insn.mnemonic} ${insn.text} — the address comes from a pointer in zero page` };
    default: return { why: `${insn.mnemonic} has no memory operand` };
  }
}

const SIMPLE_FLAG: Record<string, [FlagName, number]> = {
  clc: ["C", 0], sec: ["C", 1], cld: ["D", 0], sed: ["D", 1], cli: ["I", 0], sei: ["I", 1], clv: ["V", 0],
};

/** Run one instruction. Returns false when the instruction is not modelled. */
export function execute(st: SymState, insn: Insn): boolean {
  const m = insn.mnemonic;
  const setNZ = (v: Expr): void => { st.flags.N = nOf(v); st.flags.Z = zOf(v); };

  const operandValue = (): Expr | null => {
    if (insn.mode === "imm") return K(insn.operand ?? 0);
    if (insn.mode === "acc") return st.a;
    const ea = effectiveAddress(st, insn);
    if (ea.addr === undefined) { st.unknown.push(ea.why ?? "an address that is not constant"); return null; }
    return readMem(st, ea.addr);
  };
  const storeTo = (value: Expr): boolean => {
    const ea = effectiveAddress(st, insn);
    if (ea.addr === undefined) { st.unknown.push(ea.why ?? "a write to an address that is not constant"); return false; }
    writeMem(st, ea.addr, value);
    return true;
  };
  const rmw = (fn: (v: Expr) => Expr): boolean => {
    if (insn.mode === "acc") { st.a = fn(st.a); return true; }
    const ea = effectiveAddress(st, insn);
    if (ea.addr === undefined) { st.unknown.push(ea.why ?? "a read-modify-write on an address that is not constant"); return false; }
    const v = fn(readMem(st, ea.addr));
    writeMem(st, ea.addr, v);
    return true;
  };

  if (SIMPLE_FLAG[m]) { const [f, v] = SIMPLE_FLAG[m]!; st.flags[f] = K(v); return true; }

  switch (m) {
    case "nop": return true;
    case "lda": { const v = operandValue(); if (!v) return true; st.a = v; setNZ(v); return true; }
    case "ldx": { const v = operandValue(); if (!v) return true; st.x = v; setNZ(v); return true; }
    case "ldy": { const v = operandValue(); if (!v) return true; st.y = v; setNZ(v); return true; }
    case "lax": { const v = operandValue(); if (!v) return true; st.a = v; st.x = v; setNZ(v); return true; }
    case "sta": storeTo(st.a); return true;
    case "stx": storeTo(st.x); return true;
    case "sty": storeTo(st.y); return true;
    case "sax": storeTo(andE(st.a, st.x)); return true;
    case "tax": st.x = st.a; setNZ(st.x); return true;
    case "tay": st.y = st.a; setNZ(st.y); return true;
    case "txa": st.a = st.x; setNZ(st.a); return true;
    case "tya": st.a = st.y; setNZ(st.a); return true;
    case "tsx": st.x = S(`SP_in+${st.spDelta}`); setNZ(st.x); return true;
    case "txs": st.unknown.push("txs sets the stack pointer from data — the stack delta stops being known"); st.spDelta = Number.NaN; return true;
    case "pha": push(st, st.a); return true;
    case "php": push(st, op("P", st.flags.N, st.flags.V, st.flags.D, st.flags.I, st.flags.Z, st.flags.C)); return true;
    case "pla": st.a = pull(st); setNZ(st.a); return true;
    case "plp": {
      const v = pull(st);
      for (const f of ["C", "Z", "N", "V", "D", "I"] as FlagName[]) st.flags[f] = op(`bit.${f}`, v);
      return true;
    }
    case "and": { const v = operandValue(); if (!v) return true; st.a = andE(st.a, v); setNZ(st.a); return true; }
    case "ora": { const v = operandValue(); if (!v) return true; st.a = oraE(st.a, v); setNZ(st.a); return true; }
    case "eor": { const v = operandValue(); if (!v) return true; st.a = eorE(st.a, v); setNZ(st.a); return true; }
    case "bit": {
      const v = operandValue(); if (!v) return true;
      st.flags.Z = zOf(andE(st.a, v));
      st.flags.N = op("bit7", v);
      st.flags.V = op("bit6", v);
      return true;
    }
    case "adc": case "sbc": {
      const v = operandValue(); if (!v) return true;
      const decimalKnownClear = isConst(st.flags.D) && st.flags.D.v === 0;
      const carryIn = st.flags.C;
      if (decimalKnownClear && isConst(carryIn)) {
        // Binary mode with a known carry: the sum is arithmetic, so `clc/adc #$01`
        // and `inc` reach the same expression. A subtraction of a constant is the
        // same sum with the operand complemented; of anything else it stays opaque.
        const value = m === "adc"
          ? add(st.a, v, K(carryIn.v))
          : isConst(v)
            ? add(st.a, K(~v.v & 0xff), K(carryIn.v))
            : op("sbc", st.a, v, carryIn);
        st.flags.C = op(`${m}.C`, st.a, v, carryIn);
        st.flags.V = op(`${m}.V`, st.a, v, carryIn);
        st.a = value;
      } else {
        st.a = op(m, st.a, v, carryIn, st.flags.D);
        st.flags.C = op(`${m}.C`, st.a, v, carryIn, st.flags.D);
        st.flags.V = op(`${m}.V`, st.a, v, carryIn, st.flags.D);
      }
      setNZ(st.a);
      return true;
    }
    case "cmp": case "cpx": case "cpy": {
      const v = operandValue(); if (!v) return true;
      const reg = m === "cmp" ? st.a : m === "cpx" ? st.x : st.y;
      st.flags.C = op("cmp.C", reg, v);
      setNZ(op("cmp.R", reg, v));
      return true;
    }
    case "inc": rmw((v) => { const r = add(v, K(1)); setNZ(r); return r; }); return true;
    case "dec": rmw((v) => { const r = add(v, K(0xff)); setNZ(r); return r; }); return true;
    case "inx": st.x = add(st.x, K(1)); setNZ(st.x); return true;
    case "dex": st.x = add(st.x, K(0xff)); setNZ(st.x); return true;
    case "iny": st.y = add(st.y, K(1)); setNZ(st.y); return true;
    case "dey": st.y = add(st.y, K(0xff)); setNZ(st.y); return true;
    case "asl": rmw((v) => { st.flags.C = op("bit7", v); const r = isConst(v) ? K((v.v << 1) & 0xff) : op("asl", v); setNZ(r); return r; }); return true;
    case "lsr": rmw((v) => { st.flags.C = op("bit0", v); const r = isConst(v) ? K(v.v >> 1) : op("lsr", v); setNZ(r); return r; }); return true;
    case "rol": rmw((v) => { const cin = st.flags.C; st.flags.C = op("bit7", v); const r = op("rol", v, cin); setNZ(r); return r; }); return true;
    case "ror": rmw((v) => { const cin = st.flags.C; st.flags.C = op("bit0", v); const r = op("ror", v, cin); setNZ(r); return r; }); return true;
    default:
      st.unknown.push(`${m} is not modelled by the equivalence check`);
      return false;
  }
}

export function runStraightLine(insns: readonly Insn[], options: SymOptions = {}): SymState {
  const st = initialState(options);
  for (const insn of insns) execute(st, insn);
  return st;
}

// ----------------------------------------------------------------- compare

export type Verdict = "EQUIVALENT" | "NOT EQUIVALENT" | "UNKNOWN";

export interface Comparison {
  verdict: Verdict;
  /** the differing effect, for NOT EQUIVALENT */
  counterExample?: string;
  /** every reason the answer cannot be decided, for UNKNOWN */
  reasons: string[];
  /** what the verdict rests on */
  assumptions: string[];
  /** what was compared */
  compared: string[];
}

const REG_OF: Partial<Record<Loc, (s: SymState) => Expr>> = {
  A: (s) => s.a, X: (s) => s.x, Y: (s) => s.y,
  C: (s) => s.flags.C, Z: (s) => s.flags.Z, N: (s) => s.flags.N,
  V: (s) => s.flags.V, D: (s) => s.flags.D, I: (s) => s.flags.I,
};

export function compareStates(a: SymState, b: SymState, liveOut: LocSet, assumptions: string[] = []): Comparison {
  const reasons = [...new Set([...a.unknown, ...b.unknown])];
  if (reasons.length > 0) return { verdict: "UNKNOWN", reasons, assumptions, compared: [] };

  const compared: string[] = [];

  // The stack is compared whether or not SP is "live": a block that leaves the
  // stack somewhere else is not a replacement for one that does not.
  if (Number.isNaN(a.spDelta) || Number.isNaN(b.spDelta)) {
    return { verdict: "UNKNOWN", reasons: ["the stack pointer stops being known in one of the two versions"], assumptions, compared };
  }
  compared.push("the stack delta");
  if (a.spDelta !== b.spDelta) {
    return { verdict: "NOT EQUIVALENT", counterExample: `the stack: ${a.spDelta} against ${b.spDelta}`, reasons, assumptions, compared };
  }

  // I/O, as a sequence. Order is the effect.
  compared.push("every access to $D000-$DFFF, in order");
  const ioLine = (s: SymState): string =>
    s.io.map((e) => `${e.kind === "read" ? "read" : "write"} ${hex4(e.addr)}${e.value ? `=${show(e.value)}` : ""}`).join(", ");
  if (ioLine(a) !== ioLine(b)) {
    return {
      verdict: "NOT EQUIVALENT",
      counterExample: `the I/O accesses differ:\n      original:  ${ioLine(a) || "(none)"}\n      candidate: ${ioLine(b) || "(none)"}`,
      reasons, assumptions, compared,
    };
  }

  // Every write to RAM, by cell. Order between different cells does not matter;
  // the VALUE left in each does.
  compared.push("every memory cell either version writes");
  const cells = new Set<string>([...a.writes.map((w) => w.where), ...b.writes.map((w) => w.where)]);
  for (const cell of [...cells].sort()) {
    const lastA = [...a.writes].reverse().find((w) => w.where === cell);
    const lastB = [...b.writes].reverse().find((w) => w.where === cell);
    if (!lastA || !lastB) {
      return {
        verdict: "NOT EQUIVALENT",
        counterExample: `${cell} is written by ${lastA ? "the original" : "the candidate"} only`,
        reasons, assumptions, compared,
      };
    }
    if (!same(lastA.value, lastB.value)) {
      return {
        verdict: "NOT EQUIVALENT",
        counterExample: `${cell}: ${show(lastA.value)} against ${show(lastB.value)}`,
        reasons, assumptions, compared,
      };
    }
  }

  // The registers and flags that are live afterwards.
  const live = [...liveOut].filter((l): l is Loc => REG_OF[l] !== undefined);
  compared.push(live.length ? `the live locations ${live.sort().join(" ")}` : "no register or flag (none is live afterwards)");
  for (const loc of live.sort()) {
    const ea = REG_OF[loc]!(a);
    const eb = REG_OF[loc]!(b);
    if (!same(ea, eb)) {
      return { verdict: "NOT EQUIVALENT", counterExample: `${loc}: ${show(ea)} against ${show(eb)}`, reasons, assumptions, compared };
    }
  }

  return { verdict: "EQUIVALENT", reasons, assumptions, compared };
}
