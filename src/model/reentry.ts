// Spec 845 D6 — the one read a session does after a /new.
//
// The owner's goal is to set the scope and leave: "ich WILL mich wegrationalisieren in
// der Analysephase". What replaces him is not a longer document — it is a shorter one
// that a fresh session can hold whole. So this returns four things and deliberately not
// a fifth:
//
//   the MODEL      — boundaries with their citations, and the edges between them
//   what is OPEN   — the 844 slots that are still empty, and the open questions
//   the REFUTATIONS — what was already tried and found wrong
//   the SCOPE      — what the project set out to do, if it said
//
// The refutations earn their place over anything else that could have gone here. Ultima
// VI holds six, and each one stops a rebuild down a path already known to be wrong; a
// session that re-derives a refuted claim pays the full original cost a second time.
// Everything else a session might want is one query away and does not have to be carried.

import type { ModelReport } from "./types.js";
import { modelReport, formatModel } from "./rollup.js";

export interface Refutation {
  title: string;
  summary: string;
  /** What it invalidated, when the record says so (845 §2, the `amended` field). */
  amended: string[];
}

export interface ReentryPackage {
  model: ModelReport;
  openSlots: Array<{ id: string; name: string; question: string; detail: string }>;
  openQuestions: string[];
  refutations: Refutation[];
  coverage: { covered: number; total: number; ratio: number };
}

export async function reentryPackage(projectDir: string): Promise<ReentryPackage> {
  const model = await modelReport(projectDir);

  const { slotReport } = await import("../slots/state.js");
  const slots = await slotReport(projectDir);

  const { KnowledgeRecords } = await import("../knowledge-graph/records.js");
  const rec = new KnowledgeRecords(projectDir);

  const refutations: Refutation[] = rec.listFindings({ kind: "refutation" }).map((f) => ({
    title: f.title,
    summary: f.summary ?? "",
    amended: (f.tags ?? []).filter((t) => t.startsWith("amends:")).map((t) => t.slice("amends:".length)),
  }));

  // Just the titles. A question carrying the INSTRUMENT that would settle it — the
  // `settleBy` field the Ultima VI session invented — has no carrier here:
  // OpenQuestionRecord has no tags and nothing else fits. That belongs to the critic
  // spec (§6) along with gaps and `nextRead`, and half of it here would be worse than
  // none.
  const openQuestions = rec.listOpenQuestions({ status: "open" }).map((q) => q.title);

  return {
    model,
    openSlots: slots.missing.map((s) => ({
      id: s.slot.id, name: s.slot.name, question: s.slot.question, detail: s.detail,
    })),
    openQuestions,
    refutations,
    coverage: { covered: slots.coverage.covered, total: slots.coverage.total, ratio: slots.coverage.ratio },
  };
}

export function formatReentry(p: ReentryPackage): string {
  const out: string[] = [];
  out.push(formatModel(p.model));

  out.push("", "=== Already refuted - do not re-derive these ===");
  if (p.refutations.length === 0) {
    out.push("  (none recorded yet)");
  } else {
    for (const r of p.refutations) {
      out.push(`  x ${r.title}`);
      if (r.summary) out.push(`      ${r.summary.split("\n")[0]}`);
      if (r.amended.length) out.push(`      invalidated: ${r.amended.join(", ")}`);
    }
  }

  out.push("", "=== Still open ===");
  if (p.openSlots.length === 0 && p.openQuestions.length === 0) {
    out.push("  (nothing)");
  } else {
    for (const s of p.openSlots) out.push(`  ${s.id} ${s.name} - ${s.question}`);
    for (const q of p.openQuestions) out.push(`  Q  ${q}`);
  }

  if (p.coverage.total > 0) {
    out.push("", `Coverage: ${p.coverage.covered}/${p.coverage.total} bytes = ${(p.coverage.ratio * 100).toFixed(1)} %`);
  }
  return out.join("\n");
}
