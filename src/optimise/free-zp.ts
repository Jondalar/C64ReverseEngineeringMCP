// Spec 862 §4 — where `zp-promote` is allowed to move a variable TO.
//
// Not a guess, and not a table of "what the KERNAL usually leaves alone": the
// project's own free-RAM slot (Spec 844's S11) is the only thing that says
// which zero page is free here, and it distinguishes a claim a RUN confirmed
// from one somebody read off a listing. Four projects in the corpus claimed
// free RAM from reading and all four were corrected by running, which is why
// the distinction is carried into the candidate rather than flattened.
//
// No slot, no destination, no candidate — and the rule says that is why,
// instead of picking $FB and hoping.

import { KnowledgeRecords } from "../knowledge-graph/records.js";

export interface FreeZeroPage {
  cells: number[];
  /** how it was established, carried into the candidate's assumptions */
  how: string;
}

const hex2 = (v: number): string => `$${(v & 0xff).toString(16).toUpperCase().padStart(2, "0")}`;

export function freeZeroPage(projectDir: string): FreeZeroPage | null {
  let findings;
  try {
    findings = new KnowledgeRecords(projectDir).listFindings();
  } catch {
    return null;
  }
  const slot = findings.filter((f) => (f.tags ?? []).some((t) => /^slot:S11$/iu.test(t)));
  if (slot.length === 0) return null;

  const cells = new Set<number>();
  let confirmedByRun = false;
  const sources: string[] = [];
  for (const f of slot) {
    const byRun = (f.tags ?? []).some((t) => /^method:run$/iu.test(t));
    const ranges = [f.addressRange, ...(f.evidence ?? []).map((e) => e.addressRange)].filter(
      (r): r is { start: number; end: number } => !!r && typeof r.start === "number",
    );
    let took = false;
    for (const r of ranges) {
      const end = typeof r.end === "number" ? r.end : r.start;
      for (let a = Math.max(0, r.start); a <= Math.min(0xff, end); a += 1) { cells.add(a); took = true; }
    }
    if (!took) continue;
    if (byRun) confirmedByRun = true;
    sources.push(`"${f.title}" (${byRun ? "confirmed by running" : "read-derived, still a hypothesis"})`);
  }
  if (cells.size === 0) return null;

  const list = [...cells].sort((a, b) => a - b);
  const shown = list.slice(0, 8).map(hex2).join(", ");
  return {
    cells: list,
    how:
      `the project's free-RAM slot says ${list.length} zero-page cell(s) are free (${shown}${list.length > 8 ? ", …" : ""}) — ` +
      sources.join("; ") +
      (confirmedByRun ? "" : ". No run has confirmed this, so the destination is a hypothesis and the candidate inherits that"),
  };
}
