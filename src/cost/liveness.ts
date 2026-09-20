// Spec 861 §3.3 — what is live after every instruction.
//
// Nine bits of machine state: A X Y SP and the flags C Z N V D I. Backwards over
// the block graph to a fixpoint, because a loop's head has to see what its own
// back edge leaves live.
//
// CONSERVATIVE WHERE THE GRAPH ENDS. An `rts`, an `rti`, a `jmp ($xxxx)`, a jump
// out of the range, a fall-through off the end: the successor is not in the
// graph, so everything is live there. A `jsr` is the same argument pointing the
// other way — the callee may read anything, so everything is live before it.
// Being wrong in this direction costs an optimisation; being wrong in the other
// direction breaks a program.
//
// Q1 (§2) reads this to say what a change must PRESERVE; §3.4 reads it to decide
// which differences between two versions matter.

import { effects, type Loc } from "../knowledge-graph/isa-6502.js";
import type { Block, Cfg, Insn } from "./cfg.js";

export const ALL_LOCS: readonly Loc[] = ["A", "X", "Y", "SP", "C", "Z", "N", "V", "D", "I"];

export type LocSet = ReadonlySet<Loc>;

export interface Liveness {
  /** live AFTER each instruction, by instruction address */
  after: Map<number, LocSet>;
  /** live BEFORE each instruction, by instruction address */
  before: Map<number, LocSet>;
  /** live at the range's exits — what a replacement must preserve */
  atExit: LocSet;
  /** why the exit set is what it is */
  exitWhy: string;
}

const everything = (): Set<Loc> => new Set(ALL_LOCS);

/** Backwards through one instruction: (live − writes) ∪ reads. */
function step(live: Set<Loc>, insn: Insn): Set<Loc> {
  if (insn.mnemonic === "jsr") return everything(); // the callee may read anything
  const e = effects(insn.mnemonic, insn.mode);
  const out = new Set(live);
  for (const w of e.writes) out.delete(w);
  for (const r of e.reads) out.add(r);
  if (insn.mnemonic === "rts" || insn.mnemonic === "rti") return everything();
  return out;
}

export function liveness(cfg: Cfg, declaredExit?: LocSet): Liveness {
  const n = cfg.blocks.length;
  const liveIn: Array<Set<Loc>> = cfg.blocks.map(() => new Set<Loc>());
  const exitSet = declaredExit ? new Set(declaredExit) : everything();
  const exitWhy = declaredExit
    ? `the caller declared what is live after the range: ${[...exitSet].sort().join(" ") || "nothing"}`
    : `no live-out was declared, so every successor the graph cannot see leaves everything live (§3.3)`;

  let changed = true;
  let rounds = 0;
  while (changed && rounds < 64) {
    changed = false;
    rounds += 1;
    for (let i = n - 1; i >= 0; i -= 1) {
      const block = cfg.blocks[i]!;
      const out = blockLiveOut(block, liveIn, exitSet);
      let live = out;
      for (let k = block.insns.length - 1; k >= 0; k -= 1) live = step(live, block.insns[k]!);
      if (!sameSet(live, liveIn[i]!)) {
        liveIn[i] = live;
        changed = true;
      }
    }
  }

  const after = new Map<number, LocSet>();
  const before = new Map<number, LocSet>();
  for (const block of cfg.blocks) {
    let live = blockLiveOut(block, liveIn, exitSet);
    for (let k = block.insns.length - 1; k >= 0; k -= 1) {
      const insn = block.insns[k]!;
      after.set(insn.address, new Set(live));
      live = step(live, insn);
      before.set(insn.address, new Set(live));
    }
  }

  return { after, before, atExit: exitSet, exitWhy };
}

function blockLiveOut(block: Block, liveIn: Array<Set<Loc>>, exitSet: Set<Loc>): Set<Loc> {
  const out = new Set<Loc>();
  for (const s of block.succ) for (const l of liveIn[s]!) out.add(l);
  if (block.unknownExits.length > 0) for (const l of exitSet) out.add(l);
  return out;
}

function sameSet(a: Set<Loc>, b: Set<Loc>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

export function formatLocs(set: LocSet): string {
  const order = ALL_LOCS.filter((l) => set.has(l));
  return order.length ? order.join(" ") : "nothing";
}
