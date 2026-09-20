// Spec 862 §1 — finding is a heuristic; the verdict is not.
//
// A matcher in `rules.ts` proposes. Nothing it says about its own correctness
// is taken at face value: every proposal comes through here and leaves with
// 861's answer attached, or it does not leave at all.
//
// THREE PROOFS, and the candidate always says which one it rests on:
//
//   equivalence   861 §3.4. Both versions are executed symbolically from the
//                 same entry — seeded, where a dataflow rule established a
//                 fact — and their effects compared: registers, the stack,
//                 every memory cell, the flags that are still LIVE at this
//                 point in this routine, and every access to $D000-$DFFF in
//                 order. The verdict is 861's, unchanged.
//
//   control-flow  A `jsr`, a `jmp` and an `rts` are not straight-line code, so
//                 symbolic execution cannot compare them — but `jsr x / rts`
//                 against `jmp x` is decidable all the same, once the one
//                 thing that can differ is CHECKED: how deep the stack is
//                 while x runs. The obligations are listed with the candidate
//                 and each was read off the bytes, never assumed.
//
//   measurement   The structural rules, where §4 says the answer is a count
//                 plus 861's impact rather than an equivalence. The count is
//                 exact — page crossings the trace recorded, accesses in the
//                 code, iterations a resolved loop makes — and the candidate
//                 says it is a measurement, not a proof of sameness.
//
// NOT EQUIVALENT is the end of a candidate: §1 says a rule that proposes one
// has proposed nothing. UNKNOWN is not — it is shown, marked, and counted, so
// that "the check could not decide" never reads as "it is fine".

import { compareCost, type CodeCostOptions } from "../cost/code-cost.js";
import { formatSpan, isExact, type Span } from "../cost/cycles.js";
import { RULE_BY_ID, type Proof, type Proposal, type Unit } from "./rules.js";

export type CandidateVerdict = "EQUIVALENT" | "NOT EQUIVALENT" | "UNKNOWN" | "MEASURED";

export interface Judged {
  /** what happens to the proposal: it stands, the verdict killed it, or it was never formed */
  outcome: "proposed" | "dropped" | "not-formed";
  verdict: CandidateVerdict | null;
  proof: Proof;
  deltaBytes: number;
  /** per execution; negative is a saving */
  deltaCycles: number;
  /** set when the cycle count is a span rather than a number */
  deltaCyclesNote?: string;
  assumptions: string[];
  checked: string[];
  facts: string[];
  reasons: string[];
  counterExample?: string;
  /** for "not-formed": what stopped it */
  why?: string;
}

/** The conservative end of a saving: the least it can save, never the most. */
function conservative(span: Span | null): { value: number; note?: string } {
  if (!span) return { value: 0, note: "one of the two sides has no cycle total" };
  if (isExact(span)) return { value: span.min };
  // A negative delta is a saving; the SMALLEST saving is the end nearest zero.
  const value = span.min <= 0 && span.max <= 0 ? span.max : span.min >= 0 && span.max >= 0 ? span.min : 0;
  return { value, note: `the cycle delta is a span, ${formatSpan(span)}; the gain below is its least favourable end` };
}

export function judge(proposal: Proposal, unit: Unit, options: CodeCostOptions = {}): Judged {
  const rule = proposal.rule;
  const base = {
    // The kind of proof is a property of the RULE, declared once in §4's
    // table — not something inferred from the shape of a proposal.
    proof: RULE_BY_ID.get(rule)!.proof,
    facts: proposal.facts,
    checked: proposal.checked,
    assumptions: [] as string[],
    reasons: [] as string[],
  };

  if (proposal.notFormed) {
    return {
      ...base, outcome: "not-formed", verdict: null,
      deltaBytes: 0, deltaCycles: 0, why: proposal.notFormed,
    };
  }

  if (base.proof === "measurement" || base.proof === "control-flow") {
    const m = proposal.measured;
    if (!m) {
      return {
        ...base, outcome: "not-formed", verdict: null, deltaBytes: 0, deltaCycles: 0,
        why: `${rule} reached a ${base.proof} verdict without a measurement, which is a fault in the rule, not in the code`,
      };
    }
    return {
      ...base,
      outcome: "proposed",
      verdict: base.proof === "control-flow" ? "EQUIVALENT" : "MEASURED",
      deltaBytes: m.deltaBytes,
      deltaCycles: m.deltaCycles,
      assumptions:
        base.proof === "control-flow"
          ? ["the obligations above were read off the bytes in this image; the two versions transfer control to the same address with the same registers, flags, memory and stack"]
          : ["this is a COUNT, not a proof that the two versions are the same: " + m.how],
    };
  }

  // ---- 861 §3.4, directly ------------------------------------------------
  const last = lastInsnAddress(unit, proposal);
  const liveOut = last === null ? undefined : unit.live.after.get(last);
  const cmp = compareCost(
    { address: proposal.at, bytes: proposal.before, label: "as it is" },
    { address: proposal.at, bytes: proposal.after, label: "the candidate" },
    { ...options, ...(liveOut ? { liveOut } : {}), ...(proposal.known ? { known: proposal.known } : {}) },
  );

  const delta = conservative(cmp.deltaCycles);
  const judged: Judged = {
    ...base,
    outcome: cmp.equivalence.verdict === "NOT EQUIVALENT" ? "dropped" : "proposed",
    verdict: cmp.equivalence.verdict,
    deltaBytes: cmp.deltaBytes,
    deltaCycles: delta.value,
    assumptions: cmp.equivalence.assumptions,
    reasons: cmp.equivalence.reasons,
  };
  if (delta.note) judged.deltaCyclesNote = delta.note;
  if (cmp.equivalence.counterExample) judged.counterExample = cmp.equivalence.counterExample;
  if (liveOut) {
    judged.checked = [...base.checked, `what is live after ${hex4(last!)} in ${unit.label}, which is what the flags were compared against`];
  }
  return judged;
}

const hex4 = (a: number): string => `$${(a & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;

/** The address of the last instruction the window covers. */
function lastInsnAddress(unit: Unit, proposal: Proposal): number | null {
  const endExclusive = proposal.at + proposal.before.length;
  let last: number | null = null;
  for (const insn of unit.cfg.insns) {
    if (insn.address < proposal.at) continue;
    if (insn.address + insn.size > endExclusive) break;
    last = insn.address;
  }
  return last;
}
