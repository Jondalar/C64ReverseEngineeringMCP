// Spec 846 — running the checks, and the verdict.
//
// Everything here reads. The critic does not write records of its own: a critic that
// files its own findings starts arguing with itself two runs later, and the one thing it
// must never become is another source of unverified claims. What it returns is what it
// found, with the proof, and the caller decides.
//
// D5 — nothing in this file calls a model. What the graph can decide, it decides; what
// needs prose read against prose is FORMULATED as a question (`handoverQuestions`) and
// answered by the harness. Spec 773 decision #1 holds: "Harness redet+denkt, C64RE
// merkt+zeigt."

import type { CriticFinding, Severity } from "./checks.js";
import { CHECK_BY_ID } from "./checks.js";
import { parseNegativeClaim, findCounterExample } from "./negative-claims.js";

export interface CriticReport {
  findings: CriticFinding[];
  /** Checks that ran, so a silent critic is distinguishable from a broken one. */
  ran: string[];
  counts: Record<Severity, number>;
  /** D5 — what the graph could not decide, phrased as questions for the harness. */
  handover: string[];
}

export interface Verdict {
  ready: boolean;
  /** Everything that would have to change for `ready` to become true. Never empty when not ready. */
  blockers: string[];
}

const ORPHAN_RATIO_LIMIT = (): number => {
  const raw = process.env.C64RE_ORPHAN_RATIO?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.5;
};

export async function critique(projectDir: string): Promise<CriticReport> {
  const findings: CriticFinding[] = [];
  const ran: string[] = [];
  const add = (check: Parameters<typeof CHECK_BY_ID.get>[0], title: string, proof: string): void => {
    const def = CHECK_BY_ID.get(check)!;
    findings.push({ check: def.id, severity: def.severity, title, proof, settleBy: def.settleBy });
  };

  const { KnowledgeRecords } = await import("../knowledge-graph/records.js");
  const rec = new KnowledgeRecords(projectDir);
  const allFindings = rec.listFindings();
  const entityCount = rec.listEntities().length;
  const questionCount = rec.listOpenQuestions().length;

  const { GraphStore } = await import("../knowledge-graph/store.js");
  let store: ReturnType<typeof GraphStore.open> | undefined;
  try { store = GraphStore.open(projectDir, { readOnly: true }); } catch { store = undefined; }

  try {
    // ---------------------------------------------------- D1 negative claims
    if (store) {
      ran.push("negative-claim-refuted");
      for (const f of allFindings) {
        if (f.status === "archived" || f.status === "rejected") continue;
        if (f.kind === "refutation") continue; // a refutation IS a negative claim, on purpose
        const claim = parseNegativeClaim(`${f.title} ${f.summary ?? ""}`);
        if (!claim) continue;
        const range = f.addressRange ?? f.evidence?.[0]?.addressRange;
        const counter = findCounterExample(store.db, claim, claim.onlyAddress === undefined ? range : undefined);
        if (counter) {
          const proof = claim.onlyAddress !== undefined
            ? `${counter.from} also does it: ${counter.edgeType} edge ${counter.from} -> ${counter.to}, the same target $${hex(claim.onlyAddress)} reaches`
            : `${counter.edgeType} edge ${counter.from} -> ${counter.to} lands on $${hex(counter.address)}`;
          add("negative-claim-refuted", `"${f.title}" claims ${claim.phrase}`, proof);
        }
      }
    }

    // ------------------------------------------ refutations that killed nothing
    ran.push("refutation-without-casualty");
    for (const f of allFindings.filter((x) => x.kind === "refutation")) {
      const amends = (f.tags ?? []).some((t) => t.startsWith("amends:"));
      if (amends) continue;
      const range = f.addressRange ?? f.evidence?.[0]?.addressRange;
      const superseded = range
        ? allFindings.some((o) =>
            // "killed" = the claim was retired. `rejected` and `archived` are the two
            // statuses that mean that; the record schema has no `superseded`.
            o.id !== f.id && (o.status === "rejected" || o.status === "archived")
            && overlaps(o.addressRange ?? o.evidence?.[0]?.addressRange, range))
        : false;
      if (!superseded) {
        add("refutation-without-casualty",
          `refutation "${f.title}" invalidated nothing`,
          `no \`amends:\` tag${range ? `, and no retired finding overlaps $${hex(range.start)}-$${hex(range.end)}` : " and no address range to look under"}`);
      }
    }

    // -------------------------------------------------- findings without proof
    ran.push("finding-without-evidence");
    for (const f of allFindings) {
      if (f.status === "archived" || f.status === "rejected") continue;
      const hasEvidence = (f.evidence?.length ?? 0) > 0;
      const hasRange = !!(f.addressRange ?? f.evidence?.[0]?.addressRange);
      if (!hasEvidence && !hasRange) {
        add("finding-without-evidence", `"${f.title}" asserts without proof`, `finding ${f.id}: evidence[] empty, no addressRange`);
      }
    }

    // ------------------------------------------------------- the model layer
    const { listBoundaries } = await import("../model/store.js");
    const { modelReport } = await import("../model/rollup.js");
    const boundaries = await listBoundaries(projectDir);

    ran.push("overlapping-boundaries");
    for (let i = 0; i < boundaries.length; i++) {
      for (let j = i + 1; j < boundaries.length; j++) {
        const a = boundaries[i], b = boundaries[j];
        if (a.level !== b.level || a.space !== b.space) continue;
        if (a.owner && b.owner && a.owner !== b.owner) continue;
        if (a.end < b.start || b.end < a.start) continue;
        add("overlapping-boundaries",
          `"${a.name}" and "${b.name}" are both ${a.level} and overlap`,
          `$${hex(Math.max(a.start, b.start))}-$${hex(Math.min(a.end, b.end))} is claimed twice`);
      }
    }

    // Listed as run even with no boundaries to check: a check that disappears when it
    // has nothing to look at is exactly what makes a silent report unreadable — you
    // cannot tell "found nothing" from "never ran".
    ran.push("empty-boundary", "orphan-ratio");
    if (boundaries.length > 0) {
      const model = await modelReport(projectDir);
      for (const m of model.membership) {
        if (m.members > 0) continue;
        const node = model.nodes.find((n) => n.id === m.containerId);
        add("empty-boundary",
          `"${node?.name ?? m.containerId}" contains nothing`,
          `$${hex(node?.start ?? 0)}-$${hex(node?.end ?? 0)} holds no analysed node`);
      }

      const limit = ORPHAN_RATIO_LIMIT();
      if (model.memberTotal > 0) {
        const ratio = model.orphans.length / model.memberTotal;
        if (ratio > limit) {
          add("orphan-ratio",
            `${model.orphans.length} of ${model.memberTotal} nodes sit outside every boundary`,
            `${(ratio * 100).toFixed(1)} % orphaned, limit ${(limit * 100).toFixed(0)} % (C64RE_ORPHAN_RATIO)`);
        }
      }
    }

    // ------------------------------------------- documents (847 D4/D5)
    {
      const { lintDocs } = await import("../docs/scan.js");
      const lint = lintDocs(projectDir);

      ran.push("dangling-citation");
      for (const d of lint.dangling) {
        add("dangling-citation",
          `${d.from} cites a document that is not here`,
          `\`amends: ${d.names.join(", ")}\` — no such document in this project`);
      }

      ran.push("stale-render");
      for (const d of lint.docs) {
        const g = d.frontmatter?.generated;
        if (!g) continue;
        const live = { findings: allFindings.length, entities: entityCount, questions: questionCount };
        const drift = Object.entries(g.counts).filter(([k, v]) => {
          const now = (live as Record<string, number>)[k];
          return now !== undefined && now !== v;
        });
        if (drift.length > 0) {
          add("stale-render",
            `${d.path} was rendered from a different graph`,
            drift.map(([k, v]) => `${k}: rendered ${v}, now ${(live as Record<string, number>)[k]}`).join("; ") + ` (rendered ${g.at.slice(0, 10)})`);
        }
      }
    }

    // ------------------------------------------------------ unreachable code
    if (store) {
      ran.push("unreachable-routine");
      const rows = store.db.prepare(
        `SELECT n.id, n.name, n.address FROM nodes n
         WHERE n.kind = 'routine'
           AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.to_id = n.id)
           AND NOT EXISTS (SELECT 1 FROM nodes k WHERE k.kind = 'entry' AND k.address = n.address)
         ORDER BY n.address LIMIT 25`,
      ).all() as Array<{ id: string; name: string | null; address: number }>;
      for (const r of rows) {
        add("unreachable-routine",
          `${r.name ?? r.id} at $${hex(r.address)} has no caller`,
          `no edge in the graph points at ${r.id}, and no entry node sits at $${hex(r.address)}`);
      }
    }
  } finally {
    store?.close();
  }

  const counts: Record<Severity, number> = { blocking: 0, important: 0, "nice-to-have": 0 };
  for (const f of findings) counts[f.severity]++;

  return { findings, ran, counts, handover: handoverQuestions(findings.length, allFindings.length) };
}

/**
 * D5 — what the graph cannot decide, asked rather than guessed.
 *
 * These are QUESTIONS, not prompts C64RE will run. Handing the harness a question is not
 * driving the model, and that distinction is the only reason this spec is allowed to
 * exist at all next to Spec 773 decision #1.
 */
function handoverQuestions(criticFindings: number, totalFindings: number): string[] {
  if (totalFindings < 2) return [];
  const qs = [
    "Read the findings against each other: do any two assert different things about the same address range? Name both and say which evidence wins.",
    "Which findings restate an assumption rather than something that was read? Quote the sentence.",
  ];
  if (criticFindings === 0) {
    qs.push("The mechanical checks found nothing. That is either a clean project or a blind spot — name one claim in this project you would not bet on, and why.");
  }
  return qs;
}

/**
 * D4 — the verdict. Computed, allowed to say no, and it names what would flip it.
 *
 * This absorbs Spec 844's `checkPhaseComplete`: one question, one answer, one place.
 */
export async function verdict(projectDir: string): Promise<Verdict> {
  const blockers: string[] = [];

  const { loadContract } = await import("../contract/contract.js");
  const { contract, present } = loadContract(projectDir);

  const { slotReport } = await import("../slots/state.js");
  const slots = await slotReport(projectDir);

  // Spec 848 — what the human asked for, checked. Without a contract only the defaults
  // apply, which is the behaviour that existed before.
  const d = contract.deliver ?? {};
  if (d.namedRatio !== undefined && slots.naming.members > 0 && slots.naming.ratio < d.namedRatio) {
    blockers.push(
      `named ${(slots.naming.ratio * 100).toFixed(1)} % (${slots.naming.named}/${slots.naming.members} nodes) is below the ${(d.namedRatio * 100).toFixed(0)} % the contract asks for — coverage counts bytes in a RANGE, this counts things with a name`,
    );
  }
  if (d.annotate?.length) {
    const { KnowledgeRecords } = await import("../knowledge-graph/records.js");
    const arts = new KnowledgeRecords(projectDir).listArtifacts();
    for (const want of d.annotate) {
      const has = arts.some((a) => /annotation/i.test(a.role ?? "") && (a.relativePath ?? a.title).includes(want));
      if (!has) blockers.push(`the contract asks for "${want}" to be semantically annotated, and no annotations file covers it`);
    }
  }
  if (d.documents?.length) {
    const { lintDocs } = await import("../docs/scan.js");
    const declared = lintDocs(projectDir).docs.filter((x) => x.declared);
    for (const want of d.documents) {
      const has = declared.some((x) =>
        (x.frontmatter?.covers ?? []).some((c) =>
          c.kind === "artifact" ? want.covers.includes(c.ref) : want.covers.toLowerCase().includes(c.start.toString(16))));
      if (!has) blockers.push(`the contract asks for a document covering ${want.covers}${want.why ? ` (${want.why})` : ""}, and none declares it`);
    }
  }
  void present;
  for (const s of slots.missing) {
    blockers.push(`slot ${s.slot.id} ${s.slot.name}: ${s.detail}`);
  }
  if (slots.coverage.total > 0 && slots.coverage.ratio < slots.coverage.threshold) {
    blockers.push(`coverage ${(slots.coverage.ratio * 100).toFixed(1)} % is below the ${(slots.coverage.threshold * 100).toFixed(0)} % threshold`);
  }

  const report = await critique(projectDir);
  for (const f of report.findings.filter((x) => x.severity === "blocking")) {
    blockers.push(`${f.check}: ${f.title}`);
  }

  return { ready: blockers.length === 0, blockers };
}

export function formatCritique(r: CriticReport): string {
  const out: string[] = [];
  out.push(`Critic: ${r.findings.length} finding(s) — ${r.counts.blocking} blocking, ${r.counts.important} important, ${r.counts["nice-to-have"]} nice-to-have`);
  out.push(`Checks run: ${r.ran.join(", ")}`);
  out.push("");
  if (r.findings.length === 0) {
    out.push("Nothing mechanical to report. That is not the same as nothing wrong -");
    out.push("these checks decide what the GRAPH can decide, and no more.");
  }
  for (const sev of ["blocking", "important", "nice-to-have"] as const) {
    const group = r.findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    out.push(`--- ${sev} (${group.length}) ---`);
    for (const f of group) {
      out.push(`  ${f.title}`);
      out.push(`     proof:     ${f.proof}`);
      out.push(`     settle by: ${f.settleBy}`);
    }
    out.push("");
  }
  if (r.handover.length > 0) {
    out.push("--- for the harness to answer (C64RE does not run a model) ---");
    for (const q of r.handover) out.push(`  ? ${q}`);
  }
  return out.join("\n");
}

function overlaps(a: { start: number; end: number } | undefined, b: { start: number; end: number }): boolean {
  return !!a && a.start <= b.end && b.start <= a.end;
}
function hex(n: number): string { return (n & 0xffff).toString(16).padStart(4, "0"); }
