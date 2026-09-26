// Spec 721.J3 — the knowledge an asset join yields: the relation chain
// VisualElement → MemoryRange → Routine → ArtifactRange → MediaRegion, plus annotation
// proposals with evidence refs.
//
// Types only. The daemon's `vic/inspect/origin` produces this shape, the workbench
// POSTs it back, and `workspace-ui/asset-join-persist.ts` stores it. The TypeScript
// mapping that once built it from an `AssetJoinResult` had no caller left.

import type { AssetJoinResult } from "./asset-join-types.js";

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
