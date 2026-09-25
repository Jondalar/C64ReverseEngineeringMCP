// Spec 877 D1 — the contract's promises, as records rather than as sentences.
//
// 848 computed all of this already and 849 delivered it on the busiest channel. The run
// that produced 877 was told, verbatim, on the footer of a `slot_record` answer:
//
//     **Contract: now owed** — named 0.0 % (0/171 nodes) is below the 90 % the contract
//     asks for
//
// and carried on building the cartridge — 21 payloads extracted, 2 analysed, 0 annotated.
// Nothing between the rule and the delivery made it cost anything.
//
// To make a door refuse on a promise, the promise has to BE something: an id a waiver can
// name, the number the contract asked for, the number that was measured, and the shortest
// way to close the gap. A blocker string cannot carry that, which is why this file exists
// and why `critic/run.ts` now renders its contract blockers FROM here rather than
// computing them a second time. One computation, two readers — the verdict's wording is
// unchanged on purpose, because `e2e:848-contract` asserts it and the footer quotes it.

import type { SlotReport } from "../slots/state.js";

export interface ContractPromise {
  /** Stable id. This is what a waiver names, so it may not drift with the wording. */
  id: string;
  /** What the contract asks for, in the reader's terms. */
  asks: string;
  /** The stated value, verbatim. A waiver lapses when the human changes it (877 D2). */
  askedValue: string;
  /** What was measured, now. */
  now: string;
  /** The shortest path to clearing it — never advice that cannot be followed. */
  clearBy: string;
  /** The one-line form the verdict and the 849 footer speak in. Unchanged since 848. */
  blocker: string;
}

/**
 * Every deliverable the contract states that is NOT met right now.
 *
 * Waivers are not applied here: the verdict has to keep measuring the truth, or a waiver
 * would launder the number into "met". 877 D2 releases the DOOR, not the measurement.
 */
export async function contractPromises(
  projectDir: string,
  opts?: { slots?: SlotReport },
): Promise<ContractPromise[]> {
  const { loadContract } = await import("./contract.js");
  const { contract, present } = loadContract(projectDir);
  if (!present) return []; // the defaults are not a promise anybody made

  const d = contract.deliver ?? {};
  const out: ContractPromise[] = [];

  const { slotReport } = await import("../slots/state.js");
  const slots = opts?.slots ?? (await slotReport(projectDir));

  if (d.namedRatio !== undefined && slots.naming.members > 0 && slots.naming.ratio < d.namedRatio) {
    out.push({
      id: "namedRatio",
      asks: `>= ${(d.namedRatio * 100).toFixed(0)} % of the meaning-bearing nodes carry a HUMAN name`,
      askedValue: String(d.namedRatio),
      now: `${(slots.naming.ratio * 100).toFixed(1)} % (${slots.naming.named}/${slots.naming.members} nodes; ${slots.naming.machineNamed} carry only a machine name)`,
      clearBy: "disasm the payload and then NAME what is in it — `propose_annotations` → `disasm_prg` imports the file into the graph's human layer, or `save_finding` with tags=[\"routine\"] and an addressRange",
      blocker: `named ${(slots.naming.ratio * 100).toFixed(1)} % (${slots.naming.named}/${slots.naming.members} nodes) is below the ${(d.namedRatio * 100).toFixed(0)} % the contract asks for — coverage counts bytes in a RANGE, this counts things with a name`,
    });
  }

  // Coverage is stated in two places — the contract and S12's threshold — and they are the
  // same number: `slotReport` reads the contract for it. So it is a promise only when the
  // human actually wrote one down; otherwise it stays the default the critic has always
  // applied, and `critic/run.ts` keeps printing that one itself.
  if (d.coverageRatio !== undefined && slots.coverage.total > 0 && slots.coverage.ratio < slots.coverage.threshold) {
    out.push({
      id: "coverageRatio",
      asks: `>= ${(slots.coverage.threshold * 100).toFixed(0)} % of the bytes sit inside a range that says what they ARE`,
      askedValue: String(d.coverageRatio),
      now: `${(slots.coverage.ratio * 100).toFixed(1)} % (${slots.coverage.covered}/${slots.coverage.total} bytes; ${slots.coverage.declaredUnknown} declared unknown, ${slots.coverage.machineOnly} machine-named only)`,
      clearBy: "classify the ranges that are still unaccounted for — `save_finding` with an addressRange, or `analyze` + `disasm` the payloads that have none",
      blocker: `coverage ${(slots.coverage.ratio * 100).toFixed(1)} % is below the ${(slots.coverage.threshold * 100).toFixed(0)} % threshold`,
    });
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
        out.push({
          id: `annotate:${want}`,
          asks: `"${want}" is semantically annotated, not merely disassembled`,
          askedValue: want,
          now: "no model boundary carries that name yet",
          clearBy: `\`model_assert\` the boundary that IS "${want}" — its name, level and address range — then annotate what is inside it`,
          blocker: `the contract asks for "${want}" to be annotated, and no model boundary is named for it yet (model_assert)`,
        });
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

      const base = {
        id: `annotate:${want}`,
        asks: `"${want}" is semantically annotated, not merely disassembled`,
        askedValue: want,
      };
      if (total === 0) {
        out.push({
          ...base,
          now: `"${boundary.name}" holds no routine or table at all`,
          clearBy: `either the asserted range for "${boundary.name}" is wrong, or nothing in it has been disassembled yet — \`disasm\` it and re-check`,
          blocker: `"${boundary.name}" is asserted for "${want}" but holds no routine or table to annotate — either the range is wrong or nothing in it has been disassembled`,
        });
      } else if (named === 0) {
        out.push({
          ...base,
          now: `"${boundary.name}" holds ${total} routines/tables and not one carries a human name`,
          clearBy: `name them — \`propose_annotations\` → \`disasm_prg\`, or \`save_finding\` tags=["routine"] per routine`,
          blocker: `"${boundary.name}" (asked for as "${want}") holds ${total} routines/tables and not one carries a human name`,
        });
      } else if (named / total < (d.namedRatio ?? 0.5)) {
        out.push({
          ...base,
          now: `"${boundary.name}" is ${(named / total * 100).toFixed(0)} % named — ${named} of ${total}`,
          clearBy: `name the remaining ${total - named} — \`propose_annotations\` → \`disasm_prg\`, or \`save_finding\` tags=["routine"] per routine`,
          blocker: `"${boundary.name}" (asked for as "${want}") is ${(named / total * 100).toFixed(0)} % named — ${named} of ${total}`,
        });
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
    const { resolveDocumentDemand, demandSatisfiedBy, documentDemandBlocker } = await import("./documents.js");
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
      out.push({
        id: `document:${want.covers}`,
        asks: `a declared document covering ${want.covers}${want.why ? ` — ${want.why}` : ""}`,
        askedValue: want.covers,
        now: "no document declares it",
        clearBy: "write it, then `doc_register` it with a `covers:` line that names what it covers",
        blocker: documentDemandBlocker(demand, want.why),
      });
    }
  }

  return out;
}
