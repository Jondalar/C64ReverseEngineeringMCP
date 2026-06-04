// Spec 754 §3.3k — flow disassembly: three "more than VICE" disassemblers that
// show the code PATH, not just linear bytes.
//
//   sd <n>            DYNAMIC: actually step n instructions, render the REAL path
//                     the PC takes, fold loops (each touched address once + ×count).
//                     Ground truth — but only the path actually executed.
//   df [addr] [n]     STATIC: walk control flow without executing. Follows JMP,
//                     descends into JSR (call stack) + returns on RTS, follows an
//                     indirect JMP via the current pointer, loop-guarded. Covers
//                     unreached code; a conditional branch defaults to fall-through
//                     + annotates the taken target.
//   df -i [addr] [n]  INTERACTIVE: the static walk STOPS at each conditional branch
//                     and asks which path (`df t|f|b`) — the human resolves the
//                     ambiguity static analysis cannot. IDA-style guided explore.
//
// VICE's `d` is stsrictly linear; these follow the flow. Reuses disasm6502's
// `disasmLine` for rendering + a small 6502 control-flow classifier.

import { disasmLine } from "./disasm6502.js";

export type Read = (a: number) => number;

// lowercase to match disasm6502's disasmLine rendering ($c100, not $C100).
const hx4 = (n: number) => (n & 0xffff).toString(16).padStart(4, "0");

type CfKind = "normal" | "jmp" | "jmpind" | "jsr" | "rts" | "rti" | "brk" | "branch";
interface CfInfo { size: number; kind: CfKind; target?: number; }

// Conditional-branch opcodes (BPL/BMI/BVC/BVS/BCC/BCS/BNE/BEQ).
const BRANCH_OPS = new Set([0x10, 0x30, 0x50, 0x70, 0x90, 0xb0, 0xd0, 0xf0]);

/** Classify the instruction at `addr` for control-flow following. */
function classify(read: Read, addr: number): CfInfo {
  const { size } = disasmLine(read, addr);
  const op = read(addr) & 0xff;
  const abs = () => (read(addr + 1) | (read(addr + 2) << 8)) & 0xffff;
  switch (op) {
    case 0x4c: return { size, kind: "jmp", target: abs() };        // JMP abs
    case 0x6c: return { size, kind: "jmpind", target: abs() };     // JMP (ind) — target = pointer addr
    case 0x20: return { size, kind: "jsr", target: abs() };        // JSR abs
    case 0x60: return { size, kind: "rts" };
    case 0x40: return { size, kind: "rti" };
    case 0x00: return { size, kind: "brk" };
  }
  if (BRANCH_OPS.has(op)) {
    const rel = read(addr + 1) & 0xff;
    const off = rel < 0x80 ? rel : rel - 256;
    return { size, kind: "branch", target: (addr + 2 + off) & 0xffff };
  }
  return { size, kind: "normal" };
}

// ---- sd: dynamic step+disassemble (ground truth, loop-folded) ------------
/**
 * Step `n` instructions on the session, recording the executed PC stream, and
 * render each touched address ONCE (first-seen order) with a ×count so loops
 * fold to their body. DESTRUCTIVE to the session — the caller wraps it in a
 * checkpoint save/restore to keep it non-destructive.
 */
export function stepDisasm(
  s: { c64Cpu: { pc: number }; c64Bus: { peek(a: number, lens: "cpu"): number }; runFor(n: number): unknown },
  n: number,
): string[] {
  const read: Read = (a) => s.c64Bus.peek(a & 0xffff, "cpu") & 0xff;
  const order: number[] = [];
  const count = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const pc = s.c64Cpu.pc & 0xffff;
    if (!count.has(pc)) order.push(pc);
    count.set(pc, (count.get(pc) ?? 0) + 1);
    s.runFor(1);
  }
  const land = s.c64Cpu.pc & 0xffff;
  const out = order.map((pc) => {
    const { line } = disasmLine(read, pc);
    const c = count.get(pc)!;
    return c > 1 ? `${line}   x${c}` : line;
  });
  out.push(`-- sd: ${n} steps, ${order.length} distinct addrs -> .C:${hx4(land)}`);
  return out;
}

// ---- df: static follow-disassemble (+ interactive) ----------------------
export interface DfState {
  addr: number;
  stack: number[];          // JSR return addresses
  visited: Set<number>;
  remaining: number;
  interactive: boolean;
  pendingBranch?: { taken: number; fall: number };
}
export interface DfResult { lines: string[]; pending?: DfState; }

const indent = (depth: number) => "  ".repeat(Math.min(depth, 8));

/** Continue (or start) a static control-flow walk until N runs out, a dead end,
 *  a loop back-edge, or — in interactive mode — a conditional branch. */
function walk(st: DfState, read: Read): DfResult {
  const lines: string[] = [];
  while (st.remaining > 0) {
    if (st.visited.has(st.addr)) {
      lines.push(`${indent(st.stack.length)}  | back to $${hx4(st.addr)} (loop)`);
      break;
    }
    st.visited.add(st.addr);
    const cf = classify(read, st.addr);
    const { line } = disasmLine(read, st.addr);
    lines.push(indent(st.stack.length) + line);
    st.remaining--;

    if (cf.kind === "jmp") { st.addr = cf.target!; continue; }
    if (cf.kind === "jmpind") {
      const t = (read(cf.target!) | (read((cf.target! + 1) & 0xffff) << 8)) & 0xffff;
      lines.push(`${indent(st.stack.length)}  -> ($${hx4(cf.target!)}) = $${hx4(t)}`);
      st.addr = t; continue;
    }
    if (cf.kind === "jsr") { st.stack.push((st.addr + cf.size) & 0xffff); st.addr = cf.target!; continue; }
    if (cf.kind === "rts" || cf.kind === "rti") {
      if (st.stack.length) { st.addr = st.stack.pop()!; continue; }
      lines.push(`${indent(st.stack.length)}  (end — ${cf.kind}, call stack empty)`);
      break;
    }
    if (cf.kind === "brk") { lines.push(`${indent(st.stack.length)}  (end — BRK)`); break; }
    if (cf.kind === "branch") {
      const fall = (st.addr + cf.size) & 0xffff;
      if (st.interactive) {
        st.pendingBranch = { taken: cf.target!, fall };
        lines.push(`${indent(st.stack.length)}  ? branch — (t)aken $${hx4(cf.target!)} / (f)all $${hx4(fall)} / (b)oth   [type t/f/b]`);
        return { lines, pending: st };
      }
      // non-interactive default: fall-through + annotate the taken target.
      lines.push(`${indent(st.stack.length)}  ; taken -> $${hx4(cf.target!)}`);
      st.addr = fall; continue;
    }
    // normal — linear advance.
    st.addr = (st.addr + cf.size) & 0xffff;
  }
  if (st.remaining <= 0) lines.push(`-- df: reached step limit`);
  return { lines };
}

export function followDisasm(read: Read, addr: number, n: number, opts: { interactive: boolean }): DfResult {
  return walk({ addr: addr & 0xffff, stack: [], visited: new Set(), remaining: n, interactive: opts.interactive }, read);
}

/** Resume an interactive walk at the pending branch with the user's choice. */
export function resumeDisasm(st: DfState, read: Read, choice: "t" | "f" | "b"): DfResult {
  const pb = st.pendingBranch;
  if (!pb) return { lines: ["df: no pending branch"], pending: undefined };
  st.pendingBranch = undefined;
  const lines: string[] = [];
  if (choice === "f") { st.addr = pb.fall; }
  else { // t or b — follow taken; for `b` note the fall-through path was not taken
    st.addr = pb.taken;
    if (choice === "b") lines.push(`  ; (both) fall-through $${hx4(pb.fall)} NOT followed — \`df ${hx4(pb.fall)}\` to explore it`);
  }
  const r = walk(st, read);
  return { lines: [...lines, ...r.lines], pending: r.pending };
}
