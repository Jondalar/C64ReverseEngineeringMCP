// Does the cited address actually RESOLVE to something this project has read?
//
// The form gate (discipline-gate.ts) checks that a hypothesis LOOKS read-derived: a
// `$XXXX` somewhere and twenty characters of prose. The owner put his finger straight
// through it — "was ist denn die Hypothese ohne die verweigert wird? doch einfach Text".
// He is right. `hypothesis="$C000 the loader probably copies the payload there"` passes
// a regex and a character count, and nothing was read.
//
// A citation with teeth has to RESOLVE, not match. So every `$address` in the hypothesis
// is looked up against what the project already holds — routine nodes, findings,
// entities, graph nodes — and at least one of them has to land. Those records are
// produced by disassembly, analysis and annotation, i.e. by reading. A model cannot
// invent one that is already there.
//
// THE EARLY-PHASE ESCAPE, and it is not optional. A project that has analysed nothing
// yet holds nothing to cite against, and a resolver applied to it would brick every
// runtime door on day one — the "gate fires too early" failure, which is worse than no
// gate. So the resolver only binds once a corpus EXISTS. Empty project ⇒ form check
// only, and the caller is told the resolver is dormant rather than passed silently.

import { existsSync } from "node:fs";
import { join } from "node:path";

const ADDRESS_G = /\$([0-9A-Fa-f]{2,4})\b/g;

export interface CitationResult {
  /** false only when a corpus exists and NOTHING the hypothesis cites lands in it. */
  resolved: boolean;
  /** dormant = the project holds nothing to cite against yet (early phase). */
  dormant: boolean;
  /** Human-readable: what the citation landed on, or what was searched in vain. */
  detail: string;
  /** The addresses parsed out of the hypothesis, for the refusal message. */
  addresses: number[];
}

interface Range { start: number; end: number; what: string }

/** Every `$XXXX` in the text, as numbers. Duplicates collapsed, order kept. */
export function citedAddresses(hypothesis: string): number[] {
  const out: number[] = [];
  for (const m of hypothesis.matchAll(ADDRESS_G)) {
    const n = parseInt(m[1], 16);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Resolve a hypothesis against the project's read-derived records.
 *
 * Cheap by construction: one pass over routine nodes / findings / entities (all already
 * in memory as records) plus one exact-address graph probe. No analysis JSON is parsed —
 * `disasm_prg` and `analyze_prg` already import their results into the graph, so the
 * graph IS the record that reading happened.
 */
export async function resolveCitation(hypothesis: string, projectDir: string | undefined): Promise<CitationResult> {
  const addresses = citedAddresses(hypothesis ?? "");
  if (!projectDir || !existsSync(join(projectDir, "knowledge"))) {
    return { resolved: true, dormant: true, detail: "no project in scope — resolver dormant", addresses };
  }

  let ranges: Range[] = [];
  let corpus = 0;
  let records: import("../knowledge-graph/records.js").KnowledgeRecords | undefined;
  try {
    // Imported lazily: the gate runs on every runtime call, including ones made with no
    // project at all, and better-sqlite3 should not be opened for those. It must be
    // `await import` and not `require` — this bundle is ESM, where `require` is not
    // defined at runtime, so a require here would throw into the catch below and leave
    // the resolver permanently dormant. A gate that fails open silently is worse than
    // no gate; that is the whole complaint this file answers.
    const { KnowledgeRecords } = await import("../knowledge-graph/records.js");
    records = new KnowledgeRecords(projectDir);
    for (const r of records.listRoutineNodes()) {
      corpus++;
      ranges.push({ start: r.address, end: r.endAddress ?? r.address, what: `routine ${r.name ?? r.id}` });
    }
    for (const f of records.listFindings()) {
      corpus++;
      const ar = f.addressRange ?? f.evidence?.[0]?.addressRange;
      if (ar) ranges.push({ start: ar.start, end: ar.end, what: `finding "${f.title}"` });
    }
    for (const e of records.listEntities()) {
      corpus++;
      const ar = e.addressRange;
      if (ar) ranges.push({ start: ar.start, end: ar.end, what: `entity "${e.name}"` });
    }
  } catch {
    // A project whose graph cannot be opened is not a project the gate may punish.
    return { resolved: true, dormant: true, detail: "project records unreadable — resolver dormant", addresses };
  }

  if (corpus === 0) {
    return { resolved: true, dormant: true, detail: "project holds no analysis yet — resolver dormant", addresses };
  }

  // An id citation is as good as an address one: naming a finding or entity that exists
  // is exactly the "what did you read that points there" the gate asks for.
  for (const token of (hypothesis ?? "").split(/[\s,;()"']+/)) {
    if (token.length < 3) continue;
    try {
      const f = records.getFinding(token);
      if (f) return { resolved: true, dormant: false, detail: `cites finding "${f.title}"`, addresses };
      const e = records.getEntity(token);
      if (e) return { resolved: true, dormant: false, detail: `cites entity "${e.name}"`, addresses };
    } catch { /* not a ref */ }
  }

  for (const a of addresses) {
    const hit = ranges.find((r) => a >= r.start && a <= r.end);
    if (hit) return { resolved: true, dormant: false, detail: `$${hex(a)} falls in ${hit.what}`, addresses };
  }

  // Last chance: an exact graph node at the address — machine layer included, so a
  // disassembled-but-unnamed location still counts as read.
  try {
    const { GraphStore } = await import("../knowledge-graph/store.js");
    const store = GraphStore.open(projectDir, { readOnly: true });
    try {
      const stmt = store.db.prepare("SELECT id, kind, name FROM nodes WHERE address = ? LIMIT 1");
      for (const a of addresses) {
        const row = stmt.get(a) as { id: string; kind: string; name: string | null } | undefined;
        if (row) {
          return { resolved: true, dormant: false, detail: `$${hex(a)} is ${row.kind} ${row.name ?? row.id} in the graph`, addresses };
        }
      }
    } finally { store.close(); }
  } catch { /* no graph — the record scan above already decided */ }

  return {
    resolved: false,
    dormant: false,
    detail: addresses.length === 0
      ? `no $address and no record id in the hypothesis, against ${corpus} records that exist`
      : `${addresses.map((a) => "$" + hex(a)).join(", ")} ${addresses.length === 1 ? "resolves" : "resolve"} to nothing among ${corpus} records this project has read`,
    addresses,
  };
}

function hex(n: number): string {
  return (n & 0xffff).toString(16).padStart(4, "0");
}
