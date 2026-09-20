// Spec 862 — the report.
//
// Text, because a tool that answers in `structuredContent` hides its own
// report from the model that called it. Four parts, in this order:
//
//   what it looked at and why       §2
//   what it refused to touch        §3 — and the reason, always
//   the candidates                  §5, ranked
//   the rules, counted              §6 — proposed, dropped, UNKNOWN
//
// The counters are not an appendix. §1's whole argument is that a rule may be
// wrong about whether it applies, and the only thing that keeps that honest is
// a line saying how often it was.

import type { Candidate, RuleCounter, ScanReport } from "./candidates.js";
import type { Exclusion } from "./exclusions.js";
import { RULES } from "./rules.js";

const hex4 = (a: number): string => `$${(a & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;
const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));
const round1 = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export function formatScan(report: ScanReport, title: string): string {
  const out: string[] = [];
  out.push(title);
  out.push(
    `  ${report.total} candidate(s) from ${report.classes.join(", ")}; ranked by ` +
    (report.ranking === "measured"
      ? "gain per frame, from the capture"
      : "what each change saves once — there is no measurement, so nothing here knows how OFTEN it runs"),
  );
  out.push("  nothing here is applied: turning a candidate into a patch is a separate, deliberate step (runtime_candidate_patch)");
  out.push("");

  // ---- §2
  out.push(`where it looked (${report.lookedAt.length} unit(s), in this order)`);
  if (report.lookedAt.length === 0) out.push("  nothing — no code range was given or resolved");
  for (const l of report.lookedAt.slice(0, 20)) {
    out.push(`  ${l.unit.padEnd(22)} ${hex4(l.start)}-${hex4(l.end)}  ${l.why}`);
  }
  if (report.lookedAt.length > 20) out.push(`  … and ${report.lookedAt.length - 20} more`);
  out.push("");

  // ---- §3
  out.push(`left alone, and why (${report.exclusions.length})`);
  if (report.exclusions.length === 0) out.push("  nothing: no delay loop, no raster-timed code, no drive code, nothing the graph could not follow");
  for (const e of report.exclusions) out.push(`  [${e.kind}] ${hex4(e.start)}-${hex4(e.end)} in ${e.where}\n      ${e.why}`);
  out.push("");

  // ---- §5
  out.push(`candidates (${report.kept} of ${report.total})`);
  if (report.candidates.length === 0) out.push("  none");
  for (const c of report.candidates) out.push(formatCandidate(c));
  out.push("");

  // ---- §6
  out.push("the rules, counted");
  for (const counter of report.counters) out.push(formatCounter(counter));
  out.push("");

  for (const n of report.notes) out.push(`note: ${n}`);
  return out.join("\n").replace(/\n+$/u, "") + "\n";
}

function formatCandidate(c: Candidate): string {
  const lines: string[] = [];
  const gain = c.gainPerFrame !== null
    ? `${round1(c.gainPerFrame)} cycles per frame`
    : `${c.staticGain} cycle(s) each time it runs`;
  lines.push(`  ${hex4(c.at)}  ${c.rule.id}  [${c.rule.class}]  in ${c.unit}${c.payload ? ` (${c.payload})` : ""}`);
  lines.push(`      gain: ${gain}   Δ bytes ${signed(c.deltaBytes)}   Δ cycles ${signed(c.deltaCycles)} per execution`);
  if (c.deltaCyclesNote) lines.push(`        ${c.deltaCyclesNote}`);
  if (c.executionsInCapture !== null) {
    lines.push(
      `      the capture ran it ${c.executionsInCapture} time(s)` +
      (c.executionsPerFrame !== null ? `, ${round1(c.executionsPerFrame)} per frame` : "") +
      (c.gainInCapture !== null ? `, ${c.gainInCapture} cycle(s) over the whole capture` : ""),
    );
  }
  lines.push(`      verdict: ${c.verdict} (${proofName(c.proof)})`);
  for (const r of c.reasons) lines.push(`        UNKNOWN because ${r}`);
  lines.push(`      as it is:      ${c.before.lines.join(" · ")}`);
  // A measurement whose change is not a byte edit at this address says what it
  // IS instead of printing "(nothing)", which would read as "delete this".
  if (c.advice && c.after.bytes.length === 0) lines.push(`      the change:    ${c.advice}`);
  else {
    lines.push(`      the candidate: ${c.after.lines.join(" · ")}`);
    if (c.advice) lines.push(`      the change:    ${c.advice}`);
  }
  for (const f of c.facts) lines.push(`      it holds because ${f}`);
  for (const ch of c.checked) lines.push(`      checked: ${ch}`);
  for (const a of c.assumptions) lines.push(`      it rests on: ${a}`);
  if (c.impact) lines.push(`      impact: ${c.impact}`);
  return lines.join("\n");
}

function proofName(proof: Candidate["proof"]): string {
  switch (proof) {
    case "equivalence": return "both versions executed symbolically and their effects compared";
    case "control-flow": return "not an equivalence of straight-line code — the obligations below were checked against the bytes";
    case "measurement": return "a measurement, not a proof of sameness — the count is what carries it";
  }
}

function formatCounter(c: RuleCounter): string {
  const head =
    `  ${c.rule.id.padEnd(16)} [${c.rule.class.padEnd(12)}] ` +
    `matched ${String(c.matched).padStart(3)} · proposed ${String(c.proposed).padStart(3)} · ` +
    `dropped NOT EQUIVALENT ${String(c.droppedNotEquivalent).padStart(3)} · not formed ${String(c.notFormed).padStart(3)} · ` +
    `UNKNOWN ${String(c.unknown).padStart(3)}`;
  return [head, ...c.reasons.map((r) => `      ${r}`)].join("\n");
}

/** §4's table, printed — what each rule looks for and what it rests on. */
export function formatRuleTable(): string {
  const out: string[] = ["the rules"];
  for (const rule of RULES) {
    out.push(`  ${rule.id}  [${rule.class}]`);
    out.push(`    pattern:       ${rule.pattern}`);
    out.push(`    preconditions: ${rule.preconditions}`);
    out.push(`    rewrite:       ${rule.rewrite}`);
    out.push(`    saves:         ${rule.saves}`);
    out.push(`    verdict by:    ${proofName(rule.proof)}`);
  }
  out.push("");
  out.push("The undocumented class is off unless it is switched on: using those opcodes is a decision about which machines the result has to run on, not a fact about the code.");
  return out.join("\n");
}

export function formatExclusionsOnly(exclusions: readonly Exclusion[]): string {
  return exclusions.map((e) => `  [${e.kind}] ${hex4(e.start)}-${hex4(e.end)} in ${e.where}: ${e.why}`).join("\n");
}
