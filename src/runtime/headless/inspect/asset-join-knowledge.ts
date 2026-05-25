// src/runtime/headless/inspect/asset-join-knowledge.ts
//
// Spec 721.J3 — turn an AssetJoinResult into knowledge: the relation chain
// VisualElement → MemoryRange → Routine → ArtifactRange → MediaRegion, plus
// annotation proposals (routine + data labels) with evidence refs. PURE mapping
// (no persistence here) — the caller persists relations via link_entities and
// the proposals via the existing annotation/finding APIs (same store, no new
// model). Honest: runtime_generated yields NO asset relations.

import type { AssetJoinResult } from "./asset-join-types.js";

const hx = (n: number): string => `$${(n >>> 0).toString(16)}`;

/** A typed edge of the origin chain (persisted as link_entities). */
export interface ChainRelation {
  from: { kind: string; ref: string };   // kind = VisualElement|MemoryRange|Routine|ArtifactRange|MediaRegion
  to: { kind: string; ref: string };
  relation: "maps-to" | "derived-from" | "writes" | "reads" | "loads" | "contains";
  evidence: string;
}

/** An annotation proposal for the disassembly layer (Spec 042/720 consumer). */
export interface AnnotationProposal {
  kind: "routine" | "label" | "segment";
  addr: number;
  length?: number;
  name?: string;
  comment: string;
  provenance: "runtime-join";
  evidence: string[];
}

export interface JoinKnowledge {
  classification: AssetJoinResult["classification"];
  relations: ChainRelation[];
  annotations: AnnotationProposal[];
  /** A durable summary finding (persist via saveFinding). */
  finding: { kind: string; title: string; summary: string; tags: string[]; addressRange?: { start: number; end: number } };
}

export interface JoinKnowledgeCtx {
  artifactId: string;
  /** Routine entity/label for the chain writer PC, if known (from 720/trace). */
  routineRef?: string;
  traceRef?: string;
}

/** Map an AssetJoinResult → knowledge (relation chain + annotation proposals). */
export function assetJoinToKnowledge(r: AssetJoinResult, ctx: JoinKnowledgeCtx): JoinKnowledge {
  const mr = r.memoryRange;
  const memRef = `${ctx.artifactId}:mem:${hx(mr.addr)}+${mr.length}`;
  const visRef = `${ctx.artifactId}:visual:${hx(mr.addr)}`;
  const relations: ChainRelation[] = [];
  const annotations: AnnotationProposal[] = [];
  const ev = [r.evidence, ...(r.ramHash ? [`ramHash=${r.ramHash.slice(0, 12)}`] : []), ...(ctx.traceRef ? [`trace=${ctx.traceRef}`] : [])];

  // VisualElement → MemoryRange (always).
  relations.push({ from: { kind: "VisualElement", ref: visRef }, to: { kind: "MemoryRange", ref: memRef }, relation: "maps-to", evidence: `frozen-inspect node @ ${hx(mr.addr)}` });

  if (r.classification === "runtime_generated" || r.classification === "unresolved") {
    annotations.push({ kind: "segment", addr: mr.addr, length: mr.length, comment: `runtime-${r.classification === "unresolved" ? "unresolved" : "generated"}: no static asset origin (${r.evidence})`, provenance: "runtime-join", evidence: ev });
    return {
      classification: r.classification, relations, annotations,
      finding: { kind: "observation", title: `No static origin for ${hx(mr.addr)} (${r.classification})`, summary: r.evidence, tags: ["vic-inspect", "asset-join", r.classification], addressRange: { start: mr.addr, end: mr.addr + mr.length } },
    };
  }

  // exact_asset / derived_asset → there is a source candidate.
  const c = r.candidate!;
  const artRef = `${c.artifactId}:file:${hx(c.source.offset)}+${c.source.length}`;
  const where = c.source.fileRef ?? c.source.mediumRef ?? "?";

  // MemoryRange ⇐ derived-from ⇐ ArtifactRange, ArtifactRange contains← MediaRegion.
  relations.push({ from: { kind: "MemoryRange", ref: memRef }, to: { kind: "ArtifactRange", ref: artRef }, relation: "derived-from", evidence: r.evidence });
  if (c.source.mediumRef) {
    relations.push({ from: { kind: "ArtifactRange", ref: artRef }, to: { kind: "MediaRegion", ref: `${c.source.mediumRef}@${hx(c.source.offset)}` }, relation: "contains", evidence: `${c.kind} ${c.format} on ${c.source.mediumRef}` });
  }

  if (r.classification === "derived_asset" && Array.isArray((r.chain as any)?.steps)) {
    // Routine writes MemoryRange + reads the source; chain step carries the PC.
    const step = (r.chain as any).steps.find((s: any) => s.kind === "depack" || s.kind === "copy");
    const pc = step?.pc ?? (r.chain as any).steps[0]?.pc;
    if (typeof pc === "number") {
      const routineRef = ctx.routineRef ?? `${ctx.artifactId}:routine:${hx(pc)}`;
      relations.push({ from: { kind: "Routine", ref: routineRef }, to: { kind: "MemoryRange", ref: memRef }, relation: "writes", evidence: `${step?.kind} writer @ ${hx(pc)}` });
      relations.push({ from: { kind: "Routine", ref: routineRef }, to: { kind: "ArtifactRange", ref: artRef }, relation: "reads", evidence: `reads source @ ${step?.from ? hx(step.from.addr) : "?"}` });
      annotations.push({ kind: "routine", addr: pc, name: `${step?.kind}_${c.kind}`, comment: `${step?.kind === "depack" ? "depacks" : "copies"} ${c.kind} ${c.format} (${c.id}) from ${where}+${hx(c.source.offset)} to ${hx(mr.addr)}`, provenance: "runtime-join", evidence: ev });
    }
  }

  // Data label on the destination range.
  annotations.push({ kind: "label", addr: mr.addr, length: mr.length, name: `${c.kind}_${hx(mr.addr).slice(1)}`, comment: `${r.classification === "exact_asset" ? "verbatim" : "derived"} ${c.kind} ${c.format} ⇐ ${c.id} (${where}+${hx(c.source.offset)})`, provenance: "runtime-join", evidence: ev });

  return {
    classification: r.classification, relations, annotations,
    finding: {
      kind: "observation",
      title: `${r.classification}: ${hx(mr.addr)} ⇐ ${c.id} (${c.kind} ${c.format})`,
      summary: r.evidence,
      tags: ["vic-inspect", "asset-join", r.classification, c.kind],
      addressRange: { start: mr.addr, end: mr.addr + mr.length },
    },
  };
}
