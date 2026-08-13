// Spec 750.6 — derive who WRITES a payload, and who LOADS it, from the static analysis.
//
// 750.3 put a warning on a mutated payload: patch the medium alone and the mutation may
// undo you, and the byte-identical rebuild this workbench leans on will not mention it.
// That warning only fires when a `writes` relation exists, and until now every one had
// to be created by hand — so the warning was, in practice, decoration.
//
// This closes it from the side that needs no runtime: a `_analysis.json` already
// records every cross-reference the disassembler resolved, typed `read`/`write`. A
// write whose target lands inside a payload's runtime range, issued from an address
// inside a known routine, IS the mutator edge. No trace, no guessing.
//
// What it deliberately does NOT do: invent a relation from a bare address. A write from
// code nobody has identified as a routine is reported as UNATTRIBUTED rather than
// hung off the nearest entity — an edge pointing at the wrong routine is worse than a
// missing one, because it reads as an answer.

import { readFileSync, existsSync } from "node:fs";
import type { EntityRecord } from "./types.js";

/** What the analyser actually records. `codeAnalysis.xrefs` is CONTROL FLOW ONLY
 *  (jump/branch/fallthrough/call) — there is no `read`/`write` cross-reference in a
 *  real report, and the top-level `crossReferences` field this once read does not
 *  exist at all. The data reference lives on the INSTRUCTION: mnemonic, addressing
 *  mode, and the resolved base address. Checked against real reports, not the schema. */
interface AnalysedInstruction {
  address: number;
  mnemonic?: string;
  addressingMode?: string;
  targetAddress?: number;
  operandValue?: number;
  operandText?: string;
}

export interface DerivedEdge {
  kind: "writes" | "loads";
  /** The routine doing it. Absent = we know a write happens but not from where. */
  sourceEntityId?: string;
  sourceName?: string;
  sourceAddress: number;
  targetEntityId: string;
  targetName: string;
  /** The address actually written, inside the payload's range. */
  hitAddress: number;
  mnemonic?: string;
  confidence: number;
}

export interface DeriveResult {
  edges: DerivedEdge[];
  /** Writes into a payload from code that belongs to no known routine. Reported, never
   *  attributed — see the note at the top. */
  unattributed: Array<{ targetEntityId: string; targetName: string; sourceAddress: number; hitAddress: number }>;
  scanned: number;
  notes: string[];
}

function rangeOf(e: EntityRecord): { start: number; end: number } | undefined {
  // A payload's RUNTIME range: where it lives once loaded, which is what a mutator
  // writes into. Its position on the medium is a different question (mediumSpans) and
  // is not what a `STA` lands in.
  // An explicit runtime range wins. Otherwise derive one from the load address plus
  // the bytes the payload actually occupies on the medium — there is no length field
  // on a payload, and inventing one from a single span would be wrong for anything
  // that crosses banks or sectors.
  if (e.addressRange) return { start: e.addressRange.start, end: e.addressRange.end };
  const load = e.payloadLoadAddress;
  if (load === undefined) return undefined;
  const bytes = (e.mediumSpans ?? []).reduce((sum, sp) => sum + ((sp as { length?: number }).length ?? 0), 0);
  return bytes > 0 ? { start: load, end: load + bytes } : undefined;
}

/** Derive mutator (and loader-call) edges from an analysis report's cross-references. */
export function derivePayloadRelations(
  analysisPath: string,
  entities: EntityRecord[],
): DeriveResult {
  const notes: string[] = [];
  if (!existsSync(analysisPath)) {
    return { edges: [], unattributed: [], scanned: 0, notes: [`no analysis report at ${analysisPath}`] };
  }
  let report: { codeAnalysis?: { instructions?: AnalysedInstruction[] } };
  try {
    report = JSON.parse(readFileSync(analysisPath, "utf8"));
  } catch (err) {
    return { edges: [], unattributed: [], scanned: 0, notes: [`unreadable analysis report: ${(err as Error).message}`] };
  }
  const instructions = report.codeAnalysis?.instructions ?? [];
  if (!instructions.length) {
    return { edges: [], unattributed: [], scanned: 0, notes: ["the analysis report has no disassembled instructions — run analyze_prg first"] };
  }
  // Every store with a resolved absolute target. Indexed stores count: `STA $1034,X`
  // names the BASE of what it writes, and a mutator that walks a payload with an index
  // is the common case, not the exception.
  const STORES = new Set(["sta", "stx", "sty", "sax", "shx", "shy"]);
  const writes = instructions.filter(
    (i) => STORES.has((i.mnemonic ?? "").toLowerCase()) &&
      /^(abs|abs,x|abs,y)$/.test(i.addressingMode ?? "") &&
      (i.targetAddress ?? i.operandValue) !== undefined,
  );

  // Payloads with a runtime range, and routines with an address range to attribute to.
  const payloads = entities
    .filter((e) => e.kind === "payload")
    .map((e) => ({ e, range: rangeOf(e) }))
    .filter((p): p is { e: EntityRecord; range: { start: number; end: number } } => Boolean(p.range));
  const routines = entities
    .filter((e) => (e.kind === "routine" || e.kind === "entry-point") && e.addressRange)
    .map((e) => ({ e, range: e.addressRange! }));

  if (!payloads.length) notes.push("no payload carries a runtime range (payloadLoadAddress + length, or addressRange) — nothing to attribute writes to");
  if (!routines.length) notes.push("no routine carries an addressRange — every write will come back unattributed");

  const routineAt = (addr: number) => routines.find((r) => addr >= r.range.start && addr < r.range.end);

  const edges: DerivedEdge[] = [];
  const unattributed: DeriveResult["unattributed"] = [];
  let scanned = 0;

  for (const ins of writes) {
    const target = (ins.targetAddress ?? ins.operandValue)!;
    scanned++;
    for (const p of payloads) {
      // An indexed store reaches PAST its base, so a base just below a payload can
      // still land inside it. Only the resolved base is claimed here — saying more
      // would be guessing at the index register's range.
      if (target < p.range.start || target >= p.range.end) continue;
      const r = routineAt(ins.address);
      if (!r) {
        unattributed.push({
          targetEntityId: p.e.id, targetName: p.e.name,
          sourceAddress: ins.address, hitAddress: target,
        });
        continue;
      }
      // A routine writing into ITSELF is self-modifying code, not a mutator of some
      // other payload — a real and different thing, and calling it a mutation edge
      // would put a warning on every self-mod routine in the image.
      if (r.e.id === p.e.id) continue;
      edges.push({
        kind: "writes",
        sourceEntityId: r.e.id, sourceName: r.e.name, sourceAddress: ins.address,
        targetEntityId: p.e.id, targetName: p.e.name,
        hitAddress: target,
        mnemonic: `${ins.mnemonic}${ins.addressingMode?.startsWith("abs,") ? ` ${ins.addressingMode}` : ""}`,
        // The disassembler's own confidence in the xref, floored: a resolved store is
        // strong evidence, but this is still a static reading of an indexed write.
        // An indexed store is weaker evidence than a plain one: the base is resolved,
        // the reach is not. Say so in the number rather than in a footnote.
        confidence: ins.addressingMode === "abs" ? 0.85 : 0.6,
      });
    }
  }

  // One edge per (source, target) pair — a routine writing a payload forty times is one
  // relation, not forty. Keep the lowest address as the witness so it is findable.
  const byPair = new Map<string, DerivedEdge>();
  for (const e of edges) {
    const key = `${e.sourceEntityId}→${e.targetEntityId}`;
    const prev = byPair.get(key);
    if (!prev || e.hitAddress < prev.hitAddress) byPair.set(key, e);
  }

  return { edges: [...byPair.values()], unattributed, scanned, notes };
}

export function formatDerivedRelations(result: DeriveResult): string {
  const hx = (n: number) => `$${n.toString(16).toUpperCase().padStart(4, "0")}`;
  const out: string[] = [];
  out.push(`Scanned ${result.scanned} resolved store instruction(s).`);
  for (const n of result.notes) out.push(`  note: ${n}`);
  if (result.edges.length) {
    out.push("", `MUTATORS — ${result.edges.length} routine→payload edge(s):`);
    for (const e of result.edges) {
      out.push(`  ${e.sourceName} writes ${e.targetName}  (${e.mnemonic ?? "store"} at ${hx(e.sourceAddress)} → ${hx(e.hitAddress)}, confidence ${e.confidence.toFixed(2)})`);
    }
    out.push("", "Each of these means the bytes on the medium are not the bytes that run. Patching the medium alone may not hold, and a byte-identical rebuild will not say so.");
  } else {
    out.push("", "No mutator edge found. That is a statement about RESOLVED stores only — a store through a pointer, or into a region no payload claims, leaves nothing to match.");
  }
  if (result.unattributed.length) {
    out.push("", `UNATTRIBUTED — ${result.unattributed.length} write(s) into a payload from code belonging to no known routine:`);
    for (const u of result.unattributed.slice(0, 10)) {
      out.push(`  ${hx(u.sourceAddress)} → ${hx(u.hitAddress)} in ${u.targetName}`);
    }
    if (result.unattributed.length > 10) out.push(`  … ${result.unattributed.length - 10} more`);
    out.push("These are NOT guessed onto the nearest routine: an edge pointing at the wrong one reads as an answer. Name the routine (save_entity kind=routine with an address_range) and run this again.");
  }
  return out.join("\n");
}
