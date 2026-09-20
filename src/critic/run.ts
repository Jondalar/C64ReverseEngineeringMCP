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

/**
 * The orphan limit, and where it came from.
 *
 * Spec 848's precedence, which this check did not honour: a contract the human wrote
 * outranks an env override, which outranks the default. The limit was declared in the
 * contract, printed back by `contract_show`, and read by nobody — run 5 sat at 62 %
 * against a stated 50 % and the verdict said nothing, because the check consulted only
 * `C64RE_ORPHAN_RATIO`.
 *
 * The source decides the severity. A default is a preference and stays `important`; a
 * number the human put in the contract is a promise, and breaking a promise blocks.
 */
function orphanLimit(projectDir: string): { limit: number; fromContract: boolean } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const stated = loadedContractOrphanRatio(projectDir);
    if (stated !== undefined) return { limit: stated, fromContract: true };
  } catch { /* no contract, or unreadable: fall through to the env and the default */ }
  const raw = process.env.C64RE_ORPHAN_RATIO?.trim();
  const n = raw ? Number(raw) : NaN;
  return { limit: Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.5, fromContract: false };
}

let contractReader: ((dir: string) => number | undefined) | undefined;
function loadedContractOrphanRatio(projectDir: string): number | undefined {
  return contractReader?.(projectDir);
}

export async function critique(projectDir: string): Promise<CriticReport> {
  // The contract module is loaded lazily so the critic keeps working in a project that
  // has none; `loadContract` returns undefined there and the env/default path applies.
  if (!contractReader) {
    // Read the FILE, not the loaded contract: `loadContract` merges the defaults in, so
    // every project would look as if the human had stated a limit. What decides the
    // severity is whether somebody actually wrote the number down.
    const { existsSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    contractReader = (dir) => {
      const path = join(dir, "knowledge", "contract.json");
      if (!existsSync(path)) return undefined;
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as { limits?: { orphanRatio?: unknown } };
        const n = raw.limits?.orphanRatio;
        return typeof n === "number" && n > 0 && n <= 1 ? n : undefined;
      } catch { return undefined; }
    };
  }
  const findings: CriticFinding[] = [];
  const ran: string[] = [];
  const add = (
    check: Parameters<typeof CHECK_BY_ID.get>[0],
    title: string,
    proof: string,
    severity?: CriticFinding["severity"],
  ): void => {
    const def = CHECK_BY_ID.get(check)!;
    findings.push({ check: def.id, severity: severity ?? def.severity, title, proof, settleBy: def.settleBy });
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
    // Not guarded on `boundaries.length > 0` any more. That guard was the way past the
    // orphan limit: assert nothing, and the check that measures how much sits outside the
    // model never ran at all.
    {
      const model = await modelReport(projectDir);
      for (const m of model.membership) {
        if (m.members > 0) continue;
        const node = model.nodes.find((n) => n.id === m.containerId);
        add("empty-boundary",
          `"${node?.name ?? m.containerId}" contains nothing`,
          `$${hex(node?.start ?? 0)}-$${hex(node?.end ?? 0)} holds no analysed node`);
      }

      const { limit, fromContract } = orphanLimit(projectDir);
      // A project with NO boundary at all reports memberTotal 0, and the check used to
      // fall silent there — so the way past an orphan limit was to assert nothing, which
      // is the behaviour the limit exists to catch. With no model, every classified node
      // is outside every boundary by definition.
      let orphanCount = model.orphans.length;
      let memberTotal = model.memberTotal;
      if (model.nodes.length === 0 && store) {
        try {
          const { MEMBER_KINDS } = await import("../model/types.js");
          const ph = MEMBER_KINDS.map(() => "?").join(",");
          const n = (store.db.prepare(
            `SELECT COUNT(*) AS n FROM (SELECT id FROM nodes WHERE kind IN (${ph}) GROUP BY id)`,
          ).get(...MEMBER_KINDS) as { n?: number } | undefined)?.n ?? 0;
          orphanCount = n;
          memberTotal = n;
        } catch { /* leave the report's own numbers alone */ }
      }
      if (memberTotal > 0) {
        const ratio = orphanCount / memberTotal;
        if (ratio > limit) {
          add("orphan-ratio",
            model.nodes.length === 0
              ? `no boundary is asserted — all ${memberTotal} classified nodes sit outside the model`
              : `${orphanCount} of ${memberTotal} nodes sit outside every boundary`,
            `${(ratio * 100).toFixed(1)} % orphaned, limit ${(limit * 100).toFixed(0)} % `
              + (fromContract ? "(the project contract)" : "(C64RE_ORPHAN_RATIO)"),
            fromContract ? "blocking" : undefined);
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

      // Spec 740.3 D3 — the comparison lives in one function the project search calls too,
      // so "is this render stale" cannot mean two different things.
      ran.push("stale-render");
      const { liveRenderCounts, renderDrift, formatRenderDrift } = await import("../docs/render-drift.js");
      const live = liveRenderCounts(allFindings.length, entityCount, questionCount);
      for (const d of lint.docs) {
        const g = d.frontmatter?.generated;
        if (!g) continue;
        const drift = renderDrift(g, live);
        if (drift.length > 0) {
          add("stale-render",
            `${d.path} was rendered from a different graph`,
            formatRenderDrift(drift, g.at));
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
    // The first cut matched these words against artifact PATHS, and the trial showed why
    // that is useless: a project's payloads are named after their disk directory entries
    // — `a`, `i`, `p`, `s`, `01_neuromancer` — so "loader" matches nothing, ever, and the
    // check would pass or fail by accident.
    //
    // A contract is written at kickoff, when nobody knows any address or filename. What
    // the human CAN say is "the loader must be annotated, wherever it turns out to be".
    // So the demand resolves against the Spec 845 MODEL: a boundary the session itself
    // named, and the nodes inside it. That closes the loop — asserting a boundary is what
    // makes the contract checkable, and the contract is what makes asserting it matter.
    const { modelReport } = await import("../model/rollup.js");
    const { isMachineName } = await import("../slots/state.js");
    const model = await modelReport(projectDir);
    const { GraphStore } = await import("../knowledge-graph/store.js");

    for (const want of d.annotate) {
      const boundary = model.nodes.find((n) => n.name.toLowerCase().includes(want.toLowerCase()));
      if (!boundary) {
        blockers.push(`the contract asks for "${want}" to be annotated, and no model boundary is named for it yet (model_assert)`);
        continue;
      }
      let named = 0, total = 0;
      try {
        const store = GraphStore.open(projectDir, { readOnly: true });
        try {
          const rows = store.db.prepare(
            `SELECT id, MAX(CASE WHEN layer='human' THEN name END) AS hn, MAX(name) AS an,
                    MIN(address) AS address, MAX(owner) AS owner
             FROM nodes WHERE kind IN ('routine','data_block','lookup_table','pointer_table')
             GROUP BY id`,
          ).all() as Array<{ hn: string | null; an: string | null; address: number; owner: string | null }>;
          for (const r of rows) {
            if (r.address < boundary.start || r.address > boundary.end) continue;
            if (boundary.owner && r.owner !== boundary.owner) continue;
            total++;
            if (!isMachineName(r.hn ?? r.an)) named++;
          }
        } finally { store.close(); }
      } catch { /* no graph — reported as unnamed below */ }

      if (total === 0) {
        blockers.push(`"${boundary.name}" is asserted for "${want}" but holds no routine or table to annotate — either the range is wrong or nothing in it has been disassembled`);
      } else if (named === 0) {
        blockers.push(`"${boundary.name}" (asked for as "${want}") holds ${total} routines/tables and not one carries a human name`);
      } else if (named / total < (d.namedRatio ?? 0.5)) {
        blockers.push(`"${boundary.name}" (asked for as "${want}") is ${(named / total * 100).toFixed(0)} % named — ${named} of ${total}`);
      }
    }
  }
  if (d.documents?.length) {
    // Like `annotate`, a document demand may name a ROLE — "the loader" — because that is
    // all a human knows at kickoff. The first real run wrote exactly the document that was
    // asked for, declared it with the address ranges it actually covers, and the check
    // still said none existed: it was comparing the literal word "loader" against
    // `$3E00-$42F9`. The session called that out itself — "kein Wissens-, sondern ein
    // Deklarationsproblem" — and it was mine.
    //
    // So a role resolves through the model first: the boundary carrying that name gives
    // the range, and a document covering that range satisfies the demand. A MEDIUM or a
    // file resolves through the artifacts — see contract/documents.ts, which owns the
    // whole crosswalk from a demand's vocabulary to what satisfies it.
    const { lintDocs } = await import("../docs/scan.js");
    const { modelReport } = await import("../model/rollup.js");
    const { resolveDocumentDemand, demandSatisfiedBy, documentDemandBlocker } = await import("../contract/documents.js");
    const { KnowledgeRecords: Records } = await import("../knowledge-graph/records.js");
    const declared = lintDocs(projectDir).docs
      .filter((x) => x.declared)
      .map((x) => ({ covers: x.frontmatter?.covers ?? [] }));
    const model = await modelReport(projectDir);
    let artifacts: Array<{ id: string; title?: string; path?: string; relativePath?: string; addressRange?: { start: number; end: number } }> = [];
    try { artifacts = new Records(projectDir).listArtifacts(); } catch { artifacts = []; }

    for (const want of d.documents) {
      const demand = resolveDocumentDemand(want.covers, { boundaries: model.nodes, artifacts });
      if (demandSatisfiedBy(demand, declared)) continue;
      blockers.push(documentDemandBlocker(demand, want.why));
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
    // The verdict carries what settles it.
    //
    // Without this the blocker read `refutation-without-casualty: refutation "…"
    // invalidated nothing`, and a reader could try two entirely reasonable fixes and
    // watch it stay red, because the requirement is a LITERAL `amends:<name>` tag and
    // only `critic_checks` said so. A verdict that names the problem and withholds the
    // remedy is a verdict nobody can act on.
    blockers.push(`${f.check}: ${f.title}\n      settle by: ${f.settleBy}`);
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
