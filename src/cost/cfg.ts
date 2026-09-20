// Spec 861 §3.2 — blocks, paths, loops.
//
// The range is decoded linearly from its first byte (a range IS a run of
// instructions; where it is not, the decode says so and stops). Leaders are the
// range's first address, every branch or jump target that lands inside it, and
// every address after something that ends a path. A block's BYTES are exact; its
// CYCLES are a span, and the only two things that widen it are the page crossing
// of an indexed read and whether a branch is taken.
//
// Where the successor is one the graph cannot see — `jmp ($xxxx)`, an `rts`, a
// jump out of the range, a fall-through off the end — the block says so. That
// same list is what makes liveness conservative (§3.3) and what makes an
// equivalence UNKNOWN rather than wrong (§3.4).

import { disasm6502, type AddressingMode } from "../monitor/disasm6502.js";
import { BRANCHES, indexRegister } from "../knowledge-graph/isa-6502.js";
import { addSpans, crossesPage, differentPage, opcodeTiming, scaleSpan, span, timingSpan, type OpcodeTiming, type Span } from "./cycles.js";

export interface Insn {
  address: number;
  size: number;
  opcode: number;
  mnemonic: string;
  mode: AddressingMode;
  operand?: number;
  /** branch / jump target, when the operand is one */
  target?: number;
  bytes: number[];
  timing: OpcodeTiming | undefined;
  /** cycles with nothing known about the data */
  cycles: Span;
  text: string;
}

/** Why a successor is not in the graph. */
export type UnknownExit =
  | "rts"
  | "rti"
  | "brk"
  | "jam"
  | "jmp-indirect"
  | "jmp-out-of-range"
  | "branch-out-of-range"
  | "falls-off-the-end"
  | "undecodable";

export interface Block {
  index: number;
  start: number;
  /** address after the last instruction */
  end: number;
  insns: Insn[];
  bytes: number;
  cycles: Span;
  /** indices of blocks this one can reach inside the range */
  succ: number[];
  /** what it can reach that the graph cannot see */
  unknownExits: Array<{ kind: UnknownExit; at: number; detail?: string }>;
  /** a `jsr` inside this block: control comes back, but the callee is opaque */
  calls: number[];
}

export interface ResolvedLoop {
  /** the block the back edge lands on */
  head: number;
  /** the block holding the back edge */
  tail: number;
  /** blocks in the loop body */
  body: number[];
  register: "X" | "Y" | null;
  /** iterations, when they could be resolved */
  iterations: number | null;
  /** the reason, either way */
  why: string;
  /** the cost of one iteration */
  perIteration: Span;
  /** every iteration together, when the bound is resolved */
  total: Span | null;
  /** what the loop costs BEYOND one pass through its blocks (what a collapse adds) */
  extra: Span;
  /** how the total was sharpened past the naive per-iteration span */
  totalWhy: string | null;
}

export interface Cfg {
  start: number;
  end: number;
  insns: Insn[];
  blocks: Block[];
  loops: ResolvedLoop[];
  /** bytes that could not be decoded as instructions */
  truncatedAt: number | null;
  /** the whole range, when it is one straight line with no unknown exit */
  straightLine: boolean;
}

const TERMINAL = new Set(["rts", "rti", "brk", "jam"]);

export function decodeRange(bytes: Uint8Array, start: number): { insns: Insn[]; truncatedAt: number | null } {
  const read = (addr: number): number => {
    const off = addr - start;
    return off >= 0 && off < bytes.length ? bytes[off]! : 0;
  };
  const insns: Insn[] = [];
  let at = start;
  const end = start + bytes.length;
  let truncatedAt: number | null = null;
  while (at < end) {
    const d = disasm6502(read, at);
    if (d.mnemonic === "???" || at + d.size > end) {
      truncatedAt = at;
      break;
    }
    const raw: number[] = [];
    for (let i = 0; i < d.size; i += 1) raw.push(read(at + i));
    insns.push({
      address: at,
      size: d.size,
      opcode: d.opcode,
      mnemonic: d.mnemonic,
      mode: d.mode,
      operand: d.operand,
      target: d.target,
      bytes: raw,
      timing: opcodeTiming(d.opcode),
      cycles: timingSpan(d.opcode) ?? span(0),
      text: d.text,
    });
    at += d.size;
  }
  return { insns, truncatedAt };
}

/** The address a branch or an absolute jump names, when it names one inside the code. */
function flowTarget(insn: Insn): number | undefined {
  if (BRANCHES.has(insn.mnemonic)) return insn.target;
  if (insn.mnemonic === "jmp" && insn.mode === "abs") return insn.operand;
  if (insn.mnemonic === "jsr") return insn.operand;
  return undefined;
}

export function buildCfg(bytes: Uint8Array, start: number): Cfg {
  const { insns, truncatedAt } = decodeRange(bytes, start);
  const end = truncatedAt ?? start + bytes.length;
  const inRange = (a: number): boolean => a >= start && a < end;
  const byAddress = new Map<number, Insn>(insns.map((i) => [i.address, i]));

  // ---- leaders
  const leaders = new Set<number>();
  if (insns.length > 0) leaders.add(insns[0]!.address);
  for (const insn of insns) {
    const after = insn.address + insn.size;
    if (BRANCHES.has(insn.mnemonic)) {
      if (insn.target !== undefined && inRange(insn.target) && byAddress.has(insn.target)) leaders.add(insn.target);
      if (inRange(after)) leaders.add(after);
    } else if (insn.mnemonic === "jmp") {
      if (insn.mode === "abs" && insn.operand !== undefined && inRange(insn.operand) && byAddress.has(insn.operand)) leaders.add(insn.operand);
      if (inRange(after)) leaders.add(after);
    } else if (TERMINAL.has(insn.mnemonic)) {
      if (inRange(after)) leaders.add(after);
    }
  }

  // ---- blocks
  const blocks: Block[] = [];
  let current: Block | null = null;
  const indexOfStart = new Map<number, number>();
  for (const insn of insns) {
    if (!current || leaders.has(insn.address)) {
      current = {
        index: blocks.length, start: insn.address, end: insn.address, insns: [], bytes: 0,
        cycles: span(0), succ: [], unknownExits: [], calls: [],
      };
      indexOfStart.set(insn.address, current.index);
      blocks.push(current);
    }
    current.insns.push(insn);
    current.end = insn.address + insn.size;
    current.bytes += insn.size;
    current.cycles = addSpans(current.cycles, insn.cycles);
  }

  // ---- edges
  for (const block of blocks) {
    const last = block.insns[block.insns.length - 1]!;
    const after = last.address + last.size;
    const link = (addr: number, kind: UnknownExit): void => {
      const idx = indexOfStart.get(addr);
      if (idx !== undefined) block.succ.push(idx);
      else block.unknownExits.push({ kind, at: last.address, detail: `$${addr.toString(16).toUpperCase().padStart(4, "0")}` });
    };
    for (const insn of block.insns) if (insn.mnemonic === "jsr" && insn.operand !== undefined) block.calls.push(insn.operand);

    if (BRANCHES.has(last.mnemonic)) {
      if (last.target !== undefined) link(last.target, "branch-out-of-range");
      if (after < end) link(after, "falls-off-the-end");
      else block.unknownExits.push({ kind: "falls-off-the-end", at: last.address });
    } else if (last.mnemonic === "jmp") {
      if (last.mode === "ind") block.unknownExits.push({ kind: "jmp-indirect", at: last.address, detail: last.text });
      else if (last.operand !== undefined) link(last.operand, "jmp-out-of-range");
    } else if (TERMINAL.has(last.mnemonic)) {
      block.unknownExits.push({ kind: last.mnemonic as UnknownExit, at: last.address });
    } else if (after < end) {
      link(after, "falls-off-the-end");
    } else {
      block.unknownExits.push({ kind: "falls-off-the-end", at: last.address });
    }
    block.succ = [...new Set(block.succ)];
  }
  if (truncatedAt !== null) {
    const owner = blocks[blocks.length - 1];
    if (owner) owner.unknownExits.push({ kind: "undecodable", at: truncatedAt });
  }

  const loops = findLoops(blocks, insns);
  // An EMPTY range is straight-line and costs nothing. It is not a degenerate
  // case to be tolerated: "these bytes go away" is a candidate like any other
  // (a `jmp` to the next instruction, a redundant `clc`), and the comparison
  // that decides it needs a side with no instructions in it.
  const straightLine =
    truncatedAt === null &&
    blocks.length <= 1 &&
    (blocks.length === 0 ||
      (blocks[0]!.unknownExits.every((e) => e.kind === "falls-off-the-end") &&
        blocks[0]!.calls.length === 0 &&
        insns.every((i) => !BRANCHES.has(i.mnemonic) && i.mnemonic !== "jmp" && !TERMINAL.has(i.mnemonic))));

  return { start, end, insns, blocks, loops, truncatedAt, straightLine };
}

// ---------------------------------------------------------------------------
// §3.2 — the loops whose bound is a constant.
//
// The pattern, and only this pattern: `LDr #imm` … `DEr` / `INr` … `Bxx` back to
// the head, with no other write to `r` in the body. Everything else is reported
// per iteration with its bound marked unknown, which is the honest answer — a
// counter read from memory has no static bound.

const DEC_REG: Record<string, "X" | "Y"> = { dex: "X", dey: "Y" };
const INC_REG: Record<string, "X" | "Y"> = { inx: "X", iny: "Y" };
const LOAD_REG: Record<string, "X" | "Y"> = { ldx: "X", ldy: "Y" };
/** every mnemonic that writes X or Y, for the "no other write" test */
const WRITES_REG: Record<string, "X" | "Y"> = {
  ...DEC_REG, ...INC_REG, ...LOAD_REG,
  tax: "X", tay: "Y", tsx: "X", lax: "X", axs: "X", las: "X",
};

function findLoops(blocks: Block[], insns: Insn[]): ResolvedLoop[] {
  const loops: ResolvedLoop[] = [];
  for (const tail of blocks) {
    for (const s of tail.succ) {
      const head = blocks[s]!;
      if (head.start > tail.start) continue; // not a back edge
      const body = blocks.filter((b) => b.start >= head.start && b.start <= tail.start).map((b) => b.index);
      const bodyInsns = insns.filter((i) => i.address >= head.start && i.address < tail.end);
      const perIteration = body.reduce((acc, i) => addSpans(acc, blocks[i]!.cycles), span(0));
      const bound = resolveBound(head, tail, bodyInsns, insns);
      const cost = loopTotal(head, tail, bodyInsns, perIteration, bound);
      loops.push({ head: head.index, tail: tail.index, body, perIteration, ...bound, ...cost });
    }
  }
  return loops;
}

/**
 * What the whole loop costs.
 *
 * The naive answer — one iteration's span times the count — is wrong by the
 * branch alone: the back edge is TAKEN on every pass but the last, and taken
 * costs one more (two, across a page). And where the indexed read uses the
 * counter itself, the page crossing is not a span at all: the counter's values
 * are known, so the crossings can be counted. Both refinements need the loop to
 * be one block; anything with its own branching inside keeps the span.
 */
function loopTotal(
  head: Block,
  tail: Block,
  bodyInsns: Insn[],
  perIteration: Span,
  bound: { register: "X" | "Y" | null; iterations: number | null; seed?: number; down?: boolean; stepAt?: number },
): { total: Span | null; extra: Span; totalWhy: string | null } {
  const n = bound.iterations;
  if (n === null) return { total: null, extra: span(0), totalWhy: null };
  const oneBlock = head.index === tail.index;
  if (!oneBlock) {
    const total = scaleSpan(perIteration, n);
    return { total, extra: scaleSpan(perIteration, n - 1), totalWhy: null };
  }

  const branch = tail.insns[tail.insns.length - 1]!;
  const takenPenalty = 1 + (branch.target !== undefined && differentPage(branch.address + branch.size, branch.target) ? 1 : 0);
  const why: string[] = [`the back edge is taken ${n - 1} times at ${takenPenalty} cycle${takenPenalty === 1 ? "" : "s"} more each`];

  let per = span(0);
  let crossings = 0;
  for (const insn of bodyInsns) {
    if (insn === branch) { per = addSpans(per, span(insn.timing?.base ?? 0)); continue; }
    const indexed = insn.timing?.pageCross === true && indexRegister(insn.mode) === bound.register;
    const beforeStep = bound.stepAt === undefined || insn.address < bound.stepAt;
    if (indexed && beforeStep && bound.seed !== undefined && (insn.mode === "abs,x" || insn.mode === "abs,y") && insn.operand !== undefined) {
      const base = insn.operand & 0xff;
      let crossed = 0;
      for (let k = 0; k < n; k += 1) {
        const v = (bound.down ? bound.seed - k : bound.seed + k) & 0xff;
        if (crossesPage(base, v)) crossed += 1;
      }
      crossings += crossed;
      per = addSpans(per, span(insn.timing!.base));
      why.push(`${insn.mnemonic} ${insn.text} crosses a page on ${crossed} of the ${n} iterations`);
      continue;
    }
    per = addSpans(per, insn.cycles);
  }
  const total = addSpans(scaleSpan(per, n), span(crossings + takenPenalty * (n - 1)));
  const once = tail.cycles;
  return { total, extra: { min: total.min - once.min, max: total.max - once.max }, totalWhy: why.join("; ") };
}

function resolveBound(
  head: Block,
  tail: Block,
  bodyInsns: Insn[],
  all: Insn[],
): { register: "X" | "Y" | null; iterations: number | null; why: string; seed?: number; down?: boolean; stepAt?: number } {
  const branch = tail.insns[tail.insns.length - 1]!;
  if (!BRANCHES.has(branch.mnemonic)) {
    return { register: null, iterations: null, why: `the back edge is a ${branch.mnemonic}, not a conditional branch` };
  }
  // the one counter step in the body
  const steps = bodyInsns.filter((i) => DEC_REG[i.mnemonic] !== undefined || INC_REG[i.mnemonic] !== undefined);
  if (steps.length !== 1) {
    return { register: null, iterations: null, why: steps.length === 0 ? "no counter step in the body" : `${steps.length} counter steps in the body` };
  }
  const step = steps[0]!;
  const register = (DEC_REG[step.mnemonic] ?? INC_REG[step.mnemonic])!;
  const down = DEC_REG[step.mnemonic] !== undefined;

  // nothing else may write the counter inside the body
  const others = bodyInsns.filter((i) => i !== step && WRITES_REG[i.mnemonic] === register);
  if (others.length > 0) {
    return { register, iterations: null, why: `${register} is written again at $${others[0]!.address.toString(16).toUpperCase().padStart(4, "0")}` };
  }
  // the branch must read the flag the step set, with nothing in between that writes it
  const between = bodyInsns.filter((i) => i.address > step.address && i.address < branch.address);
  const flagWriters = between.filter((i) => !["sta", "stx", "sty", "nop", "pha", "php"].includes(i.mnemonic));
  if (flagWriters.length > 0) {
    return { register, iterations: null, why: `$${flagWriters[0]!.address.toString(16).toUpperCase().padStart(4, "0")} (${flagWriters[0]!.mnemonic}) writes the flags between the counter and the branch` };
  }
  // the initial value: the nearest `LD<r> #imm` before the head
  const init = [...all].reverse().find((i) => i.address < head.start && LOAD_REG[i.mnemonic] === register && i.mode === "imm");
  if (!init || init.operand === undefined) {
    return { register, iterations: null, why: `no \`ld${register.toLowerCase()} #imm\` before the loop, so the start value is not in this range` };
  }
  const seed = init.operand & 0xff;
  const iterations = countIterations(seed, down, branch.mnemonic);
  if (iterations === null) {
    return { register, iterations: null, why: `${branch.mnemonic} after ${step.mnemonic} is not a bound this resolves` };
  }
  return {
    register,
    iterations,
    seed,
    down,
    stepAt: step.address,
    why: `ld${register.toLowerCase()} #$${seed.toString(16).toUpperCase().padStart(2, "0")} at $${init.address.toString(16).toUpperCase().padStart(4, "0")}, ${step.mnemonic} / ${branch.mnemonic}`,
  };
}

/** Run the counter until the branch stops taking it. Bounded at 257 — anything
 *  longer is not a single-byte counter and is not resolved. */
function countIterations(seed: number, down: boolean, branch: string): number | null {
  let v = seed;
  for (let n = 1; n <= 257; n += 1) {
    v = down ? (v - 1) & 0xff : (v + 1) & 0xff;
    const z = v === 0;
    const negative = (v & 0x80) !== 0;
    let taken: boolean;
    switch (branch) {
      case "bne": taken = !z; break;
      case "beq": taken = z; break;
      case "bpl": taken = !negative; break;
      case "bmi": taken = negative; break;
      default: return null; // bcc/bcs/bvc/bvs are not set by inx/dex
    }
    if (!taken) return n;
  }
  return null;
}

// ---------------------------------------------------------------------------
// §3.2 — the whole range's cost.

export interface RangeCost {
  bytes: number;
  /** the cost of the cheapest and the dearest path, loops resolved where they could be */
  cycles: Span | null;
  /** why there is no total, when there is none */
  why: string | null;
}

/**
 * Shortest and longest path over the block graph, with every RESOLVED loop
 * collapsed into its body's cost times its iterations. A loop that stays
 * unresolved leaves a cycle in the graph, and then there is no total — the
 * report gives the per-iteration cost instead and says the bound is unknown.
 */
export function rangeCost(cfg: Cfg): RangeCost {
  const bytes = cfg.blocks.reduce((a, b) => a + b.bytes, 0);
  if (cfg.blocks.length === 0) {
    // No bytes at all is not "nothing decoded": it is zero bytes and zero
    // cycles, exactly, and it is the other side of every candidate that
    // removes an instruction.
    if (cfg.insns.length === 0 && cfg.truncatedAt === null) return { bytes: 0, cycles: span(0), why: null };
    return { bytes, cycles: null, why: "nothing decoded" };
  }

  const extra = new Map<number, Span>();
  const removed = new Set<string>();
  for (const loop of cfg.loops) {
    if (loop.iterations === null) {
      return { bytes, cycles: null, why: `the loop at $${cfg.blocks[loop.head]!.start.toString(16).toUpperCase().padStart(4, "0")} has no static bound — ${loop.why}` };
    }
    // The body runs `iterations` times; the path through it once is already in
    // the graph, so the collapse adds the other `iterations - 1`.
    extra.set(loop.tail, addSpans(extra.get(loop.tail) ?? span(0), loop.extra));
    removed.add(`${loop.tail}->${loop.head}`);
  }

  const n = cfg.blocks.length;
  const succ = cfg.blocks.map((b) => b.succ.filter((s) => !removed.has(`${b.index}->${s}`)));
  // topological order over the acyclic remainder
  const indeg = new Array<number>(n).fill(0);
  for (const list of succ) for (const s of list) indeg[s] += 1;
  const order: number[] = [];
  const queue = indeg.map((d, i) => (d === 0 ? i : -1)).filter((i) => i >= 0);
  while (queue.length) {
    const i = queue.shift()!;
    order.push(i);
    for (const s of succ[i]!) if (--indeg[s] === 0) queue.push(s);
  }
  if (order.length !== n) return { bytes, cycles: null, why: "a loop remains in the block graph after the resolved ones were collapsed" };

  // `into[i]` is the cost of reaching the START of block i; `out[i]` adds its own.
  const intoMin = new Array<number>(n).fill(Number.POSITIVE_INFINITY);
  const intoMax = new Array<number>(n).fill(Number.NEGATIVE_INFINITY);
  intoMin[0] = 0; intoMax[0] = 0;
  const outMin = new Array<number>(n).fill(Number.POSITIVE_INFINITY);
  const outMax = new Array<number>(n).fill(Number.NEGATIVE_INFINITY);
  const exits: number[] = [];
  for (const i of order) {
    if (intoMin[i] === Number.POSITIVE_INFINITY) continue; // unreachable from the entry
    const own = addSpans(cfg.blocks[i]!.cycles, extra.get(i) ?? span(0));
    outMin[i] = intoMin[i]! + own.min;
    outMax[i] = intoMax[i]! + own.max;
    if (succ[i]!.length === 0) exits.push(i);
    for (const s of succ[i]!) {
      intoMin[s] = Math.min(intoMin[s]!, outMin[i]!);
      intoMax[s] = Math.max(intoMax[s]!, outMax[i]!);
    }
  }
  if (exits.length === 0) return { bytes, cycles: null, why: "no path out of the range" };
  const lo = Math.min(...exits.map((i) => outMin[i]!));
  const hi = Math.max(...exits.map((i) => outMax[i]!));
  return { bytes, cycles: { min: lo, max: hi }, why: null };
}

/**
 * §4.2's exactness rules, applied statically: given what is known about the
 * data, an instruction's cycles collapse from a span to a number.
 *  - an indexed read whose base and index are both known: the page cross is known;
 *  - a branch whose outcome is known: taken and its page cross are known.
 */
export function exactCycles(insn: Insn, known: { base?: number; index?: number; taken?: boolean }): Span {
  const t = insn.timing;
  if (!t) return span(0);
  if (t.branch) {
    if (known.taken === undefined) return insn.cycles;
    if (!known.taken) return span(t.base);
    const next = insn.address + insn.size;
    return span(t.base + 1 + (insn.target !== undefined && differentPage(next, insn.target) ? 1 : 0));
  }
  if (t.pageCross) {
    if (known.base === undefined || known.index === undefined) return insn.cycles;
    return span(t.base + (crossesPage(known.base, known.index) ? 1 : 0));
  }
  return span(t.base);
}
