// Spec 862 §4 — the rules, declared once in a table.
//
// Like 846's checks: `id`, `class`, the pattern, its preconditions, the
// rewrite, and why it saves. Adding a rule is adding a row here and a matcher
// below it. Nothing in this file decides whether a rewrite is CORRECT — the
// matchers propose, and `verdict.ts` attaches 861's answer. That separation is
// §1: finding is a heuristic, the verdict is not.
//
// THREE KINDS OF PROOF, and a candidate says which one carries it:
//
//   equivalence    861 §3.4 runs both versions symbolically and compares their
//                  effects. Straight-line only, which is most of the local,
//                  every dataflow and every undocumented rule.
//   control-flow   the two versions are not straight-line — a `jsr`, a `jmp`,
//                  an `rts` — but they are provably the same transfer with the
//                  same state, once a named obligation is CHECKED against the
//                  bytes. `tail-call`, `jump-to-next`, `jump-threading`.
//   measurement    the structural rules, where the spec says so outright: the
//                  answer is an exact count (of page crossings, of accesses, of
//                  iterations) plus 861's impact, not an equivalence.
//
// A rule that cannot form a sound rewrite says so (`notFormed`) instead of
// proposing one, and the counter in §6 makes that visible.

import { buildCfg, type Cfg, type Insn } from "../cost/cfg.js";
import { opcodeTiming, crossesPage, differentPage } from "../cost/cycles.js";
import { BRANCHES, effects, indexRegister } from "../knowledge-graph/isa-6502.js";
import { execute, factsOf, initialState, type KnownEntry } from "../cost/symbolic.js";
import type { Liveness } from "../cost/liveness.js";

// ---------------------------------------------------------------- the table

export type RuleClass = "local" | "dataflow" | "structural" | "undocumented";

export type RuleId =
  | "tail-call" | "redundant-load" | "jump-to-next" | "jump-threading"
  | "known-carry" | "known-register"
  | "page-align" | "zp-promote" | "count-down"
  | "lax-load" | "rmw-alu-fuse";

export interface RuleDef {
  id: RuleId;
  class: RuleClass;
  /** what the rule looks for */
  pattern: string;
  /** what must hold before the rewrite is even proposed */
  preconditions: string;
  /** what it becomes */
  rewrite: string;
  /** why that is cheaper */
  saves: string;
  /** how the verdict is reached for this rule */
  proof: Proof;
}

export type Proof = "equivalence" | "control-flow" | "measurement";

export const RULES: readonly RuleDef[] = [
  // ---- local: straight-line or a provable control transfer ----------------
  {
    id: "tail-call", class: "local", proof: "control-flow",
    pattern: "`jsr x` immediately followed by `rts`",
    preconditions:
      "x's own bytes are in scope and neither reads nor rewrites its return address — no `tsx`, no `txs`, "
      + "no pull it did not push, every exit an `rts`; and nothing branches to the `rts` that goes away",
    rewrite: "`jmp x`",
    saves: "the `jsr` becomes a `jmp` (6 → 3) and the `rts` goes (6) — 9 cycles and a byte",
  },
  {
    id: "redundant-load", class: "local", proof: "equivalence",
    pattern: "`sta z` / `lda z` on the same cell, adjacent (and the same for X and Y)",
    preconditions: "the cell is RAM, not $D000-$DFFF; and N and Z are dead afterwards, or already follow the register",
    rewrite: "drop the load",
    saves: "the load's bytes and cycles — 3 cycles in zero page, 4 absolute",
  },
  {
    id: "jump-to-next", class: "local", proof: "control-flow",
    pattern: "`jmp` whose target is the instruction that follows it",
    preconditions: "none — the jump changes no register, no flag, no memory and no stack",
    rewrite: "drop the jump",
    saves: "3 cycles and 3 bytes, every time it runs",
  },
  {
    id: "jump-threading", class: "local", proof: "control-flow",
    pattern: "a branch or a `jmp` whose target holds another `jmp`",
    preconditions: "the final target is readable in the same image, and for a branch it is within reach of the displacement",
    rewrite: "go straight to the final target",
    saves: "the second jump no longer runs — 3 cycles, and for a `jmp` source 3 bytes are freed at the hop",
  },

  // ---- dataflow: the verdict holds under a named fact ----------------------
  {
    id: "known-carry", class: "dataflow", proof: "equivalence",
    pattern: "`clc` or `sec` where the carry already has that value",
    preconditions:
      "the value is established either by running the block up to here, or by the edge that reaches this block "
      + "(the fall-through of a `bcc` has C set, its target has C clear) — and then the block must have exactly one way in",
    rewrite: "drop the `clc` / `sec`",
    saves: "2 cycles and a byte, every time it runs",
  },
  {
    id: "known-register", class: "dataflow", proof: "equivalence",
    pattern: "`lda #n` (or `ldx`, `ldy`) where the register already holds n",
    preconditions: "the value is established by running the block up to here, and the flags the load sets are dead or already the same",
    rewrite: "drop the load",
    saves: "2 cycles and 2 bytes, every time it runs",
  },

  // ---- structural: an exact count, not an equivalence ----------------------
  {
    id: "page-align", class: "structural", proof: "measurement",
    pattern: "an indexed read, or a taken branch, that crosses a page and pays one more cycle",
    preconditions: "how often it crosses has to be COUNTED — from the trace, or from a loop whose bound is a constant. A crossing that might happen is not a gain",
    rewrite: "move the table, or the code, so the access stays inside one page",
    saves: "exactly one cycle per crossing that happened — no more, and the count is the measurement's, not an estimate",
  },
  {
    id: "zp-promote", class: "structural", proof: "measurement",
    pattern: "an absolute access to a single RAM cell, used more than once",
    preconditions: "zero page that is established FREE (the project's free-RAM slot says so, and a read-derived claim stays a hypothesis) and every access to the cell can be found",
    rewrite: "move the cell into free zero page and rewrite every access",
    saves: "a byte and a cycle per access",
  },
  {
    id: "count-down", class: "structural", proof: "measurement",
    pattern: "`inx` / `cpx #n` / `bne` around a loop (and the same for Y)",
    preconditions:
      "the body never READS the counter — no indexed access through it, no transfer, no store, no second compare — "
      + "the counter and the flags are dead after the loop, and n fits a `bpl` (at most 128)",
    rewrite: "`dex` / `bpl`, with the initialiser seeded to n-1",
    saves: "the compare: 2 cycles and 2 bytes per iteration",
  },

  // ---- undocumented: off by default, per project ---------------------------
  {
    id: "lax-load", class: "undocumented", proof: "equivalence",
    pattern: "`lda m` / `ldx m` on the same cell, or `lda m` / `tax`",
    preconditions: "a mode `lax` has ($A7 zp, $AF abs, $BF abs,y, $A3 (zp,x), $B3 (zp),y, $B7 zp,y) and a cell that is not $D000-$DFFF — `lax` reads it once where the pair read it twice",
    rewrite: "`lax m`",
    saves: "the second instruction entirely — 1 to 4 cycles and 1 to 3 bytes",
  },
  {
    id: "rmw-alu-fuse", class: "undocumented", proof: "equivalence",
    pattern:
      "a read-modify-write followed by an ALU op on the same cell: `dec`+`cmp`, `inc`+`sbc`, `asl`+`ora`, "
      + "`lsr`+`eor`, `rol`+`and`, `ror`+`adc`",
    preconditions: "the same addressing mode and operand, a mode the fused opcode has, and a cell that is not $D000-$DFFF",
    rewrite: "the fused opcode — `dcp`, `isc`, `slo`, `sre`, `rla`, `rra`",
    saves: "the ALU instruction's own cycles and bytes — 3 cycles and 2 bytes in zero page",
  },
] as const;

export const RULE_BY_ID: ReadonlyMap<RuleId, RuleDef> = new Map(RULES.map((r) => [r.id, r]));

export const ALL_CLASSES: readonly RuleClass[] = ["local", "dataflow", "structural", "undocumented"];

/**
 * §4 — the undocumented class is OFF unless a project switches it on, because
 * using those opcodes is a choice about which machines the result must run on,
 * not a fact about the code.
 */
export const DEFAULT_CLASSES: readonly RuleClass[] = ["local", "dataflow", "structural"];

// ---------------------------------------------------------------- the input

export interface Unit {
  label: string;
  routineId?: string;
  /** which payload these bytes came from — residency, where more than one could claim the address */
  payload?: string;
  start: number;
  /** inclusive */
  end: number;
  bytes: Uint8Array;
  cfg: Cfg;
  live: Liveness;
}

export interface MatchEnv {
  unit: Unit;
  /** any byte of the image by address, `undefined` outside it */
  byteAt: (addr: number) => number | undefined;
  /** the routine covering an address, for the callee check a tail call needs */
  routineAt: (addr: number) => { start: number; end: number; bytes: Uint8Array } | null;
  /** how many times each pc retired in the capture */
  instancesByPc: ReadonlyMap<number, number>;
  /** how many of those paid a page-crossing cycle (861 §4.2's own number) */
  crossingsByPc: ReadonlyMap<number, number>;
  frames: number;
  hasTrace: boolean;
  /** zero page the project has established free (Spec 844's slot) */
  freeZp: { cells: number[]; how: string } | null;
  /**
   * Who reaches this address, by source address — every branch, jump, call and
   * pointer in the image. A SET would not do: "is anything else pointing here"
   * is a different question from "is anything pointing here", and the second
   * one is true of every block start by construction.
   */
  referencedFrom: (addr: number) => readonly number[];
}

export interface Proposal {
  rule: RuleId;
  at: number;
  /** the bytes that change */
  before: Uint8Array;
  /** what they become; empty means they go away */
  after: Uint8Array;
  /** entry facts the equivalence is seeded with — the verdict holds only under them */
  known?: KnownEntry;
  /** those facts, in words */
  facts: string[];
  /** the obligations a control-flow or measurement proof CHECKED */
  checked: string[];
  /** a measurement rule brings its own exact numbers */
  measured?: {
    deltaBytes: number;
    deltaCycles: number;
    how: string;
    /** executions the gain is counted over WITHOUT a trace: sites, iterations, crossings off a static bound */
    executions?: number;
    /** executions the CAPTURE gives, where the rule counts them itself rather than "how often this pc ran" */
    traceExecutions?: number;
    /** what else has to change with it */
    alsoChanges?: string[];
  };
  /** the rule saw its shape and could not form a sound rewrite */
  notFormed?: string;
  /** the change is not a byte edit at `at` */
  advice?: string;
}

// ---------------------------------------------------------------- helpers

const hex4 = (a: number): string => `$${(a & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;
const hex2 = (a: number): string => `$${(a & 0xff).toString(16).toUpperCase().padStart(2, "0")}`;

const IO = (addr: number): boolean => addr >= 0xd000 && addr <= 0xdfff;

/** The cell an instruction names, when the mode names one outright. */
function directCell(insn: Insn): number | undefined {
  if (insn.mode === "zp" || insn.mode === "abs") return insn.operand;
  return undefined;
}

const bytesOf = (...b: number[]): Uint8Array => new Uint8Array(b);

/** The block an address is in, and where in it. */
function locate(cfg: Cfg, address: number): { block: number; index: number } | null {
  for (const block of cfg.blocks) {
    const i = block.insns.findIndex((x) => x.address === address);
    if (i >= 0) return { block: block.index, index: i };
  }
  return null;
}

/**
 * What is already true at an instruction, from running its own block up to it.
 *
 * Sound because the run starts at the BLOCK's start with everything symbolic:
 * anything that comes out a constant is a constant for every way into the
 * block. `null` when the prefix holds something the engine does not model — a
 * `jsr`, an opcode it has no semantics for — because then nothing it says can
 * be trusted.
 */
export function entryFacts(cfg: Cfg, address: number): KnownEntry | null {
  const at = locate(cfg, address);
  if (!at) return null;
  const block = cfg.blocks[at.block]!;
  const st = initialState({});
  for (let i = 0; i < at.index; i += 1) {
    if (!execute(st, block.insns[i]!)) return null;
    if (st.unknown.length > 0) return null;
  }
  return factsOf(st);
}

/** The blocks that can reach this one, inside the unit. */
function predecessorsOf(cfg: Cfg, blockIndex: number): number[] {
  return cfg.blocks.filter((b) => b.succ.includes(blockIndex)).map((b) => b.index);
}

// ---------------------------------------------------------------- matchers

export type Matcher = (env: MatchEnv) => Proposal[];

// ---- tail-call ------------------------------------------------------------

/**
 * Does the callee leave its return address alone?
 *
 * `jsr x / rts` and `jmp x` differ in exactly one thing: while x runs, the
 * stack is two bytes deeper in the first. So the rewrite is sound unless x can
 * tell — by reading the stack pointer, by setting it, or by pulling something
 * it did not push. That is the spec's precondition, and it is CHECKED here
 * against the callee's own bytes rather than assumed.
 */
function calleeLeavesReturnAlone(bytes: Uint8Array, start: number): { ok: boolean; why: string } {
  const cfg = buildCfg(bytes, start);
  if (cfg.truncatedAt !== null) {
    return { ok: false, why: `the callee at ${hex4(start)} does not decode all the way through (${hex4(cfg.truncatedAt)})` };
  }
  for (const insn of cfg.insns) {
    if (insn.mnemonic === "tsx") return { ok: false, why: `the callee reads the stack pointer (\`tsx\` at ${hex4(insn.address)}) — it can see how deep it was called from` };
    if (insn.mnemonic === "txs") return { ok: false, why: `the callee sets the stack pointer (\`txs\` at ${hex4(insn.address)})` };
    if (insn.mnemonic === "rti") return { ok: false, why: `the callee leaves through an \`rti\` at ${hex4(insn.address)}, not an \`rts\`` };
    if (insn.mnemonic === "jmp" && insn.mode === "ind") {
      return { ok: false, why: `the callee leaves through \`jmp ${insn.text}\` at ${hex4(insn.address)} — where it goes is not in the graph` };
    }
  }
  // Pushes and pulls must balance on the straight run through each block, and
  // the whole routine must never be able to pull more than it pushed.
  let depth = 0;
  let low = 0;
  for (const insn of cfg.insns) {
    const e = effects(insn.mnemonic, insn.mode);
    if (insn.mnemonic === "jsr") continue;    // a call balances itself
    if (!Number.isFinite(e.stack)) return { ok: false, why: `\`${insn.mnemonic}\` at ${hex4(insn.address)} moves the stack by an amount the table cannot name` };
    if (insn.mnemonic === "rts") continue;    // the exit, not an imbalance
    depth += e.stack;
    low = Math.min(low, depth);
  }
  if (low < 0) return { ok: false, why: `the callee pulls more than it pushes (${-low} byte(s) below its entry) — it reads its own return address` };
  if (depth !== 0) return { ok: false, why: `the callee leaves ${depth} byte(s) on the stack — it is not a plain subroutine` };
  return { ok: true, why: `${hex4(start)} never reads or moves the stack pointer and every push is pulled back: ${cfg.insns.length} instructions read` };
}

const matchTailCall: Matcher = (env) => {
  const out: Proposal[] = [];
  for (const block of env.unit.cfg.blocks) {
    for (let i = 0; i + 1 < block.insns.length; i += 1) {
      const jsr = block.insns[i]!;
      const rts = block.insns[i + 1]!;
      if (jsr.mnemonic !== "jsr" || jsr.mode !== "abs" || jsr.operand === undefined) continue;
      if (rts.mnemonic !== "rts") continue;

      const target = jsr.operand;
      const checked: string[] = [];
      const others = env.referencedFrom(rts.address);
      if (others.length > 0) {
        out.push({
          rule: "tail-call", at: jsr.address, before: bytesOf(...jsr.bytes, ...rts.bytes), after: new Uint8Array(),
          facts: [], checked: [],
          notFormed: `the \`rts\` at ${hex4(rts.address)} is reached from ${others.map(hex4).join(", ")} as well, so it cannot go away`,
        });
        continue;
      }
      checked.push(`nothing but the \`jsr\` reaches the \`rts\` at ${hex4(rts.address)}`);

      const callee = env.routineAt(target);
      if (!callee) {
        out.push({
          rule: "tail-call", at: jsr.address, before: bytesOf(...jsr.bytes, ...rts.bytes), after: bytesOf(0x4c, target & 0xff, target >> 8),
          facts: [], checked,
          notFormed: `${hex4(target)} is not in this image, so whether it reads its return address cannot be checked — and that is the whole precondition`,
        });
        continue;
      }
      const verdict = calleeLeavesReturnAlone(callee.bytes, callee.start);
      if (!verdict.ok) {
        out.push({
          rule: "tail-call", at: jsr.address, before: bytesOf(...jsr.bytes, ...rts.bytes), after: bytesOf(0x4c, target & 0xff, target >> 8),
          facts: [], checked, notFormed: verdict.why,
        });
        continue;
      }
      checked.push(verdict.why);
      checked.push("the two differ only in how deep the stack is while the callee runs, and the callee cannot tell");
      out.push({
        rule: "tail-call", at: jsr.address,
        before: bytesOf(...jsr.bytes, ...rts.bytes),
        after: bytesOf(0x4c, target & 0xff, target >> 8),
        facts: [], checked,
        measured: {
          deltaBytes: -1,
          deltaCycles: -((opcodeTiming(jsr.opcode)?.base ?? 6) + (opcodeTiming(rts.opcode)?.base ?? 6) - 3),
          how: "`jsr` 6 + `rts` 6 against `jmp` 3, from the cycle table",
        },
      });
    }
  }
  return out;
};

// ---- redundant-load -------------------------------------------------------

const STORE_LOAD: Record<string, string> = { sta: "lda", stx: "ldx", sty: "ldy" };

const matchRedundantLoad: Matcher = (env) => {
  const out: Proposal[] = [];
  for (const block of env.unit.cfg.blocks) {
    for (let i = 0; i + 1 < block.insns.length; i += 1) {
      const store = block.insns[i]!;
      const load = block.insns[i + 1]!;
      const want = STORE_LOAD[store.mnemonic];
      if (!want || load.mnemonic !== want) continue;
      if (store.mode !== load.mode || store.operand !== load.operand) continue;
      const cell = directCell(store);
      if (cell === undefined) continue;
      if (IO(cell)) continue;   // reading $D012 back is not reading what you wrote

      // The window is both instructions, so the load reads the cell the store
      // wrote and the engine resolves it. What is left to decide is the flags —
      // dead, or already what the load would set. The second half needs the
      // block up to here, which is what the entry facts are.
      const facts = entryFacts(env.unit.cfg, store.address);
      const follows = facts?.nzFollow;
      out.push({
        rule: "redundant-load", at: store.address,
        before: bytesOf(...store.bytes, ...load.bytes),
        after: bytesOf(...store.bytes),
        ...(facts ? { known: facts } : {}),
        facts: follows
          ? [`N and Z already follow ${follows} when this runs — the block up to ${hex4(store.address)} says so, so the reload would set them to what they are`]
          : [],
        checked: [],
      });
    }
  }
  return out;
};

// ---- jump-to-next ---------------------------------------------------------

const matchJumpToNext: Matcher = (env) => {
  const out: Proposal[] = [];
  for (const insn of env.unit.cfg.insns) {
    if (insn.mnemonic !== "jmp" || insn.mode !== "abs" || insn.operand === undefined) continue;
    if (insn.operand !== insn.address + insn.size) continue;
    out.push({
      rule: "jump-to-next", at: insn.address,
      before: bytesOf(...insn.bytes), after: new Uint8Array(),
      facts: [],
      checked: [
        "a `jmp` writes no register, no flag, no memory and no stack",
        `both versions continue at ${hex4(insn.operand)}`,
      ],
      measured: { deltaBytes: -insn.size, deltaCycles: -(opcodeTiming(insn.opcode)?.base ?? 3), how: "the whole instruction goes" },
    });
  }
  return out;
};

// ---- jump-threading -------------------------------------------------------

/** Is there a `jmp abs` at this address, and where does it go? */
function jmpAt(env: MatchEnv, addr: number): number | null {
  if (env.byteAt(addr) !== 0x4c) return null;
  const lo = env.byteAt(addr + 1);
  const hi = env.byteAt(addr + 2);
  if (lo === undefined || hi === undefined) return null;
  return lo | (hi << 8);
}

const matchJumpThreading: Matcher = (env) => {
  const out: Proposal[] = [];
  for (const insn of env.unit.cfg.insns) {
    const isBranch = BRANCHES.has(insn.mnemonic);
    const isJmp = insn.mnemonic === "jmp" && insn.mode === "abs";
    if (!isBranch && !isJmp) continue;
    const hop = isBranch ? insn.target : insn.operand;
    if (hop === undefined) continue;
    const final = jmpAt(env, hop);
    if (final === null || final === hop) continue;

    const checked = [`${hex4(hop)} holds \`jmp ${hex4(final)}\`, read from this image`];
    if (isJmp) {
      out.push({
        rule: "jump-threading", at: insn.address,
        before: bytesOf(...insn.bytes), after: bytesOf(0x4c, final & 0xff, final >> 8),
        facts: [], checked: [...checked, "a `jmp` carries no state, so going straight there is the same arrival"],
        measured: { deltaBytes: 0, deltaCycles: -3, how: `the \`jmp\` at ${hex4(hop)} no longer runs — 3 cycles` },
      });
      continue;
    }
    // A branch keeps its size; only the displacement changes, and it has to fit.
    const from = insn.address + insn.size;
    const disp = final - from;
    if (disp < -128 || disp > 127) {
      out.push({
        rule: "jump-threading", at: insn.address,
        before: bytesOf(...insn.bytes), after: new Uint8Array(),
        facts: [], checked,
        notFormed: `${hex4(final)} is ${disp} bytes from ${hex4(from)} — out of reach of a branch, which carries one signed byte`,
      });
      continue;
    }
    const wasCrossing = differentPage(from, hop) ? 1 : 0;
    const nowCrossing = differentPage(from, final) ? 1 : 0;
    out.push({
      rule: "jump-threading", at: insn.address,
      before: bytesOf(...insn.bytes), after: bytesOf(insn.opcode, disp & 0xff),
      facts: [], checked: [...checked, `the displacement fits: ${disp} from ${hex4(from)}`],
      measured: {
        deltaBytes: 0,
        deltaCycles: -3 + (nowCrossing - wasCrossing),
        how:
          `the \`jmp\` at ${hex4(hop)} no longer runs (3 cycles)`
          + (nowCrossing !== wasCrossing
            ? `, and the branch itself ${nowCrossing ? "starts" : "stops"} paying its page-crossing cycle`
            : ""),
      },
    });
  }
  return out;
};

// ---- known-carry ----------------------------------------------------------

const CARRY_VALUE: Record<string, 0 | 1> = { clc: 0, sec: 1 };

/**
 * The carry a branch edge guarantees. `bcc` is taken with C clear, so its
 * TARGET has C = 0 and its FALL-THROUGH has C = 1; `bcs` is the other way.
 */
function carryOnEdge(branch: Insn, toAddress: number): 0 | 1 | null {
  const taken = branch.target === toAddress;
  const through = branch.address + branch.size === toAddress;
  if (taken === through) return null;    // cannot tell the two apart
  if (branch.mnemonic === "bcc") return taken ? 0 : 1;
  if (branch.mnemonic === "bcs") return taken ? 1 : 0;
  return null;
}

const matchKnownCarry: Matcher = (env) => {
  const out: Proposal[] = [];
  const cfg = env.unit.cfg;
  for (const block of cfg.blocks) {
    // What the edge into this block says about the carry, when there is exactly one.
    let edgeCarry: { value: 0 | 1; why: string } | null = null;
    const preds = predecessorsOf(cfg, block.index);
    if (preds.length === 1) {
      const pred = cfg.blocks[preds[0]!]!;
      const last = pred.insns[pred.insns.length - 1]!;
      const fromElsewhere = env.referencedFrom(block.start).filter((a) => a !== last.address);
      if (fromElsewhere.length === 0) {
        const v = carryOnEdge(last, block.start);
        if (v !== null) {
          edgeCarry = {
            value: v,
            why: `C = ${v} here: this is the ${last.target === block.start ? "target" : "fall-through"} of the \`${last.mnemonic}\` at ${hex4(last.address)}, and nothing else reaches ${hex4(block.start)}`,
          };
        }
      }
    }

    for (let i = 0; i < block.insns.length; i += 1) {
      const insn = block.insns[i]!;
      const want = CARRY_VALUE[insn.mnemonic];
      if (want === undefined) continue;

      const facts = entryFacts(cfg, insn.address);
      let known: KnownEntry | undefined;
      let why: string | undefined;
      if (facts && facts.C === want) {
        known = { C: want };
        why = `C is already ${want} when this runs — the block up to ${hex4(insn.address)} says so`;
      } else if (edgeCarry && edgeCarry.value === want && !writesCarryBefore(block.insns, i)) {
        known = { ...(facts ?? {}), C: want };
        why = edgeCarry.why;
      }
      if (!known || !why) continue;

      out.push({
        rule: "known-carry", at: insn.address,
        before: bytesOf(...insn.bytes), after: new Uint8Array(),
        known, facts: [why], checked: [],
      });
    }
  }
  return out;
};

/**
 * Could the carry have changed between the block's start and here?
 *
 * A `jsr` counts, and it is the reason this is not simply the effects table:
 * the table says a `jsr` writes nothing, which is true of the instruction and
 * false of the call. Reading it literally would carry a branch's promise about
 * C straight through a subroutine that clears it.
 */
function writesCarryBefore(insns: readonly Insn[], index: number): boolean {
  for (let i = 0; i < index; i += 1) {
    const insn = insns[i]!;
    if (insn.mnemonic === "jsr") return true;
    if (effects(insn.mnemonic, insn.mode).writes.includes("C")) return true;
  }
  return false;
}

// ---- known-register -------------------------------------------------------

const LOAD_REG: Record<string, "a" | "x" | "y"> = { lda: "a", ldx: "x", ldy: "y" };

const matchKnownRegister: Matcher = (env) => {
  const out: Proposal[] = [];
  const cfg = env.unit.cfg;
  for (const insn of cfg.insns) {
    const reg = LOAD_REG[insn.mnemonic];
    if (!reg || insn.mode !== "imm" || insn.operand === undefined) continue;
    const facts = entryFacts(cfg, insn.address);
    if (!facts) continue;
    if (facts[reg] !== insn.operand) continue;
    out.push({
      rule: "known-register", at: insn.address,
      before: bytesOf(...insn.bytes), after: new Uint8Array(),
      known: facts,
      facts: [`${reg.toUpperCase()} already holds ${hex2(insn.operand)} when this runs — the block up to ${hex4(insn.address)} says so`],
      checked: [],
    });
  }
  return out;
};

// ---- page-align -----------------------------------------------------------

/**
 * Count the page crossings a resolved loop's indexed read makes, without a
 * trace. Only where the counter's values are known, which is the same
 * condition 861 §3.2 costs a loop under.
 */
function staticCrossings(cfg: Cfg, insn: Insn): { crossings: number; iterations: number; why: string } | null {
  if (insn.mode !== "abs,x" && insn.mode !== "abs,y") return null;
  if (insn.operand === undefined) return null;
  const reg = indexRegister(insn.mode);
  for (const loop of cfg.loops) {
    if (loop.iterations === null || loop.register !== reg) continue;
    const head = cfg.blocks[loop.head]!;
    const tail = cfg.blocks[loop.tail]!;
    if (insn.address < head.start || insn.address >= tail.end) continue;
    const m = /ld[xy] #\$([0-9A-F]{2})/u.exec(loop.why);
    if (!m) continue;
    const seed = parseInt(m[1]!, 16);
    const down = /dex|dey/u.test(loop.why);
    const base = insn.operand & 0xff;
    let crossings = 0;
    for (let k = 0; k < loop.iterations; k += 1) {
      const v = (down ? seed - k : seed + k) & 0xff;
      if (crossesPage(base, v)) crossings += 1;
    }
    return { crossings, iterations: loop.iterations, why: `${loop.why}, ${loop.iterations} iterations` };
  }
  return null;
}

const matchPageAlign: Matcher = (env) => {
  const out: Proposal[] = [];
  for (const insn of env.unit.cfg.insns) {
    const t = insn.timing;
    const branch = BRANCHES.has(insn.mnemonic);
    if (!t) continue;
    if (!t.pageCross && !branch) continue;

    if (branch) {
      if (insn.target === undefined) continue;
      const from = insn.address + insn.size;
      if (!differentPage(from, insn.target)) continue;
      const taken = env.crossingsByPc.get(insn.address) ?? 0;
      if (!env.hasTrace) {
        out.push({
          rule: "page-align", at: insn.address, before: bytesOf(...insn.bytes), after: new Uint8Array(),
          facts: [], checked: [],
          notFormed: `\`${insn.mnemonic} ${hex4(insn.target)}\` crosses a page from ${hex4(from)}, but how often it is TAKEN is not in the code — give a trace and the count becomes a number`,
        });
        continue;
      }
      if (taken === 0) continue;
      out.push({
        rule: "page-align", at: insn.address, before: bytesOf(...insn.bytes), after: new Uint8Array(),
        facts: [], checked: [`the capture records ${taken} taken crossing(s) at ${hex4(insn.address)}`],
        advice: `move the code so ${hex4(insn.target)} is on the same page as ${hex4(from)}`,
        measured: {
          deltaBytes: 0, deltaCycles: -1, executions: taken, traceExecutions: taken,
          how: `861 counted ${taken} crossing(s) of this branch in the capture, one cycle each`,
        },
      });
      continue;
    }

    const measuredCrossings = env.crossingsByPc.get(insn.address) ?? 0;
    if (env.hasTrace) {
      if (measuredCrossings === 0) continue;
      out.push({
        rule: "page-align", at: insn.address, before: bytesOf(...insn.bytes), after: new Uint8Array(),
        facts: [], checked: [`the capture records ${measuredCrossings} crossing(s) at ${hex4(insn.address)}`],
        advice: insn.operand !== undefined
          ? `move the table at ${hex4(insn.operand)} so the index never leaves its page`
          : "move the table so the index never leaves its page",
        measured: {
          deltaBytes: 0, deltaCycles: -1, executions: measuredCrossings, traceExecutions: measuredCrossings,
          how: `861 counted ${measuredCrossings} crossing(s) at this pc in the capture, one cycle each`,
        },
      });
      continue;
    }
    const stat = staticCrossings(env.unit.cfg, insn);
    if (!stat) {
      if (insn.operand === undefined) continue;
      out.push({
        rule: "page-align", at: insn.address, before: bytesOf(...insn.bytes), after: new Uint8Array(),
        facts: [], checked: [],
        notFormed: `\`${insn.mnemonic} ${insn.text}\` can cross a page, but nothing here says how often — the loop's bound is not a constant, and there is no trace`,
      });
      continue;
    }
    if (stat.crossings === 0) continue;
    out.push({
      rule: "page-align", at: insn.address, before: bytesOf(...insn.bytes), after: new Uint8Array(),
      facts: [], checked: [`counted from the loop's own bound: ${stat.why}`],
      advice: `move the table at ${hex4(insn.operand!)} so the index never leaves its page`,
      measured: {
        deltaBytes: 0, deltaCycles: -1, executions: stat.crossings,
        how: `${stat.crossings} of the ${stat.iterations} iterations cross, one cycle each`,
      },
    });
  }
  return out;
};

// ---- zp-promote -----------------------------------------------------------

const matchZpPromote: Matcher = (env) => {
  const out: Proposal[] = [];
  const uses = new Map<number, Insn[]>();
  for (const insn of env.unit.cfg.insns) {
    if (insn.mode !== "abs" || insn.operand === undefined) continue;
    const e = effects(insn.mnemonic, insn.mode);
    if (!e.memRead && !e.memWrite) continue;     // `jmp` / `jsr` name a target, not a cell
    const cell = insn.operand;
    if (IO(cell) || cell < 0x0200) continue;   // I/O, and the zero page and stack it would move INTO
    if (cell >= env.unit.start && cell <= env.unit.end) continue; // the code's own bytes
    const list = uses.get(cell) ?? [];
    list.push(insn);
    uses.set(cell, list);
  }

  for (const [cell, list] of [...uses.entries()].sort((a, b) => a[0] - b[0])) {
    if (list.length < 2) continue;
    const executions = env.hasTrace
      ? list.reduce((n, i) => n + (env.instancesByPc.get(i.address) ?? 0), 0)
      : list.length;
    if (env.hasTrace && executions === 0) continue;
    if (!env.freeZp || env.freeZp.cells.length === 0) {
      out.push({
        rule: "zp-promote", at: list[0]!.address, before: bytesOf(...list[0]!.bytes), after: new Uint8Array(),
        facts: [], checked: [],
        notFormed:
          `${hex4(cell)} is read or written ${list.length} times here and would fit zero page, but no zero page is established FREE in this project `
          + `— the free-RAM slot is what says where it may go (project_slots), and guessing a zero-page cell is how a save routine gets overwritten`,
      });
      continue;
    }
    const destination = env.freeZp.cells[0]!;
    out.push({
      rule: "zp-promote", at: list[0]!.address,
      before: bytesOf(...list[0]!.bytes), after: new Uint8Array(),
      facts: [`${hex2(destination)} is free: ${env.freeZp.how}`],
      checked: [`${list.length} access(es) to ${hex4(cell)} in ${env.unit.label}: ${list.map((i) => hex4(i.address)).join(", ")}`],
      advice: `move ${hex4(cell)} to ${hex2(destination)} and rewrite every access — each becomes a byte shorter and a cycle faster`,
      measured: {
        deltaBytes: -list.length,
        deltaCycles: -1,
        executions: list.length,
        ...(env.hasTrace ? { traceExecutions: executions } : {}),
        how: env.hasTrace
          ? `${executions} execution(s) of the ${list.length} access(es) in the capture, one cycle each`
          : `${list.length} access(es) in the code, one cycle each — without a trace this counts sites, not executions`,
        alsoChanges: list.map((i) => `${hex4(i.address)} ${i.mnemonic} ${i.text}`),
      },
    });
  }
  return out;
};

// ---- count-down -----------------------------------------------------------

const UP_STEP: Record<string, "X" | "Y"> = { inx: "X", iny: "Y" };
const COMPARE_OF: Record<"X" | "Y", string> = { X: "cpx", Y: "cpy" };
const DOWN_OPCODE: Record<"X" | "Y", number> = { X: 0xca, Y: 0x88 };

/** Does this instruction READ the counter, rather than just step it? */
function readsCounter(insn: Insn, reg: "X" | "Y", step: Insn, bound: Insn): boolean {
  if (insn === step || insn === bound) return false;
  if (indexRegister(insn.mode) === reg) return true;
  return effects(insn.mnemonic, insn.mode).reads.includes(reg);
}

const matchCountDown: Matcher = (env) => {
  const out: Proposal[] = [];
  const cfg = env.unit.cfg;
  for (const loop of cfg.loops) {
    const head = cfg.blocks[loop.head]!;
    const tail = cfg.blocks[loop.tail]!;
    const body = cfg.insns.filter((i) => i.address >= head.start && i.address < tail.end);
    const branch = tail.insns[tail.insns.length - 1]!;
    if (branch.mnemonic !== "bne") continue;

    const steps = body.filter((i) => UP_STEP[i.mnemonic] !== undefined);
    if (steps.length !== 1) continue;
    const step = steps[0]!;
    const reg = UP_STEP[step.mnemonic]!;
    const bounds = body.filter((i) => i.mnemonic === COMPARE_OF[reg] && i.mode === "imm");
    if (bounds.length !== 1) continue;
    const bound = bounds[0]!;
    if (bound.operand === undefined) continue;
    const n = bound.operand;

    const readers = body.filter((i) => readsCounter(i, reg, step, bound));
    if (readers.length > 0) {
      out.push({
        rule: "count-down", at: bound.address, before: bytesOf(...bound.bytes), after: new Uint8Array(),
        facts: [], checked: [],
        notFormed: `the body reads ${reg} at ${hex4(readers[0]!.address)} (\`${readers[0]!.mnemonic} ${readers[0]!.text}\`) — counting the other way would read other bytes`,
      });
      continue;
    }
    if (n === 0 || n > 128) {
      out.push({
        rule: "count-down", at: bound.address, before: bytesOf(...bound.bytes), after: new Uint8Array(),
        facts: [], checked: [],
        notFormed: `the bound is ${n}; a \`bpl\` counts down from at most 128`,
      });
      continue;
    }
    // What is live on the way OUT, which is the fall-through — never
    // `after(branch)`, because that merges in the back edge, and the back edge
    // reads the counter by construction. Asking the wrong one makes this rule
    // fire never.
    const exitAt = branch.address + branch.size;
    const liveAfter = env.unit.live.before.get(exitAt);
    const stillLive = liveAfter
      ? ["N", "Z", "C", reg].filter((l) => liveAfter.has(l as never))
      : ["N", "Z", "C", reg];
    if (stillLive.length > 0) {
      out.push({
        rule: "count-down", at: bound.address, before: bytesOf(...bound.bytes), after: new Uint8Array(),
        facts: [], checked: [],
        notFormed: liveAfter
          ? `${stillLive.join(" ")} ${stillLive.length === 1 ? "is" : "are"} still live where the loop exits at ${hex4(exitAt)}, and counting down leaves ${reg} at $FF with N set instead of ${hex2(n)} with Z set`
          : `the loop falls out of ${hex4(exitAt)}, past the end of this range — what is live there is not known, so it is taken to be everything`,
      });
      continue;
    }

    out.push({
      rule: "count-down", at: bound.address,
      before: bytesOf(...bound.bytes), after: new Uint8Array(),
      facts: [],
      checked: [
        `the body never reads ${reg}: ${body.length} instruction(s) read`,
        `${reg}, N, Z and C are all dead where the loop exits, at ${hex4(exitAt)}`,
        `the bound is ${n}, which a \`bpl\` reaches`,
      ],
      advice: `\`${step.mnemonic} / ${bound.mnemonic} #${hex2(n)} / bne\` becomes \`de${reg.toLowerCase()} / bpl\`, and the \`ld${reg.toLowerCase()} #$00\` before the loop becomes \`ld${reg.toLowerCase()} #${hex2(n - 1)}\``,
      measured: {
        deltaBytes: -bound.size,
        deltaCycles: -(opcodeTiming(bound.opcode)?.base ?? 2),
        executions: loop.iterations ?? n,
        how: `the \`${bound.mnemonic}\` goes: ${opcodeTiming(bound.opcode)?.base ?? 2} cycles × ${loop.iterations ?? n} iterations`,
        alsoChanges: [`the initialiser before ${hex4(head.start)} must be seeded to ${hex2(n - 1)}`],
      },
    });
  }
  return out;
};

// ---- lax-load -------------------------------------------------------------

/** The `lax` opcode for a mode, where one exists. */
const LAX_OPCODE: Partial<Record<string, number>> = {
  "zp": 0xa7, "abs": 0xaf, "abs,y": 0xbf, "(zp,x)": 0xa3, "(zp),y": 0xb3, "zp,y": 0xb7,
};

const matchLaxLoad: Matcher = (env) => {
  const out: Proposal[] = [];
  for (const block of env.unit.cfg.blocks) {
    for (let i = 0; i + 1 < block.insns.length; i += 1) {
      const lda = block.insns[i]!;
      const second = block.insns[i + 1]!;
      if (lda.mnemonic !== "lda") continue;
      const op = LAX_OPCODE[lda.mode];
      if (op === undefined) continue;
      const cell = directCell(lda);
      if (cell !== undefined && IO(cell)) continue;

      const pairsAsLdx = second.mnemonic === "ldx" && second.mode === lda.mode && second.operand === lda.operand;
      const pairsAsTax = second.mnemonic === "tax";
      if (!pairsAsLdx && !pairsAsTax) continue;

      out.push({
        rule: "lax-load", at: lda.address,
        before: bytesOf(...lda.bytes, ...second.bytes),
        after: bytesOf(op, ...lda.bytes.slice(1)),
        facts: [], checked: [],
      });
    }
  }
  return out;
};

// ---- rmw-alu-fuse ---------------------------------------------------------

interface FusePair { rmw: string; alu: string; fused: string; opcodes: Partial<Record<string, number>> }

const FUSE_PAIRS: readonly FusePair[] = [
  { rmw: "dec", alu: "cmp", fused: "dcp", opcodes: { "zp": 0xc7, "zp,x": 0xd7, "abs": 0xcf, "abs,x": 0xdf, "abs,y": 0xdb, "(zp,x)": 0xc3, "(zp),y": 0xd3 } },
  { rmw: "inc", alu: "sbc", fused: "isc", opcodes: { "zp": 0xe7, "zp,x": 0xf7, "abs": 0xef, "abs,x": 0xff, "abs,y": 0xfb, "(zp,x)": 0xe3, "(zp),y": 0xf3 } },
  { rmw: "asl", alu: "ora", fused: "slo", opcodes: { "zp": 0x07, "zp,x": 0x17, "abs": 0x0f, "abs,x": 0x1f, "abs,y": 0x1b, "(zp,x)": 0x03, "(zp),y": 0x13 } },
  { rmw: "lsr", alu: "eor", fused: "sre", opcodes: { "zp": 0x47, "zp,x": 0x57, "abs": 0x4f, "abs,x": 0x5f, "abs,y": 0x5b, "(zp,x)": 0x43, "(zp),y": 0x53 } },
  { rmw: "rol", alu: "and", fused: "rla", opcodes: { "zp": 0x27, "zp,x": 0x37, "abs": 0x2f, "abs,x": 0x3f, "abs,y": 0x3b, "(zp,x)": 0x23, "(zp),y": 0x33 } },
  { rmw: "ror", alu: "adc", fused: "rra", opcodes: { "zp": 0x67, "zp,x": 0x77, "abs": 0x6f, "abs,x": 0x7f, "abs,y": 0x7b, "(zp,x)": 0x63, "(zp),y": 0x73 } },
];

const matchRmwAluFuse: Matcher = (env) => {
  const out: Proposal[] = [];
  for (const block of env.unit.cfg.blocks) {
    for (let i = 0; i + 1 < block.insns.length; i += 1) {
      const first = block.insns[i]!;
      const second = block.insns[i + 1]!;
      const pair = FUSE_PAIRS.find((p) => p.rmw === first.mnemonic && p.alu === second.mnemonic);
      if (!pair) continue;
      if (first.mode !== second.mode || first.operand !== second.operand) continue;
      const op = pair.opcodes[first.mode];
      if (op === undefined) continue;
      const cell = directCell(first);
      if (cell !== undefined && IO(cell)) continue;

      out.push({
        rule: "rmw-alu-fuse", at: first.address,
        before: bytesOf(...first.bytes, ...second.bytes),
        after: bytesOf(op, ...first.bytes.slice(1)),
        facts: [], checked: [],
      });
    }
  }
  return out;
};

// ---------------------------------------------------------------- registry

export const MATCHERS: Readonly<Record<RuleId, Matcher>> = {
  "tail-call": matchTailCall,
  "redundant-load": matchRedundantLoad,
  "jump-to-next": matchJumpToNext,
  "jump-threading": matchJumpThreading,
  "known-carry": matchKnownCarry,
  "known-register": matchKnownRegister,
  "page-align": matchPageAlign,
  "zp-promote": matchZpPromote,
  "count-down": matchCountDown,
  "lax-load": matchLaxLoad,
  "rmw-alu-fuse": matchRmwAluFuse,
};
