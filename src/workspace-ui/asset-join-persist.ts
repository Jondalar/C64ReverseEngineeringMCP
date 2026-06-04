// src/workspace-ui/asset-join-persist.ts
//
// Spec 721.J3 (persistence) — write a Visual-Origin Join knowledge result into
// the ONE project knowledge store: each chain node becomes an entity, each edge
// a link_entities relation, and the summary a finding tying them together. Lives
// on the HTTP workspace/knowledge side (NOT the WsServer — the WS stays a thin
// live-runtime transport, Spec 710.3 architecture). The UI/MCP gets the
// JoinKnowledge from `vic/inspect/origin` and POSTs it here to persist.
//
// Honest: runtime_generated yields only the VisualElement→MemoryRange (maps-to)
// edge, so persisting it records exactly that — no fabricated asset entities.

import type { ProjectKnowledgeService } from "../project-knowledge/service.js";
import type { JoinKnowledge } from "../runtime/headless/inspect/asset-join-knowledge.js";
import type { EntityRecord } from "../project-knowledge/types.js";

// Chain node kind (asset-join-knowledge) → project EntityKind.
const ENTITY_KIND: Record<string, EntityRecord["kind"]> = {
  VisualElement: "asset",
  MemoryRange: "memory-region",
  Routine: "routine",
  ArtifactRange: "asset",
  MediaRegion: "disk-file",
};

export interface PersistAssetJoinResult {
  classification: string;
  entityIds: string[];
  relationIds: string[];
  findingId: string;
}

/** Persist a JoinKnowledge (entities + relation chain + finding) into the store. */
export function persistAssetJoin(
  service: ProjectKnowledgeService,
  knowledge: JoinKnowledge,
  ctx: { artifactId?: string } = {},
): PersistAssetJoinResult {
  const refToEntity = new Map<string, string>();
  const ensure = (node: { kind: string; ref: string }): string => {
    const seen = refToEntity.get(node.ref);
    if (seen) return seen;
    const e = service.saveEntity({
      id: `aj:${node.ref}`,                       // deterministic → re-resolving the same node folds, not duplicates
      kind: ENTITY_KIND[node.kind] ?? "asset",
      name: node.ref,
      summary: `${node.kind} (Visual-Origin Join)`,
      status: "proposed",
      artifactIds: ctx.artifactId ? [ctx.artifactId] : undefined,
      tags: ["vic-inspect", "asset-join", node.kind],
    });
    refToEntity.set(node.ref, e.id);
    return e.id;
  };

  const relationIds: string[] = [];
  for (const r of knowledge.relations) {
    const sourceEntityId = ensure(r.from);
    const targetEntityId = ensure(r.to);
    const rel = service.linkEntities({
      kind: r.relation,
      title: `${r.from.kind} ${r.relation} ${r.to.kind}`,
      sourceEntityId, targetEntityId,
      summary: r.evidence,
    });
    relationIds.push(rel.id);
  }

  const entityIds = [...refToEntity.values()];
  const finding = service.saveFinding({
    kind: (knowledge.finding.kind as any) ?? "observation",
    title: knowledge.finding.title,
    summary: knowledge.finding.summary,
    tags: knowledge.finding.tags,
    addressRange: knowledge.finding.addressRange,
    status: "proposed",
    entityIds, relationIds,
    artifactIds: ctx.artifactId ? [ctx.artifactId] : undefined,
  });

  return { classification: knowledge.classification, entityIds, relationIds, findingId: finding.id };
}
