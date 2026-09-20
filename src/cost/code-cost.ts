// Spec 861 D2 — static cost, and whether the new version is the same.
//
// §3.5: the verdict is Δ bytes, Δ cycles as a span, the equivalence, and the
// liveness assumptions it rests on. Same input, same answer — nothing here reads
// a clock, a file it was not given, or a machine.

import { buildCfg, rangeCost, type Cfg } from "./cfg.js";
import { formatSpan, isExact, type Span } from "./cycles.js";
import { formatLocs, liveness, type LocSet, type Liveness } from "./liveness.js";
import { compareStates, runStraightLine, type Comparison, type SymOptions } from "./symbolic.js";

export interface CodeInput {
  /** where the bytes run */
  address: number;
  bytes: Uint8Array;
  /** what to call it in the report */
  label: string;
}

export interface CodeCostOptions extends SymOptions {
  /** What is live after the range. Omitted: derived, and conservative where the graph ends. */
  liveOut?: LocSet;
  /** include the per-instruction listing */
  listing?: boolean;
}

export interface OneCost {
  input: CodeInput;
  cfg: Cfg;
  bytes: number;
  cycles: Span | null;
  why: string | null;
  live: Liveness;
}

export function costOf(input: CodeInput, options: CodeCostOptions = {}): OneCost {
  const cfg = buildCfg(input.bytes, input.address);
  const total = rangeCost(cfg);
  const live = liveness(cfg, options.liveOut);
  return { input, cfg, bytes: total.bytes, cycles: total.cycles, why: total.why, live };
}

const hex4 = (a: number): string => `$${(a & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;

function listing(cost: OneCost): string[] {
  const out: string[] = [];
  for (const block of cost.cfg.blocks) {
    out.push(
      `  block ${block.index}  ${hex4(block.start)}-${hex4(block.end - 1)}  ` +
        `${block.bytes} bytes  ${formatSpan(block.cycles)} cycles` +
        (block.succ.length ? `  → block ${block.succ.join(", ")}` : ""),
    );
    for (const insn of block.insns) {
      const c = insn.timing ? formatSpan(insn.cycles) : "—";
      out.push(`    ${hex4(insn.address)}  ${insn.mnemonic.toUpperCase().padEnd(3)} ${insn.text.padEnd(10)} ${c.padStart(5)}`);
    }
    for (const e of block.unknownExits) {
      out.push(`    ${hex4(e.at)}  exit the graph cannot follow: ${e.kind}${e.detail ? ` ${e.detail}` : ""}`);
    }
  }
  return out;
}

function loopLines(cost: OneCost): string[] {
  const out: string[] = [];
  for (const loop of cost.cfg.loops) {
    const head = cost.cfg.blocks[loop.head]!;
    if (loop.iterations !== null) {
      out.push(
        `  loop at ${hex4(head.start)}: ${loop.iterations} iterations (${loop.why}), ` +
          `${formatSpan(loop.perIteration)} cycles each` +
          (loop.total ? `, ${formatSpan(loop.total)} in total` : ""),
      );
      if (loop.totalWhy) out.push(`    ${loop.totalWhy}`);
    } else {
      out.push(`  loop at ${hex4(head.start)}: bound UNKNOWN — ${loop.why}; ${formatSpan(loop.perIteration)} cycles per iteration`);
    }
  }
  return out;
}

export function formatOne(cost: OneCost, options: CodeCostOptions = {}): string {
  const lines: string[] = [];
  lines.push(`${cost.input.label}: ${hex4(cost.input.address)}-${hex4(cost.input.address + cost.input.bytes.length - 1)}`);
  lines.push(`  bytes: ${cost.bytes} exact`);
  lines.push(`  cycles: ${cost.cycles ? `${formatSpan(cost.cycles)}${isExact(cost.cycles) ? " exact" : " (the span is the page crossings and the branches)"}` : `no total — ${cost.why}`}`);
  lines.push(`  blocks: ${cost.cfg.blocks.length}, instructions: ${cost.cfg.insns.length}`);
  if (cost.cfg.truncatedAt !== null) lines.push(`  the decode stopped at ${hex4(cost.cfg.truncatedAt)} — the bytes after it are not instructions`);
  lines.push(...loopLines(cost));
  const unknown = cost.cfg.blocks.flatMap((b) => b.unknownExits);
  if (unknown.length) {
    lines.push(`  exits the graph cannot follow: ${unknown.map((e) => `${e.kind} @${hex4(e.at)}`).join(", ")}`);
  }
  lines.push(`  live at the exit: ${formatLocs(cost.live.atExit)} — ${cost.live.exitWhy}`);
  if (options.listing) lines.push(...listing(cost));
  return lines.join("\n");
}

// ----------------------------------------------------------------- compare

export interface CostComparison {
  original: OneCost;
  candidate: OneCost;
  deltaBytes: number;
  deltaCycles: Span | null;
  equivalence: Comparison;
}

export function compareCost(original: CodeInput, candidate: CodeInput, options: CodeCostOptions = {}): CostComparison {
  const a = costOf(original, options);
  const b = costOf(candidate, options);
  const deltaCycles =
    a.cycles && b.cycles
      ? { min: b.cycles.min - a.cycles.max, max: b.cycles.max - a.cycles.min }
      : null;

  const assumptions = [
    a.live.exitWhy,
    options.decimalAtEntry === "unknown"
      ? "decimal mode at entry is unknown, so every add and subtract stays opaque"
      : "decimal mode is clear at entry (the C64 runs with D clear; a block that sets D is modelled as it is)",
  ];

  let equivalence: Comparison;
  if (!a.cfg.straightLine || !b.cfg.straightLine) {
    const which = !a.cfg.straightLine ? "the original" : "the candidate";
    equivalence = {
      verdict: "UNKNOWN",
      reasons: [`${which} is not straight-line code — equivalence across a branch, a loop or a call is out of scope (§6)`],
      assumptions,
      compared: [],
    };
  } else {
    const sa = runStraightLine(a.cfg.insns, options);
    const sb = runStraightLine(b.cfg.insns, options);
    equivalence = compareStates(sa, sb, a.live.atExit, assumptions);
  }

  return { original: a, candidate: b, deltaBytes: b.bytes - a.bytes, deltaCycles, equivalence };
}

export function formatComparison(cmp: CostComparison, options: CodeCostOptions = {}): string {
  const lines: string[] = [];
  lines.push(formatOne(cmp.original, options));
  lines.push("");
  lines.push(formatOne(cmp.candidate, options));
  lines.push("");
  lines.push("verdict");
  lines.push(`  Δ bytes: ${cmp.deltaBytes > 0 ? "+" : ""}${cmp.deltaBytes}`);
  lines.push(
    `  Δ cycles: ${
      cmp.deltaCycles
        ? isExact(cmp.deltaCycles)
          ? `${cmp.deltaCycles.min > 0 ? "+" : ""}${cmp.deltaCycles.min}`
          : `${cmp.deltaCycles.min > 0 ? "+" : ""}${cmp.deltaCycles.min} … ${cmp.deltaCycles.max > 0 ? "+" : ""}${cmp.deltaCycles.max}`
        : "no total on one of the two sides"
    }`,
  );
  lines.push(`  equivalence: ${cmp.equivalence.verdict}`);
  if (cmp.equivalence.counterExample) lines.push(`    it differs in ${cmp.equivalence.counterExample}`);
  for (const r of cmp.equivalence.reasons) lines.push(`    UNKNOWN because ${r}`);
  if (cmp.equivalence.compared.length) lines.push(`    compared: ${cmp.equivalence.compared.join("; ")}`);
  for (const a of cmp.equivalence.assumptions) lines.push(`    it rests on: ${a}`);
  return lines.join("\n");
}
