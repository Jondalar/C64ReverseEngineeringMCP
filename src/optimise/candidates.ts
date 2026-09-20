// Spec 862 §2, §5 and §6 — where to look, what a candidate carries, and the
// counters that make a bad rule visible.
//
// §2's order is the product of what a candidate saves and how often the code
// runs, so the scan looks at hot code first, at routines in raster lines whose
// budget is nearly spent second, and at everything else last. Without a trace
// there is no frequency at all, and the report says so rather than ranking on
// a number it does not have.
//
// §5's order is separate and fixed: gain per frame, then static gain, then
// address. The same input gives the same list — a scan is not allowed to be a
// different answer on Tuesday.

import { buildCfg, decodeRange, type Insn } from "../cost/cfg.js";
import { opcodeTiming } from "../cost/cycles.js";
import { liveness } from "../cost/liveness.js";
import type { CodeCostOptions } from "../cost/code-cost.js";
import type { Instance, RoutineSpan, TraceCostReport } from "../cost/trace-cost.js";
import { exclusionsFor, excluded, type Exclusion } from "./exclusions.js";
import {
  DEFAULT_CLASSES, MATCHERS, RULES, RULE_BY_ID,
  type MatchEnv, type Proposal, type RuleClass, type RuleDef, type RuleId, type Unit,
} from "./rules.js";
import { judge, type CandidateVerdict } from "./verdict.js";
import type { Proof } from "./rules.js";

const hex4 = (a: number): string => `$${(a & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;

// ---------------------------------------------------------------- §5

export interface Candidate {
  rule: RuleDef;
  /** the routine it sits in, and where its bytes come from */
  unit: string;
  routineId?: string;
  payload?: string;
  at: number;
  before: { bytes: Uint8Array; lines: string[] };
  after: { bytes: Uint8Array; lines: string[] };
  /** for a change that is not a byte edit at `at` */
  advice?: string;
  verdict: CandidateVerdict;
  proof: Proof;
  facts: string[];
  checked: string[];
  assumptions: string[];
  reasons: string[];
  deltaBytes: number;
  /** per execution; negative is a saving */
  deltaCycles: number;
  deltaCyclesNote?: string;
  executionsInCapture: number | null;
  executionsPerFrame: number | null;
  /** cycles saved over the whole capture */
  gainInCapture: number | null;
  gainPerFrame: number | null;
  /** cycles saved with nothing but the code to go on */
  staticGain: number;
  /** 861 D1, in one line */
  impact: string | null;
}

export interface RuleCounter {
  rule: RuleDef;
  matched: number;
  proposed: number;
  droppedNotEquivalent: number;
  notFormed: number;
  unknown: number;
  /** why, in the rule's own words, at most a handful */
  reasons: string[];
}

export type Ranking = "measured" | "static";

export interface ScanReport {
  candidates: Candidate[];
  counters: RuleCounter[];
  exclusions: Exclusion[];
  /** the order §2 looked in, and why */
  lookedAt: Array<{ unit: string; start: number; end: number; why: string }>;
  ranking: Ranking;
  classes: readonly RuleClass[];
  notes: string[];
  /** how many candidates the report kept of how many it had */
  kept: number;
  total: number;
}

// ---------------------------------------------------------------- the input

export interface ScanInput {
  /** the image the bytes come from, with the address its first byte runs at */
  image: { load: number; bytes: Uint8Array };
  /** the routines to scan, in whatever order; §2 reorders them */
  units: Array<{ label: string; routineId?: string; payload?: string; start: number; end: number }>;
  classes?: readonly RuleClass[];
  trace?: TraceCostReport | null;
  /** zero page the project has established free (Spec 844's slot) */
  freeZp?: { cells: number[]; how: string } | null;
  /** the graph's own verdicts, by routine id */
  onDriveCpu?: (routineId: string | undefined, start: number) => boolean;
  writtenInto?: (start: number, end: number) => string[];
  /** 861 D1, for the candidates that survive */
  impactFor?: (range: { start: number; end: number }) => string | null;
  /** how many candidates to keep (default 40) */
  limit?: number;
  /** how many candidates get an impact walk (default 25) */
  impactLimit?: number;
  costOptions?: CodeCostOptions;
}

// ---------------------------------------------------------------- the scan

export function scanForCandidates(input: ScanInput): ScanReport {
  const classes = input.classes ?? DEFAULT_CLASSES;
  const notes: string[] = [];
  const { load, bytes } = input.image;
  const imageEnd = load + bytes.length - 1;
  const byteAt = (addr: number): number | undefined =>
    addr >= load && addr <= imageEnd ? bytes[addr - load] : undefined;

  // ---- the units, decoded once -------------------------------------------
  const units: Unit[] = [];
  for (const u of input.units) {
    const from = Math.max(u.start, load);
    const to = Math.min(u.end, imageEnd);
    if (to < from) {
      notes.push(`${u.label} (${hex4(u.start)}-${hex4(u.end)}) is not inside this image (${hex4(load)}-${hex4(imageEnd)}) — skipped`);
      continue;
    }
    const slice = new Uint8Array(bytes.subarray(from - load, to - load + 1));
    const cfg = buildCfg(slice, from);
    units.push({
      label: u.label, start: from, end: to, bytes: slice, cfg,
      live: liveness(cfg),
      ...(u.routineId ? { routineId: u.routineId } : {}),
      ...(u.payload ? { payload: u.payload } : {}),
    });
  }

  // ---- who reaches what --------------------------------------------------
  //
  // Every branch, jump and call in every unit, by destination. A rule that
  // wants to delete an instruction has to know whether anything else lands on
  // it, and "it is a block leader" does not answer that question.
  const reaches = new Map<number, number[]>();
  const note = (to: number, from: number): void => {
    const list = reaches.get(to) ?? [];
    if (!list.includes(from)) list.push(from);
    reaches.set(to, list);
  };
  for (const unit of units) {
    for (const insn of unit.cfg.insns) {
      if (insn.target !== undefined && (insn.mnemonic === "jmp" || insn.mnemonic === "jsr" || isBranch(insn))) note(insn.target, insn.address);
      if (insn.mnemonic === "jsr" && insn.operand !== undefined) note(insn.operand, insn.address);
    }
  }
  const referencedFrom = (addr: number): readonly number[] => reaches.get(addr) ?? [];

  // ---- what the capture says ---------------------------------------------
  const measured = input.trace && !input.trace.laneProblem ? input.trace : null;
  const instancesByPc = new Map<number, number>();
  const crossingsByPc = new Map<number, number>();
  const instancesByUnit = new Map<string, Instance[]>();
  if (measured) {
    for (const inst of measured.instances) {
      instancesByPc.set(inst.pc, (instancesByPc.get(inst.pc) ?? 0) + 1);
      const cross = pageCrossCycles(inst);
      if (cross) crossingsByPc.set(inst.pc, (crossingsByPc.get(inst.pc) ?? 0) + cross);
    }
    for (const unit of units) {
      instancesByUnit.set(unit.label, measured.instances.filter((i) => i.pc >= unit.start && i.pc <= unit.end));
    }
  }
  const frames = measured?.frames ?? 0;
  const ranking: Ranking = measured && frames > 0 ? "measured" : "static";
  if (!measured) {
    notes.push(
      input.trace?.laneProblem
        ? `the capture's lane cannot be priced, so there is no frequency to rank by: ${input.trace.laneProblem.why}`
        : "no trace was given, so nothing here knows how OFTEN any of this runs — the list is ranked by what each change saves once",
    );
  } else if (frames === 0) {
    notes.push("the capture has no frame anchor, so a gain per frame cannot be computed; the totals below are for the whole capture");
  }

  // ---- §2: where to look, and in what order ------------------------------
  const lookedAt = orderUnits(units, measured, instancesByUnit);

  // ---- the rules ---------------------------------------------------------
  const counters = new Map<RuleId, RuleCounter>();
  for (const rule of RULES) {
    counters.set(rule.id, { rule, matched: 0, proposed: 0, droppedNotEquivalent: 0, notFormed: 0, unknown: 0, reasons: [] });
  }
  const exclusions: Exclusion[] = [];
  const candidates: Candidate[] = [];
  const active = RULES.filter((r) => classes.includes(r.class));

  for (const order of lookedAt) {
    const unit = units.find((u) => u.label === order.unit && u.start === order.start)!;
    const unitExclusions = exclusionsFor({
      unit,
      ...(instancesByUnit.get(unit.label) ? { instances: instancesByUnit.get(unit.label)! } : {}),
      ...(input.onDriveCpu ? { onDriveCpu: input.onDriveCpu(unit.routineId, unit.start) } : {}),
      ...(input.writtenInto ? { writtenInto: input.writtenInto(unit.start, unit.end) } : {}),
    });
    exclusions.push(...unitExclusions);

    const env: MatchEnv = {
      unit, byteAt, referencedFrom, instancesByPc, crossingsByPc,
      frames, hasTrace: measured !== null,
      freeZp: input.freeZp ?? null,
      routineAt: (addr) => {
        const owner = units.find((u) => addr >= u.start && addr <= u.end);
        if (owner) return { start: owner.start, end: owner.end, bytes: owner.bytes };
        // Not a routine the graph names, but still inside the image: decode
        // from the address to the end of the image. Reading further than the
        // callee is harmless — the check is looking for what it must NOT find.
        if (addr < load || addr > imageEnd) return null;
        return { start: addr, end: imageEnd, bytes: new Uint8Array(bytes.subarray(addr - load)) };
      },
    };

    for (const rule of active) {
      const proposals = MATCHERS[rule.id](env);
      for (const proposal of proposals) {
        const counter = counters.get(rule.id)!;
        counter.matched += 1;

        const block = excluded(unitExclusions, proposal.at);
        if (block) {
          counter.notFormed += 1;
          pushReason(counter, `not proposed at ${hex4(proposal.at)}: ${block.why}`);
          continue;
        }

        const verdict = judge(proposal, unit, input.costOptions ?? {});
        if (verdict.outcome === "not-formed") {
          counter.notFormed += 1;
          pushReason(counter, `not formed at ${hex4(proposal.at)}: ${verdict.why ?? "no reason given"}`);
          continue;
        }
        if (verdict.outcome === "dropped") {
          counter.droppedNotEquivalent += 1;
          pushReason(counter, `dropped at ${hex4(proposal.at)}: NOT EQUIVALENT — ${verdict.counterExample ?? "the effects differ"}`);
          continue;
        }
        counter.proposed += 1;
        if (verdict.verdict === "UNKNOWN") {
          counter.unknown += 1;
          pushReason(counter, `UNKNOWN at ${hex4(proposal.at)}: ${verdict.reasons[0] ?? "the check could not decide"}`);
        }
        candidates.push(buildCandidate(proposal, unit, verdict, {
          instancesByPc, frames, hasTrace: measured !== null,
        }));
      }
    }
  }

  // ---- §5's order --------------------------------------------------------
  candidates.sort(byGain);
  const total = candidates.length;
  const kept = candidates.slice(0, input.limit ?? 40);
  if (kept.length < total) notes.push(`${total} candidates found; the ${kept.length} with the largest gain are listed`);

  // ---- 861's impact, for the ones that survived --------------------------
  if (input.impactFor) {
    const impactLimit = input.impactLimit ?? 25;
    for (const c of kept.slice(0, impactLimit)) {
      c.impact = input.impactFor({ start: c.at, end: c.at + Math.max(1, c.before.bytes.length) - 1 });
    }
    if (kept.length > impactLimit) notes.push(`the impact walk was run for the first ${impactLimit} candidates; change_impact answers for any of the rest by address`);
  }

  return {
    candidates: kept,
    counters: [...counters.values()].filter((c) => classes.includes(c.rule.class)),
    exclusions: dedupeExclusions(exclusions),
    lookedAt, ranking, classes, notes, kept: kept.length, total,
  };
}

// ---------------------------------------------------------------- helpers

function isBranch(insn: Insn): boolean {
  const t = opcodeTiming(insn.opcode);
  return t?.branch === true;
}

/**
 * The page-crossing cycles 861 charged this instance — read back out of its
 * own arithmetic rather than recomputed, so §7.4's "exactly what 861 measured"
 * is true by construction and not by two implementations agreeing.
 */
function pageCrossCycles(inst: Instance): number {
  const t = opcodeTiming(inst.opcode);
  if (!t || inst.staticCycles === null || !inst.exact) return 0;
  const extra = inst.staticCycles - t.base;
  if (t.pageCross) return extra === 1 ? 1 : 0;
  if (t.branch) return extra === 2 ? 1 : 0;
  return 0;
}

function pushReason(counter: RuleCounter, reason: string): void {
  if (counter.reasons.length < 6 && !counter.reasons.includes(reason)) counter.reasons.push(reason);
}

function listing(bytes: Uint8Array, at: number): string[] {
  if (bytes.length === 0) return ["(nothing)"];
  const { insns, truncatedAt } = decodeRange(bytes, at);
  const lines = insns.map((i) => `${hex4(i.address)}  ${i.mnemonic.toUpperCase()}${i.text ? ` ${i.text}` : ""}`);
  if (truncatedAt !== null) lines.push(`${hex4(truncatedAt)}  (not an instruction)`);
  return lines;
}

function buildCandidate(
  proposal: Proposal,
  unit: Unit,
  verdict: ReturnType<typeof judge>,
  ctx: { instancesByPc: ReadonlyMap<number, number>; frames: number; hasTrace: boolean },
): Candidate {
  const rule = RULE_BY_ID.get(proposal.rule)!;
  const staticExecutions = proposal.measured?.executions ?? 1;
  const executionsInCapture = !ctx.hasTrace
    ? null
    : proposal.measured?.traceExecutions ?? ctx.instancesByPc.get(proposal.at) ?? 0;
  const saving = -verdict.deltaCycles;
  const gainInCapture = executionsInCapture === null ? null : saving * executionsInCapture;
  const c: Candidate = {
    rule, unit: unit.label, at: proposal.at,
    before: { bytes: proposal.before, lines: listing(proposal.before, proposal.at) },
    after: { bytes: proposal.after, lines: listing(proposal.after, proposal.at) },
    verdict: verdict.verdict ?? "UNKNOWN",
    proof: verdict.proof,
    facts: verdict.facts, checked: verdict.checked,
    assumptions: verdict.assumptions, reasons: verdict.reasons,
    deltaBytes: verdict.deltaBytes,
    deltaCycles: verdict.deltaCycles,
    executionsInCapture,
    executionsPerFrame: executionsInCapture === null || ctx.frames === 0 ? null : executionsInCapture / ctx.frames,
    gainInCapture,
    gainPerFrame: gainInCapture === null || ctx.frames === 0 ? null : gainInCapture / ctx.frames,
    staticGain: saving * staticExecutions,
    impact: null,
  };
  if (unit.routineId) c.routineId = unit.routineId;
  if (unit.payload) c.payload = unit.payload;
  if (proposal.advice) c.advice = proposal.advice;
  if (verdict.deltaCyclesNote) c.deltaCyclesNote = verdict.deltaCyclesNote;
  if (proposal.measured?.alsoChanges?.length) {
    c.checked = [...c.checked, ...proposal.measured.alsoChanges.map((a) => `it also changes: ${a}`)];
  }
  return c;
}

/** §5's order. Ties are broken all the way down, so the list is reproducible. */
function byGain(a: Candidate, b: Candidate): number {
  const ga = a.gainPerFrame ?? -1;
  const gb = b.gainPerFrame ?? -1;
  if (ga !== gb) return gb - ga;
  if (a.staticGain !== b.staticGain) return b.staticGain - a.staticGain;
  if (a.at !== b.at) return a.at - b.at;
  return a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0;
}

/**
 * §2 — hot code, then the routines in raster lines whose budget is nearly
 * spent, then everything else. Without a measurement all three collapse into
 * the third, and the report says which one it used.
 */
function orderUnits(
  units: readonly Unit[],
  measured: TraceCostReport | null,
  instancesByUnit: ReadonlyMap<string, Instance[]>,
): Array<{ unit: string; start: number; end: number; why: string }> {
  if (!measured) {
    return [...units]
      .sort((a, b) => a.start - b.start)
      .map((u) => ({ unit: u.label, start: u.start, end: u.end, why: "no measurement — scanned in address order, and ranked by what each change saves once" }));
  }
  const cyclesPerLine = measured.anchor?.cyclesPerLine ?? 63;
  const tight = new Set(measured.perLine.filter((l) => l.cycles >= cyclesPerLine - 8).map((l) => l.line));
  const scored = units.map((u) => {
    const insts = instancesByUnit.get(u.label) ?? [];
    const cycles = insts.reduce((n, i) => n + i.measured, 0);
    const onTight = insts.some((i) => i.line !== null && tight.has(i.line));
    return { u, cycles, onTight };
  });
  scored.sort((a, b) => (b.cycles - a.cycles) || (Number(b.onTight) - Number(a.onTight)) || (a.u.start - b.u.start));
  return scored.map(({ u, cycles, onTight }) => ({
    unit: u.label, start: u.start, end: u.end,
    why: cycles > 0
      ? `${cycles} cycles measured over ${measured.frames || 1} frame(s)` + (onTight ? `, and it runs in a raster line with almost nothing left` : "")
      : "nothing in this capture ran here — ranked below the code that did",
  }));
}

function dedupeExclusions(list: readonly Exclusion[]): Exclusion[] {
  const seen = new Set<string>();
  const out: Exclusion[] = [];
  for (const e of list) {
    const k = `${e.kind}|${e.start}|${e.end}|${e.why}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out.sort((a, b) => a.start - b.start || (a.kind < b.kind ? -1 : 1));
}

/** The graph's routines, as units. */
export function unitsFromSpans(spans: readonly RoutineSpan[], load: number, end: number): ScanInput["units"] {
  return spans
    .filter((s) => s.end >= load && s.start <= end)
    .map((s) => ({ label: s.label, routineId: s.id, start: s.start, end: s.end }));
}
